# 批次 2：单一事实源 + setup 状态机进代码 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 消灭扩展元数据的第二份声明，把 `/sdd-setup` 的 7 步分支状态机从 markdown 搬进可测试的代码，并让安装产物彻底退出 git 跟踪——三件事都指向同一条 Linus 判据：**每个事实只有一处可编辑，控制流必须可被断言**。

**Architecture:** 不新增工具、不新增技能、不新增依赖。`sdd_upstream` 增加一个 `setup` 动作（内部编排既有动作，薄胶水）；扩展元数据改为运行期从 `extension.yml` 定向读取（约 25 行固定键读取器，替代手写常量，比 codegen 更薄）；`.dsh/` 与 `.specify/extensions*` 等纯安装产物 gitignore 化，由 `setup` 幂等重建。对外表面仍是 2 技能 + 2 工具 + 1 扩展，章程 v4.0.0 无需修订。

**Tech Stack:** Node.js >=18 ESM，零 npm 依赖；`node --test`；specify CLI 1.4.4.dev0；git。

---

## 治理与前提（先读）

1. **章程原则 II** 要求实现前有批准的规范产物。本计划走评审提出的**轻量通道**（单页计划替代 188KB 规格套组）。拥有者批准本计划即视为批准；若要对 Task 2 走完整仪式，先跑 `/speckit.specify` 再执行本计划。**变更分级入章程属批次 3 决策，不在本计划内。**
2. **任务顺序不可调换**：Task 2（setup 保证两个扩展总是幂等安装）必须先于 Task 3（untrack 安装产物）。否则新克隆的仓库会缺 bug 扩展且无人补装——现有技能把 `install_bug_ext` 嵌套在 init 条件里，untrack 后 init 被跳过，bug 扩展就永远装不上。Task 2 正是关闭这个缺口的那一步。
3. 每个 Task 结束必须 `npm test` 全绿（当前基线 **36/36，0 skip**，specify 已就位）并原子提交（章程 IV，中文消息）。
4. 本机为 Windows + pwsh 7；`npm test` 前若新开终端需确保 `~/.local/bin` 在 PATH（`uv tool update-shell` 已执行过，重开终端即生效）。
5. 行尾一律 LF（`.gitattributes` 已就位）；新文件用 LF 写入。

**新证据（本会话实测，支撑 Task 3）：** `/sdd-setup` 在 Windows 重装时，`.dsh/skills/*/SKILL.md` 从 Linux 生成的符号链接（mode 120000）回退为内容一致的普通副本，`.specify/extensions/.registry` 的 `installed_at` 时间戳每次重装必变。这两类文件入库 = 每次跨平台重装必产生噪声 diff（提交 `d6833df` 就是实例）。它们是纯安装输出，零作者内容，应当像 EARS 模板安装产物一样退出跟踪。

---

### Task 1: 扩展元数据单一事实源（运行期读取 extension.yml）

**Files:**
- Modify: `src/core/upstream.mjs:17-26`（删除 `HOOKS_EXTENSION` / `HOOKS_EXTENSION_EVENTS` 常量）、`src/core/upstream.mjs:188-200`（install_hooks_ext 报告改为读清单）
- Test: `test/sdd-kit.test.mjs`（新增夹具与 3 处用例调整）

**背景：** `plan.md`（specs/002）当年决定"用常量避免 YAML 解析"，代价是元数据两份声明 + 一条文本断言粘合。定向固定键读取器（~25 行）比"codegen 脚本 + 生成文件 + 漂移测试"更薄：没有第二份产物，就没有漂移。清单合法性仍由 `specify` CLI 校验，读取器只取自己需要的 4 个键。

**Step 1: 写失败测试——证明元数据来自清单而非常量**

在 `test/sdd-kit.test.mjs` 的 `const EXTENSION_DIR = ...` 定义之后加入夹具函数：

```js
async function seedExtensionManifest(dir, { id = 'superpowers-hooks', version = '0.1.0' } = {}) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'extension.yml'),
    [
      'schema_version: "1.0"',
      'extension:',
      `  id: ${id}`,
      '  name: Demo Hooks',
      `  version: "${version}"`,
      'hooks:',
      '  before_implement:',
      '    command: speckit.demo.before-implement',
      '    optional: false',
      '  after_implement:',
      '    command: speckit.demo.after-implement',
      '    optional: false',
      '  before_bug_fix:',
      '    command: speckit.demo.before-bug-fix',
      '    optional: false',
      '  after_bug_fix:',
      '    command: speckit.demo.after-bug-fix',
      '    optional: false',
      '',
    ].join('\n'),
    'utf8'
  );
}

test('install_hooks_ext reads id/version/events from the manifest, not hardcoded constants', async () => {
  const cwd = await makeTempDir();
  const extensionDir = path.join(cwd, 'ext-src');
  await seedExtensionManifest(extensionDir, { id: 'demo-hooks', version: '9.9.9' });
  const mockRunner = async () => ({ ok: true, code: 0, stdout: 'installed', stderr: '' });
  try {
    const report = await runUpstream({ action: 'install_hooks_ext', cwd, extensionDir }, mockRunner);
    assert.equal(report.ok, true);
    assert.deepEqual(report.extension, { id: 'demo-hooks', version: '9.9.9' });
    assert.deepEqual(report.hooks, ['before_implement', 'after_implement', 'before_bug_fix', 'after_bug_fix']);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
```

