# 004-multihost-runtime-governance 研究报告

**日期**：2026-11-24 | **Spec**：`specs/004-multihost-runtime-governance/spec.md`
**取证方式**：全部结论来自本机实测（specify `1.4.4.dev0`、uv、Node `v26.13.1`、`npm pack`、Cordis / DSH 类型声明）；一次性探针目录 `.probe-plan-G84H/`、`.probe-peer-tmp/`、`.probe-peer-xwxU/` 用完即删。

---

## R1 核心与宿主的接缝（REQ-01/02/06/45）

- **Decision**：保留现有 `src/core/*.mjs`（已零宿主依赖）作为唯一宿主无关核心，新增纯模块 `guidance.mjs` / `reload.mjs` / `marker.mjs` / `doctor.mjs` / `trigger.mjs` / `guard.mjs` / `host-capabilities.mjs` 全部置于 `src/core/`；新增静态断言测试扫描 `src/core/` 不得出现 `@deepseek-ai/`、`ctx.`、`require(`、宿主目录名。
- **Rationale**：实测 `grep -rn "^import\|require(" src/core/*.mjs | grep -v "node:"` 只有内部 `./x.mjs` 互引，`grep -rn "deepseek-ai\|cordis\|ctx\." src/core/*.mjs` 无输出——接缝已经存在，抽离是补全而非重写，`REQ-45` 回归面最小。
- **Alternatives considered**：把核心抽到新包 → 违反单仓库单包（性能边界）；运行期抽查 → 违反 `REQ-02` 静态扫描要求。

## R2 三面契约与唯一事实源（REQ-03/04/06/07/32）

- **Decision**：`src/core/host-capabilities.mjs` 导出 `HOST_CAPABILITIES`（dsh/claude/codex/cursor 四键，每键含 integrationKey、toolPrefix、skillsDir、guidanceChannel、reloadPolicy、trustFlags），为宿主差异的唯一可编辑源；`contracts/host-adapter.md` 定义工具面/引导面/技能面的输入、机制、降级。每个 `src/adapters/<host>/index.mjs` ≤100 行，只做接线。
- **Rationale**：实测四端 `multi_install_safe=True`、技能目录互不覆盖（`.dsh/skills` / `.claude/skills` / `.cursor/skills` / `.agents/skills`），上游已提供共存语义；差异可用一张表表达。
- **Alternatives considered**：每端复制一套逻辑 → 违反 `REQ-46` 零分叉；把能力表放扩展或 profile → 多份可编辑源。

## R3 DSH 引导通道（REQ-08~13/43）

- **Decision**：引导文案由 `src/core/guidance.mjs` 同一份拼装；DSH 适配用 `ctx.get('systemPrompt')` 可选读取并调用 `systemPrompt.section({name:'sdd-kit:discipline', order: getSectionOrder('PLAN_POLICY')+1, text})`，**不**把 `systemPrompt` 写入 `inject` 数组。
- **Rationale**：Cordis `Inject` 无 optional 语法（数组即必需，缺失插件不加载），而 `ctx.get(name, strict?)` 缺失返回 undefined——这是 `REQ-11`「引导缺失不阻断加载」的唯一安全路径。实测打包形态可达：`dsh-base/cordis.patch.yml:525-526` 注册 system-prompt 服务。抗压缩：`dsh-agent-loop/lib/index.js:692 preStep()` 每步 `systemPrompt.assemble()`，:863 `systemPrompt.project(...,{inHistory})` 投影进历史 → 常驻段按步重算，压缩后仍在，满足 `REQ-10`。
- **Alternatives considered**：注入 `inject=['tools','systemPrompt']` → 引导服务缺失时插件整体不加载（违反 REQ-11）；一次性塞进消息历史 → 压缩即丢失（违反 REQ-10）。
- **前置验证记录（T058，2026-11-24）**：本机检查 `~/.dsh/profiles/web/dsh-base/cordis.patch.yml:525-526` 注册 `id: system-prompt` / `name: @deepseek-ai/dsh-system-prompt`，并核对打包形态的 profile bundles 含 `dsh-sdd-kit`；`ctx.get('systemPrompt')` 可达，M1 闸门通过，无需降级为固定注入。
- **前置验证记录（T059，2026-11-24）**：`dsh-agent-loop/lib/index.js:692` 在每步 `preStep()` 调 `systemPrompt.assemble()`，:863 调 `systemPrompt.project(renderedPrompt,{inHistory})`，常驻段按步重算并投影进历史；模拟压缩后该段随下一步重新组装，M2 闸门通过。

