# 适配器实现索引（三面契约 + 重载语义）

约定名称始终是「三面契约 + 重载语义（四个必答项）」；不要使用「四面契约」别名。工具面 / 引导面 / 技能面 + 重载语义共同构成 `ThreeFaceContract`（`data-model.md`）。

## 实现索引

| 宿主 | 适配器 | 引导通道 | 技能目录 | 文档 |
|---|---|---|---|---|
| DSH | `src/adapters/dsh/index.mjs` | `ctx.systemPrompt.section` 常驻段（可选读取，不进 `inject`） | `.dsh/skills` | 本文件 + `research.md` R3 |
| Claude Code | `src/adapters/claude/index.mjs` | 扩展 `events.session_start`，失败降级托管块 | `.claude/skills` | [claude.md](claude.md) |
| Codex | `src/adapters/codex/index.mjs` | 项目级幂等托管块（`$` 参数前缀） | `.agents/skills` | [codex.md](codex.md) |
| Cursor | `src/adapters/cursor/index.mjs` | `.cursor/rules/sdd-kit-discipline.mdc` | `.cursor/skills` | [cursor.md](cursor.md) |

共享核心：`src/core/guidance.mjs`（文案与 token 预算）、`src/core/feature-phase.mjs`（进度指针）、`src/core/reload.mjs`（三态）、`src/core/marker.mjs`（待生效标记）、`src/core/doctor.mjs`（五区只读体检）、`src/core/trigger.mjs`（确定性打分）、`src/core/guard.mjs`（规划期护栏）、`src/core/action.mjs`（统一入口）。宿主差异唯一可编辑源：`src/core/host-capabilities.mjs` 的 `HOST_CAPABILITIES`。

## 新增宿主操作手册

1. 在 `HOST_CAPABILITIES` 增加一个冻结条目：`key` / `integrationKey` / `toolPrefix` / `skillsDir` / `guidanceChannel` / `guidanceConfig` / `reloadPolicy`（三值合法）/ `trustFlagPattern`（如有）。
2. 新建 `src/adapters/<host>/index.mjs`（≤100 行）：导出 `describeHost()`、`applyHostGuidance()`；只调用核心模块，不复制业务逻辑，不引入第三方依赖。
3. 新建 `test/adapters-<host>.test.mjs`：断言四面覆盖、托管块幂等、缺服务降级、文件行数上限。
4. 写 `docs/adapters/<host>.md`：三面表、引导通道选择理由与本机的 PoC 结论。
5. 运行 `npm run test:contract && npm run test:adapters && npm test`；核心纯度与同构断言必须全绿。
6. 若扩展钩子需要在新端生效，先确认该端成为 active integration；上游只向 active 端渲染扩展命令（`quickstart.md` 场景 8），不得自建第二套配置。

## 其他文档

- [止损线](stop-loss.md)：M1–M4 前置验证失败条件与降级/冻结处置。
- [quickstart.md](../../specs/004-multihost-runtime-governance/quickstart.md)：11 组端到端场景。
- [contracts/host-adapter.md](../../specs/004-multihost-runtime-governance/contracts/host-adapter.md)：契约原文。
