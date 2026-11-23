---
name: sdd-update
description: Check and update the two upstream layers (Spec Kit CLI + Superpowers mirror) in one invocation with a per-component before/after report.
disable-model-invocation: true
---

# /sdd-update

一条命令刷新两层上游工具链：`specify` CLI 与本地 `obra/superpowers` 镜像。本技能是声明式命令：只委托一次并渲染结果，自身不包含任何更新逻辑。

**插件自身不在本命令职责内**：dsh-sdd-kit 的安装与升级由 DSH 包管理器负责（`dsh plugin --profile <profile> update dsh-sdd-kit --latest`，随后重启 DSH）。本插件不复制、不替换已安装的 profile 副本。

## 工作流

1. **仅在用户明确给出时收集可选参数**：`superpowersDir`、`repoUrl`、`python`、`cwd`。用户未指定时不要臆造。
2. **只委托一次**：调用 `sdd_upstream(action: "update_all", ...)`，这是本工作流中唯一的调用。不要调用其他 `sdd_upstream` 动作，也不要调用 `sdd_bridge`。
3. **渲染报告**：按固定顺序 `spec-kit`、`superpowers`，为返回的 `components` 数组逐条输出一行：

   ```text
   <组件>: <before> -> <after> [<outcome>]
   ```

   - `before` 或 `after` 为 `null` 时显示为 `-`。
   - 当记录的 `followUp` 非空时，追加其文本。
   - 追加总体行：`Overall: ok` 或 `Overall: failed (<n> 个组件)`，并把 `errors` 中每一项按 `<组件>: <message>` 列出。
4. **说明必须由用户执行的操作**：
   - `requiresRestart` 为 `true` 时，明确告知必须先重启 DSH，更新后的技能才会生效。
   - 否则说明无需重启。
   - 若用户想升级 dsh-sdd-kit 本身，给出包管理器命令 `dsh plugin --profile <profile> update dsh-sdd-kit --latest` 并提醒随后重启 DSH；不要尝试代替包管理器复制文件。
   - 绝不代替用户重启 DSH，也绝不弹出确认提示。
5. **不得修改项目产物**：`specs/`、`plan.md`、`tasks.md`、`.specify/` 与应用源码均在职责范围之外。若用户要求改动规范或任务，引导其使用对应的 `/speckit-*` 命令。

## 说明

- 已是最新的组件会返回 `unchanged`，且 `before` 与 `after` 相同；不要重试。
- 单个组件失败不会中断另一个组件；即使 `ok` 为 `false`，也必须报告全部记录。
