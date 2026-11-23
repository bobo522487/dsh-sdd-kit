# Feature Specification: SDD Unified Update Command

> Describe **what** the system must do and **what it must NOT do**. Keep implementation details (SQL, frameworks, internal classes) out of this document.

## 1. User Story & Intent
- **作为**一名维护由 dsh-sdd-kit 初始化的项目的 DSH 用户，**我希望** `/sdd-update` 能一并刷新 Spec Kit、Superpowers 与已安装的 dsh-sdd-kit，**从而**通过一次调用让三层工具全部保持最新，并获得清晰的逐组件变更报告。

**用户场景**

- 主要场景：在开始一个功能之前，用户运行 `/sdd-update`；系统检查全部三个组件，更新其中落后的组件，并打印一份包含 before/after 标识的汇总。
- 已为最新：上游无变化时用户再次运行命令；系统报告三个组件均为 unchanged，且不产生有效更新——各组件的 before 与 after 标识完全一致。
- 部分失败：某个组件无法刷新；系统仍会尝试其余两个组件，指出失败的组件，并报告总体失败。

## 2. Functional Requirements (EARS Format)
使用 EARS 语法编写每一条需求，使其与自动化测试一一对应：
- `REQ-01`：**WHEN** 用户调用 `/sdd-update` **THE SYSTEM SHALL** 检查 Spec Kit、Superpowers 与已安装的 dsh-sdd-kit，尝试将各自更新到其配置的最新来源，并为每个组件生成一条状态条目，包含其 before 标识、after 标识与结果。
- `REQ-02`: **WHEN** 某组件已处于其配置的最新来源 **THE SYSTEM SHALL** 将其报告为 unchanged，且不得对该组件产生有效变化；其 before 标识与 after 标识 MUST 相同。
- `REQ-03`：**IF** 刷新某个组件失败 **THE SYSTEM SHALL** 继续尝试其余组件，按名称标记失败的组件，并将整条命令报告为未成功。
- `REQ-04`：**WHEN** 三个组件均为最新或均已成功刷新 **THE SYSTEM SHALL** 报告总体成功，并说明更新后仍需要用户执行的操作。
- `REQ-05`：**IF** 已安装的 dsh-sdd-kit 未配置来源 **THE SYSTEM SHALL** 针对该组件报告明确的错误，同时仍报告 Spec Kit 与 Superpowers 的状态。
- `REQ-06`：**WHEN** `/sdd-update` 启动 **THE SYSTEM SHALL** 保持现有功能规格、计划、任务列表与应用源码文件不变。
- `REQ-07`：**WHEN** 某次更新需要重启 DSH 才能生效 **THE SYSTEM SHALL** 在最终状态报告中包含该要求。

## 3. Non-Goals & Hard Constraints (业务禁区)
明确声明哪些内容**不在范围内**、哪些内容**被禁止**：
- **Out of Scope（不在范围内）**：创建或更改功能或缺陷修复、重新运行项目初始化、修改现有 specs/plans/tasks、更新无关的 DSH 插件、降级组件、自动重启 DSH，以及交互式确认提示。
- **Forbidden Behavior（禁止行为）**：在与现有更新路径并行的情况下重新实现上游更新逻辑；静默跳过三个组件中的任何一个；以总体成功消息掩盖某个组件的失败；更改带版本的 Spec Kit 模板或应用源码文件；破坏现有 `/sdd-setup` 或 `/sdd-implement` 行为。
- **Performance / Compatibility Bounds（性能 / 兼容性边界）**：单次调用在无需用户交互的情况下检查全部三个组件；在正常宽带连接下命令在五分钟内完成；更新后现有 dsh-sdd-kit 技能与工具继续照常工作。

## 4. Acceptance Criteria
- [ ] `AC-01`：在三个组件均落后的项目中调用 `/sdd-update`；输出包含三条不同的组件条目，每条均带有 before 标识、after 标识与结果，且总体结果为成功。
- [ ] `AC-02`: 在三个组件均已为最新时调用命令；每个组件均报告为 unchanged，其 before 与 after 标识相同，未观察到有效更新，且总体结果为 success。
- [ ] `AC-03`：模拟刷新 Superpowers 时的失败；Spec Kit 与 dsh-sdd-kit 仍会被尝试，Superpowers 被指明为失败，且总体结果为未成功。
- [ ] `AC-04`：在已安装的 dsh-sdd-kit 未配置来源的情况下调用命令；会显示明确的 dsh-sdd-kit 错误，且 Spec Kit 与 Superpowers 的状态仍然存在。
- [ ] `AC-05`：对比命令执行前后的项目 specs、plans、tasks 与应用源码文件；没有任何内容被新增、删除或改动。
- [ ] `AC-06`：在 dsh-sdd-kit 刷新需要重启 DSH 的场景中，最终报告明确说明需要重启；典型完成时间保持在五分钟以内。

### Success Criteria
- 全部三个受管组件在一次调用中被检查，没有任何未报告的组件。
- 每个组件条目都显示 before 标识、after 标识与结果。
- 用户无需检查内部状态即可确定哪个组件发生了变化、以及需要执行什么操作（如有）。
- 在正常宽带连接下，典型完成时间在五分钟以内。

## 5. Assumptions and Dependencies
- 该命令在已由 `/sdd-setup` 初始化的项目中运行。
- “配置的最新来源”指 Spec Kit 与 Superpowers 的已配置上游，以及已安装的 dsh-sdd-kit 的当前本地事实来源，与文档化的 profile-copy 工作流一致。
- 该命令复用 dsh-sdd-kit 已暴露的现有更新能力；不引入单独的并行更新器。
- 在需要更新时，能够通过网络访问已配置的上游。

## 6. Key Entities
- **Component Update Record**：每个受管组件（Spec Kit、Superpowers、dsh-sdd-kit）一条记录；字段为组件名称、before 标识、after 标识、结果，以及任何必需的后续操作。
