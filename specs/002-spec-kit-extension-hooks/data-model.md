# Phase 1 Data Model：Spec Kit 原生扩展钩子层

**Date**: 2026-11-23 | **Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)

本特性没有数据库。这里的「数据模型」指三类**持久化文件/结构**的字段、约束与不变量，它们全部由 Spec Kit CLI 或本插件的薄委派写入。

---

## E1. 扩展清单（Extension Manifest）

**载体**：`spec-kit-extension/extension.yml`（仓库内唯一事实来源）

| 字段 | 类型 | 约束 | 取值 |
|------|------|------|------|
| `schema_version` | string | 必须为 `"1.0"`（CLI 硬校验） | `"1.0"` |
| `extension.id` | string | 匹配 `[a-z0-9-]+` | `superpowers-hooks` |
| `extension.name` | string | 人类可读 | `Superpowers Hooks` |
| `extension.description` | string | 非空 | 说明「把 Superpowers 执行纪律织入原生 /speckit.implement 与 /speckit-bug-fix」 |
| `extension.author` | string | 非空 | `dsh-sdd-kit` |
| `extension.version` | string | 合法 semver | `0.1.0` |
| `requires.speckit_version` | string | 非空 | `">=1.4.0"` |
| `provides.commands` | list | 每项含 `name` + `file` | 恰好 4 项，见 E2 |
| `hooks` | mapping | 事件 → mapping 或非空 list | 恰好 4 个事件，见 E3 |

**不变量**：

- INV-1：`provides.commands[*].name` 与 `hooks[*].command` 构成双射——每个声明的钩子命令都能找到对应文件，且没有未被任何事件引用的命令文件。
- INV-2：不出现 `events:` 顶层键（REQ-09）；不出现 `templates:` / `scripts:` 声明（本扩展不注入模板或脚本，REQ-07）。
- INV-3：清单中不写 `settings`——`settings.auto_execute_hooks` 属项目配置，扩展无权改写（REQ-13）。

**校验责任**：`specify extension add` 是唯一权威校验器（schema 见 research R3）。本插件**不**自建 YAML 校验器（禁止并行逻辑）。

---

## E2. 钩子命令文件（Hook Command File）

**载体**：`spec-kit-extension/commands/speckit.superpowers-hooks.<command>.md` × 4

| `command`（命令段） | 文件名 | 触发事件 |
|---|---|---|
| `before-implement` | `speckit.superpowers-hooks.before-implement.md` | `before_implement` |
| `after-implement` | `speckit.superpowers-hooks.after-implement.md` | `after_implement` |
| `before-bug-fix` | `speckit.superpowers-hooks.before-bug-fix.md` | `before_bug_fix` |
| `after-bug-fix` | `speckit.superpowers-hooks.after-bug-fix.md` | `after_bug_fix` |

**文件结构**（固定四段，缺一段即视为不合规）：

1. YAML frontmatter：仅 `description:`（非空，一行）。不写 `allowed-tools` / `model`——钩子只是同会话提示，不改变工具权限。
2. `## 何时触发`：一句话说明该事件的时间点（如「在 `/speckit.implement` 读取 tasks.md 之后、第一次写源码之前」）。
3. `## 必须加载的技能`：**按名称**列出的上游技能（表格或列表），每项含技能名与加载方式（`skill` 工具，名称精确匹配）。
4. `## 执行纪律`：只写**顺序与引用**（如「按 `test-driven-development` 的 Red→Green→Refactor 循环」），不写循环内容本身。
5. `## 出口条件`：可判定的完成信号（如「所有改动任务的测试先红后绿，且 `npm test` 通过」）。

**不变量**：

- INV-4：正文 MUST NOT 复制上游技能的任何段落；只允许出现技能名、命令名、路径与顺序描述（REQ-02/03）。
- INV-5：每个文件开头 MUST 含缺失处理句——若 `~/.dsh/upstream/superpowers/skills` 不存在或缺所列技能，报告缺失项并停止，不得凭记忆代替（REQ-06）。
- INV-6：引用其它 Spec Kit 命令时 MUST 写 `__SPECKIT_COMMAND_<NAME>__` 占位符，由 CLI 按当前 agent 风格渲染（DSH 恒为 `/`，research R5）；MUST NOT 硬写 `/speckit.converge` 这类点号形式，否则 skills 模式下不可执行。

---

## E3. 钩子条目（Hook Entry，写入 `.specify/extensions.yml`）

**载体**：项目 `.specify/extensions.yml` 的 `hooks.<event>[]`，由 CLI `register_hooks` 写入，**禁止手工编辑**（spec §3 Forbidden）。

