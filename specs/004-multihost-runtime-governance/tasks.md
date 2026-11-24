---

description: "004-multihost-runtime-governance 任务清单"
---

# Tasks: 跨宿主 SDD 运行时治理层（v2.0）

**Input**: 设计文档位于 `/specs/004-multihost-runtime-governance/`

**Prerequisites**: [plan.md](./plan.md)（必需）、[spec.md](./spec.md)（用户故事与优先级）、[research.md](./research.md)、[data-model.md](./data-model.md)、[contracts/](./contracts/)、[quickstart.md](./quickstart.md)

**Tests**: 本特性**强制 TDD**（章程原则 III：红 → 绿 → 重构，`npm test` 全绿才可勾任务），故每个用户故事阶段均含测试任务，且测试任务 MUST 先于实现任务执行并先观察失败。

**Organization**: 任务按用户故事分组，每个故事可独立实现与独立验证。用户故事编号与 spec.md §2 的 REQ 分组 A–H 一一对应，优先级取自 spec 标注（P0 → P1、P1 → P2、P1 收尾 → P3 之外按里程碑排序）。

## Format: `[ID] [P?] [Story] Description`

- **[P]**：可并行（不同文件、无未完成依赖）
- **[Story]**：所属用户故事（US1–US8）
- 每条任务 MUST 含精确文件路径

## Path Conventions

单仓库单包：`src/`、`bin/`、`test/`、`spec-kit-extension/`、`docs/` 均在仓库根。

---

## Phase 1: Setup（共享基础设施）

**Purpose**：建立新目录骨架与打包/脚本入口，不改任何既有逻辑。

- [x] T001 建立 `src/adapters/dsh/`、`src/adapters/claude/`、`src/adapters/codex/`、`src/adapters/cursor/`、`bin/`、`docs/adapters/` 六个目录（`src/adapters/`、`bin/`、`docs/adapters/`）
- [x] T002 [P] 在 `package.json` 增加 `bin` 字段（`"sdd-kit": "./bin/sdd-kit.mjs"`）并把 `bin/`、`docs/` 加入 `files` 白名单（`package.json`）
- [x] T003 [P] 在 `package.json` 的 `scripts` 增加 `test:contract`（`node --test test/contract-*.test.mjs`）与 `test:adapters`（`node --test test/adapters*.test.mjs`）（`package.json`）

**Checkpoint**：目录与打包入口就绪，`npm test` 仍为基线全绿（91/91，数字不固定，以全绿为判据）。

---

## Phase 2: Foundational（阻塞性前置，MUST 先于全部用户故事）

**Purpose**：宿主能力表（唯一事实源）+ 核心纯度门禁 + CLI 骨架 + 同构断言基座。这四件事被所有故事依赖。

**⚠️ CRITICAL**：本阶段未完成前，任何用户故事不得开始。

- [x] T004 [P] 写失败测试 `test/contract-core-purity.test.mjs`：静态扫描 `src/core/*.mjs`，出现 `@deepseek-ai/`、`ctx.`、`require(`、宿主目录名任一即失败；并含一条「人为注入宿主引用 → 断言必须变红」的自证用例（`test/contract-core-purity.test.mjs`）
- [x] T005 实现 `src/core/host-capabilities.mjs`：导出冻结常量 `HOST_CAPABILITIES`，四键 `dsh|claude|codex|cursor`，每键含 `key`、`integrationKey`、`toolPrefix`、`skillsDir`、`guidanceChannel`、`guidanceConfig`、`reloadPolicy`、`trustFlagPattern`；字段取值与约束见 `data-model.md` 的 `HostCapability.key`、`HostCapability.integrationKey`、`HostCapability.toolPrefix`、`HostCapability.skillsDir`、`HostCapability.guidanceChannel`、`HostCapability.guidanceConfig`、`HostCapability.reloadPolicy`、`HostCapability.trustFlagPattern`（`src/core/host-capabilities.mjs`）
- [x] T006 [P] 写失败测试 `test/host-capabilities.test.mjs`：四端齐全、`reloadPolicy` 三值合法、适配文件行数 ≤100、表内无重复 `skillsDir`（`test/host-capabilities.test.mjs`）
- [x] T007 [P] 写失败测试 `test/contract-parity.test.mjs`：同一动作经核心入口与 CLI 入口执行，输出 JSON 结构深度相等（键集合与类型，非仅快照）（`test/contract-parity.test.mjs`）
- [x] T008 实现 `bin/sdd-kit.mjs` 骨架：`node:util.parseArgs` 解析，子命令 `update|bridge|doctor|guard|guidance` 分发到 `src/core/`，未实现子命令返回 `{status:'error',code,message,fix}` 四字段并非零退出（`bin/sdd-kit.mjs`）

**Checkpoint**：能力表、纯度门禁、CLI 骨架、同构基座全部就位 → 用户故事可并行开始。

---

## Phase 3: User Story 1 - 宿主无关核心与统一 CLI（Priority: P1）🎯 MVP

**Goal**：把治理能力收拢到零宿主依赖核心，工具面与 CLI 走同一实现且输出同构，peer 依赖可选化。对应 REQ-01~07、REQ-14、REQ-21、REQ-45（里程碑 M1 / v0.6.0）。

**Independent Test**：`npm test -- --test-name-pattern="core purity|parity|regression|compat"` 全绿；`node bin/sdd-kit.mjs doctor --json` 在无宿主运行时环境可独立运行且结构与宿主工具一致。

### Tests for User Story 1 ⚠️（先写、先看失败）

- [x] T009 [P] [US1] 写失败测试 `test/regression-dsh.test.mjs`：锁定 `sdd_upstream` / `sdd_bridge` 既有输入字段、输出字段、成功/失败语义与既有版本逐项一致，新增字段须为增量（`test/regression-dsh.test.mjs`）
- [x] T010 [P] [US1] 写失败测试 `test/compat.test.mjs`：`package.json` 三个 peer 均存在 `peerDependenciesMeta.<name>.optional === true`，且无 `*` 之外的强制安装语义（`test/compat.test.mjs`）

### Implementation for User Story 1

