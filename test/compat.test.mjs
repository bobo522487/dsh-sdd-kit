import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selectSuperpowersDir } from '../src/core/candidates.mjs';

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

function notExecuted(reason) {
  assert.fail(`not_executed (REQ-42): ${reason}`);
}

function probeSpecify() {
  const probe = spawnSync('specify', ['--version'], { encoding: 'utf8', timeout: 30_000 });
  if (probe.error?.code === 'ENOENT') {
    notExecuted('specify is not installed on PATH; the install-time probe cannot be executed');
  }
  assert.equal(probe.status, 0, `specify --version failed: ${probe.stderr || probe.stdout}`);
  return probe.stdout.trim();
}

function assertNoHalfInstall(dir, label) {
  assert.equal(
    fsSync.existsSync(path.join(dir, '.specify', 'extensions', 'superpowers-hooks')),
    false,
    `${label}: no half install`
  );
  const extensionsYml = path.join(dir, '.specify', 'extensions.yml');
  if (fsSync.existsSync(extensionsYml)) {
    assert.doesNotMatch(
      fsSync.readFileSync(extensionsYml, 'utf8'),
      /superpowers-hooks/,
      `${label}: no half-registered extension`
    );
  }
  const skillsDir = path.join(dir, '.dsh', 'skills');
  if (fsSync.existsSync(skillsDir)) {
    assert.deepEqual(
      fsSync.readdirSync(skillsDir).filter((name) => name.startsWith('speckit-superpowers-hooks-')),
      [],
      `${label}: no rendered hook skill residue`
    );
  }
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

test('candidate environment keys and default path can be injected by a host adapter (T079)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-candidates-inject-'));
  const mirror = path.join(root, 'mirror');
  await fs.mkdir(mirror, { recursive: true });

  const injected = await selectSuperpowersDir(
    { envKeys: { mirror: 'ADAPTER_MIRROR', home: 'ADAPTER_HOME' } },
    { ADAPTER_MIRROR: mirror },
  );
  assert.equal(injected.reason, 'env');
  assert.equal(injected.realPath, mirror);

  const injectedDefault = await selectSuperpowersDir({ defaultDir: mirror }, {});
  assert.equal(injectedDefault.reason, 'default');
  assert.equal(injectedDefault.dir, mirror);
  assert.equal(injectedDefault.fallback, false);
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

test('version bound failures happen at install time with no half-installed residue (REQ-24/AC-14)', () => {
  const observed = probeSpecify();
  for (const { required, shouldInstall, label } of LOW_BOUND_CASES) {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-'));
    try {
      const init = runSpecify(dir, ['init', '.', '--integration', 'dsh', '--non-interactive', '--force', '--ignore-agent-tools']);
      if (init.error?.code === 'ENOENT') {
        notExecuted('specify disappeared during the install probe');
      }
      assert.equal(init.status, 0, `${label}: specify init failed: ${init.stderr || init.stdout}`);
      const ext = path.join(dir, 'ext');
      fsSync.cpSync(path.join(PKG_ROOT, 'spec-kit-extension'), ext, { recursive: true });
      const manifest = path.join(ext, 'extension.yml');
      fsSync.writeFileSync(manifest, fsSync.readFileSync(manifest, 'utf8').replace('">=1.4.0"', `"${required}"`));
      const add = runSpecify(dir, ['extension', 'add', '--dev', './ext']);
      if (shouldInstall) {
        assert.equal(add.status, 0, `${label}: expected success, got ${add.stderr || add.stdout}`);
        assert.equal(
          fsSync.existsSync(path.join(dir, '.specify', 'extensions', 'superpowers-hooks')),
          true,
          `${label}: a satisfied bound must install the extension`
        );
      } else {
        assert.notEqual(add.status, 0, `${label}: expected install failure`);
        assert.match(`${add.stdout}${add.stderr}`, /Compatibility Error/);
        assertNoHalfInstall(dir, label);
      }
    } finally {
      fsSync.rmSync(dir, { recursive: true, force: true });
    }
  }
  assert.ok(observed.length > 0, 'the probe must record the observed specify version');
});

