---

description: "Task list for Spec Kit 原生扩展钩子层（Hooks 取代 /sdd-implement）"
---

# Tasks: Spec Kit 原生扩展钩子层（Hooks 取代 `/sdd-implement`）

**Input**: Design documents from `/specs/002-spec-kit-extension-hooks/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)、[research.md](./research.md)、[data-model.md](./data-model.md)、[contracts/](./contracts/)、[quickstart.md](./quickstart.md)

**Tests**: 本特性**必须**先写失败测试——章程原则 III「严格 TDD 不可协商」明确要求 `npm test` 在任务标记完成前通过，且 plan 的 Constitution Check 已把「契约 §6 测试先行清单」列为交付前提。所有测试落在既有单文件套件 `test/sdd-kit.test.mjs`。

**Organization**: 任务按用户故事分组，每个故事可独立实现与独立验证。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、无未完成依赖）
- **[Story]**: 所属用户故事（US1…US5）
- 每条任务含精确文件路径

## Path Conventions

单仓库 DSH 插件：`src/`、`skills/`、`test/`、`spec-kit-extension/` 均在仓库根（见 [plan.md](./plan.md) 的 Project Structure）。

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 建立扩展源目录骨架，并让它在发布与 profile 复制两条链路上都不丢失。

- [x] T001 创建扩展源目录骨架 `spec-kit-extension/` 与 `spec-kit-extension/commands/`（空目录即可，`.gitkeep` 不留）
- [x] T002 [P] 在 `package.json` 的 `files` 数组追加 `"spec-kit-extension/"`（否则 npm 包不含扩展源，`--dev` 安装必失败）
- [x] T003 [P] 在 `src/core/kit-copy.mjs:6` 的 `KIT_ALLOWLIST` 追加 `'spec-kit-extension'`（否则 `update_all` 复制到 profile 时扩展源丢失，`/sdd-setup` 在 profile 副本里找不到源目录）

- [x] T004 [P] 在 `test/sdd-kit.test.mjs` 新增发布白名单测试：断言 `package.json` 的 `files` 与 `src/core/kit-copy.mjs` 的 `KIT_ALLOWLIST` 都包含 `spec-kit-extension`（缺一即导致 npm 包或 profile 副本丢失扩展源，research R10）；同时断言 `seedKitSource` 里写死的 `files` 数组也含该项

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 扩展清单 + 唯一安装动作 + 工具参数暴露。**任何用户故事都不能在 Phase 2 完成前实现**——没有清单就没有 `hooks:` 声明，没有 `install_hooks_ext` 就无法把扩展装进项目。

**⚠️ CRITICAL**: 本阶段完成前，Phase 3+ 的任何任务都无法端到端验证。

- [x] T005 编写扩展清单 `spec-kit-extension/extension.yml`：`schema_version`、`extension.id`、`extension.name`、`extension.description`、`extension.author`、`extension.version`、`requires.speckit_version`、`provides.commands`（4 条，`name` + `file`）、`hooks`（4 个事件），字段取值与约束见 `data-model.md` 的 `E1.schema_version`、`E1.extension.id`、`E1.extension.name`、`E1.extension.description`、`E1.extension.author`、`E1.extension.version`、`E1.requires.speckit_version`、`E1.provides.commands`、`E1.hooks`；不得出现 `events:`、`templates:`、`scripts:`、`settings:`（`data-model.md` 的 INV-1/INV-2/INV-3）
- [x] T006 [P] 在 `test/sdd-kit.test.mjs` 新增清单结构测试：文本断言 `schema_version: "1.0"`、`id: superpowers-hooks`、`version: 0.1.0`、`requires.speckit_version` 非空、`provides.commands` 恰 4 条、`hooks` 恰 4 个事件键、无 `events:` 键；并断言每个钩子条目声明了 `optional: false`（`data-model.md` 的 `E1.schema_version`、`E1.extension.id`、`E1.extension.version`、`E1.requires.speckit_version`、`E1.provides.commands`、`E1.hooks` 与 INV-1/INV-2/INV-3；不引入 YAML 解析依赖，见 research R8）
- [x] T007 在 `src/core/upstream.mjs` 新增 `install_hooks_ext` 动作：解析扩展源目录（`args.extensionDir` → 包根 `spec-kit-extension/`，不存在则返回 `ok: false` + `error: 'extension source not found at <path>'`），**一次且仅一次**调用 `runner('specify', ['extension', 'add', '--dev', dir, '--force'], { cwd })`，返回 `data-model.md` 的 `E4.action`、`E4.cwd`、`E4.extensionDir`、`E4.command`、`E4.ok`、`E4.code`、`E4.stdout`、`E4.stderr`、`E4.extension.id`、`E4.extension.version`、`E4.hooks`、`E4.restartRequired`；失败不抛异常（契约 [sdd-upstream-install-hooks-ext.md](./contracts/sdd-upstream-install-hooks-ext.md) §2/§4）
- [x] T008 [P] 在 `test/sdd-kit.test.mjs` 新增 `install_hooks_ext` 单测：注入假 `runner` 断言 argv 精确为 `['extension','add','--dev',<dir>,'--force']`（`--dev` 必需，research R1）、源目录不存在时 `runner` 调用计数为 0、返回字段齐全且 `hooks` 顺序固定为 `before_implement → after_implement → before_bug_fix → after_bug_fix`（`data-model.md` 的 `E4.hooks` 与 INV-11）、`restartRequired` 语义（INV-13）
- [x] T009 在 `src/register.mjs` 的 `sdd_upstream` 工具描述字符串与参数表中加入 `install_hooks_ext` 与 `extensionDir`（描述字符串形如 `'One of: status, sync_superpowers, specify_upgrade, specify_init, install_bug_ext, install_hooks_ext, update_all.'`）

**Checkpoint**: 清单与安装动作就绪，可以开始各用户故事的钩子内容。

---

## Phase 3: User Story 1 - `/speckit.implement` 自动注入执行纪律（Priority: P1）🎯 MVP

**Goal**: 用户执行原生 `/speckit.implement` 时，写第一行代码前自动收到强制 TDD/根因调试纪律，完成后自动两阶段自审并衔接 `/speckit.converge`——全程无需改敲 `/sdd-implement`。

**Independent Test**: 只读 `spec-kit-extension/commands/speckit.superpowers-hooks.before-implement.md` 与 `...after-implement.md`，断言五段结构齐全、只出现技能名不出现纪律正文、含缺失处理句、含 `__SPECKIT_COMMAND_CONVERGE__` 占位符；再在已装扩展的临时项目上执行 `/speckit.implement`，观察 `**Automatic Hook**` 块与 `EXECUTE_COMMAND_INVOCATION: /speckit-superpowers-hooks-before-implement`。

### Tests for User Story 1

- [x] T010 [P] [US1] 在 `test/sdd-kit.test.mjs` 新增 US1 命令文件测试：断言两个文件存在、frontmatter 仅有非空 `description`、含 `## 何时触发`/`## 上游依赖检查`/`## 必须加载的技能`/`## 执行纪律`/`## 出口条件` 五段（`data-model.md` 的 `E2` 文件结构与 INV-5）、正文出现 `test-driven-development` 与 `systematic-debugging` 技能名（`E2.command` 中 `before-implement` 行）、正文不含上游纪律正文副本（INV-4）、`after-implement.md` 含 `__SPECKIT_COMMAND_CONVERGE__` 占位符（INV-6，禁止硬写 `/speckit.converge`）、每文件 ≤ 60 行