- [x] T011 [US1] 在 `src/core/action.mjs` 抽出统一动作入口 `runAction(action, params)`，内部委托既有 `upstream.mjs`/`update.mjs`/`bridge.mjs`，不重实现（`src/core/action.mjs`）
- [x] T012 [US1] 改造 `src/register.mjs` 的两个工具为委托 `runAction`，保持 `registerSddTools(ctx, defineTool, deps)` 签名与渲染契约不变（`src/register.mjs`）
- [x] T013 [P] [US1] `bin/sdd-kit.mjs` 实现 `update`、`bridge` 子命令，全部委托 `runAction`，禁止在 CLI 内复刻逻辑（`bin/sdd-kit.mjs`）
- [x] T014 [US1] `package.json` 为三个 peerDependencies 增加 `peerDependenciesMeta.<name>.optional = true`（`package.json`）
- [x] T015 [US1] 实测并收紧 peer 版本下界：在具备宿主运行时的机器上分别安装，记录真实最低版本并替换 `*`；纯 Node 环境不可定的结论写入 `research.md` 未决事项（`package.json`、`research.md`）
- [x] T016 [US1] 在 `src/index.mjs` 保持 `export const inject = ['tools']` 不变，仅接线适配器（若宿主服务缺失不得影响加载）（`src/index.mjs`）

**Checkpoint**：DSH 端可观察行为 100% 回归一致，CLI 独立可用，MVP 可交付。

---

## Phase 4: User Story 2 - 会话引导（Priority: P1）

**Goal**：新会话首条请求即带常驻引导（上游原文引用 + 工具名映射 + SDD 指针），抗压缩、≤1.2k token、缺依赖静默降级。对应 REQ-08~13（里程碑 M2 / v0.7.0）。

**Independent Test**：`npm test -- --test-name-pattern="guidance"` 全绿；DSH 会话首条请求的常驻上下文可见引导段，模拟压缩后仍在。

### Tests for User Story 2 ⚠️

- [x] T017 [P] [US2] 写失败测试 `test/guidance.test.mjs`：三段内容齐备、`tokenEstimate ≤ 1200`、超限只裁 `sddPointer` 且 `upstreamText` 逐字不变、原文本身超限时保留并记 `warnings`、缺镜像时返回告警而非抛错、项目级开关覆盖全局级、两宿主拼装结果逐字一致（`test/guidance.test.mjs`）
- [x] T018 [P] [US2] 写失败测试 `test/adapters.test.mjs`：`systemPrompt` 服务缺失时插件照常加载且引导静默缺席（`test/adapters.test.mjs`）

### Implementation for User Story 2

- [x] T019 [US2] 实现 `src/core/guidance.mjs` 的 `assembleGuidance({ host, cwd, skills })`，返回结构对应 `data-model.md` 的 `GuidanceBundle.upstreamText`、`GuidanceBundle.toolMapping`、`GuidanceBundle.sddPointer`、`GuidanceBundle.tokenEstimate`、`GuidanceBundle.warnings`；`GuidanceBundle.sddPointer` 的 `feature`/`phase`/`nextCommand` 三字段按 `data-model.md` 的推导规则实现，`phase` 推导 MUST 与 `FeaturePhase.判定` 共用同一实现而非各写一份（`src/core/guidance.mjs`）
- [x] T020 [US2] 在 `src/core/guidance.mjs` 实现 token 估算器（CJK 1 tok/字 + 非 CJK `ceil(chars/3.5)`）与裁剪次序：仅裁 `sddPointer`，`upstreamText` 不可裁（`src/core/guidance.mjs`）
- [x] T021 [US2] 实现两级开关读取与生效层级判定：项目级 `<repo>/.specify/sdd-kit.json` 的 `guidance.enabled`、全局级 `~/.dsh/sdd-kit.json` 的 `guidance.enabled`（HOME 可覆盖，便于测试），产出 `data-model.md` 的 `GuidanceBundle.enabled`（布尔，项目级键存在则覆盖全局级）与 `GuidanceBundle.effectiveScope`（`project|user|default`），并记录生效层级来源供体检引用；文件不可解析视为该级未设置并记 `GuidanceBundle.warnings`，MUST NOT 使引导整体失败，MUST NOT 新建开关文件（`src/core/guidance.mjs`）
- [x] T022 [P] [US2] 实现 `src/adapters/dsh/index.mjs`：用 `ctx.get('systemPrompt')` 读取服务（**不得**写入 `inject` 必需数组），注册 `section({ name:'sdd-kit:discipline', order: getSectionOrder('PLAN_POLICY')+1, text })`，服务缺失则不注册并记告警（`src/adapters/dsh/index.mjs`）
- [x] T023 [US2] 在 `src/index.mjs` 的 `apply(ctx)` 中接线 DSH 适配器，确保 disposer 正确释放（`src/index.mjs`）

**Checkpoint**：引导在 DSH 上常驻且抗压缩，关闭开关后技能目录与可用性不受影响。

---

## Phase 5: User Story 3 - 三态重载与待生效标记（Priority: P1）

**Goal**：改动后唯一结论为「重启宿主 / 新开会话 / 无需动作」，标记按仓库共享、按宿主分条，宿主启动自清当前条目。对应 REQ-15~20（里程碑 M2）。

**Independent Test**：`npm test -- --test-name-pattern="reload|marker"` 全绿；同一改动集在 DSH 得 `restart_host`、在外部宿主得 `new_session`。

### Tests for User Story 3 ⚠️

- [x] T024 [P] [US3] 写失败测试 `test/reload.test.mjs`：三态矩阵逐格断言、空改动集得 `none` 且不落盘、判定只有一处实现（对 `reload.mjs` 唯一导出断言）（`test/reload.test.mjs`）
- [x] T025 [P] [US3] 写失败测试 `test/marker.test.mjs`：写入含 `layer`/`timestamp`/`reason`/`host` 四字段、按 host 分条互不覆盖、清除只作用当前 host、按时间戳区分历史残留与本次改动（`test/marker.test.mjs`）

### Implementation for User Story 3

- [x] T026 [US3] 实现 `src/core/reload.mjs` 的 `decideReload(changes, host)`，返回 `data-model.md` 的 `ReloadDecision.result`（`restart_host|new_session|none`）、`ReloadDecision.layers`（`tool_code|skill_data|extension_command`）、`ReloadDecision.reason`（人可读，含命中的改动层与宿主策略来源）、`ReloadDecision.host`（规范化宿主键）；查表来源为 `HOST_CAPABILITIES[*].reloadPolicy`（`src/core/reload.mjs`）
- [x] T027 [US3] 实现 `src/core/marker.mjs` 读写 `.specify/sdd-pending.json`，文件结构为 `{ [host]: MarkerEntry }`；条目字段对应 `data-model.md` 的 `MarkerEntry.layer`、`MarkerEntry.timestamp`、`MarkerEntry.reason`、`MarkerEntry.host`；写入前做原子写（临时文件 + rename）（`src/core/marker.mjs`）
- [x] T028 [US3] 在 DSH 适配器 `apply` 启动路径调用标记清除，仅删当前仓库当前 host 条目（`src/adapters/dsh/index.mjs`）
- [x] T029 [US3] `runAction('update')` 返回值增加增量字段 `reload`（结论 + 标记路径），既有字段保持不变（`src/core/action.mjs`）

