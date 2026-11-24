# 止损线（v1.0 多宿主治理层）

逐里程碑的前置验证失败处置。原则：任何里程碑都不以未验证状态叠加；降级后功能保持可用，且只回退当前层，不复制上游逻辑。

| 里程碑 | 版本 | 前置验证 | 触发条件 | 预设处置 |
|---|---|---|---|---|
| M1 | v0.6.0 | 打包形态 `ctx.systemPrompt` 可达（`research.md` R3 / T058） | `ctx.get('systemPrompt')` 在真实宿主镜像中返回 `undefined`，或 `section()` 抛错 | 按 REQ-44 降级为固定注入（技能/规则文件），保留 CLI 与核心动作；扩展事件不启用 |
| M2 | v0.7.0 | 引导段在模拟压缩后仍存在（`research.md` R3 / T059） | 每步 `assemble()` 行为变更导致常驻段丢失，或 1.2k token 上限无法容纳合法指针 | 保留上游 name+description 原文与工具映射，清空 SDD 指针并记录告警；延后扩展钩子到 M3 |
| M3 | v0.8.0 | 规划期只读护栏与扩展事件在本机验证（`quickstart.md` 场景 8） | `before_clarify`/`before_plan` 被上游判为非法 hook，或 `events.session_start` 不执行 | 护栏退化为 CLI `guard` 手动调用；引导退化为 Claude 托管块；不自建第二套钩子写者 |
| M4 | v0.9.0+ | Codex/Cursor 纪律技能安装方式可行（`quickstart.md` 场景 8 / T060） | 单端维护成本拖慢主线，或任一宿主 peer 下界无法在宿主环境确认 | 冻结后续端开发，只保留已验证端；peer 下界维持未决并在发布说明中显式标注；CI 矩阵无凭据时按 `not_executed` 报告，不得记通过 |

零分叉约束（所有里程碑）：核心目录禁止 `@deepseek-ai/*` 与 `ctx.` 引用（`test/contract-core-purity.test.mjs`）；用户自建技能零改写（`test/boundary.test.mjs`）；CLI 与 Host 工具共调 `src/core/action.mjs` 的同一实现，不产生第二份可编辑源。
