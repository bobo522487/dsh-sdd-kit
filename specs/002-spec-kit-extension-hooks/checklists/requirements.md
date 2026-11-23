# Specification Quality Checklist: Spec Kit 原生扩展钩子层

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-11-23
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — 规范只描述行为与契约；`specify extension add`、`.specify/extensions.yml`、事件名等作为**外部契约**出现，属于可观察接口而非内部实现
- [x] Focused on user value and business needs — 三条主场景（特性实现、缺陷修复、首次安装）均以用户可感知结果表述
- [x] Written for non-technical stakeholders — 除「Key Entities」外无代码级描述
- [x] All mandatory sections completed — User Story & Intent / EARS Requirements / Non-Goals & Hard Constraints / Acceptance Criteria 四节齐备

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain — 全文 0 处
- [x] Requirements are testable and unambiguous — 15 条 REQ 每条对应至少一条 AC 或可执行断言
- [x] Success criteria are measurable — 见 §4 Success Criteria 五条，均可通过观察安装输出/文件差异判定
- [x] Success criteria are technology-agnostic — 以「用户可观察行为」表述，未绑定具体脚本实现
- [x] All acceptance scenarios are defined — AC-01…AC-13 覆盖安装、四钩子触发、幂等、卸载、模板不被改动、无 Runtime Events、默认 integration=dsh、既有 claude 项目不自动改写
- [x] Edge cases are identified — 上游缺失（REQ-06）、重复安装（REQ-08）、卸载/禁用（REQ-12）、升级重装（REQ-07）、同步失败（REQ-11）
- [x] Scope is clearly bounded — Non-Goals 六条显式排除：tasks.md 解析、Superpowers 内容重写、Runtime Events 硬门禁、规划阶段行为、sdd-setup/sdd-update 语义、DSH 自动重启
- [x] Dependencies and assumptions identified — §5 五条，含 specify-cli 版本契约与本地镜像前提

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria — REQ-01…REQ-15 与 AC-01…AC-13 交叉覆盖
- [x] User scenarios cover primary flows — 特性实现、缺陷修复、首次安装、上游缺失、重复安装五个场景
- [x] Feature meets measurable outcomes defined in Success Criteria — 无孤立成功标准
- [x] No implementation details leak into specification — 钩子「如何注入纪律」留给 plan；规范只要求「在写代码前自动执行强制钩子并注入哪些纪律类别」

## Notes

- 规范刻意区分 Hooks 与 Runtime Events：REQ-09 与 AC-09 是硬性边界，防止后续实现越界到硬门禁。
- REQ-05 是本次特性的**验收核心**：`/sdd-implement` 必须从所有推荐流程中消失，否则「100% 只用原生命令」的目标未达成。
- 2026-11-23 `/speckit.clarify` 后复核：16/16 项仍全部通过，无回归。已由澄清决议并写入规范的 5 项：删除 `skills/sdd-implement/`（章程技能上限降回 2）、钩子只按名称引用上游技能不内联正文、安装入口扩展现有 `/sdd-setup` 不新增技能、扩展源目录为仓库内 `spec-kit-extension/`（随 npm 包分发、测试直连真实 `specify` CLI）、强制语义只靠 `optional: false` 且不改 `settings.auto_execute_hooks`。
- 2026-11-23 追加澄清（第 6 项）：`specify_init` 默认 integration 由 `claude` 改为 `dsh`（REQ-14）；对既有 claude 项目**不自动切换**，`/sdd-setup` 只报告不一致并给出显式 `specify integration switch dsh` 命令（REQ-15）。对应新增 AC-12 / AC-13。
- 仍待 plan 阶段决定的实现问题（不在本规范内）：扩展 id 命名、四个钩子命令的具体命名、纪律注入文本的组织方式、以及 `test/sdd-kit.test.mjs:183-189` 的技能数量断言如何调整。（除技能数量断言外，其余均已在 plan/research/contracts 中定案。）