**Checkpoint**：改动后用户能明确知道下一步动作，历史残留不会被误报为本次。

---

## Phase 6: User Story 4 - 扩展多端复用与规划期护栏（Priority: P2）

**Goal**：四个执行钩子在 active 集成上等价生效；规划期命令被只读护栏拦截；扩展声明版本下界并在安装期硬失败。对应 REQ-22~25（里程碑 M3 / v0.8.0）。

**Independent Test**：`npm test -- --test-name-pattern="guard|compat"` 全绿；四端样例项目安装后钩子命令渲染到 active 端；改 `requires.speckit_version` 为 `>=99.0.0` 后安装退出码 1 且无半装产物。

### Tests for User Story 4 ⚠️

- [x] T030 [P] [US4] 写失败测试 `test/guard.test.mjs`：tasks.md 存在且含 `- [x]` 时拦截并非零退出、仅存在未勾选 tasks.md 时不拦截、断言执行前后仓库零文件变更（`test/guard.test.mjs`）
- [x] T031 [P] [US4] 在 `test/compat.test.mjs` 增用例：下界以下安装期失败、无半装残留、`>=1.4.4` 对 `1.4.4.dev0` 判失败、`>=1.4.0` 通过（`test/compat.test.mjs`）

### Implementation for User Story 4

- [x] T032 [US4] 实现 `src/core/guard.mjs`：读当前 feature 的 `tasks.md`，判定规则对应 `data-model.md` 的 `FeaturePhase.判定`（文件存在且 `^- \[[xX]\]` 命中 ≥1 即实现阶段已开始；仅存在未勾选 tasks.md 不拦截），该判定 MUST 与 `GuidanceBundle.sddPointer.phase` 共用同一实现，零写、无状态文件（`src/core/guard.mjs`）
- [x] T033 [US4] `bin/sdd-kit.mjs` 增加 `guard` 子命令：被拦截时非零退出并打印「先回到定义阶段」提示（`bin/sdd-kit.mjs`）
- [x] T034 [US4] `spec-kit-extension/extension.yml` 增加 `hooks.before_clarify` 与 `hooks.before_plan`，命令指向 `node <pkg>/bin/sdd-kit.mjs guard`，`optional: false`（`spec-kit-extension/extension.yml`）
- [x] T035 [P] [US4] `spec-kit-extension/extension.yml` 增加 `events.session_start` 声明（Claude 引导通道），handler 指向 `guidance` 子命令（`spec-kit-extension/extension.yml`）
- [x] T036 [US4] 里程碑 M3 前置验证：四端依次安装并确认扩展命令仅渲染到 active 集成，把实测矩阵写入 `quickstart.md` 场景 8（`quickstart.md`）

**Checkpoint**：规划期不再悄悄漂移；扩展下界失败在安装期即暴露。

---

## Phase 7: User Story 5 - Claude Code 适配器（Priority: P2）

**Goal**：Claude Code 三面实现，缺插件时降级为一句安装提示，输出结构与 DSH 同构。对应 REQ-26~28（里程碑 M3）。

**Independent Test**：`npm test -- --test-name-pattern="adapters-claude"` 全绿；Claude 端等价更新与体检产出与 DSH 一致结构。

### Tests for User Story 5 ⚠️

- [x] T037 [P] [US5] 写失败测试 `test/adapters-claude.test.mjs`：技能面检测 `.claude/skills`、工具面走 CLI、引导面在「原生事件」与「托管块」间可切换且缺插件时降级为安装提示、输出结构与 DSH 一致、实现 ≤100 行（`test/adapters-claude.test.mjs`）

### Implementation for User Story 5

- [x] T038 [US5] 实现 `src/adapters/claude/index.mjs`（≤100 行）：技能面读 `.claude/skills`、工具面委托 CLI、引导面按 `HOST_CAPABILITIES.claude.guidanceChannel` 选择 `native-event` 或降级 `managed-block`；四个必答项（三面契约 + 重载语义）对应 `data-model.md` 的 `ThreeFaceContract.toolFace`、`ThreeFaceContract.guidanceFace`、`ThreeFaceContract.skillFace`、`ThreeFaceContract.reloadSemantics`（`src/adapters/claude/index.mjs`）
- [x] T039 [US5] 实现 Claude 引导降级路径：纪律技能插件或上游镜像缺失时输出一句可执行安装提示，不阻断宿主其余功能（`src/adapters/claude/index.mjs`）
- [x] T040 [US5] 编写 `docs/adapters/claude.md`：记录通道选择（events vs 托管块）的最小验证结论与选择理由（REQ-26 要求文档化）（`docs/adapters/claude.md`）

**Checkpoint**：首个外部端可用，四端阶段的第一道门槛通过。

---

## Phase 8: User Story 6 - Codex 与 Cursor 适配器（Priority: P3）

**Goal**：两端各自原生调用前缀与技能目录完成三面动作；Cursor 自动信任参数显式告警且默认不写入。对应 REQ-29~32（里程碑 M4 / v0.9.0+）。

**Independent Test**：`npm test -- --test-name-pattern="adapters-codex|adapters-cursor"` 全绿；两端适配各 ≤100 行。

### Tests for User Story 6 ⚠️

- [x] T041 [P] [US6] 写失败测试 `test/adapters-codex.test.mjs`：技能面读 `.agents/skills`、调用前缀 `$`、托管块幂等（连续执行两次内容不变）、实现 ≤100 行（`test/adapters-codex.test.mjs`）
- [x] T042 [P] [US6] 写失败测试 `test/adapters-cursor.test.mjs`：技能面读 `.cursor/skills`、调用前缀 `/`、引导落 `.cursor/rules/`、检测到 trust 类参数时输出安全告警、默认写入配置不含该参数、实现 ≤100 行（`test/adapters-cursor.test.mjs`）

### Implementation for User Story 6

