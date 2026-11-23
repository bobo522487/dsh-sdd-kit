# Phase 0 Research：Spec Kit 原生扩展钩子层

**Date**: 2026-11-23 | **Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)

本文件记录实现所需的事实与决策。所有「实测」结论都在一次性临时项目（`/tmp/probe-ext`，`integration=claude`；`/tmp/probe-dsh`，`integration=dsh`）中用真实的 `specify` 1.4.4.dev0 验证过，不是文档推测。

---

## R1. 本地目录扩展的安装方式：必须 `--dev`

**问题**：`/sdd-setup` 如何把仓库内 `spec-kit-extension/` 装进项目？

**实测**：

| 命令 | 结果 |
|------|------|
| `specify extension add ./spec-kit-extension` | 失败：`Error: Extension './spec-kit-extension' not found in catalog` + `Search available extensions:` |
| `specify extension add --dev spec-kit-extension` | 成功（相对路径、绝对路径均可） |
| `specify extension add --dev` （无路径） | 失败：`Error: --dev requires the path to a local extension directory.` |
| `specify extension add --dev <dir> --version 0.1.0` | 失败：`--version requires a catalog install (without --dev or --from)` |

**决策**：`install_hooks_ext` 恒使用 `['extension', 'add', '--dev', <absDir>, '--force']`。`--dev` 在 CLI 内部对应 `install_from_directory(..., link_commands=True)`，因此生成的技能是**符号链接**（指向 `.specify/extensions/<id>/.specify-dev/agent-commands/<agent>/<skill>/SKILL.md`），扩展源目录被改动后技能内容即时生效——这对仓库内开发迭代是优点，对 profile 副本则意味着「源目录必须存在」，故 `spec-kit-extension/` 必须进入 `package.json` 的 `files` 与 `KIT_ALLOWLIST`。

**替代方案被否**：把扩展发布到 catalog 需要发布流程与网络；`--from <url>` 需要托管仓库。二者都违背「零新增网络源」的章程约束。

---

## R2. 幂等性：`--force` 是唯一可行路径

**实测**：

- 已装且不带 `--force`：`Error: Extension 'superpowers-hooks' is already installed. Use 'specify extension remove superpowers-hooks' first, or retry with --force to overwrite.`
- 带 `--force` 重装后：`.specify/extensions.yml` 中 `before_implement` / `after_implement` 各仍为 **1** 条，`installed` 仍为 1 项，无重复。

**机制**（`specify_cli/extensions/__init__.py` 的 `register_hooks`，:6125–6230）：写入前先清除「本扩展在此事件下的旧条目」，并按新清单清掉「新清单未声明事件的孤儿条目」，最后删除空列表；同一事件内按 `command` 去重（后写覆盖）。

**决策**：`install_hooks_ext` **恒传 `--force`**，使 `/sdd-setup` 可重复运行（REQ-09 / AC-09）。不用「先 `remove` 再 `add`」——那会在中途留下无钩子窗口，且 `remove` 需要交互确认（`--force` 才能跳过）。

---

## R3. 清单与命令命名的硬约束

**校验规则**（`extensions/__init__.py`）：

- `schema_version` 必须为 `"1.0"`；
- `extension.id` 必须匹配 `[a-z0-9-]+`；
- `version` 必须是合法 semver 字符串；
- `requires.speckit_version` 必须为非空字符串；
- `provides` 必须是 mapping，其中 `commands` / `templates` / `scripts` 必须是 list；至少要提供 command / hook / event / template / script 之一；
- 顶层 `hooks` 必须是 mapping；每个事件值为 mapping 或非空 list；每条 entry 必须有非空 string `command`；`priority` 若给必须是 `>= 1` 的整数（bool 被拒）；
- 命令名必须匹配 `EXTENSION_COMMAND_NAME_PATTERN = re.compile(r"^speckit\.([a-z0-9-]+)\.([a-z0-9-]+)$")`（:74）。

**决策**：

| 项 | 取值 | 理由 |
|----|------|------|
| `extension.id` | `superpowers-hooks` | 短、语义明确、符合 `[a-z0-9-]+`；不与官方 `bug` / `git` 冲突 |
| `version` | `0.1.0` | 首个内置版本；清单变更时才升 |
| `requires.speckit_version` | `>=1.4.0` | `optional: false` + `EXECUTE_COMMAND` 渲染在该区间稳定；实测 1.4.4.dev0 通过 |
| 命令名 | `speckit.superpowers-hooks.before-implement` 等 4 条 | 两段式约束下命令段不能含点，故 bug 事件用连字符 `before-bug-fix` / `after-bug-fix` |
| 生成的技能名 | `speckit-superpowers-hooks-before-implement` 等 | CLI 规则 `speckit-{ext}.{cmd}` 点换横线，无需手工指定 |

