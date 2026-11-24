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

import { readMarkers, writeMarker } from '../src/core/marker.mjs';

const ADAPTER_SRC = await fs.readFile(
  new URL('../src/adapters/codex/index.mjs', import.meta.url),
  'utf8'
);

async function makeRepo({ switchEnabled } = {}) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-codex-'));
  await fs.mkdir(path.join(repo, '.agents', 'skills', 'speckit-implement'), { recursive: true });
  await fs.writeFile(path.join(repo, '.agents', 'skills', 'speckit-implement', 'SKILL.md'), '# skill\n', 'utf8');
  await fs.mkdir(path.join(repo, '.specify'), { recursive: true });
  await fs.writeFile(
    path.join(repo, '.specify', 'feature.json'),
    JSON.stringify({ feature_directory: 'specs/004-multihost-runtime-governance' }),
    'utf8'
  );
  await fs.mkdir(path.join(repo, 'specs', '004-multihost-runtime-governance'), { recursive: true });
  await fs.writeFile(path.join(repo, 'specs', '004-multihost-runtime-governance', 'spec.md'), '# spec\n', 'utf8');
  if (typeof switchEnabled === 'boolean') {
    await fs.writeFile(
      path.join(repo, '.specify', 'sdd-kit.json'),
      JSON.stringify({ guidance: { enabled: switchEnabled } }),
      'utf8'
    );
  }
  return repo;
}

async function emptyMirrorEnv() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-codex-empty-mirror-'));
  const mirror = path.join(root, 'superpowers');
  await fs.mkdir(path.join(mirror, 'skills'), { recursive: true });
  return { ...process.env, DSH_SDD_KIT_SUPERPOWERS_DIR: mirror, HOME: root };
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

test('a closed guidance switch writes no Codex block and reports its state (T067)', async () => {
  const repo = await makeRepo({ switchEnabled: false });
  const result = await applyCodexGuidance({ cwd: repo });
  assert.equal(result.enabled, false);
  assert.equal(result.written, false);
  await assert.rejects(fs.access(path.join(repo, '.codex', 'sdd-kit-discipline.md')));
});

test('an empty upstream mirror writes no Codex file but keeps warnings readable (T069)', async () => {
  const repo = await makeRepo();
  const result = await applyCodexGuidance({ cwd: repo, env: await emptyMirrorEnv() });
  assert.equal(result.enabled, true, 'the switch still decides enabled');
  assert.equal(result.written, false);
  assert.ok(result.warnings.some((w) => /纪律技能/.test(w)), `warnings must be readable: ${result.warnings}`);
  await assert.rejects(fs.access(path.join(repo, '.codex', 'sdd-kit-discipline.md')));
});

test('closing the switch after a write removes the Codex block (C2/REQ-12/AC-08)', async () => {
  const repo = await makeRepo();
  const first = await applyCodexGuidance({ cwd: repo });
  assert.equal(first.written, true);
  await fs.access(path.join(repo, '.codex', 'sdd-kit-discipline.md'));

  await fs.writeFile(
    path.join(repo, '.specify', 'sdd-kit.json'),
    JSON.stringify({ guidance: { enabled: false } }),
    'utf8'
  );
  const closed = await applyCodexGuidance({ cwd: repo });
  assert.equal(closed.enabled, false);
  assert.equal(closed.written, false);
  assert.equal(closed.removed, true, 'the stale block must be reported as removed');
  await assert.rejects(
    fs.access(path.join(repo, '.codex', 'sdd-kit-discipline.md')),
    'a closed switch must leave no resident Codex content behind'
  );
});

test('an empty upstream mirror also removes a previously written Codex block (C2/REQ-12)', async () => {
  const repo = await makeRepo();
  await applyCodexGuidance({ cwd: repo });
  const emptied = await applyCodexGuidance({ cwd: repo, env: await emptyMirrorEnv() });
  assert.equal(emptied.written, false);
  assert.equal(emptied.removed, true);
  await assert.rejects(fs.access(path.join(repo, '.codex', 'sdd-kit-discipline.md')));
});

test('a user-authored Codex file without the managed markers is never deleted (C2)', async () => {
  const repo = await makeRepo({ switchEnabled: false });
  const target = path.join(repo, '.codex', 'sdd-kit-discipline.md');
  const userText = '# 我自己的 Codex 纪律\n\n- 用户手写内容，不含 sdd-kit 标记\n';
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, userText, 'utf8');

  const result = await applyCodexGuidance({ cwd: repo });
  assert.equal(result.written, false);
  assert.equal(result.removed, false, 'a foreign file must be reported as kept');
  assert.equal(await fs.readFile(target, 'utf8'), userText, 'user content must survive byte for byte');
});

test('a natively injecting Codex host removes the resident managed block (C2/REQ-12)', async () => {
  const repo = await makeRepo();
  await applyCodexGuidance({ cwd: repo });
  const target = path.join(repo, '.codex', 'sdd-kit-discipline.md');
  await fs.access(target);

  const native = await applyCodexGuidance({ cwd: repo, nativeEventsAvailable: true });
  assert.equal(native.channel, 'native-event');
  assert.equal(native.written, false, 'a native-event host must not write a file');
  assert.equal(native.removed, true);
  await assert.rejects(fs.access(target), 'native injection must not leave a stale block behind');
});

test('Codex startup clears only its own pending marker (T081)', async () => {
  const repo = await makeRepo({ switchEnabled: false });
  await writeMarker({ cwd: repo, host: 'dsh', reason: 'dsh pending' });
  await writeMarker({ cwd: repo, host: 'codex', reason: 'codex pending' });
  const result = await applyCodexGuidance({ cwd: repo });
  assert.equal(result.enabled, false, 'clearing happens before the guidance gates');
  assert.deepEqual(Object.keys(await readMarkers({ cwd: repo })), ['dsh']);
});

test('a marker that cannot be cleared never blocks Codex guidance (T081)', async () => {
  const repo = await makeRepo();
  await writeMarker({ cwd: repo, host: 'codex' });
  const specifyDir = path.join(repo, '.specify');
  await fs.chmod(specifyDir, 0o500);
  try {
    const result = await applyCodexGuidance({ cwd: repo });
    assert.equal(result.enabled, true);
    assert.match(result.text, /## SDD 运行时纪律/);
  } finally {
    await fs.chmod(specifyDir, 0o700);
  }
});

test('the Codex adapter contains no business judgement over the shared bundle (T087)', () => {
  assert.doesNotMatch(ADAPTER_SRC, /bundle\.toolMapping/, 'adapters only format/IO the shared bundle');
  assert.doesNotMatch(ADAPTER_SRC, /bundle\.sddPointer/, 'adapters only format/IO the shared bundle');
  assert.doesNotMatch(ADAPTER_SRC, /upstreamText\s*[=!]==/, 'no upstream-text policy belongs in an adapter');
});

test('Codex adapter is a thin shell (≤100 lines) (REQ-32)', async () => {
  assert.ok(ADAPTER_SRC.split('\n').length <= 100);
});