**Step 2: 跑测试确认失败**

Run: `node --test --test-name-pattern "reads id/version/events" test/sdd-kit.test.mjs`
Expected: FAIL——`report.extension` 是常量 `{ id: 'superpowers-hooks', version: '0.1.0' }`，与 `demo-hooks/9.9.9` 不等。

**Step 3: 最小实现**

`src/core/upstream.mjs`：删除第 17-26 行的两个 `export const`（含注释），替换为：

```js
/**
 * Read only the keys this plugin needs from the extension manifest.
 * The manifest itself is validated by the specify CLI; this is a targeted
 * fixed-key reader, not a YAML parser (zero-dependency constraint).
 */
async function readExtensionManifest(extensionDir) {
  const raw = await fs.readFile(path.join(extensionDir, 'extension.yml'), 'utf8');
  const id = raw.match(/^  id:\s*(\S+)\s*$/m)?.[1] ?? null;
  const versionRaw = raw.match(/^  version:\s*(.+)$/m)?.[1] ?? null;
  const version = versionRaw ? versionRaw.trim().replace(/^"|"$/g, '') : null;
  const lines = raw.split(/\r?\n/);
  const hooksStart = lines.findIndex((line) => /^hooks:\s*$/.test(line));
  const events = [];
  if (hooksStart >= 0) {
    for (const line of lines.slice(hooksStart + 1)) {
      if (/^\S/.test(line)) break;
      const m = line.match(/^  ([a-z_]+):\s*$/);
      if (m) events.push(m[1]);
    }
  }
  return { id, version, events };
}
```

`install_hooks_ext` 分支中，CLI 调用之后（`const res = await runner(...)` 与 `const integration = ...` 之间）插入：

```js
    if (!res.ok) {
      return { action, cwd, extensionDir, command: `specify ${cliArgs.join(' ')}`, ...res };
    }
    const manifest = await readExtensionManifest(extensionDir).catch(() => null);
    if (!manifest?.id || !manifest?.version || manifest.events.length === 0) {
      return {
        action, cwd, extensionDir, ok: false,
        error: `cannot read extension manifest at ${path.join(extensionDir, 'extension.yml')}`,
      };
    }
```

并把报告里的两行常量引用改为：

```js
      extension: { id: manifest.id, version: manifest.version },
      hooks: [...manifest.events],
```

（删除原 `...res` 之后重复的 ok/code 字段不受影响；失败路径已在上面提前返回。）

**Step 4: 修两个依赖空目录夹具的既有用例**

`install_hooks_ext delegates once with --dev...`（test L624 附近）与 `US3 install_hooks_ext derives the skills directory...`（L933 附近）目前用**空的** `ext-src` 目录 + ok runner。在每处 `await fs.mkdir(extensionDir, ...)` 之后补一行：

```js
  await seedExtensionManifest(extensionDir);
```

US3 用例里 `extensionDirOf` 助手改为：

```js
  const extensionDirOf = async (cwd) => {
    const dir = path.join(cwd, 'ext-src');
    await seedExtensionManifest(dir);
    return dir;
  };
```

`install_hooks_ext surfaces CLI failures without throwing` 不需要夹具：CLI 失败在读清单之前提前返回。

**Step 5: 跑全量确认通过**

Run: `npm test`
Expected: 37 tests，0 fail（新增 1 个）；`install_hooks_ext refuses a missing extension source` 仍 0 次 runner 调用。

**Step 6: Commit**

```bash
git add src/core/upstream.mjs test/sdd-kit.test.mjs
git commit -m "refactor: 扩展元数据运行期读取 extension.yml，删除手写常量（单一事实源）"
```

---

### Task 2: setup 状态机进代码（`sdd_upstream action:"setup"`）

**Files:**
- Create: `src/core/setup.mjs`
- Modify: `src/core/upstream.mjs:168-171`（install_bug_ext 恒传 `--force`，幂等）、`src/register.mjs:11,24,61`（路由与参数）、`skills/sdd-setup/SKILL.md`（整体重写为声明式）
- Test: `test/sdd-kit.test.mjs`（删除 2 个散文断言用例，新增 5 个行为用例 + 1 个技能契约用例；修改 L78 的 bug 扩展 argv 断言）

