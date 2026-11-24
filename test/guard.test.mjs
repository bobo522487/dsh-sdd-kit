import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkPlanningGuard } from '../src/core/guard.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PKG_ROOT, 'bin', 'sdd-kit.mjs');

async function makeFeature(tasksBody) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-guard-'));
  const featureDir = path.join(repo, 'specs', '004-multihost-runtime-governance');
  await fs.mkdir(path.join(repo, '.specify'), { recursive: true });
  await fs.mkdir(featureDir, { recursive: true });
  await fs.writeFile(
    path.join(repo, '.specify', 'feature.json'),
    JSON.stringify({ feature_directory: 'specs/004-multihost-runtime-governance' }),
    'utf8'
  );
  await fs.writeFile(path.join(featureDir, 'spec.md'), '# spec\n', 'utf8');
  if (tasksBody !== null) await fs.writeFile(path.join(featureDir, 'tasks.md'), tasksBody, 'utf8');
  return { repo, featureDir };
}

async function snapshot(dir) {
  const out = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(`${path.relative(dir, full)}:${(await fs.stat(full)).size}`);
    }
  }
  await walk(dir);
  return out;
}

test('a started implementation phase blocks planning commands (REQ-23/AC-13)', async () => {
  const { repo } = await makeFeature('- [x] T001 done\n- [ ] T002 pending\n');
  const before = await snapshot(repo);
  const result = await checkPlanningGuard({ cwd: repo });
  assert.equal(result.blocked, true);
  assert.equal(result.phase, 'implement');
  assert.match(result.message, /定义阶段|规划/);
  assert.match(result.fix, /tasks\.md/);
  assert.deepEqual(await snapshot(repo), before, 'the guard must not write anything');
});

test('an unchecked tasks.md alone does not block (REQ-23/AC-13)', async () => {
  const { repo } = await makeFeature('- [ ] T001 pending\n');
  const result = await checkPlanningGuard({ cwd: repo });
  assert.equal(result.blocked, false);
  // No plan.md exists: the shared phase detector falls back to specify (T093).
  assert.equal(result.phase, 'specify');
});

test('a feature without tasks.md does not block (AC-13)', async () => {
  const { repo } = await makeFeature(null);
  const result = await checkPlanningGuard({ cwd: repo });
  assert.equal(result.blocked, false);
});

test('the guard shares the phase implementation with the guidance pointer (REQ-23)', async () => {
  const { detectFeaturePhase } = await import('../src/core/feature-phase.mjs');
  const { repo } = await makeFeature('- [x] T001 done\n');
  const phase = (await detectFeaturePhase({ cwd: repo })).phase;
  const guard = await checkPlanningGuard({ cwd: repo });
  assert.equal(guard.phase, phase);
});

test('CLI guard exits non-zero with the four-field contract when blocked (AC-13)', async () => {
  const { repo } = await makeFeature('- [x] T001 done\n');
  const result = spawnSync(process.execPath, [CLI, 'guard', '--json', '--cwd', repo], {
    cwd: PKG_ROOT, encoding: 'utf8', timeout: 10_000,
  });
  const parsed = JSON.parse(result.stdout);
  assert.equal(result.status, 1);
  assert.equal(parsed.status, 'error');
  assert.equal(parsed.code, 'E_PLANNING_GUARD');
  assert.equal(typeof parsed.message, 'string');
  assert.equal(typeof parsed.fix, 'string');
});

test('CLI guard exits zero when planning is still allowed (AC-13)', async () => {
  const { repo } = await makeFeature('- [ ] T001 pending\n');
  const result = spawnSync(process.execPath, [CLI, 'guard', '--json', '--cwd', repo], {
    cwd: PKG_ROOT, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.blocked, false);
});