---

## R4. 强制语义只由 `optional: false` 承担

**实测**（用 `HookExecutor.format_hook_message`）：

- `optional: true` 输出 `**Optional Hook**` + `Command:` / `Description:` / `Prompt:` / `To execute:`——只是提示，agent 可以不执行；
- `optional: false` 输出 `**Automatic Hook**: superpowers-hooks` + `Executing: /speckit-superpowers-hooks-before-implement` + `EXECUTE_COMMAND: speckit.superpowers-hooks.before-implement` + `EXECUTE_COMMAND_INVOCATION: /speckit-superpowers-hooks-before-implement`——`EXECUTE_COMMAND` 是给 agent 的强制指令。

**决策**：四个事件全部 `optional: false`，不设 `prompt`（该字段只在 optional 提示里用），不写 `condition`（无条件执行，避免 `_evaluate_condition` 对未知格式默认 `False` 而静默跳过）。**不改** `settings.auto_execute_hooks`——它是全局开关，改动会影响用户已装的 `bug` 扩展行为（REQ-13）。

**优先级**：前置钩子 `priority: 5`，后置钩子 `priority: 15`。同一事件内按 `normalize_priority` 升序执行，前置先于任何其它可选钩子，后置最后——这样 `after_implement` 的「自审 → 提示 converge」在其它后置提示之前完成。官方 `bug` 扩展无 hooks，不与本扩展争序。

---

## R5. DSH 的调用前缀恒为 `/`

**实测**（`specify_cli/_invocation_style.py`）：`ALWAYS_SLASH_AGENTS` 含 `dsh`（另有 devin / docker-agent / droid / grok / mcode / muse / qodercli / trae / zed）。该集合**不依赖 `ai_skills`**，恒渲染 `/speckit-<name>`。`CONDITIONAL_SLASH_AGENTS`（claude / generic / copilot …）才需要 `ai_skills`；`DOLLAR_SKILLS_AGENTS`（codex / zcode / command-code）用 `$`；`kimi` 用 `/skill:`。

**决策**：钩子正文里引用其它 Spec Kit 命令时一律写 `/speckit-*` 形式（如 `/speckit-converge`），在 DSH 与 claude 两种 integration 下都成立，无需条件分支。

---

## R6. 技能落盘位置由项目 integration 决定，`/sdd-setup` 必须报告它

**实测**：

| `init-options.json` 的 `integration` | 生成技能目录 | `.registry` 的 `registered_commands` 键 |
|---|---|---|
| `claude` | `.claude/skills/` | `"claude"` |
| `dsh` | `.dsh/skills/` | `"dsh"` |

两者都生成 symlink，`dsh` 走官方 `integrations/dsh/__init__.py`（`folder=".dsh/"`、`commands_subdir="skills"`、`multi_install_safe=True`）。

**DSH 的技能根**（`@deepseek-ai/dsh-skill-filesystem` 的 `roots()`，`src/index.ts:251-270`）：项目 `.dsh/skills` → 项目 `.agents/skills` → `customSkillDirs` → 用户 `~/.dsh/skills` → `~/.agents/skills` → `bundledSkillDir`。**`.claude/skills` 不在默认根内**；本机能看见 `.claude/skills` 下的 speckit 技能，是因为 profile 额外装了第三方 `@michengai/dsh-skills-manager`（其 `lib/core.js:77` 注册了 `{ key: "claude", directory: ".claude" }`）。

**决策（经 m00603 修订）**：`specify_init` 的默认 integration 从 `claude` 改为 **`dsh`**。理由：本套件的宿主就是 DSH，`.claude/skills` 不在 DSH 默认技能根内，本机能看见它纯属 profile 额外装了第三方 `@michengai/dsh-skills-manager`；依赖一个可选第三方插件才能看见钩子技能，是脆弱的隐式依赖。改为 `dsh` 后技能落在 DSH 原生根 `.dsh/skills`，零额外插件即可被发现。

`integration` 参数仍保留可覆盖（`args.integration`），因此需要 claude 布局的用户不受影响。

**对既有项目**：`/sdd-setup` **不自动**切换 integration（那会删改用户既有布局）。实测 `specify integration switch dsh` 的行为：

