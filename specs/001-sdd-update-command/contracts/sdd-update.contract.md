# Contract: `/sdd-update` and `sdd_upstream(action: "update_all")`

日期：2026-11-23 | 规格：[spec.md](../spec.md) | 数据模型：[data-model.md](../data-model.md)

## 1. User-facing command

### Skill: `sdd-update`

| 属性 | 值 |
| :--- | :--- |
| 目录 | `skills/sdd-update/SKILL.md` |
| Frontmatter `name` | `sdd-update` |
| Frontmatter `description` | 一行说明：检查/更新 Spec Kit、Superpowers 与已安装的 dsh-sdd-kit，并给出按组件划分的报告。 |
| Frontmatter `disable-model-invocation` | `true` |
| H1 | `# /sdd-update` |
| 正文职责 | 若用户提供了可选的源码/profile 路径则解析之；恰好调用一次 `sdd_upstream(action: "update_all", ...)`；打印返回的按组件报告与重启指引。技能内不含任何更新逻辑。 |

前置条件：该技能必须已安装在当前生效的 DSH profile 中。本功能的首次采用需要按文档执行手动 profile 复制 + DSH 重启（research.md §7）。

## 2. Host tool action

现有工具 `sdd_upstream`（`src/register.mjs:14-74`）新增一个 action。工具名称与数量均不改变。

### Request

```json
{
  "action": "update_all",
  "cwd": "/path/to/project",
  "dshKitSourceDir": "/path/to/dsh-sdd-kit",
  "dshProfileDir": "/home/bobo/.dsh/profiles/web",
  "superpowersDir": "/home/bobo/.dsh/upstream/superpowers",
  "repoUrl": "https://github.com/obra/superpowers.git",
  "python": "3.14"
}
```

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `action` | `'update_all'` 字面量 | 是 | — | 分发到 `src/core/update.mjs` 中的 `runUpdate`。 |
| `cwd` | string | 否 | `process.cwd()` | 仓库根目录；必须保持只读。 |
| `dshKitSourceDir` | string | 否 | `null` | REQ-05：缺失时产生一条清晰的 `dsh-sdd-kit` 失败记录；上游仍会运行。 |
| `dshProfileDir` | string | 否 | `$DSH_PROFILE_DIR`，其次 `~/.dsh/profiles/${DSH_PROFILE:-web}` | 目标根目录；其后拼接 `node_modules/dsh-sdd-kit`。 |
| `superpowersDir` | string | 否 | `getDefaultSuperpowersDir()` | 与现有 `sdd_upstream` 行为一致。 |
| `repoUrl` | string | 否 | `DEFAULT_SUPERPOWERS_REPO` | 仅在首次克隆 Superpowers 时使用。 |
| `python` | string | 否 | `'3.14'` | 仅用于全新安装时传给 `specify_upgrade`。 |

### Response (success or partial failure)

```json
{
  "action": "update",
  "ok": true,
  "cwd": "/path/to/project",
  "requiresRestart": true,
  "components": [
    {
      "component": "spec-kit",
      "before": "specify 1.3.1",
      "after": "specify 1.4.0",
      "outcome": "updated",
      "followUp": null,
      "error": null
    },
    {
      "component": "superpowers",
      "before": "86f9e18",
      "after": "9ab2c31",
      "outcome": "updated",
      "followUp": "Restart DSH to load updated tools/skills",
      "error": null
    },
    {
      "component": "dsh-sdd-kit",
      "before": "sha256:4d1f…",
      "after": "sha256:7c0e…",
      "outcome": "updated",
      "followUp": "Restart DSH to load updated tools/skills",
      "error": null
    }
  ],
  "errors": []
}
```