### Implementation for User Story 1

- [x] T011 [US1] 编写 `spec-kit-extension/commands/speckit.superpowers-hooks.before-implement.md`：五段结构；按名称引用 `test-driven-development`（Red→Green→Refactor）与 `systematic-debugging`（非预期失败先定根因）；出口条件为「所选任务测试红→绿 + `npm test` 通过 + 已产生一次原子提交」；禁止一次实现多任务/跳过红阶段/未过测试即勾选任务（契约 [hook-commands.md](./contracts/hook-commands.md) §3.1）
- [x] T012 [US1] 编写 `spec-kit-extension/commands/speckit.superpowers-hooks.after-implement.md`：五段结构；按名称引用 `verification-before-completion` 与 `requesting-code-review`；两阶段自审（阶段一对照 `spec.md` 的 REQ/AC，阶段二对照章程的 TDD/原子提交/零新增依赖/零分叉），每阶段产出「通过/不通过 + 证据」；自审通过后衔接 `__SPECKIT_COMMAND_CONVERGE__`（契约 §3.2）

**Checkpoint**: US1 独立可验证——两个文件的内容断言全绿，且装到临时项目后 `/speckit.implement` 会渲染出强制预钩子。

---

## Phase 4: User Story 2 - `/speckit-bug-fix` 自动注入调试与 TDD 纪律（Priority: P2）

