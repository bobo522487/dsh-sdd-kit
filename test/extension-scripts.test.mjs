import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolvePosixShell, POSIX_SHELL_SKIP } from './posix-shell.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(PKG_ROOT, 'spec-kit-extension', 'scripts', 'bash');
const CLI = path.join(PKG_ROOT, 'bin', 'sdd-kit.mjs');
const SHELL = resolvePosixShell();

function runScript(script, { cwd, cli = CLI } = {}) {
  return spawnSync(SHELL.shell, [path.join(SCRIPTS, script)], {
    cwd: cwd ?? PKG_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, DSH_SDD_KIT_CLI: cli },
  });
}

async function makeRepo(tasksBody) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ext-'));
  const featureDir = path.join(repo, 'specs', '004-multihost-runtime-governance');
  await fs.mkdir(path.join(repo, '.specify'), { recursive: true });
  await fs.mkdir(featureDir, { recursive: true });
  await fs.writeFile(
    path.join(repo, '.specify', 'feature.json'),
    JSON.stringify({ feature_directory: 'specs/004-multihost-runtime-governance' }),
    'utf8'
  );
  await fs.writeFile(path.join(featureDir, 'spec.md'), '# spec\n', 'utf8');
  if (tasksBody) await fs.writeFile(path.join(featureDir, 'tasks.md'), tasksBody, 'utf8');
  return repo;
}

test('the session-start script emits the shared guidance text (REQ-27)', (t) => {
  if (!SHELL.available) return t.skip(POSIX_SHELL_SKIP);
  const result = runScript('guidance.sh');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /## SDD 运行时纪律（dsh-sdd-kit）/);
  assert.match(result.stdout, /sdd_upstream/);
});

test('the session-start script degrades silently when the package is absent (REQ-27)', (t) => {
  if (!SHELL.available) return t.skip(POSIX_SHELL_SKIP);
  const result = runScript('guidance.sh', { cli: '/nonexistent/sdd-kit.mjs' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '');
});

test('the guard script mirrors the CLI exit code (REQ-23/AC-13)', async (t) => {
  if (!SHELL.available) return t.skip(POSIX_SHELL_SKIP);
  const blocked = runScript('guard.sh', { cwd: await makeRepo('- [x] T001 done\n') });
  assert.equal(blocked.status, 1);
  assert.equal(JSON.parse(blocked.stdout).code, 'E_PLANNING_GUARD');

  const allowed = runScript('guard.sh', { cwd: await makeRepo('- [ ] T001 pending\n') });
  assert.equal(allowed.status, 0);
  assert.equal(JSON.parse(allowed.stdout).blocked, false);
});

test('a missing installation lets the guarded command proceed (REQ-23)', async (t) => {
  if (!SHELL.available) return t.skip(POSIX_SHELL_SKIP);
  const result = runScript('guard.sh', {
    cwd: await makeRepo('- [x] T001 done\n'),
    cli: '/nonexistent/sdd-kit.mjs',
  });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /未安装/);
});
