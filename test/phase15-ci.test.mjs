import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPAT = path.join(PKG_ROOT, 'test', 'compat.test.mjs');

test('T107: the install-time version-bound case is not hidden behind an integration skip', async () => {
  const source = await fs.readFile(COMPAT, 'utf8');
  assert.doesNotMatch(
    source,
    /skip:\s*!process\.env\.DSH_SDD_KIT_INTEGRATION/,
    'the case must be part of the normal compat run'
  );
  assert.doesNotMatch(
    source,
    /if \(init\.status !== 0\) continue/,
    'a failed init must not be silently skipped either'
  );
  assert.match(
    source,
    /not_executed \(REQ-42\)/,
    'an unavailable toolchain must be named explicitly, not skipped'
  );
});

test('T107: compat exits non-zero with an explicit not_executed when specify is absent', async () => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-t107-empty-'));
  try {
    const result = spawnSync(process.execPath, ['--test', COMPAT], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { PATH: empty, HOME: empty, TMPDIR: empty },
    });
    assert.notEqual(
      result.status,
      0,
      `REQ-42: not_executed must fail the process; stdout=${result.stdout}\nstderr=${result.stderr}`
    );
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /not_executed \(REQ-42\)/, 'the report must name the REQ-42 verdict');
    assert.match(output, /version bound failures happen at install time/, 'the named case must be the one that failed');
  } finally {
    await fs.rm(empty, { recursive: true, force: true });
  }
});

test('T107: CI runs the install-time compat gate after installing specify with the probe enabled', async () => {
  const workflow = await fs.readFile(path.join(PKG_ROOT, '.github', 'workflows', 'upstream-integration.yml'), 'utf8');
  const cliStep = workflow.indexOf('- name: Install the CLI under test');
  const command = workflow.indexOf('node --test test/compat.test.mjs');
  assert.ok(cliStep >= 0, 'the matrix must install specify before probing compatibility');
  assert.ok(command > cliStep, 'the install-time probe must run after specify exists on PATH');

  const stepStart = workflow.lastIndexOf('      - name:', command);
  const nextStep = workflow.indexOf('      - name:', command + 1);
  const step = workflow.slice(stepStart, nextStep === -1 ? undefined : nextStep);
  assert.match(step, /DSH_SDD_KIT_INTEGRATION:\s*['"]1['"]/, 'CI must enable the install probe deterministically');
  assert.match(step, /DSH_SDD_KIT_HOST_MODULES/, 'the optional real-host probe channel must survive');
  assert.match(step, /not_executed/, 'the step must document the REQ-42 verdict');

  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // otherwise the child --test run skips all files
  const result = spawnSync(process.execPath, ['--test', COMPAT], { encoding: 'utf8', timeout: 120_000, env });
  assert.equal(result.status, 0, `the real-toolchain compat run must exit 0: ${result.stdout}\n${result.stderr}`);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /✔ version bound failures happen at install time/,
    'the install-time case must actually execute in the normal compat run'
  );
});

test('T107: stop-loss and research record the normal install-time gate semantics', async () => {
  const stopLoss = await fs.readFile(path.join(PKG_ROOT, 'docs', 'adapters', 'stop-loss.md'), 'utf8');
  assert.match(stopLoss, /DSH_SDD_KIT_INTEGRATION=1/, 'M4 must name the deterministic CI probe setting');
  assert.match(stopLoss, /not_executed \(REQ-42\)/, 'M4 must record the explicit unavailable verdict');
  const research = await fs.readFile(path.join(PKG_ROOT, 'specs', '004-multihost-runtime-governance', 'research.md'), 'utf8');
  assert.match(research, /T107 常态执行记录/, 'R7 must record the T107 semantics');
  assert.match(research, /not_executed \(REQ-42\)/, 'R7 must record the unavailable verdict');
});