**Goal**: 用户执行原生 `/speckit-bug-fix` 时，改源码前自动收到系统化调试与严格 TDD 纪律，完成后自动两阶段自审并衔接 `/speckit-bug-test`。

**Independent Test**: 只读 `spec-kit-extension/commands/speckit.superpowers-hooks.before-bug-fix.md` 与 `...after-bug-fix.md`，断言与 US1 同构（五段结构、只引用技能名、含缺失处理句），且后钩子含 `__SPECKIT_COMMAND_BUG_TEST__` 占位符；再执行 `/speckit-bug-fix slug=<slug>` 观察强制预钩子在源码修改前渲染。

### Tests for User Story 2

- [x] T013 [P] [US2] 在 `test/sdd-kit.test.mjs` 新增 US2 命令文件测试：断言两文件存在且五段齐全（`data-model.md` 的 `E2` 文件结构与 INV-5）、正文出现 `systematic-debugging` 与 `test-driven-development`（`E2.command` 中 `before-bug-fix` 行）、不含纪律正文副本（INV-4）、`after-bug-fix.md` 含 `__SPECKIT_COMMAND_BUG_TEST__` 占位符（INV-6）、每文件 ≤ 60 行

### Implementation for User Story 2

- [x] T014 [US2] 编写 `spec-kit-extension/commands/speckit.superpowers-hooks.before-bug-fix.md`：五段结构；按名称引用 `systematic-debugging`（先复现、再定根因、禁止猜测式修补）与 `test-driven-development`（先写能复现缺陷的失败测试）；出口条件为「失败测试先红、修复后转绿」；禁止在未复现缺陷前改源码（契约 [hook-commands.md](./contracts/hook-commands.md) §3.3）
- [x] T015 [US2] 编写 `spec-kit-extension/commands/speckit.superpowers-hooks.after-bug-fix.md`：五段结构；按名称引用 `verification-before-completion` 与 `requesting-code-review`；两阶段自审（阶段一对照评估报告的修复方案与 AC，阶段二对照章程纪律）；自审通过后衔接 `__SPECKIT_COMMAND_BUG_TEST__`（契约 §3.4）

**Checkpoint**: US1 与 US2 均独立可验证，四个命令文件与清单的 `provides.commands` 构成双射（`data-model.md` 的 INV-1）。

---

## Phase 5: User Story 3 - 一次 `/sdd-setup` 完成安装并如实报告（Priority: P3）

**Goal**: 空项目运行一次 `/sdd-setup` 即以 `integration=dsh` 初始化并装好扩展，技能落在 DSH 原生根 `.dsh/skills`；既有 `claude` 项目只收到不一致提示与显式切换命令，布局不被改写。

**Independent Test**: 在无 `.specify/` 的临时目录跑 `/sdd-setup` 的等价步骤（`specify init --integration dsh` → `install_hooks_ext`），断言 `.dsh/skills/speckit-superpowers-hooks-*` 存在、`.claude/` 未创建、`.specify/extensions.yml` 四事件各 1 条；再在 `integration=claude` 的项目上跑，断言输出含 `specify integration switch dsh` 且 `.claude/` 内容未变。

### Tests for User Story 3

