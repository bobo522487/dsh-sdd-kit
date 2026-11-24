---
description: 会话启动时注入 SDD 纪律与当前进度（session_start 事件）
scripts:
  sh: scripts/bash/guidance.sh --text
---

# Superpowers Hooks · 引导文本

由 `events.session_start` 自动调用 `scripts/bash/guidance.sh`，脚本委托
`bin/sdd-kit.mjs guidance --text` 输出与 DSH `systemPrompt` 完全同构的文本。
本文件本身只作为事件命令载体，不需要模型手动执行。
