# Cursor 适配器

## 三面与重载语义

| 面 | 实现 | 说明 |
|---|---|---|
| 工具面 | 原生调用前缀 `/` | 动作委托 `bin/sdd-kit.mjs`，输出与其他宿主同构 |
| 引导面 | 常驻规则文件 `.cursor/rules/sdd-kit-discipline.mdc` | 文本来自 `src/core/guidance.mjs` |
| 技能面 | `.cursor/skills`（`specify integration install cursor-agent`） | 上游集成键为 `cursor-agent` |
| 重载语义 | `tool_code=new_session; skill_data=new_session; extension_command=none` | 扩展命令变更无需重载 |

## 安全边界（REQ-31 / AC-17）

- `HOST_CAPABILITIES.cursor.trustFlagPattern` 是自动信任类参数的唯一可编辑源，匹配 `--trust` / `--approve-mcps` / `--force` / `-p`。
- 体检宿主区检测到这些参数会显式输出安全警告，并提示仅限受控项目使用。
- 插件默认写入的配置由 `cursorDefaultConfig()` 给出，只含通道、技能目录、调用前缀，**不含任何 trust 类参数**；默认值不开启自动信任。

## 通道选择理由（2026-11-24，本机）

Cursor 集成的 `multi_install_safe=True`，四端共存时 `.cursor/skills` 与其他技能目录互不覆盖；规则文件放在项目级 `.cursor/rules/`，避免改用户全局配置，符合章程「零分叉、单一可编辑源」。
