# Feature Specification: Spec Kit 原生扩展钩子层（Hooks 取代 /sdd-implement）

> Describe **what** the system must do and **what it must NOT do**. Keep implementation details (SQL, frameworks, internal classes) out of this document.

## 1. User Story & Intent

- **作为**一名在 DSH 中使用 Spec Kit 的开发者，**我希望**日常只敲 Spec Kit 原生命令（`/speckit.specify` … `/speckit.implement`、`/speckit-bug-fix`），Superpowers 的工程纪律通过 Spec Kit 原生 Extension Hooks 自动织入，**从而**不必记住「规划用 `/speckit.*`、执行改敲 `/sdd-implement`」，并且未来 Spec Kit 升级 `implement` 模板时不会与本插件冲突。

**用户场景**

- 主场景（特性实现）：用户依次执行 `/speckit.specify` → `/speckit.plan` → `/speckit.tasks`，然后直接执行 `/speckit.implement`；在写第一行代码前，系统自动注入严格 TDD（红 → 绿 → 重构）与根因调试纪律；实现完成后自动执行两阶段自审，并衔接原生 `/speckit.converge` 收敛。
- 主场景（缺陷修复）：用户执行 `/speckit-bug-assess` → `/speckit-bug-fix`；修复前自动注入系统化调试与 TDD 纪律，修复后自动衔接原生 `/speckit-bug-test`，直至验证结论为 `verified`。
- 首次安装（空项目）：用户在一个还没有 `.specify/` 的项目里运行一次 `/sdd-setup`；系统以 `integration=dsh` 初始化 Spec Kit，把内置扩展装入 `.specify/extensions/`，技能落在 DSH 原生根 `.dsh/skills`，`specify extension list` 能看到扩展及其钩子数量，用户无需手工编辑任何 YAML。
- 既有项目（integration 不是 `dsh`）：用户运行 `/sdd-setup`；系统正常安装扩展，并在汇总中明确指出 integration 不一致、给出显式切换命令与影响范围，**不自动**改写用户既有的 `.claude/` 等目录。
- 未安装 Superpowers 镜像：用户直接执行 `/speckit.implement`；钩子明确报告上游技能目录缺失并给出可操作的修复指引，而不是静默地以「无纪律」方式继续实现。
- 重复安装 / 升级：用户再次运行 `/sdd-setup` 或升级 Spec Kit 后重装扩展；钩子注册不重复、不残留旧条目，Spec Kit 核心模板文件未被改动。

**用户故事优先级**（供任务拆分与增量交付排序）：

| 故事 | 优先级 | 覆盖场景 / 需求 | 独立可验证的交付物 |
|---|---|---|---|
| US1 特性实现自动注入纪律 | P1（MVP） | 主场景（特性实现）、REQ-02、REQ-04、REQ-06 | `before-implement` 与 `after-implement` 两个钩子命令文件 |
| US2 缺陷修复自动注入纪律 | P2 | 主场景（缺陷修复）、REQ-03、REQ-04、REQ-06 | `before-bug-fix` 与 `after-bug-fix` 两个钩子命令文件 |
| US3 一次安装并如实报告 | P3 | 首次安装（空项目）、既有项目、REQ-01、REQ-10、REQ-11、REQ-14、REQ-15 | `install_hooks_ext` 动作 + `/sdd-setup` 七步工作流 + 安装报告 |
| US4 旧执行入口彻底消失 | P4 | REQ-05 | 删除 `skills/sdd-implement/`、章程 v3.0.0、README 与挂载注释同步 |
| US5 幂等重装与卸载回滚 | P5 | 重复安装 / 升级、REQ-07、REQ-08、REQ-12、REQ-13 | 幂等/卸载/全局开关与模板不变三类回归测试 |

## Clarifications

### Session 2026-11-23