**背景：** 7 步分支状态机住在 markdown 里，漏步不可检测，测试只能断言"文档提到了某词"。本会话手工执行 `/sdd-setup` 就是活证据。搬进代码后，测试断言 `steps` 序列，技能缩到 ~30 行只渲染结果。**同时修复一个真实缺口**：`install_bug_ext` 目前不带 `--force`，重复运行会报 "already installed"；且它被嵌套在 init 条件里，既有项目永远不补装。setup 对两个扩展一律幂等确保安装。

**Step 1: 写失败测试（5 个行为用例）**

在 `test/sdd-kit.test.mjs` 末尾追加：

```js
import { runSetup } from '../src/core/setup.mjs';

function setupFakes({ hasSpecifyDir = true, uvInstalled = true, specifyInstalled = true, syncOk = true, mismatch = null } = {}) {
  const calls = [];
  const upstream = async (args) => {
    calls.push(args.action);
    switch (args.action) {
      case 'status':
        return {
          uv: { installed: uvInstalled },
          specifyCli: { installed: specifyInstalled, version: 'specify 1.4.4.dev0' },
          superpowers: { installed: true, head: 'abc1234', skillCount: 15 },
        };
      case 'sync_superpowers':
        return syncOk ? { ok: true, mode: 'pull', skillCount: 15 } : { ok: false, code: 128, stderr: 'fatal: offline' };
      case 'specify_upgrade': return { ok: true, mode: 'install' };
      case 'specify_init': return { ok: true };
      case 'install_bug_ext': return { ok: true };
      case 'install_hooks_ext':
        return {
          ok: true,
          extension: { id: 'superpowers-hooks', version: '0.1.0' },
          hooks: ['before_implement', 'after_implement', 'before_bug_fix', 'after_bug_fix'],
          integration: mismatch ? 'claude' : 'dsh',
          skillsDir: mismatch ? '.claude/skills' : '.dsh/skills',
          integrationMismatch: mismatch,
        };
      case 'switch_integration': return { ok: true, integration: 'dsh' };
      default: throw new Error(`unexpected upstream action: ${args.action}`);
    }
  };
  const bridge = async (args) =>
    args.action === 'inspect'
      ? { hasSpecifyDir, hasConstitution: true, hasEarsOverride: false, features: [], bugs: [] }
      : { action: 'install_overrides', status: 'written' };
  return { calls, deps: { runUpstream: upstream, runBridge: bridge } };
}

const SETUP_STEP_ORDER = [
  'inspect', 'sync_superpowers', 'specify_cli', 'specify_init',
  'install_bug_ext', 'install_hooks_ext', 'install_overrides',
];

test('runSetup: fresh project runs init and installs both extensions in order', async () => {
  const { calls, deps } = setupFakes({ hasSpecifyDir: false, specifyInstalled: false });
  const report = await runSetup({ cwd: process.cwd() }, deps);
  assert.equal(report.ok, true);
  assert.deepEqual(report.steps.map((s) => s.name), SETUP_STEP_ORDER);
  assert.equal(report.steps.find((s) => s.name === 'specify_init').status, 'performed');
  assert.equal(report.steps.find((s) => s.name === 'specify_cli').status, 'performed');
  assert.ok(calls.includes('install_bug_ext'), 'bug extension must be installed even on fresh init');
  assert.ok(calls.includes('install_hooks_ext'));
});

test('runSetup: existing project skips init and stays idempotent across reruns', async () => {
  const { calls, deps } = setupFakes({ hasSpecifyDir: true });
  const first = await runSetup({ cwd: process.cwd() }, deps);
  const second = await runSetup({ cwd: process.cwd() }, deps);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(calls.includes('specify_init'), false, 'REQ-15: never re-init an existing layout');
  assert.deepEqual(
    second.steps.map((s) => [s.name, s.status]),
    first.steps.map((s) => [s.name, s.status])
  );
  assert.equal(second.steps.find((s) => s.name === 'specify_init').status, 'skipped');
  assert.equal(second.steps.find((s) => s.name === 'install_bug_ext').status, 'performed', 'extensions are ensured on every run');
});

test('runSetup: a Superpowers sync failure does not abort the extension install (REQ-11)', async () => {
  const { deps } = setupFakes({ syncOk: false });
  const report = await runSetup({ cwd: process.cwd() }, deps);
  assert.equal(report.ok, false);
  assert.equal(report.steps.find((s) => s.name === 'sync_superpowers').status, 'failed');
  assert.equal(report.steps.find((s) => s.name === 'install_hooks_ext').status, 'performed');
});

test('runSetup: missing uv stops before touching the repository', async () => {
  const { calls, deps } = setupFakes({ hasSpecifyDir: false, uvInstalled: false });
  const report = await runSetup({ cwd: process.cwd() }, deps);
  assert.equal(report.ok, false);
  assert.equal(calls.includes('specify_init'), false);
  assert.equal(calls.includes('install_bug_ext'), false);
  assert.match(report.steps.find((s) => s.name === 'specify_cli').detail.hint, /uv/);
});

test('runSetup: integration switch happens only on explicit opt-in', async () => {
  const mismatch = { current: 'claude', expected: 'dsh', switchCommand: 'specify integration switch dsh', note: 'x' };
  const auto = setupFakes({ mismatch });
  const reportAuto = await runSetup({ cwd: process.cwd() }, auto.deps);
  assert.equal(auto.calls.includes('switch_integration'), false, 'default path must never switch');
  assert.ok(reportAuto.integrationMismatch, 'mismatch must be reported, not silently fixed');

  const optIn = setupFakes({ mismatch });
  const reportOpt = await runSetup({ cwd: process.cwd(), switchIntegration: true }, optIn.deps);
  assert.ok(optIn.calls.includes('switch_integration'));
  assert.ok(optIn.calls.filter((a) => a === 'install_hooks_ext').length === 2, 'hooks must be regenerated after the switch');
  assert.equal(reportOpt.integrationMismatch, null);
});
```

