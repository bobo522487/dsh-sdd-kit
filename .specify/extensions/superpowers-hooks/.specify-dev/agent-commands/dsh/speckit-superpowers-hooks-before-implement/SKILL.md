---
name: speckit-superpowers-hooks-before-implement
description: 在 /speckit.implement 写第一行源码前强制注入严格 TDD 与根因调试纪律
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: dsh-sdd-kit
  source: superpowers-hooks:commands/speckit.superpowers-hooks.before-implement.md
  version: 0.1.0
---

# Superpowers Hooks · 实现前

## 何时触发

`/speckit.implement` 读取 `tasks.md` 并选定第一个未完成任务之后、写入任何源码之前。

## 上游依赖检查

先确认 `~/.dsh/upstream/superpowers/skills` 存在，且下列技能目录齐全。
缺失任一项时，报告缺失的技能名、完整路径与修复命令 `/sdd-setup`（会重新同步上游镜像）并停止，不得凭记忆代替或自行改写纪律。

## 必须加载的技能

| 技能名 | 加载方式 | 用途 |
|---|---|---|
| `test-driven-development` | `skill` 工具，名称精确匹配 | Red→Green→Refactor 循环 |
| `systematic-debugging` | `skill` 工具，名称精确匹配 | 非预期失败先定根因 |

## 执行纪律

1. 加载 `test-driven-development`，按它的循环推进；本钩子只规定顺序，不重述循环内容。
2. 每个任务先写失败测试并确认红（Red），再写最小实现转绿（Green），最后重构（Refactor）。
3. 测试出现非预期失败时，加载 `systematic-debugging` 定位根因；禁止猜测式修补。
4. 一次只推进一个任务；完成即 `git commit`（章程原则 IV，中文消息）。
5. 勾选 `tasks.md` 前必须 `npm test` 通过。

## 出口条件

- 所选任务的测试经历「红 → 绿」；
- `npm test` 全部通过；
- 已产生一次原子提交。

不满足任一条时，不得勾选该任务，也不得进入下一个任务。