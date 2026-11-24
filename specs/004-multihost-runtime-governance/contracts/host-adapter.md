# 宿主适配器三面契约与重载语义

> 唯一契约定义。新增宿主只需实现本文**三面契约 + 重载语义** + 在 `HOST_CAPABILITIES` 增一条，核心不改（`REQ-04/06`）。
> 每个 `src/adapters/<host>/index.mjs` ≤100 行，不得含业务判定（`REQ-03/07`）。
>
> **术语（全文统一）**：契约由「三面」加「重载语义」构成，共四个必答项，对应
> `data-model.md` 的 `ThreeFaceContract.toolFace` / `.guidanceFace` / `.skillFace` /
> `.reloadSemantics`。正文一律称「三面契约 + 重载语义」，**不**使用「四面契约」这一别名，
> 以免与「三面」的计数表述冲突。

## 通用约束

- 核心入口 `src/core/*.mjs`：零宿主包名、零 `ctx.`、零第三方依赖；静态断言测试 `test/contract-core-purity.test.mjs` 扫描并在违规时红。
- 工具面与 CLI 共享 `src/core/` 动作实现；共享样例 `test/contract-parity.test.mjs` 对同一输入断言输出 100% 同构（`REQ-14`）。
- 引导文案来自 `src/core/guidance.mjs` 单一拼装结果，各宿主不得自带文案副本（`REQ-13`）。
- 缺依赖/缺通道时一律降级不阻断（`REQ-11/27/39`）。

## 面 1：工具面（Tool Face）

| 项目 | 说明 |
|------|------|
| 输入 | 动作名 + 参数对象（与 `sdd_upstream` / `sdd_bridge` 现有字段兼容） |
| 宿主机制 | DSH：`registerSddTools(ctx, defineTool)` 注册的 `sdd_upstream` / `sdd_bridge`；非 DSH：`bin/sdd-kit.mjs` 子命令 |
| CLI 调用 | `node bin/sdd-kit.mjs <action> [--json]`，`parseArgs` 解析，stdout 输出 JSON |
| 降级 | 无宿主运行时只用 CLI；CLI 不 import 任何 `@deepseek-ai/*` |
| 等价 | 同一动作经工具面与 CLI 输出结构相同；新增字段为增量 |

## 面 2：引导面（Guidance Face）

| 宿主 | channel | 机制 | 降级 |
|------|---------|------|------|
| DSH | `system-prompt` | `ctx.get('systemPrompt')` → `section({name:'sdd-kit:discipline', text: assembleGuidance()})`；每步 assemble 抗压缩 | 服务缺失→不注册、留告警、插件照常加载 |
| Claude Code | `native-event` | 扩展 `events.session_start` 经上游写 `.claude/settings.json`，调用 `node <pkg>/bin/sdd-kit.mjs guidance` | 事件未生效→项目级托管块；插件缺失→一句安装提示 |
| Codex | `managed-block` | 项目级幂等托管块（标记包裹、重复执行幂等） | 块不可写→告警、其余功能可用 |
| Cursor | `rule-dir` | `.cursor/rules/sdd-kit-discipline.mdc` 常驻规则，内容同核心拼装 | 目录不可写→告警、其余功能可用 |

- 开关：用户全局级（默认开）+ 项目级覆盖；读开关不得改变技能目录或可用性；体检报告实际生效层级。
  - 全局级 `~/.dsh/sdd-kit.json` → `guidance.enabled`；项目级 `<repo>/.specify/sdd-kit.json` → `guidance.enabled`；缺省等价开启。
- 预算：≤1200 token；超限裁 SDD 指针、不裁上游原文、原文超限保留并告警。

## 面 3：技能面（Skill Face）

| 宿主 | 上游集成键 | 项目技能目录 | 调用前缀 |
|------|-----------|--------------|----------|
| DSH | `dsh` | `.dsh/skills` | `@` |
| Claude Code | `claude` | `.claude/skills` | `/` |
| Codex | `codex` | `.agents/skills` | `$` |
| Cursor | `cursor-agent` | `.cursor/skills` | `/`（自动信任参数仅受控项目） |

- 声明与检测官方渠道的纪律技能安装；缺失时仅告警不阻断。
- 多端共存时各目录互不覆盖，由上游 `multi_install_safe` 保证；体检识别全部已装集成，如实报告钩子仅渲染到 active 集成。
- 不迁移/改写用户自建普通技能（`REQ-46`）。

## 面 4：重载语义（Reload Semantics）

| 改动层 | DSH | Claude Code | Codex | Cursor |
|--------|-----|-------------|-------|--------|
| `tool_code` | restart_host | new_session | new_session | new_session |
| `skill_data` | new_session | new_session | new_session | new_session |
| `extension_command` | new_session | new_session | new_session | none |

- 判定唯一实现 `src/core/reload.mjs`；空改动集 → `none` 不落盘。
- 标记 `.specify/sdd-pending.json` 按 host 分条；宿主启动清当前 host 条目；体检按时间戳区分历史与本次。

## 扩展清单契约（spec-kit-extension/extension.yml）

- `requires.speckit_version: ">=1.4.0"`：安装期硬失败、无半装（上游 `check_compatibility` 保证，CI 用例固化）。
- 四个执行钩子 before/after_implement、before/after_bug_fix：`optional:false`，由上游按 active 集成渲染。
- 规划期只读护栏：`hooks.before_clarify` / `hooks.before_plan` → `node <pkg>/bin/sdd-kit.mjs guard`，只读 tasks.md，实现已开始则非零退出并提示回退定义阶段。
- 引导事件（Claude）：`events.session_start` 声明，由上游写原生 hook 配置；DSH 不支持 events，走 system-prompt。

## 体检契约

- 入口：`sdd_upstream({action:'doctor', trigger?})` / `node bin/sdd-kit.mjs doctor [--trigger "..."]`。
- 输出：五区（environment / host / repository / runtime / triggerDryRun），每区 `{status, items[]}`，每 item `{status, code, message, fix?}`。
- 零写、可重复、错误统一四字段；触发试跑只打分不执行。

### 触发试跑打分（`REQ-38`）

- 输入：任务描述字符串 + 可见技能列表（插件提供 + 用户级安装，不含仅存在于上游镜像而未安装者）。
- 输出：`TriggerScore[]`，字段与排序规则见 `data-model.md` 的 `TriggerScore`；同分按 `name` 字典序升序再按 `provider` 升序，保证重复执行结果逐字一致。
- 约束：不执行任何技能、不写任何文件；镜像缺失时仍返回结果且该区 `status` 不为 `fail`；`score=0` 的可见技能仍列出。
- 性能：100 条技能规模内 ≤1 秒（`REQ-38` + 性能边界），实现 MUST 为单趟线性打分，MUST NOT 引入索引或缓存文件。
