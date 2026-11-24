import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as reloadModule from '../src/core/reload.mjs';
import { decideReload } from '../src/core/reload.mjs';
import { runAction } from '../src/core/action.mjs';
import { runUpdate, reloadFollowUp } from '../src/core/update.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  assert.throws(() => decideReload({ layers: ['tool_code'] }, 'unknown-host'), /未知的宿主/);
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

test('a none decision with a non-empty layer set explains that no action is needed (AC-09)', () => {
  const decision = decideReload({ layers: ['extension_command'] }, 'cursor');
  assert.equal(decision.result, 'none');
  assert.deepEqual(decision.layers, ['extension_command']);
  assert.match(decision.reason, /无需/);
  assert.doesNotMatch(decision.reason, /新开会话|重启宿主/);
  assert.match(decision.reason, /extension_command/);
});

test('only new_session and restart_host decisions carry a reload instruction (AC-09)', () => {
  const restart = decideReload({ layers: ['tool_code'] }, 'dsh');
  assert.match(restart.reason, /重启宿主/);
  const session = decideReload({ layers: ['skill_data'] }, 'claude');
  assert.match(session.reason, /新开会话/);
  assert.doesNotMatch(session.reason, /重启宿主/);
});

test('a failed update writes no pending marker (REQ-17/REQ-20)', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reload-failed-'));
  await fs.mkdir(path.join(repo, '.specify'), { recursive: true });
  const fakeUpdate = async () => ({
    action: 'update',
    ok: false,
    components: [{ component: 'spec-kit', outcome: 'failed', error: 'boom' }],
    requiresRestart: false,
    errors: ['spec-kit: boom'],
    cwd: repo,
  });
  const result = await runAction('update', { cwd: repo, host: 'dsh' }, { runUpdate: fakeUpdate });
  assert.equal(result.ok, false);
  assert.equal(result.reload.markerPath, path.join(repo, '.specify', 'sdd-pending.json'));
  await assert.rejects(fs.readFile(path.join(repo, '.specify', 'sdd-pending.json'), 'utf8'));
});

test('a partially failed update never persists a reload marker (REQ-17/REQ-20)', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reload-partial-'));
  await fs.mkdir(path.join(repo, '.specify'), { recursive: true });
  const fakeUpdate = async () => ({
    action: 'update',
    ok: false,
    components: [
      { component: 'spec-kit', outcome: 'updated' },
      { component: 'superpowers', outcome: 'failed', error: 'mirror offline' },
    ],
    requiresRestart: true,
    errors: ['superpowers: mirror offline'],
    cwd: repo,
  });
  const result = await runAction('update', { cwd: repo, host: 'dsh' }, { runUpdate: fakeUpdate });
  assert.equal(typeof result.reload.reason, 'string');
  await assert.rejects(fs.readFile(path.join(repo, '.specify', 'sdd-pending.json'), 'utf8'));
});

test('an update that reports error status keeps the marker untouched (REQ-20)', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reload-status-error-'));
  await fs.mkdir(path.join(repo, '.specify'), { recursive: true });
  const fakeUpdate = async () => ({
    action: 'update', status: 'error', ok: false, code: 'E_UPDATE', message: 'nope', fix: 'retry',
  });
  const result = await runAction('update', { cwd: repo, host: 'dsh' }, { runUpdate: fakeUpdate });
  assert.equal(result.status, 'error');
  assert.equal(result.reload, undefined);
  await assert.rejects(fs.readFile(path.join(repo, '.specify', 'sdd-pending.json'), 'utf8'));
});

test('follow-up text comes from the host reload policy, not a hard-coded sentence (T082)', async () => {
  assert.match(reloadFollowUp({ host: 'dsh' }), /^重启 DSH 后加载更新的工具与技能$/);
  for (const host of ['claude', 'codex', 'cursor']) {
    const text = reloadFollowUp({ host });
    assert.match(text, new RegExp(host.toUpperCase(), 'i'));
    assert.match(text, /^新开一个 .+ 会话后加载更新的工具与技能$/);
    assert.doesNotMatch(text, /重启 DSH/);
  }
  const source = await fs.readFile(path.join(ROOT, 'src', 'core', 'update.mjs'), 'utf8');
  assert.doesNotMatch(source, /Restart DSH/);
});

test('extension command changes reach decideReload through the production chain (T083)', async () => {
  for (const [host, expected] of [['dsh', 'new_session'], ['claude', 'new_session'], ['cursor', 'none']]) {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), `dsh-extension-${host}-`));
    await fs.mkdir(path.join(repo, '.specify'), { recursive: true });
    const fakeUpdate = async () => ({
      action: 'update',
      ok: true,
      components: [{ component: 'extension_command', outcome: 'updated' }],
      errors: [],
      cwd: repo,
    });
    const result = await runAction('update', { cwd: repo, host }, { runUpdate: fakeUpdate });
    assert.equal(result.reload.result, expected);
    assert.deepEqual(result.reload.layers, ['extension_command']);
  }
});

test('a multi-component update records every changed layer in the marker (T080/T083)', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reload-layers-'));
  await fs.mkdir(path.join(repo, '.specify'), { recursive: true });
  const fakeUpdate = async () => ({
    action: 'update',
    ok: true,
    components: [
      { component: 'spec-kit', outcome: 'updated' },
      { component: 'superpowers', outcome: 'updated' },
      { component: 'extension_command', outcome: 'updated' },
      { component: 'ignored', outcome: 'failed' },
    ],
    errors: [],
    cwd: repo,
  });
  const result = await runAction('update', { cwd: repo, host: 'dsh' }, { runUpdate: fakeUpdate });
  assert.equal(result.reload.result, 'restart_host');
  assert.deepEqual(result.reload.layers, ['tool_code', 'skill_data', 'extension_command']);
  const stored = JSON.parse(await fs.readFile(result.reload.markerPath, 'utf8'));
  assert.deepEqual(stored.dsh.layers, ['tool_code', 'skill_data', 'extension_command']);
});

test('runUpdate surfaces injected extension changes as an extension_command component (T083)', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-extension-components-'));
  const fakeUpstream = async (args) => {
    if (args.action === 'status') {
      return { specifyCli: { version: '1.4.0' }, superpowers: { head: 'deadbeef', skillCount: 3 } };
    }
    if (args.action === 'specify_upgrade' || args.action === 'sync_superpowers') return { ok: true };
    throw new Error(`unexpected upstream action: ${args.action}`);
  };
  const report = await runUpdate(
    { cwd: repo, extensionChanges: [{ component: 'extension_command', outcome: 'updated' }] },
    { runUpstream: fakeUpstream },
  );
  assert.ok(
    report.components.some((component) => component.component === 'extension_command' && component.outcome === 'updated'),
  );
});
