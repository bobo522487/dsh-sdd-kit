---

description: "Task list for the SDD unified update command feature"
---

# Tasks: SDD Unified Update Command

**Input**: Design documents from `/specs/001-sdd-update-command/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/sdd-update.contract.md, quickstart.md, `.specify/memory/constitution.md`

**Tests**: Included because the spec defines AC-01..AC-06 as automated acceptance criteria and the constitution requires strict Red → Green → Refactor (`constitution.md:36-42`).

**Organization**: One P1 user story (the spec contains a single user story at `spec.md:5-12`); tasks are grouped into Setup, Foundational, User Story 1, and Polish. Every task must be one atomic commit on the current branch (`constitution.md:44-49`).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Different files, no dependency on incomplete tasks
- **[Story]**: `[US1]` only inside the user-story phase
- Exact file paths appear in every description

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 在命令表面出现前完成治理状态核验与发布元数据更新。

- [x] T001 核验 [.specify/memory/constitution.md](.specify/memory/constitution.md) 已为 v2.1.0，且原则 I 明确允许三个命名技能（`sdd-setup`、`sdd-implement`、`sdd-update`）与两个 Host 工具（`sdd_upstream`、`sdd_bridge`），并包含 v2.0.0 迁移说明与中文优先原则 VI。本任务仅核验，不得重新修正或降级章程。
- [x] T002 [P] 更新发布元数据与注释：将 `package.json` 版本设为 `0.3.0`，更新 `cordis.patch.yml` 中的 `v0.2.0`/旧版双技能注释，并将 `README.md` 中的 `2 skills + 2 thin Host tools` 标语改为 `3 skills + 2 thin Host tools`。

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Command surface and module skeletons that block all user-story work.

**⚠️ CRITICAL**: No user-story implementation can begin until T001–T004 are complete.

- [x] T003 [P] Create `skills/sdd-update/SKILL.md` skeleton with frontmatter `name: sdd-update`, a one-line description, `disable-model-invocation: true`, and H1 `# /sdd-update`; leave the body as a TODO placeholder for T013 (no logic yet).
- [x] T004 [P] Add behavior-free skeletons in `src/core/update.mjs` and `src/core/kit-copy.mjs`: export `runUpdate(args = {}, deps = {})` and `refreshInstalledKit(args = {}, deps = {})` with named constants `COMPONENT_NAMES`, `OUTCOMES`, and `KIT_ALLOWLIST`; do not implement orchestration or copying yet.

**Checkpoint**: Governance permits the third skill; skill and core module shells exist. User-story work can begin.

---

## Phase 3: User Story 1 — Unified update with per-component report (Priority: P1) 🎯 MVP

**Goal**: As a DSH user, running `/sdd-update` checks Spec Kit, Superpowers and the installed dsh-sdd-kit in one invocation, brings each to its configured latest source, and prints one report with before/after identifiers, outcome, follow-up, overall status, and restart guidance — without touching project specs, plans, tasks or application source.

**Independent Test**: In a temp project, run the injected `runUpdate` suite in `test/sdd-kit.test.mjs` and a `/sdd-update` skill smoke check: exactly three component records appear in fixed order with before/after/outcome; a failed component does not suppress the other two; a no-side-effect snapshot of `specs/`, `.specify/`, `plan.md`, `tasks.md` and app source is byte-identical; restart guidance appears when the kit hash or Superpowers skills change.

**Tests for User Story 1 (RED first — do not implement behavior until these fail for the expected reason)** ⚠️

- [x] T005 [US1] Update exact-surface assertions in `test/sdd-kit.test.mjs`: expect skill directories `['sdd-implement','sdd-setup','sdd-update']`, keep the two-tool assertion `['sdd_upstream','sdd_bridge']`, and keep frontmatter validation for `disable-model-invocation: true`.
- [x] T006 [US1] Add failing AC-01/AC-02 tests to `test/sdd-kit.test.mjs` using the existing injected `runner` pattern: all-behind yields three `updated` records with before/after; all-current yields three `unchanged` records with no effective `uv tool upgrade|install` or `git pull|clone`.
- [x] T007 [US1] Add failing AC-03/AC-04 tests to `test/sdd-kit.test.mjs`: a mocked Superpowers `git pull` failure still produces Spec Kit and dsh-kit records, names Superpowers as failed, and sets overall `ok:false`; a missing `dshKitSourceDir` produces a clear dsh-kit error while upstream records remain.
- [x] T008 [US1] Add failing AC-05/AC-06 tests to `test/sdd-kit.test.mjs`: recursively snapshot `specs/`, `.specify/`, `plan.md`, `tasks.md` and `src/app.js` in a temp cwd before/after `runUpdate` and assert equality plus no `specify init` / `specify extension add bug` calls; assert `requiresRestart` and restart guidance when the kit tree hash changes.

