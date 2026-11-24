---
description: 实现阶段开始后拒绝回到澄清/规划阶段（只读护栏）
---

# Superpowers Hooks · 规划期护栏

## 触发时机

`/speckit.clarify` 与 `/speckit.plan` 开始前。

## 执行

运行扩展自带的只读包装脚本（不修改任何文件）：

```bash
sh .specify/extensions/superpowers-hooks/scripts/bash/guard.sh --json
```

- 退出码非 0 且输出 `status=error`、`code=E_PLANNING_GUARD` 时，停止当前命令，按输出的 `message`/`fix` 提示用户先回到定义阶段再规划。
- 退出码 0（`blocked=false`）时继续原命令。
- 输出「dsh-sdd-kit 未安装」时同样继续，不得凭猜测拦截。

判定依据是 `tasks.md` 中是否存在至少一项 `- [x]`；仅有未勾选任务不拦截。
