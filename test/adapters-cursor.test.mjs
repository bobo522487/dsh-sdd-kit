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

async function makeRepo() {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cursor-'));
  await fs.mkdir(path.join(repo, '.cursor', 'skills', 'sdd-setup'), { recursive: true });
  await fs.writeFile(path.join(repo, '.cursor', 'skills', 'sdd-setup', 'SKILL.md'), '# sdd-setup\n', 'utf8');
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

test('Cursor adapter is a thin shell (≤100 lines) (REQ-32)', async () => {
  const raw = await fs.readFile(new URL('../src/adapters/cursor/index.mjs', import.meta.url), 'utf8');
  assert.ok(raw.split('\n').length <= 100);
});
