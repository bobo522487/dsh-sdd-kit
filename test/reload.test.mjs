import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as reloadModule from '../src/core/reload.mjs';
import { decideReload } from '../src/core/reload.mjs';
import { runAction } from '../src/core/action.mjs';

test('reload decision matrix: DSH restarts the host, external hosts open a new session (REQ-15/AC-09)', () => {
  const dsh = decideReload({ layers: ['tool_code'] }, 'dsh');
  assert.equal(dsh.result, 'restart_host');
  assert.equal(dsh.host, 'dsh');
  assert.deepEqual(dsh.layers, ['tool_code']);
  assert.match(dsh.reason, /tool_code/);
  assert.match(dsh.reason, /dsh/);

  for (const host of ['claude', 'codex', 'cursor']) {
    const decision = decideReload({ layers: ['tool_code', 'skill_data'] }, host);
    assert.equal(decision.result, 'new_session');
    assert.equal(decision.host, host);
    assert.deepEqual(decision.layers, ['tool_code', 'skill_data']);
  }
});

test('extension command changes never force a host restart (REQ-16)', () => {
  assert.equal(decideReload({ layers: ['extension_command'] }, 'dsh').result, 'new_session');
  // Cursor declares no reload requirement for extension commands in HOST_CAPABILITIES.
  assert.equal(decideReload({ layers: ['extension_command'] }, 'cursor').result, 'none');
});

test('empty change set resolves to none and never writes state (REQ-16/AC-09)', () => {
  const decision = decideReload({ layers: [] }, 'dsh');
  assert.equal(decision.result, 'none');
  assert.deepEqual(decision.layers, []);
  assert.equal(decision.host, 'dsh');
  assert.equal(typeof decision.reason, 'string');
});

test('reload policy has exactly one implementation (REQ-17/T026)', () => {
  const exported = Object.keys(reloadModule).sort();
  assert.deepEqual(exported, ['decideReload']);
});

test('unknown host keys are rejected instead of silently defaulting (AC-09)', () => {
  assert.throws(() => decideReload({ layers: ['tool_code'] }, 'unknown-host'), /unknown host/i);
});

test('runAction update reports reload decision and writes the pending marker (REQ-17/T029)', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reload-action-'));
  await fs.mkdir(path.join(repo, '.specify'), { recursive: true });
  const fakeUpdate = async () => ({
    action: 'update',
    ok: true,
    components: [
      { component: 'spec-kit', outcome: 'updated' },
      { component: 'superpowers', outcome: 'unchanged' },
    ],
    requiresRestart: true,
    errors: [],
  });
  const result = await runAction('update', { cwd: repo, host: 'dsh' }, { runUpdate: fakeUpdate });
  assert.equal(result.action, 'update');
  assert.equal(result.reload.result, 'restart_host');
  assert.equal(result.reload.host, 'dsh');
  assert.equal(result.reload.markerPath, path.join(repo, '.specify', 'sdd-pending.json'));
  const stored = JSON.parse(await fs.readFile(result.reload.markerPath, 'utf8'));
  assert.equal(stored.dsh.layer, 'tool_code');
  assert.equal(stored.dsh.reason.length > 0, true);
});

test('an unchanged update writes no marker (REQ-20)', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reload-none-'));
  await fs.mkdir(path.join(repo, '.specify'), { recursive: true });
  const fakeUpdate = async () => ({
    action: 'update', ok: true,
    components: [{ component: 'spec-kit', outcome: 'unchanged' }],
    requiresRestart: false, errors: [],
  });
  const result = await runAction('update', { cwd: repo, host: 'dsh' }, { runUpdate: fakeUpdate });
  assert.equal(result.reload.result, 'none');
  await assert.rejects(fs.readFile(path.join(repo, '.specify', 'sdd-pending.json'), 'utf8'));
});
