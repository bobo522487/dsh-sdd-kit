# dsh-sdd-kit

> **零分叉，薄胶水（Zero Fork, Thin Glue）。**
> 面向 **DeepSeek Harness（DSH）** 的极简 SDD 桥接插件：
> **GitHub Spec Kit** 决定*做什么*（`specify` CLI），**obra/superpowers** 决定*怎么做*（实时 Git 镜像），**`dsh-sdd-kit`** 用 **2 个技能 + 2 个薄 Host 工具 + 1 个宿主中立 CLI（`bin/sdd-kit.mjs`）+ 1 个内置 Spec Kit 扩展**把两者粘合起来（章程 v5.0.0 五项对外表面）。

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

## 跨宿主安装、CLI 与体检

宿主中立 CLI 只做参数解析与结果序列化，所有动作委托 `src/core/action.mjs`；与 DSH 工具输出结构同构（章程 v5.0.0）。

```bash
# 任一宿主项目中由上游安装/切换集成（扩展命令只渲染到曾激活的集成）
specify integration install dsh
specify integration install claude
specify integration install cursor-agent
specify integration install codex
specify integration use <key> --trust-integration

# 零第三方依赖 CLI（包内 bin/sdd-kit.mjs）
node ./node_modules/dsh-sdd-kit/bin/sdd-kit.mjs doctor --json --trigger "修复登录崩溃"
node ./node_modules/dsh-sdd-kit/bin/sdd-kit.mjs guard --json
```

`doctor --json` 返回 environment / host / repository / runtime / triggerDryRun 五区；网络探测显式 skip，不写任何文件，单次 ≤5 秒。触发试跑只对当前可见技能确定性打分（100 条 ≤1 秒），不执行技能；Cursor 的 `-p` / `--trust` / `--approve-mcps` / `--force` 参数由宿主能力表检测并告警。

重载三态由 `HOST_CAPABILITIES.<host>.reloadPolicy` 决定：

| 结果 | 含义 | 待生效标记 |
|---|---|---|
| `none` | 无改动，无需处理 | 不落盘 |
| `new_session` | 开新会话后生效 | `.specify/sdd-pending.json` 按 host 写入 |
| `restart_host` | 重启宿主后生效 | 同上，宿主启动时只清当前 host 条目 |

详见 [docs/adapters/README.md](docs/adapters/README.md) 与 [止损线](docs/adapters/stop-loss.md)。

## 安装安全性

模板覆盖（`.specify/templates/overrides/spec-template.md`）不再「文件存在就跳过」。每次 `/sdd-setup` 或 `sdd_bridge(action: "install_overrides")` 都先按内容指纹判定状态，再决定动作：

| 状态 | 含义 | 默认行为 |
|---|---|---|
| `not_installed` | 目标文件不存在 | 写入随包模板 |
| `installed_consistent` | 指纹与随包模板一致 | 不写入、不碰 mtime |
| `user_modified` | 指纹既非随包也不在历史台账里 | 保留你的改动，报告 `nextAction` |
| `stale_upstream` | 指纹命中旧版本台账 | 保留现状并提示可刷新（附 `localVersion`/`bundledVersion`） |
| `unknown` | 读不了（权限、符号链接等） | 不写入，报告原因 |

`nextAction` 是机器可读建议（形如 `{ tool, args }`），技能只原样展示并等确认，绝不自行执行——所以手工定制不会被静默覆盖。确认显式覆盖后，报告状态为 `written`（手改/未知来源）或 `refreshed`（仅历史版本刷新）。`unknown` 不能靠显式意图硬写：读不出原字节就留不下可回滚的快照，此时一律拒绝覆盖并报 `E_SNAPSHOT_UNREADABLE`——先把权限修好再来。

**快照与一键回滚**：显式覆盖前，原内容先快照到 `.specify/templates/overrides/.backup/`（`<id>.bak` + `manifest.json`）。该目录**自带 `.gitignore`（内容 `*`）**，因此永远不出现在 `git status` 里，也不依赖、不改写你项目根目录的 `.gitignore`。回滚用 `sdd_bridge(action: "restore_overrides")`（可传 `artifact` 只还原某一项）：逐项校验快照指纹，只还原清单内的文件，空清单返回 `ok:false` 而不是假装成功；成功后快照保留，可重复回滚。

**写入安全**：所有写入走「同目录临时文件 → `fsync` → 单次 `rename`」，异常时清理临时文件且目标保持原内容；写入前逐段检查路径分量，任一层是符号链接或逃出项目根即拒绝（`E_SYMLINK` / `E_ESCAPE`），不会顺着软链改到项目外。多个产物时单个失败不影响其余，报告里逐项给出状态。

