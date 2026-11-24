import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  describeCursor,
  applyCursorGuidance,
  checkTrustFlags,
  cursorDefaultConfig,
} from '../src/adapters/cursor/index.mjs';

import { readMarkers, writeMarker } from '../src/core/marker.mjs';

const ADAPTER_SRC = await fs.readFile(
  new URL('../src/adapters/cursor/index.mjs', import.meta.url),
  'utf8'
);

async function makeRepo({ switchEnabled } = {}) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cursor-'));
  await fs.mkdir(path.join(repo, '.cursor', 'skills', 'speckit-implement'), { recursive: true });
  await fs.writeFile(path.join(repo, '.cursor', 'skills', 'speckit-implement', 'SKILL.md'), '# skill\n', 'utf8');
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cursor-empty-mirror-'));
  const mirror = path.join(root, 'superpowers');
  await fs.mkdir(path.join(mirror, 'skills'), { recursive: true });
  return { ...process.env, DSH_SDD_KIT_SUPERPOWERS_DIR: mirror, HOME: root };
}

test('Cursor adapter answers all four contract items (REQ-30)', () => {
  const contract = describeCursor();
  assert.deepEqual(Object.keys(contract).sort(), [
    'guidanceFace', 'reloadSemantics', 'skillFace', 'toolFace',
  ]);
  assert.match(contract.toolFace, /\//);
  assert.match(contract.skillFace, /\.cursor\/skills/);
  assert.match(contract.guidanceFace, /\.cursor\/rules/);
  assert.match(contract.reloadSemantics, /extension_command=none/);
});

test('Cursor writes a rule-dir file with the shared text (REQ-30)', async () => {
  const repo = await makeRepo();
  const result = await applyCursorGuidance({ cwd: repo });
  const bytes = await fs.readFile(path.join(repo, '.cursor', 'rules', 'sdd-kit-discipline.mdc'), 'utf8');
  assert.equal(result.channel, 'rule-dir');
  assert.match(bytes, /## SDD 运行时纪律（dsh-sdd-kit）/);
  const again = await applyCursorGuidance({ cwd: repo });
  assert.deepEqual(result.text, again.text);
});

test('Cursor trust flags yield an explicit security warning, never a default (REQ-31/AC-17)', () => {
  assert.deepEqual(checkTrustFlags('--trust --approve-mcps --force -p'), [
    '--trust', '--approve-mcps', '--force', '-p',
  ]);
  assert.deepEqual(checkTrustFlags('speckit-implement'), []);
  const config = cursorDefaultConfig();
  const serialized = JSON.stringify(config);
  assert.equal(checkTrustFlags(serialized).length, 0, 'default config must not contain trust flags');
});

test('a closed guidance switch writes no Cursor rule and reports its state (T067)', async () => {
  const repo = await makeRepo({ switchEnabled: false });
  const result = await applyCursorGuidance({ cwd: repo });
  assert.equal(result.enabled, false);
  assert.equal(result.written, false);
  await assert.rejects(fs.access(path.join(repo, '.cursor', 'rules', 'sdd-kit-discipline.mdc')));
});

test('an empty upstream mirror writes no Cursor rule but keeps warnings readable (T069)', async () => {
  const repo = await makeRepo();
  const result = await applyCursorGuidance({ cwd: repo, env: await emptyMirrorEnv() });
  assert.equal(result.enabled, true, 'the switch still decides enabled');
  assert.equal(result.written, false);
  assert.ok(result.warnings.some((w) => /纪律技能/.test(w)), `warnings must be readable: ${result.warnings}`);
  await assert.rejects(fs.access(path.join(repo, '.cursor', 'rules', 'sdd-kit-discipline.mdc')));
});

test('closing the switch after a write removes the Cursor rule (C2/REQ-12/AC-08)', async () => {
  const repo = await makeRepo();
  const first = await applyCursorGuidance({ cwd: repo });
  assert.equal(first.written, true);
  const target = path.join(repo, '.cursor', 'rules', 'sdd-kit-discipline.mdc');
  await fs.access(target);

  await fs.writeFile(
    path.join(repo, '.specify', 'sdd-kit.json'),
    JSON.stringify({ guidance: { enabled: false } }),
    'utf8'
  );
  const closed = await applyCursorGuidance({ cwd: repo });
  assert.equal(closed.enabled, false);
  assert.equal(closed.written, false);
  assert.equal(closed.removed, true, 'the stale rule must be reported as removed');
  await assert.rejects(fs.access(target), 'a closed switch must leave no resident Cursor rule behind');
});

test('an empty upstream mirror also removes a previously written Cursor rule (C2/REQ-12)', async () => {
  const repo = await makeRepo();
  await applyCursorGuidance({ cwd: repo });
  const emptied = await applyCursorGuidance({ cwd: repo, env: await emptyMirrorEnv() });
  assert.equal(emptied.written, false);
  assert.equal(emptied.removed, true);
  await assert.rejects(fs.access(path.join(repo, '.cursor', 'rules', 'sdd-kit-discipline.mdc')));
});

test('Cursor startup clears only its own pending marker (T081)', async () => {
  const repo = await makeRepo({ switchEnabled: false });
  await writeMarker({ cwd: repo, host: 'dsh', reason: 'dsh pending' });
  await writeMarker({ cwd: repo, host: 'cursor', reason: 'cursor pending' });
  const result = await applyCursorGuidance({ cwd: repo });
  assert.equal(result.enabled, false, 'clearing happens before the guidance gates');
  assert.deepEqual(Object.keys(await readMarkers({ cwd: repo })), ['dsh']);
});

test('a marker that cannot be cleared never blocks Cursor guidance (T081)', async () => {
  const repo = await makeRepo();
  await writeMarker({ cwd: repo, host: 'cursor' });
  const specifyDir = path.join(repo, '.specify');
  await fs.chmod(specifyDir, 0o500);
  try {
    const result = await applyCursorGuidance({ cwd: repo });
    assert.equal(result.enabled, true);
    assert.match(result.text, /## SDD 运行时纪律/);
  } finally {
    await fs.chmod(specifyDir, 0o700);
  }
});

test('the Cursor adapter contains no business judgement over the shared bundle (T087)', () => {
  assert.doesNotMatch(ADAPTER_SRC, /bundle\.toolMapping/, 'adapters only format/IO the shared bundle');
  assert.doesNotMatch(ADAPTER_SRC, /bundle\.sddPointer/, 'adapters only format/IO the shared bundle');
  assert.doesNotMatch(ADAPTER_SRC, /upstreamText\s*[=!]==/, 'no upstream-text policy belongs in an adapter');
});

test('Cursor adapter is a thin shell (≤100 lines) (REQ-32)', async () => {
  assert.ok(ADAPTER_SRC.split('\n').length <= 100);
});
