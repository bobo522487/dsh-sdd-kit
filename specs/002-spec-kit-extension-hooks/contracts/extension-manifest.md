# 契约：扩展清单（`spec-kit-extension/extension.yml`）

**对应**：REQ-01、REQ-02、REQ-03、REQ-04、REQ-07、REQ-09、REQ-13 / AC-01、AC-09
**数据形状**：[data-model.md E1](../data-model.md#e1-扩展清单extension-manifest)

本契约描述扩展清单**必须**长什么样，以及为什么每个字段不能随意改。清单的合法性由 `specify extension add` 校验（`specify_cli/extensions/__init__.py:280-470`），本插件不自建校验器。

---

## 1. 必须通过 CLI 校验的硬规则

| 规则 | 违反时的 CLI 错误 |
|------|------------------|
| `schema_version` 必须为 `"1.0"` | `ValidationError: Unsupported schema_version ...` |
| `extension.id` 必须匹配 `[a-z0-9-]+` | `ValidationError: Invalid extension id ...` |
| `version` 必须是合法 semver | `ValidationError: Invalid version ...` |
| `requires.speckit_version` 必须为非空字符串 | `ValidationError: requires.speckit_version must be ...` |
| `provides` 必须是 mapping，`commands` 必须是 list | `ValidationError: provides.commands must be a list` |
| 顶层 `hooks` 必须是 mapping | `ValidationError: hooks must be a mapping` |
| 每条 hook entry 必须有非空 string `command` | `ValidationError: Hook entry for event '...' must define a command` |
| `priority` 若给必须是 `>= 1` 的 int（bool 被拒） | `ValidationError: Priority must be a positive integer (1 or higher)` |
| 命令名必须匹配 `^speckit\.([a-z0-9-]+)\.([a-z0-9-]+)$` | `Invalid command name '...' must follow pattern 'speckit.{extension}.{command}'` |
| 至少提供 command / hook / event / template / script 之一 | `ValidationError: Extension must provide at least one ...` |

## 2. 目标清单（逐字段）

```yaml
schema_version: "1.0"
extension:
  id: superpowers-hooks
  name: Superpowers Hooks
  description: 把 Superpowers 执行纪律织入原生 /speckit.implement 与 /speckit-bug-fix
  author: dsh-sdd-kit
  version: "0.1.0"
requires:
  speckit_version: ">=1.4.0"
provides:
  commands:
    - name: speckit.superpowers-hooks.before-implement
      file: commands/speckit.superpowers-hooks.before-implement.md
      description: 实现前注入严格 TDD 与根因调试纪律
    - name: speckit.superpowers-hooks.after-implement
      file: commands/speckit.superpowers-hooks.after-implement.md
      description: 实现后两阶段自审并衔接 /speckit-converge
    - name: speckit.superpowers-hooks.before-bug-fix
      file: commands/speckit.superpowers-hooks.before-bug-fix.md
      description: 修复前注入系统化调试与复现测试纪律
    - name: speckit.superpowers-hooks.after-bug-fix
      file: commands/speckit.superpowers-hooks.after-bug-fix.md
      description: 修复后两阶段自审并衔接 /speckit-bug-test
hooks:
  before_implement:
    command: speckit.superpowers-hooks.before-implement
    optional: false
    priority: 5
    description: 强制加载 test-driven-development 与 systematic-debugging
  after_implement:
    command: speckit.superpowers-hooks.after-implement
    optional: false
    priority: 15
    description: 强制两阶段自审并衔接 /speckit-converge
  before_bug_fix:
    command: speckit.superpowers-hooks.before-bug-fix
    optional: false
    priority: 5
    description: 强制加载 systematic-debugging 与 test-driven-development
  after_bug_fix:
    command: speckit.superpowers-hooks.after-bug-fix
    optional: false
    priority: 15
    description: 强制两阶段自审并衔接 /speckit-bug-test
```

## 3. 不变量与理由

- **INV-1 双射**：`provides.commands[*].name` ↔ `hooks[*].command` 一一对应，`commands/` 下无孤立文件。理由：CLI 会为 `provides.commands` 里每条命令生成一个技能；未挂到事件的命令等于给用户暴露一个永远不会被自动调用的技能，违背「零分叉」。
- **INV-2 不声明 `events:`**：本特性只走 Hooks（REQ-09）。`events:` 会进入 Runtime Events 通道（`pre_tool_use` 等硬门禁），超出用户偏好。
- **INV-3 不声明 `settings`**：`settings.auto_execute_hooks` 是项目级配置，扩展写入会污染用户既有设置（REQ-13 / AC-09）。
- **INV-4 四个事件全为 `optional: false`**：`format_hook_message` 仅在 `optional: false` 时输出 `**Automatic Hook**` + `EXECUTE_COMMAND:`（research R4）。改成 `true` 会让强制语义消失，而 AC-02/AC-03 将无法成立。
- **INV-5 优先级 5 / 15**：同一事件内按 `normalize_priority` 升序执行；前置钩子必须早于任何其它可选钩子，后置钩子最后跑，保证「自审 → 衔接原生收尾命令」的次序（research R4）。
- **INV-6 不写 `condition`**：`_evaluate_condition` 对未知格式默认 `False`（静默不执行）；无条件执行才符合 REQ-02/REQ-03 的「自动」语义。
- **INV-7 `version: "0.1.0"`**：字符串（非浮点），否则 semver 校验失败。

## 4. 兼容性与升级

- `requires.speckit_version: ">=1.4.0"`：`optional: false` 与 `EXECUTE_COMMAND` 渲染在 1.4.x 稳定；实测 1.4.4.dev0 通过。
- Spec Kit 升级后若清单 schema 变更，CLI 会在 `extension add` 时报错并拒绝安装——这正是期望行为（失败可见，不静默漂移）。此时只需改本文件与对应命令文件，不改 DSH 侧代码（REQ-07 / Success Criteria 4）。
- 卸载：`specify extension remove superpowers-hooks --force` 会移除 `installed` 条目、清空本扩展全部钩子条目、删除生成的技能（AC-10）。**必须带 `--force`**，否则 CLI 会交互确认并 `Aborted`（research R2）。
