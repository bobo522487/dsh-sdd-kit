import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  describeClaude,
  applyClaudeGuidance,
  claudeManagedBlock,
} from '../src/adapters/claude/index.mjs';

async function makeRepo() {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-claude-'));
  await fs.mkdir(path.join(repo, '.claude', 'skills', 'sdd-setup'), { recursive: true });
  await fs.writeFile(path.join(repo, '.claude', 'skills', 'sdd-setup', 'SKILL.md'), '# sdd-setup\n', 'utf8');
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

test('Claude adapter answers all four contract items with host-specific facts (REQ-26)', () => {
  const contract = describeClaude();
  assert.deepEqual(Object.keys(contract).sort(), [
    'guidanceFace', 'reloadSemantics', 'skillFace', 'toolFace',
  ]);
  assert.match(contract.toolFace, /CLI/);
  assert.match(contract.guidanceFace, /session_start|托管块/);
  assert.match(contract.skillFace, /\.claude\/skills/);
  assert.match(contract.reloadSemantics, /new_session/);
});

test('Claude prefers the native session_start event and produces the shared text (REQ-26/REQ-27)', async () => {
  const repo = await makeRepo();
  const result = await applyClaudeGuidance({ cwd: repo, nativeEventsAvailable: true });
  assert.equal(result.channel, 'native-event');
  assert.match(result.text, /## SDD 运行时纪律（dsh-sdd-kit）/);
  assert.equal(result.installHint, null);
});

test('Claude falls back to an idempotent managed block when native events are unavailable (REQ-26/REQ-28)', async () => {
  const repo = await makeRepo();
  const first = await applyClaudeGuidance({ cwd: repo, nativeEventsAvailable: false });
  const bytes1 = await fs.readFile(path.join(repo, '.claude', 'sdd-kit-discipline.md'), 'utf8');
  const second = await applyClaudeGuidance({ cwd: repo, nativeEventsAvailable: false });
  const bytes2 = await fs.readFile(path.join(repo, '.claude', 'sdd-kit-discipline.md'), 'utf8');
  assert.equal(first.channel, 'managed-block');
  assert.equal(second.channel, 'managed-block');
  assert.equal(bytes1, bytes2, 'managed block must be byte-identical on repeat');
  assert.equal(claudeManagedBlock(first.text), bytes1);
});

test('a missing discipline plugin only yields an install hint, not a failure (REQ-28)', async () => {
  const repo = await makeRepo();
  await fs.rm(path.join(repo, '.claude', 'skills'), { recursive: true, force: true });
  const result = await applyClaudeGuidance({ cwd: repo, nativeEventsAvailable: true });
  assert.match(result.installHint, /sdd-setup|specify extension add/);
  assert.match(result.text, /## SDD 运行时纪律/);
});

test('Claude adapter is a thin shell (≤100 lines) (REQ-01)', async () => {
  const raw = await fs.readFile(
    new URL('../src/adapters/claude/index.mjs', import.meta.url),
    'utf8'
  );
  assert.ok(raw.split('\n').length <= 100, 'Claude adapter must be ≤100 lines');
});