**Step 2: 跑测试确认失败**

Run: `node --test --test-name-pattern "runSetup" test/sdd-kit.test.mjs`
Expected: FAIL——`Cannot find module '../src/core/setup.mjs'`。

**Step 3: 实现 `src/core/setup.mjs`（完整代码）**

```js
import path from 'node:path';

import { runUpstream } from './upstream.mjs';
import { runBridge } from './bridge.mjs';

/**
 * The /sdd-setup state machine, in code so it can be asserted.
 * Pure orchestration of existing actions — no upstream logic lives here.
 */
export async function runSetup(args = {}, deps = {}) {
  const upstream = deps.runUpstream ?? runUpstream;
  const bridge = deps.runBridge ?? runBridge;
  const cwd = path.resolve(args.cwd || process.cwd());
  const steps = [];
  const record = (name, status, detail = null) => steps.push({ name, status, detail });
  const finish = (extra = {}) => ({
    action: 'setup',
    ok: steps.every((s) => s.status !== 'failed'),
    cwd,
    steps,
    ...extra,
  });

  const info = await bridge({ action: 'inspect', cwd });
  record('inspect', 'performed', { hasSpecifyDir: info.hasSpecifyDir, hasConstitution: info.hasConstitution });

  // REQ-11: a mirror sync failure must not abort the extension install.
  const sync = await upstream({ action: 'sync_superpowers', cwd, superpowersDir: args.superpowersDir, repoUrl: args.repoUrl });
  record('sync_superpowers', sync.ok ? 'performed' : 'failed',
    sync.ok ? { mode: sync.mode, skillCount: sync.skillCount } : { stderr: sync.stderr });
  const restartRequired = sync.mode === 'clone';

  const status = await upstream({ action: 'status', cwd, superpowersDir: args.superpowersDir });
  if (!status.uv.installed) {
    record('specify_cli', 'failed', { hint: 'uv is required: https://docs.astral.sh/uv/getting-started/installation/' });
    return finish({ restartRequired });
  }
  if (!status.specifyCli.installed || args.upgrade === true) {
    const up = await upstream({ action: 'specify_upgrade', cwd, python: args.python });
    record('specify_cli', up.ok ? 'performed' : 'failed', up.ok ? { mode: up.mode } : { stderr: up.stderr });
  } else {
    record('specify_cli', 'skipped', { version: status.specifyCli.version });
  }

  // REQ-15: never re-run init on an existing layout.
  if (!info.hasSpecifyDir) {
    const init = await upstream({ action: 'specify_init', cwd, integration: args.integration });
    record('specify_init', init.ok ? 'performed' : 'failed', init.ok ? null : { stderr: init.stderr });
    if (!init.ok) return finish({ restartRequired });
  } else {
    record('specify_init', 'skipped', { reason: 'existing .specify layout preserved (REQ-15)' });
  }

  // Both extensions are ensured on every run (idempotent via --force).
  const bug = await upstream({ action: 'install_bug_ext', cwd });
  record('install_bug_ext', bug.ok ? 'performed' : 'failed', bug.ok ? null : { stderr: bug.stderr });
  const hooks = await upstream({ action: 'install_hooks_ext', cwd, extensionDir: args.extensionDir });
  record('install_hooks_ext', hooks.ok ? 'performed' : 'failed',
    hooks.ok ? { extension: hooks.extension, hooks: hooks.hooks } : { stderr: hooks.stderr ?? hooks.error });

  const ov = await bridge({ action: 'install_overrides', cwd });
  record('install_overrides', ov.status === 'written' ? 'performed' : 'skipped', { status: ov.status });

  // REQ-16: the switch is explicit opt-in only, then hooks are regenerated.
  let mismatch = hooks.integrationMismatch ?? null;
  if (args.switchIntegration === true && mismatch) {
    const sw = await upstream({ action: 'switch_integration', cwd });
    record('switch_integration', sw.ok ? 'performed' : 'failed', sw.ok ? null : { stderr: sw.stderr });
    if (sw.ok) {
      const re = await upstream({ action: 'install_hooks_ext', cwd, extensionDir: args.extensionDir });
      record('reinstall_hooks_ext', re.ok ? 'performed' : 'failed', re.ok ? null : { stderr: re.stderr ?? re.error });
      mismatch = re.integrationMismatch ?? null;
    }
  }

  return finish({
    integration: hooks.integration ?? null,
    skillsDir: hooks.skillsDir ?? null,
    integrationMismatch: mismatch,
    restartRequired,
    constitutionPresent: info.hasConstitution,
  });
}
```

