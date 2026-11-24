import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { runAction } from '../src/core/action.mjs';
import { classifyMarkers, writeMarker } from '../src/core/marker.mjs';
import { registerSddTools } from '../src/register.mjs';
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

async function makeToolchain(t, root) {
  const bin = path.join(root, '.fake-bin');
  const home = path.join(root, '.fake-home');
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  const scripts = {
    specify: '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "specify 1.0.0"; fi\nexit 0\n',
    uv: '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "uv 0.6.0"; fi\nexit 0\n',
    git: [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "git version 2.45.0"; exit 0; fi',
      'if [ "$1" = "clone" ]; then /bin/mkdir -p "$5/.git"; echo "abc1234" > "$5/.git/HEAD"; exit 0; fi',
      'if [ "$1" = "-C" ]; then',
      '  if [ "$3" = "rev-parse" ]; then echo "abc1234"; fi',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  };
  for (const [name, body] of Object.entries(scripts)) {
    const file = path.join(bin, name);
    await fs.writeFile(file, body, { mode: 0o755 });
  }
  t.after(() => fs.rm(bin, { recursive: true, force: true }));
  return { PATH: bin, HOME: home };
}

function withoutRunEnv(source = process.env) {
  const env = { ...source };
  delete env.DSH_SDD_KIT_SESSION_START;
  delete env.DSH_SDD_KIT_RUN_ID;
  return env;
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

async function runCli(args, overrides = {}, baseEnv = process.env) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      env: { ...baseEnv, ...overrides },
      encoding: 'utf8',
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error?.code ?? 1, stdout: error?.stdout ?? '' };
  }
}

