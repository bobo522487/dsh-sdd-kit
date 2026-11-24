import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { detectFeaturePhase, nextCommandForPhase } from '../src/core/feature-phase.mjs';

async function makeRepo(files) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-phase-'));
  const featureDir = path.join(repo, 'specs', '001-demo');
  await fs.mkdir(featureDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(featureDir, name), content, 'utf8');
  }
  return repo;
}

test('unchecked tasks.md without plan.md falls back to specify (phase 12 / T093)', async () => {
  const repo = await makeRepo({
    'spec.md': '# spec',
    'tasks.md': '- [ ] T001 pending\n- [ ] T002 pending\n',
  });
  const result = await detectFeaturePhase({ cwd: repo });
  assert.equal(result.phase, 'specify');
  assert.equal(result.nextCommand, '/speckit-clarify');
  assert.equal(result.featureDir, path.join(repo, 'specs', '001-demo'));
});

test('unchecked tasks.md with plan.md still reports plan (T093)', async () => {
  const repo = await makeRepo({ 'spec.md': '# spec', 'plan.md': '# plan', 'tasks.md': '- [ ] T001 pending\n' });
  assert.equal((await detectFeaturePhase({ cwd: repo })).phase, 'plan');
});

test('a checked task wins over plan.md (REQ-23/AC-13)', async () => {
  const repo = await makeRepo({ 'plan.md': '# plan', 'tasks.md': '- [x] T001 done\n' });
  assert.equal((await detectFeaturePhase({ cwd: repo })).phase, 'implement');
});

test('plan.md without tasks.md reports plan; spec.md alone reports specify', async () => {
  const withPlan = await makeRepo({ 'spec.md': '# s', 'plan.md': '# p' });
  const withSpec = await makeRepo({ 'spec.md': '# s' });
  assert.equal((await detectFeaturePhase({ cwd: withPlan })).phase, 'plan');
  assert.equal((await detectFeaturePhase({ cwd: withSpec })).phase, 'specify');
});

test('a repo without feature artifacts reports constitution', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-phase-empty-'));
  const result = await detectFeaturePhase({ cwd: repo });
  assert.equal(result.phase, 'constitution');
  assert.equal(result.nextCommand, nextCommandForPhase('constitution'));
});
