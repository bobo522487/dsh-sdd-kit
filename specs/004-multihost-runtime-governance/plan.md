# Implementation Plan: 跨宿主 SDD 运行时治理层（v2.0）

**Branch**: `004-multihost-runtime-governance` | **Date**: 2026-11-24 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-multihost-runtime-governance/spec.md`

## Summary

把 dsh-sdd-kit 的治理价值层（镜像同步、更新编排、安装状态机、重载判定、五区体检、引导拼装、模板渲染）收拢到一处零宿主依赖的 `src/core/`，在 `src/adapters/<host>/` 以固定三面契约加重载语义（工具面/引导面/技能面/重载语义四个必答项）接入 DSH、Claude Code、Codex、Cursor，并提供零第三方依赖 CLI `bin/sdd-kit.mjs`。上游事实已实测：本仓库核心已零宿主引用（抽离为增量补全）；Spec Kit 四端均 `multi_install_safe` 且技能目录互不覆盖；打包形态 DSH `ctx.systemPrompt` 可达；`peerDependenciesMeta.optional` 可消除裸 Node 强制安装；扩展版本下界由上游 `check_compatibility` 在安装期硬失败保证。新增能力以增量入口出现，既有输入/输出/语义 100% 回归一致。

## Technical Context

**Language/Version**: JavaScript ES Modules，Node.js >=18（实测运行 v26.13.1）

**Primary Dependencies**: 仅 Node 内置（`node:fs` / `node:path` / `node:util.parseArgs` 等）；宿主运行时可选 `ctx.get()` 读取（不进 `inject` 必需数组）

**Storage**: JSON 文件——`.specify/sdd-pending.json`（按 host 分条的待生效标记）、`~/.dsh/sdd-kit.json` 与 `<repo>/.specify/sdd-kit.json`（引导开关 `guidance.enabled` 两级键，均为既有配置的增量键、不新建独立开关文件）；无数据库

**Testing**: `node --test test/sdd-kit.test.mjs`（基线 91/91 全绿）+ tasks.md 列出的新增契约/模块测试（core-purity、contract-parity、host-capabilities、guidance、reload、marker、guard、doctor、trigger、compat、regression-dsh、adapters 系列、boundary），性能边界断言含体检 ≤5s 与 100 技能 ≤1s

**Target Platform**: Linux / macOS / Windows；平台受限用例（宿主钩子、符号链接、特定安装渠道）显式 skip 并注明原因

**Project Type**: 单包多宿主库 + 薄 CLI（库导出 `src/index.mjs`，CLI 为 `bin/sdd-kit.mjs`）

**Performance Goals**: 常驻引导 ≤1.2k token；体检单次（不含网络）≤5s；触发试跑 ≤100 条技能 ≤1s；单个适配实现 ≤100 行

**Constraints**: 禁新增 npm 依赖；核心零第三方/零宿主引用（静态断言门禁）；LF 换行；既有命令字段与语义向后兼容；零分叉（不复制上游逻辑）；当前分支原子提交（章程 IV）

**Scale/Scope**: 4 个宿主适配器；三面契约 + 重载语义（四个必答项）；7 个核心模块；46 条 REQ / 23 条 AC / 66 个任务；里程碑 M1 v0.6.0 → M4 v0.9.0+

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原则 | 预判 | 依据与本计划对策 |
|------|------|------------------|
| I 零分叉薄胶水 | 通过（需章程 v5.0.0） | 核心只编排上游 `specify`/git；新增 CLI 与适配仅委托核心，不重实现；引导不复制上游正文（引用 name+description）；不写 tasks.md 勾选、不替换 profile 副本。对外表面枚举已由章程 v5.0.0 原则 I 扩为「两技能 + 两宿主工具 + 一个宿主中立 CLI + 一扩展」，`bin/sdd-kit.mjs` 属允许表面且被要求只委托核心、与 Host 工具输出同构（`/speckit-analyze` C1 已关闭） |
| II 规范优先 EARS+非目标 | 通过 | spec.md 46 条 EARS REQ + 明确 Non-Goals；五问已 `/speckit-clarify` 解决；本计划由 spec 驱动 |
| III 严格 TDD | 通过 | 每个核心模块先写失败测试再实现；`npm test` 全绿才勾任务（由 tasks/implement 阶段执行） |
| IV 当前分支原子提交 | 通过 | 当前分支 `main`（feature 目录独立），不建分支/worktree；任务逐条原子提交 |
| V 免值守上游同步 | 通过 | `specify init` 沿用固定 `--non-interactive --force --ignore-agent-tools`，省略 `--integration-options=--skills`；不新增自研安装器 |
| VI 中文优先 | 通过 | 本计划及全部设计产物中文；命令/路径/固定标题保留原文 |

无违规，无需 Complexity Tracking 例外。

## Project Structure

### Documentation (this feature)

```text
specs/004-multihost-runtime-governance/
├── plan.md              # 本文件（/speckit-plan 输出）
├── research.md          # Phase 0：12 项实测决策
├── data-model.md        # Phase 1：实体与状态转换
├── quickstart.md        # Phase 1：端到端验证场景
├── contracts/
│   └── host-adapter.md  # Phase 1：三面契约 + 重载语义唯一定义
├── checklists/
│   └── requirements.md  # /speckit-specify 产出
└── tasks.md             # Phase 2 /speckit-tasks 产出（本命令不创建）
```

### Source Code (repository root)

```text
src/
├── index.mjs                    # DSH 插件入口（保持 inject=['tools']，ctx.get 可选读服务）
├── register.mjs                 # 宿主导出的两个轻量工具（委托 core）
└── core/
    ├── upstream.mjs / update.mjs / setup.mjs / bridge.mjs
    ├── status.mjs / snapshot.mjs / artifacts.mjs / fsutil.mjs / candidates.mjs
    ├── guidance.mjs             # 新增：单一引导拼装 + token 预算裁剪
    ├── reload.mjs               # 新增：三态重载判定（唯一实现）
    ├── marker.mjs               # 新增：待生效标记读写（按 host 分条）
    ├── doctor.mjs               # 新增：五区只读体检
    ├── trigger.mjs              # 新增：触发试跑打分（不执行）
    ├── guard.mjs                # 新增：规划期只读护栏
    └── host-capabilities.mjs    # 新增：宿主能力表（唯一事实源）
