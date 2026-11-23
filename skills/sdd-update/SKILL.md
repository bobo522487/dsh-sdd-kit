---
name: sdd-update
description: Check and update Spec Kit, Superpowers, and the installed dsh-sdd-kit in one invocation with a per-component before/after report.
disable-model-invocation: true
---

# /sdd-update

一条命令刷新三层工具链：上游 Spec Kit（`specify` CLI）、本地 `obra/superpowers` 镜像，以及安装在当前 DSH profile 中的 dsh-sdd-kit 插件。本技能是声明式命令：只委托一次并渲染结果，自身不包含任何更新逻辑。

## 工作流

1. **仅在用户明确给出时收集可选参数**：
   - `dshKitSourceDir`：要复制进 profile 的本地 dsh-sdd-kit 检出目录。用户未指定时不要臆造——此时报告中该组件会给出清晰失败信息，其余两个组件仍会照常更新。
   - `dshProfileDir`：profile 根目录（默认取 `$DSH_PROFILE_DIR`，其次 `~/.dsh/profiles/${DSH_PROFILE:-web}`）。
   - `superpowersDir`、`repoUrl`、`python`、`cwd`：仅在用户给出时透传。
2. **只委托一次**：调用 `sdd_upstream(action: "update_all", ...)`，这是本工作流中唯一的调用。不要调用其他 `sdd_upstream` 动作，也不要调用 `sdd_bridge`。
3. **渲染报告**：按固定顺序 `spec-kit`、`superpowers`、`dsh-sdd-kit`，为返回的 `components` 数组逐条输出一行：

   ```text
   <组件>: <before> -> <after> [<outcome>]
   ```

   - `before` 或 `after` 为 `null` 时显示为 `-`。
   - 当记录的 `followUp` 非空时，追加其文本。
   - 追加总体行：`Overall: ok` 或 `Overall: failed (<n> 个组件)`，并把 `errors` 中每一项按 `<组件>: <message>` 列出。
4. **说明必须由用户执行的操作**：
   - `requiresRestart` 为 `true` 时，明确告知必须先重启 DSH，更新后的工具与技能才会生效。
   - 否则说明无需重启。
   - 绝不代替用户重启 DSH，也绝不弹出确认提示。
5. **不得修改项目产物**：`specs/`、`plan.md`、`tasks.md`、`.specify/` 与应用源码均在职责范围之外。若用户要求改动规范或任务，引导其使用对应的 `/speckit-*` 命令。

## 说明

- 已是最新的组件会返回 `unchanged`，且 `before` 与 `after` 相同；不要重试。
- 单个组件失败不会中断其他组件；即使 `ok` 为 `false`，也必须报告全部记录。
- 字段语义见 `specs/001-sdd-update-command/data-model.md`，输出规则见 `specs/001-sdd-update-command/contracts/sdd-update.contract.md`。