- [x] T043 [P] [US6] 实现 `src/adapters/codex/index.mjs`（≤100 行）：项目级幂等托管块（标记包裹、重复执行字节一致）（`src/adapters/codex/index.mjs`）
- [x] T044 [P] [US6] 实现 `src/adapters/cursor/index.mjs`（≤100 行）：`.cursor/rules/sdd-kit-discipline.mdc` 常驻规则 + trust 参数告警（按 `HOST_CAPABILITIES.cursor.trustFlagPattern` 匹配）（`src/adapters/cursor/index.mjs`）
- [x] T045 [US6] 编写 `docs/adapters/codex.md` 与 `docs/adapters/cursor.md`：各自通道选择、调用前缀、Cursor 安全边界说明（`docs/adapters/codex.md`、`docs/adapters/cursor.md`）

**Checkpoint**：四端收官，每端实现均 ≤100 行且核心未改。

---

## Phase 9: User Story 7 - 五区只读体检与回归矩阵（Priority: P3）

**Goal**：一次只读体检定位全部缺失与冲突，五区独立判定；CI 矩阵在上游破坏性变更时合并前变红。对应 REQ-33~42（里程碑 M4）。

**Independent Test**：`npm test -- --test-name-pattern="doctor|trigger"` 全绿；`node bin/sdd-kit.mjs doctor --json` 五区齐备、重复执行零文件变更。

### Tests for User Story 7 ⚠️

- [x] T046 [P] [US7] 写失败测试 `test/doctor.test.mjs`：五区键齐备、单区抛错不影响其余区、区级 `status` 只出现 `pass|fail|skipped|not_executed`、项级 `status` 只出现 `pass|fail|warn|skip`、每项含 `status`/`code`/`message`/`fix`、重复执行结果一致且仓库快照零变更；**性能边界断言**：不含网络探测的单次体检用 `process.hrtime.bigint()` 计时并断言 ≤5000ms（`REQ-33`/`AC-18`，平台受限环境按章程显式 skip 并注明原因）（`test/doctor.test.mjs`）
- [x] T047 [P] [US7] 写失败测试 `test/trigger.test.mjs`：返回按匹配度排序的候选、断言未执行任何技能、镜像缺失时仍返回结果且该区不判失败、范围仅当前可见技能、同分按 `name` 再按 `provider` 字典序稳定排序、`userInvocable=false` 者标 `excluded` 不进候选、`score=0` 仍列出；**性能边界断言**：构造 100 条技能输入，单次打分计时断言 ≤1000ms（`REQ-38`/`AC-19`）（`test/trigger.test.mjs`）

### Implementation for User Story 7

- [x] T048 [US7] 实现 `src/core/doctor.mjs` 的 `runDoctor({ trigger, host })`，返回 `data-model.md` 的 `DoctorReport.environment`、`DoctorReport.host`、`DoctorReport.repository`、`DoctorReport.runtime`、`DoctorReport.triggerDryRun` 五区；**区级状态**取 `DoctorReport` 每区 `status`（`pass|fail|skipped|not_executed`，由该区条目聚合得出），**项级状态**取 `DiagnosticItem.status`（`pass|fail|warn|skip`），两者枚举不同且不得互相赋值；每项另含 `DiagnosticItem.code`、`DiagnosticItem.message`、`DiagnosticItem.fix`（`src/core/doctor.mjs`）
- [x] T049 [US7] 实现环境区：一次性全量探测全部外部工具与平台前提，逐项给状态、失败原因与可直接执行的修复命令（`src/core/doctor.mjs`）
- [x] T050 [US7] 实现宿主区：当前宿主、集成键、扩展状态、纪律技能安装渠道与版本、trust 类参数安全告警（`src/core/doctor.mjs`）
- [x] T051 [US7] 实现仓库区：受管模板与随包版本的内容漂移、原生命令技能产物完整性（`src/core/doctor.mjs`）
- [x] T052 [US7] 实现运行时区：技能挂载情况、同名技能跨提供者优先级冲突、外部桥接插件来源、待生效标记状态（含历史残留按时间戳区分）（`src/core/doctor.mjs`）
- [x] T053 [US7] 实现 `src/core/trigger.mjs`：对当前可见技能（插件 + 用户级，不含仅存在于上游镜像未安装者）按匹配度打分排序，只读不执行；输入技能结构对应 `data-model.md` 的 `SkillSummary.name`、`SkillSummary.description`、`SkillSummary.whenToUse`、`SkillSummary.source`、`SkillSummary.invocation`、`SkillSummary.provider`、`SkillSummary.path`；输出条目字段对应 `data-model.md` 的 `TriggerScore.skill`、`TriggerScore.score`、`TriggerScore.matchedTerms`、`TriggerScore.excluded`；打分口径见 `data-model.md` 的 `TriggerScore` 与 `contracts/host-adapter.md` 的「触发试跑打分」小节，`SkillSummary.invocation.userInvocable=false` 的技能置 `TriggerScore.excluded` 不进候选但仍计入可见总数（`src/core/trigger.mjs`）
- [x] T054 [US7] `bin/sdd-kit.mjs` 增加 `doctor` 子命令与 `--trigger "<描述>"` 选项（`bin/sdd-kit.mjs`）
- [x] T055 [P] [US7] 扩展 `.github/workflows/upstream-integration.yml` 为矩阵：上游维度（最新主干 / 锁定 Spec Kit / 锁定纪律技能镜像）× 宿主维度（DSH + Claude Code，四端阶段扩至四端），每组合执行安装 → 初始化 → 体检冒烟（`.github/workflows/upstream-integration.yml`）
- [x] T056 [US7] 矩阵失败语义：破坏性变更时指出具体命令/参数/契约点与需调整的版本下界；环境不可用时报 `not_executed` 而非通过（`.github/workflows/upstream-integration.yml`、`scripts/verify-upstream.mjs`）

**Checkpoint**：体检成为唯一诊断入口，上游漂移在合并前被拦。

---

## Phase 10: User Story 8 - 渐进交付门槛与零分叉边界（Priority: P1，贯穿）

**Goal**：每个里程碑进入前有前置最小验证、触发止损线时按预设处置；全程零分叉。对应 REQ-43、REQ-44、REQ-46。

**Independent Test**：`npm test -- --test-name-pattern="boundary"` 全绿；模拟前置验证失败时不进入该里程碑。

### Tests for User Story 8 ⚠️