- Q: 移除 `/sdd-implement` 后，仓库里 `skills/sdd-implement/SKILL.md` 本身该怎么处理？ → A: 彻底删除该技能目录；章程原则 I 的技能上限从三个降回两个（`sdd-setup`、`sdd-update`），并同步修改 README 与 `test/sdd-kit.test.mjs:183-189` 的技能数量断言。
- Q: 四个钩子命令该怎么把纪律交给 Agent？ → A: 只**引用**上游 Superpowers 的 DSH 技能名（`test-driven-development`、`systematic-debugging`、`verification-before-completion`、`requesting-code-review` 等），**不内联**任何纪律正文；纪律内容的唯一来源保持为 `~/.dsh/upstream/superpowers/skills`。
- Q: 安装扩展这个动作，用户到底从哪里触发？ → A: 扩展现有 `/sdd-setup`，**不新增**技能；技能上限维持两个，`/sdd-setup` 在同一次运行中完成上游同步与扩展安装。
- Q: 内置扩展在仓库里的开发位置放在哪里？ → A: 仓库内 `spec-kit-extension/` 目录；它同时是 `specify extension add --dev` 的安装来源与 npm 包 `files` 的一部分，测试直接调用真实 `specify` CLI（不 mock）。
- Q: 当项目里 `settings.auto_execute_hooks` 为 false 时，强制钩子应该仍然执行还是尊重全局开关？ → A: 只依赖每条钩子自己的 `optional: false`，**不修改** `settings.auto_execute_hooks`；扩展安装与卸载均不改动该全局设置。
- Q: 既然本套件的宿主是 DSH，`specify_init` 的默认 integration 应该继续用 `claude` 还是改成 `dsh`？ → A: 默认改为 `dsh`（技能落到 DSH 原生根 `.dsh/skills`，无需 claude 兼容层）；对已初始化为其它 integration 的项目，`/sdd-setup` 必须**报告不一致**并提供显式切换动作，**不自动**改写用户项目布局。

## 2. Functional Requirements (EARS Format)

使用 EARS 语法编写每一条需求，使其与自动化测试一一对应：

