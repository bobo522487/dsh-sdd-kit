import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runDoctor } from '../src/core/doctor.mjs';

const ZONES = ['environment', 'host', 'repository', 'runtime', 'triggerDryRun'];
const ZONE_STATUSES = new Set(['pass', 'fail', 'skipped', 'not_executed']);
const ITEM_STATUSES = new Set(['pass', 'fail', 'warn', 'skip']);

async function makeRepo() {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-doctor-'));
  await fs.mkdir(path.join(repo, '.specify'), { recursive: true });
  await fs.writeFile(
    path.join(repo, '.specify', 'feature.json'),
    JSON.stringify({ feature_directory: 'specs/004-multihost-runtime-governance' }),
    'utf8'
  );
  await fs.mkdir(path.join(repo, 'specs', '004-multihost-runtime-governance'), { recursive: true });
  await fs.writeFile(path.join(repo, 'specs', '004-multihost-runtime-governance', 'spec.md'), '# spec\n', 'utf8');
  return repo;
}

function assertShape(report) {
  assert.deepEqual(Object.keys(report), ZONES);
  for (const zone of ZONES) {
    assert.ok(ZONE_STATUSES.has(report[zone].status), `${zone} status invalid: ${report[zone].status}`);
    assert.ok(Array.isArray(report[zone].items));
    for (const item of report[zone].items) {
      assert.ok(ITEM_STATUSES.has(item.status), `${zone} item status invalid: ${item.status}`);
      for (const key of ['status', 'code', 'message', 'fix']) {
        assert.ok(key in item, `${zone} item missing ${key}`);
      }
    }
  }
}

async function snapshot(root) {
  const out = {};
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out[path.relative(root, full)] = await fs.readFile(full, 'utf8');
    }
  }
  await walk(root);
  return out;
}

test('doctor reports all five zones with the two distinct status enums (REQ-33/REQ-39)', async () => {
  const repo = await makeRepo();
  const report = await runDoctor({ cwd: repo, host: 'dsh' });
  assertShape(report);
});

test('a failing zone does not suppress the other four (REQ-33)', async () => {
  const repo = await makeRepo();
  const report = await runDoctor({
    cwd: repo,
    host: 'dsh',
    deps: {
      environment: async () => { throw new Error('probe exploded'); },
    },
  });
  assertShape(report);
  assert.equal(report.environment.status, 'fail');
  for (const zone of ZONES.filter((z) => z !== 'environment')) {
    assert.notEqual(report[zone].items.length, 0, `${zone} must still report`);
  }
});

test('repeated doctor runs are byte-identical and change no file (REQ-39)', async () => {
  const repo = await makeRepo();
  const before = await snapshot(repo);
  const first = await runDoctor({ cwd: repo, host: 'dsh' });
  const second = await runDoctor({ cwd: repo, host: 'dsh' });
  const after = await snapshot(repo);
  assert.deepEqual(first, second);
  assert.deepEqual(before, after);
});

test('doctor without network probes finishes within 5 seconds (AC-18)', async () => {
  const repo = await makeRepo();
  const started = process.hrtime.bigint();
  await runDoctor({ cwd: repo, host: 'dsh' });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs <= 5000, `doctor took ${elapsedMs.toFixed(1)}ms`);
});

test('the trigger zone scores only visible skills and executes nothing (REQ-38/AC-19)', async () => {
  const repo = await makeRepo();
  const skills = [{
    name: 'debugging', description: 'debug failing test', whenToUse: '',
    source: 'plugin', provider: 'plugin', path: '/skills/debugging',
    invocation: { userInvocable: true, modelInvocable: true },
  }];
  const report = await runDoctor({ cwd: repo, host: 'dsh', trigger: 'debug failing test', skills });
  assertShape(report);
  assert.equal(report.triggerDryRun.status, 'pass');
  assert.equal(report.triggerDryRun.items[0].code, 'TRIGGER_SCORES');
  assert.ok(report.triggerDryRun.items[0].scores[0].score > 0);
});

test('CLI doctor exposes the five zones as JSON (T054)', async () => {
  const repo = await makeRepo();
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['bin/sdd-kit.mjs', 'doctor', '--json', '--cwd', repo], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assertShape(JSON.parse(result.stdout));
});
