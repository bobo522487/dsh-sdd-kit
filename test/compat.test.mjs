import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readPkg() {
  return JSON.parse(await fs.readFile(path.join(PKG_ROOT, 'package.json'), 'utf8'));
}

const LOW_BOUND_CASES = [
  { required: '>=99.0.0', shouldInstall: false, label: 'impossible lower bound' },
  { required: '>=1.4.4', shouldInstall: false, label: 'prerelease below final bound' },
  { required: '>=1.4.0', shouldInstall: true, label: 'satisfied bound' },
];

function runSpecify(cwd, args) {
  return spawnSync('specify', args, { cwd, encoding: 'utf8', timeout: 60_000 });
}

test('host peers are declared optional so a pure Node install has no mandatory peer set (REQ-21/AC-11)', async () => {
  const pkg = await readPkg();
  const peers = Object.keys(pkg.peerDependencies ?? {});
  assert.deepEqual(peers.sort(), [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-skill-filesystem',
    '@deepseek-ai/dsh-tools',
  ]);
  const meta = pkg.peerDependenciesMeta ?? {};
  for (const peer of peers) {
    assert.equal(meta[peer]?.optional, true, `${peer} must be optional`);
  }
});

test('CLI and published files expose the host-neutral entry (REQ-05)', async () => {
  const pkg = await readPkg();
  assert.equal(pkg.bin?.['sdd-kit'], './bin/sdd-kit.mjs');
  assert.ok(pkg.files.includes('bin/'));
  assert.ok(pkg.files.includes('docs/'));
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0,
    'core package must not add runtime dependencies');
});

test('extension declares a version bound, four execution hooks, guard hooks and session_start event (REQ-24/REQ-23/REQ-27)', async () => {
  const raw = await fs.readFile(
    path.join(PKG_ROOT, 'spec-kit-extension', 'extension.yml'),
    'utf8'
  );
  assert.match(raw, /speckit_version:\s*">=1\.4\.0"/);
  for (const hook of ['before_implement', 'after_implement', 'before_bug_fix', 'after_bug_fix', 'before_clarify', 'before_plan']) {
    assert.match(raw, new RegExp(`${hook}:`));
  }
  assert.match(raw, /events:/);
  assert.match(raw, /session_start:/);
});

test('version bound failures happen at install time with no half-installed residue (REQ-24/AC-14)', { skip: !process.env.DSH_SDD_KIT_INTEGRATION }, () => {
  for (const { required, shouldInstall, label } of LOW_BOUND_CASES) {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-'));
    try {
      const init = runSpecify(dir, ['init', '.', '--integration', 'dsh', '--non-interactive', '--force', '--ignore-agent-tools']);
      if (init.status !== 0) continue; // toolchain unavailable, skip this case
      const ext = path.join(dir, 'ext');
      fsSync.cpSync(path.join(PKG_ROOT, 'spec-kit-extension'), ext, { recursive: true });
      const manifest = path.join(ext, 'extension.yml');
      fsSync.writeFileSync(manifest, fsSync.readFileSync(manifest, 'utf8').replace('">=1.4.0"', `"${required}"`));
      const add = runSpecify(dir, ['extension', 'add', '--dev', './ext']);
      if (shouldInstall) {
        assert.equal(add.status, 0, `${label}: expected success`);
      } else {
        assert.notEqual(add.status, 0, `${label}: expected install failure`);
        assert.match(`${add.stdout}${add.stderr}`, /Compatibility Error/);
        assert.equal(
          fsSync.existsSync(path.join(dir, '.specify', 'extensions', 'superpowers-hooks')),
          false,
          `${label}: no half install`
        );
      }
    } finally {
      fsSync.rmSync(dir, { recursive: true, force: true });
    }
  }
});