| 字段 | 类型 | 写入者 | 本特性取值 |
|------|------|--------|-----------|
| `extension` | string | CLI | `superpowers-hooks` |
| `command` | string | CLI（来自清单） | `speckit.superpowers-hooks.<command>` |
| `enabled` | bool | CLI | `true` |
| `optional` | bool | CLI（来自清单） | **`false`**（强制语义唯一来源，REQ-13） |
| `priority` | int ≥ 1 | CLI | 前置 `5` / 后置 `15` |
| `prompt` | string | CLI 默认 | `"Execute speckit.superpowers-hooks.<command>?"`（optional 为 false 时不参与渲染） |
| `description` | string | CLI（来自清单） | 一行说明 |
| `condition` | null | — | 不设置（无条件执行，避免静默跳过） |

**不变量**：

- INV-7：每个事件下本扩展的条目**恰好 1 条**（幂等，REQ-08 / AC-07）。
- INV-8：四个事件之外不得出现本扩展的条目（无孤儿，REQ-08）。
- INV-9：`settings.auto_execute_hooks` 在安装/卸载前后取值不变（REQ-13 / AC-09）。
- INV-10：`installed` 列表包含 `superpowers-hooks` 且不重复。

---

## E4. 安装报告（Install Report）

**载体**：`sdd_upstream(action: "install_hooks_ext")` 的返回值，经 `renderJsonText` 序列化后呈现给用户与 `/sdd-setup` 的汇总步骤。

```jsonc
{
  "action": "install_hooks_ext",
  "cwd": "/abs/path/to/project",
  "extensionDir": "/abs/path/to/node_modules/dsh-sdd-kit/spec-kit-extension",
  "command": "specify extension add --dev /abs/.../spec-kit-extension --force",
  "ok": true,
  "code": 0,
  "stdout": "...",
  "stderr": "",
  // 以下字段由本插件推导，非 CLI 输出
  "extension": { "id": "superpowers-hooks", "version": "0.1.0" },
  "integration": "dsh",
  "skillsDir": ".dsh/skills",
  "skillsDirInDshRoots": true,
  "integrationMismatch": null,
  "hooks": ["before_implement", "after_implement", "before_bug_fix", "after_bug_fix"],
  "restartRequired": false
}
```

**失败形态**（`ok: false`，不抛异常）：

| 场景 | `error` | 附加字段 |
|---|---|---|
| 扩展源目录不存在 | `extension source not found at <path>` | `extensionDir` |
| `specify` 不可执行 | `specify CLI not available` | `code: null` |
| CLI 返回非零 | 不设 `error`，仅 `ok: false` + `code` + `stderr` | 由调用方读 `stderr` 判断 |

**不变量**：

- INV-11：`hooks` 数组固定为四个事件名，顺序固定（`before_implement` → `after_implement` → `before_bug_fix` → `after_bug_fix`），供 AC-11 断言。
- INV-12：`skillsDir` 必须与项目 `integration` 一致（`dsh` → `.dsh/skills`；`claude` → `.claude/skills`；其余回退 `.dsh/skills` 并置 `skillsDirGuessed: true`），使 AC-07 的「DSH 可见性」可判断（research R6）。
- INV-12b：`skillsDirInDshRoots === (integration === 'dsh')`；`integrationMismatch` 当且仅当 `integration !== 'dsh'` 时为非 `null`，且其 `switchCommand` 恒为 `specify integration switch dsh`（REQ-15）。
- INV-13：`restartRequired` 仅当本次运行同时新建了 Superpowers 镜像（首次克隆）或安装了本插件的工具代码更新时为 `true`；单纯重装扩展为 `false`。

---

## E5. 关系图

```text
spec-kit-extension/extension.yml ──provides.commands──▶ commands/*.md (×4)
             │
             └──hooks.<event>.command──┐
                                       ▼
        specify extension add --dev ──▶ .specify/extensions/superpowers-hooks/  (副本)
                                       │
                                       ├──▶ .specify/extensions.yml  hooks.<event>[]  (E3)
                                       ├──▶ .specify/extensions/.registry          (CLI 维护)
                                       └──▶ <integration skills dir>/speckit-superpowers-hooks-*/SKILL.md (symlink)

sdd_upstream(install_hooks_ext) ──1 次委派──▶ specify CLI ──▶ 安装报告 (E4) ──▶ /sdd-setup 汇总输出
```

**删除 `sdd-implement` 后的表面**：对外技能 = `sdd-setup` + `sdd-update`（2 个）；Host 工具 = `sdd_upstream` + `sdd_bridge`（2 个）。执行纪律的载体从「技能」变成「扩展钩子」，不再占用技能名额。
