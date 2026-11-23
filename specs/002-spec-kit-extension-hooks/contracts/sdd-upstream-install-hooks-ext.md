# 契约：`sdd_upstream(action: "install_hooks_ext")`

**对应**：REQ-01、REQ-08、REQ-10、REQ-11、REQ-13 / AC-01、AC-07、AC-11
**数据形状**：[data-model.md E4](../data-model.md#e4-安装报告install-report)

本契约描述 DSH 侧唯一的安装入口。它的全部职责是**一次委派**：解析扩展源目录 → 调用 `specify extension add --dev <dir> --force` → 结构化返回。它不解析 YAML、不改 `extensions.yml`、不生成技能。

---

## 1. 入参

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `action` | string | 是 | — | 固定 `"install_hooks_ext"` |
| `cwd` | string | 否 | `process.cwd()` | 项目根（须含 `.specify/`） |
| `extensionDir` | string | 否 | 包内 `spec-kit-extension/` | 覆盖扩展源目录；用于测试与本地开发 |
| `force` | bool | 否 | `true` | **保留但恒为 true**：不传也传 `--force`，因为重装必须幂等（research R2）。显式传 `false` 被忽略并记入报告 `forceIgnored: true` |

**禁止新增的入参**：`priority`（清单已声明）、`integration`（由项目 `init-options.json` 决定）、`version`（`--dev` 与 `--version` 互斥）。

## 2. 行为

```text
1. cwd ← resolve(args.cwd || process.cwd())
2. extensionDir ← resolve(args.extensionDir || <pkgRoot>/spec-kit-extension)
3. 若 extensionDir 不存在或不是目录 → 返回 { ok: false, error: 'extension source not found at <extensionDir>' }
4. argv ← ['extension', 'add', '--dev', extensionDir, '--force']
5. res ← runner('specify', argv, { cwd })
6. 读 .specify/init-options.json 的 integration（读失败则 'dsh'，与 specify_init 的新默认一致）
7. 返回 E4 形状的报告
```

**关键约束**：

- **一次且仅一次** `runner` 调用（章程原则 I「薄胶水」+ 既有测试 `sdd-update skill delegates once` 的同款纪律）。
- 不用 `shell: true`，不拼字符串命令。
- **不**先跑 `extension remove`（会产生无钩子窗口，且 remove 需 `--force` 且会删掉用户可能自定义过的副本）。
- **不**读、不写 `.specify/extensions.yml`（那是 CLI 的职责）。
- **不**改 `settings.auto_execute_hooks`（REQ-13）。
- 失败不抛异常：`runner` 已把非零退出码转成 `{ ok: false, code, stdout, stderr }`，直接展开进报告（与 `install_bug_ext` 的既有风格一致）。

## 3. 返回（成功）

```jsonc
{
  "action": "install_hooks_ext",
  "cwd": "/abs/project",
  "extensionDir": "/abs/node_modules/dsh-sdd-kit/spec-kit-extension",
  "command": "specify extension add --dev /abs/.../spec-kit-extension --force",
  "ok": true,
  "code": 0,
  "stdout": "✔ Extension 'superpowers-hooks' installed",
  "stderr": "",
  "extension": { "id": "superpowers-hooks", "version": "0.1.0" },
  "integration": "dsh",
  "skillsDir": ".dsh/skills",
  "skillsDirInDshRoots": true,
  "hooks": ["before_implement", "after_implement", "before_bug_fix", "after_bug_fix"],
  "restartRequired": false
}
```

- `extension.id` / `extension.version` 是本插件写死的常量（与 `spec-kit-extension/extension.yml` 一致），**不**通过解析 YAML 得到——避免引入依赖与双解析路径。二者的一致性由测试保证（测试读 YAML 文本断言，不参与运行期）。
- `hooks` 顺序固定，供 AC-11 直接断言。
- `skillsDir` 由 `integration` 推导（`dsh` → `.dsh/skills`；`claude` → `.claude/skills`；其余回退 `.dsh/skills` 并置 `skillsDirGuessed: true`），用于 AC-07 判断 DSH 可见性（research R6）。
- `skillsDirInDshRoots` 为布尔：`integration === 'dsh'` 时为 `true`（`.dsh/skills` 在 DSH 默认技能根内）；否则为 `false`，`/sdd-setup` 必须据此输出 REQ-15 的不一致提示与显式切换命令 `specify integration switch dsh`。
- `integrationMismatch` 字段：当 `integration !== 'dsh'` 时给出 `{ current: '<key>', expected: 'dsh', switchCommand: 'specify integration switch dsh', note: '<影响范围说明>' }`，否则为 `null`。

## 4. 返回（失败）

| 场景 | 形状 |
|---|---|
| 扩展源不存在 | `{ action, cwd, extensionDir, ok: false, error: 'extension source not found at <path>' }` |
| `specify` 不存在 / 不可执行 | `{ ..., ok: false, code: 127, error: 'specify CLI not available' }` |
| CLI 非零（清单非法、版本不满足等） | `{ ..., ok: false, code: <n>, stdout, stderr }`，**不设** `error`（保留原始 `stderr` 供用户判读） |

**共同要求**：无论成败都返回结构化对象，绝不抛异常——`/sdd-setup` 需要在失败后继续给出诊断摘要（REQ-11 的「同步失败仍继续」精神）。

## 5. `/sdd-setup` 的调用位置与报告要求（REQ-10 / AC-11）

工作流改为七步：

| 步 | 动作 | 说明 |
|---|---|---|
| 1 | `sdd_upstream(status)` + `sdd_bridge(inspect)` | 不变 |
| 2 | `sdd_upstream(sync_superpowers)` | 不变；首次克隆后提醒重启一次 |
| 3 | `sdd_upstream(specify_upgrade)` | 不变 |
| 4 | `sdd_upstream(specify_init)`（**仅当** `hasSpecifyDir === false`）+ `sdd_upstream(install_bug_ext)` | `specify_init` 默认 `--integration dsh`（REQ-14），`integration` 参数仍可显式覆盖。`hasSpecifyDir === true` 时**完全跳过** init——这是 REQ-15「不自动改写既有布局」的执行保证 |
| **5（新）** | **`sdd_upstream(install_hooks_ext)`** | 本次新增 |
| 6 | `sdd_bridge(install_overrides)` | 不变 |
| 7 | 汇总输出 | 增加扩展段（见下） |

第 7 步的扩展段必须包含：

```text
扩展：superpowers-hooks v0.1.0（integration=dsh，技能落盘 .dsh/skills，在 DSH 默认技能根内）
钩子：before_implement, after_implement, before_bug_fix, after_bug_fix（全部 optional: false）
状态：已安装 / 安装失败（原因）
下一步：/speckit.constitution（首次）或直接 /speckit.specify
重启：<需要 / 不需要>
```

若 `integrationMismatch !== null`（REQ-15），扩展段之后**必须**追加一段，且措辞不得暗示已自动修复：

```text
⚠ integration 不一致：当前 claude，本套件默认 dsh
   影响：钩子技能落在 .claude/skills，不在 DSH 默认技能根内，DSH 可能看不见它们
   切换（需你显式执行）：specify integration switch dsh
   切换影响：会卸载旧 integration 的未修改文件（被改过的文件保留）；.specify/extensions.yml、templates、scripts 不受影响
```

该段是**纯报告**：`/sdd-setup` MUST NOT 自行执行 `specify integration switch`，也 MUST NOT 在 `hasSpecifyDir === true` 时调用 `specify init --integration dsh`（实测该调用虽是**追加式**——不会删除 `.claude/skills`、不改 `extensions.yml`——但会把 `init-options.json` 的 `integration` 翻成 `dsh` 并新建 `.dsh/skills`，仍属改写用户布局）。

若第 2 步同步失败而第 5 步成功，必须明确写出「钩子已装但上游缺失，`/speckit.implement` 将在预钩子处按 REQ-06 失败」——不允许只报「成功」（REQ-11）。

## 6. 测试契约

| 断言 | 方法 |
|---|---|
| 只调一次 `specify`，argv 精确 | 注入假 `runner` 记录调用：`['extension','add','--dev',<dir>,'--force']` |
| 源目录不存在时不调用 `runner` | 假 runner 调用计数为 0，返回 `ok:false` + `error` |
| 返回字段齐全且 `hooks` 顺序固定 | `deepEqual(Object.keys(...))` 与 `deepEqual(hooks, [...])` |
| `--dev` 是必需项 | argv 断言中 `--dev` 存在（回归防线：research R1 的硬事实） |
| 端到端（CLI 可用时） | 临时目录 `specify init` → 真实 `install_hooks_ext` → 读 `.specify/extensions.yml` 断言四事件各 1 条 |
| 幂等（CLI 可用时） | 连跑两次 → 条目数不变、`installed` 不重复（AC-07） |
| 卸载（CLI 可用时） | `specify extension remove superpowers-hooks --force` → `installed: []` / `hooks: {}`（AC-10） |
| CLI 不可用 | `t.skip('specify CLI not available')`，不 mock |

## 显式 integration 切换（`switch_integration`，REQ-16 / AC-14）

默认路径**不调用**本动作；只有用户向 `/sdd-setup` 传 `switchIntegration: true`（或明确要求“切换到 dsh”）时才调用。

| 项 | 值 |
|---|---|
| 入参 | `action: "switch_integration"`；`cwd`（项目根）；可选 `integration`（默认 `dsh`） |
| 委托 | `specify integration switch <target>`，**恰好一次** runner 调用 |
| 回读 | 切换后重新读取 `.specify/init-options.json`，产出与 E4 相同的 `integration` / `skillsDir` / `skillsDirInDshRoots` / `integrationMismatch` 字段 |
| 失败 | 直接透传 CLI 的 `ok:false` / `code` / `stdout` / `stderr`，不合成 `error`，不抛异常 |
| 后续 | `/sdd-setup` 必须重新执行扩展安装（步骤 5），把四条命令技能重建到 `.dsh/skills` |
| 禁止 | 默认 `/sdd-setup` 路径自动调用；在 `hasSpecifyDir === true` 时重跑 `specify init` 代替切换 |

测试契约：`switch_integration` 委托次数为 1、argv 为 `['integration','switch','dsh']`、成功后 `integrationMismatch === null`、`skillsDirInDshRoots === true`；CLI 失败时保持原始 `stderr`。