- [x] T057 [P] [US8] 写失败测试 `test/boundary.test.mjs`：在含用户自建普通技能的仓库初始化后该技能字节不变、体检标注为非本套件产物、仓库内不存在上游逻辑复制品（`test/boundary.test.mjs`）

### Implementation for User Story 8

- [x] T058 [US8] 记录 M1 前置验证：`ctx.systemPrompt` 在打包形态下可达（已实测于 `dsh-base/cordis.patch.yml:525-526`），把探针方法与结论写入 `research.md` R3（`research.md`）
- [x] T059 [US8] 记录 M2 前置验证：引导段在模拟上下文压缩后仍存在（agent-loop 每步 `assemble()` 行为），写入 `research.md` R3（`research.md`）
- [x] T060 [US8] 记录 M4 前置验证：Codex 与 Cursor 的纪律技能安装方式可行（`.agents/skills`、`.cursor/skills` 实测），写入 `quickstart.md` 场景 8（`quickstart.md`）
- [x] T061 [US8] 在 `docs/adapters/` 增 `stop-loss.md`：逐里程碑列出止损线触发条件与预设处置（降级固定注入 / 延后扩展 / 冻结后续端 / 回退目录重组）（`docs/adapters/stop-loss.md`）

**Checkpoint**：任何里程碑都不会以未验证状态叠加。

---

## Phase 11: Polish & Cross-Cutting Concerns

**Purpose**：文档、全量验证与收敛。

- [x] T062 [P] 更新 `README.md`：四端安装步骤、体检用法、重载三态说明；把对外表面枚举同步为章程 v5.0.0 的五项（2 技能 + 2 宿主工具 + 1 宿主中立 CLI `bin/sdd-kit.mjs` + 1 扩展），并核对 `test/sdd-kit.test.mjs` 中关于「严格限定为两个命名技能」的断言仍与章程一致（`README.md`、`test/sdd-kit.test.mjs`）
- [x] T063 [P] 编写 `docs/adapters/README.md`：三面契约的实现索引与新增宿主操作手册（`docs/adapters/README.md`）
- [x] T064 全量验证：`npm test` 全绿 + 覆盖差集脚本（spec 46 条 REQ / 23 条 AC 全部有实现或验证任务）零缺口（`test/`）
- [x] T065 [P] 按 `quickstart.md` 11 组场景逐条执行并记录结果（含显式 skip 的平台受限项与原因）（`quickstart.md`）
- [x] T066 逐任务原子提交（当前分支 `main`，不建分支/worktree），完成后同步 `specs/INDEX.md`（仓库根）

---

## Phase 12: Convergence（规格差距收敛）

**Purpose**：基于 2026-11-24 的三路只读评估（REQ-01~46 / AC-01~23）与 spec/plan 对照，补齐已实现但与规范不完全一致的缺口。所有任务完成并通过 TDD 前，不得宣称 Converged。

**Gate**：P0 必须先完成；P1 可在 P0 之后并行；P2 依赖 P0/P1 的公开接口稳定。

### P0：正确性与安全边界（阻塞）

- [x] T067 [US2] 先补失败用例，再让四个引导投递通道统一以 `bundle.enabled` 为闸门：Claude/Codex/Cursor 适配器关闭时不得写托管块/规则文件，CLI `--text` 关闭时不得输出引导文本；补 `test/adapters-claude.test.mjs`、`test/adapters-codex.test.mjs`、`test/adapters-cursor.test.mjs`、`test/contract-parity.test.mjs` 的关闭开关用例（`src/adapters/claude/index.mjs`、`src/adapters/codex/index.mjs`、`src/adapters/cursor/index.mjs`、`bin/sdd-kit.mjs`）
- [x] T068 [US2] 让 `toolMapping(host)` 从 `HOST_CAPABILITIES` 派生：DSH 映射 `sdd_upstream`/`sdd_bridge`，非 DSH 映射 `sdd-kit <subcommand>`；`assembleGuidance` 必须实际使用 `host`，并同步 `contracts/host-adapter.md` 与四端逐字断言（`src/core/guidance.mjs`、`src/core/host-capabilities.mjs`、`test/guidance.test.mjs`、`specs/004-multihost-runtime-governance/contracts/host-adapter.md`）
- [x] T069 [US2] 镜像缺失或 `upstreamText` 为空时，DSH 不得注册 `service.section`，Claude/Codex/Cursor 不得落盘，并把告警投递到宿主可见通道；补空镜像/改名场景测试（`src/adapters/dsh/index.mjs`、`src/adapters/claude/index.mjs`、`src/adapters/codex/index.mjs`、`src/adapters/cursor/index.mjs`、`test/adapters*.test.mjs`）
- [x] T070 [US2] 以 `formatGuidanceText(bundle)` 的最终文本（含标题、工具映射、当前进度标签）计算 `tokenEstimate` 与 1.2k 闸门，超限仍只裁剪 `sddPointer` 并记录告警；补最终文本 ≤1200 或告警的断言（`src/core/guidance.mjs`、`test/guidance.test.mjs`）
- [x] T071 [US2] 按 REQ-08「引用而非复制」与 1.2k 预算明确“上游原文”的注入单位为 frontmatter `name + description`（不复制 SKILL.md 全文）；超长引用条目完整保留、只裁 SDD 指针并记录超限告警；补超长 description 用例（`src/core/guidance.mjs`、`test/guidance.test.mjs`、`specs/004-multihost-runtime-governance/data-model.md`）
- [x] T072 [US7] 体检读取 `.specify/integration.json` / `.specify/integrations.yml` 的已装集成清单，逐端检查 `skillsDir` 下六个命令技能与四个执行钩子；非激活端未渲染必须 `warn`/`fail` 而非恒 `pass`；补多集成与单集成测试（`src/core/doctor.mjs`、`test/doctor.test.mjs`）
- [x] T073 [US7] 宿主区 Cursor 信任告警复用 `checkTrustFlags` 与 `CAP.trustFlagPattern`，不得按 `trustFlags.length` 一刀切；`--harmless` 不告警、真实 `--trust`/`--approve-mcps`/`--force`/`-p` 告警；补测试（`src/core/doctor.mjs`、`src/adapters/cursor/index.mjs`、`test/doctor.test.mjs`、`test/adapters-cursor.test.mjs`）
- [x] T074 [US7] 环境区一次性全量探测 `node/npm/uv/specify/git` 与上游镜像/纪律技能可读性，逐项给出状态、失败原因和可直接执行的修复命令；缺必需项置 `fail`，缺镜像按 REQ-11/AC-07 报失败或告警；补临时 PATH/空镜像测试（`src/core/doctor.mjs`、`test/doctor.test.mjs`）
- [x] T075 [US7] 宿主区报告纪律技能的安装渠道与**实际版本**（从技能插件/扩展清单/镜像读取），不得用套件自身 `package.json` 版本冒充；补有/无技能插件两种测试（`src/core/doctor.mjs`、`test/doctor.test.mjs`）
- [x] T076 [US7] 运行时区报告每个可见技能的 `name/provider/path/source`，同名冲突给出胜出者与优先级顺序；补同名跨提供者测试（`src/core/doctor.mjs`、`test/doctor.test.mjs`）
- [x] T077 [US7] CLI `doctor --trigger` 按宿主技能目录与用户级目录收集 `SkillSummary[]` 后传给 `runDoctor`，不得因 `skills=[]` 恒报 `skipped`，且不执行任何技能；补 CLI 触发试跑测试（`bin/sdd-kit.mjs`、`src/core/action.mjs`、`test/doctor.test.mjs`）
- [x] T078 [US7] 体检新增“非本套件产物”标注项，识别并列出用户自建普通技能，不误报为漂移；补 boundary/doctor 测试（`src/core/doctor.mjs`、`test/boundary.test.mjs`、`test/doctor.test.mjs`）
- [x] T079 [US1] 把 `DSH_*` 环境变量、`host='dsh'` 默认值等宿主专属引用纳入核心纯度静态门禁；把 DSH 路径/环境解析下沉到 `src/adapters/dsh/` 或能力表，核心只接受注入，并补自证用例（`test/contract-core-purity.test.mjs`、`src/core/candidates.mjs`、`src/core/doctor.mjs`、`src/adapters/dsh/index.mjs`）