// Versions read from the DSH runtime that is actually installed and active on
// this machine (see docs/adapters/stop-loss.md M4 for the exact package paths).
// They are observed facts, not guesses: a host without these packages keeps
// them optional; a host with older packages must fail the floor check.
const MEASURED_PEER_FLOORS = {
  '@deepseek-ai/cordis': { floor: '>=4.1.0', observed: '4.1.0' },
  '@deepseek-ai/dsh-skill-filesystem': { floor: '>=0.2.2-rc.3', observed: '0.2.2-rc.3' },
  '@deepseek-ai/dsh-tools': { floor: '>=0.2.2-rc.3', observed: '0.2.2-rc.3' },
};

test('peer floors are the versions measured in the active DSH host runtime (T100)', async () => {
  const pkg = await readPkg();
  assert.deepEqual(Object.keys(pkg.peerDependencies ?? {}).sort(), Object.keys(MEASURED_PEER_FLOORS).sort());
  for (const [peer, { floor }] of Object.entries(MEASURED_PEER_FLOORS)) {
    assert.equal(pkg.peerDependencies[peer], floor, `${peer} must use the measured floor`);
    assert.equal(pkg.peerDependenciesMeta?.[peer]?.optional, true, `${peer} must stay optional for hosts without it`);
  }
  const doc = await fs.readFile(path.join(PKG_ROOT, 'docs', 'adapters', 'stop-loss.md'), 'utf8');
  for (const { floor } of Object.values(MEASURED_PEER_FLOORS)) {
    assert.ok(doc.includes(floor), `M4 must record the measured floor ${floor}`);
  }
  assert.match(doc, /@deepseek-ai\/dsh\/node_modules/, 'M4 must name the runtime the versions came from');
});

test('a normal script exposes the compat checks without the integration switch (T100)', async () => {
  const pkg = await readPkg();
  assert.equal(pkg.scripts?.['verify:compat'], 'node --test test/compat.test.mjs');
});

test('prerelease floors are decided on every run, not only with a real toolchain (T100)', async () => {
  const { compareBound } = await import('../scripts/verify-upstream.mjs');
  const exact = compareBound('>=0.2.2-rc.3', '0.2.2-rc.3');
  assert.equal(exact.needsAdjustment, false, 'an installed prerelease equal to its floor satisfies it');
  const final = compareBound('>=0.2.2-rc.3', '0.2.2');
  assert.equal(final.needsAdjustment, false, 'a final release satisfies a prerelease floor');
  const older = compareBound('>=0.2.2-rc.4', '0.2.2-rc.3');
  assert.equal(older.needsAdjustment, true, 'an older prerelease is still drift');
  assert.equal(older.suggestedBound, '>=0.2.2-rc.3');
});

const HOST_MODULES = process.env.DSH_SDD_KIT_HOST_MODULES;

test('installed host peers satisfy the declared floors (T100)', {
  skip: HOST_MODULES ? false : 'set DSH_SDD_KIT_HOST_MODULES to a host node_modules directory',
}, async () => {
  const { createRequire } = await import('node:module');
  const hostRequire = createRequire(path.join(HOST_MODULES, '__probe__.cjs'));
  const { compareBound } = await import('../scripts/verify-upstream.mjs');
  const pkg = await readPkg();
  for (const [peer, floor] of Object.entries(pkg.peerDependencies ?? {})) {
    const version = hostRequire(`${peer}/package.json`).version;
    const verdict = compareBound(floor, version);
    assert.equal(verdict.needsAdjustment, false, `${peer} ${version} must satisfy ${floor}: ${verdict.reason}`);
  }
});

