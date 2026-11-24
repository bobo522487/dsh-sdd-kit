# Codex 适配器

## 三面与重载语义

| 面 | 实现 | 说明 |
|---|---|---|
| 工具面 | 宿主原生命令前缀 `$` | 动作委托 `bin/sdd-kit.mjs`，与 DSH 宿主工具输出同构 |
| 引导面 | 项目级幂等托管块 `.codex/sdd-kit-discipline.md` | `<!-- sdd-kit:discipline:start/end -->` 标记，重复执行字节一致；文本来自 `src/core/guidance.mjs` |
| 技能面 | `.agents/skills`（`specify integration install codex`） | 由上游渲染扩展命令 |
| 重载语义 | `new_session`（三层同值） | 工具代码、技能数据、扩展命令变更均需新会话 |

## 通道选择的最小验证与理由（2026-11-24，本机）

- Codex 集成声明 `events_config_file`，但本包未为其声明 `events.session_start`；采用托管块不依赖宿主事件可用性，且可在无 Codex 运行时的环境用纯文件测试验证幂等性。
- 托管块每端各一份、互不覆盖；写入只在项目级 `.codex/`，不修改用户全局配置。

详见 `contracts/host-adapter.md` 与 `data-model.md`。