- [x] T016 [P] [US3] 在 `test/sdd-kit.test.mjs` 新增 `specify_init` 默认值测试：假 `runner` 断言默认 argv 含 `--integration dsh`（且 `--non-interactive --force --ignore-agent-tools` 三参数仍在，章程原则 V），显式传 `integration: 'claude'` 时覆盖为 `claude`
- [x] T017 [P] [US3] 在 `test/sdd-kit.test.mjs` 新增安装报告推导测试：断言 `integration: 'dsh'` 时 `skillsDir === '.dsh/skills'` 且 `skillsDirInDshRoots === true`、`integrationMismatch === null`；`integration: 'claude'` 时 `skillsDir === '.claude/skills'`、`skillsDirInDshRoots === false`、`integrationMismatch.switchCommand === 'specify integration switch dsh'`（`data-model.md` 的 `E4.integration`、`E4.skillsDir`、`E4.skillsDirInDshRoots`、`E4.integrationMismatch` 与 INV-12/INV-12b）
- [x] T018 [US3] 在 `src/core/upstream.mjs` 把 `specify_init` 的 `integration` 默认值从 `'claude'` 改为 `'dsh'`，并保留 `args.integration` 覆盖（REQ-14；既有 `hasSpecifyDir === false` 门控不动，REQ-15）
- [x] T019 [US3] 在 `src/core/upstream.mjs` 的 `install_hooks_ext` 补推导字段：读 `.specify/init-options.json` 的 `integration`（读失败回退 `'dsh'`），据此填 `skillsDir`（`dsh` → `.dsh/skills`、`claude` → `.claude/skills`、其余回退 `.dsh/skills` 并置 `skillsDirGuessed: true`）、`skillsDirInDshRoots`、`integrationMismatch`（`data-model.md` 的 `E4.skillsDirGuessed`、`E4.skillsDirInDshRoots`、`E4.integrationMismatch` 与 INV-12/INV-12b）
- [x] T020 [US3] 改写 `skills/sdd-setup/SKILL.md` 工作流为七步：第 4 步标注 `specify_init` 仅当 `hasSpecifyDir === false`；第 5 步新增 `sdd_upstream(action: "install_hooks_ext")`；第 7 步汇总必须含扩展版本、四钩子事件、`integration`、落盘目录、重启提示；`integrationMismatch !== null` 时追加不一致警告段（含 `specify integration switch dsh` 与影响范围），并明令不得自行切换（REQ-15，契约 §5）
- [x] T021 [US3] 在 `test/sdd-kit.test.mjs` 新增 `sdd-setup` 技能内容测试：断言 `install_hooks_ext` 恰出现 1 次、含 `hasSpecifyDir` 门控措辞、含 `specify integration switch dsh`、含 `integrationMismatch`
- [x] T022 [US3] 在 `test/sdd-kit.test.mjs` 新增端到端安装测试（`specify` CLI 不可用时 `t.skip`，不 mock）：临时目录 `specify init --integration dsh` → 真实 `install_hooks_ext` → 断言 `.dsh/skills/speckit-superpowers-hooks-*` 存在、`.claude/` 未创建、`.specify/extensions.yml` 四事件各 1 条且条目字段符合 `data-model.md` 的 `E3.extension`、`E3.command`、`E3.enabled`、`E3.optional`（必须为 `false`）、`E3.priority`（前置 5 / 后置 15）、`E3.prompt`、`E3.condition`（必须为 `null`）（AC-01/AC-12）

**Checkpoint**: US1+US2+US3 合起来满足「装一次 → 原生命令自动带纪律」的完整闭环。

---

## Phase 6: User Story 4 - `/sdd-implement` 从所有推荐流程消失（Priority: P4）

**Goal**: 仓库里不再存在第二执行入口；章程、README、挂载注释与测试断言同步降到两个技能。

**Independent Test**: `grep -rn "sdd-implement" README.md skills/ cordis.patch.yml .specify/memory/constitution.md` 无命中（历史迁移说明除外）；`skills/` 只有 `sdd-setup`、`sdd-update`；`npm test` 中技能数量断言为 2。

### Tests for User Story 4

- [x] T023 [P] [US4] 修改 `test/sdd-kit.test.mjs:183-189` 的技能断言：测试名改为「skills/ contains exactly 2 user-only bridge skills…」，`assert.deepEqual(dirs, ['sdd-setup', 'sdd-update'])`，并保留逐技能 frontmatter 断言（`name`/`description`/`disable-model-invocation: true`）
- [x] T024 [P] [US4] 在 `test/sdd-kit.test.mjs` 新增全仓引用测试：断言 `README.md`、`skills/**`、`cordis.patch.yml` 中不含 `sdd-implement`（章程文件允许在「迁移说明」段落提及，测试只断言 `README.md`/`skills/`/`cordis.patch.yml` 三处，AC-05）

### Implementation for User Story 4

