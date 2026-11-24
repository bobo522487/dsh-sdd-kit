# 止损线（v1.0 多宿主治理层）

逐里程碑的前置验证失败处置。原则：任何里程碑都不以未验证状态叠加；降级后功能仍可用，且只回退当前层，不复制上游逻辑。

| 里程碑 | 版本 | 前置验证 | 触发条件 | 预设处置 |
|---|---|---|---|---|
| M1 | v0.6.0 | 打包形态 `ctx.systemPrompt` 可达（`research.md` R3 / T058） | `ctx.get('systemPrompt')` 在真实宿主镜像中返回 `undefined`，或 `section()` 抛错 | 按 REQ-44 降级为固定注入（技能/规则文件），保留 CLI 与核心动作；扩展事件不启用 |
| M2 | v0.7.0 | 引导段在模拟压缩后仍存在（`research.md` R3 / T059） | 每步 `assemble()` 行为变更导致常驻段丢失，或 1.2k token 上限无法容纳合法指针 | 保留上游 name+description 原文与工具映射，清空 SDD 指针并记录告警；延后扩展钩子到 M3 |
| M3 | v0.8.0 | 规划期只读护栏与扩展事件在本机验证（`quickstart.md` 场景 8） | `before_clarify`/`before_plan` 被上游判为非法 hook，或 `events.session_start` 不执行 | 护栏退化为 CLI `guard` 手动调用；引导退化为 Claude 托管块；不自建第二套钩子写者 |
| M4 | v0.9.0+ | Codex/Cursor 纪律技能安装方式可行（`quickstart.md` 场景 8 / T060） | 单端维护成本拖慢主线，或任一宿主 peer 下界无法在宿主环境确认 | 冻结后续端开发，只保留已验证端；peer 下界维持未决并在发布说明中显式标注；CI 矩阵无凭据时按 `not_executed` 报告，不得记通过 |

## M1 门槛：引导服务可达（不依赖真实宿主进程）

```sh
node bin/sdd-kit.mjs guidance --json --host dsh
```

断言：

- `enabled === true`（`effectiveScope` 为 `project` 或 `user` 均可）；
- `typeof upstreamText === 'string'` 且 `upstreamText.length > 0`；
- `tokenEstimate <= 1200`（`src/core/guidance.mjs` 的 `TOKEN_BUDGET`）；
- 退出码为 `0`。

自动化守护：`test/guidance.test.mjs`（断言 token 预算 1200 与原文非空），`test/contract-parity.test.mjs`（断言 CLI 与 `runAction` 同构）。

判负即触发 M1 处置：按 REQ-44 降级为固定注入，保留 CLI 与核心动作，扩展事件不启用。

## M2 门槛：压缩后引导仍在（模拟压缩，不压缩真实会话）

```sh
node bin/sdd-kit.mjs guidance --text --host dsh
node bin/sdd-kit.mjs guidance --json --host dsh
```

断言：

- `--text` 输出包含 `## SDD 运行时纪律`；
- `--json` 的 `warnings` 不含 token 超限告警，且 `tokenEstimate <= 1200`；
- 连续两次调用输出完全一致（同一输入 → 同一拼装；常驻段按步重算即可复现）。

自动化守护：`test/guidance.test.mjs`（含超预算只裁 SDD 指针、不裁上游原文的用例）。

判负即触发 M2 处置：保留上游 name+description 原文与工具映射，清空 SDD 指针并记录告警，扩展钩子延后到 M3。

## M3 门槛：只读护栏与扩展事件声明

```sh
node bin/sdd-kit.mjs doctor --json --host dsh
node scripts/verify-upstream.mjs --json
```

断言：

- `doctor` 的 `host` 区 `EXTENSION_STATE` 为 `pass`，`HOOK_RENDERING` 不为 `fail`；
- `doctor` 的 `repository` 区 `COMMAND_SKILLS` 为 `pass`；
- `verify-upstream` 的 `hooks-registered` 检查 `ok === true`（六个执行钩子各注册一次，且 manifest 含 `session_start`）；
- `spec-kit-extension/extension.yml` 同时声明 `before_clarify`、`before_plan` 与 `events.session_start`。

自动化守护：`test/doctor.test.mjs`（五区逐项状态），`test/ci-matrix.test.mjs`（CI 门禁要求 `EXTENSION_STATE`/`COMMAND_SKILLS`/`TEMPLATE_DRIFT` 必须 pass）。

