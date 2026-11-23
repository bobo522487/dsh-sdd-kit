# Data Model: SDD Unified Update Command

Date: 2026-11-23 | Spec: [spec.md](./spec.md) | Contract: [sdd-update.contract.md](./contracts/sdd-update.contract.md)

## Overview

本命令无状态：读取当前标识、委托既有更新器、重新读取标识，并返回一份不可变报告。不引入数据库、缓存或持久状态文件。下文所有值均可 JSON 序列化，因为 Host 工具用 `JSON.stringify` 渲染结果（`src/register.mjs:4-6`）。

## Enums

### ComponentName

| Value | Meaning | Identifier source |
| :--- | :--- | :--- |
| `spec-kit` | GitHub Spec Kit 的 `specify` CLI | `status.specifyCli.version`（`src/core/upstream.mjs:62,:79`） |
| `superpowers` | 本地 `obra/superpowers` Git 镜像 | `status.superpowers.head` 短 SHA，可选 `skillCount`（`src/core/upstream.mjs:67-74,:82-87`） |
| `dsh-sdd-kit` | 已安装的 DSH profile 副本 | 对 allowlist 文件计算的 SHA-256 树哈希（新增） |

### Outcome

| Value | Meaning |
| :--- | :--- |
| `unchanged` | before 标识等于 after 标识且更新器报告成功；未发生有效更新工作。 |
| `updated` | before 标识不同于 after 标识且更新器报告成功。 |
| `failed` | 该组件的读取、更新或校验失败。其他组件仍会获得记录。 |

## Entities

### ComponentUpdateRecord

每个受管组件一条；与规范中的 “Component Update Record” 一一对应（`spec.md:50-51`）。

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `component` | `ComponentName` | yes | 稳定的机器可读名称；MUST 为三个枚举值之一。 |
| `before` | `string \| null` | yes | 更新尝试前的标识；不可读或缺失时为 `null`。 |
| `after` | `string \| null` | yes | 更新尝试后的标识；不可读、缺失或校验未成功时为 `null`。 |
| `outcome` | `Outcome` | yes | 结果分类。 |
| `followUp` | `string \| null` | yes | 因该组件而需要的用户操作，例如 `"Restart DSH to load updated tools/skills"`。无则为 `null`。 |
| `error` | `{ message: string, code?: string } \| null` | yes | 归一化的失败详情；`unchanged`/`updated` 时 MUST 为 `null`。 |

**Validation rules**
- 报告 MUST 为每个 `ComponentName` 恰好包含一条记录，顺序固定为 `spec-kit`、`superpowers`、`dsh-sdd-kit`。
- 当 `outcome !== 'failed'` 时，`before` 与 `after` MUST 为字符串（完全读取失败时二者同为 `null`）。
- 当 `outcome === 'failed'` 时，`error` MUST NOT 为 `null`。
- 当某组件导致 `UpdateReport.requiresRestart === true` 时，其 `followUp` MUST 非空。

### UpdateReport

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `action` | `'update'` | yes | 与其他 core 结果一致的判别字段。 |
| `ok` | `boolean` | yes | 仅当每条记录的 `outcome !== 'failed'` 时为 `true`（REQ-03/REQ-04，`spec.md:18-19`）。 |
| `components` | `ComponentUpdateRecord[]` | yes | 恰好三条记录。 |
| `requiresRestart` | `boolean` | yes | 任一组件带有需要重启的非空 `followUp` 时为 `true`。 |
| `errors` | `{ component: ComponentName, message: string }[]` | yes | 失败组件的扁平列表；`ok === true` 时为空。 |
| `cwd` | `string` | yes | 传入并解析后的仓库根目录；仅用于诊断，绝不写入。 |

### KitCopyResult

`src/core/kit-copy.mjs` 中 `refreshInstalledKit` 的内部结果。