- [x] T025 [US4] 删除整个 `skills/sdd-implement/` 目录（REQ-05：不保留废弃提示页，不留并行执行路径）
- [x] T026 [P] [US4] 更新 `cordis.patch.yml` 注释：把「3 个桥接技能（/sdd-setup、/sdd-implement、/sdd-update）」改为「2 个桥接技能（/sdd-setup、/sdd-update）」并补一句「执行纪律由 Spec Kit 原生扩展钩子注入」
- [x] T027 [P] [US4] 更新 `README.md`：开头「3 个技能」改「2 个技能」；第 43 行「用 `/sdd-implement` 执行…」与第 46 行「用 `/sdd-implement bug=<slug>`…」改写为原生命令 + 钩子说明（`/speckit.implement` 自动注入 TDD、`/speckit-bug-fix` 自动衔接 `/speckit-bug-test`）；补一句「Runtime Events 硬门禁为未来可选升级口」
- [x] T028 [US4] 更新 `.specify/memory/constitution.md` 至 v3.0.0：原则 I 技能上限「三个」→「两个（`sdd-setup`、`sdd-update`）」；开发流程段「使用 `/sdd-implement`，遵循 TDD…」→「使用原生 `/speckit.implement`，执行纪律由扩展钩子注入」；「`/sdd-implement bug=<slug>` → `/speckit-bug-test`」→「`/speckit-bug-fix` → `/speckit-bug-test`」；治理段记录版本变更理由（AC-05）

**Checkpoint**: 全仓只有一个执行入口，`npm test` 与 grep 双双证明。

---

## Phase 7: User Story 5 - 幂等重装、禁用与卸载回滚（Priority: P5）

**Goal**: 重复 `/sdd-setup` 不产生重复或孤儿条目；卸载后原生命令回到无钩子原始行为；`settings.auto_execute_hooks` 全程不变。

**Independent Test**: 连跑两次 `install_hooks_ext` 后 `.specify/extensions.yml` 每事件仍 1 条、`installed` 不重复；`specify extension remove superpowers-hooks --force` 后回落为 `installed: []` / `hooks: {}`，`.dsh/skills/speckit-superpowers-hooks-*` 消失。

### Tests for User Story 5

- [x] T029 [P] [US5] 在 `test/sdd-kit.test.mjs` 新增幂等测试（CLI 可用时，否则 `t.skip`）：连跑两次 `install_hooks_ext` → 四事件各 1 条、`installed` 恰 1 项、无孤儿事件键（`data-model.md` 的 INV-7/INV-8/INV-10，AC-07）
- [x] T030 [P] [US5] 在 `test/sdd-kit.test.mjs` 新增卸载测试（CLI 可用时，否则 `t.skip`）：`specify extension remove superpowers-hooks --force` → `installed` 不含本扩展、`hooks` 无本扩展条目、技能目录被删除、`.specify/extensions/.backup/superpowers-hooks/` 存在（`data-model.md` 的 INV-8，AC-10/REQ-12）
- [x] T031 [US5] 在 `test/sdd-kit.test.mjs` 新增全局开关与模板不变测试：安装前后 `.specify/extensions.yml` 的 `settings.auto_execute_hooks` 取值相同（`data-model.md` 的 INV-9，REQ-13/AC-09）；`.specify/templates/` 与 `.specify/scripts/` 的树快照前后一致（复用既有 `snapshotTree` helper，AC-08/REQ-07）

**Checkpoint**: 五个用户故事全部独立可验证，安装/重装/卸载三条生命周期闭合。

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: 交付前的一致性核对与文档校验。

- [ ] T032 [P] 核对 `specs/002-spec-kit-extension-hooks/quickstart.md` 的命令与实测行为一致（尤其 `specify extension list` 的 `Commands: 4 | Hooks: 4`、`remove --force`、`integration switch` 影响范围）
- [ ] T033 [P] 核对 `specs/002-spec-kit-extension-hooks/data-model.md` 的 INV-1…INV-13 与 `test/sdd-kit.test.mjs` 的断言一一对应，无遗漏不变量
- [ ] T034 全量回归：`npm test` 必须全绿（章程原则 III），并确认 `node --test test/sdd-kit.test.mjs` 无 `t.skip` 之外的跳过
- [ ] T035 手工走一遍 [quickstart.md](./quickstart.md) 的「一次性安装 → 四视角验证 → 幂等 → 回滚」四段，记录实际输出
- [ ] T036 更新 `specs/INDEX.md`（通过 `sdd_bridge(action: "sync_index")`），确认 `002-spec-kit-extension-hooks` 行状态正确

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 无依赖，可立即开始
- **Foundational (Phase 2)**: 依赖 Setup 完成；**阻塞全部用户故事**
- **User Stories (Phase 3–7)**: 均依赖 Foundational
  - US1 与 US2 可并行（各自两个命令文件，互不重叠）
  - US3 的端到端安装（T022）需 US1+US2 的四个命令文件齐备（清单已声明 4 条命令，缺文件时 CLI 安装失败）
  - US4 与 US5 相互独立，但与 US3 共享 `test/sdd-kit.test.mjs`，不宜并行编辑
