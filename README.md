# dsh-sdd-kit

> **零分叉，薄胶水（Zero Fork, Thin Glue）。**
> 面向 **DeepSeek Harness（DSH）** 的极简 SDD 桥接插件：
> **GitHub Spec Kit** 决定*做什么*（`specify` CLI），**obra/superpowers** 决定*怎么做*（实时 Git 镜像），**`dsh-sdd-kit`** 用 **2 个技能 + 2 个薄 Host 工具 + 1 个内置 Spec Kit 扩展**把两者粘合起来。

## 为什么采用这种架构？

- **可升级（Upgrade-Proof）**：从不重新实现 Spec Kit 或 Superpowers。随时运行 `/sdd-setup` 即可 `uv tool upgrade specify-cli` 并 `git pull` `~/.dsh/upstream/superpowers`。
- **SDD 生态最佳组合（零侵入）**：
  - **Spec Kit**：章程、`specify → clarify → plan → tasks → analyze → converge`，以及官方 `specify extension add bug`。
  - **Superpowers**：严格 TDD（Red → Green → Refactor）、系统化调试、完成前验证，以及两阶段代码评审。
  - **Kiro / cc-sdd**：通过 Spec Kit 官方 `.specify/templates/overrides/spec-template.md` 注入 EARS 验收语法（`WHEN ... THE SYSTEM SHALL ...`）与强制的 **Non-Goals**。
  - **GSD**：干净上下文的执行纪律 + 直接在当前分支上按任务原子 `git commit`。
  - **OpenSpec**：自动维护 `specs/INDEX.md` 活文档，便于在存量项目中保持可见性。

## 安装到 DSH