### P1：重载、标记与适配器接线

- [x] T080 [US3] 待生效标记支持记录全部受影响层（`layers` 数组或按层多条），`withReload` 不得只写 `layers[0]`；消费端兼容并补多组件更新测试（`src/core/action.mjs`、`src/core/marker.mjs`、`test/marker.test.mjs`、`test/reload.test.mjs`）
- [x] T081 [US3] 为 Claude/Codex/Cursor 增加启动清理入口，CLI `guidance`/`doctor` 支持按 `--host` 清理当前仓库当前宿主条目；doctor 的修复提示必须指向真实存在的命令；补各端清理测试（`src/adapters/claude/index.mjs`、`src/adapters/codex/index.mjs`、`src/adapters/cursor/index.mjs`、`bin/sdd-kit.mjs`、`src/core/doctor.mjs`、`test/adapters-marker.test.mjs`）
- [x] T082 [US3] 重载后的 follow-up 文案由 `HOST_CAPABILITIES` 派生，删除 `src/core/update.mjs` 中硬编码的 “Restart DSH”，并按 DSH/Claude/Codex/Cursor 分别断言（`src/core/update.mjs`、`src/core/host-capabilities.mjs`、`test/reload.test.mjs`）
- [x] T083 [US3] 让扩展命令变更进入生产链路：`components`→`changedLayers`→`decideReload` 覆盖 `extension_command` 层，并验证三态结论（`src/core/update.mjs`、`src/core/action.mjs`、`src/core/reload.mjs`、`test/reload.test.mjs`）
- [x] T084 [US3] 历史标记判定改为相对于本次运行/会话基线（或记录 run/session 标识），替代固定 24h 墙钟；补“跨天仍为本次”“23 小时前历史残留”两类测试（`src/core/doctor.mjs`、`src/core/marker.mjs`、`test/doctor.test.mjs`、`test/marker.test.mjs`）
- [x] T085 [US5] Claude 缺插件判据改为上游扩展命令/纪律技能命名（如 `speckit-superpowers-hooks-*` 与官方纪律技能名），不得用 `/sdd-(setup|update)/`；补已装/未装两种测试（`src/adapters/claude/index.mjs`、`test/adapters-claude.test.mjs`）
- [x] T086 [US6] 为 `applyCodexGuidance`/`applyCursorGuidance` 增加实际启动接线（CLI 子命令或各端 session 入口），幂等写托管块/规则文件；同步 `docs/adapters/codex.md`、`docs/adapters/cursor.md` 与真实渠道一致并补端到端测试（`src/adapters/codex/index.mjs`、`src/adapters/cursor/index.mjs`、`bin/sdd-kit.mjs`、`docs/adapters/codex.md`、`docs/adapters/cursor.md`、`test/adapters-codex.test.mjs`、`test/adapters-cursor.test.mjs`）
- [x] T087 [US5] 把 Claude 托管块标记与技能判定下沉到 `HOST_CAPABILITIES`/核心，适配器只做 IO；补“适配器无业务判定”约束测试与 ≤100 行断言（`src/adapters/claude/index.mjs`、`src/core/host-capabilities.mjs`、`test/host-capabilities.test.mjs`、`test/adapters-claude.test.mjs`）

### P2：契约与回归