**Step 4: `install_bug_ext` 恒传 `--force`**

`src/core/upstream.mjs:168-171` 改为：

```js
  if (action === 'install_bug_ext') {
    const res = await runner('specify', ['extension', 'add', 'bug', '--force'], { cwd });
    return { action, cwd, command: 'specify extension add bug --force', ...res };
  }
```

同步修改 test L78 的断言：

```js
    assert.ok(calls.some((c) => c.join(' ') === 'specify extension add bug --force'));
```

**Step 5: register.mjs 路由与参数**

- L2 附近加 `import { runSetup } from './core/setup.mjs';`
- L11 后加 `const runSetupImpl = deps.runSetup ?? runSetup;`
- L24 动作枚举改为 `'One of: setup, status, sync_superpowers, specify_upgrade, specify_init, install_bug_ext, install_hooks_ext, switch_integration, update_all.'`
- 参数表新增两项（放在 `cwd` 之后）：

```js
          switchIntegration: {
            type: 'boolean',
            description: 'Explicit opt-in for action "setup": switch a non-dsh integration to dsh, then reinstall hooks (default false; the default path only reports the mismatch).',
          },
          upgrade: {
            type: 'boolean',
            description: 'For action "setup": force a specify-cli upgrade even when already installed (default false).',
          },
```

- execute 路由（L61 附近）改为：

```js
        async execute(args) {
          const action = args?.action || '';
          if (action === 'setup') return runSetupImpl(args);
          if (action === 'update_all') return runUpdateImpl(args);
          return runUpstream(args);
        },
```

**Step 6: 重写 `skills/sdd-setup/SKILL.md`（完整内容，声明式）**

```markdown
---
name: sdd-setup
description: Bootstrap or upgrade the Spec Kit × Superpowers stack in one delegated call, then render the step report.
disable-model-invocation: true
---

# /sdd-setup

一条命令完成 Spec Kit（做什么）× Superpowers（怎么做）技术栈的引导与升级。本技能是声明式命令：只委托一次并渲染结果，状态机在工具代码里，不在本文档里。

## 工作流

1. **收集参数**：`cwd` 默认当前仓库。仅当用户明确要求切换到 dsh 技能根时传 `switchIntegration: true`；仅当用户明确要求升级 specify-cli 时传 `upgrade: true`。其余可选参数（`superpowersDir`、`repoUrl`、`python`、`integration`、`extensionDir`）仅在用户给出时透传。
2. **只委托一次**：调用 `sdd_upstream(action: "setup", ...)`。不要自行调用其他动作，不要自行读取 `.specify/extensions.yml`。
3. **渲染报告**：按返回的 `steps` 数组逐行输出 `<name>: <status>`（`performed` / `skipped` / `failed`），failed 项附 detail。追加总体行 `Overall: ok` 或 `Overall: failed`。
4. **必须报告的字段**：`integration`、`skillsDir`、扩展 id/版本与四个钩子事件（在 `install_hooks_ext` 步骤的 detail 里）。`integrationMismatch` 非空时，说明当前 integration 不在 DSH 技能根内，给出显式切换方式（传 `switchIntegration: true` 重跑本命令）；默认路径只报告，绝不自动切换。
5. **重启提示**：`restartRequired` 为 true（Superpowers 首次克隆）时，明确告知重启 DSH 一次以挂载上游技能。绝不代替用户重启。
6. **下一步**：`constitutionPresent` 为 false 时，邀请用户运行 `/speckit.constitution`。

## 边界

- 既有 `.specify/` 布局永不被重跑 init（REQ-15）；切换 integration 必须显式 opt-in（REQ-16）。
- 上游镜像同步失败不阻断扩展安装（REQ-11），但必须在报告中如实标 failed。
- 本技能不修改 `specs/`、`tasks.md` 与应用源码。
```