从 GitHub 安装（当前发布版本 [`v0.5.1`](https://github.com/bobo522487/dsh-sdd-kit/releases/tag/v0.5.1)）：

```bash
# Web profile
dsh plugin --profile web add https://github.com/bobo522487/dsh-sdd-kit

# Desktop profile
dsh plugin --profile desktop add https://github.com/bobo522487/dsh-sdd-kit
```

或从本地 `.tgz` 压缩包安装：

```bash
dsh plugin --profile web add ./dsh-sdd-kit-0.5.1.tgz
```

安装后重启 DSH，然后在项目中运行 `/sdd-setup`。

升级到新版本时，git 依赖的锁文件指向具体 commit，**必须让 pnpm 重新解析**，否则内容会停在旧 commit：

```bash
dsh plugin --profile web update dsh-sdd-kit --latest
```

要点：

- 只重新 `add` 同一个来源**不会**升级——specifier 没变时 pnpm 直接报 `Lockfile is up to date, resolution step is skipped`，锁仍钉在旧 commit。
- `pnpm update --force` 在 pnpm v12 上不可用（`error: unexpected argument '--force' found`）。
- 升级后重启 DSH，并在项目里重跑 `/sdd-setup` 重装扩展。

**既有项目的 integration 不会自动切换**：`/sdd-setup` 为保护用户布局只报告不一致；重跑多少次都仍是原 integration。要显式切换到 DSH 原生技能根，传 `switchIntegration: true` 重跑 `/sdd-setup`（内部调用一次 `sdd_upstream(action: "switch_integration")`，等价于 `specify integration switch dsh`，随后重装钩子扩展）。切换只替换未修改的托管文件，本地改过的文件会保留；`.specify/extensions.yml`、模板与脚本不受影响。

## 日常流程

1. **初始化 / 升级**：`/sdd-setup`（同步 `~/.dsh/upstream/superpowers`、检查或升级 `specify-cli`、执行 `specify init --here --integration dsh` 与 `specify extension add bug`、装入本仓库内置的 `superpowers-hooks` 扩展、安装 EARS/Non-Goals 模板覆盖）。init 以无人值守方式运行，跳过 agent 工具检查，并为安装固定稳定 Python。
2. **刷新两层上游**：`/sdd-update` 在一次调用中检查并更新两层上游——`specify-cli` 与 `~/.dsh/upstream/superpowers` 镜像——并输出每个组件的 `before → after` 报告与所需的重启提示。**插件自身不在其职责内**：升级 dsh-sdd-kit 请走上文的包管理器路径（`dsh plugin --profile <profile> update dsh-sdd-kit --latest` + 重启 DSH），插件不复制、不替换已安装的 profile 副本。
3. **开发特性**：
   - 用原生 Spec Kit 规划：`/speckit.constitution` → `/speckit.specify` → `/speckit.clarify` → `/speckit.plan` → `/speckit.tasks` → `/speckit.analyze`
   - 用原生 `/speckit.implement` 执行。内置扩展的 `before_implement` 钩子会在写第一行源码前自动拉起 Superpowers 的严格 TDD 与根因调试纪律，`after_implement` 钩子在完成后做两阶段自审并提示 `/speckit.converge`；每个任务仍在当前分支上原子提交。
4. **修复缺陷**：
   - 用原生 Spec Kit 评估：`/speckit-bug-assess "<symptom>" slug=<slug>`
   - 用原生 `/speckit-bug-fix slug=<slug>` 修复。`before_bug_fix` 钩子自动注入系统化调试与复现测试纪律，`after_bug_fix` 钩子在写完修复报告后做两阶段自审并提示 `/speckit-bug-test slug=<slug>`，直至 `verified`。

## 扩展钩子（Hooks）

执行纪律不再由一个桥接技能承载，而是由仓库内 `spec-kit-extension/` 这个标准 Spec Kit 扩展注入：

| 事件 | 触发时机 | 自动加载的上游技能 |
|---|---|---|
| `before_implement` | `/speckit.implement` 写第一行源码前 | `test-driven-development`、`systematic-debugging` |
| `after_implement` | 全部任务完成后 | `verification-before-completion`、`requesting-code-review` |
| `before_bug_fix` | `/speckit-bug-fix` 改源码前 | `systematic-debugging`、`test-driven-development` |
| `after_bug_fix` | 修复报告写完后 | `verification-before-completion`、`requesting-code-review` |

四条钩子均为 `optional: false`（强制）。日常只需敲 Spec Kit 原生命令，纪律由钩子织入；Spec Kit 升级 `/speckit.implement` 模板时不会冲突。

> 若未来需要硬门禁（例如「未跑测试禁止 commit」），Spec Kit 的 Runtime Events（`pre_tool_use` 等）是现成的可选升级口；当前刻意不使用，保持软门禁。

## 新克隆的仓库

`.dsh/skills/` 与 `.specify/extensions*` 是安装产物，不入库。克隆后运行一次 `/sdd-setup` 即可幂等重建（specify-cli、Superpowers 镜像、bug 与 hooks 扩展、EARS 覆盖）。治理文档 `.specify/memory/constitution.md` 与上游脚本/模板仍在库中。

从把安装产物**入库**的旧版本（≤ v0.4.x）升级上来的仓库，`.specify/` 布局已存在，`/sdd-setup` 按 REQ-15 不会重跑 `specify init`。v0.5.1 起，setup 会额外检查 `.dsh/skills/speckit-implement/SKILL.md`：缺失时依次尝试 `specify integration upgrade <key>` 与 `specify integration install <key>` 重建原生命令技能（报告中的 `integration_commands` 步骤），两者都失败才标 `failed`。该修复在扩展安装之前执行，不会覆盖钩子注册。

## 支持矩阵

| 平台 | 状态 |
|---|---|
| Linux / macOS / WSL | 一级支持（specify CLI 生成符号链接，bash 脚本原生） |
| Windows 原生 | 已验证（51 测试全绿）；CLI 无 symlink 权限时钩子技能回退为内容一致的副本；`.specify/scripts/` 仅 bash 版本，Spec Kit 脚本步骤需 WSL/Git Bash |

`peerDependencies` 目前为 `"*"`：宿主 `@deepseek-ai/cordis`、`dsh-tools`、`dsh-skill-filesystem` 的实际版本下界待在可读取的 DSH profile 上核实后收紧（desktop profile 的宿主包内置于应用，profile 内不可读）。

**插件不加载时的排查**：`cordis.patch.yml` 用 `!!js` + `createRequire(baseUrl)` 定位包内 `skills/`，是加载的单点故障。确认 profile 的 `node_modules/dsh-sdd-kit` 存在且 `package.json` 可解析；DSH 日志中 skill-filesystem 提供器报错时优先检查该路径。

## 本地测试

```bash
npm test
```
