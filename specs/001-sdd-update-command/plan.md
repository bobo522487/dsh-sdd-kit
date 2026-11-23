# Implementation Plan: SDD Unified Update Command

**Branch**: `001-sdd-update-command` (planned; current branch is `main`) | **Date**: 2026-11-23 | **Spec**: [spec.md](./spec.md)

**Input**: 功能规格来自 `/specs/001-sdd-update-command/spec.md`

**Note**: 本文件是 `/speckit-plan` 的输出。`tasks.md` 特意不在此创建；它是 `/speckit-tasks` 的 Phase 2 输出。

## Summary

用户要求提供一个字面量命令 `/sdd-update`，用于刷新 Spec Kit（`specify` CLI）、本地 `obra/superpowers` Git 镜像以及已安装的 dsh-sdd-kit profile 副本，并为每个组件报告 before 标识、after 标识、结果与后续操作（spec.md:6，REQ-01 见 :16，AC-01 见 :31）。

技术方案：新增第三个薄技能 `skills/sdd-update/SKILL.md`（它是唯一能映射到字面量 `/sdd-update` 手势的 DSH 机制），其正文仅委托给现有 `sdd_upstream` Host 工具上新增的 `update_all` 动作。核心逻辑位于两个新的薄模块中：`src/core/update.mjs`（编排器）与 `src/core/kit-copy.mjs`（profile-copy 胶水）。编排器调用现有 `runUpstream` 动作 `status`、`specify_upgrade` 与 `sync_superpowers`，比较更新前后的标识，用 `Promise.allSettled` 隔离每个组件，使单个失败不会中止其他组件，并为每个组件返回一条 `ComponentUpdateRecord`，外加 `ok` 与 `requiresRestart`。profile 副本使用显式源目录、派生的 `DSH_PROFILE_DIR`、来自 `package.json:13-20` 的白名单、确定性树哈希，以及暂存文件 + `fs.rename`，以避免改动 pnpm-store 硬链接。不触碰任何项目 specs、plans、tasks 或应用源码。

章程治理已由独立命令完成：当前 [.specify/memory/constitution.md](.specify/memory/constitution.md) 为 v2.1.0，原则 I 已允许三个命名技能（`sdd-setup`、`sdd-implement`、`sdd-update`）与两个 Host 工具（`sdd_upstream`、`sdd_bridge`），并包含 v2.0.0 迁移说明与中文优先原则 VI。功能任务 T001 仅核验该状态，不得重新修正或降级章程。

## Technical Context

**Language/Version**：Node.js >=18，使用原生 ESM（`package.json:44-46`、constitution.md:78）；不使用 TypeScript，不使用转译器。

**Primary Dependencies**：仅 Node 内置模块（`node:fs/promises`、`node:path`、`node:os`、`node:crypto`、经现有 runner 使用的 `node:child_process`）。现有内部 API：`src/core/upstream.mjs:95` 中的 `runUpstream(args, runner)`、`runBridge`（仅只读用法）、`src/register.mjs:9` 中的 `registerSddTools`。上游事实来源仍为 `specify` CLI 与 `~/.dsh/upstream/superpowers` Git 镜像。不新增 npm 依赖（constitution.md:78）。

**Storage**：仅本地文件系统。读写目标：Superpowers 镜像（`~/.dsh/upstream/superpowers`）、已安装的 profile 副本（`$DSH_PROFILE_DIR/node_modules/dsh-sdd-kit`，回退为 `~/.dsh/profiles/${DSH_PROFILE:-web}/node_modules/dsh-sdd-kit`），以及该 profile 副本旁的临时暂存目录。无数据库。`cwd` 下的项目文件（`specs/`、`plan.md`、`tasks.md`、应用源码、`.specify/`）为只读或不被触碰。

**Testing**：`npm test` → `node --test test/sdd-kit.test.mjs`（`package.json:42`）。按 `test/sdd-kit.test.mjs:16-59` 与 `:161-200` 的模式，以注入的 `runUpstream`/`refreshKit` 假实现和临时目录文件系统快照来扩展现有测试套件。每个任务严格遵循 Red → Green → Refactor（constitution.md:46-50）。

**Target Platform**：宿主操作系统上的 DSH Web/Desktop profile；插件内部为 Node 18+ 运行时。斜杠命令由 `@deepseek-ai/dsh-skill-filesystem` 挂载打包的 `skills/` 目录提供（`cordis.patch.yml:5-11`）。

**Project Type**: DSH 插件：当前章程已允许 3 个面向用户的技能 + 2 个轻量 Host 工具；本功能新增编排模块和 profile-copy 胶水模块，不引入并行更新器。

