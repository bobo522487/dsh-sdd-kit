# Implementation Plan: 安装与覆盖层的安全性加固

**Branch**: `003-install-safety-hardening` | **Date**: 2026-11-23 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-install-safety-hardening/spec.md`

## Summary

把 `sdd_bridge(action:"install_overrides")` 从「文件存在就跳过、否则裸写」升级为一条**可判定、可回滚、不可逃逸**的安装路径：写入前用内容指纹把目标分成 `not_installed` / `installed_consistent` / `user_modified` / `stale_upstream` / `unknown` 五类（只有前两类会在默认参数下自动处理，后三类一律等显式意图），写入走「同目录临时文件 → fsync → 单次 rename」并对符号链接与路径逃逸硬拒绝，覆盖前在同目录 `.backup/` 留一份可一键还原的快照（新增 `sdd_bridge(action:"restore_overrides")`），多个上游镜像候选按 realpath 去重 + `mtimeNs` 最新优先选唯一目标（候选来源包含两个具名环境变量），最后用一个独立的 `scripts/verify-upstream.mjs` + 夜间 GitHub Actions 对真实上游 `specify` 做契约验证（环境不可用时报「未执行」而非「通过」）。

对外表面**不变**：仍是 2 个技能 + 2 个工具 + 1 个扩展；`install_overrides` 的既有 `status`/`path` 字段保留，新信息全部为增量字段（`artifacts[]`、`selection`、`snapshot`）。所有新行为都在既有薄胶水层内实现，不新增 npm 依赖，不碰 DSH profile 副本，不碰 `tasks.md`。

## Technical Context

**Language/Version**: Node.js >= 18（ESM），零新增 npm 依赖；所有原语来自 `node:fs/promises`、`node:crypto`、`node:path`、`node:os`、`node:child_process`。

**Primary Dependencies**: 运行时无第三方依赖。外部工具仅 `specify` CLI（本机 `1.4.4.dev0`）、`uv`（本机 `0.13.9`）、`git`——均只被**调用**，不被解析或复制。上游事实来源仍为 `specify` CLI 与 `~/.dsh/upstream/superpowers` Git 镜像（章程技术与集成约束）。

**Storage**: 文件系统三处 —— (1) 项目内 `.specify/templates/overrides/spec-template.md`（唯一由本插件写入的安装产物）；(2) 项目内 `.specify/templates/overrides/.backup/`（快照 + `manifest.json` + **自忽略文件 `.gitignore`**，内容 `*`，因此在下游项目里也不入库）；(3) 包内 `overrides/spec-template.versions.json`（历史指纹台账，随包发布）。无数据库、无缓存。

**Testing**: `node --test test/sdd-kit.test.mjs`（现有单文件套件，基线 51 个顶层用例全绿）；新增真实上游验证走独立文件 `test/upstream-contract.test.mjs`（默认整文件 skip，仅 `DSH_SDD_KIT_INTEGRATION=1` 时执行），因此 `npm test` 的判定不受网络与上游抖动影响。

**Target Platform**: 跨平台 Node（Linux / macOS / Windows）。符号链接用例在 Windows 上 `t.skip`（创建符号链接需管理员权限或开发者模式）；`chmod 000` 用例在 Windows 与 root 下 `t.skip`（POSIX 权限位不适用 / root 无视权限位）。目录 fsync 在 Windows 会失败，实现里作为尽力而为步骤忽略错误。

**Project Type**: 单仓库 DSH 插件（`src/` 库 + 两个宿主工具 + 两个技能 + 一个 Spec Kit 扩展源 + 一个随包 `overrides/` 数据目录）。

**Performance Goals**: 单次 `/sdd-setup` 内状态判定 + 候选选择 + 原子写入的额外耗时 ≤ 2 秒（spec §3 边界）。实测预算：`sha256(4 KB)` 0.029 ms、4 候选 realpath+去重+stat 1.4 ms、`open(wx)+write+fsync+rename` 1.9 ms、加父目录 fsync 3.1 ms；单次 setup 只写 1 个产物，总增量 < 10 ms，余量三个数量级。回滚单次 ≤ 5 秒（实际 < 10 ms）。

**Constraints**:
- MUST NOT 新增 npm 依赖（章程）；MUST NOT 引入 YAML 解析器——`extensions.yml` 只做文本断言，扩展状态只读 `specify extension list --json`。
- MUST NOT 复制或替换 DSH profile 内已安装副本（章程原则 I 硬边界）。
- MUST NOT 提供 `tasks.md` 平行勾选写者（`check_task` 保持退役）。
- 既有 `/sdd-setup`、`/sdd-update` 的输出字段与成功/失败语义 MUST 向后兼容，新增字段一律增量。
- 仓库文本 LF；契约测试 MUST NOT 锚定平台相关换行。
- `src/` 首次使用 `process.env`：只读 `DSH_SDD_KIT_SUPERPOWERS_DIR` 与 `DSH_HOME` 两个具名变量，不做前缀扫描，测试须 `finally` 恢复。

**Scale/Scope**: 4 个新增 `src/core/*.mjs` 模块（`artifacts`、`status`、`snapshot`、`candidates`）+ 1 个新增 `fsutil` 原子写模块；改动 `bridge.mjs`、`upstream.mjs`、`setup.mjs`、`register.mjs` 四个既有模块；新增 1 个随包数据文件、1 个脚本、1 个测试文件、1 个 CI 工作流；改 1 个技能正文、README、`package.json`（仅 `scripts`）。共 17 个仓库文件改动点（9 新增 + 8 修改）。

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原则 | 判定 | 依据 |
|------|------|------|
| I. 零分叉，薄胶水层 | PASS | 对外表面仍是 2 技能（`sdd-setup`、`sdd-update`）+ 2 工具（`sdd_upstream`、`sdd_bridge`）+ 1 扩展，**工具与技能数量均未增加**；`restore_overrides` 是 `sdd_bridge` 的第四个动作，不是新工具。新增写入能力全部落在「本插件唯一拥有写权的产物」（`.specify/templates/overrides/spec-template.md`）；对 `.specify/extensions.yml` 与 `.dsh/skills/speckit-*` 只映射 CLI 退出码，不自行判定/写入/留快照（research R1 范围收敛）。技能正文不新增动作名（`test/sdd-kit.test.mjs:480`、`:1135` 的 forbidden 名单保持绿）。 |
| II. 规范优先（EARS + 非目标） | PASS | spec.md 含 REQ-01…REQ-19、Out of Scope / Forbidden Behavior、AC-01…AC-10；无 NEEDS CLARIFICATION（`checklists/requirements.md` 15/15）。本计划不引入 spec 之外的行为：唯一「新增」是 `restore_overrides` 动作与 `candidateDirs` 入参，二者分别由 REQ-11/12 与 REQ-06 直接要求。 |
| III. 严格 TDD（不可协商） | PASS | 每个契约文件 §6 已给出可先落为失败测试的断言表（含 `t.skip` 条件）；任务顺序将强制「契约测试 → 模块 → 编排 → 技能/文档」，`npm test` 未绿不得勾任务。 |
| IV. 当前分支原子提交 | PASS | 在 `003-install-safety-hardening` 当前分支上每任务一个原子 `git commit`，不建分支、不建 worktree。 |
| V. 可升级免值守上游同步 | PASS | `specify init` 的参数集（`--non-interactive --force --ignore-agent-tools`，省略 `--integration-options=--skills`）**完全未变**；`/sdd-setup` 每次仍同步上游；新增的真实上游验证是**只读**契约探针，不改任何上游状态，且在独立 CI 作业里运行。 |
| VI. 中文优先 | PASS | 全部新增文档（research/data-model/contracts/quickstart/本计划）为中文；命令名、字段名、路径保留原文。 |

**结论**：Phase 0 前无阻塞违规，无需章程修订。本特性只加固既有写入路径，不改变对外表面与上游委派形态。

## Project Structure

### Documentation (this feature)

```text
specs/003-install-safety-hardening/
├── plan.md              # 本文件
├── research.md          # Phase 0：R1–R8 实测事实与决策（已完成）
├── data-model.md        # Phase 1：E1–E7 实体、字段与 INV-1…INV-25（含 INV-18a/18b/20a，已完成）
├── quickstart.md        # Phase 1：手工验证路径与排错表（已完成）
├── contracts/           # Phase 1：四份契约（已完成）
│   ├── sdd-bridge-install-overrides.md
│   ├── sdd-bridge-restore-overrides.md
│   ├── sdd-upstream-candidate-selection.md
│   └── verify-upstream-script.md
├── checklists/
│   └── requirements.md  # 已完成（15/15）
├── spec.md              # 已完成
└── tasks.md             # Phase 2（/speckit-tasks 产出，非本命令）
```

### Source Code (repository root)

```text
overrides/
├── spec-template.md                 # 不变（唯一可编辑源，sha256 803203dc…）
└── spec-template.versions.json      # 新增：历史指纹台账（末项必须等于上面文件的指纹）

src/core/
├── fsutil.mjs                       # 新增：assertInside(realpath 版) / assertNoSymlinkComponent /
│                                    #       atomicWriteFile（同目录临时文件 + fsync + rename + finally 清理）
├── artifacts.mjs                    # 新增：受管产物清单 + sha256 计算 + 台账读取
├── status.mjs                       # 新增：classifyArtifact()（四分类 + unknown，短路顺序固定）
├── snapshot.mjs                     # 新增：captureSnapshot() / readManifest() / restoreSnapshot()
├── candidates.mjs                   # 新增：selectSuperpowersDir()（五来源声明 + realpath 去重 + mtimeNs 排序）
├── bridge.mjs                       # 改：installOverrides 改为「判定 → 快照 → 原子写 → artifacts[]」；
│                                    #     新增 restore_overrides 动作；E_ARGS 消息更新为四个动作；
│                                    #     runBridge(args, deps) 增加注入通道（artifacts / clock，仅测试用）
├── upstream.mjs                     # 改：status / sync_superpowers 消费 candidates.mjs，返回 selection
├── setup.mjs                        # 改：install_overrides 与 sync_superpowers 的 detail 结构化
└── update.mjs                       # 不变

src/
├── index.mjs                        # 不变
└── register.mjs                     # 改：sdd_bridge 动作描述加 restore_overrides / artifact；
                                     #     sdd_upstream 参数加 candidateDirs；两者 isConcurrencySafe 复核

scripts/
└── verify-upstream.mjs              # 新增：真实上游契约验证（--json / --keep；not_executed 退出码 0）

test/
├── sdd-kit.test.mjs                 # 改：改写 :111-114 的 written/skipped_existing 断言；新增状态分类、
│                                    #     快照/回滚、原子写与 symlink、候选选择、台账一致性等用例
└── upstream-contract.test.mjs       # 新增：默认整文件 skip，DSH_SDD_KIT_INTEGRATION=1 时执行

.github/workflows/
└── upstream-integration.yml         # 新增：schedule（每日 03:00 UTC）+ workflow_dispatch

skills/sdd-setup/SKILL.md            # 改：第 3/4 步各加一句（nextAction 原样展示、selection 依据）
README.md                            # 改：安装安全性小节（状态分类、回滚、候选选择）
package.json                         # 改：scripts 增加 verify:upstream（files 无需改，"overrides/" 已含）
```

**Structure Decision**: 沿用现有扁平单项目结构（`src/core/*.mjs` 平铺，不新增子目录）。新增的四个职责模块与既有 `bridge/upstream/setup/update` 平级，理由是它们各自对应 data-model 的一个实体簇（E1/E2、E5、E4），且彼此无循环依赖：`fsutil` ← `snapshot` ← `bridge`，`artifacts` ← `status` ← `bridge`，`candidates` ← `upstream`。不把逻辑塞进 `bridge.mjs`（它会从 209 行涨到 400+ 行，违反「薄胶水」的可读性），也不新建 `src/core/install/` 子目录（4 个文件不足以支撑一层目录，且会打断既有 import 路径的平铺惯例）。`scripts/` 与 `.github/` 是仓库级新目录：前者是**不随包发布的开发工具**（`package.json` 的 `files` 不含它），后者是 CI 配置。

## Phase 0 决策摘要

完整实测事实与理由见 [research.md](./research.md)。关键结论：

1. **判定判据是内容指纹，不是存在性/版本号/mtime**（R1）。顺序固定为 `lstat 不存在 → 读失败 → 当前指纹 → 历史指纹 → 其余`，任何异常只能落 `unknown`，不得降级为 `not_installed`。理由：mtime 会被 `touch` 骗、版本号无法表达「模板跨版本不变」（`overrides/spec-template.md` 自 v0.2.0 起从未变过），而指纹是唯一能同时满足 AC-01（mtime 不变）与 AC-02/03（区分用户改与上游改）的判据。
2. **范围收敛：只有模板覆盖文件由本插件写**（R1 末段）。`.specify/extensions.yml` 的注册项与 `.dsh/skills/speckit-*` 由上游 `specify` CLI 写；本插件只映射 CLI 退出码。理由：章程原则 I 禁止并行逻辑，且 CLI 已拥有这两处的写权与幂等语义（`extension add --force` 重装后同事件条目仍为 1 条）。
3. **历史版本靠随包台账**（R2）：新增 `overrides/spec-template.versions.json`，末项指纹必须等于当前模板指纹（测试强制）。理由：历史内容不在磁盘上，联网查 git 历史违反离线可用；台账与模板同目录，改模板时必然被同一个 diff 审阅到。
4. **候选按 realpath 去重、`mtimeNs` 降序、声明序号决胜**（R3）。五个声明来源：`explicit` → `candidateDirs` → `env` → `dsh_home` → `default`；全部不可解析时回落 `default` 并标 `fallback:true`（因为 clone 需要一个目标）。理由：`mtimeMs` 经 `utimes` 后读回不精确（实测），`mtimeNs` 稳定；`.git/HEAD` 的 mtime 不随 commit 变化，不能当活跃度判据。
5. **快照放项目内 `.backup/`、每产物 1 份就地刷新、目录自忽略**（R4）。理由：本仓库的 `.gitignore:8` 确实忽略 `.specify/templates/overrides/`，但实测**下游** `specify init` 项目的 `.specify/.gitignore` 不含该规则——若照搬「天然不入库」的假设，快照会以 `?? .specify/templates/overrides/.backup/` 进版本库。因此创建目录时写入 `.backup/.gitignore`（内容 `*`），让保证随目录移动、不依赖也不改写宿主忽略规则。1 份即可满足「快照 = 最近一次覆盖前内容」，多份会引入「回滚到哪一份」的歧义与无界增长。
6. **原子写用同目录临时文件 + `wx` + fsync + rename，父目录 fsync 尽力而为**（R5）。实测 `rename` 覆盖符号链接会**替换链接本身**（把软链变普通文件），因此必须在 `open` 之前用 `lstat` 逐段拒绝符号链接；拒绝顺序 `E_ESCAPE` → `E_SYMLINK` → 任何 `open`。
7. **回滚是独立动作 `restore_overrides`，不是 `install_overrides` 的参数**（R6 与 [restore 契约](./contracts/sdd-bridge-restore-overrides.md) §2 末段）。理由：两者内容来源互斥（随包 vs 快照），叠加 `overwrite` 会产生无法自洽的组合；报告形状也不同（`restored[]` vs `artifacts[].verdict`）。
8. **真实上游验证独立成文件 + 独立脚本 + 独立 CI**（R8）。理由：`npm test` 只跑 `test/sdd-kit.test.mjs`，文件隔离比运行时 `t.skip` 更能保证「上游抖动不影响日常结论」；`not_executed` 退出码 0 但输出必须含「未执行」，杜绝把「没跑」当「通过」。

## Phase 1 设计摘要

- 数据形状见 [data-model.md](./data-model.md)：E1 受管产物、E2 状态判定、E3 版本台账、E4 候选选择、E5 快照与清单、E6 安装报告、E7 集成验证结果；共 28 条不变量（INV-1…INV-25，含 INV-18a/18b/20a）。
- 契约见 [contracts/](./contracts/)：`sdd-bridge-install-overrides.md`（判定/快照/原子写/拒绝）、`sdd-bridge-restore-overrides.md`（一键回滚）、`sdd-upstream-candidate-selection.md`（候选选择与报告）、`verify-upstream-script.md`（真实上游验证）。
- 手工验收路径见 [quickstart.md](./quickstart.md)（9 个小节，含 9 行排错表与 10 项自检清单）。

### 契约要点（摘）

- **`install_overrides`**：`overwrite` 是唯一的显式覆盖意图；`installed_consistent` 零副作用（不 `open`、不 `utimes`、不留快照）；`user_modified`/`stale_upstream` 默认跳过并给出机器可读 `nextAction`；`unknown` 且未显式覆盖 ⇒ `status:'failed'` 并附 `error.code`。返回顶层 `status`/`path`（兼容旧断言）+ `artifacts[]`（增量）。
- **`restore_overrides`**：无快照 ⇒ `ok:false, status:'no_snapshot'`；`.bak` 指纹与清单不符 ⇒ `E_SNAPSHOT_CHECKSUM_MISMATCH` 且不写；只写清单列出的 `relativePath`（清单是数据，必须重新做越界与 symlink 校验）；还原后保留快照以支持重复回滚。
- **候选选择**：`candidateDirs` 是新增入参（声明序号 1）；`process.env` 只读两个具名变量；永不抛异常，只在返回里标 `eligible`/`fallback`；`candidates.filter(c => c.selected).length === 1` 恒成立。
- **`verify-upstream.mjs`**：四个契约点（`init-args`、`extension-add-args`、`manifest-contract`、`hooks-registered`）；环境不可用 ⇒ `not_executed` + 退出码 0；契约失败 ⇒ 退出码 1 + 指明命令/参数/字段；MUST NOT 被 `test/sdd-kit.test.mjs` 引用。

## Post-Design Constitution Re-Check

*Phase 1 产物（research.md / data-model.md / contracts/ / quickstart.md）落地后复核，确认设计未引入新的违规。*

| 原则 | 复核结果 | 设计证据 |
|------|----------|----------|
| I. 零分叉，薄胶水层 | PASS | 新增代码全部在 `src/core/` 内、由既有两个工具动作暴露；工具与技能数量不变；四份契约都写了「禁止新增的入参」，排除的是会扩大写权或改变语义的参数——`install_overrides` 禁 `artifact`/`content`/`backupDir`/`force`，`restore_overrides` 禁 `content`/`sha256`/`version`/`snapshotId`/`overwrite`/`dryRun`，候选选择禁 `env`/`sortBy`/`prefer`/`scanRoots`/`depth`，验证脚本禁 `--repo`/`--ref`/`--offline`/`--fix`。技能正文只加两句展示要求，不含动作名（`install_overrides`、`restore_overrides` 均不出现在 `skills/*/SKILL.md`）。 |
| II. 规范优先 | PASS | INV-1…INV-25（含 INV-18a/18b/20a）与四份契约逐条可回溯到 REQ/AC 编号（每份契约头部有「对应」行）；未定义行为为零。复核期发现并修正两处实质缺陷：INV-17 原写「由宿主 `.gitignore` 覆盖」，实测下游不成立，已改为「快照目录自忽略」（Phase 0 决策 5 与 install 契约 §2）；INV-18a 新增「没有可还原副本就不许覆盖」，堵住 `unknown` + `overwrite:true` 无快照改写用户文件的路径。 |
| III. 严格 TDD | PASS | 每份契约 §6 的断言表可直接转成失败测试；平台受限用例的 `t.skip` 条件已在表中写明（Windows symlink、root/POSIX 权限位）。 |
| IV. 原子提交 | PASS | 任务将按「fsutil+artifacts 单测 → status → snapshot → candidates → bridge 编排 → setup/register → 技能/文档 → 脚本+CI」切分，每步独立可测可提交。 |
| V. 免值守上游同步 | PASS | `specify init` 参数集未变；验证脚本只读；CI 与 `npm test` 完全隔离（不同文件、不同入口）。 |
| VI. 中文优先 | PASS | 全部新增文档中文；标识符与命令保留原文。 |

**Phase 1 新增的约束**（已写入契约与 data-model，实现时必须遵守）：

1. **`installed_consistent` 分支不得触碰文件系统写路径**（INV-5）：不 `open`、不 `utimes`、不留快照、不重写 `manifest.json`。理由：AC-01 明确要求「内容与修改时间均未变化」，任何一次 `open(…,'r+')` 或 `utimes` 都会让该验收项不可测。
2. **`.backup/` 必须自带 `.gitignore`（内容 `*`）**（INV-17）：`captureSnapshot()` 建目录时同步写入，且 `readManifest()` 不得把该文件当作快照条目。理由：实测下游 `specify init` 项目的 `.specify/.gitignore` 不忽略 `templates/overrides/`，靠宿主忽略会让快照入库。
3. **`rename` 之前必须完成 symlink 逐段检查**（INV 见 [install 契约](./contracts/sdd-bridge-install-overrides.md) §2）：因为实测 `rename` 到符号链接路径会替换链接本身而非目标，检查放在 `rename` 之后等于没检查。
4. **台账末项指纹与随包模板指纹必须相等**（INV-2 / INV-7）：任何一次修改 `overrides/spec-template.md` 的提交都必须同时追加台账项，否则测试红。
5. **`process.env` 只允许两个具名变量**（[候选契约](./contracts/sdd-upstream-candidate-selection.md) §2）：`DSH_SDD_KIT_SUPERPOWERS_DIR`、`DSH_HOME`；禁止前缀扫描。理由：环境变量是跨 profile 传递的唯一合法通道，但开放扫描会让行为依赖宿主环境噪声。
6. **`scripts/` 不进入 npm 包**：`package.json` 的 `files` 保持不含 `scripts/`；`test/upstream-contract.test.mjs` 与 CI 都从仓库根调用它。理由：它是维护者工具，不是运行时资产。
7. **`ok` 一律用「非空且无失败」聚合，不用 `some`**：`install_overrides` 的 `ok = artifacts.length > 0 && artifacts.every(a => a.status !== 'failed')`，`restore_overrides` 的 `ok = restored.length > 0 && restored.every(r => r.status === 'restored')`。理由：`Array.prototype.every` 对空数组返回 `true`、`some` 对空数组返回 `false`，两者单独使用都会在「什么都没做」时给出错误的成功/失败结论，而这正是 REQ-12「MUST NOT 伪造还原结果」的边界。
8. **越界与 symlink 守卫覆盖两条写入分支**：首次安装（`not_installed`）与显式覆盖走同一组守卫。理由：`not_installed` 只说明目标文件不存在，父目录 `.specify/templates/overrides/` 仍可能是符号链接，放行等于让首次写入落到项目外（REQ-15 要求「任一层」）。

## Complexity Tracking

> 无 Constitution Check 违规项，本节留空。

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