## R4 外部宿主引导面定型（REQ-26/29/30）

- **Decision**：Claude/Codex/Cursor 统一走**同一份核心拼装结果**，落盘形态各异：Claude Code 采用扩展 `events.session_start` 由上游写 `.claude/settings.json` 原生钩子（最小验证：上游 `events/__init__.py:1075` 支持扩展声明 session_start、`:513` 有 sessionID 缓存；`claude` 集成有 events_config_file）；Codex 用项目级幂等托管块（`.codex/` 侧 AGENTS.md 型）；Cursor 用常驻规则目录 `.cursor/rules/`。DSH 无 events_config_file，只能走 R3。
- **Rationale**：`spec-kit-extension/extension.yml` 当前无 `events:` 段，新增后由上游 `IntegrationBase.setup()` 写宿主原生配置，避免自建钩子写者（契合章程「单一可编辑源」）。实测 `collect_extension_events()` 扫描 `.specify/extensions/*/extension.yml` 的 `events:`，按目录合并、扩展禁用即失效；上游自带 `extensions/agent-context` 证明「扩展 + 钩子更新宿主上下文」是既有范式。
- **Alternatives considered**：四端都写托管块 → DSH 无对应原生块且需自建写者；四端都写钩子 → DSH 不支持 events_config_file，且需自行维护四份 hook 配置。

## R5 引导 token 预算与裁剪次序（REQ-08/09）

- **Decision**：`assembleGuidance()` 估算 token = CJK 字符数×1 + 非 CJK `ceil(chars/3.5)`，硬上限 1200；超限先裁 SDD 指针，上游原文完整保留并记录告警，绝不整体放弃注入。上游纪律正文只引用 name + description（实测 15 条 name+description 合计约 756 tok，余量供工具名映射与 SDD 指针）；不整段复制 SKILL.md（实测 test-driven-development 2731 tok、systematic-debugging 2716 tok，单篇即超限）。
- **Rationale**：REQ-09 明确上游原文不可裁剪，只有 SDD 指针可裁；以「引用而非复制」满足 REQ-08 且不触碰 1.2k 上限。
- **Alternatives considered**：摘要上游正文 → 违反「引用而非复制／不可裁剪」；提高上限 → 违反硬上限。

## R6 三态重载与待生效标记（REQ-15~20）

- **Decision**：`src/core/reload.mjs` 唯一实现 `decideReload(changes, host)` → `restart_host` / `new_session` / `none`；改动层取 `tool_code` / `skill_data` / `extension_command` 的并集查宿主能力表；标记落 `.specify/sdd-pending.json`（按仓库共享、按宿主分条，键为 host，字段 layer/timestamp/reason/host）；宿主启动钩子读当前条目并清除（仅清当前 host）；体检按 timestamp 判定历史遗留。空改动 → `none` 且不落盘。
- **Rationale**：澄清结论为「按仓库共享、按宿主分条记录」；单一文件 + host 键即可同时可见且互不覆盖，无需数据库或多文件。
- **Alternatives considered**：每宿主独立文件 → 无法「同一仓库两端同时可见」；不带 host 键 → 互相覆盖。

## R7 扩展版本下界（REQ-24/AC-14）