**Performance Goals**: 单次非交互调用检查全部三个组件并在五分钟内完成（[spec.md:28](specs/001-sdd-update-command/spec.md#L28)、[spec.md:36](specs/001-sdd-update-command/spec.md#L36)）。现有上游命令已有 120 s 单命令超时（`src/core/upstream.mjs:49`）；T014 增加耗时验证与网络/缓存前提记录。

**Constraints**:
- 零分叉：MUST 委托给现有 `runUpstream` 动作；MUST NOT 重新实现 `specify`/`git` 更新逻辑（constitution.md:24-37；spec.md:27、:47）。
- Surface cap: 章程 v2.1.0 已允许三个命名技能 + 两个 Host 工具，本功能不新增工具、不新增命令机制（见 Constitution Check）。
- 不从 `/sdd-update` 调用 `specify_init` 或 `install_bug_ext`；它们会写入 `.specify/`（src/core/upstream.mjs:155-172），并会破坏 REQ-06（spec.md:21）。
- 不调用 `sdd_bridge` 的变更类操作（`install_overrides`、`check_task`、`sync_index`，见 src/core/bridge.mjs:142-230）。
- profile 文件以硬链接指向 pnpm 内容寻址存储；绝不原地写入，绝不对整个目标执行 `rm -rf`（constitution.md:81-83；来自更新调研）。
- 仅凭版本号无法检测漂移：`package.json` 由 T002 升到 `0.3.0`，但已安装的 profile 副本可能仍携带版本相同或不同的旧目录树，因此变更检测 MUST 使用树哈希。
- 当 profile 副本发生变化或 Superpowers 技能发生变化时，MUST 报告需要重启（constitution.md:62、:81-83；skills/sdd-setup/SKILL.md:16）。

**Scale/Scope**：一条命令、恰好三个受管组件、每个组件一条记录、每次调用一个状态对象；不含多项目或批量范围。

## Constitution Check

*GATE：必须在 Phase 0 调研前通过。Phase 1 设计后重新核查。*

**当前章程核验结果：PASS（治理已先行完成）。**

| 检查项 | 结果 | 证据 / 说明 |
| :--- | :--- | :--- |
| 原则 I — 零分叉，薄胶水层 | PASS | [.specify/memory/constitution.md:24-37](.specify/memory/constitution.md#L24-L37) 已允许三个命名技能（`sdd-setup`、`sdd-implement`、`sdd-update`）与两个 Host 工具；`/sdd-update` 保持声明式，仅委托 `sdd_upstream(update_all)` 一次。DSH 仅把 `/name` 绑定到技能目录（`cordis.patch.yml:1-4`；`skills/sdd-*/SKILL.md:1-7`；DSH `dsh-tool-skill/src/index.ts:429`），故第三个技能是该手势的必要薄表面。 |
| 原则 II — 规范优先，采用 EARS 与非目标 | PASS | [spec.md:14-27](specs/001-sdd-update-command/spec.md#L14-L27) 使用 EARS，REQ-02/AC-02 已改为可观测语义；非目标已声明。 |
| 原则 III — 严格测试先行 | PASS（计划中） | AC-01..AC-06 均有 RED→GREEN 测试任务，`npm test` 为完成闸门。 |
| 原则 IV — 当前分支上的原子提交 | PASS（计划中） | 任务在当前分支逐项原子提交，不创建 worktree/分支。 |
| 原则 V — 可升级、免值守的上游同步 | PASS | 复用现有免值守 `specify_upgrade`/`sync_superpowers`；无新交互提示；包含重启提示。 |
| 原则 VI — 中文优先的文档与答复 | PASS（本次修订） | 本次对 plan/tasks/spec 的修订内容为中文；存量英文段落按 v2.1.0 迁移说明可逐步中文化。 |
| 技术与集成约束 | PASS | Node >=18 ESM、无新增依赖、无上游逻辑分叉、profile-copy 重启提示已覆盖。 |

**Phase 1 设计后复核：PASS。** 三技能/两工具表面与 [test/sdd-kit.test.mjs](test/sdd-kit.test.mjs) 的断言更新、[cordis.patch.yml](cordis.patch.yml) 与 [README.md](README.md) 注释保持一致；治理修正案已由独立章程命令批准，T001 改为核验任务，不再重复修正。无新增门禁违规；不可避免的取舍见 Complexity Tracking。

## Phase 0 Outline

- **Input**：spec.md + constitution.md + 现有 `runUpstream`/`runBridge`/register/cordis 源码。
- **Output**：`research.md`，记录已确定的命令表面决策、更新机制决策、标识策略、profile-copy 安全决策与测试策略，每项均含理由与被否决的替代方案。
- **已解决的未知项**：(1) `/sdd-update` 如何做到用户可调用；(2) 在纯 profile-copy 安装下“更新 dsh-sdd-kit”意味着什么；(3) 如何区分已是最新与已更新；(4) 如何隔离失败；(5) 何时需要重启。

## Phase 1 Outline

- **Output**：`data-model.md`、`contracts/sdd-update.contract.md`、`quickstart.md`。
- **Data model**：`ComponentUpdateRecord`、`UpdateReport`、`KitCopyResult`、配置输入、结果枚举（`unchanged` | `updated` | `failed`）、错误形状。
- **Contract**：`sdd_upstream` 新增 `action: "update_all"`，参数为 `cwd`、`dshKitSourceDir`、`dshProfileDir?`、`superpowersDir?`、`python?`、`repoUrl?`；定义了响应 schema 与逐组件语义；排除所有变更类 `specify_init`/`install_bug_ext`/`sdd_bridge` 动作。
- **Quickstart**：如何运行 `/sdd-update`、需要哪些配置、如何阅读报告、重启指引，以及首次采用的注意事项（该命令必须已安装在 profile 中）。

## Project Structure

### Documentation (this feature)

```text
specs/001-sdd-update-command/
├── plan.md              # This file (/speckit-plan output)
├── research.md          # Phase 0 output (/speckit-plan output)
├── data-model.md        # Phase 1 output (/speckit-plan output)
├── quickstart.md        # Phase 1 output (/speckit-plan output)
├── contracts/
│   └── sdd-update.contract.md  # Phase 1 output (/speckit-plan output)
└── tasks.md             # Phase 2 output (/speckit-tasks; NOT created here)
```

### Source Code (repository root)

```text
.specify/memory/constitution.md      # 已批准至 v2.1.0（原则 I：三个命名技能；原则 VI：中文优先）
README.md                            # document /sdd-update; 3 skills + 2 tools
package.json                         # plugin version 0.3.0; files[] already packages skills/
cordis.patch.yml                     # comment-only: v0.3.0, three skills
skills/
├── sdd-setup/SKILL.md               # unchanged
├── sdd-implement/SKILL.md           # unchanged
└── sdd-update/SKILL.md              # NEW: thin command, delegates to sdd_upstream(update_all)
src/
├── index.mjs                        # unchanged (registerSddTools still injected with tools)
├── register.mjs                     # sdd_upstream gains update_all action + params
└── core/
    ├── upstream.mjs                 # unchanged (status/specify_upgrade/sync_superpowers reused)
    ├── bridge.mjs                   # unchanged (mutators explicitly excluded)
    ├── update.mjs                   # NEW: runUpdate orchestrator, Promise.allSettled isolation
    └── kit-copy.mjs                 # NEW: assertInside guards, tree hash, staged copy+rename
test/
└── sdd-kit.test.mjs                 # extended: 3-skill assertion + AC-01..AC-06 cases
```

**Structure Decision**：单一的现有 Node ESM 插件；不新增顶层项目或包。新逻辑拆分为两个小的 `src/core/` 模块，使 Host 工具保持为薄分发器、技能保持声明式。整个 `skills/` 目录已由 `cordis.patch.yml:5-11` 与 `package.json:13-20` 打包，因此新增技能无需新的挂载。

## Complexity Tracking

| 违规项 | 为何需要 | 更简单的替代方案被否决的原因 |
|-----------|------------|-------------------------------------|
| 第三个用户技能与旧版两技能上限冲突；已通过独立章程命令修正，当前 v2.1.0 已允许 | 用户明确要求字面量 `/sdd-update`；DSH 仅把 `/name` 绑定到技能目录，无技能别名/子命令（`dsh-tool-skill/src/index.ts:429`） | 仅给 `sdd_upstream` 增加 `update_all` 虽符合章程，但 Host 工具是模型可调用的，不能产生用户手势；`ctx.commands.register` 会引入未枚举的表面且缺乏 ACP 等价能力。 |
| REQ-02 采用幂等更新器 + before/after 比较，而非只读探测 | 现有薄上游表面没有只读“最新版本/HEAD”动作；规范已改为可观测语义（before/after 相同、无有效变化），与设计一致 | 严格的预检会新增并行网络逻辑并违反零分叉；AC-02 的可观测结果保持不变。 |
| 采用暂存复制 + 逐条目 `fs.rename`，而非 `fs.cp`/`fs.copyFile` | 已安装的 profile 文件以硬链接指向 pnpm 存储；原地写入会改动共享存储及其他 profile | 纯复制虽更短但不安全；官方 `dsh plugin add` 依赖已发布的新版 tarball，在 registry 滞后时可能造成降级，且无法指向 spec.md:46 要求的本地事实来源。 |
| 章程 MAJOR 修正已先行完成，功能内不再重复 | 治理命令已批准 v2.0.0，随后升至 v2.1.0；T001 仅核验该状态 | 在功能任务中重复修正会回退或污染已批准的治理状态。 |
| 以白名单文件的树哈希作为 dsh-kit 标识 | 已安装的 profile 目录没有 `.git`，打包版本也无法证明已安装目录树与源码检出匹配，因此版本号与 HEAD 均无法检测漂移 | 仅比较版本会误报 `unchanged` 并跳过复制；已安装 profile 中无法获得源码 git HEAD。 |
