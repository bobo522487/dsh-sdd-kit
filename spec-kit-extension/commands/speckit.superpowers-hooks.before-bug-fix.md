---
description: 在 /speckit-bug-fix 修改源码前强制注入系统化调试与复现测试纪律
---

# Superpowers Hooks · 修复前

## 何时触发

`/speckit-bug-fix` 解析出 `slug` 并确认 `.specify/bugs/<slug>/assess.md` 存在之后、修改任何源码之前。

## 上游依赖检查

先确认 `~/.dsh/upstream/superpowers/skills` 存在，且下列技能目录齐全。
缺失任一项时，报告缺失的技能名、完整路径与修复命令 `/sdd-setup`（会重新同步上游镜像）并停止，不得凭记忆代替或自行推断根因。

## 必须加载的技能

| 技能名 | 加载方式 | 用途 |
|---|---|---|
| `systematic-debugging` | `skill` 工具，名称精确匹配 | 先复现、再定根因、禁止猜测式修补 |
| `test-driven-development` | `skill` 工具，名称精确匹配 | 先写能复现缺陷的失败测试 |

## 执行纪律

1. 加载 `systematic-debugging`，按其顺序复述根因假设与证据链；引用 `.specify/bugs/<slug>/assess.md` 的根因段作为起点。
2. 加载 `test-driven-development`，先写一个能复现该缺陷的失败测试，确认它确实红。
3. 只做最小改动让该测试转绿，再重构；不做与根因无关的顺手重构。
4. 每个原子改动一次 `git commit`（章程原则 IV，中文消息）。
5. 根因与评估报告不一致时，先更新评估报告，再继续修复。

## 出口条件

- 复现测试先红后绿；
- `npm test` 全部通过；
- 根因结论与评估报告一致，且已产生原子提交。

未复现缺陷前不得改源码。