判负即触发 M3 处置：护栏退化为 CLI `guard` 手动调用，引导退化为 Claude 托管块，不自建第二套钩子写者。

## M4 门槛：peer 下界与 CI 凭据

实测来源（T100，2026-11-24）：本机 `node_modules/@deepseek-ai` 不存在，但当前生效的 DSH 运行时自带三项 peer；直接读取其 `package.json`（未改 profile、未联网安装、未编造版本）：

- `@deepseek-ai/cordis@4.1.0` — `/home/bobo/.nvm/versions/node/v26.13.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/package.json`（DSH 自身声明 `~4.1.0`）
- `@deepseek-ai/dsh-skill-filesystem@0.2.2-rc.3` — `/home/bobo/.nvm/versions/node/v26.13.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-skill-filesystem/package.json`
- `@deepseek-ai/dsh-tools@0.2.2-rc.3` — `/home/bobo/.nvm/versions/node/v26.13.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/package.json`

宿主本体为 `/home/bobo/.nvm/versions/node/v26.13.1/lib/node_modules/@deepseek-ai/dsh/package.json`（`0.2.2-rc.3`）。以上观测到的安装版本即保守下界；没有这些 peer 的宿主仍由 `peerDependenciesMeta.<name>.optional: true` 放行。

```sh
npm ls --depth=0
npm run verify:compat          # = node --test test/compat.test.mjs
node scripts/verify-upstream.mjs --json
```

真实宿主 CI 可在运行 `npm run verify:compat` 时设置 `DSH_SDD_KIT_HOST_MODULES=/path/to/host/node_modules`，追加"已安装 peer 满足下界"探针；该可选开关不属于上面的常态命令。

断言：

- `package.json` 的 `peerDependencies` 为 `>=4.1.0`、`>=0.2.2-rc.3`、`>=0.2.2-rc.3`（正是上述实测版本），且三项 `peerDependenciesMeta.<name>.optional === true`；`research.md` 旧条目仍写 `*`，由 lead 决定是否回填（本任务文件清单不含它）。
- `npm run verify:compat` 常态全绿：安装期下界硬失败用例与预发布用例均执行，不再依赖 `DSH_SDD_KIT_INTEGRATION`；常态 CI 在安装 specify 后显式设置 `DSH_SDD_KIT_INTEGRATION=1` 标记集成探测通道，工具缺失时用例以 `not_executed (REQ-42)` 明确失败且进程退出码非零，绝不静默 skip；`DSH_SDD_KIT_HOST_MODULES` 只用于把已安装 peer 探针带到真实宿主 CI，未设置时仍明确 skip 而非伪绿。常态 CI（`.github/workflows/upstream-integration.yml`）每轮都跑该脚本。
- 失败安装必须同时断言非零退出码、`Compatibility Error` 与零残留：`.specify/extensions/superpowers-hooks` 不存在、`.specify/extensions.yml` 未注册、`.dsh/skills` 无 `speckit-superpowers-hooks-*` 渲染产物。
- `verify-upstream` 报告 `versionDrift.needsAdjustment === false`；若为 `true`，按 `versionDrift.suggestedBound` 调整 `spec-kit-extension/extension.yml` 的 `requires.speckit_version`。
- CI 无凭据时报告 `status === 'not_executed'`：T099 起验证器进程自身即以退出码 1 失败，workflow 的 `status !== 'passed'` 与 `needsAdjustment` 门禁继续二次拦截，绝不当成功。

自动化守护：`test/compat.test.mjs`（实测下界、预发布语义、可选宿主探针、常态安装期下界硬失败与零残留）、`test/ci-matrix.test.mjs`（常态 CI 接线、漂移门禁与 `not_executed` 不得当成功）、`test/phase15-ci.test.mjs`（T107 下界用例常态执行、进程退出码与 CI 接线回归）。

判负即触发 M4 处置：冻结后续端开发，只保留已验证端；若某宿主版本低于下界，以该宿主实际版本为准重测并更新下界与本报告，不得回退到 `*` 掩盖问题。

零分叉约束（所有里程碑）：核心目录禁止 `@deepseek-ai/*` 与 `ctx.` 引用（`test/contract-core-purity.test.mjs`）；用户自建技能零改写（`test/boundary.test.mjs`）；CLI 与 Host 工具共调 `src/core/action.mjs` 的同一实现，不产生第二份可编辑源。