**Step 7: 替换散文断言测试**

删除 `US3 sdd-setup installs the hooks extension and reports integration mismatches`（L984）与 `US6 sdd-setup exposes the explicit integration switch...`（L1007）两个用例，替换为：

```js
test('sdd-setup skill delegates once to the setup action and contains no state machine', async () => {
  const raw = await fs.readFile(path.join(PKG_ROOT, 'skills', 'sdd-setup', 'SKILL.md'), 'utf8');
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  assert.equal((body.match(/sdd_upstream\(action: "setup"/g) || []).length, 1);
  for (const forbidden of ['specify_init', 'install_bug_ext', 'install_hooks_ext', 'sync_superpowers', 'specify_upgrade', 'switch_integration', 'install_overrides']) {
    assert.equal(body.includes(forbidden), false, `skill must not orchestrate ${forbidden} itself`);
  }
  assert.match(body, /switchIntegration/);
  assert.match(body, /restartRequired/);
  assert.match(body, /integrationMismatch/);
  assert.equal(/fs\.|child_process|exec\(/.test(body), false);
});

test('sdd_upstream exposes the setup action with opt-in switch and upgrade parameters', () => {
  const registered = [];
  const ctx = { tools: { register: (t) => { registered.push(t); return () => {}; } } };
  registerSddTools(ctx, (d) => d);
  const tool = registered.find((t) => t.name === 'sdd_upstream');
  assert.match(tool.parameters.action.description, /\bsetup\b/);
  assert.ok(tool.parameters.switchIntegration);
  assert.ok(tool.parameters.upgrade);
});
```

**Step 8: 跑全量确认通过**

Run: `npm test`
Expected: 43 tests（37 − 2 + 5 + 2 + 1），0 fail，0 skip。

**Step 9: 真实环境冒烟（specify 已就位）**

Run: `node --input-type=module -e "const { runSetup } = await import('file:///D:/Project/dsh-sdd-kit/src/core/setup.mjs'); console.log(JSON.stringify(await runSetup({ cwd: 'D:/Project/dsh-sdd-kit' }), null, 2));"`
Expected: `ok: true`；`specify_init: skipped`；两个扩展 `performed`；`integration: "dsh"`；`integrationMismatch: null`。随后 `git status --short` 应只有安装产物的时间戳/行尾类变化（Task 3 之后这类变化将不再入库）。

**Step 10: Commit**

```bash
git add src/core/setup.mjs src/core/upstream.mjs src/register.mjs skills/sdd-setup/SKILL.md test/sdd-kit.test.mjs
git commit -m "feat: setup 状态机进代码（sdd_upstream action:setup），技能降为声明式；bug 扩展幂等确保安装"
```

---

### Task 3: 安装产物退出 git 跟踪（跨平台抖根治本）

**Files:**
- Modify: `.gitignore`
- Untrack: `.dsh/`（16 文件）、`.specify/extensions/`（15 文件）、`.specify/extensions.yml`、`.specify/integrations/*.manifest.json`（2 文件）
- Keep tracked: `.specify/memory/constitution.md`（治理源）、`.specify/scripts/`、`.specify/templates/`（上游模板，跨平台稳定）、`.specify/init-options.json`、`.specify/integration.json`、`.specify/workflows/`、`.specify/.gitignore`
- Test: `test/sdd-kit.test.mjs`（新增 1 个守卫用例）
- Modify: `README.md`（新克隆流程说明）

**前提：** Task 2 已完成——setup 现在对两个扩展一律幂等确保安装，新克隆缺扩展的缺口已关闭。保留 `init-options.json` 与 `scripts/` 跟踪，使 `hasSpecifyDir` 门控在新克隆上仍为 true（布局已声明，init 正确跳过）。

**Step 1: 写失败测试**

```js
test('install outputs are gitignored so cross-platform reinstalls never churn the repo', async () => {
  const ignore = await fs.readFile(path.join(PKG_ROOT, '.gitignore'), 'utf8');
  for (const pattern of ['.dsh/', '.specify/extensions/', '.specify/extensions.yml', '.specify/integrations/*.manifest.json']) {
    assert.ok(ignore.includes(pattern), `.gitignore must contain ${pattern}`);
  }
});
```