**候选目录选择**：`~/.dsh/upstream/superpowers` 不再是硬编码唯一答案。候选按声明顺序来自：显式 `superpowersDir` → 调用方 `candidateDirs` → `DSH_SDD_KIT_SUPERPOWERS_DIR` → `$DSH_HOME/upstream/superpowers` → 默认 `~/.dsh/upstream/superpowers`；按 `realpath` 去重（同一目录的多个别名只算一次）、最近修改时间优先、同时间按声明顺序决胜，报告里给出所选绝对路径与依据。不扫描文件系统，只认这五个声明来源。

**真实上游验证**：`npm run verify:upstream` 会在临时项目里真跑 `specify init`、`specify extension add --dev`、`specify extension list --json`，核对参数与扩展契约今天是否仍成立。工具缺失/断网导致的 `not_executed`、契约不符、以及 `versionDrift.needsAdjustment` 版本下界漂移都返回非零退出码 1；CI 对此再做一次独立门禁。它不进 `npm test`（日常不联网），`.github/workflows/upstream-integration.yml` 每日 03:00 UTC 跑一次，也可手动触发。

## 扩展钩子（Hooks）

执行纪律不再由一个桥接技能承载，而是由仓库内 `spec-kit-extension/` 这个标准 Spec Kit 扩展注入：

| 事件 | 触发时机 | 自动加载的上游技能 |
|---|---|---|
| `before_implement` | `/speckit.implement` 写第一行源码前 | `test-driven-development`、`systematic-debugging` |
| `before_clarify` / `before_plan` | 规划命令执行前（只读） | 加载 `/sdd-kit guard`，tasks.md 存在已勾选任务时拦截并提示 |
| `after_implement` | 全部任务完成后 | `verification-before-completion`、`requesting-code-review` |
| `before_bug_fix` | `/speckit-bug-fix` 改源码前 | `systematic-debugging`、`test-driven-development` |
| `after_bug_fix` | 修复报告写完后 | `verification-before-completion`、`requesting-code-review` |

六条执行钩子均为 `optional: false`（强制），另有一条 `session_start` 事件。日常只需敲 Spec Kit 原生命令，纪律由钩子织入；Spec Kit 升级 `/speckit.implement` 模板时不会冲突。

> 若未来需要硬门禁（例如「未跑测试禁止 commit」），Spec Kit 的 Runtime Events（`pre_tool_use` 等）是现成的可选升级口；当前刻意不使用，保持软门禁。

## 新克隆的仓库

`.dsh/skills/` 与 `.specify/extensions*` 是安装产物，不入库。克隆后运行一次 `/sdd-setup` 即可幂等重建（specify-cli、Superpowers 镜像、bug 与 hooks 扩展、EARS 覆盖）。治理文档 `.specify/memory/constitution.md` 与上游脚本/模板仍在库中。

从把安装产物**入库**的旧版本（≤ v0.4.x）升级上来的仓库，`.specify/` 布局已存在，`/sdd-setup` 按 REQ-15 不会重跑 `specify init`。v0.5.1 起，setup 会额外检查 `.dsh/skills/speckit-implement/SKILL.md`：缺失时依次尝试 `specify integration upgrade <key>` 与 `specify integration install <key>` 重建原生命令技能（报告中的 `integration_commands` 步骤），两者都失败才标 `failed`。该修复在扩展安装之前执行，不会覆盖钩子注册。

## 支持矩阵

| 平台 | 状态 |
|---|---|
| Linux / macOS / WSL | 一级支持（specify CLI 生成符号链接，bash 脚本原生） |
| Windows 原生 | 平台路径与扩展安装已验证；CLI 无 symlink 权限时钩子技能回退为内容一致的副本；`.specify/scripts/` 仅 bash 版本，Spec Kit 脚本步骤需 WSL/Git Bash |

`peerDependencies` 已在 DSH 0.2.2-rc.3 宿主实测并收紧为 `@deepseek-ai/cordis >=4.1.0`、`@deepseek-ai/dsh-skill-filesystem >=0.2.2-rc.3`、`@deepseek-ai/dsh-tools >=0.2.2-rc.3`，三项均保持 `optional: true`。`npm run verify:compat` 常态校验版本下界与预发布比较。

**插件不加载时的排查**：`cordis.patch.yml` 用 `!!js` + `createRequire(baseUrl)` 定位包内 `skills/`，是加载的单点故障。确认 profile 的 `node_modules/dsh-sdd-kit` 存在且 `package.json` 可解析；DSH 日志中 skill-filesystem 提供器报错时优先检查该路径。

## 本地测试

```bash
npm test
```

测试数量以本次 `npm test` 实际输出为准，不再在文档中固定历史计数；`npm run test:contract`、`npm run test:adapters` 与 `npm run verify:compat` 分别守护核心同构、四端适配与宿主 peer 下界。