test('declared bound and prerelease semantics are asserted on every run (T091)', async () => {
  const { compareBound } = await import('../scripts/verify-upstream.mjs');
  const manifest = await fs.readFile(path.join(PKG_ROOT, 'spec-kit-extension', 'extension.yml'), 'utf8');
  const declared = /speckit_version:\s*"([^"]+)"/.exec(manifest)?.[1];
  assert.equal(declared, '>=1.4.0', 'the extension must declare a real floor, never "*"');

  // The three LOW_BOUND_CASES, decided without a toolchain: this is the part
  // that used to be skipped together with the live install probe.
  const belowImpossible = compareBound('>=99.0.0', '1.4.4.dev0');
  assert.equal(belowImpossible.needsAdjustment, true);
  assert.equal(belowImpossible.suggestedBound, '>=1.4.4');

  const belowFinal = compareBound('>=1.4.4', '1.4.4.dev0');
  assert.equal(belowFinal.needsAdjustment, true, 'a prerelease must not satisfy a final-release floor');

  const satisfied = compareBound('>=1.4.0', '1.4.4.dev0');
  assert.equal(satisfied.needsAdjustment, false, 'a prerelease of a satisfying release is inside the floor');
  assert.equal(satisfied.suggestedBound, '>=1.4.0');

  // A missing toolchain is not drift: it is simply not executed.
  const absent = compareBound('>=1.4.0', null);
  assert.equal(absent.needsAdjustment, false);
  assert.equal(absent.observed, null);
});

const HOOK_COMMANDS = [
  'speckit-superpowers-hooks-before-implement',
  'speckit-superpowers-hooks-after-implement',
  'speckit-superpowers-hooks-before-bug-fix',
  'speckit-superpowers-hooks-after-bug-fix',
  'speckit-superpowers-hooks-guard',
  'speckit-superpowers-hooks-guidance',
];
const HOOK_EVENTS = [
  'before_implement',
  'after_implement',
  'before_bug_fix',
  'after_bug_fix',
  'before_clarify',
  'before_plan',
];

test('the packaged extension ships every hook, the guard and the guidance command (T095)', async () => {
  const manifest = await fs.readFile(path.join(PKG_ROOT, 'spec-kit-extension', 'extension.yml'), 'utf8');
  for (const event of HOOK_EVENTS) assert.match(manifest, new RegExp(`^  ${event}:`, 'm'), `${event} must be declared`);
  for (const command of HOOK_COMMANDS) {
    // The manifest declares dotted ids (`speckit.superpowers-hooks.guard`); the
    // host renders them as dash-separated skill directories.
    const dotted = command.replace(/^speckit-superpowers-hooks-/, 'speckit.superpowers-hooks.');
    assert.match(manifest, new RegExp(`name: ${dotted.replace(/\./g, '\\.')}`), `${dotted} must be provided`);
    const file = path.join(PKG_ROOT, 'spec-kit-extension', 'commands', `${dotted}.md`);
    assert.ok(fsSync.existsSync(file), `${command} must ship a command document`);
  }
  assert.match(manifest, /events:\n\s+session_start:/, 'session_start must stay declared for Claude/Codex/Cursor');
  // The guard and the guidance command are the two the repo itself once missed,
  // so their scripts must exist next to the documents that call them.
  for (const script of ['guard.sh', 'guidance.sh', '_cli.sh']) {
    assert.ok(
      fsSync.existsSync(path.join(PKG_ROOT, 'spec-kit-extension', 'scripts', 'bash', script)),
      `${script} must ship with the extension`
    );
  }
});

