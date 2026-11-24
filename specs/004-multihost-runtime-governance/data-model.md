# 数据模型：跨宿主 SDD 运行时治理层

> 所有实体驻留内存或为纯 JSON 文件；无数据库。字段名与 `contracts/` 保持一致。

## HostCapability（宿主能力表条目）

- **来源**：`src/core/host-capabilities.mjs` 的 `HOST_CAPABILITIES` 常量（唯一可编辑源）。
- **字段**：
  - `key`: `'dsh' | 'claude' | 'codex' | 'cursor'`
  - `integrationKey`: 上游 specify 集成键（dsh / claude / codex / cursor-agent）
  - `toolPrefix`: 原生调用前缀（DSH 为 `@`，Codex 为 `$`，Cursor 为 `/`，Claude 为 `/`）
  - `skillsDir`: 项目级技能目录（`.dsh/skills` / `.claude/skills` / `.agents/skills` / `.cursor/skills`）
  - `guidanceChannel`: `'system-prompt' | 'native-event' | 'managed-block' | 'rule-dir'`
  - `guidanceConfig`: 各通道所需配置（section order / 事件名与路径 / 托管块路径与 `markerStart`+`markerEnd` / 规则目录路径）；凡是写托管块的通道（Codex、Claude 降级块）都自带同一对标记，适配器不得借用其它宿主的配置
  - `toolNames`: 五个动作（`upstream` / `bridge` / `doctor` / `guard` / `guidance`）的调用名，引导面工具映射的唯一可编辑源（DSH 原生名 / 非 DSH 的 `sdd-kit <subcommand>`）
  - `reloadPolicy`: `{ tool_code: 'restart_host'|'new_session'|'none', skill_data: ..., extension_command: ... }`
  - `trustFlagPattern`: 需安全告警的派发参数正则（Cursor 为 `-p --trust --approve-mcps --force`）
- **验证**：四端齐全；每个 `reloadPolicy` 三值合法；适配实现 ≤100 行（行数断言）。

## ThreeFaceContract（三面契约）

- **字段**：`toolFace`（调用机制）、`guidanceFace`（常驻机制与降级）、`skillFace`（安装渠道与目录）、`reloadSemantics`。
- **约束**：`contracts/host-adapter.md` 为唯一文档源；每宿主实现须覆盖 `toolFace`、`guidanceFace`、`skillFace` 三面与 `reloadSemantics` 重载语义（四个必答项），且无业务判定。

## GuidanceBundle（引导段）

- **字段**：
  - `upstreamText`: 上游纪律技能的**引用条目**注入，单位为一个技能一行 = `- <frontmatter.name>: <frontmatter.description>`（上游作者自己写的 name + description 原文，逐字保留、不做摘要/改写）；技能行之间以换行分隔。`SKILL.md` 正文**不读取、不注入**，完整正文留在镜像里供宿主按技能名加载（`T071/AC-06`）
    - 为什么只引用不复制正文：常驻段受 1.2k token 硬预算约束（见 `spec.md` 成功标准「常驻开销不超过 1.2k token」），且 `REQ-08` 要求「引用而非复制」上游原文。实测本机镜像 15 个纪律技能，仅 name+description 为 774 tok，注入全量正文为 40,679 tok（约 34×），会直接击穿预算。AC-06 的「上游正文」按此注入单位（name + description 引用条目）理解。
    - 不可裁剪：即使这些引用条目本身超限，也完整保留、只裁 `sddPointer` 并记超限告警。
  - `toolMapping`: `{ [action: string]: string }`（动作 → 当前宿主工具名；派生自 `HOST_CAPABILITIES[host].toolNames`，DSH 为 `sdd_upstream`/`sdd_bridge`，非 DSH 为 `sdd-kit <subcommand>`）
  - `sddPointer`: `{ feature: string, phase: string, nextCommand: string }`
    - `feature`：`.specify/feature.json` 的 `feature_directory` 最后一段；缺失时取 `specs/` 下编号最大目录。
    - `phase`：**纯函数推导，无状态文件**，判定顺序自上而下命中即停——① 当前 feature 的 `tasks.md` 存在且 `^- \[[xX]\]` 命中 ≥1 → `implement`；② `plan.md` 存在 → `plan`；③ `spec.md` 存在 → `specify`；④ 无 `spec.md` → `constitution`。该推导与 `FeaturePhase.判定` MUST 共用同一实现，不得两处各写一份。
    - `nextCommand`：`constitution`→`/speckit-constitution`、`specify`→`/speckit-clarify`、`plan`→`/speckit-tasks`、`implement`→`/speckit-implement`。
  - `tokenEstimate`: 数字，测量对象是 `formatGuidanceText(bundle)` 的**最终渲染文本**（含 `## SDD 运行时纪律（dsh-sdd-kit）` 标题、`工具映射：` 与 `当前进度：` 标签），不是各字段的裸拼接；CJK 1 tok/字 + 非 CJK ceil(chars/3.5)
  - `text`: `formatGuidanceText(bundle)` 的结果，即真正注入宿主会话的文本（与 `tokenEstimate` 同源）
  - `warnings`: 字符串数组（超限/缺镜像/缺技能）
