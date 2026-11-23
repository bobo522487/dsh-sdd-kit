# Quickstart：安装、验证与回滚扩展钩子层

**面向**：想在本机确认「`/speckit.implement` 真的会自动注入 TDD」的开发者。
**前提**：`specify` CLI 可用（`specify --version` 有输出）。项目可以还没初始化——`/sdd-setup` 会用 `integration=dsh` 帮你初始化；若项目已用其它 integration 初始化，`/sdd-setup` 只提示不自动切换。

---

## 1. 一次性安装（推荐路径）

在 DSH 中打开项目，执行：

```text
/sdd-setup
```

它会依次：同步 Superpowers 镜像 → 升级 `specify` CLI → `specify init`（默认 `--integration dsh`）→ 装官方 `bug` 扩展 → **装本扩展** → 安装 spec 模板覆盖 → 打印汇总（含 integration 一致性提示）。

汇总里必须能看到这一段（对应 AC-11）：

```text
扩展：superpowers-hooks v0.1.0（integration=dsh，技能落盘 .dsh/skills，在 DSH 默认技能根内）
钩子：before_implement, after_implement, before_bug_fix, after_bug_fix（全部 optional: false）
状态：已安装
重启：不需要
```

> 首次克隆 Superpowers 镜像后，`/sdd-setup` 会提示重启一次 DSH——那是为了让 `superpowers-upstream` 技能 provider 扫到新目录，与扩展安装本身无关。

## 2. 只用原生命令的日常流程

安装后**不再需要** `/sdd-implement`（该技能已删除）。日常：

| 场景 | 你敲的命令 | 自动发生什么 |
|---|---|---|
| 特性开发 | `/speckit-specify` → `/speckit-plan` → `/speckit-tasks` → **`/speckit-implement`** | 写第一行代码前自动加载 `test-driven-development` + `systematic-debugging`；全部任务完成后自动两阶段自审并提示 `/speckit-converge` |
| 缺陷修复 | `/speckit-bug-assess` → **`/speckit-bug-fix`** | 改源码前自动加载 `systematic-debugging` + `test-driven-development`；修完自动两阶段自审并提示 `/speckit-bug-test` |
| 收尾 | `/speckit-converge` / `/speckit-bug-test` | 原生行为，无钩子 |

钩子是**软门禁**：它把纪律指令写进会话，但不拦截工具调用。你要硬门禁（「未跑测试禁止 commit」）需要 Runtime Events，本特性不提供。

## 3. 验证安装是否真的生效

### 3.1 看 CLI 视角

```bash
specify extension list
```

期望（AC-01）：

```text
Installed Extensions:

  ✓ Superpowers Hooks (v0.1.0)
     superpowers-hooks
     Commands: 4 | Hooks: 4 | Priority: 10 | Status: Enabled
```

```bash
specify extension info superpowers-hooks
```

期望能看到 4 条命令（`speckit-superpowers-hooks-before-implement` 等）与 `✓ Installed`。

### 3.2 看注册表视角

```bash
grep -A6 'before_implement' .specify/extensions.yml
```

期望（AC-01 / AC-09）：

```yaml
  before_implement:
  - extension: superpowers-hooks
    command: speckit.superpowers-hooks.before-implement
    enabled: true
    optional: false
    priority: 5
```

四个事件都应存在且各 **1 条**；`optional` 必须全为 `false`；文件里不应出现 `events:` 键。

### 3.3 看技能落盘视角（DSH 可见性）

```bash
ls -l .dsh/skills/ | grep superpowers-hooks     # integration=dsh（默认）时
ls -l .claude/skills/ | grep superpowers-hooks  # 仅当项目仍是 integration=claude
```

应为 4 个 symlink 指向 `.specify/extensions/superpowers-hooks/.specify-dev/agent-commands/<agent>/...`。

> **为什么默认是 `dsh`**：DSH 的默认技能根是项目 `.dsh/skills`、`.agents/skills`、`~/.dsh/skills`、`~/.agents/skills`，**不含 `.claude/skills`**。因此 `/sdd-setup` 的 `specify init` 默认传 `--integration dsh`，装完即可被 DSH 发现，无需第三方 skills 管理器。
>
> **既有 claude 项目**：`/sdd-setup` **不会**自动改写你的布局，只在汇总里报 `integration=claude` 不一致并给出显式切换命令：
>
> ```bash
> specify integration status      # 先看当前状态
> specify integration switch dsh  # 显式切换
> ```
>
> 实测影响范围：会卸载旧 integration 的**未修改**文件（被改过的文件会保留，打印 `⚠ N modified file(s) preserved`）；`.specify/extensions.yml`、`.specify/templates/`、`.specify/scripts/` 均**不受影响**，钩子注册表与模板覆盖都不会丢。