**Step 2: 跑测试确认失败**

Run: `node --test --test-name-pattern "install outputs are gitignored" test/sdd-kit.test.mjs`
Expected: FAIL——`.gitignore` 缺这些条目。

**Step 3: 更新 `.gitignore` 并 untrack**

`.gitignore` 追加：

```gitignore
# 纯安装产物：由 /sdd-setup（sdd_upstream action:setup）幂等重建。
# Windows 无 symlink 权限时 CLI 回退为副本、.registry 时间戳每次重装必变——入库即跨平台抖动。
.dsh/
.specify/extensions/
.specify/extensions.yml
.specify/integrations/*.manifest.json
```

Run:
```bash
git rm -r -q --cached .dsh .specify/extensions .specify/extensions.yml
git rm -q --cached .specify/integrations/dsh.manifest.json .specify/integrations/speckit.manifest.json
```
Expected: 文件仍在磁盘（`Test-Path .dsh/skills` 为 True），仅退出索引。

**Step 4: README 补一句新克隆流程**

在「本地测试」节前加入：

```markdown
## 新克隆的仓库

`.dsh/skills/` 与 `.specify/extensions*` 是安装产物，不入库。克隆后运行一次 `/sdd-setup` 即可幂等重建（specify-cli、Superpowers 镜像、bug 与 hooks 扩展、EARS 覆盖）。治理文档 `.specify/memory/constitution.md` 与上游脚本/模板仍在库中。
```

**Step 5: 跑全量 + 验证守卫**

Run: `npm test`
Expected: 44 tests，0 fail。
Run: `git ls-files .dsh .specify/extensions | Measure-Object`（pwsh）
Expected: 0。

**Step 6: Commit**

```bash
git add .gitignore README.md test/sdd-kit.test.mjs
git commit -m "chore!: 安装产物退出 git 跟踪（.dsh/、extensions*、integrations 清单），由 setup 幂等重建"
```

---

### Task 4: 未知动作返回结构化 E_ARGS（不再抛异常）

**Files:**
- Modify: `src/core/upstream.mjs:218-220`、`src/core/bridge.mjs:198-202`
- Test: `test/sdd-kit.test.mjs`（修改 check_task 拒绝断言，新增 upstream 未知动作用例）

**背景：** 参数/动作错误目前 throw，CLI 失败返回 `{ok:false}`——调用方要记两套语义。最小统一：**动作分发错误**返回 `{ ok:false, error:{ code:'E_ARGS', message, hint } }`；CLI 失败语义不动。不做大一统重构（YAGNI）。

**Step 1: 写失败测试**

```js
test('unknown actions return structured E_ARGS instead of throwing', async () => {
  const up = await runUpstream({ action: 'nope' });
  assert.equal(up.ok, false);
  assert.equal(up.error.code, 'E_ARGS');
  assert.match(up.error.hint, /setup|status/);
  const br = await runBridge({ action: 'check_task', featureName: 'x', taskMatch: 'T001' });
  assert.equal(br.ok, false);
  assert.equal(br.error.code, 'E_ARGS');
  assert.match(br.error.message, /Unknown sdd_bridge action/);
});
```

并把既有 bridge 用例里的 `await assert.rejects(() => runBridge({ action: 'check_task', ... }), /Unknown sdd_bridge action/)` 改为：

```js
    const retired = await runBridge({ action: 'check_task', cwd, featureName: '001-user-auth', taskMatch: 'T002' });
    assert.equal(retired.ok, false);
    assert.equal(retired.error.code, 'E_ARGS');
```

**Step 2: 跑测试确认失败**

Run: `node --test --test-name-pattern "structured E_ARGS" test/sdd-kit.test.mjs`
Expected: FAIL——两处仍 throw。

**Step 3: 实现**

`upstream.mjs` 末尾的 `throw new Error(...)` 改为：

```js
  return {
    ok: false,
    action,
    error: {
      code: 'E_ARGS',
      message: `Unknown sdd_upstream action "${action}".`,
      hint: 'Expected one of: setup, status, sync_superpowers, specify_upgrade, specify_init, install_bug_ext, install_hooks_ext, switch_integration, update_all.',
    },
  };
```

`bridge.mjs` 的 default 分支改为：

```js
    default:
      return {
        ok: false,
        action,
        error: {
          code: 'E_ARGS',
          message: `Unknown sdd_bridge action "${action}". Expected one of: inspect, install_overrides, sync_index.`,
          hint: 'Task checkbox updates belong to upstream /speckit.implement, not to this bridge.',
        },
      };
```

**Step 4: 跑全量确认通过**

Run: `npm test`
Expected: 45 tests，0 fail。

**Step 5: Commit**