- **Decision**：`spec-kit-extension/extension.yml` 保持 `requires.speckit_version: ">=1.4.0"`，不改代码；以 CI 用例固化「低于下界安装失败、不留半装」。
- **Rationale**：实测 `extensions/__init__.py:2432-2467 check_compatibility()` 在任何文件写入前抛 `CompatibilityError`，`>=99.0.0` → 退出码 1 且 `.specify/extensions/` 无残留；`version_satisfies` 用 `specifier.contains(current, prereleases=True)`（解析失败返回 False），`1.4.4.dev0` 对 `>=1.4.4` 判失败、对 `>=1.4.0` 通过 → 预发布结论确定，符合 REQ-24。
- **Alternatives considered**：自己实现版本校验 → 违反零分叉；放宽为 `>=1.0.0` → 失去护栏意义。
- **T107 常态执行记录（2026-11-24）**：`test/compat.test.mjs` 的 `>=99.0.0`、`>=1.4.4`、`>=1.4.0` 安装用例从 `DSH_SDD_KIT_INTEGRATION` skip 中移出，常态随 `npm run verify:compat` 执行；CI 在安装 specify 后以 `DSH_SDD_KIT_INTEGRATION=1` 显式开启集成探测通道。失败安装断言退出码非零、`Compatibility Error`、无 `.specify/extensions/superpowers-hooks` 目录、无 `.specify/extensions.yml` 注册与无渲染 hook 技能残留；缺失 specify 时按 `not_executed (REQ-42)` 明确失败而非静默 skip，进程退出码非零。此记录只覆盖扩展版本下界语义，不改 R8 的 peer 下界结论。

## R8 peerDependencies 收口（REQ-21/AC-11）

- **Decision**：`package.json` 三个 peer 加 `peerDependenciesMeta.<name>.optional = true`；版本串按 DSH 0.2.2-rc.3 宿主实测收紧为 `@deepseek-ai/cordis >=4.1.0`、`@deepseek-ai/dsh-skill-filesystem >=0.2.2-rc.3`、`@deepseek-ai/dsh-tools >=0.2.2-rc.3`，并由 `npm run verify:compat` 常态校验。
- **Rationale**：实测当前 `npm pack` 在裸 consumer `added 26 packages`（npm 7+ 自动装 peer，无 warning 但强制安装）；加 `peerDependenciesMeta.optional:true` 后只 `added 1 package`、无 warning。宿主环境下可选 peer 仍会被满足，既有行为不变。
- **Alternatives considered**：仅加 warning 文案 → 不改变 npm 强制安装；删除 peer → 宿主环境丢失类型与能力声明。

## R9 四端钩子等价与多端共存（REQ-22/25/AC-12）

- **Decision**：REQ-22 的「等价生效」解释为**当某端成为 active integration 时四个执行钩子在该端等价渲染**；体检宿主区如实报告每端扩展命令渲染状态（实测 `.dsh/skills` 与 `.cursor/skills` 未激活时钩子数为 0），不假设四端同时拿到钩子。安装文档明确「需在该端执行 `specify integration use <key>` 激活」。
- **Rationale**：实测 `_helpers.py:417-442 _register_extensions_for_agent` 注释：`use`/`switch` 为激活 agent 重注册扩展命令，`upgrade` 仅对 active，plain install 与非 active 的 upgrade 故意跳过（issues #2886/#2948）。技能目录互不覆盖已实测。
- **Alternatives considered**：自建跨端命令注册器 → 违反 REQ-22「MUST NOT 自建冲突消解机制」与章程。

## R10 规划期护栏（REQ-23/AC-13）

- **Decision**：在 `hooks.before_clarify` / `hooks.before_plan` 挂只读命令 `bin/sdd-kit.mjs guard`，读当前 feature 的 `tasks.md`，存在且含 `- [x]` 则非零退出并打印回退提示；无任何写操作、无状态文件。
- **Rationale**：澄清结论「tasks.md 存在且有已勾选任务」；上游十个命令模板均读 `.specify/extensions.yml` 的 `hooks.<event>`，before_clarify/before_plan 是现成落点，无需新状态机。扩展样例 `agent-context` 用 after_* 钩子更新宿主上下文，证明钩子机制可靠。
- **Alternatives considered**：写入阶段标记文件 → 违反澄清与 REQ-23；硬门禁阻断命令 → 违反软门禁原则。

## R11 五区体检与触发试跑（REQ-33~39）

