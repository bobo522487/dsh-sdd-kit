---

description: "Task list for feature implementation"
---

# Tasks: 安装与覆盖层的安全性加固

**Input**: Design documents from `/specs/003-install-safety-hardening/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)、[research.md](./research.md)、[data-model.md](./data-model.md)、[contracts/](./contracts/)、[quickstart.md](./quickstart.md)

**Tests**: 本特性按章程原则 III（严格 TDD）**显式要求测试**——每个用户故事的第一组任务都是「先写失败测试」。`npm test` 未绿不得勾任务、不得提交。

**Organization**: 按用户故事分组。五个故事对应 spec §2 的五组需求（A 状态判定 / C 备份回滚 / D 原子写与符号链接防护 / B 候选选择 / E 上游集成验证），优先级按「写入路径的可判定性 → 可回滚性 → 不可逃逸性 → 多宿主选择 → 上游契约」排列。每个故事可独立完成并独立验证。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、无未完成依赖）
- **[Story]**: 所属用户故事（US1…US5）
- 每个任务都给出**精确文件路径**；受约束字段一律以 `data-model.md <实体>.<字段>` 形式引用，不复制约束原文

## Path Conventions

单仓库 DSH 插件：`src/core/*.mjs`（库）、`src/register.mjs`（宿主工具定义）、`test/`（`node --test`）、`overrides/`（随包数据）、`scripts/`（不随包的维护者工具）、`.github/workflows/`（CI）、`skills/`（技能正文）、`specs/003-install-safety-hardening/`（本特性文档）。

---

## Phase 1: Setup（共享基础设施）

**Purpose**: 建立随包数据文件与脚本入口。本阶段不改变任何运行时行为。

- [x] T001 新增 `overrides/spec-template.versions.json`，字段严格按 `data-model.md` E3（`artifact`、`versions[].sinceVersion`、`versions[].sha256`）；首项 `sinceVersion` 取 `"0.2.0"`（`git log -S"spec-template" -- overrides/` 唯一命中点 `6373527`），`sha256` 填 `803203dce4e93f53d25cc3bf77774f91769a21cfac44be055015bfd6fe5458fb`（`data-model.md` E1.`bundledSha256`）
- [x] T002 [P] 在 `package.json` 的 `scripts` 增加 `"verify:upstream": "node scripts/verify-upstream.mjs"`；确认 `files` 数组**未**新增 `scripts/` 或 `test/`（`data-model.md` E7 载体约束 + plan.md「Phase 1 新增的约束」第 6 条）

---

## Phase 2: Foundational（阻塞性前置）

**Purpose**: 三个底座模块（原子写原语、产物清单、快照原语）。US1 的写入分支与 US2 的回滚分支都依赖它们，**必须全部完成**才能开始任何用户故事。

**⚠️ CRITICAL**: 本阶段未完成前，US1–US5 均不得开始。

### 测试（先写，必须失败）

- [x] T003 [P] 在 `test/sdd-kit.test.mjs` 新增 `describe('fsutil: atomic write')`：`atomicWriteFile` 写入后内容正确、目标 inode 被替换、`finally` 后同目录无 `*.tmp` 残留（REQ-13/14，`contracts/sdd-bridge-install-overrides.md` §6「注入写入异常后目标保持原内容、无残留 `.tmp`」行）
- [x] T004 [P] 在 `test/sdd-kit.test.mjs` 新增 `describe('fsutil: guards')`：`assertInside(cwd, join(cwd,'..','x'))` 抛 `E_ESCAPE`；`assertNoSymlinkComponent` 对 `a-link/x.md` 返回含绝对路径的 `symlink:<abs>`、对 `a/x.md` 返回 `null`（REQ-15，`contracts/sdd-bridge-install-overrides.md` §6「`..` 逃逸路径 `E_ESCAPE`」行）；`t.skip` 条件：`process.platform === 'win32'`（创建符号链接需管理员权限）
- [x] T005 [P] 在 `test/sdd-kit.test.mjs` 新增 `describe('artifacts: ledger')`：产物清单恰 1 项且 `id === 'ears-spec-template'`；`sha256(bundledPath)` 等于 `bundledSha256`（`data-model.md` E1.`id` / E1.`bundledSha256`，INV-1）；台账末项指纹等于随包指纹（INV-2 / INV-7）、台账内无重复 `sha256`（INV-8）、`sinceVersion` 递增（`data-model.md` E3.`versions[].sinceVersion`）
- [x] T006 [P] 在 `test/sdd-kit.test.mjs` 新增 `describe('snapshot: capture')`：`captureSnapshot()` 建目录后 `.backup/.gitignore` 内容恰为 `"*\n"`（INV-17，`data-model.md` E5 目录树）；`manifest.json` 的 `schema === 1`、`snapshots[id].relativePath` 为 POSIX 相对路径（`data-model.md` E5.`relativePath`）；同内容重复捕获不刷新 `capturedAt`（INV-14）；`readManifest()` 不把 `.gitignore` 当作快照条目

### 实现

- [x] T007 实现 `src/core/fsutil.mjs` 的 `atomicWriteFile(target, bytes)`：同目录临时名 `.<basename>.<pid>.<random>.tmp` + `fs.open(tmp,'wx')` + `writeFile` + `sync` + `close` + `rename`；父目录 `fs.open(dir,'r')` + `sync()` 放 `try/catch` 忽略（Windows 必失败）；`finally` 中 `fs.rm(tmp,{force:true})`（REQ-13/14）
- [x] T008 实现 `src/core/fsutil.mjs` 的 `assertInside(baseDir, targetPath)`（`path.resolve` 后比较，抛 `E_ESCAPE: <abs>`）与 `assertNoSymlinkComponent(baseDir, targetPath)`（从 `baseDir` 到目标的**每一段**做 `lstat().isSymbolicLink()`，命中抛 `E_SYMLINK: <abs>`）（REQ-15；拒绝顺序 `E_ESCAPE` → `E_SYMLINK`）
- [x] T009 实现 `src/core/artifacts.mjs`：`listArtifacts()` 返回 `data-model.md` E1 的七个字段；`sha256File(p)` 流式摘要；`readLedger()` 解析 `overrides/spec-template.versions.json`（`data-model.md` E3）；`bundledVersion()` 取台账末项 `sinceVersion` 而非 `package.json.version`
- [x] T010 实现 `src/core/snapshot.mjs` 的 `captureSnapshot(artifact)` 与 `readManifest(cwd)`：建 `.backup/` 时**同步写入** `.backup/.gitignore`（内容 `"*\n"`，INV-17），`manifest.json` 字段按 `data-model.md` E5（`schema`/`snapshots`/`relativePath`/`sha256`/`sourceVersion`/`capturedAt`）；`capturedAt` 从注入的 `clock()` 取（默认 `new Date().toISOString()`）

**Checkpoint**: `npm test` 新增 4 组用例全绿，既有 51 个用例不受影响。基础原语就绪。

---

## Phase 3: User Story 1 — 幂等状态检测（Priority: P1）🎯 MVP

**Goal**: 把 `install_overrides` 从「存在即跳过」改为「按内容指纹四分类 + `unknown` 兜底」，默认只写 `not_installed`、只跳 `installed_consistent`，其余给机器可读的 `nextAction`。

**Independent Test**: 在临时项目连续跑两次 `runBridge({action:'install_overrides'})`，第二次 `status === 'unchanged'` 且文件 `mtimeMs` 与内容均未变（AC-01）；手工改内容后 `skipped_user_modified` 且文件未变（AC-02）；换成台账历史内容后 `skipped_stale` 且同时给出两个版本（AC-03）；`chmod 000` 后 `verdict === 'unknown'` 且未写入（AC-04）。

### 测试（先写，必须失败）

- [x] T011 [P] [US1] 在 `test/sdd-kit.test.mjs` 新增 `describe('install_overrides: status')` 覆盖 AC-01/AC-02（REQ-01/REQ-02）：首次 `status === 'written'` + `verdict === 'not_installed'`；第二次 `status === 'unchanged'` + `verdict === 'installed_consistent'` 且 `mtimeMs` 未变（INV-5）；手工改内容后 `skipped_user_modified` + `nextAction` 非空（INV-20）
- [x] T012 [P] [US1] 在 `test/sdd-kit.test.mjs` 新增 AC-03/AC-04 用例（REQ-03/REQ-04）：从台账历史指纹构造内容 ⇒ `skipped_stale` 且 `localVersion` 与 `bundledVersion` 均非空（INV-20a / INV-6：两者相等时不得报 `stale_upstream`）；`chmod 000` ⇒ `verdict === 'unknown'` 且 `status === 'failed'`、未写入（INV-4）；`t.skip` 条件：`process.platform === 'win32'` 或 `process.getuid?.() === 0`
- [x] T013 [P] [US1] 在 `test/sdd-kit.test.mjs` 新增 `describe('install_overrides: report')`（REQ-05）：`ok` 与 `status` 的聚合语义（`data-model.md` E6.`ok` / E6.`status`：空 `artifacts` 为 `false`；`skipped_*` 不算失败）；`artifacts.length` 恒等于产物清单长度（INV-21）
- [x] T014 [US1] 改写 `test/sdd-kit.test.mjs:111-114` 的既有断言：`ov2.status === 'skipped_existing'` → `'unchanged'`，并补 `ov1.verdict === 'not_installed'` / `ov2.verdict === 'installed_consistent'`

### 实现

- [x] T015 [US1] 实现 `src/core/status.mjs` 的 `classifyArtifact(artifact, ctx)`（REQ-01…REQ-04）：严格按 `data-model.md` E2 的五行短路顺序（`lstat` 不存在 → 读失败 → 当前指纹 → 历史指纹 → 其余），返回 `data-model.md` E2 的 `verdict`/`reason`/`localSha256`/`localVersion`/`bundledVersion`/`action`；任何异常只落 `unknown`（INV-4）
- [x] T016 [US1] 重写 `src/core/bridge.mjs` 的 `installOverrides(cwd, overwrite, deps)`：按 `contracts/sdd-bridge-install-overrides.md` §2 第 3–22 行编排（判定 → 分支 → 写入 → 组装），返回 `data-model.md` E6 全字段（顶层 `status`/`path` 取 `artifacts[0]`，向后兼容）
- [x] T017 [US1] 给 `src/core/bridge.mjs` 的 `runBridge(args, deps = {})` 增加第二参数注入通道：`deps.artifacts`（产物清单覆盖）与 `deps.clock`（`capturedAt` 固定）；工具层不得暴露（`contracts/sdd-bridge-install-overrides.md` §1「测试注入通道」）
- [x] T018 [US1] 改 `src/core/setup.mjs:72-73`：`install_overrides` 步骤的 `detail` 改为 `{status, verdict, reason, nextAction, artifacts}`，步骤状态映射按 `contracts/sdd-bridge-install-overrides.md` §5（`written`/`refreshed` → `performed`，`unchanged`/`skipped_*` → `skipped`，`failed` → `failed`）
- [x] T019 [US1] 改 `test/sdd-kit.test.mjs:1466` 的 setup 假桥返回值为新形状（含 `verdict`/`artifacts`），保持 `SETUP_STEP_ORDER` 断言（`test/sdd-kit.test.mjs:1472`）不变

**Checkpoint**: AC-01…AC-04 全绿；`/sdd-setup` 报告能区分四类状态。MVP 可交付。

---

## Phase 4: User Story 2 — 备份刷新与一键回滚（Priority: P2）

**Goal**: 覆盖前留快照、过期快照就地刷新、并提供独立动作 `restore_overrides` 一键还原；无快照时明确失败。

**Independent Test**: 安装 → 手工改 → 显式覆盖（产生快照）→ `restore_overrides` ⇒ 内容逐字节等于快照且报告含 `sourceVersion`（AC-07 前半）；干净项目回滚 ⇒ `ok:false` + `status:'no_snapshot'`（AC-07 后半）；改随包内容后再覆盖 ⇒ 快照被刷新为「本次覆盖前内容」（AC-06）。

### 测试（先写，必须失败）

- [x] T020 [P] [US2] 在 `test/sdd-kit.test.mjs` 新增 `describe('restore_overrides')` 覆盖 AC-06/AC-07（REQ-09/REQ-10）：全流程还原后 `sha256` 相等、`restored[0].sourceVersion === '0.2.0'`、`restored[0].path` 为绝对路径；快照刷新后旧内容不覆盖新快照（INV-14）
- [x] T021 [P] [US2] 在 `test/sdd-kit.test.mjs` 新增失败面用例（REQ-10/REQ-12）：`.bak` 被篡改 ⇒ `E_SNAPSHOT_CHECKSUM_MISMATCH` 且目标未变（INV-15）；`.bak` 丢失 ⇒ `E_SNAPSHOT_MISSING` + `status === 'partial'`；`{"schema":1,"snapshots":{}}` ⇒ `ok === false` + `no_snapshot`（空集不算成功）；`artifact:'nope'` ⇒ `E_ARGS` 且未写任何文件
- [x] T022 [P] [US2] 在 `test/sdd-kit.test.mjs` 新增「回滚不越界」用例（REQ-11）：在项目内放哨兵文件，回滚后其 `mtimeMs` 与内容不变（REQ-11）；目标被替换为符号链接 ⇒ `E_SYMLINK` 且链接目标未变；`t.skip` 条件：`process.platform === 'win32'`
- [x] T023 [P] [US2] 在 `test/sdd-kit.test.mjs` 新增「可重复回滚」用例（REQ-12）：连续回滚两次，第二次仍 `ok:true` 且内容不变（INV-18）
- [x] T024 [US2] 改写 `test/sdd-kit.test.mjs:132` 与 `:1560` 的未知动作断言：message MUST 含四个动作名（`Expected one of: inspect, install_overrides, restore_overrides, sync_index.`），保持 `/Unknown sdd_bridge action/` 匹配

### 实现

- [x] T025 [US2] 在 `src/core/snapshot.mjs` 实现 `restoreSnapshot(cwd, artifactId)`：按 `contracts/sdd-bridge-restore-overrides.md` §2 第 3–19 行（manifest 读失败当 `null`；`entries` 为空 ⇒ `no_snapshot`；逐项校验指纹 → 守卫 → 原子写 → 收集 `restored[]`）；`ok` 用「非空且全部 `restored`」聚合
- [x] T026 [US2] 在 `src/core/bridge.mjs` 新增 `restoreOverrides(cwd, artifact)` 并接入 `runBridge` 的 `case 'restore_overrides'`；未知动作消息更新为四个动作（§5）
- [x] T027 [US2] 在 `src/core/bridge.mjs` 的 `installOverrides` 显式覆盖分支补「快照先于覆盖」：`captureSnapshot()` 仅在目标已存在且将被改写时调用，`refreshed` 与 `written` 可区分（REQ-09 / `data-model.md` E6.`artifacts[].snapshot`）

**Checkpoint**: AC-06、AC-07 全绿；任意一次覆盖可还原，且还原范围严格受限。

---

## Phase 5: User Story 3 — 原子写入与符号链接防护（Priority: P3）

**Goal**: 让「拒绝」成为可验证的行为：符号链接与路径逃逸在 `open` 之前被拒，异常中断不留半写与残留，多产物失败互不阻断。

**Independent Test**: 目标为指向项目外的符号链接 ⇒ 写入被拒且链接目标未被修改（AC-08）；注入 `rename` 异常 ⇒ 目标保持原内容、目录内无 `.tmp`（AC-08）；令第 1 个产物失败 ⇒ 第 2 个仍被处理且整体 `ok:false`（AC-09）。

### 测试（先写，必须失败）

- [x] T028 [P] [US3] 在 `test/sdd-kit.test.mjs` 新增 AC-08 用例：目标自身是指向项目外文件的符号链接 ⇒ `status === 'failed'` + `reason` 以 `E_SYMLINK:` 开头，且链接目标内容未变（REQ-15）；`t.skip` 条件：`process.platform === 'win32'`
- [x] T029 [P] [US3] 在 `test/sdd-kit.test.mjs` 新增「首次安装时父目录是符号链接」用例（REQ-15「任一层」）：把 `<cwd>/.specify/templates/overrides` 换成指向项目外的链接后首次安装，断言 `failed` + `E_SYMLINK` 且外部目录无新文件
- [x] T030 [P] [US3] 在 `test/sdd-kit.test.mjs` 新增「写入中断」用例（REQ-14）：`mock.method(fs, 'rename', () => { throw Object.assign(new Error('boom'), {code:'EIO'}) })` 后安装，断言目标内容不变、同目录无 `*.tmp`（REQ-14）
- [x] T031 [P] [US3] 在 `test/sdd-kit.test.mjs` 新增 AC-09 用例（REQ-16 / INV-21）：`runBridge(args, {artifacts:[A,B]})` 令 A 失败，断言 `artifacts.length === 2`、A `failed`、B 正常写入、`ok === false`（REQ-16 / INV-21）

### 实现

- [x] T032 [US3] 在 `src/core/bridge.mjs` 的两条写入分支（`not_installed` 与显式覆盖）接入同一组守卫：`assertInside` → `assertNoSymlinkComponent` → `atomicWriteFile`；守卫失败时 `status:'failed'` + `reason` 带错误码前缀（REQ-15 / `data-model.md` E6.`artifacts[].reason`）
- [x] T033 [US3] 在 `src/core/bridge.mjs` 补齐失败隔离：循环体内 `try/catch` 包住单产物处理，异常转成该条 `failed` 条目，不中断其余产物；`ok` 用「非空且无 `failed`」聚合（REQ-16 / plan.md 约束第 7 条）
- [x] T034 [US3] 补齐 `reason` 错误码：`E_BUNDLED_MISSING`（随包文件缺失）、`EACCES`/`ENOSPC`/`EEXIST`（临时文件创建失败）按 `contracts/sdd-bridge-install-overrides.md` §4 表格落码

**Checkpoint**: AC-08、AC-09 全绿；项目外文件在任何异常场景下都未被修改。

---

## Phase 6: User Story 4 — 多候选目录按真实路径去重与最近活跃优先（Priority: P4）

**Goal**: 五个声明来源 → realpath 去重 → `mtimeNs` 降序 → 声明序号决胜，返回唯一 `selected` 与可排错的 `candidates[]`。

**Independent Test**: 临时目录建 3 个候选（其中两个经符号链接指向同一真实路径）、第三个更新 ⇒ 选中第三个且 `realPath` 唯一（AC-05）；重复 3 次结果一致（REQ-07）；全部不可解析 ⇒ `fallback:true` + `reason:'default'`。

### 测试（先写，必须失败）

- [x] T035 [P] [US4] 在 `test/sdd-kit.test.mjs` 新增 `describe('candidates: selection')` 覆盖 AC-05（REQ-06）：`new Set(realPaths).size === realPaths.length`（INV-10）、`candidates.filter(c => c.selected).length === 1`（INV-12）、选中项为 `mtimeNs` 最大者（INV-11）
- [x] T036 [P] [US4] 在 `test/sdd-kit.test.mjs` 新增决胜与回落用例（REQ-07）：`mtimeNs` 相同 ⇒ 取 `declaredIndex` 最小者（REQ-07）；全部不可解析 ⇒ `fallback === true` + `reason === 'default'` + `realPath === null` 且 `candidates` 不裁剪（INV-13）
- [x] T037 [P] [US4] 在 `test/sdd-kit.test.mjs` 新增来源优先级用例（REQ-08）：`DSH_SDD_KIT_SUPERPOWERS_DIR` 与 `DSH_HOME` 同设 ⇒ `reason === 'env'`（REQ-08）；再传 `superpowersDir` ⇒ `reason === 'explicit'`；`finally` 恢复两个环境变量
- [x] T038 [P] [US4] 在 `test/sdd-kit.test.mjs` 新增结构性断言（REQ-06/REQ-08）：`src/core/candidates.mjs` 源码不含 `readdir`（不扫描文件系统）；POSIX 下用 `HOME` 指向临时目录隔离默认路径，`t.skip` 条件：`process.platform === 'win32'`（`os.homedir()` 取 `USERPROFILE`）

### 实现

- [x] T039 [US4] 实现 `src/core/candidates.mjs` 的 `selectSuperpowersDir(args, env)`：按 `contracts/sdd-upstream-candidate-selection.md` §2 第 1–18 行生成五个声明来源、`realpath` 去重（仅对非 `null` 项）、`fs.stat(p,{bigint:true}).mtimeNs` 降序 + `declaredIndex` 升序决胜；返回 `data-model.md` E4 的 `dir`/`realPath`/`reason`/`mtimeNs`/`fallback`/`candidates[]`；`process.env` 只读两个具名变量并在注释里说明原因
- [x] T040 [US4] 改 `src/core/upstream.mjs`：`status` 与 `sync_superpowers` 消费 `selectSuperpowersDir()`，把 `selection` 放进 `superpowers.selection`（`data-model.md` E4 载体）；`sync_superpowers` 的 `dir` 用选中的 `dir`（clone 目标）
- [x] T041 [US4] 改 `src/core/setup.mjs` 的 `sync_superpowers` 步骤：`detail` 增加 `{dir, selection:{reason, realPath}}`（`contracts/sdd-upstream-candidate-selection.md` §5）
- [x] T042 [US4] 改 `src/register.mjs`：`sdd_upstream` 增加 `candidateDirs`（string[]）入参定义；`sdd_bridge` 的动作描述改为四个动作并新增 `artifact` 入参；复核两者 `isConcurrencySafe`

**Checkpoint**: AC-05 全绿；同一台机器重复运行选择结果一致。

---

## Phase 7: User Story 5 — 面向真实上游的集成验证（Priority: P5）

**Goal**: 用真实 `specify` CLI 验证四个契约点，环境不可用时报「未执行」而非「通过」，且永不进入 `npm test` 的默认入口。

**Independent Test**: `node scripts/verify-upstream.mjs --json` 输出可解析 JSON 且 `status !== 'failed'`；`PATH=` 空环境 ⇒ 退出码 0 且 stdout 含「未执行」；假 `specify` shim ⇒ 退出码 1 且 `checks` 有 `ok:false`（AC-10）。
  > **已被 T099 取代**：当前 `PATH=` 空环境（及版本漂移、契约失败）⇒ 退出码 1；本行为历史规格原文，仅作留档。

### 测试（先写，必须失败）

- [x] T043 [P] [US5] 新增 `test/upstream-contract.test.mjs`（REQ-17/REQ-19）：顶层 `if (process.env.DSH_SDD_KIT_INTEGRATION !== '1') t.skip(...)` 整文件跳过；`=1` 时 `import { verifyUpstream }` 并断言 `status !== 'failed'`（INV-25：该文件 MUST NOT 被 `test/sdd-kit.test.mjs` 引用）
- [x] T044 [P] [US5] 在 `test/sdd-kit.test.mjs` 新增脚本契约用例（REQ-18/REQ-19）：空 `PATH` 跑脚本 ⇒ 退出码 0、`--json` 的 `checks.length === 0` 且 `reason` 非空（INV-23）；假 `specify` shim（exit 2）⇒ 退出码 1 且至少一项 `ok === false` 且 `detail` 非空（INV-24）；`passed` 时 `checks.map(c=>c.id).sort()` 等于四个 id（`data-model.md` E7.`checks[].id`）
  > **已被 T099 取代**：当前空 `PATH` 用例断言退出码为 1（非 0）；其余断言仍有效。
- [x] T045 [P] [US5] 新增结构断言（REQ-18）：`test/sdd-kit.test.mjs` 源码不含 `verify-upstream` 字样（REQ-18「不阻塞日常」）；`.github/workflows/upstream-integration.yml` 含 `schedule` 与 `workflow_dispatch`

### 实现

- [x] T046 [US5] 实现 `scripts/verify-upstream.mjs`：导出 `verifyUpstream({json, keep})` 并支持 `node scripts/verify-upstream.mjs [--json] [--keep]`；按 `contracts/verify-upstream-script.md` §2 第 1–10 行执行四个契约点（`init-args` / `extension-add-args` / `manifest-contract` / `hooks-registered`）；网络类错误 ⇒ `not_executed` + 退出码 0，契约失败 ⇒ `failed` + 退出码 1；`finally` 清理 `mkdtemp` 目录（`--keep` 除外）；单命令超时 120 s
  > **已被 T099 取代**：当前网络类错误（`not_executed`）退出码为 1，契约失败与版本漂移同样退出 1；上文「退出码 0」为历史规格。
- [x] T047 [US5] 新增 `.github/workflows/upstream-integration.yml`：`on: schedule`（`cron: '0 3 * * *'`）+ `workflow_dispatch`；`ubuntu-latest`，`astral-sh/setup-uv` 后跑 `node scripts/verify-upstream.mjs`

**Checkpoint**: AC-10 全绿；上游契约漂移可在一次手动/夜间验证内被发现，且不影响 `npm test` 结论。

---

## Phase 8: Polish & 跨故事关注点

**Purpose**: 把新语义暴露到用户可见表面，并做全量回归。

- [x] T048 [P] 改 `skills/sdd-setup/SKILL.md` 第 3/4 步各加一句：`detail.nextAction` 非空时**原样展示**并等用户确认；`detail.selection.reason !== 'explicit'` 时报告所选绝对路径与依据。**MUST NOT** 出现任何动作名（`install_overrides`/`restore_overrides`），保持 `test/sdd-kit.test.mjs:480`、`:1135` 的 forbidden 名单为绿（INV-22）
- [x] T049 [P] 改 `README.md`：新增「安装安全性」小节，说明四分类状态、`nextAction` 的展示方式、`.backup/` 快照与一键回滚、候选目录选择依据、`npm run verify:upstream` 的用法；**MUST NOT** 声称快照依赖宿主 `.gitignore`（INV-17）
- [x] T050 跑 [quickstart.md](./quickstart.md) 的 9 个小节做手工验收，逐条核对期望输出（含 `git check-ignore` 命中 `.backup/.gitignore`、`git status --porcelain` 不含 `.backup`）
- [x] T051 全量回归：`npm test` 必须 `fail 0`；`node scripts/verify-upstream.mjs --json` 在联网环境下 `status !== 'failed'`；`git status --porcelain` 仅含预期改动（无 `.tmp`、无探针目录）
- [x] T052 复核章程原则 I 的三条硬边界：技能与工具数量未变（`grep -c` 技能目录、`register.mjs` 中 `defineTool` 调用数各为 2）、`src/` 内 `process.env` 仅两个具名变量、`skills/` 不含动作名

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 无依赖，可立即开始
- **Foundational (Phase 2)**: 依赖 Setup（T001 的台账文件是 T005/T009 的输入）——**阻塞所有用户故事**
- **US1 (Phase 3)**: 依赖 Phase 2（`fsutil` 原子写、`artifacts` 清单、`snapshot.captureSnapshot`）
- **US2 (Phase 4)**: 依赖 US1（复用 `installOverrides` 的显式覆盖分支产生快照）
- **US3 (Phase 5)**: 依赖 US1（在 `installOverrides` 的两条写入分支上接入守卫）
- **US4 (Phase 6)**: 依赖 Phase 2 即可；与 US1/US2/US3 无文件交叠（`candidates.mjs` + `upstream.mjs`），可提前并行
- **US5 (Phase 7)**: 仅依赖 Setup（T002 的 `scripts` 入口）；与 US1–US4 无代码依赖，可任意时刻并行
- **Polish (Phase 8)**: 依赖全部用户故事

### 文件冲突提示（顺序强制的真实原因）

- T016 / T026 / T027 / T032 / T033 / T034 全部改 `src/core/bridge.mjs` → **必须串行**
- T020–T023 与 T028–T031 全部改 `test/sdd-kit.test.mjs` → 可并行起草，但**提交必须串行**
- T018 改 `src/core/setup.mjs`、T041 再改同一文件 → 串行
- T040 改 `src/core/upstream.mjs`、T042 改 `src/register.mjs` → 与 US1 无交叠，可并行

### 并行机会

- T003–T006（四组失败测试，不同 `describe` 块）可同时起草
- T007–T010 中 T007/T008 同文件（`fsutil.mjs`）须串行，T009（`artifacts.mjs`）与 T010（`snapshot.mjs`）可并行
- US4（T035–T042）与 US5（T043–T047）整体可与 US1–US3 并行
- T048（技能）与 T049（README）可并行

---

## Parallel Example: User Story 1

```bash
# 先让四组失败测试同时就位（不同 describe 块，互不冲突）：
Task: "T011 新增 install_overrides 状态分类用例（AC-01/AC-02）"
Task: "T012 新增台账历史与不可读用例（AC-03/AC-04）"
Task: "T013 新增报告聚合语义用例（ok/status/artifacts.length）"

# 实现阶段串行（同一文件）：
Task: "T015 实现 src/core/status.mjs 的 classifyArtifact"
Task: "T016 重写 src/core/bridge.mjs 的 installOverrides"
```

## Parallel Example: User Story 4

```bash
# 候选选择与上游集成验证可同时进行（完全不同的文件）：
Task: "T039 实现 src/core/candidates.mjs"
Task: "T046 实现 scripts/verify-upstream.mjs"
```

---

## Implementation Strategy

### MVP First（US1 单独交付）

1. 完成 Phase 1（T001–T002）
2. 完成 Phase 2（T003–T010）——**关键**，底座未就绪不得开始故事
3. 完成 Phase 3（T011–T019）
4. **STOP & VALIDATE**：`npm test` 全绿、AC-01…AC-04 逐条手工核对
5. 此时「从未知覆盖」到「可判定覆盖」的收益已可交付：用户不会再被静默跳过，也不会丢手工定制

### Incremental Delivery

1. Setup + Foundational → 底座就绪
2. +US1 → 可判定（MVP）
3. +US2 → 可回滚
4. +US3 → 不可逃逸
5. +US4 → 多宿主选择正确
6. +US5 → 上游漂移可发现
7. +Polish → 用户可见表面与全量回归

每个故事完成后 `npm test` 必须保持 `fail 0`；按章程原则 IV，**每个任务一个原子 commit**（在当前分支 `003-install-safety-hardening` 上，不建分支、不建 worktree）。

---

## Notes

- `[P]` 仅表示「不同文件、无未完成依赖」，不表示可以跳过 TDD 顺序
- 每个任务的验收 = 对应契约 §6 的断言行为绿 + `npm test` 全绿 + 单次原子提交
- 受约束字段一律引用 `data-model.md <实体>.<字段>`，不在任务里复制约束原文
- 平台受限用例（Windows 符号链接、POSIX 权限位、`HOME` 隔离）MUST 显式 `t.skip` 并写明原因（章程「技术与集成约束」）
- 契约测试 MUST NOT 锚定平台相关换行（`extensions.yml` 只做文本断言）