完整字段语义与校验定义见 [data-model.md](../data-model.md#entities)。

### Response rules

1. 无论是否发生失败，`components` 必须恰好包含三条记录，顺序为 `spec-kit`、`superpowers`、`dsh-sdd-kit`。
2. 若任一记录满足 `outcome === 'failed'`，则 `ok` 必须为 `false`；`errors[]` 列出每个失败组件的名称与消息（REQ-03、AC-03）。
3. 已与来源一致的组件为 `unchanged`：`before === after` 且更新器没有产生有效变更（REQ-02、AC-02）。
4. `dshKitSourceDir` 缺失/无效时，产生一条 `dsh-sdd-kit` 记录，其 `outcome: 'failed'`、`before`/`after` 可能为 `null`，并带可据以处置的 `error.message`；另外两条记录必须仍然产生（REQ-05、AC-04）。
5. 当套件目录树哈希发生变化、Superpowers 返回 `mode: 'clone'`，或 Superpowers 的 `skillCount` 发生变化时，`requiresRestart` 必须为 `true`；否则为 `false`（REQ-07、AC-06）。
6. 渲染器必须为每个组件打印一行，包含 `name`、`before`、`after`、`outcome`，并附加一行总体结论以及重启指引或 "No restart required"。JSON 输出仍然可供测试使用。

### Explicit non-actions

`update_all` 不得分发到、技能也不得调用：
- `sdd_upstream` 的 `specify_init` 或 `install_bug_ext` action（`src/core/upstream.mjs:114-130`）；
- 任何 `sdd_bridge` 变更操作：`install_overrides`、`check_task`、`sync_index`（`src/core/bridge.mjs:142-230`）；
- 任何自动 DSH 重启或交互式确认提示。

## 3. Internal function contract

```js
// src/core/update.mjs
export async function runUpdate(args = {}, deps = {}) -> UpdateReport

// deps (all optional, for tests):
//   runUpstream: (args, runner?) => Promise<any>   default: imported runUpstream
//   refreshKit:  (args) => Promise<KitCopyResult>   default: imported refreshInstalledKit
```

`runUpdate` 只读取上面两个注入点。命令执行由 `runUpstream` 自己的 `runner` 参数负责，因此这里不再重复暴露 `runner`。

行为：
- 独立解析三个组件任务并用 `Promise.allSettled` 等待；将抛出的错误归一化为 `failed` 记录。
- 对上游：`status` → `specify_upgrade` / `sync_superpowers` → `status`；比较标识符；检查 `ok` 字段而不是假定会抛错。
- 对 dsh-kit：校验源/目标防护条件，对两棵树求哈希，哈希相等时跳过复制，否则暂存 + 校验 + 重命名白名单条目并重新求哈希。
- 由这三条记录推导出 `ok`、`errors`、`requiresRestart`。

```js
// src/core/kit-copy.mjs
export async function refreshInstalledKit(args = {}, deps = {}) -> KitCopyResult
// deps (all optional, for tests):
//   env:     NodeJS.ProcessEnv   default: process.env
//   homedir: () => string        default: os.homedir
```

`refreshInstalledKit` 只读取 `env` 与 `homedir` 两个注入点；文件系统与哈希直接使用 `node:fs/promises` 与 `node:crypto`，不额外注入。

## 4. Error semantics

| 条件 | 组件 | `outcome` | `error.message`（前缀） |
| :--- | :--- | :--- | :--- |
| `specify --version` 两次读取均失败 | `spec-kit` | `failed` | `Unable to read Spec Kit version:` |
| `uv` 升级/安装失败 | `spec-kit` | `failed` | `Spec Kit update failed:` |
| 镜像 HEAD 不可读，或 `git pull`/`clone` 失败 | `superpowers` | `failed` | `Superpowers update failed:` |
| `dshKitSourceDir` 缺失 | `dsh-sdd-kit` | `failed` | `No dsh-sdd-kit source configured: pass dshKitSourceDir ...` |
| 源校验失败（缺少 name/index、符号链接、路径逃逸） | `dsh-sdd-kit` | `failed` | `Invalid dsh-sdd-kit source:` |
| 暂存复制或重命名失败 | `dsh-sdd-kit` | `failed` | `dsh-sdd-kit profile copy failed:` |

错误会随报告返回，而不会用于中止整个调用。工具本身在组件级失败时不应抛出异常；只有程序员错误（未知 action）才沿用现有行为（`src/core/upstream.mjs:132-134`）。

## 5. Acceptance traceability

| AC | 契约保证 |
| :--- | :--- |
| AC-01 | 三条记录，含 before/after/outcome；全部成功时 `ok: true`。 |
| AC-02 | `unchanged` 结果；更新器没有有效变更。 |
| AC-03 | Superpowers 失败记录；另外两条记录存在；`ok: false`。 |
| AC-04 | 源缺失 → dsh-sdd-kit 失败记录；上游记录存在。 |
| AC-05 | `cwd` 从不被写入；非操作清单得到执行。 |
| AC-06 | `requiresRestart` 与渲染器指引由组件变更推导；上游超时限定延迟上限。 |