### 3.4 端到端试一次

在任意有未完成任务的特性上执行 `/speckit-implement`。期望在它读 `tasks.md` 之后、写第一个文件之前，会话里出现：

```text
**Automatic Hook**: superpowers-hooks
Executing: `/speckit-superpowers-hooks-before-implement`
EXECUTE_COMMAND: speckit.superpowers-hooks.before-implement
EXECUTE_COMMAND_INVOCATION: /speckit-superpowers-hooks-before-implement
```

（对应 AC-02。）

## 4. 手工安装（不经 `/sdd-setup`）

```bash
# 在仓库根（扩展源目录所在处）
specify extension add --dev spec-kit-extension --force
```

要点：

- **必须带 `--dev`**。不带会得到 `Error: Extension './spec-kit-extension' not found in catalog`。
- **必须带 `--force`** 才能重复安装；否则报 `Extension 'superpowers-hooks' is already installed`。
- 路径可以是相对或绝对；推荐绝对路径（避免 cwd 变化）。

## 5. 重复安装 / 升级（AC-07）

```bash
/sdd-setup          # 再跑一次
```

或手工：

```bash
specify extension add --dev spec-kit-extension --force
grep -c 'command: speckit.superpowers-hooks.before-implement' .specify/extensions.yml
# 期望：1
```

CLI 的 `register_hooks` 会先清本扩展旧条目、再写新条目，因此**不会**出现重复或孤儿。若出现 2 条，说明有人手工编辑过 `extensions.yml`——删掉重复项后重跑安装。

## 6. 验证上游缺失时的行为（AC-06）

```bash
mv ~/.dsh/upstream/superpowers/skills ~/.dsh/upstream/superpowers/skills.bak
# 在 DSH 中执行 /speckit-implement
```

期望：预钩子报告 `~/.dsh/upstream/superpowers/skills` 缺失、列出缺失的技能名，并**停止**，不产生任何源码改动。

恢复：

```bash
mv ~/.dsh/upstream/superpowers/skills.bak ~/.dsh/upstream/superpowers/skills
```

## 7. 回滚 / 卸载（AC-10 / REQ-12）

```bash
specify extension remove superpowers-hooks --force
```

期望：

- `.specify/extensions.yml` 中四个事件下本扩展条目被清除，`installed` 不再含 `superpowers-hooks`；若没有其它扩展，文件回落为 `installed: []` / `hooks: {}`；
- `.dsh/skills/speckit-superpowers-hooks-*` 四个 symlink 被删除（若项目是 `integration=claude` 则为 `.claude/skills/` 下同名条目）；
- 配置备份在 `.specify/extensions/.backup/superpowers-hooks/`；
- `/speckit-implement` 回到无钩子的原始行为。

**必须带 `--force`**，否则 CLI 会交互确认（在非交互环境下直接 `Aborted`）。

## 8. 排错

| 症状 | 原因 | 处理 |
|---|---|---|
| `Error: Extension '...' not found in catalog` | 少了 `--dev` | 加 `--dev` |
| `already installed` | 少了 `--force` | 加 `--force` |
| 装完 `specify extension list` 看不到 | 装到了别的项目（`cwd` 不对） | 确认 `cwd` 是含 `.specify/` 的项目根 |
| 技能落盘了但 DSH 里没有 | 项目仍是 `integration=claude`，而 DSH 默认根不含 `.claude/skills` | `specify integration switch dsh`（`/sdd-setup` 会提示这条命令），或挂载 claude 技能目录 |
| 钩子没触发 | `.specify/extensions.yml` 缺条目，或 `enabled: false` | 重跑 `install_hooks_ext`；检查 `settings.auto_execute_hooks` 未被改成 `false` |
| 钩子触发但纪律没执行 | 钩子是软门禁（会话提示） | 这是设计语义；硬门禁需 Runtime Events，不在本特性范围 |
| `requires.speckit_version` 不满足 | `specify` 太旧 | `/sdd-setup`（含 `specify_upgrade`）或 `uv tool upgrade specify-cli` |

## 9. 自检清单（交付前）

- [ ] `specify extension list` 显示 `Commands: 4 | Hooks: 4 | Status: Enabled`
- [ ] `.specify/extensions.yml` 四个事件各 1 条，全部 `optional: false`
- [ ] `settings.auto_execute_hooks` 与安装前一致（AC-09）
- [ ] `.specify/templates/`、`.specify/scripts/` 未被改动（AC-08，`git status` 可证）
- [ ] `README.md`、`.specify/memory/constitution.md`、`skills/` 中不再出现 `/sdd-implement`（AC-05）
- [ ] `npm test` 通过（章程原则 III）