```bash
git add src/core/upstream.mjs src/core/bridge.mjs test/sdd-kit.test.mjs
git commit -m "refactor: 未知动作返回结构化 E_ARGS，统一分发错误的出口语义"
```

---

### Task 5: peerDependencies 下界 + README 支持矩阵

**Files:**
- Modify: `package.json:37-41`、`README.md`

**Step 1: 核实宿主实际版本（不臆造下界）**

Run（DSH 宿主所在机器；本机若无 profile 则跳过改值，仅加文档）:
```bash
cat ~/.dsh/profiles/web/node_modules/@deepseek-ai/cordis/package.json | grep '"version"'
cat ~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-tools/package.json | grep '"version"'
cat ~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-skill-filesystem/package.json | grep '"version"'
```

**Step 2: 按核实结果改 peerDependencies**

若读到版本（示例为 `x.y.z`，以实际为准），把三个 `"*"` 改为 `">=x.y.0"`（各自下界）。**读不到就保持 `"*"` 不动**，在 README 支持矩阵里注明"peer 版本下界待宿主核实"。禁止编造版本号。

**Step 3: README 支持矩阵与 cordis 排查说明**

「本地测试」节后追加：

```markdown
## 支持矩阵

| 平台 | 状态 |
|---|---|
| Linux / macOS / WSL | 一级支持（specify CLI 生成符号链接，bash 脚本原生） |
| Windows 原生 | 已验证（36+ 测试全绿）；CLI 无 symlink 权限时钩子技能回退为内容一致的副本；`.specify/scripts/` 仅 bash 版本，Spec Kit 脚本步骤需 WSL/Git Bash |

**插件不加载时的排查**：`cordis.patch.yml` 用 `!!js` + `createRequire(baseUrl)` 定位包内 `skills/`，是加载的单点故障。确认 profile 的 `node_modules/dsh-sdd-kit` 存在且 `package.json` 可解析；DSH 日志中 skill-filesystem 提供器报错时优先检查该路径。
```

**Step 4: 跑全量 + Commit**

Run: `npm test` → 0 fail。
```bash
git add package.json README.md
git commit -m "docs: 平台支持矩阵与 cordis 加载排查；peerDependencies 下界按宿主核实结果收紧"
```

---

### Task 6: 发布 v0.5.0（⚠️ 需拥有者明确批准后执行）

**Files:**
- Modify: `package.json`（version）、`README.md`（发布链接/tgz 名）、`cordis.patch.yml`（头注释版本号）
- Create: `docs/releases/v0.5.0.md`

**Step 1:** `package.json` version → `0.5.0`；README 中 `v0.4.0` 链接与 `dsh-sdd-kit-0.4.0.tgz` 同步为 0.5.0；`cordis.patch.yml` 首行注释版本号同步（测试 `README install commands...` 强制三者一致）。

**Step 2:** 写 `docs/releases/v0.5.0.md`：破坏性变更（update_all 两层、check_task/force/dshKitSourceDir 删除、安装产物 untrack、setup 动作新增）、迁移步骤（`dsh plugin update --latest` + 重启 + `/sdd-setup`）、验证证据（`npm test` 计数）。用 `git log --oneline v0.4.0..HEAD` 列完整变更。

**Step 3:** `npm test` 全绿 → 提交 `chore(release): bump to 0.5.0` 与 `docs(release): v0.5.0 notes` → 打 tag `v0.5.0` → 推送（SSH：`git push git@github.com:bobo522487/dsh-sdd-kit.git main --tags`）。

---

## 明确不做（YAGNI 守卫）

- **不引入 YAML 解析依赖、不做 codegen**：Task 1 的定向读取器就是最薄方案。
- **不新增第三个工具**：`sdd_doctor` 的只读价值由 `setup` 首步 inspect + 既有 `status` 覆盖；加工具要动章程表面上限，收益不抵成本。
- **不做 pending-restart 标记文件**：两个重启判定点语义清晰（首次克隆 / 技能数变化），为"用户可能忘记"造状态文件是投机。
- **不启用 Runtime Events 硬门禁**、**不为假想多宿主抽象 integration 层**。
- **不重写历史 specs**（章程 VI 豁免存量）。

## 留给拥有者的批次 3 决策（不在本计划执行）

1. 章程原则 I 的"薄"度量从**技能个数**改为**动词数 + 自研行数预算**（当前 2 工具 13 动词；本计划 +1 动词 −约 60 行常量/散文）。
2. 变更分级入章程（轻量通道合法化），避免小变更再产 188KB 规格。
3. `install_hooks_ext` 的 `restartRequired: false` 假设（DSH 是否重扫 `.dsh/skills`）需在真实 DSH 宿主上验证一次。