**Implementation for User Story 1**

- [x] T009 [P] [US1] Implement the `runUpdate` orchestrator in `src/core/update.mjs`: resolve args/deps, await three independent component tasks with `Promise.allSettled`, normalize `ComponentUpdateRecord.component`, `ComponentUpdateRecord.before`, `ComponentUpdateRecord.after`, `ComponentUpdateRecord.outcome`, `ComponentUpdateRecord.followUp`, `ComponentUpdateRecord.error`, and assemble `UpdateReport.action`, `UpdateReport.ok`, `UpdateReport.components`, `UpdateReport.requiresRestart`, `UpdateReport.errors`, `UpdateReport.cwd` exactly as defined in `data-model.md`.
- [x] T010 [US1] 在 `src/core/update.mjs` 实现 Spec Kit 与 Superpowers 适配器：使用 `runUpstream` 的 `status`、`specify_upgrade`、`sync_superpowers` 动作；按 [data-model.md 的 `UpdateArgs`](specs/001-sdd-update-command/data-model.md#L72) 处理 `cwd`、`superpowersDir`、`repoUrl`、`python`；按 [data-model.md 的 `ComponentUpdateRecord`](specs/001-sdd-update-command/data-model.md#L29) 设置 `before`、`after`、`outcome`、`followUp`、`error`，并在首次克隆或技能数变化时推导 `requiresRestart`。
- [x] T011 [P] [US1] Implement `refreshInstalledKit` in `src/core/kit-copy.mjs`: validate `UpdateArgs.dshKitSourceDir` and `UpdateArgs.dshProfileDir`, enforce `KitCopyConfig.sourceDir`, `KitCopyConfig.destDir`, `KitCopyConfig.allowlist`, `KitCopyConfig.rejectSymlinks`, and return `KitCopyResult.changed`, `KitCopyResult.beforeHash`, `KitCopyResult.afterHash`, `KitCopyResult.changedFiles`, `KitCopyResult.destDir`, `KitCopyResult.mode` per `data-model.md`; stage into a temp dir, hash-verify, then swap with `fs.rename` — never write in place and never delete the whole destination.
- [x] T012 [P] [US1] Wire `sdd_upstream(action: "update_all")` in `src/register.mjs` to call `runUpdate`, add the contract parameters (`cwd`, `dshKitSourceDir`, `dshProfileDir`, `superpowersDir`, `repoUrl`, `python`) to the tool schema, update the description, and keep the tool count at two.
- [x] T013 [P] [US1] Finalize `skills/sdd-update/SKILL.md` body: call `sdd_upstream(action: "update_all", ...)` exactly once, render `ComponentUpdateRecord.before`, `ComponentUpdateRecord.after`, `ComponentUpdateRecord.outcome`, `ComponentUpdateRecord.followUp` and `UpdateReport.requiresRestart` from `data-model.md` plus the output rules in `contracts/sdd-update.contract.md`, with no update logic in the skill.

**Checkpoint**: `/sdd-update` is independently functional and all AC-01..AC-06 tests pass after RED→GREEN→REFACTOR.

---

## Phase 4: Polish & Cross-Cutting Concerns

**Purpose**: Verification, operational validation and final governance review.

- [x] T014 [P] 在仓库根目录运行 `npm test` 并记录通过输出；增加耗时校验：对 `runUpdate` 的全量当前场景计时，断言在五分钟阈值内完成并记录网络/缓存前提（见 [spec.md:42](specs/001-sdd-update-command/spec.md#L42)）；修复 `test/sdd-kit.test.mjs`、`src/core/update.mjs`、`src/core/kit-copy.mjs` 中的回归直至全绿。
- [x] T015 [P] Validate the profile-copy and restart drill in `specs/001-sdd-update-command/quickstart.md` against a temp `DSH_PROFILE_DIR`; correct the documented path, allowlist or hardlink caveat in that file if behavior differs.
- [x] T016 [P] 对 [.specify/memory/constitution.md](.specify/memory/constitution.md) 与 [specs/001-sdd-update-command/spec.md](specs/001-sdd-update-command/spec.md) 做最终合规复核：确认三技能/两工具表面一致、REQ-02/AC-02 措辞一致，并按章程 VI 检查新增与修订内容为中文；必要时修正 `README.md` 与 `cordis.patch.yml`。

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies; T001 and T002 can run in parallel.
- **Foundational (Phase 2)**: Depends on T001 (governance gate). T003 and T004 can run in parallel after T001.
- **User Story 1 (Phase 3)**: Depends on T003 and T004. Tests T005–T008 are sequential (same file). T009 and T011 can run in parallel once skeletons exist; T010 follows T009 (same file); T012 and T013 follow the core implementations.
- **Polish (Phase 4)**: Depends on the US1 checkpoint. T014–T016 can run in parallel.

### User Story Dependencies

- **User Story 1 (P1)**: Starts after Foundational; no dependency on other stories because the spec defines only one story.

### Within User Story 1

- RED tests T005–T008 MUST fail for the expected reason before T009–T013.
- Core orchestration T009 before adapters T010 (same file); kit-copy T011 is independent given the T004 skeleton.
- Host wiring T012 and skill body T013 come after the core behavior exists.
- Verify GREEN with T014; then REFACTOR while keeping tests green.

### Data model citation coverage

| Canonical fields | Resolving implementation task |
| :--- | :--- |
| `ComponentUpdateRecord.component`, `.before`, `.after`, `.outcome`, `.followUp`, `.error` | T009, T010, T013 |
| `UpdateReport.action`, `.ok`, `.components`, `.requiresRestart`, `.errors`, `.cwd` | T009, T013 |
| `UpdateArgs.cwd`, `.superpowersDir`, `.repoUrl`, `.python` | T010 |
| `UpdateArgs.dshKitSourceDir`, `.dshProfileDir` | T011 |
| `KitCopyConfig.sourceDir`, `.destDir`, `.allowlist`, `.rejectSymlinks` | T011 |
| `KitCopyResult.changed`, `.beforeHash`, `.afterHash`, `.changedFiles`, `.destDir`, `.mode` | T011 |

### Parallel Opportunities

- T001 + T002 (different files).
- T003 + T004 after governance gate (different files).
- T009 + T011 (different core files); T012 + T013 after core behavior (different files).
- T014 + T015 + T016 (different concerns/files).
- Do not parallelize T005–T008 or T009+T010: they edit the same file.

---

## Parallel Example: User Story 1

```bash
# RED tests are sequential (same file):
# T005 → T006 → T007 → T008

# GREEN core work after skeletons:
# T009 (src/core/update.mjs)  ||  T011 (src/core/kit-copy.mjs)
# then T010 (src/core/update.mjs)
# then T012 (src/register.mjs) || T013 (skills/sdd-update/SKILL.md)
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 (T001 governance gate + T002 metadata).
2. Complete Phase 2 (T003 skill shell + T004 core shells).
3. Complete Phase 3 RED tests T005–T008, observe failures.
4. Complete GREEN implementations T009–T013, keeping `npm test` green.
5. **STOP and VALIDATE** with T014–T016; this is the full MVP because the spec has one story.

### Incremental Delivery

- Setup + Foundational → command surface exists but is inert.
- User Story 1 → all three components update with a unified report; this is the MVP increment.
- Polish → operational docs and governance consistency verified.

### Commit Discipline

- One atomic Conventional Commit per completed task on the current branch (`main` unless explicitly changed by the user), per `constitution.md:44-49`. Never `git add -A`; stage only the files named in the task.

---

## Notes

- [P] means different files and no dependency on incomplete work.
- [Story] labels map only to `US1` from `spec.md:5-12`.
- Verify each test fails before implementing its behavior.
- No task calls `specify_init`, `install_bug_ext`, or any `sdd_bridge` mutator; that is a hard boundary from `spec.md:26-27`.
- `tasks.md` is a Phase 2 `/speckit-tasks` artifact; no implementation code was written by task generation.

---

## Phase 5: Convergence

- [x] T017 **CRITICAL**：按章程「技术与集成约束」把当前源码安全刷新到 `/home/bobo/.dsh/profiles/web/node_modules/dsh-sdd-kit`，验证 profile 中出现 `sdd-update` 技能、`package.json` 为 `0.3.0`、`src/register.mjs` 含 `update_all`，并向用户报告需要重启 DSH per Constitution 技术与集成约束 (missing)
- [x] T018 修正 `README.md:40` 中关于检出目录“自动发现”的误导表述，明确 `dshKitSourceDir` 必须显式传入、缺失时该组件会失败 per README.md:40 / REQ-05 (contradicts)
- [ ] T019 把 `specs/001-sdd-update-command/quickstart.md:78-96` 的手工恢复流程改为暂存 + 逐条目重命名的硬链接安全流程，或明确标注原地复制的破坏性前提 per plan: profile-copy 安全决策 (partial)
- [ ] T020 对齐 `specs/001-sdd-update-command/contracts/sdd-update.contract.md` §3 与 `plan.md:25` 的依赖注入说明：要么实现 `runner`/`fs`/`crypto` 注入，要么把文档改为实现实际支持的 `runUpstream`/`refreshKit`/`env`/`homedir` per plan:contract §3 (partial)
- [ ] T021 校正 `plan.md:19,25,34,38,40`、`research.md:15,50,70,84`、`tasks.md:12,14,152` 中因章程中文化而失效的行号引用，保持原有语义不变 per plan/research/tasks 引用 (partial)
