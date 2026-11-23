---
name: sdd-setup
description: Bootstrap or upgrade the Spec Kit × Superpowers stack in one delegated call, then render the step report.
disable-model-invocation: true
---

# /sdd-setup

一条命令完成 Spec Kit（做什么）× Superpowers（怎么做）技术栈的引导与升级。本技能是声明式命令：只委托一次并渲染结果，状态机在工具代码里，不在本文档里。

## 工作流

1. **收集参数**：`cwd` 默认当前仓库。仅当用户明确要求切换到 dsh 技能根时传 `switchIntegration: true`；仅当用户明确要求升级 specify-cli 时传 `upgrade: true`。其余可选参数（`superpowersDir`、`repoUrl`、`python`、`integration`、`extensionDir`）仅在用户给出时透传。
2. **只委托一次**：调用 `sdd_upstream(action: "setup", ...)`。不要自行调用其他动作，不要自行读取 `.specify/extensions.yml`。
3. **渲染报告**：按返回的 `steps` 数组逐行输出 `<name>: <status>`（`performed` / `skipped` / `failed`），failed 项附 detail。追加总体行 `Overall: ok` 或 `Overall: failed`。
4. **必须报告的字段**：`integration`、`skillsDir`、扩展 id/版本与四个钩子事件（在扩展安装步骤的 detail 里）。`integrationMismatch` 非空时，说明当前 integration 不在 DSH 技能根内，给出显式切换方式（传 `switchIntegration: true` 重跑本命令）；默认路径只报告，绝不自动切换。
5. **重启提示**：`restartRequired` 为 true（Superpowers 首次克隆）时，明确告知重启 DSH 一次以挂载上游技能。绝不代替用户重启。
6. **下一步**：`constitutionPresent` 为 false 时，邀请用户运行 `/speckit.constitution`。

## 边界

- 既有 `.specify/` 布局永不被重跑 init（REQ-15）；切换 integration 必须显式 opt-in（REQ-16）。
- 上游镜像同步失败不阻断扩展安装（REQ-11），但必须在报告中如实标 failed。
- 本技能不修改 `specs/`、`tasks.md` 与应用源码。
