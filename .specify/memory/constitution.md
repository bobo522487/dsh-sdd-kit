<!--
同步影响报告
版本变更：4.0.0 → 5.0.0（MAJOR：原则 I 的对外表面枚举被重新定义，新增一个宿主中立命令行入口）
修改的原则：
  I. 零分叉，薄胶水层（对外表面从「两技能 + 两宿主工具 + 一扩展」扩为
     「两技能 + 两宿主工具 + 一个宿主中立 CLI + 一扩展」；新增第三条硬边界：
     CLI MUST 只委托核心、MUST NOT 承载业务逻辑、输出 MUST 与宿主工具同构）
新增章节：无
移除章节：无
迁移说明：`bin/sdd-kit.mjs` 成为章程允许的对外表面之一，其存在理由是
  specs/004-multihost-runtime-governance 的 REQ-05：非 DSH 宿主没有 Host 工具通道，
  必须有一个零第三方依赖的命令行入口提供等价能力。该 CLI MUST 只是核心的第二个
  薄入口（与 `sdd_upstream`/`sdd_bridge` 共享同一实现），MUST NOT 引入第二套逻辑或
  第二份事实。此前「表面严格限定为四项」的表述不再成立，相关断言与文档 MUST 更新。
授权：项目拥有者显式指令（采纳 /speckit-analyze 报告 C1 的修复顺序，2026-11-24）。
后续待办：本文档无。
-->

# dsh-sdd-kit 项目章程

## 核心原则

### I. 零分叉，薄胶水层
dsh-sdd-kit MUST NOT 重实现 GitHub Spec Kit 或 obra/superpowers。它 MUST 把“构建什么”
交给上游 `specify` CLI，把“如何构建”交给上游 Superpowers 技能。插件对外表面 MUST
严格限定为两个命名技能（`sdd-setup`、`sdd-update`）、两个轻量 Host
工具（`sdd_upstream`、`sdd_bridge`）、一个宿主中立的命令行入口
（`bin/sdd-kit.mjs`，零第三方依赖）以及一个以标准形态存在的 Spec Kit 扩展
（`spec-kit-extension/`，由 `specify extension add --dev` 装入，自身不含桥接代码）；
新行为 MUST 以委托或薄胶水层实现，MUST NOT 形成并行逻辑。`/sdd-update` MUST 是声明式命令技能，仅委托 `sdd_upstream(update_all)`
一次，MUST NOT 包含更新逻辑。

零分叉的三条硬边界（v5.0.0）：
- 插件 MUST NOT 复制或替换已安装的 profile 副本；自身安装与升级 MUST 走 DSH 包管理器
  （`dsh plugin add/update dsh-sdd-kit --latest`）。运行中的插件无法可靠替换自己。
- `tasks.md` 勾选 MUST 只有上游 `/speckit.implement` 一个写者；插件 MUST NOT 提供
  平行的任务勾选动作，只读统计（`inspect`）不受限。
- 同一事实 MUST 只有一处可编辑源：打包白名单以 `package.json` 的 `files` 为准，
  EARS 模板以 `overrides/spec-template.md` 为准，安装产物 MUST NOT 入库。

宿主中立 CLI 的边界（v5.0.0）：
- `bin/sdd-kit.mjs` MUST 只做参数解析与结果序列化，业务逻辑 MUST 全部位于宿主无关核心
  （`src/core/`）；CLI 与 Host 工具 MUST 调用同一核心函数，MUST NOT 各写一份。
- 同一动作经 CLI 与经 Host 工具执行 MUST 输出结构同构的 JSON，且该同构性 MUST 由共享
  契约测试断言，MUST NOT 依赖人工核对。
- CLI 的存在 MUST NOT 使任一事实出现第二处可编辑源，也 MUST NOT 引入新的运行期依赖。

理由：这使项目始终可随上游升级，避免漂移；“薄”的实质是消灭第二套机制与第二份事实，
而不是表面的技能个数或入口个数。

