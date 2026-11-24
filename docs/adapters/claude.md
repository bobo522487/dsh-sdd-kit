# Claude Code 适配器

## 三面与重载语义

| 面 | 实现 | 说明 |
|---|---|---|
| 工具面 | `bin/sdd-kit.mjs`（`/` 前缀技能调用 CLI） | 动作委托 `src/core/action.mjs`，与 DSH 宿主工具输出同构 |
| 引导面 | `events.session_start`（默认）→ `.claude/sdd-kit-discipline.md`（降级） | 文本由 `src/core/guidance.mjs` 单一来源生成 |
| 技能面 | `.claude/skills`（`specify integration install claude`） | 扩展命令仅渲染到 active 集成 |
| 重载语义 | `new_session`（三层同值） | 工具代码、技能数据、扩展命令变更均需新会话 |

## 启用方式

默认宿主是 DSH；让插件在 Claude Code 项目里落引导面时，显式声明宿主：

```bash
DSH_SDD_KIT_HOST=claude dsh   # 或在 ctx 上提供 sddKitHost: 'claude'
```

`src/index.mjs` 的 `apply` 用 `resolveGuidanceHost({ctx, env})` 选出宿主后调用
`applyClaudeGuidance`，并把它包在 `.catch()` 里：Claude 侧任何失败都不会阻断
DSH 工具注册（T086）。

## 开关与空上游（T067/T069）

- `applyClaudeGuidance` 先看 `bundle.enabled`。开关关闭（`.specify/sdd-kit.json`
  的 `guidance.enabled=false`，或用户级 `~/.dsh/sdd-kit.json`）时不写任何文件，
  返回 `{ enabled: false, written: false }`，不抛错。
- 镜像缺失或镜像内没有可见纪律技能时 `upstreamText` 为空：同样不落盘
  （`written: false`），`enabled` 仍由开关决定（为 `true`），`warnings` 原样返回
  给调用方，插件加载不受影响。
- `written` 仅在「开关开启 + 上游文本非空 + 原生事件不可用」三者同时成立时为
  `true`。

## 缺插件判据（T085）

`isDisciplineSkill(name)` 是纯函数：上游命令技能 `/^speckit-/`，或纪律技能名
（`test-driven-development`、`writing-plans`、`systematic-debugging` 等）。
`hasDisciplineSkills(entries)` 只做 `some` 聚合。**不再**把本套件自己的
`sdd-setup`/`sdd-update` 当作证据——它们本来就未必出现在 `skillsDir` 里。
缺技能只产出 `installHint`（指向 `specify integration install claude` 或
`specify extension add --dev spec-kit-extension`），不阻断宿主其余功能。

## 托管块标记（T087）

`claudeManagedBlock(text, markers = MARKERS)` 是薄包装：标记取自
`HOST_CAPABILITIES.claude.guidanceConfig` 的 `markerStart`/`markerEnd`（核心已补齐；
旧能力表缺字段时回落到 codex 的同一对），adapter 内不再硬编码第二份
`<!-- sdd-kit:discipline:start/end -->`；`markers` 可注入，
便于将来把标记下沉到核心时零改动切换。adapter 只做格式化与 IO，不含
`bundle.toolMapping`/`bundle.sddPointer` 的任何业务判定。

## 待办标记清理（T081）

`applyClaudeGuidance` 启动时先 `clearMarker({ cwd, host: CAP.key })`，只清本仓库
本宿主（`claude`）的 `.specify/sdd-pending.json` 条目，其它宿主的条目原样保留；
清理失败用 `.catch(() => {})` 吞掉，不阻断引导文本产出与宿主工具加载。

## 通道选择的最小验证（2026-11-24，本机）

- `specify 1.4.4.dev0`：扩展清单增加 `events.session_start` 后，`specify extension add --dev ./ext` 成功；随后 `specify integration install claude` 生成 `.claude/settings.json`，其中 `SessionStart` hook 调用 `.specify/events.py speckit.superpowers-hooks.guidance session_start 10`。
- 运行该事件脚本输出与 `node bin/sdd-kit.mjs guidance --text` 完全同构的文本（同一 `formatGuidanceText`）。
- DSH 集成没有 `events_config_file`，故 DSH 必须走 `ctx.systemPrompt`；Claude 可走原生事件。
- 若宿主未安装/未启用 `events.session_start`，`applyClaudeGuidance({ nativeEventsAvailable:false })` 落幂等托管块，重复执行字节一致；缺纪律技能只给安装提示，不阻断宿主其余功能。

## 选择理由

原生事件由上游写入宿主配置，避免本包自建第二处原生 hook 写者，符合章程原则 I「单一可编辑源」；托管块仅作降级，保证引导不会因插件缺失而完全消失。
