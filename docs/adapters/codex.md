# Codex 适配器

## 三面与重载语义

| 面 | 实现 | 说明 |
|---|---|---|
| 工具面 | 宿主原生命令前缀 `$` | 动作委托 `bin/sdd-kit.mjs`，与 DSH 宿主工具输出同构 |
| 引导面 | 项目级幂等托管块 `.codex/sdd-kit-discipline.md` | `<!-- sdd-kit:discipline:start/end -->` 标记，重复执行字节一致；文本来自 `src/core/guidance.mjs` |
| 技能面 | `.agents/skills`（`specify integration install codex`） | 由上游渲染扩展命令 |
| 重载语义 | `new_session`（三层同值） | 工具代码、技能数据、扩展命令变更均需新会话 |

## 启用方式（T086）

默认宿主是 DSH；要在 Codex 项目里落托管块，显式声明宿主：

```bash
DSH_SDD_KIT_HOST=codex dsh      # 或在 ctx 上提供 sddKitHost: 'codex'
```

`src/index.mjs` 的 `apply` 经 `resolveGuidanceHost({ctx, env})` 选中 `codex` 后
调用 `applyCodexGuidance`；该调用被 `.catch()` 包裹，写文件失败或宿主不支持
都只影响引导面，不会阻断 DSH 工具加载。未知的 `DSH_SDD_KIT_HOST` 值回退到
`dsh`，不会让启动报错。

## 开关与空上游（T067/T069）

- 先看 `bundle.enabled`：开关关闭时不写 `.codex/sdd-kit-discipline.md`，返回
  `{ enabled: false, written: false }`，不抛错。
- 镜像缺失/无可见纪律技能导致 `upstreamText` 为空时同样不落盘
  （`written: false`），`enabled` 仍按开关为 `true`，`warnings` 返回给调用方。

## 待办标记清理（T081）

`applyCodexGuidance` 启动时先 `clearMarker({ cwd, host: CAP.key })`，只清本仓库
`codex` 这一条 `.specify/sdd-pending.json` 记录，其它宿主（如 `dsh`）的条目原样
保留；清理失败（只读目录等）用 `.catch(() => {})` 吞掉，引导照常产出、宿主工具
照常加载。

## 通道选择的最小验证与理由（2026-11-24，本机）

- Codex 集成声明 `events_config_file`，但本包未为其声明 `events.session_start`；采用托管块不依赖宿主事件可用性，且可在无 Codex 运行时的环境用纯文件测试验证幂等性。
- 托管块每端各一份、互不覆盖；写入只在项目级 `.codex/`，不修改用户全局配置。
- 标记的唯一来源是 `HOST_CAPABILITIES.codex.guidanceConfig` 的
  `markerStart`/`markerEnd`；adapter 只做格式化与 IO。

详见 `contracts/host-adapter.md` 与 `data-model.md`。