/** Run the same CLI through a different parent shell to vary pid/ppid facts. */
async function runCliFromShell(shell, args, env) {
  const command = [process.execPath, CLI, ...args].map((part) => JSON.stringify(part)).join(' ');
  const { stdout } = await execFileAsync(shell, ['-c', command], { env, encoding: 'utf8' });
  return JSON.parse(stdout);
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

test('生产路径：无环境覆盖时 CLI update 写入的 runId 让 48 小时标记仍判待生效', async (t) => {
  const root = await makeRepo(t);
  const toolchain = await makeToolchain(t, root);
  // 只移除宿主覆盖变量；测试不手动注入任何会话/运行环境变量。
  const env = { ...withoutRunEnv(), ...toolchain };
  const updated = await runCli([
    'update', '--json', '--cwd', root, '--host', 'dsh', '--extension-changes=extension,commands',
  ], {}, env);
  const updatedReport = JSON.parse(updated.stdout);
  assert.equal(updatedReport.action, 'update', `CLI update 必须返回更新报告：${updated.stdout}`);
  assert.equal(updatedReport.reload?.result, 'new_session', '扩展变更必须产生待生效标记');

  const markerFile = path.join(root, MARKER_FILE);
  const recorded = JSON.parse(await fs.readFile(markerFile, 'utf8'));
  const productionRunId = recorded.dsh?.runId;
  assert.equal(typeof productionRunId, 'string', `CLI update 必须记录生产 runId：${updated.stdout}`);
  assert.ok(productionRunId.length > 0, '生产 runId 不得为空');
  const anchor = JSON.parse(await fs.readFile(
    path.join(root, '.specify', 'extensions', 'sdd-run-context.json'), 'utf8'
  ));
  assert.equal(anchor.runId, productionRunId, '生产 anchor 必须与标记共享同一 runId');

  const aged = {
    ...recorded,
    dsh: {
      ...recorded.dsh,
      timestamp: new Date(Date.now() - (48 * 60 * 60 * 1000)).toISOString(),
      runId: productionRunId,
    },
  };
  await fs.writeFile(markerFile, `${JSON.stringify(aged, null, 2)}\n`, 'utf8');

  const examined = await runCli(['doctor', '--json', '--cwd', root, '--host', 'dsh'], {}, env);
  const sameRun = markerCheck(JSON.parse(examined.stdout));
  assert.deepEqual(sameRun?.pending, ['dsh'], '48 小时但同一生产运行的标记必须仍判 pending');
  assert.deepEqual(sameRun?.history, [], '不得仅凭 24 小时窗口把同运行标记降级为 history');

  const fixed = await runCli(['guidance', '--host', 'dsh', '--cwd', root, '--clear-marker'], {}, env);
  assert.equal(fixed.code, 0, `doctor 建议的清理命令必须可执行：${fixed.stdout}`);
  const afterFix = JSON.parse(await fs.readFile(markerFile, 'utf8'));
  assert.equal(afterFix.dsh, undefined, '清理命令必须移除当前宿主的标记');

  await fs.writeFile(markerFile, `${JSON.stringify({
    ...aged,
    dsh: {
      ...aged.dsh,
      timestamp: new Date(Date.now() - (365 * 24 * 60 * 60 * 1000)).toISOString(),
      runId: productionRunId,
    },
  }, null, 2)}\n`, 'utf8');
  const residue = markerCheck(JSON.parse((
    await runCli(['doctor', '--json', '--cwd', root, '--host', 'dsh'], {}, env)
  ).stdout));
  assert.deepEqual(residue?.pending, [], '同一 runId 的多年残留也不得永久判 pending');
  assert.deepEqual(residue?.history, ['dsh'], '同一 runId 的多年残留也必须判 history');
});

test('T106: 同一 runId 的标记也必须有界，48 小时 pending 但 365 天 history', () => {
  const now = Date.parse('2026-11-24T12:00:00.000Z');
  const runId = 'stable-anchor-run';
  const at = (days) => new Date(now - (days * 24 * 60 * 60 * 1000)).toISOString();
  const marker = (days) => ({ dsh: { runId, timestamp: at(days) } });

  assert.deepEqual(classifyMarkers(marker(2), { now, runId }), {
    pending: ['dsh'],
    history: [],
  }, '同一 runId 的 48 小时标记必须仍判 pending');
  assert.deepEqual(classifyMarkers(marker(365), { now, runId }), {
    pending: [],
    history: ['dsh'],
  }, '同一 runId 的 365 天标记必须判 history');
});

test('生产路径：Host 工具无环境覆盖时生成并复用同一 run context', async (t) => {
  const root = await makeRepo(t);
  const registered = [];
  const captured = [];
  registerSddTools(
    { tools: { register(definition) { registered.push(definition); return () => {}; } } },
    (definition) => definition,
    {
      runDoctor: async (params) => {
        captured.push(params);
        return { action: 'doctor' };
      },
    }
  );
  const tool = registered.find((definition) => definition.name === 'sdd_upstream');
  const env = withoutRunEnv({});
  const first = await tool.execute({ action: 'doctor', cwd: root, env });
  const second = await tool.execute({ action: 'doctor', cwd: root, env });
  assert.equal(first.action, 'doctor');
  assert.equal(second.action, 'doctor');

  const contexts = captured.map(({ sessionStart, runId }) => ({ sessionStart, runId }));
  assert.equal(contexts.length, 2);
  for (const context of contexts) {
    assert.ok(Number.isFinite(context.sessionStart), 'Host 工具必须生成有限的 sessionStart');
    assert.match(context.runId, /^[0-9a-f]{32}$/, 'Host 工具必须生成非空 production runId');
  }
  assert.deepEqual(contexts[1], contexts[0], '同一进程的 Host 工具调用必须复用同一 run context');

  await tool.execute({ action: 'doctor', cwd: root, env, sessionStart: 123, runId: 'explicit-run' });
  assert.equal(captured[2].sessionStart, 123, '显式参数必须覆盖自动生成的上下文');
  assert.equal(captured[2].runId, 'explicit-run', '显式参数必须覆盖自动生成的 runId');
});

test('生产路径：四端启动在无环境覆盖时共享稳定 run context', async (t) => {
  const root = await makeRepo(t);
  const env = withoutRunEnv({});
  const dsh = await applyDshGuidance({}, { cwd: root, env });
  const claude = await applyClaudeGuidance({ cwd: root, env, nativeEventsAvailable: false });
  const codex = await applyCodexGuidance({ cwd: root, env, nativeEventsAvailable: false });
  const cursor = await applyCursorGuidance({ cwd: root, env });
  const contexts = [
    dsh.status?.runContext,
    claude.runContext,
    codex.runContext,
    cursor.runContext,
  ];
  for (const context of contexts) {
    assert.ok(Number.isFinite(context?.sessionStart), '四端启动必须生成 sessionStart');
    assert.match(context?.runId ?? '', /^[0-9a-f]{32}$/, '四端启动必须生成 production runId');
  }
  assert.equal(new Set(contexts.map((context) => context.sessionStart)).size, 1);
  assert.equal(new Set(contexts.map((context) => context.runId)).size, 1);
});

test('生产 run-context 生成器保持宿主中立', async () => {
  const { createRunContext } = await import('../src/core/run-context.mjs');
  const source = await fs.readFile(path.join(REPO_ROOT, 'src', 'core', 'run-context.mjs'), 'utf8');
  assert.doesNotMatch(source, /DSH_/, '生成器不得解析宿主环境变量');
  assert.doesNotMatch(source, /process\.env/, '生成器不得读取进程环境');
  assert.doesNotMatch(source, /\bhost\s*(?:=|:)/, '生成器不得包含 host 默认值');

  const input = {
    cwd: '/tmp/run-context',
    hostname: 'neutral-host',
    uid: 'uid-1',
    pid: 1234,
    ppid: 42,
    now: Date.parse('2026-11-24T12:00:00.000Z'),
    sessionStart: Date.parse('2026-11-24T10:00:00.000Z'),
    parentStart: Date.parse('2026-11-24T11:00:00.000Z'),
    processStart: Date.parse('2026-11-24T11:30:00.000Z'),
    anchor: null,
  };
  const first = createRunContext(input);
  assert.deepEqual(createRunContext({ ...input }), first, '相同中性输入必须生成同一上下文');
  assert.equal(first.sessionStart, input.sessionStart, '显式 sessionStart 优先于进程起点');
  assert.match(first.runId, /^[0-9a-f]{32}$/);
  assert.equal(
    createRunContext({ ...input, ppid: 43, parentStart: input.parentStart + 60_000 }).runId,
    first.runId,
    '不同父进程不得改变 runId'
  );
  assert.notEqual(
    createRunContext({ ...input, cwd: '/tmp/other-workspace' }).runId,
    first.runId,
    '不同工作区必须分离 runId'
  );
  assert.notEqual(
    createRunContext({ ...input, uid: 'uid-2' }).runId,
    first.runId,
    '不同用户必须分离 runId'
  );
});

test('T106: /proc 启动 ticks 按固定 USER_HZ 换算，不能用 uptime 估 Hz', async () => {
  const { createRunContext } = await import('../src/core/run-context.mjs');
  const btimeSeconds = 1_700_000_000;
  const startTicks = 20_000;
  const bootStat = `btime ${btimeSeconds}\n`;
  const afterComm = Array(20).fill('0');
  // fields[0] is state (field 3), so field 22 is fields[19] = afterComm[18].
  afterComm[18] = String(startTicks);
  const pidStat = `4242 (node) S ${afterComm.join(' ')}\n`;
  const context = createRunContext({
    cwd: '/tmp/hz-check',
    hostname: 'neutral-host',
    uid: 'uid-1',
    now: (btimeSeconds * 1000) + 500_000,
    platform: 'linux',
    pid: 4242,
    uptimeSeconds: 1,
    procStatText: pidStat,
    procBootStatText: bootStat,
    anchor: null,
    fallbackToProcessStart: true,
  });
  assert.equal(
    context.sessionStart,
    (btimeSeconds * 1000) + 200_000,
    '固定 100Hz 下 startTicks=20000 必须是启动后 200s，而不是 boot time'
  );
});

test('T106: 非 Linux fallback 使用中性当日桶，不产生 boot time', async () => {
  const { createRunContext } = await import('../src/core/run-context.mjs');
  const now = Date.parse('2026-11-24T12:34:56.000Z');
  const context = createRunContext({
    cwd: '/tmp/non-linux',
    hostname: 'neutral-host',
    uid: 'uid-1',
    now,
    platform: 'win32',
    uptimeSeconds: 9 * 24 * 60 * 60,
    anchor: null,
  });
  assert.equal(context.sessionStart, Date.parse('2026-11-24T00:00:00.000Z'));
  assert.ok(
    context.sessionStart > now - (24 * 60 * 60 * 1000),
    'fallback 不得把长时间 uptime/boot time 当成会话起点'
  );
  assert.match(context.runId, /^[0-9a-f]{32}$/);
});

test('T106: getRunContext 缓存键包含影响 seed 的输入', async (t) => {
  const { getRunContext } = await import('../src/core/run-context.mjs');
  const root = await makeRepo(t);
  const base = {
    cwd: root,
    now: Date.parse('2026-11-24T12:00:00.000Z'),
    hostname: 'neutral-host',
    uid: 'uid-1',
  };
  const first = getRunContext(base);
  assert.equal(getRunContext({ ...base, runId: 'run-b' }).runId, 'run-b', 'runId 不得被 cwd 缓存吞掉');
  assert.notEqual(
    getRunContext({ ...base, uid: 'uid-2' }).runId,
    first.runId,
    'uid 变化时缓存必须失效'
  );
  assert.equal(
    getRunContext({ ...base, sessionStart: 1_234_567 }).sessionStart,
    1_234_567,
    '显式 sessionStart 变化时缓存必须失效'
  );
});

test('T106: action 显式 runContext 缺 sessionStart 时 fallback 生成值', async (t) => {
  const root = await makeRepo(t);
  let captured;
  await runAction('doctor', {
    cwd: root,
    env: {},
    runContext: { runId: 'partial-context-run' },
  }, {
    runDoctor: async (params) => {
      captured = params;
      return { action: 'doctor' };
    },
  });
  assert.equal(captured?.runId, 'partial-context-run');
  assert.ok(Number.isFinite(captured?.sessionStart), '缺 sessionStart 时必须补生成值');
});

test('T106: 48 小时但不同 runId 的 marker 仍判 history', async (t) => {
  const root = await makeRepo(t);
  const now = Date.now();
  await writeMarker({
    cwd: root,
    host: 'dsh',
    layers: ['tool_code'],
    reason: '其他运行',
    runId: 'other-run',
    now: new Date(now - (48 * 60 * 60 * 1000)).toISOString(),
  });
  const report = JSON.parse((await runCli(['doctor', '--json', '--cwd', root, '--host', 'dsh'], {
    DSH_SDD_KIT_SESSION_START: String(now),
    DSH_SDD_KIT_RUN_ID: 'current-run',
  })).stdout);
  assert.deepEqual(markerCheck(report)?.pending, []);
  assert.deepEqual(markerCheck(report)?.history, ['dsh']);
});

test('T106: 两个不同父 shell 的 CLI 调用共享同一 runId', async (t) => {
  const root = await makeRepo(t);
  const toolchain = await makeToolchain(t, root);
  const env = { ...withoutRunEnv(), ...toolchain };
  const args = ['update', '--json', '--cwd', root, '--host', 'dsh', '--extension-changes=extension,commands'];
  async function markerRunId(shell) {
    const report = await runCliFromShell(shell, args, env);
    assert.equal(report.action, 'update', `CLI update 必须成功：${JSON.stringify(report)}`);
    const markers = JSON.parse(await fs.readFile(path.join(root, MARKER_FILE), 'utf8'));
    assert.equal(typeof markers.dsh?.runId, 'string');
    return markers.dsh.runId;
  }
  const fromSh = await markerRunId('/bin/sh');
  const fromBash = await markerRunId('/bin/bash');
  assert.equal(fromBash, fromSh, '不同父 shell 不得改变同一工作区的 runId');
});

test('T106: doctor 无 anchor 时保持零写', async (t) => {
  const root = await makeRepo(t);
  const env = withoutRunEnv();
  const result = await runCli(['--json', 'doctor', '--cwd', root, '--host', 'dsh'], {}, env);
  assert.equal(result.code, 0, `doctor 必须可执行：${result.stdout}`);
  assert.ok(JSON.parse(result.stdout).runtime, `输出必须是 doctor JSON：${result.stdout}`);
  await assert.rejects(fs.access(path.join(root, '.specify', 'extensions', 'sdd-run-context.json')));
});
