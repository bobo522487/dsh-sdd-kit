# 契约：钩子命令文件（`spec-kit-extension/commands/*.md`）

**对应**：REQ-02、REQ-03、REQ-04、REQ-06 / AC-02、AC-03、AC-04、AC-06
**数据形状**：[data-model.md E2](../data-model.md#e2-钩子命令文件hook-command-file)

四个命令文件是「纪律注入」的全部载体。它们**不是**代码，而是被 CLI 转成技能正文的 Markdown。

---

## 1. 四个文件与事件的双射

| 文件 | 事件 | `optional` | `priority` |
|---|---|---|---|
| `commands/speckit.superpowers-hooks.before-implement.md` | `before_implement` | `false` | 5 |
| `commands/speckit.superpowers-hooks.after-implement.md` | `after_implement` | `false` | 15 |
| `commands/speckit.superpowers-hooks.before-bug-fix.md` | `before_bug_fix` | `false` | 5 |
| `commands/speckit.superpowers-hooks.after-bug-fix.md` | `after_bug_fix` | `false` | 15 |

文件名必须与 `provides.commands[*].file` 完全一致（含 `speckit.` 前缀与连字符）。

## 2. 文件结构（缺一段即不合规）

```markdown
---
description: "<一行，非空，≤ 120 字>"
---

# <标题>

## 何时触发

<一句话：该事件在原生命令生命周期中的位置>

## 上游依赖检查

<缺失处理：MUST 报告并停止，不得凭记忆代替>

## 必须加载的技能

| 技能名 | 加载方式 | 用途 |
|---|---|---|
| `test-driven-development` | `skill` 工具，名称精确匹配 | Red→Green→Refactor |

## 执行纪律

<只写顺序与引用，不写纪律正文>

## 出口条件

<可判定的完成信号>
```

## 3. 逐文件要求

### 3.1 `before-implement`（REQ-02）

- **何时触发**：`/speckit.implement` 读取 `tasks.md` 并选定第一个未完成任务之后、写入任何源码之前。
- **必须加载的技能**：`test-driven-development`（强制）、`systematic-debugging`（测试转红后强制）。
- **执行纪律**（只写顺序）：
  1. 每个任务先写失败测试，确认红（引用 `test-driven-development` 的 Red 阶段定义）；
  2. 写最小实现转绿（Green），再重构（Refactor）；
  3. 遇到非预期失败时按 `systematic-debugging` 先定位根因，禁止猜测式修补；
  4. 每个任务完成即 `git commit`（章程原则 IV），消息用中文。
- **出口条件**：所选任务的测试经历「红 → 绿」，`npm test` 通过，且已产生一次原子提交。
- **禁止**：一次实现多个任务；跳过红阶段直接写实现；在 `npm test` 未过时勾选任务。

### 3.2 `after-implement`（REQ-04）

- **何时触发**：`/speckit.implement` 处理完 `tasks.md` 全部（或用户指定范围内全部）任务之后、命令返回之前。
- **必须加载的技能**：`verification-before-completion`（强制）、`requesting-code-review`（强制）。
- **执行纪律**（两阶段自审，只写顺序）：
  1. **阶段一 · 规范符合性**：逐条对照 `spec.md` 的 REQ / AC，指出未覆盖项；
  2. **阶段二 · 质量与纪律**：对照章程（TDD、原子提交、零新增依赖、零分叉）逐条核对；
  3. 两阶段都产出「通过 / 不通过 + 证据（命令与输出）」；
  4. 自审通过后，衔接原生 `__SPECKIT_COMMAND_CONVERGE__` 收敛未建工作；
  5. 任一阶段不通过时，列出待补任务并回到 `/speckit-implement`，不得直接宣告完成。
- **出口条件**：两阶段自审均有明确结论与证据；已提示执行 `__SPECKIT_COMMAND_CONVERGE__`。
- **禁止**：无证据宣告「完成 / 通过」；用自审替代真实测试运行。

### 3.3 `before-bug-fix`（REQ-03）

- **何时触发**：`/speckit-bug-fix` 解析出 `slug` 并确认 `.specify/bugs/<slug>/assess.md` 存在之后、修改任何源码之前。
- **必须加载的技能**：`systematic-debugging`（强制）、`test-driven-development`（强制）。
- **执行纪律**（只写顺序）：
  1. 按 `systematic-debugging` 复述根因假设与证据链（引用评估报告的根因段）；
  2. 先写一个能复现该 bug 的失败测试，确认红；
  3. 最小改动转绿，再重构；
  4. 每个原子改动一次 `git commit`。
- **出口条件**：复现测试从红转绿；根因与评估报告一致（不一致时先更新评估报告再继续）。
- **禁止**：无复现测试即改源码；顺手重构无关代码；在根因未确认时批量修改。

### 3.4 `after-bug-fix`（REQ-04）

- **何时触发**：`/speckit-bug-fix` 写完修复报告 `.specify/bugs/<slug>/fix.md` 之后。
- **必须加载的技能**：`verification-before-completion`、`requesting-code-review`。
- **执行纪律**（两阶段自审 + 衔接）：
  1. **阶段一 · 缺陷闭环**：复现测试仍绿、原失败场景已消失、无新增失败测试；
  2. **阶段二 · 副作用审查**：改动范围是否超出评估报告、是否有回归风险、提交是否原子；
  3. 自审通过后衔接原生 `__SPECKIT_COMMAND_BUG_TEST__`；
  4. 不通过时列出缺口，回到 `/speckit-bug-fix`。
- **出口条件**：两阶段自审有结论与证据；已提示执行 `__SPECKIT_COMMAND_BUG_TEST__`。

## 4. 跨文件不变量

- **INV-4 只引用不内联**：正文 MUST NOT 出现上游技能的任何段落原文；允许出现的只有技能名、命令名、路径、顺序描述。自检方法：`grep -c` 上游 SKILL.md 的任意连续 8 词片段，命中数必须为 0。
- **INV-5 缺失即失败**：每个文件 `## 上游依赖检查` 段 MUST 含缺失路径 `~/.dsh/upstream/superpowers/skills` 与「报告缺失技能名并停止」的指令（REQ-06 / AC-06）。
- **INV-6 命令引用用占位符**：引用其它 Spec Kit 命令时使用 `__SPECKIT_COMMAND_CONVERGE__` / `__SPECKIT_COMMAND_BUG_TEST__` 占位符——CLI 会按当前 agent 的调用风格渲染（`dsh` → `/speckit-converge`，`codex` → `$speckit-converge`）。**不要**硬写 `/speckit.converge`（点号形式在 skills 模式下不可执行）。
- **INV-7 frontmatter 只有 `description`**：不写 `allowed-tools`、`model`、`user-invocable`；CLI 会自行补齐 `name` / `compatibility` / `metadata` / `user-invocable: true` / `disable-model-invocation: false`。
- **INV-8 无 `$ARGUMENTS`**：钩子不接收用户参数（它在命令执行中途被注入），写入 `$ARGUMENTS` 会渲染成空串并误导读者。
- **INV-9 篇幅上限**：每个文件 ≤ 60 行。钩子越长，越容易诱导 agent 把它当实现计划而非纪律清单。

## 5. 验证方式

| 断言 | 方法 |
|---|---|
| 四文件存在且 frontmatter 有 `description` | 测试里读文件 + 正则 `^---\ndescription: "?.+"?\n---` |
| 四段结构齐全 | 正则匹配 `## 何时触发`、`## 必须加载的技能`、`## 执行纪律`、`## 出口条件` |
| 无内联纪律 | 人工评审 + 与上游技能做 8 词片段比对（测试里只做关键词黑名单：`Red-Green-Refactor 的具体步骤`、`假设检验五步法` 等不得出现） |
| 占位符正确 | `grep -c '__SPECKIT_COMMAND_CONVERGE__'` = 1（after-implement）；`__SPECKIT_COMMAND_BUG_TEST__` = 1（after-bug-fix） |
| 上游缺失处理 | `grep -c '~/.dsh/upstream/superpowers/skills'` ≥ 1 每文件 |