- `REQ-01`：**WHEN** 用户在已初始化 Spec Kit 的项目中运行 `/sdd-setup` **THE SYSTEM SHALL** 在同一次运行中通过 Spec Kit 原生扩展机制（`specify extension add`）把内置扩展装入 `.specify/extensions/`，并使 `specify extension list` 将其报告为已启用、且带有非零钩子数量；**MUST NOT** 为此新增独立技能或独立命令。
- `REQ-02`：**WHEN** 用户执行原生 `/speckit.implement` **THE SYSTEM SHALL** 在该命令开始写代码前自动执行一个**强制**（`optional: false`）预钩子，拉起上游 Superpowers 的执行纪律（严格 TDD、根因调试、完成前验证、两阶段评审），且用户无需改敲 `/sdd-implement`；该钩子 **MUST** 只按名称引用上游 DSH 技能，**MUST NOT** 内联纪律正文。
- `REQ-03`：**WHEN** 用户执行原生 `/speckit-bug-fix` **THE SYSTEM SHALL** 在修改源码前自动执行一个**强制**预钩子，拉起上游 Superpowers 的系统化调试与严格 TDD 纪律；同样 **MUST** 只引用上游技能名而不内联正文。
- `REQ-04`：**WHEN** 原生 `/speckit.implement` 或 `/speckit-bug-fix` 完成后 **THE SYSTEM SHALL** 自动执行一个**强制**后钩子，先完成两阶段自审（对照 `spec.md` 的规范符合性 + 对照章程的代码质量），再衔接对应的原生收尾命令（特性为 `/speckit.converge`，缺陷为 `/speckit-bug-test`）。
- `REQ-05`：**WHEN** 用户进行日常规划、实现或缺陷修复 **THE SYSTEM SHALL** 使全部步骤仅由 Spec Kit 原生命令完成；`/sdd-implement` **MUST NOT** 再作为执行入口出现在任何推荐流程、README 或章程工作流中，且其技能目录 **MUST** 被删除（不保留废弃提示页，不留任何并行执行路径）；章程原则 I 的技能上限 **MUST** 同步降回两个（`sdd-setup`、`sdd-update`）。
- `REQ-06`：**IF** 上游 Superpowers 技能目录缺失或不可读 **THE SYSTEM SHALL** 在该钩子执行时给出明确、可操作的失败信息（指出缺失路径与修复命令），并以显式失败状态结束，**MUST NOT** 静默跳过纪律继续实现。
- `REQ-07`：**WHEN** 用户升级 Spec Kit 或本插件后重装扩展 **THE SYSTEM SHALL** 通过扩展机制重新注册钩子，且 **MUST NOT** 修改 Spec Kit 的核心命令模板、`.specify/templates/` 下的上游模板或 `.specify/scripts/` 下的上游脚本。
- `REQ-08`：**WHEN** 用户重复运行 `/sdd-setup` **THE SYSTEM SHALL** 保持幂等：同一钩子事件下不出现重复条目，不出现来自旧版本、已不再声明的孤儿条目，且不因「已安装」而失败退出。
- `REQ-09`：**WHEN** 本插件注册任何自动化触发 **THE SYSTEM SHALL** 仅使用 Hooks 层（`before_*` / `after_*` 命令事件）；**MUST NOT** 注册任何 Runtime Events（如 `pre_tool_use`）或硬门禁拦截。
- `REQ-10`：**WHEN** `/sdd-setup` 执行完毕 **THE SYSTEM SHALL** 报告扩展标识与版本、已注册的钩子事件清单，以及是否需要重启 DSH 才能生效。
- `REQ-11`：**WHEN** 用户运行 `/sdd-setup` **THE SYSTEM SHALL** 一并确保上游 Superpowers 技能目录已同步到本地镜像；**IF** 同步失败 **THE SYSTEM SHALL** 仍完成扩展安装，并明确指出钩子将在上游缺失时按 `REQ-06` 失败。
- `REQ-12`：**WHEN** 本插件被卸载或扩展被禁用 **THE SYSTEM SHALL** 使 Spec Kit 原生命令回到无钩子的原始行为，且不残留指向本插件的钩子条目。
- `REQ-13`：**WHEN** 扩展安装或卸载 **THE SYSTEM SHALL** 保持 `settings.auto_execute_hooks` 不变，强制语义仅由每条钩子的 `optional: false` 承担；**MUST NOT** 借改写全局开关来“确保”钩子执行。
- `REQ-14`：**WHEN** 用户在没有既有 `.specify/` 的项目中运行 `/sdd-setup` **THE SYSTEM SHALL** 以 `integration=dsh` 执行 `specify init`，使 Spec Kit 生成的技能落在 DSH 原生技能根 `.dsh/skills`；**MUST NOT** 默认写入 `.claude/` 等其它 agent 的目录。
- `REQ-15`：**IF** 项目已用其它 integration（如 `claude`）初始化 **THE SYSTEM SHALL** 在 `/sdd-setup` 报告中明确指出该不一致、给出显式切换命令与影响范围，并**不得**自动改写用户项目布局；切换动作 **MUST** 由用户显式请求触发。

## 3. Non-Goals & Hard Constraints (业务禁区)

明确声明哪些内容**不在范围内**、哪些内容**被禁止**：

- **Out of Scope（不在范围内）**：
  - 重新实现 Spec Kit 的 `tasks.md` 解析、任务勾选或收敛逻辑；这些一律交回 Spec Kit 原生命令。
  - 重新实现 Superpowers 的任何技能内容；只挂载上游镜像。
  - 用 Runtime Events 做「未跑测试禁止 commit」类硬门禁（仅作为未来可选的官方升级口记录，不在本次交付）。
  - 变更 Spec Kit 规划阶段（`specify` / `clarify` / `plan` / `tasks` / `analyze`）的既有行为与产物格式。
  - 修改 `/sdd-setup` 与 `/sdd-update` 已交付的三层更新语义。
  - 自动重启 DSH、弹出交互式确认、或修改用户 git 历史。
  - 自动把**既有项目**的 integration 从 `claude`（或其它 agent）切换到 `dsh`；只允许在**新建**项目时默认 `dsh`，既有项目仅报告不一致并给出显式命令。