迁移说明（v5.0.0）：`bin/sdd-kit.mjs` 被列入允许表面，用于非 DSH 宿主（Claude Code、
Codex、Cursor 等）没有 Host 工具通道时的等价能力。此前「对外表面严格限定为四项」的
表述与任何据此写成的断言 MUST 在功能实现前更新为五项枚举；CLI 本身 MUST 只是核心的
第二个薄入口。
迁移说明（v4.0.0）：`update_all` 从三层降为两层上游（`spec-kit`、`superpowers`），
`kit-copy` 自研安装器与 `check_task` 平行勾选路径整体删除，不保留兼容别名。
迁移说明（v3.0.0）：v2.1.0 的三技能上限（`sdd-setup`、`sdd-implement`、`sdd-update`）
已被上述两技能上限取代。`/sdd-implement` 整体删除，执行纪律改由 Spec Kit 原生扩展的
四个强制钩子（`before_implement`、`after_implement`、`before_bug_fix`、`after_bug_fix`）
注入，因此日常流程 100% 使用 Spec Kit 原生命令。任何断言三个技能的测试或文档 MUST
在功能实现前更新。本次修订经项目拥有者显式指令批准。

### II. 规范优先，采用 EARS 与非目标
每个功能和缺陷修复 MUST 在编写实现代码前具备已批准的 Spec Kit 产物。规范 MUST 使用
EARS 验收语法（`WHEN ... THE SYSTEM SHALL ...`），并 MUST 通过已安装的
`.specify/templates/overrides/spec-template.md` 声明明确的非目标。歧义 MUST 在规划前
通过 `/speckit-clarify` 解决。
理由：可测试的验收标准与明确边界能够防止范围蔓延。

### III. 严格测试先行（不可协商）
实现 MUST 遵循“红 → 绿 → 重构”：先写失败测试，观察其失败，再做最小通过改动。
`npm test` MUST 在任务标记完成前通过，每个缺陷修复 MUST 包含回归测试。完成声明 MUST
以实际命令输出为依据，MUST NOT 依赖假设。
理由：TDD 与可观察验证是从 Superpowers 继承的质量底线。

### IV. 当前分支上的原子提交
每个计划任务 MUST 在当前分支产生一个原子 `git commit`。工作 MUST NOT 拆分为无关提交，
除非用户显式要求，MUST NOT 创建其他分支或 worktree。提交信息 MUST 标明其实现的任务或修复。
理由：原子历史使评审、回滚和收敛保持确定性。

### V. 可升级、免值守的上游同步
`/sdd-setup` MUST 在每次运行时同步上游 Superpowers Git 镜像与 `specify` CLI。生成的
`specify init` 命令默认 MUST 免值守：MUST 包含 `--non-interactive`、`--force`、
`--ignore-agent-tools`，并 MUST 省略已弃用的 `--integration-options=--skills`（除非显式选择加入）。
全新 `specify` 安装 MUST 通过可覆盖参数固定稳定 Python 版本，MUST NOT 硬编码机器相关路径。
插件自身的安装与升级 MUST 走 DSH 包管理器路径，升级后 MUST 提示用户重启 DSH；
上游 Superpowers 首次克隆或技能数变化时，MUST 向用户报告需要重启 DSH。
理由：安装流程 MUST NOT 挂起、在非 Claude 主机上失败，或因新工具发布而中断。

### VI. 中文优先的文档与答复
本仓库的治理文档、Spec Kit 产物（`spec.md`、`plan.md`、`tasks.md`、`research.md`、
`data-model.md`、`contracts/`、`quickstart.md`、`checklists/` 等）以及面向用户的说明与
答复 MUST 使用中文编写。命令、路径、代码、API/字段名、上游原文引用与模板固定标题 MUST
保留原文；除这些例外外，正文、验收标准、评审意见与最终答复 MUST 使用中文表述。
评审与验收 MUST 检查语言一致性；混合语言仅在上述例外范围内允许。
理由：统一语言降低协作与审阅成本，避免中英混杂造成需求误读。

