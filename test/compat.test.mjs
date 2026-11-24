import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readPkg() {
  return JSON.parse(await fs.readFile(path.join(PKG_ROOT, 'package.json'), 'utf8'));
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
