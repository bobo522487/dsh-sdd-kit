import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { runAction } from '../src/core/action.mjs';
import { writeMarker } from '../src/core/marker.mjs';
import { applyDshGuidance } from '../src/adapters/dsh/index.mjs';
import { applyClaudeGuidance } from '../src/adapters/claude/index.mjs';
import { applyCodexGuidance } from '../src/adapters/codex/index.mjs';
import { applyCursorGuidance } from '../src/adapters/cursor/index.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CLI = path.join(REPO_ROOT, 'bin', 'sdd-kit.mjs');
const MARKER_FILE = '.specify/sdd-pending.json';

async function makeRepo(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sdd-phase15-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.specify'), { recursive: true });
  return root;
}

async function withEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function runCli(args, overrides) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...overrides },
      encoding: 'utf8',
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error?.code ?? 1, stdout: error?.stdout ?? '' };
  }
}

function markerCheck(report) {
  return report.runtime.items.find((entry) => entry.code === 'PENDING_MARKERS');
}

test('T106: runAction forwards host run context into writeMarker and runDoctor', async (t) => {
  const root = await makeRepo(t);
  const sessionStart = Date.now() - (36 * 60 * 60 * 1000);
  const runId = 'host-run-1';
  await withEnv({
    DSH_SDD_KIT_SESSION_START: String(sessionStart),
    DSH_SDD_KIT_RUN_ID: runId,
  }, async () => {
    await runAction('update', { cwd: root, host: 'dsh' }, {
      runUpdate: async () => ({
        action: 'update',
        cwd: root,
        ok: true,
        components: [{ component: 'superpowers', outcome: 'updated' }],
      }),
    });

    const markers = JSON.parse(await fs.readFile(path.join(root, MARKER_FILE), 'utf8'));
    assert.equal(markers.dsh?.runId, runId, '标记必须携带宿主传入的 runId');

    let doctorParams;
    await runAction('doctor', { cwd: root, host: 'dsh' }, {
      runDoctor: async (params) => {
        doctorParams = params;
        return { action: 'doctor' };
      },
    });
    assert.equal(doctorParams?.sessionStart, sessionStart, 'doctor 必须收到会话起点');
    assert.equal(doctorParams?.runId, runId, 'doctor 必须收到同一个 runId');
  });
});

test('T106: CLI doctor keeps a 48-hour same-run marker pending and ages out old residue', async (t) => {
  const root = await makeRepo(t);
  const now = Date.now();
  const runId = 'cli-run-48h';
  const env = {
    DSH_SDD_KIT_SESSION_START: String(now - (12 * 60 * 60 * 1000)),
    DSH_SDD_KIT_RUN_ID: runId,
  };
  await writeMarker({
    cwd: root,
    host: 'dsh',
    layers: ['tool_code'],
    reason: '跨会话标记',
    runId,
    now: new Date(now - (48 * 60 * 60 * 1000)).toISOString(),
  });

  const first = JSON.parse((await runCli(['doctor', '--json', '--cwd', root, '--host', 'dsh'], env)).stdout);
  assert.deepEqual(markerCheck(first)?.pending, ['dsh'], '48 小时但同一运行的标记必须仍判 pending');
  assert.deepEqual(markerCheck(first)?.history, [], '同一运行的标记不得仅凭时间窗口降级为 history');

  const cleared = await runCli(['guidance', '--host', 'dsh', '--cwd', root, '--clear-marker'], env);
  assert.equal(cleared.code, 0, 'doctor 建议的清理命令必须可执行');
  const remaining = JSON.parse(await fs.readFile(path.join(root, MARKER_FILE), 'utf8'));
  assert.equal(remaining.dsh, undefined, '清理命令必须移除当前宿主的标记');

  await writeMarker({
    cwd: root,
    host: 'dsh',
    layers: ['tool_code'],
    reason: '历史残留',
    runId: 'old-run',
    now: new Date(now - (365 * 24 * 60 * 60 * 1000)).toISOString(),
  });
  const second = JSON.parse((await runCli(['doctor', '--json', '--cwd', root, '--host', 'dsh'], env)).stdout);
  assert.deepEqual(markerCheck(second)?.pending, [], '多年残留不得判 pending');
  assert.deepEqual(markerCheck(second)?.history, ['dsh'], '多年残留必须判 history');
});

test('T106: all four startup adapters expose the same run context', async (t) => {
  const root = await makeRepo(t);
  const sessionStart = Date.now() - (6 * 60 * 60 * 1000);
  const runId = 'startup-run';
  const expected = { sessionStart, runId };
  await withEnv({
    DSH_SDD_KIT_SESSION_START: String(sessionStart),
    DSH_SDD_KIT_RUN_ID: runId,
  }, async () => {
    const env = process.env;
    const dsh = await applyDshGuidance({ ctx: {}, cwd: root, env });
    assert.deepEqual(dsh.status?.runContext, expected, 'DSH 启动链路必须携带 run context');

    const claude = await applyClaudeGuidance({ cwd: root, env, nativeEventsAvailable: false });
    assert.deepEqual(claude.runContext, expected, 'Claude 启动链路必须携带 run context');

    const codex = await applyCodexGuidance({ cwd: root, env, nativeEventsAvailable: false });
    assert.deepEqual(codex.runContext, expected, 'Codex 启动链路必须携带 run context');

    const cursor = await applyCursorGuidance({ cwd: root, env });
    assert.deepEqual(cursor.runContext, expected, 'Cursor 启动链路必须携带 run context');
  });
});