test('reinstalling the extension renders all six hook skills and both extra commands (T095)', async (t) => {
  const probe = spawnSync('specify', ['--version'], { encoding: 'utf8', timeout: 30_000 });
  if (probe.error || probe.status !== 0) {
    t.skip('specify is not installed here; the render is covered by the static assertions above');
    return;
  }
  const home = fsSync.mkdtempSync(path.join(os.tmpdir(), 'dsh-t095-home-'));
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'dsh-t095-'));
  // The scripts resolve the CLI through _cli.sh; point them at this checkout so
  // the probe never depends on a global install and never touches ~/.dsh.
  const env = { ...process.env, HOME: home, DSH_SDD_KIT_CLI: path.join(PKG_ROOT, 'bin', 'sdd-kit.mjs') };
  try {
    const init = spawnSync('specify', ['init', '.', '--integration', 'dsh', '--non-interactive', '--force', '--ignore-agent-tools'], { cwd: dir, encoding: 'utf8', timeout: 60_000, env });
    assert.equal(init.status, 0, `specify init failed: ${init.stderr}`);
    const add = spawnSync('specify', ['extension', 'add', '--dev', path.join(PKG_ROOT, 'spec-kit-extension'), '--force'], { cwd: dir, encoding: 'utf8', timeout: 60_000, env });
    assert.equal(add.status, 0, `specify extension add failed: ${add.stderr}`);

    const skillsDir = path.join(dir, '.dsh', 'skills');
    const rendered = fsSync.readdirSync(skillsDir).filter((name) => name.startsWith('speckit-superpowers-hooks-'));
    assert.deepEqual(rendered.sort(), [...HOOK_COMMANDS].sort(), 'all six hook skills must land on disk, guard and guidance included');

    const extensions = fsSync.readFileSync(path.join(dir, '.specify', 'extensions.yml'), 'utf8');
    for (const event of HOOK_EVENTS) {
      assert.equal((extensions.match(new RegExp(`^  ${event}:`, 'gm')) ?? []).length, 1, `${event} must be registered exactly once`);
    }

    // session_start is an event, not a hook: upstream keeps it in the extension
    // manifest it copies into the project, never in extensions.yml.
    const installedManifest = fsSync.readFileSync(path.join(dir, '.specify', 'extensions', 'superpowers-hooks', 'extension.yml'), 'utf8');
    assert.match(installedManifest, /session_start:/, 'the installed manifest must still carry session_start');

    const guard = spawnSync('sh', ['.specify/extensions/superpowers-hooks/scripts/bash/guard.sh', '--json'], { cwd: dir, encoding: 'utf8', timeout: 30_000, env });
    const guardReport = JSON.parse(guard.stdout);
    assert.ok(['ok', 'error'].includes(guardReport.status), `guard must answer with a verdict, got: ${guard.stdout}`);
    assert.equal(guardReport.blocked, false, 'a fresh project has no checked tasks, so the guard must not block');

    const guidance = spawnSync('sh', ['.specify/extensions/superpowers-hooks/scripts/bash/guidance.sh', '--text'], { cwd: dir, encoding: 'utf8', timeout: 60_000, env });
    assert.equal(guidance.status, 0, `guidance script failed: ${guidance.stderr}`);
    assert.match(guidance.stdout, /## SDD 运行时纪律/, 'the session_start payload must be the real discipline text');
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
    fsSync.rmSync(home, { recursive: true, force: true });
  }
});

test('T108: documentation records measured peer floors and precise session_start channels', async () => {
  const readme = await fs.readFile(path.join(PKG_ROOT, 'README.md'), 'utf8');
  const research = await fs.readFile(path.join(PKG_ROOT, 'specs/004-multihost-runtime-governance/research.md'), 'utf8');
  const manifest = await fs.readFile(path.join(PKG_ROOT, 'spec-kit-extension/extension.yml'), 'utf8');
  assert.doesNotMatch(readme, /peerDependencies[^\n]*"\*"/);
  assert.match(research, /R8[^\n]*peerDependencies/);
  assert.match(research, />=4\.1\.0/);
  assert.match(research, />=0\.2\.2-rc\.3/);
  assert.doesNotMatch(research, /留到 M1[^\n]*测定/);
  assert.match(manifest, /Claude 原生 SessionStart；Codex 托管块；Cursor 规则目录；DSH systemPrompt/);
});
