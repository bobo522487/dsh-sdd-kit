# Implementation Plan: Spec Kit 原生扩展钩子层（Hooks 取代 /sdd-implement）

**Branch**: `002-spec-kit-extension-hooks` | **Date**: 2026-11-23 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-spec-kit-extension-hooks/spec.md`

## Summary

把「执行纪律注入」从 DSH 侧自研的 `/sdd-implement` 技能，迁移为 **Spec Kit 原生 Extension**：仓库内新增 `spec-kit-extension/`（`extension.yml` + 4 个钩子命令文件），通过 `specify extension add --dev <dir> --force` 装入 `.specify/extensions/`，由 Spec Kit 自己在 `before_implement`、`after_implement`、`before_bug_fix`、`after_bug_fix` 四个事件上调度 `optional: false` 的强制钩子；钩子正文只**按名称引用**上游 Superpowers 技能，不含纪律正文副本。DSH 侧退化为极薄安装入口：`sdd_upstream` 新增 `install_hooks_ext` 动作（仅一次 `specify` 委派），`/sdd-setup` 增加一步调用它，`skills/sdd-implement/` 整个目录删除，技能上限从 3 降回 2。

## Technical Context

**Language/Version**: Node.js >= 18（ESM），零新增 npm 依赖；扩展侧为 YAML 清单 + Markdown 命令文件（无代码）。

**Primary Dependencies**: `specify` CLI 1.4.4.dev0（Spec Kit 扩展机制，`schema_version: "1.0"`）；上游 `obra/superpowers` 本地镜像 `~/.dsh/upstream/superpowers/skills`；DSH `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-skill-filesystem`（peer，仅宿主侧）。

**Storage**: 文件系统——仓库 `spec-kit-extension/`（扩展源）、项目 `.specify/extensions/`（安装副本）、`.specify/extensions.yml`（钩子注册表，由 CLI 写入）、`.specify/extensions/.registry`（安装记录，CLI 维护）。

**Testing**: `node --test test/sdd-kit.test.mjs`（现有单文件套件）；新增用例对 `spec-kit-extension/` 做静态断言，并在 `specify` CLI 可用时于临时目录执行真实 `extension add --dev` / `remove --force` 做端到端验证（CLI 不可用时 `t.skip`，不 mock）。

**Target Platform**: DSH（Linux/macOS 终端宿主）；新建项目默认 `integration=dsh`（技能落 `.dsh/skills`，在 DSH 默认技能根内）；既有项目的 integration 不被自动改写，实际安装目标目录始终由项目 `init-options.json` 的 `integration` 决定，其它 key 也受支持。

**Project Type**: 单仓库 DSH 插件（library + host tool + skill 集合 + Spec Kit 扩展源）。

**Performance Goals**: `/sdd-setup` 单次 ≤ 60 秒（不含首次克隆 Superpowers）；单次扩展安装（`specify extension add --dev`）实测约 1–2 秒；每个钩子注入的额外开销 ≤ 2 秒且不阻塞工具调用。

**Constraints**: 不修改 `.specify/templates/`、`.specify/scripts/` 与 Spec Kit 核心命令模板；不写 `events:`（Runtime Events）；不改 `settings.auto_execute_hooks`；不引入 YAML 解析依赖（清单合法性由 `specify` CLI 自身校验，测试只用文本断言 + CLI 退出码）。

**Scale/Scope**: 1 个扩展、4 个钩子命令、4 个事件、约 6 个仓库文件改动点 + 1 个目录删除。

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原则 | 判定 | 依据 |
|------|------|------|
| I. 零分叉，薄胶水层 | PASS（需章程修订） | 新增行为仅一次 `specify extension add --dev` 委派（`install_hooks_ext`）；删除 `sdd-implement` 后对外表面为 2 技能 + 2 工具，比现状更薄。**但**章程 v2.1.0 明写「三个命名技能」，本特性必须把章程升到 v3.0.0 才能合法落地——修订属本特性交付物，不算违规。 |
| II. 规范优先（EARS + 非目标） | PASS | `spec.md` 已含 REQ-01…REQ-15、Out of Scope / Forbidden、AC-01…AC-13；6 项歧义已由 `/speckit.clarify` 收敛。 |
| III. 严格 TDD（不可协商） | PASS | 任务顺序强制：先写失败测试（`spec-kit-extension/` 静态契约 + CLI 端到端），再写清单与命令文件，最后改 `upstream.mjs`/`register.mjs`/技能。`npm test` 未过不得勾选任务。 |
| IV. 当前分支原子提交 | PASS | 每任务一个 `git commit`，不建分支/worktree。 |
| V. 可升级免值守上游同步 | PASS | `/sdd-setup` 既有同步命令与参数（`--non-interactive --force --ignore-agent-tools`）不变；扩展安装步骤复用同一 `specify` 二进制，无新增网络源（`--dev` 走本地目录）。 |
| VI. 中文优先文档与答复 | PASS | 文档、报告、提交说明用中文；命令名、路径、字段名保留原文。 |

**结论**：Phase 0 前无阻塞违规；唯一强制动作是随本特性发布章程 v3.0.0 修订（原则 I 技能上限 3 → 2、删除 `/sdd-implement` 工作流条目）。

## Project Structure

### Documentation (this feature)

```text
specs/002-spec-kit-extension-hooks/
├── plan.md              # 本文件
├── research.md          # Phase 0：扩展机制实测事实与决策
├── data-model.md        # Phase 1：清单 / 钩子条目 / 安装报告的数据形状
├── quickstart.md        # Phase 1：安装、验证、回滚的手工步骤
├── contracts/           # Phase 1：扩展清单契约、CLI 委派契约、工具参数契约
│   ├── extension-manifest.md
│   ├── hook-commands.md
│   └── sdd-upstream-install-hooks-ext.md
├── checklists/
│   └── requirements.md  # 已完成（16/16）
├── spec.md              # 已完成
└── tasks.md             # Phase 2（/speckit-tasks 产出，非本命令）
```

### Source Code (repository root)

```text
spec-kit-extension/                     # 新增：Spec Kit 扩展源目录（npm files 的一部分）
├── extension.yml                       # 清单：id/version/requires/provides.commands/hooks
└── commands/
    ├── speckit.superpowers-hooks.before-implement.md
    ├── speckit.superpowers-hooks.after-implement.md
    ├── speckit.superpowers-hooks.before-bug-fix.md
    └── speckit.superpowers-hooks.after-bug-fix.md