迁移说明（v2.1.0）：本原则自 2.1.0 起适用于所有新增与修订内容；存量英文文档可在后续
任务中逐步中文化，不要求在本次修订中一次性重写。

## 技术与集成约束

- 运行时 MUST 为 Node.js >=18 与 ESM 模块；MUST NOT 新增 npm 依赖。
- 上游事实来源 MUST 保持为 `specify` CLI 与本地 `~/.dsh/upstream/superpowers` Git 镜像；
  本插件 MUST NOT 复制其逻辑。
- DSH profile 中的插件副本由 DSH 包管理器（pnpm）安装与升级；本插件 MUST NOT
  自行写入该副本。开发验证 MUST 通过 `dsh plugin add/update` 或本地 `.tgz` 安装完成，
  工具代码变更时 MUST 请求重启 DSH。
- 仓库内文本文件 MUST 以 LF 存储与检出（`.gitattributes`）；契约测试 MUST NOT
  锚定平台相关换行；平台受限用例（如 symlink）MUST 显式 skip 并注明原因。
- 生成的 Spec Kit 覆盖文件、模板与工作流文件 MUST 通过 `sdd_bridge`/`/sdd-setup` 安装，
  MUST NOT 在下游项目中手工编辑。
- 本章程仅用于项目治理；`/speckit-constitution` MUST NOT 修改命令与模板源文件。

## 开发流程与质量门禁

1. 运行 `/sdd-setup` 同步上游并安装 EARS/非目标覆盖文件。
2. 定义阶段：`/speckit-constitution` → `/speckit-specify` → `/speckit-clarify` →
   `/speckit-plan` → `/speckit-tasks` → `/speckit-analyze`。
3. 执行阶段：使用原生 `/speckit.implement`，遵循 TDD 与每任务一次原子提交（纪律由扩展
   钩子 `before_implement` / `after_implement` 自动注入），然后执行
   `/speckit-converge` 与 `specs/INDEX.md` 同步。
4. 缺陷流程：`/speckit-bug-assess "<symptom>" slug=<slug>` →
   `/speckit-bug-fix slug=<slug>` → `/speckit-bug-test slug=<slug>`，直至验证通过
   （纪律由扩展钩子 `before_bug_fix` / `after_bug_fix` 自动注入）。
5. 完成前 MUST 审查测试、验证证据与本章程合规性；复杂度 MUST 在计划或规范中论证。

## 治理

本章程优先于非正式项目实践。修订 MUST 记录在版本行与同步影响报告中，MUST 经项目拥有者
批准，并在行为变更时包含迁移说明。版本控制 MUST 遵循语义化版本：
原则被移除或重新定义为 MAJOR，新增原则或实质性扩展指导为 MINOR，措辞或拼写修正为 PATCH。
每次 PR 与评审 MUST 验证对这些原则的合规性。运行时指导见 `README.md` 与已安装的
Superpowers 技能；本文档仅定义不可协商的治理规则。

v5.0.0 修订为 MAJOR，因为原则 I 的对外表面枚举被重新定义（新增宿主中立 CLI），
属治理契约的不兼容变更；其迁移说明记录在原则 I 与顶部同步影响报告中，经项目拥有者
对 /speckit-analyze 报告 C1 的显式采纳落地。
v4.0.0 修订为 MAJOR，因为删除了 `update_all` 的第三组件与 `check_task` 动作及配套参数，
属工具表面的不兼容收缩；其迁移说明记录在原则 I 与顶部同步影响报告中，经项目拥有者
对宏观架构评审批次 1 的显式批准落地。
v3.0.0 修订为 MAJOR，因为删除了一个命名技能并改变了执行入口，属不兼容变更。
v2.1.0 修订为 MINOR，因为新增了原则 VI；其中文文档与答复规则记录在该原则中，并经项目
拥有者授权。v2.0.0 修订为 MAJOR，因为原则 I 的表面上限被重新定义，其迁移说明记录在
原则 I 中。

**版本**：5.0.0 | **批准日期**：2026-11-23 | **最后修订**：2026-11-24