- **状态**：`enabled: boolean`（项目级开关存在则覆盖全局级）、`effectiveScope: 'project'|'user'|'default'`。
- **开关的落点（两级，均为既有配置文件的增量键，MUST NOT 新建开关文件）**：
  - 用户全局级：`~/.dsh/sdd-kit.json` 的 `guidance.enabled`（CLI 与外部宿主读同一路径，HOME 可覆盖）。
  - 项目级：`<repo>/.specify/sdd-kit.json` 的 `guidance.enabled`。
  - 解析优先级：项目级键存在 → `effectiveScope='project'`；否则全局级键存在 → `'user'`；都缺 → `'default'`（等价开启）。
  - 任一文件不可解析 MUST 视为该级未设置并记 `warnings`，MUST NOT 使引导整体失败。
- **规则**：闸门以 `formatGuidanceText(bundle)` 的最终文本为唯一测量面；>1200 tok 只裁 `sddPointer`（顺序 `nextCommand` → `phase` → `feature`），`upstreamText`（name + description 引用条目）不可裁剪；引用条目本身超限时完整保留并告警。`SKILL.md` 正文不参与拼装，因此不占常驻预算。

## ReloadDecision（重载结论）

- **字段**：`result: 'restart_host'|'new_session'|'none'`、`layers: ChangeLayer[]`、`reason: string`、`host: string`。
- **ChangeLayer** = `'tool_code'|'skill_data'|'extension_command'`。
- **规则**：空 layers → `none` 且不落盘；判定唯一实现 `src/core/reload.mjs`。

## PendingMarker（待生效标记）

- **存储**：`.specify/sdd-pending.json`（仓库内，按仓库共享）结构 `{ [host: string]: MarkerEntry }`。
- **MarkerEntry** 字段：`layer: ChangeLayer`、`timestamp: ISO8601`、`reason: string`、`host: string`。
- **转换**：写入（结论非 none）→ 宿主启动钩子清除当前 host 条目 → 体检按 timestamp 区分历史/本次。
- **隔离**：仅清当前仓库当前 host，不影响其他键。

## DoctorReport（体检报告）

- **字段**：`environment`、`host`、`repository`、`runtime`、`triggerDryRun` 五区。
- **每区**：`{ status: 'pass'|'fail'|'skipped'|'not_executed', items: DiagnosticItem[] }`。
- **DiagnosticItem**：`{ status, code, message, fix }`（四字段统一出口）。
- **规则**：区之间独立判定；全程零写；重复执行一致。

## DiagnosticItem（诊断项）

- **字段**：`status: 'pass'|'fail'|'warn'|'skip'`、`code: string`、`message: string`、`fix?: string`。

## SkillSummary（技能摘要，来自 `ctx.skills.list()`）

- **字段**：`name`、`description`、`whenToUse`、`invocation`、`source`、`provider`、`path`。
- **来源**：DSH 运行时服务；CLI 模式扫目录得到等价结构。
- **用途**：触发试跑打分（仅可见技能：插件 + 用户级），同名冲突检测。

## TriggerScore（触发试跑打分结果）

- **字段**：`skill`（被评分的 `SkillSummary`）、`score: number`（0~1）、`matchedTerms: string[]`、`excluded?: 'not_user_invocable'`。
- **打分口径（确定性、无随机、无外部调用）**：
  1. 归一化：任务描述与技能文本（`name` + `description` + `whenToUse`）全部转小写，按非字母数字字符切分为词元集合；CJK 连续片段整体作为一个词元，并额外按二元字组切分。
  2. 命中：技能词元 ∩ 描述词元 → 计入 `matchedTerms`；`name` 命中权重 ×2。
  3. `score = (Σ 命中权重) / (技能词元总数 ** 0.5)`，再截断到 `[0,1]`；该归一化使长描述不因词多而天然占优。
  4. 排序：`score` 降序；`score` 相同按 `name` 字典序升序（保证跨平台与跨运行稳定）；仍相同按 `provider` 升序。
  5. `invocation.userInvocable === false` 的技能置 `excluded='not_user_invocable'`，不进候选，但计入可见总数。
- **约束**：`score=0` 的技能 MUST 仍然出现在结果尾部而非被静默丢弃，以便用户看到「可见但都不匹配」。
- **规则**：全程只读、不执行任何技能；镜像缺失不影响本结构。

## FeaturePhase（规划期护栏输入）

- **来源**：当前 feature 的 `tasks.md`（既有产物，无独立状态文件）。
- **判定**：文件存在且正则 `^- \[[xX]\]` 命中 ≥1 → 实现阶段已开始 → 只读拦截 `before_clarify`/`before_plan`。

## 关系图

```
HostCapability 1 ── 1 ThreeFaceContract（每宿主一份实现）
GuidanceBundle ──依赖── HostCapability.guidanceChannel
ReloadDecision ──产自── src/core/reload.mjs ──查── HostCapability.reloadPolicy
ReloadDecision ──落盘── PendingMarker[host]
DoctorReport ──含── 5×DiagnosticItem[] ──读── HostCapability / PendingMarker / SkillSummary
TriggerScore ──评分── SkillSummary ──供── DoctorReport.triggerDryRun
FeaturePhase ──读── tasks.md（只读护栏）
```