- **Forbidden Behavior（禁止行为）**：
  - 在 DSH 插件侧保留一份与 Spec Kit 扩展并行的执行逻辑（双实现必然漂移）。
  - 把 Superpowers 技能内容复制进本仓库（必须从 `~/.dsh/upstream/superpowers` 挂载），或在钩子文本中内联纪律正文副本。
  - 直接编辑 `.specify/extensions.yml` 手工写入钩子条目，绕过 `specify extension add`。
  - 覆盖或改写 Spec Kit 核心命令模板与上游脚本。
  - 以「已安装」为由静默跳过钩子注册，或在钩子失败时以成功状态结束。
  - 引入新的 npm 运行时依赖。
- **Performance / Compatibility Bounds（性能 / 兼容性边界）**：
  - `/sdd-setup` 在单次调用内、无交互提示地完成；典型耗时不超过 60 秒（不含首次克隆 Superpowers 镜像）。
  - 每个钩子注入带来的额外开销不超过 2 秒，且不得阻塞用户的工具调用（软门禁语义）。
  - 兼容 `specify-cli >= 1.4`（扩展清单 `schema_version: "1.0"`）；不得依赖未被官方文档化的私有字段。
  - Node.js >= 18、ESM、零新增依赖的既有约束继续适用。

## 4. Acceptance Criteria

- [ ] `AC-01`：在已初始化项目中运行一次 `/sdd-setup`；`specify extension list` 显示本扩展为 Enabled 且 Hooks 数量大于 0，`.specify/extensions.yml` 中出现 `before_implement`、`after_implement`、`before_bug_fix`、`after_bug_fix` 四个事件下的条目。
- [ ] `AC-02`：在 `tasks.md` 尚有未完成任务的特性上执行 `/speckit.implement`；可观察到强制预钩子在首次写代码前运行，且其输出按名称引用上游技能（至少含 `test-driven-development` 与 `systematic-debugging`），但不包含任何纪律正文副本。
- [ ] `AC-03`：执行 `/speckit-bug-fix slug=<slug>`；可观察到强制预钩子在源码修改前运行（按名称引用 `systematic-debugging` 与 `test-driven-development`），且随后按评估报告的修复方案执行。
- [ ] `AC-04`：上述两个命令完成后；可观察到后钩子执行两阶段自审，并分别衔接 `/speckit.converge` 与 `/speckit-bug-test`。
- [ ] `AC-05`：全文检索 README、章程与技能目录；`/sdd-implement` 不再出现在任何推荐工作流中，不存在「执行阶段改敲其他命令」的指引，且 `skills/sdd-implement/` 目录已被删除、章程原则 I 写明技能上限为两个。
- [ ] `AC-06`：临时重命名 Superpowers 技能目录后执行 `/speckit.implement`；钩子给出包含缺失路径的明确错误并以失败结束，未产生任何源码改动。
- [ ] `AC-07`：连续运行 `/sdd-setup` 两次；第二次成功退出，`before_implement` 等事件下的条目数量与第一次相同（无重复），且无孤儿条目。
- [ ] `AC-08`：对比安装前后 `.specify/templates/`、`.specify/scripts/` 与核心命令模板；内容未发生变化（除扩展自身目录与 `extensions.yml` 注册项外）。
- [ ] `AC-09`：检查扩展清单与 `.specify/extensions.yml`；不存在 `events:` 声明或 `pre_tool_use` 类条目，四个钩子条目均为 `optional: false`，且 `settings.auto_execute_hooks` 与安装前取值一致。
- [ ] `AC-10`：执行 `specify extension remove <本扩展>` 后再看 `/speckit.implement` 行为；钩子条目被清除，命令回到原始行为。
- [ ] `AC-11`：`/sdd-setup` 的输出包含扩展版本、四个钩子事件清单与重启提示。
- [ ] `AC-12`：在没有 `.specify/` 的临时目录中运行 `/sdd-setup`；生成的技能落在 `.dsh/skills/`，`.claude/` 未被创建，且 `.specify/init-options.json` 的 `integration` 与 `ai` 均为 `dsh`。
- [ ] `AC-13`：在 `integration=claude` 的既有项目上运行 `/sdd-setup`；输出明确指出 integration 不一致、给出 `specify integration switch dsh` 命令，且该次运行**未**改动 `.claude/` 下的任何文件。