| 场景 | 实测结果 |
|---|---|
| 全新 `specify init --integration dsh` | 生成 `.dsh/skills/` 9 个技能，不创建 `.claude/` |
| 既有 claude 项目上 `specify integration switch dsh` | 卸载 claude（移除 8 个未修改文件），安装 dsh 11 个技能；**修改过的文件被保留**（`⚠ 1 modified file(s) preserved`），故 `.claude/skills` 可能残留 |
| `switch` 对 `.specify/extensions.yml` 的影响 | 无（`diff` 为空）——钩子注册表不受 integration 切换影响 |
| `switch` 对 `.specify/templates`、`.specify/scripts` 的影响 | 无（`diff -rq` 为空） |
| 既有 claude 项目上重跑 `specify init --integration dsh --force` | **追加式**：`.claude/skills` 11 个条目一个不少、`.specify/extensions.yml` 的钩子条目不变；但 `init-options.json` 的 `integration` 与 `ai` 被翻成 `dsh`，并新建 `.dsh/skills`（11 个技能） |
| `specify integration status` 输出 | `Default integration: <key>` / `Installed integrations: <keys>` / `Modified managed files: N` / `Missing managed files: N` |

因此 `/sdd-setup` 必须：

1. 读 `.specify/init-options.json` 的 `integration`（缺省视为 `claude`，兼容旧项目）；
2. 若 ≠ `dsh`，在报告中给出**显式**切换命令 `specify integration switch dsh` 与影响范围（会卸载旧 integration 的未修改文件；修改过的文件被保留；`extensions.yml`/`templates`/`scripts` 不受影响）；
3. 绝不自动执行切换，**也绝不**在 `hasSpecifyDir === true` 时重跑 `specify init --integration dsh`——实测它虽是追加式（不删 `.claude/`、不动 `extensions.yml`），但会把 `init-options.json` 翻成 `dsh` 并新建 `.dsh/skills`，仍属改写用户布局。既有 `/sdd-setup` 第 4 步的 `hasSpecifyDir === false` 门控正好满足这一点，保持不变。

`install_hooks_ext` 的返回值与 `/sdd-setup` 的报告仍须包含：项目 `integration` key、钩子技能的实际落盘目录（`dsh` → `.dsh/skills`，`claude` → `.claude/skills`，其余按 CLI 默认）、以及「该目录是否在 DSH 默认技能根内」的判定。

这满足 AC-07「用户能判断钩子是否真的在 DSH 中可见」，同时不越界替用户改项目配置。

---

## R7. 钩子正文如何「只引用、不内联」上游纪律

**约束**（REQ-02/03 + 澄清 2）：唯一纪律来源是 `~/.dsh/upstream/superpowers/skills`；命令文件 MUST NOT 复制技能正文。

**上游技能清单**（实测 15 个）：`brainstorming`、`diagnosing-superpowers`、`dispatching-parallel-agents`、`executing-plans`、`finishing-a-development-branch`、`receiving-code-review`、`requesting-code-review`、`subagent-driven-development`、`systematic-debugging`、`test-driven-development`、`using-git-worktrees`、`using-superpowers`、`verification-before-completion`、`writing-plans`、`writing-skills`。

**四个命令文件引用的技能**：

| 命令文件 | 引用的上游技能（按名称） |
|---|---|
| `before-implement` | `test-driven-development`（Red→Green→Refactor）、`systematic-debugging`（遇红先找根因） |
| `after-implement` | `verification-before-completion`（证据先于断言）、`requesting-code-review`（两阶段自审） |
| `before-bug-fix` | `systematic-debugging`（根因先于补丁）、`test-driven-development`（先写复现测试） |
| `after-bug-fix` | `verification-before-completion`、`requesting-code-review` |

**决策**：命令文件正文采用固定四段结构——「何时触发（一句话）」「必须加载的技能（按名称列表 + 加载方式）」「执行纪律（**只写引用与顺序**，如『按 `test-driven-development` 的 Red→Green→Refactor 循环』，不写循环内容）」「出口条件（可判定的完成信号）」。并在开头声明：若 `~/.dsh/upstream/superpowers/skills` 不存在或缺少所列技能，MUST 立即报告缺失技能名并停止，MUST NOT 用记忆中的纪律代替（REQ-06）。

---

## R8. 测试策略：不引入 YAML 依赖，靠真实 CLI 兜底

**约束**：Node >= 18 ESM、零新增 npm 依赖（章程技术约束）。因此测试不能 `import yaml`。