| Field | Type | Description |
| :--- | :--- | :--- |
| `changed` | `boolean` | 暂存树哈希与已安装树哈希不同时为 `true`。 |
| `beforeHash` | `string \| null` | 尝试前的已安装树哈希；目标缺失或不可读时为 `null`。 |
| `afterHash` | `string \| null` | 成功换入后的树哈希；未变化时等于 `beforeHash`。 |
| `changedFiles` | `string[]` | 内容不同的 allowlist 相对路径，已排序。未变化时为空。 |
| `destDir` | `string` | 已安装 profile 的绝对路径。 |
| `mode` | `'unchanged' \| 'updated'` | 与最终结果一致（失败以错误形式返回，而非 mode）。 |

### UpdateArgs

`runUpdate(args, deps)` 的输入。

| Field | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `cwd` | `string` | no | `process.cwd()` | 仓库根目录；只读边界。 |
| `dshKitSourceDir` | `string` | no | `null` | 本地 dsh-sdd-kit 源检出。缺失 → 为 `dsh-sdd-kit` 产生 REQ-05 失败记录。 |
| `dshProfileDir` | `string` | no | `$DSH_PROFILE_DIR`，其次 `~/.dsh/profiles/${DSH_PROFILE:-web}` | DSH profile 根目录；目标为 `<profileDir>/node_modules/dsh-sdd-kit`。 |
| `superpowersDir` | `string` | no | `getDefaultSuperpowersDir()`（`src/core/upstream.mjs:11-13`） | 供 `status` / `sync_superpowers` 使用的镜像路径。 |
| `repoUrl` | `string` | no | `DEFAULT_SUPERPOWERS_REPO`（`src/core/upstream.mjs:9`） | 仅在需要首次克隆时使用。 |
| `python` | `string` | no | `'3.14'` | 全新安装 `specify-cli` 时的稳定 Python 覆盖值。 |

### KitCopyConfig

在 `refreshInstalledKit` 内部推导；不作为独立工具参数暴露。

| Field | Type | Description |
| :--- | :--- | :--- |
| `sourceDir` | `string` | 已解析并校验的本地检出。 |
| `destDir` | `string` | 已解析的已安装 profile 路径。 |
| `allowlist` | `string[]` | `src/`、`skills/`、`overrides/`、`cordis.patch.yml`、`README.md`、`LICENSE`、`package.json`（来自 `package.json:13-20` 加总会附带的元数据）。 |
| `rejectSymlinks` | `true` | 源或目标中任何 symlink 均为校验错误。 |

## State transitions

```text
[read before identifier]
        │
        ├─ read error ───────────────────────────► failed
        │
        ▼
[is component already current?]   (hash equal for kit; identifier equality after idempotent updater for upstreams)
        │
        ├─ yes ──► unchanged ──► followUp = null
        │
        ▼
[run thin updater / staged kit swap]
        │
        ├─ updater/verification error ──────────► failed
        │
        ▼
[read after identifier and compare]
        ├─ after === before ─► unchanged
        └─ after !== before ─► updated ──► followUp if restart-required condition holds
```

重启条件（见 research.md §5）：kit `changed === true`；Superpowers `mode === 'clone'`；Superpowers 的 `skillCount` 在前后两次 status 之间不同。`spec-kit` 更新永不设置 `followUp`。

## Invariants and forbidden mutations

1. 即使某组件失败，每个组件也恰好有一条 `ComponentUpdateRecord`。
2. `ok === true` 当且仅当没有记录的 `outcome === 'failed'`。
3. `/sdd-update` 不得在 `cwd` 下创建、修改或删除任何路径（`specs/`、`plan.md`、`tasks.md`、`.specify/`、应用源码）（REQ-06，`spec.md:21`；AC-05，`spec.md:35`）。
4. 不得调用 `specify_init`、`install_bug_ext`、`install_overrides`、`check_task` 或 `sync_index`（禁止行为，`spec.md:27`）。
5. kit 复制只触碰 `destDir` 内 allowlist 条目；源与目标不得互相包含；不得整目录删除。
6. `requiresRestart` 仅由组件记录推导，绝不单独由总体 `ok` 推导。
