import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  describeCodex,
  applyCodexGuidance,
  codexManagedBlock,
} from '../src/adapters/codex/index.mjs';

async function makeRepo() {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-codex-'));
  await fs.mkdir(path.join(repo, '.agents', 'skills', 'sdd-setup'), { recursive: true });
  await fs.writeFile(path.join(repo, '.agents', 'skills', 'sdd-setup', 'SKILL.md'), '# sdd-setup\n', 'utf8');
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

test('Codex adapter answers all four contract items (REQ-29)', () => {
  const contract = describeCodex();
  assert.deepEqual(Object.keys(contract).sort(), [
    'guidanceFace', 'reloadSemantics', 'skillFace', 'toolFace',
  ]);
  assert.match(contract.toolFace, /\$/);
  assert.match(contract.skillFace, /\.agents\/skills/);
  assert.match(contract.guidanceFace, /托管块|managed-block/);
});

test('Codex writes an idempotent project-level managed block (REQ-29)', async () => {
  const repo = await makeRepo();
  const first = await applyCodexGuidance({ cwd: repo });
  const bytes1 = await fs.readFile(path.join(repo, '.codex', 'sdd-kit-discipline.md'), 'utf8');
  const second = await applyCodexGuidance({ cwd: repo });
  const bytes2 = await fs.readFile(path.join(repo, '.codex', 'sdd-kit-discipline.md'), 'utf8');
  assert.equal(first.channel, 'managed-block');
  assert.equal(second.channel, 'managed-block');
  assert.equal(bytes1, bytes2);
  assert.equal(codexManagedBlock(first.text), bytes1);
});

test('Codex adapter is a thin shell (≤100 lines) (REQ-32)', async () => {
  const raw = await fs.readFile(new URL('../src/adapters/codex/index.mjs', import.meta.url), 'utf8');
  assert.ok(raw.split('\n').length <= 100);
});