- [x] T088 [US1] 把 CLI/宿主工具同构断言扩展到 `update`/`bridge`/`doctor`，并处理不可达参数：`--action` 要么实现要么拒绝，`upgrade/switch-integration/use-skills/python/superpowers-dir/repoUrl/extension-dir` 要么接到 `setup`/`upstream` 要么删除；补测试（`bin/sdd-kit.mjs`、`test/contract-parity.test.mjs`、`src/core/action.mjs`）
- [x] T089 [US7] CI 矩阵补 `pull_request`（必要时 `push`）触发；`pinned-mirror` 的镜像目录必须真正用于 `specify init`/doctor/verify；doctor 冒烟传 `--host "$HOST_KEY"`；补 workflow 静态断言（`.github/workflows/upstream-integration.yml`、`test/ci-matrix.test.mjs`）
- [x] T090 [US7] CI 门禁断言扩展安装后 `COMMAND_SKILLS`/`EXTENSION_STATE`/`TEMPLATE_*` 子项为 `pass`，不得只看区级 `pass`；`scripts/verify-upstream.mjs` 对 `not_executed` 返回非零，并在报告中加入“需调整的版本下界”字段（`.github/workflows/upstream-integration.yml`、`scripts/verify-upstream.mjs`、`test/ci-matrix.test.mjs`）
- [x] T091 [US7] 在具备宿主运行时的环境实测并写入 peer 依赖下界，让版本下界/预发布用例在默认 CI 或常态脚本执行，不只依赖 `DSH_SDD_KIT_INTEGRATION` 手工开关；记录预发布判定结论（`package.json`、`test/compat.test.mjs`、`.github/workflows/upstream-integration.yml`）
- [x] T092 [US8] 把 M1–M4 前置最小验证与止损线做成可执行门槛（脚本或 CI gate），前置失败时阻断后续里程碑并落到预设降级，而不只是文档表；补门槛测试（`docs/adapters/stop-loss.md`、`scripts/`、`.github/workflows/upstream-integration.yml`、`test/`）
- [x] T093 [US4] `src/core/feature-phase.mjs` 在 tasks.md 存在但零勾选且无 plan.md 时继续按 `spec.md→specify` 回落，与 data-model 的判定顺序一致；补测试（`src/core/feature-phase.mjs`、`test/feature-phase.test.mjs`）
- [x] T094 [US7] 触发打分改用码点比较，name/provider 同分时再以 path/source 作最终稳定键；excluded 技能语义与 data-model 对齐并补确定性用例（`src/core/trigger.mjs`、`test/trigger.test.mjs`、`specs/004-multihost-runtime-governance/data-model.md`）
- [x] T095 [US7] 刷新本仓库的扩展安装态并在体检中验证：`.specify` 下重新安装 `spec-kit-extension` 后确认六个钩子、`session_start` 与 `guard`/`guidance` 命令落盘，记录安装前后证据（`.specify/`、`spec-kit-extension/extension.yml`、`quickstart.md`）

**Checkpoint**：T067–T079 完成后重跑 P0 回归；T080–T087 完成后重跑重载/适配器测试；T088–T095 完成后执行全量 `npm test`、`npm run test:contract`、`npm run test:adapters` 与真实 `doctor` 冒烟。

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup（Phase 1）**：无依赖，可立即开始
- **Foundational（Phase 2）**：依赖 Setup 完成，**阻塞全部用户故事**
- **User Stories（Phase 3–10）**：均依赖 Foundational 完成
  - US1（P1）是 MVP，建议先完成
  - US2 与 US3 共享 M2 里程碑，可并行（不同文件）
  - US4 依赖 US2（`guidance` 子命令）与 US3（标记语义）
  - US5 依赖 US4（扩展 events 声明）
  - US6 依赖 US1（CLI 工具面）与 US2（引导拼装）
  - US7 依赖 US1（CLI）、US3（标记读取）、US6（四端能力）
  - US8 贯穿，其记录任务在对应里程碑完成时执行
- **Polish（Phase 11）**：依赖全部目标故事完成

### User Story Dependencies

- **US1（P1）**：Foundational 后即可开始，无其他故事依赖 → **MVP**
- **US2（P1）**：仅依赖 Foundational；与 US3 并行安全
- **US3（P1）**：仅依赖 Foundational；与 US2 并行安全
- **US4（P2）**：依赖 US2（`guidance` 子命令存在）与 US3（标记语义）
- **US5（P2）**：依赖 US4（`events.session_start` 声明）
- **US6（P3）**：依赖 US1 + US2
- **US7（P3）**：依赖 US1 + US3 + US6
- **US8（P1 贯穿）**：各记录任务绑定对应里程碑，`boundary` 测试可独立先行

### Within Each User Story

- 测试任务 MUST 先写、先观察失败，再写实现（章程 III）
- 核心模块先于适配器；适配器先于 CLI 子命令接线
- 故事完成并通过其 Independent Test 后才进入下一优先级

### Parallel Opportunities

- Phase 1 的 T002、T003 可并行
- Phase 2 的 T004、T006、T007 可并行（不同测试文件）
- US1 的 T009、T010 可并行；T013 与 T011 之后可并行
- US2 的 T017、T018 可并行；T022 与 T019–T021 可并行
- US3 的 T024、T025 可并行
- US4 的 T030、T031 可并行；T035 与 T034 不同段落但同文件，需串行
- US6 的 T041、T042 可并行；T043、T044 可并行（不同文件）
- US7 的 T046、T047 可并行；T049–T052 同文件需串行；T055 独立可并行
- Polish 的 T062、T063、T065 可并行

---

## Parallel Example: User Story 2

```bash
# 先并行写完两个失败测试：
Task: "写 test/guidance.test.mjs（三段内容/预算/裁剪/开关/一致性）"
Task: "写 test/adapters.test.mjs（服务缺失不阻断加载）"

# 再并行推进实现与适配接线（不同文件）：
Task: "实现 src/core/guidance.mjs 的 assembleGuidance"
Task: "实现 src/adapters/dsh/index.mjs 的 systemPrompt 常驻段"
```

## Parallel Example: User Story 6

```bash
Task: "写 test/adapters-codex.test.mjs"
Task: "写 test/adapters-cursor.test.mjs"
# 测试失败后并行实现：
Task: "实现 src/adapters/codex/index.mjs（托管块幂等）"
Task: "实现 src/adapters/cursor/index.mjs（规则目录 + trust 告警）"
```

---

## Implementation Strategy

### MVP First（仅 US1）

1. 完成 Phase 1 Setup
2. 完成 Phase 2 Foundational（**阻塞全部故事**）
3. 完成 Phase 3 US1
4. **STOP and VALIDATE**：`npm test` 全绿 + CLI 独立运行 + DSH 行为 100% 回归
5. 可发布 v0.6.0

### Incremental Delivery

1. Setup + Foundational → 基座就绪
2. US1 → 验证 → 发布 v0.6.0（MVP）
3. US2 + US3 → 验证 → 发布 v0.7.0（引导 + 重载）
4. US4 + US5 → 验证 → 发布 v0.8.0（护栏 + 首个外部端）
5. US6 + US7 → 验证 → 发布 v0.9.0+（四端收官 + 体检 + CI 矩阵）
6. US8 的记录任务随各里程碑完成；Polish 收尾

### 止损与降级

- M1：若核心抽离导致既有用例无法保持全绿 → 停止抽离，改为在原文件内增量补函数
- M2：若打包形态 `ctx.systemPrompt` 不可达 → 降级为安装期固定注入并记录（不阻断 M3）
- M3：若 Claude events 通道不可用 → 降级为项目级托管块（REQ-44 预设处置）
- M4：若单端维护成本拖慢整体 → 冻结第四端，只交付三端

---

## 需求与验收覆盖索引

> 46 条 REQ 与 23 条 AC 逐条对应到任务，供 T064 的全量覆盖校验使用。

