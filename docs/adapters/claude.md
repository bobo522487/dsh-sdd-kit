# Claude Code 适配器

## 三面与重载语义

| 面 | 实现 | 说明 |
|---|---|---|
| 工具面 | `bin/sdd-kit.mjs`（`/` 前缀技能调用 CLI） | 动作委托 `src/core/action.mjs`，与 DSH 宿主工具输出同构 |
| 引导面 | `events.session_start`（默认）→ `.claude/sdd-kit-discipline.md`（降级） | 文本由 `src/core/guidance.mjs` 单一来源生成 |
| 技能面 | `.claude/skills`（`specify integration install claude`） | 扩展命令仅渲染到 active 集成 |
| 重载语义 | `new_session`（三层同值） | 工具代码、技能数据、扩展命令变更均需新会话 |

## 通道选择的最小验证（2026-11-24，本机）

- `specify 1.4.4.dev0`：扩展清单增加 `events.session_start` 后，`specify extension add --dev ./ext` 成功；随后 `specify integration install claude` 生成 `.claude/settings.json`，其中 `SessionStart` hook 调用 `.specify/events.py speckit.superpowers-hooks.guidance session_start 10`。
- 运行该事件脚本输出与 `node bin/sdd-kit.mjs guidance --text` 完全同构的文本（同一 `formatGuidanceText`）。
- DSH 集成没有 `events_config_file`，故 DSH 必须走 `ctx.systemPrompt`；Claude 可走原生事件。
- 若宿主未安装/未启用 `events.session_start`，`applyClaudeGuidance({ nativeEventsAvailable:false })` 落幂等托管块，重复执行字节一致；缺纪律技能只给安装提示，不阻断宿主其余功能。

## 选择理由

原生事件由上游写入宿主配置，避免本包自建第二处原生 hook 写者，符合章程原则 I「单一可编辑源」；托管块仅作降级，保证引导不会因插件缺失而完全消失。
