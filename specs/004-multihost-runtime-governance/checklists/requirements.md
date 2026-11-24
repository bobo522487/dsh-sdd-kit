# Specification Quality Checklist: 跨宿主 SDD 运行时治理层

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-11-24
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — 规范以「常驻引导段」「五区体检报告」「三态结论」等可观察结果表述；宿主专属包名、注册 API、CLI 子命令、标记文件名、打分算法均未进入正文，只在 Non-Goals 中把既有命令与渠道作为**边界对象**引用
- [x] Focused on user value and business needs — 九个用户场景全部以用户可感知后果表述（纪律不再缺席、一次体检定位、知道下一步动作、换终端不换逻辑、规范不中途漂移、上游破坏在合并前被发现）
- [x] Written for non-technical stakeholders — 除 `REQ-39` 的错误四字段（状态/错误码/说明/修复提示）与三态结论名外无代码级描述
- [x] All mandatory sections completed — User Story & Intent / EARS Requirements / Non-Goals & Hard Constraints / Acceptance Criteria / Assumptions and Dependencies 五节齐备

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain — 全文 0 处；三处潜在歧义（1.2k token 超限时裁谁、门控是否默认启用、重载标记如何区分历史残留）均按 PRD 已给口径定案：分别为 `REQ-09`（只裁 SDD 指针）、Non-Goals 条件触发项、`REQ-19`（按时间戳区分）
- [x] Requirements are testable and unambiguous — 46 条 REQ 全部映射到 AC-01…AC-23（脚本化覆盖校验：46/46 条 REQ 均在 AC 中被引用，无未覆盖需求）或可执行断言（token 计数、五区结构、双侧输出同构、标记自动清除、适配行数上限、错误四字段一致、矩阵变红）
- [x] Success criteria are measurable — 七条均可用「是否注入」「是否一次列全」「是否两侧一致」「是否误报」「是否需改核心」「是否在合并前阻断」判定
- [x] Success criteria are technology-agnostic — 未绑定具体脚本、模块或库；性能以用户可感知耗时与 token 上限表述
- [x] All acceptance scenarios are defined — 覆盖引导成功/超限裁剪/压缩存活/镜像缺失/开关关闭/跨宿主同源、五区体检/依赖一次列全/冲突/幂等只读、规划期护栏/版本下界/多集成共存、重载三态/标记/残留/空改动/依赖收口、四端三面等价/降级/安全告警/行数上限、回归矩阵/漂移定位/环境不可用、里程碑闸门与止损、行为零回归、零分叉
- [x] Edge cases are identified — 上游正文本身超限（`REQ-09`）、上游改名或镜像缺失（`REQ-11`）、历史残留标记（`REQ-19`）、空改动集（`REQ-20`）、纯 Node 环境安装（`REQ-21`）、Cursor 自动信任派发（`REQ-31`）、矩阵无网络（`REQ-42`）、宿主能力表外的新宿主（§5）、平台受限用例（§5）
- [x] Scope is clearly bounded — Non-Goals 显式排除跨端桥接本体与端间状态同步、技能暴露门控（降为条件触发项）、复活自研安装器、第四端外新宿主、双语切换与 UI、硬门禁与 MCP 转换、自动重启/自动切换集成/自动改写用户技能
- [x] Dependencies and assumptions identified — §5 十条，含打包形态常驻通道可达性、外部端引导形态由最小验证定型、门控条件触发、多集成增量共存语义、回归矩阵网络依赖、包名与品牌过渡、平台受限验收

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria — REQ-01…REQ-46 与 AC-01…AC-23 交叉覆盖，无孤立需求（脚本化核对：46/46 条 REQ 均在 AC 中被引用）
- [x] User scenarios cover primary flows — 引导、降级、体检、冲突、规划期护栏、重载、首个外部端、多端收官、漂移发现九个场景
- [x] Feature meets measurable outcomes defined in Success Criteria — 每条成功标准均有对应 AC 提供证据
- [x] No implementation details leak into specification — 四层目录划分、适配器接口签名、宿主能力表字段、引导拼装位置、五区内部检查项清单、标记文件命名与清理时机、CLI 子命令与退出码映射均留给 plan

## Notes

- 章程约束已核对：原则 I 的「零分叉/薄胶水层/单一可编辑源」被写成 `REQ-01`/`REQ-02`/`REQ-13`/`REQ-46` 与 Forbidden Behavior 的硬边界；「不得替换已安装 profile 副本」原样保留；原则 III（TDD）与 IV（原子提交）由既有流程钩子承接，不在本规范内重复。
- 与 `003-install-safety-hardening` 的边界：本特性不触碰安装层的四分类判定、快照与原子写；重载标记属于运行面，落在独立状态目录，不复用覆盖层快照目录。
- 与 `002-spec-kit-extension-hooks` 的边界：四个执行钩子的语义与覆盖面不变（`REQ-22` 只要求其跨集成等价生效）；本特性新增的是「规划期只读护栏」与「常驻引导」，不替换钩子机制。
- 门控（技能子集暴露 / 索引条数上限）已从 v1 的正式需求降为 Non-Goal 条件触发项，本期不实现；规格中仅以「未配置时行为不变」的形式保留其未来约束。
- 待 plan 阶段决定（不在本规范内）：宿主能力表的具体字段与适配器接口签名、引导段拼装与裁剪的实现位置、五区内部检查项清单、标记文件的命名与清理时机、CLI 子命令与退出码映射、回归矩阵的宿主×上游组合矩阵表。
- 里程碑 M1–M4 与各自止损线（PRD 已给）属于交付计划，不写入本规范正文；`REQ-43`/`REQ-44` 只约束「闸门未过不得进入、止损触发须按预设处置」这一可判定性质。