- **Polish (Phase 8)**: 依赖全部目标故事完成

### User Story Dependencies

- **US1 (P1)**: Foundational 后即可，无其它故事依赖 —— **MVP**
- **US2 (P2)**: Foundational 后即可，与 US1 并行无冲突（不同文件）
- **US3 (P3)**: Foundational 后即可开工；其端到端任务 T022 需 US1+US2 完成
- **US4 (P4)**: 独立；但与 US3 同改 `test/sdd-kit.test.mjs`，建议串行
- **US5 (P5)**: 独立；同样与 US3/US4 共享测试文件

### Within Each User Story

- 测试任务在前，必须先看到失败（章程原则 III）
- 命令文件（US1/US2）之间无顺序依赖，但同一故事的测试任务先于实现任务
- 每个任务完成即 `git commit`（章程原则 IV，中文消息）

### Parallel Opportunities

- T002 / T003 可并行（不同文件）
- T006 / T008 可并行（同文件不同测试块，需注意追加位置，实际操作建议串行追加）
- T010 / T013 可并行（同文件，建议串行）
- T011 / T012 可并行（不同文件）；T014 / T015 可并行（不同文件）
- T016 / T017 可并行（不同测试块）
- T023 / T024、T026 / T027 可并行（不同文件）
- T029 / T030 / T031 可并行（不同测试块）
- T032 / T033 可并行（不同文档）

---

## Parallel Example: User Story 1 + User Story 2

```bash
# US1 与 US2 的命令文件互不重叠，可同时落地：
Task: "编写 spec-kit-extension/commands/speckit.superpowers-hooks.before-implement.md"
Task: "编写 spec-kit-extension/commands/speckit.superpowers-hooks.after-implement.md"
Task: "编写 spec-kit-extension/commands/speckit.superpowers-hooks.before-bug-fix.md"
Task: "编写 spec-kit-extension/commands/speckit.superpowers-hooks.after-bug-fix.md"
```

```bash
# US4 的文档面可并行：
Task: "更新 cordis.patch.yml 注释 3→2"
Task: "更新 README.md 日常流程为原生命令 + 钩子说明"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. 完成 Phase 1（Setup）
2. 完成 Phase 2（Foundational）——**关键**，没有清单与 `install_hooks_ext` 什么都验证不了
3. 完成 Phase 3（US1）
4. **STOP and VALIDATE**：在临时项目装扩展，执行 `/speckit.implement`，确认 `**Automatic Hook**` 块出现且 `EXECUTE_COMMAND_INVOCATION: /speckit-superpowers-hooks-before-implement`
5. 这一步已交付「特性实现自动注入 TDD」的核心价值

### Incremental Delivery

1. Setup + Foundational → 骨架就绪
2. + US1 → 特性实现带纪律（MVP）
3. + US2 → 缺陷修复带纪律（两个入口全覆盖）
4. + US3 → 一条命令装好、报告如实（可用性闭环）
5. + US4 → 旧入口彻底消失（目标「100% 原生命令」达成）
6. + US5 → 生命周期安全（可重装、可回滚）

### Notes

- 每个任务完成即原子 commit（章程原则 IV）；消息用中文
- `npm test` 未过不得勾选任务（章程原则 III）
- 四个命令文件是「Markdown + YAML frontmatter」而非代码，测试用文本/正则断言，不引入 YAML 依赖（research R8）
- 端到端测试必须直连真实 `specify` CLI，CLI 不可用时 `t.skip`，**不得** mock（spec §5）