| REQ | 任务 | REQ | 任务 | REQ | 任务 |
|-----|------|-----|------|-----|------|
| REQ-01 | T004, T011 | REQ-17 | T025, T027 | REQ-33 | T046, T048 |
| REQ-02 | T004 | REQ-18 | T025, T028 | REQ-34 | T049 |
| REQ-03 | T005, T038, T043, T044 | REQ-19 | T025, T052 | REQ-35 | T050 |
| REQ-04 | T005, T040, T045, T063 | REQ-20 | T024, T026 | REQ-36 | T051 |
| REQ-05 | T008, T013, T054 | REQ-21 | T010, T014, T015 | REQ-37 | T052 |
| REQ-06 | T005, T043, T044 | REQ-22 | T034, T036 | REQ-38 | T047, T053 |
| REQ-07 | T006, T037, T041, T042 | REQ-23 | T030, T032, T033, T034 | REQ-39 | T046, T048 |
| REQ-08 | T017, T019 | REQ-24 | T031, T034 | REQ-40 | T055 |
| REQ-09 | T017, T020 | REQ-25 | T036 | REQ-41 | T056 |
| REQ-10 | T017, T022, T023 | REQ-26 | T035, T037, T038, T040 | REQ-42 | T056 |
| REQ-11 | T016, T017, T018, T022 | REQ-27 | T039 | REQ-43 | T058, T059, T060 |
| REQ-12 | T017, T021 | REQ-28 | T037 | REQ-44 | T061 |
| REQ-13 | T017, T019 | REQ-29 | T041, T043 | REQ-45 | T009, T012 |
| REQ-14 | T007, T011, T013 | REQ-30 | T042, T044 | REQ-46 | T057, T064 |
| REQ-15 | T024, T026, T029 | REQ-31 | T042, T044, T050 | | |
| REQ-16 | T024, T026 | REQ-32 | T041, T042 | | |

| AC | 任务 | AC | 任务 |
|----|------|----|------|
| AC-01 | T004 | AC-13 | T030, T032 |
| AC-02 | T006 | AC-14 | T031 |
| AC-03 | T007, T008 | AC-15 | T037, T039 |
| AC-04 | T005, T006 | AC-16 | T041, T042, T043, T044 |
| AC-05 | T017, T019, T022 | AC-17 | T042, T044, T050 |
| AC-06 | T017, T020 | AC-18 | T046, T048–T052 |
| AC-07 | T017, T018, T049 | AC-19 | T047, T050, T053 |
| AC-08 | T017, T021 | AC-20 | T055, T056 |
| AC-09 | T024, T026 | AC-21 | T058, T059, T061 |
| AC-10 | T025, T027, T028, T052 | AC-22 | T009 |
| AC-11 | T010, T014, T015 | AC-23 | T057 |
| AC-12 | T034, T036 | | |

---

## Notes

- [P] = 不同文件、无未完成依赖，可并行
- [Story] 标签映射到 spec.md §2 的 REQ 分组，便于追溯
- 每个用户故事 MUST 可独立完成与独立验证
- 实现前 MUST 先看到测试失败
- 每任务一次原子提交（章程 IV），提交信息标明实现的任务编号
- 勾选任务前 `npm test` MUST 全绿（章程 III）
- 避免：含糊任务、同文件冲突、破坏故事独立性的跨故事依赖

---

## Phase 13: Convergence（终轮规格差距收敛）

- [x] T096 [US7] 按章程 VI 将 `src/core/doctor.mjs` 与 `bin/sdd-kit.mjs` 中新增的面向用户 `message`/`fix` 英文散文完整中文化；命令、路径、字段名、上游原文引用与模板固定标题保留原文，并补一条测试防止未豁免英文说明回流（`src/core/doctor.mjs`, `bin/sdd-kit.mjs`, `test/doctor.test.mjs`, `test/contract-parity.test.mjs`）per Constitution VI (contradicts)
- [x] T097 [US1] 将 core 中残留的 `DSH_*` 环境/路径解析与 `host='dsh'`、`EXPECTED_INTEGRATION='dsh'` 默认值下沉到 `src/adapters/dsh/` 或 `HOST_CAPABILITIES`，core 只接受注入参数；删除 `test/contract-core-purity.test.mjs` 的 `LEGACY_HOST_REFERENCES`，保留注入违规即红的静态自证（`src/core/candidates.mjs`, `src/core/guidance.mjs`, `src/core/upstream.mjs`, `src/core/doctor.mjs`, `src/adapters/dsh/index.mjs`, `test/contract-core-purity.test.mjs`）per REQ-01/REQ-02/AC-01/T079 (partial)
- [x] T098 [US7] 让 `findOnPath` 平台感知：POSIX 继续精确名探测，Windows 追加 `PATHEXT`/`.exe`/`.cmd`/`.ps1` 候选；补 Windows-shaped PATH 回归证明已安装工具不被误报缺失且零写不变（`src/core/doctor.mjs`, `test/doctor.test.mjs`）per REQ-34/AC-18/T074 (partial)
- [x] T099 [US7] 让 `scripts/verify-upstream.mjs` 自身对 `not_executed` 与 `versionDrift.needsAdjustment` 返回非零退出码，CI gate 继续二次拦截；同步修订 `INV-23` 测试并补进程级退出码断言（`scripts/verify-upstream.mjs`, `test/sdd-kit.test.mjs`, `test/ci-matrix.test.mjs`）per T090/REQ-41 (partial)
- [x] T100 [US7] 在具备宿主运行时的环境实测三项 peer 依赖下界并写入 `package.json`，把版本下界与预发布用例移入常态 CI/脚本而非仅靠 `DSH_SDD_KIT_INTEGRATION`，同步 `stop-loss.md` 的 M4 记录（`package.json`, `test/compat.test.mjs`, `.github/workflows/upstream-integration.yml`, `docs/adapters/stop-loss.md`）per REQ-21/AC-11/T091 (partial)
- [x] T101 [US4] 让规划期护栏拦截响应显式提示“先回到定义阶段”，同步 `extension.yml` 钩子描述与命令文档，补精确文案断言；保持只读、不写状态文件、判定仍为当前 feature 的 `tasks.md` 有勾选任务（`src/core/guard.mjs`, `spec-kit-extension/extension.yml`, `spec-kit-extension/commands/speckit.superpowers-hooks.guard.md`, `test/guard.test.mjs`）per REQ-23/AC-13/T033 (contradicts)