**决策**（三层）：

1. **静态结构断言**（纯文本/正则，无依赖）：`spec-kit-extension/extension.yml` 含 `schema_version: "1.0"`、`id: superpowers-hooks`、四个事件键、每条钩子 `optional: false`、四个 `commands/*.md` 文件存在且 frontmatter 有 `description:`。
2. **真实 CLI 端到端**（`spawnSync('specify', ...)`，用临时目录 `specify init` 后 `extension add --dev`）：断言退出码 0、`.specify/extensions.yml` 出现四个事件各 1 条、`installed` 含 `superpowers-hooks`、重装一次后条目数不变（幂等）、`extension remove --force` 后回落到 `installed: []` / `hooks: {}`（AC-10）。`specify` 不在 PATH 时 `t.skip('specify CLI not available')`——不 mock。
3. **委派契约断言**：`install_hooks_ext` 只调用一次 `specify`，参数为 `['extension','add','--dev',<dir>,'--force']`；用注入的假 `runner` 断言 argv 与返回值形状（这是既有测试风格：`contract injection points match the deps the implementation actually reads`）。

**替代方案被否**：引入 `yaml` 依赖解析清单——违背零依赖约束，且 CLI 才是唯一权威校验器（schema 变更时手写解析会静默漂移）。

---

## R9. 删除 `sdd-implement` 的连带影响

**受影响点**（已逐一确认）：

| 位置 | 现状 | 动作 |
|---|---|---|
| `skills/sdd-implement/` | 目录 + SKILL.md | 删除整目录 |
| `test/sdd-kit.test.mjs:183-189` | 断言恰好 `['sdd-implement','sdd-setup','sdd-update']`，测试名含「exactly 3」 | 改为 `['sdd-setup','sdd-update']`，测试名改「exactly 2」 |
| `cordis.patch.yml` 注释 | 「3 个桥接技能（/sdd-setup、/sdd-implement、/sdd-update）」 | 改为 2 个 |
| `README.md` 开头 | 「3 个技能 + 2 个薄 Host 工具」 | 改为 2 个技能 |
| `README.md:43`、`README.md:46` | 指向 `/sdd-implement` | 改为原生命令 + 钩子说明 |
| `.specify/memory/constitution.md:27` | 「三个命名技能（sdd-setup、sdd-implement、sdd-update）」 | 改为两个 |
| `.specify/memory/constitution.md:35` | 「sdd-setup 与 sdd-implement 不变」 | 改写迁移说明 |
| `.specify/memory/constitution.md:93`、`:96` | 工作流写 `/sdd-implement` | 改为 `/speckit-implement` + 钩子 |
| `skills/sdd-setup/SKILL.md` | 六步工作流 | 插入「安装内置扩展」步 |

**决策**：章程版本从 `2.1.0` 升到 **`3.0.0`**（对外技能表面破坏性收缩，属 MAJOR）。`skills/sdd-update/SKILL.md` 不动（它明令不调 `sdd_bridge`，也不涉及实现流程）。

---

## R10. 扩展源目录在 profile 副本中的可达性

**问题**：`/sdd-update` 把包复制到 `~/.dsh/profiles/<profile>/node_modules/dsh-sdd-kit` 时，`spec-kit-extension/` 会不会丢？

**事实**：`src/core/kit-copy.mjs:6` 的 `KIT_ALLOWLIST = ['src','skills','overrides','cordis.patch.yml','README.md','LICENSE','package.json']` 是复制白名单；`package.json` 的 `files` 是发布白名单。两者都不含 `spec-kit-extension`。

**决策**：两处都加 `spec-kit-extension`。`install_hooks_ext` 解析扩展源目录的顺序为：`args.extensionDir`（显式覆盖）→ 包根 `spec-kit-extension/`（由 `import.meta.url` 上溯，与 `PKG_ROOT` 同法）→ 若不存在则返回 `{ ok: false, error: 'extension source not found at ...' }` 而不抛异常（与既有动作「失败也返回结构」的风格一致）。

---

## 未决 / 留给后续特性

- Runtime Events（`pre_tool_use` 硬门禁「未跑测试禁止 commit」）——用户明确只走 Hooks，本特性不实现，仅在 README 留一句「未来可升级口」。
- `specify integration switch` 在**修改过**的旧 integration 文件上会保留残留（实测 `⚠ 1 modified file(s) preserved`），是否需要 `/sdd-setup` 提供清理建议——本特性只报告，不清理。