src/adapters/
├── dsh/index.mjs                # system-prompt 引导 + 注册 ctx 工具
├── claude/index.mjs             # 扩展 events 引导 + CLI 工具面
├── codex/index.mjs              # 托管块引导 + CLI 工具面
└── cursor/index.mjs             # 规则目录引导 + CLI 工具面 + trust 告警
bin/sdd-kit.mjs                  # 零依赖 CLI：update/bridge/doctor/guard/guidance
spec-kit-extension/extension.yml # 增 events.session_start + before_clarify/before_plan 护栏
package.json                     # peerDependenciesMeta.optional=true（版本下界 M1 实测收紧）
test/
├── sdd-kit.test.mjs             # 既有 91 用例（回归基线）
├── contract-core-purity.test.mjs
├── contract-parity.test.mjs
├── guidance.test.mjs / reload.test.mjs / doctor.test.mjs
└── guard.test.mjs / compat.test.mjs / adapters.test.mjs
```

**Structure Decision**: 单仓库单包（性能边界要求），核心/适配/CLI 三层只增目录不改既有 `src/core` 文件语义；每个适配实现是纯接线层（≤100 行），全部业务判定留在 `src/core/`。

## Phase 0 决策摘要

详见 [research.md](./research.md)（12 项决策均含 Decision/Rationale/Alternatives）。关键决策：
1. DSH 引导走 `ctx.get('systemPrompt')` + `section()` 常驻段（每步 assemble 抗压缩），不进必需 inject。
2. Claude 引导经扩展 `events.session_start` 由上游写原生 hook；Codex 托管块、Cursor 规则目录；DSH 无 events 通道。
3. 引导只引用上游技能 name+description（15 条合计约 756 tok），不整段复制超限正文；超限只裁 SDD 指针。
4. 待生效标记单 JSON 按 host 分条；重载三态判定唯一实现。
5. 保持扩展下界 `>=1.4.0`（上游安装期硬失败）；`peerDependenciesMeta.optional=true` 消除裸 Node 强制装 peer。
6. 四端钩子「等价生效」按 active 集成语义解释，体检如实呈现（实测非 active 端 hooks=0）。
7. 引导开关落在两级既有配置的 `guidance.enabled`，不新建开关文件；不可解析视为未设置并告警（`/speckit-analyze` B2）。
8. 触发试跑采用 `TriggerScore` 确定性打分（词元命中 + 名称权重 ×2 + 开方归一化 + `name`/`provider` 字典序并列），零分仍列出、`not_user_invocable` 标 excluded（`/speckit-analyze` B1）。
9. `sddPointer.phase` 由既有产物按阶推导，与 `FeaturePhase.判定` 共用实现；性能边界用计时断言固化（B3/B4）。

## Phase 1 设计摘要

- [data-model.md](./data-model.md)：HostCapability / ThreeFaceContract / GuidanceBundle / ReloadDecision / PendingMarker / TriggerScore / DoctorReport / DiagnosticItem / SkillSummary / FeaturePhase 十实体与转换。
- [contracts/host-adapter.md](./contracts/host-adapter.md)：三面契约 + 重载语义（四个必答项）+ 扩展清单 + 体检输出格式唯一定义。
- [quickstart.md](./quickstart.md)：11 组端到端验证场景覆盖全部 23 条 AC。
- 里程碑映射：M1 核心抽离 + CLI + peer 收口（REQ-01~07/14/21/45）；M2 引导 + 重载（REQ-08~20）；M3 Claude 适配 + 扩展护栏（REQ-22~28）；M4 Codex/Cursor + 体检 + CI 矩阵（REQ-29~42）；止损见 REQ-43/44。

## 需求到里程碑与验证映射

46 条 REQ 全部落位，无遗漏（AC 见 [quickstart.md](./quickstart.md) 场景对应关系）。

| REQ | 落点 | 里程碑 | 验证 |
|-----|------|--------|------|
| REQ-01 核心收拢零宿主 | `src/core/` | M1 | `contract-core-purity.test.mjs` |
| REQ-02 静态扫描门禁 | 同上 + 测试 | M1 | 注入违规引用即红 |
| REQ-03 三面+重载，适配无业务逻辑 | `src/adapters/*` | M1 | `adapters.test.mjs` |
| REQ-04 契约唯一文档 | `contracts/host-adapter.md` | M1 | 文档审查 |
| REQ-05 CLI 零依赖等价 | `bin/sdd-kit.mjs` | M1 | `contract-parity.test.mjs` |
| REQ-06 新增宿主不改核心 | 能力表 + 适配 | M1 | 加第二端后核心用例不变 |
| REQ-07 适配 ≤100 行 | 各 `adapters/*/index.mjs` | M1 | 行数断言 |
| REQ-08 引导三段内容 | `guidance.mjs` | M2 | `guidance.test.mjs` |
| REQ-09 1.2k 上限只裁指针 | 同上 | M2 | 超长正文用例 |
| REQ-10 压缩后仍存在 | `systemPrompt.section` | M2 | 模拟压缩用例 |
| REQ-11 缺镜像不阻断加载 | `ctx.get` + 告警 | M2 | 删镜像用例 |
| REQ-12 两级开关 | `guidance.mjs` 读 `~/.dsh/sdd-kit.json` 与 `<repo>/.specify/sdd-kit.json` 的 `guidance.enabled` | M2 | 项目级覆盖全局级；不可解析记告警不失败 |
| REQ-13 单一文案源 | 核心单份拼装 | M2 | 两宿主逐字一致断言 |
| REQ-14 工具/CLI 同实现 | `core` 动作 | M1 | `contract-parity.test.mjs` |
| REQ-15 三态结论 | `reload.mjs` | M2 | `reload.test.mjs` |
| REQ-16 判定唯一实现 | 同上 | M2 | 单实现断言 |
| REQ-17 标记按 host 分条 | `marker.mjs` | M2 | 双 host 互不覆盖 |
| REQ-18 启动清当前 host 条目 | 同上 | M2 | 清除隔离用例 |
| REQ-19 历史残留按时间戳区分 | `doctor.mjs` 运行时区 | M2 | 构造残留用例 |
| REQ-20 空改动不落盘 | `reload.mjs` | M2 | 空集用例 |
| REQ-21 peer 实测下界+可选 | `package.json` | M1 | `compat.test.mjs` + 裸装探针 |
| REQ-22 四钩子等价生效（限 active 集成） | `extension.yml` | M3 | 激活端四钩子渲染用例 + 非激活端如实报未渲染 |
| REQ-23 规划期只读护栏 | `guard.mjs` + 两钩子 | M3 | `guard.test.mjs` |
| REQ-24 版本下界安装期硬失败 | `requires.speckit_version` | M3 | `compat.test.mjs` |
| REQ-25 多集成共存不覆盖 | 上游能力 + 体检 | M3 | 四端目录断言 |
| REQ-26 Claude 三面 | `adapters/claude` | M3 | `adapters.test.mjs` |
| REQ-27 Claude 缺插件降级 | 同上 | M3 | 降级用例 |
| REQ-28 Claude 输出同构 | CLI 共用核心 | M3 | `contract-parity.test.mjs` |
| REQ-29 Codex 三面 | `adapters/codex` | M4 | `adapters.test.mjs` |
| REQ-30 Cursor 三面 | `adapters/cursor` | M4 | 同上 |
| REQ-31 Cursor trust 安全告警 | 宿主区 | M4 | 告警用例 |
| REQ-32 两端 ≤100 行 | 适配实现 | M4 | 行数断言 |
| REQ-33 五区独立判定 | `doctor.mjs` | M4 | `doctor.test.mjs`（含 ≤5s 计时断言） |
| REQ-34 环境区一次列全 | 同上 | M4 | 缺失项全列用例 |
| REQ-35 宿主区内容 | 同上 | M4 | 字段断言 |
| REQ-36 仓库区漂移与完整性 | 同上 | M4 | 漂移用例 |
| REQ-37 运行时区冲突与标记 | 同上 | M4 | 冲突用例 |
| REQ-38 触发试跑确定性打分 | `trigger.mjs`（口径见 `data-model.md` `TriggerScore`） | M4 | 不执行断言 + 同分稳定序 + 零分仍列出 + 镜像缺失 + 100 技能 ≤1s |
| REQ-39 零写可重复四字段 | `doctor.mjs` | M4 | 快照对比零变更 |
| REQ-40 CI 回归矩阵 | workflow | M4 | 矩阵运行 |
| REQ-41 破坏性变更合并前变红 | 同上 | M4 | 人为变更用例 |
| REQ-42 不可用报未执行 | `verify-upstream.mjs` 语义 | M4 | 断网用例 |
| REQ-43 里程碑前置验证 | 各里程碑入口 | M1~M4 | 前置 PoC 记录 |
| REQ-44 止损处置 | 各里程碑出口 | M1~M4 | 降级路径用例 |
| REQ-45 DSH 行为 100% 回归 | 既有 91 用例 | M1 | `npm test` 全绿 |
| REQ-46 零分叉边界 | 全流程 | M1~M4 | 审查 + 不改写用户技能用例 |

## Post-Design Constitution Re-Check

设计完成后逐原则复核（2026-11-24）：

- **I**：适配层无业务判定、CLI 只委托核心、引导不复制上游正文、tasks.md 无平行写者、无 profile 副本写入 → **通过**。对外表面已由章程 v5.0.0 正式扩为五项（含宿主中立 CLI），`bin/` 与 `src/adapters/` 属允许表面而非并行逻辑（C1 已关闭）。
- **II**：全部设计产物中文、EARS 需求与澄清已固化 → **通过**。
- **III**：测试文件先于实现列入结构；全绿门禁由 tasks/implement 执行 → **通过**。
- **IV**：本计划未建分支/worktree；原子提交留给实现阶段 → **通过**。
- **V**：无自研安装器；上游通道不变 → **通过**。
- **VI**：全部文档中文 → **通过**。

结论：无违规，Complexity Tracking 表保持空（见下）。

## Complexity Tracking

> 无违规需要论证。

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| （无） | — | — |