src/
├── index.mjs                           # 不变
├── register.mjs                        # 改：sdd_upstream 的 action 枚举与参数描述（+ extensionDir）
└── core/
    ├── upstream.mjs                    # 改：新增 install_hooks_ext 动作；扩展源目录解析；specify_init 默认 integration → dsh
    ├── update.mjs                      # 不变（update_all 不涉及扩展）
    ├── kit-copy.mjs                    # 改：KIT_ALLOWLIST 增加 spec-kit-extension
    └── bridge.mjs                      # 不变

skills/
├── sdd-setup/SKILL.md                  # 改：插入「安装内置扩展」步 + 报告扩展状态 + integration 不一致提示（REQ-15）
├── sdd-update/SKILL.md                 # 不变
└── sdd-implement/                      # 删除（整目录）

test/
└── sdd-kit.test.mjs                    # 改：技能数量断言 3→2；新增扩展契约与端到端用例

.specify/memory/constitution.md         # 改：v3.0.0（原则 I 上限 2、工作流去 /sdd-implement）
README.md                               # 改：日常流程改为纯原生命令 + 钩子说明
cordis.patch.yml                        # 改：注释 3 个技能 → 2 个
package.json                            # 改：files 增加 spec-kit-extension/
```

**Structure Decision**: 沿用现有单项目扁平结构，不新增 `src/` 子层。唯一新目录是 `spec-kit-extension/`，它是「数据 + 文档」而非 JS 模块，因此不进入 `src/`；它必须同时出现在 `package.json` 的 `files` 与 `src/core/kit-copy.mjs` 的 `KIT_ALLOWLIST` 中，否则 `/sdd-update` 复制到 profile 时扩展源会丢失。

## Phase 0 决策摘要

完整实测事实与理由见 [research.md](./research.md)。关键结论：

1. **本地目录安装必须带 `--dev`**：`specify extension add ./spec-kit-extension` 报 `Extension '...' not found in catalog`；`--dev` 才会走 `install_from_directory(link_commands=True)`。
2. **幂等靠 `--force`**：已装且未 `--force` 时 CLI 直接报 `Extension '<id>' is already installed`；`--force` 重装后同事件条目仍为 1 条（`register_hooks` 先清除本扩展旧条目再写入）。因此 `install_hooks_ext` **恒传 `--force`**。
3. **命令名只允许两段**：`^speckit\.([a-z0-9-]+)\.([a-z0-9-]+)$`，命令段不能含点 → 用 `before-bug-fix`（连字符）而非 `before.bug.fix`。生成的 DSH 技能名按 `speckit-{ext}.{cmd}` 点换横线。
4. **`optional: false` 才产出 `EXECUTE_COMMAND` 指令**：`format_hook_message` 对 `optional: true` 只打印可选提示，对 `false` 打印 `**Automatic Hook**` + `EXECUTE_COMMAND:` + `EXECUTE_COMMAND_INVOCATION:`。这是「强制」的唯一实现手段，与 REQ-13 一致。
5. **DSH 的调用前缀恒为 `/`**：`_invocation_style.ALWAYS_SLASH_AGENTS` 含 `dsh`，与 `ai_skills` 无关 → 钩子渲染出的 `/speckit-superpowers-hooks-*` 在 DSH 中可直接执行。
6. **默认 integration 改为 `dsh`**：`specify` 读 `.specify/init-options.json` 的 `integration`，`claude` → `.claude/skills/`，`dsh` → `.dsh/skills/`（实测均正确，registry 的 `registered_commands` 键随之变化）。`.claude/skills` **不在** DSH 默认技能根内（本机能看见它仅因 profile 装了第三方 `@michengai/dsh-skills-manager`），依赖可选插件才能看见钩子技能是脆弱隐式依赖。**决定**：`specify_init` 默认 integration 改为 `dsh`（REQ-14），`integration` 参数仍可覆盖；对既有 claude 项目**不自动切换**，`/sdd-setup` 只报告不一致 + 给出显式 `specify integration switch dsh` 命令与影响范围（REQ-15）。实测切换不影响 `.specify/extensions.yml`、`templates`、`scripts`，但会保留被修改过的旧 integration 文件。
7. **测试策略**：不引入 YAML 解析依赖。清单合法性由真实 `specify extension add --dev` 的退出码证明；结构断言用文本/正则（`schema_version: "1.0"`、`optional: false`、四个事件键、命令文件存在）。CLI 缺失时 `t.skip`。

## Phase 1 设计摘要

- 数据形状见 [data-model.md](./data-model.md)：扩展清单、钩子条目、安装报告三者的字段与不变量。
- 契约见 [contracts/](./contracts/)：`extension-manifest.md`（清单必须满足的校验规则）、`hook-commands.md`（四个命令文件的内容约束）、`sdd-upstream-install-hooks-ext.md`（工具动作的入参/返回/失败语义）。
- 手工验收路径见 [quickstart.md](./quickstart.md)。

### 契约要点（摘）

- `extension.yml`：`schema_version: "1.0"`；`extension.id = superpowers-hooks`；`version = 0.1.0`；`requires.speckit_version = ">=1.4.0"`；`provides.commands` 恰好 4 条且 `name` 与 `file` 一一对应；`hooks` 恰好 4 个事件，每个 `command` 指向上面 4 条命令之一，`optional: false`，`priority` 为整数（前置 5 / 后置 15）。
- 四个命令文件：只含 frontmatter `description` + 正文；正文以「按名称引用上游技能」的方式给出执行纪律，并显式声明「若 `~/.dsh/upstream/superpowers/skills` 缺失，报错并停止」（REQ-06），且不复制任何纪律正文（REQ-02/03）。
- `sdd_upstream(action: "install_hooks_ext")`：解析扩展源目录（默认包内 `spec-kit-extension/`，可被 `extensionDir` 覆盖），执行 `specify extension add --dev <dir> --force`，返回 `{ action, cwd, extensionDir, command, ok, code, stdout, stderr }`；失败不抛异常（与既有动作一致，交由调用方判断 `ok`）。

## Post-Design Constitution Re-Check

*Phase 1 产物（research.md / data-model.md / contracts/ / quickstart.md）落地后复核，确认设计未引入新的违规。*

| 原则 | 复核结果 | 设计证据 |
|------|----------|----------|
| I. 零分叉，薄胶水层 | PASS | 新增代码只有一个动作（`install_hooks_ext`）与两处清单（`files`、`KIT_ALLOWLIST`）；契约明确「一次且仅一次 `runner` 调用」「不读不写 `extensions.yml`」「不解析 YAML」。技能表面由 3 降为 2。 |
| II. 规范优先 | PASS | `data-model.md` 的 INV-1…INV-13 与 `contracts/` 的三份契约全部可回溯到 REQ/AC 编号，无新增未定义行为。 |
| III. 严格 TDD | PASS | 契约 §6 已给出测试先行清单（argv 断言、幂等、卸载、端到端 skip 条件），可在写实现前先落为失败测试。 |
| IV. 原子提交 | PASS | 任务粒度已按「契约测试 → 清单 → 命令文件 → 工具动作 → 技能 → 文档/章程」切分，每步可独立 `npm test` + commit。 |
| V. 免值守上游同步 | PASS | 扩展安装复用同一 `specify` 二进制与既有 `cwd`，无新增网络源；`--dev` 走本地目录。`specify_init` 的默认 integration 改为 `dsh` 不影响该原则——`--non-interactive --force --ignore-agent-tools` 三参数与升级路径完全未变。 |
| VI. 中文优先 | PASS | 全部新增文档为中文，命令名/字段名/路径保留原文。 |

**Phase 1 新增的三个约束**（已写入契约，实现时必须遵守）：

1. **命令引用必须用 `__SPECKIT_COMMAND_*__` 占位符**，不得硬写 `/speckit.converge`。理由：CLI 在生成技能时按 agent 的调用风格渲染占位符（`dsh` → `/speckit-converge`，`codex` → `$speckit-converge`），硬写点号形式在 skills 模式下不可执行（`extensions/__init__.py:1645` 的 `_resolve_command_ref_tokens` 只处理占位符）。
2. **`install_hooks_ext` 的 `extension.id`/`version` 用常量而非解析 YAML**。理由：零依赖约束下不引入 YAML 解析；一致性由测试的文本断言保证，运行期不双解析。
3. **`specify_init` 只在 `hasSpecifyDir === false` 时调用**（既有门控，保持不变）。理由：REQ-15 要求不自动改写既有布局；实测既有 claude 项目上重跑 `specify init --integration dsh --force` 虽是追加式（不删 `.claude/skills`、不动 `extensions.yml`），但会把 `init-options.json` 的 `integration` 翻成 `dsh` 并新建 `.dsh/skills`，仍属改写。`install_hooks_ext` 的报告负责把不一致讲清楚，切换由用户显式执行。

## Complexity Tracking

> 无 Constitution Check 违规项，本节留空。

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