### Success Criteria

- 用户完成一次安装后，整个特性开发与缺陷修复流程只使用 Spec Kit 原生命令，无第二个执行入口。
- 从「安装完成」到「首次 `/speckit.implement` 自动注入纪律」无需任何手工 YAML 编辑。
- 重复安装与升级不产生重复或孤儿钩子条目。
- Spec Kit 升级后重装扩展即可恢复全部行为，无需改动本仓库的执行桥接代码。
- 用户可仅凭安装输出判断扩展是否生效、注册了哪些钩子、是否需要重启。

## 5. Assumptions and Dependencies

- `specify` CLI 可用；项目可以尚未初始化——`/sdd-setup` 会用 `integration=dsh` 完成初始化（REQ-14）。既有项目保持其原 integration，不被自动改写（REQ-15）。
- Spec Kit 官方提供 `dsh` integration（`integrations/dsh/__init__.py`，`folder=".dsh/"`、`commands_subdir="skills"`），生成技能落在 DSH 默认技能根内；DSH 的默认技能根不含 `.claude/skills`。
- 当前 `specify-cli`（1.4.4.dev0）的扩展机制支持 `hooks:` 清单声明与 `optional: false` 强制钩子语义；若上游未来改变该契约，以扩展机制为准并在本规范中记录迁移。
- 上游 Superpowers 以本地 Git 镜像 `~/.dsh/upstream/superpowers/skills` 形式存在，并由既有 `/sdd-setup` 同步。
- 钩子以「同会话提示」方式执行（Spec Kit 的既有语义），因此纪律注入是软门禁；硬门禁不在本次范围。
- 扩展的安装来源是仓库内的 `spec-kit-extension/` 目录，通过 `specify extension add --dev spec-kit-extension` 安装，不依赖公网目录服务；该目录随 npm 包分发，测试直接调用真实 `specify` CLI 而非 mock。

## 6. Key Entities

- **内置扩展清单（Extension Manifest）**：描述扩展标识、版本、兼容的 Spec Kit 版本范围、所提供的命令与 `hooks` 声明；是钩子注册的唯一事实来源。
- **钩子条目（Hook Entry）**：注册进 `.specify/extensions.yml` 的一条记录，字段为所属扩展、命令标识、是否强制（`optional`）、优先级、提示文本与描述。
- **钩子事件（Hook Event）**：本次交付的四个事件——`before_implement`、`after_implement`、`before_bug_fix`、`after_bug_fix`。
- **纪律注入（Discipline Injection）**：钩子命令**按名称引用**的上游 Superpowers 技能集合（不含正文副本），按事件分为执行纪律（TDD/调试/验证/评审）与收尾纪律（两阶段自审 + 原生收尾命令）。
- **安装报告（Install Report）**：一次 `/sdd-setup` 运行的产出，包含扩展标识与版本、已注册事件清单、项目 integration 与技能落盘目录（及是否在 DSH 默认技能根内）、上游同步结果与是否需要重启。
- **扩展源目录（Extension Source Directory）**：仓库内 `spec-kit-extension/`，含 `extension.yml` 与四个钩子命令文件；它既是 `specify extension add --dev` 的安装来源，也是 npm 包 `files` 的一部分，并作为测试的直接断言对象（不在测试中 mock）。