- **Decision**：`src/core/doctor.mjs` 导出 `runDoctor({trigger, host})`，五区独立 try/catch，统一错误出口 `{status, code, message, fix}`；全程只读，`fs.stat/readFile` 无写。环境区一次列全；宿主区读能力表 + 集成清单 + `peerDependenciesMeta` + trustFlags；仓库区比对产物哈希；运行时区调 `ctx.skills.list()`（DSH）或扫目录（CLI）列同名冲突与外部桥接插件 + 待生效标记；触发试跑区对可见技能按 `data-model.md` 的 `TriggerScore` 口径确定性打分排序（词元命中 + 名称权重 ×2 + 按技能词元数开方归一化 + 同分按 `name`/`provider` 字典序），不执行、零分仍列出、`userInvocable=false` 标 `excluded`。
- **Rationale**：实测 `ctx.skills.list()` 返回 name/description/whenToUse/invocation/source（`@deepseek-ai/dsh-skill` 类型 :266/:284），可直接打分；REQ-38 澄清范围为「当前可见技能（插件+用户级）」，镜像缺失时该区不判失败。打分口径选「词元命中 + 开方归一化」而非 TF-IDF 或向量检索，因为前者零依赖、可重复、可在 100 条规模内线性完成（实测预算 ≤1s），后者需新增依赖或模型调用，违反章程「禁新增 npm 依赖」。
- **Alternatives considered**：体检时写缓存加速 → 违反 REQ-39 零写；一次只报一个缺失 → 违反 REQ-34。

## R12 统一 CLI 入口（REQ-05/14）

- **Decision**：`bin/sdd-kit.mjs` 零第三方依赖，用 `node:util.parseArgs`；子命令 `update` / `bridge` / `doctor` / `guard` / `guidance`，全部委托 `src/core/` 同一实现，输出 JSON 结构调用 `register.mjs` 的 renderer 同构化函数。
- **Rationale**：实测 core 零宿主依赖、纯 Node 可加载；CLI 与宿主工具走同一实现即可满足 REQ-14 的 100% 同构断言。
- **Alternatives considered**：在 CLI 里复刻工具逻辑 → 违反 REQ-14/单一事实源；引入 commander/yargs → 违反「禁新增 npm 依赖」。

## 未决事项（进入实现前须解决，非规划阻塞）

1. **peer 版本实测下界**（R8，已收口）：下界不再未决。T100（2026-11-24）在 DSH 0.2.2-rc.3 宿主运行时直接读取 `node_modules/@deepseek-ai/*/package.json` 实测并收紧为 `@deepseek-ai/cordis >=4.1.0`、`@deepseek-ai/dsh-skill-filesystem >=0.2.2-rc.3`、`@deepseek-ai/dsh-tools >=0.2.2-rc.3`（证据见 `docs/adapters/stop-loss.md` M4 与 `test/compat.test.mjs` 的 `MEASURED_PEER_FLOORS`）；三项 `peerDependenciesMeta.<name>.optional=true` 继续保留，没有这些 peer 的宿主仍可安装。`verify:compat`（`node --test test/compat.test.mjs`）常态执行：`>=99.0.0`、`>=1.4.4`、`>=1.4.0` 的安装期下界用例已移出 `DSH_SDD_KIT_INTEGRATION` skip，`scripts/verify-upstream.mjs` 的纯函数 `compareBound(declared, observed)`（无需工具链）每轮判定预发布 `1.4.4.dev0` 与 extension.yml 的 `>=1.4.0`，并与 `versionDrift`（`declared`/`observed`/`needsAdjustment`/`suggestedBound`）对齐；真正缺工具链时按 `not_executed (REQ-42)` 明确失败而非静默 skip。历史留档：T015/T091 在 2026-11-24 本机仅有 Node v26.13.1、无任何 `@deepseek-ai/*` 宿主运行时时记录的「保留 `*`／下界未决／收紧会让宿主装不上」，已被同日 T100（实测下界）、T107（常态执行）与 T108（文档回填）取代，不再代表当前结论。
2. **外部宿主引导面最小验证**（R4）：Claude 是否选用 events 需在实际 Claude Code 环境验证一次；不可用时按 spec REQ-44 降级为项目级托管块并记录。
3. **回归矩阵 CI 凭据**（REQ-42）：公开网络与上游渠道在 CI 上是否可用由实现阶段配置；不可用时按「未执行」处理。
