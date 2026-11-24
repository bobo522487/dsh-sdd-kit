# Phase 1 Data Model：安装与覆盖层的安全性加固

**Date**: 2026-11-23 | **Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md) | **Research**: [research.md](./research.md)

本特性没有数据库。这里的「数据模型」指**持久化文件与工具返回值**的字段、约束与不变量：两类落盘文件（历史版本台账、快照清单）与三类工具返回结构（状态判定、候选选择、安装报告）。所有字段名即为实现与契约测试中使用的字面量。

---

## E1. 受管安装产物（Managed Artifact）

**载体**：项目内的文件路径 + 仓库内的随包文件。

本特性只对**一个**产物拥有写权；其余两类产物的写入权在上游 CLI（research.md R1「范围收敛」）。

| 字段 | 类型 | 约束 | 取值 |
|------|------|------|------|
| `id` | string | 稳定、kebab-case、与快照文件名同源 | 当前仅 `"ears-spec-template"` |
| `path` | string | 绝对路径；MUST 位于 `<cwd>/.specify/templates/overrides/` 下 | `<cwd>/.specify/templates/overrides/spec-template.md` |
| `bundledPath` | string | 绝对路径；MUST 位于插件包根 `overrides/` 下 | `<PKG_ROOT>/overrides/spec-template.md` |
| `bundledSha256` | string | 64 位小写 hex | 当前 `803203dce4e93f53d25cc3bf77774f91769a21cfac44be055015bfd6fe5458fb` |
| `ledgerPath` | string | 绝对路径 | `<PKG_ROOT>/overrides/spec-template.versions.json` |
| `owner` | enum | 谁能写 | `plugin`（唯一可写者） |
| `snapshotDir` | string | 绝对路径；目录内含自忽略文件 `.gitignore`（内容 `*`），使其不入库 | `<cwd>/.specify/templates/overrides/.backup/` |

**不变量**

- `INV-1`：`bundledSha256` MUST 等于 `sha256(读 bundledPath 的字节)`。判定与报告中的「随包指纹」一律取自实际读到的字节，MUST NOT 取自常量表或 `package.json.version`。
- `INV-2`：`<ledgerPath>` 的 `versions` 末项 `sha256` MUST 等于 `bundledSha256`（台账与随包内容不可能漂移；由单元测试强制）。
- `INV-3`：本插件 MUST NOT 写入 `owner !== 'plugin'` 的产物（即 `.specify/extensions.yml` 的注册项、`.dsh/skills/speckit-*`）；对这些产物只映射上游 CLI 的退出码。

**校验责任**：`src/core/artifacts.mjs`（新增）导出产物清单与指纹计算；`test/sdd-kit.test.mjs` 断言 INV-2。

---

## E2. 状态判定结果（Status Verdict）

**载体**：`sdd_bridge(action:"install_overrides")` 返回的 `artifacts[].verdict` / `reason`，以及 `inspect` 的 `hasEarsOverride` 之外的增量字段（不改变既有字段语义）。

| 字段 | 类型 | 约束 | 取值 |
|------|------|------|------|
| `verdict` | enum | 五类之一，互斥 | `not_installed` \| `installed_consistent` \| `user_modified` \| `stale_upstream` \| `unknown` |
| `reason` | string \| null | `unknown` 时 MUST 非空；其余 MUST 为 `null` | 如 `"EACCES"`、`"E_SYMLINK: /abs/x"` |
| `localSha256` | string \| null | 目标存在且可读时非空 | 64 位小写 hex |
| `localVersion` | string \| null | 仅 `stale_upstream` 时非空 | 台账命中项的 `sinceVersion`，如 `"0.2.0"` |
| `bundledVersion` | string | MUST 非空 | 台账末项 `sinceVersion` |
| `action` | enum | 由判定 + 覆盖意图直接决定，MUST NOT 由调用方另算 | `write`（`not_installed`）\| `skip`（`installed_consistent`）\| `refuse`（`user_modified` 或 `unknown`，无显式覆盖）\| `refresh_available`（`stale_upstream`，无显式覆盖） |

**判定顺序（MUST 按此序短路，不可调换）**

```text
1  lstat(path) 抛 ENOENT                    → not_installed
2  读取或哈希抛错（EACCES/EPERM/EISDIR/…）   → unknown，reason = error.code
3  localSha256 === bundledSha256            → installed_consistent
4  localSha256 ∈ ledger.versions[0..n-2]    → stale_upstream，localVersion = 命中项.sinceVersion
5  其余                                      → user_modified
```

**不变量**

- `INV-4`：任何异常路径 MUST 落到 `unknown`，MUST NOT 落到 `not_installed`（REQ-05 的禁止行为）。
- `INV-5`：`verdict === 'installed_consistent'` 时实现 MUST NOT 打开目标文件做写入、MUST NOT 调用 `utimes`（AC-01 要求内容与 mtime 均不变）。
- `INV-6`：`localVersion` 与 `bundledVersion` 相等时 MUST NOT 报 `stale_upstream`（否则同一版本会自我陈旧化）。

**校验责任**：`src/core/status.mjs`（新增）`classifyArtifact()`；`src/core/bridge.mjs` 只做编排。

---

## E3. 历史版本台账（Version Ledger）

**载体**：`<PKG_ROOT>/overrides/spec-template.versions.json`（随包发布，入库）。

```jsonc
{
  "artifact": "spec-template.md",
  "versions": [
    { "sinceVersion": "0.2.0", "sha256": "803203dce4e93f53d25cc3bf77774f91769a21cfac44be055015bfd6fe5458fb" }
  ]
}
```

| 字段 | 类型 | 约束 | 取值 |
|------|------|------|------|
| `artifact` | string | MUST 等于产物文件名 | `"spec-template.md"` |
| `versions` | array | 非空；按时间**追加**顺序排列（旧→新）；元素不重复 sha256 | 见上 |
| `versions[].sinceVersion` | string | 语义化版本，MUST 单调递增（字符串序即可，因均为 `x.y.z`） | `"0.2.0"` |
| `versions[].sha256` | string | 64 位小写 hex | — |

**不变量**

- `INV-7`：`versions` 末项 `sha256` MUST 等于当前 `overrides/spec-template.md` 的指纹（= `INV-2`，同一条事实的两处表述，测试只断言一次）。
- `INV-8`：`versions` 中任一 `sha256` MUST NOT 重复；追加新项时 MUST NOT 改写已有项。
- `INV-9`：修改 `overrides/spec-template.md` 的同一提交 MUST 同时追加台账项（单一可编辑源的配套约束）。

**校验责任**：`test/sdd-kit.test.mjs` 新增「台账末项 == 随包指纹」「无重复指纹」「sinceVersion 递增」三条断言。

---

## E4. 候选目录与选择结果（Candidate Root / Selection）

**载体**：`sdd_upstream` 的 `status` 与 `sync_superpowers` 返回值中的 `selection` 字段。

| 字段 | 类型 | 约束 | 取值 |
|------|------|------|------|
| `dir` | string | 绝对路径；选中的声明路径（非 realpath） | `~/.dsh/upstream/superpowers` 等 |
| `realPath` | string \| null | 绝对路径；`fs.realpath` 结果；回落时 `null` | — |
| `reason` | enum | 五类之一 | `explicit` \| `candidateDirs` \| `env` \| `dsh_home` \| `default` |
| `mtimeNs` | bigint \| null | `fs.stat(p,{bigint:true}).mtimeNs`；不可解析时为 `null` | — |
| `fallback` | boolean | 仅当全部候选不可解析、回落默认路径时为 `true` | `false` |
| `candidates` | array | 至少 1 项（默认来源恒存在）；按 `declaredIndex` 升序；不裁剪不可解析项 | 见下 |
| `candidates[].declaredIndex` | number | 0 起，声明顺序 | 0..4 |
| `candidates[].input` | string | 声明时的原始值（未 resolve） | — |
| `candidates[].realPath` | string \| null | 不可解析时 `null` | — |
| `candidates[].mtimeNs` | bigint \| null | 同上 | — |
| `candidates[].eligible` | boolean | `realPath !== null` | — |
| `candidates[].selected` | boolean | 全列表恰有 1 项为 `true` | — |

**不变量**

- `INV-10`：`candidates` 中 `realPath` 非 `null` 的项 MUST 两两不同（realpath 去重，保留首次声明序号）。
- `INV-11`：除 `reason === 'explicit'` 外，被选中项 MUST 是所有 `eligible` 项中 `mtimeNs` 最大者；`mtimeNs` 相同或为 `null` 时 MUST 取 `declaredIndex` 最小者（确定性，REQ-07）。显式来源代表调用方意志，即使目录尚不存在（是 clone 目标）也直接胜出，不参与新鲜度排序；否则会被静默改道到别的镜像。
- `INV-12`：`candidates.filter(c => c.selected).length === 1` 恒成立。
- `INV-13`：`fallback === true` 时 `reason === 'default'` 且 `realPath === null`；`candidates` 仍列出全部声明项（含不可解析者，`eligible:false`），MUST NOT 裁剪成 1 项——排错时需要看到「本来还有哪些候选、为什么都不行」。

**校验责任**：`src/core/candidates.mjs`（新增）`selectSuperpowersDir()`；`src/core/upstream.mjs` 的 `status`/`sync_superpowers` 消费它。

---

## E5. 快照与快照清单（Snapshot / Snapshot Manifest）

**载体**：`<cwd>/.specify/templates/overrides/.backup/`（自忽略，不入库）。

```text
.backup/
├── .gitignore                 # 内容恰为 "*\n" —— 让快照目录自忽略（插件创建目录时写入）
├── ears-spec-template.bak     # 覆盖前内容的逐字节副本
└── manifest.json
```

`manifest.json`：

```jsonc
{
  "schema": 1,
  "snapshots": {
    "ears-spec-template": {
      "relativePath": ".specify/templates/overrides/spec-template.md",
      "sha256": "…",                       // 快照内容的指纹
      "sourceVersion": "0.2.0",            // 快照内容所属版本；未知时为 null
      "capturedAt": "2026-11-23T15:51:38.000Z"
    }
  }
}
```

| 字段 | 类型 | 约束 | 取值 |
|------|------|------|------|
| `schema` | number | MUST 为 `1` | `1` |
| `snapshots` | object | 键为产物 `id`；MUST 只含已存在的 `.bak` 项 | — |
| `relativePath` | string | MUST 为相对 `<cwd>` 的 POSIX 风格路径，MUST NOT 为绝对路径 | `.specify/templates/overrides/spec-template.md` |
| `sha256` | string | MUST 等于对应 `.bak` 文件的实际指纹 | 64 位小写 hex |
| `sourceVersion` | string \| null | 快照内容命中的台账版本；未命中 `null` | `"0.2.0"` |
| `capturedAt` | string | ISO 8601 UTC | `2026-11-23T15:51:38.000Z` |

**不变量**

- `INV-14`：写入快照前 MUST 比较「快照指纹」与「目标当前指纹」；仅当两者不同才刷新（REQ-10），因此 `sha256` 永远描述**最近一次覆盖前**的内容，MUST NOT 被更旧的内容覆盖。
- `INV-15`：`manifest.json` 与 `.bak` 必须一致：任一 `.bak` 的指纹 ≠ 清单 `sha256` 时，回滚 MUST 失败并报 `E_SNAPSHOT_CHECKSUM_MISMATCH`（REQ-12 的禁止行为：不得伪造成功）。
- `INV-16`：每个产物最多 1 份快照（就地刷新，不做时间戳轮转）。
- `INV-17`：快照与清单 MUST NOT 出现在 `git status` 的未跟踪列表中。实现方式**不依赖下游项目的 `.gitignore`**（实测：新 `specify init` 项目里 `.specify/.gitignore` 只忽略 `feature.json`、`extensions/*/local-config.yml`、`integrations/packages*`，**不含** `templates/overrides/`；本仓库能命中是因为本仓库自己的 `.gitignore:8`）。因此创建 `.backup/` 时 MUST 同时写入自忽略文件 `.backup/.gitignore`，内容恰为 `*\n`；测试以 `git check-ignore` 退出码 0 断言。
- `INV-18`：回滚成功后 MUST 保留快照（允许重复回滚到同一内容）。

**校验责任**：`src/core/snapshot.mjs`（新增）`captureSnapshot()` / `readManifest()` / `restoreSnapshot()`。

---

## E6. 安装报告条目（Install Report Entry）

**载体**：`sdd_bridge(action:"install_overrides")` 返回值；`sdd_upstream(action:"setup")` 的 `steps[]` 中 `install_overrides` 一步的 `detail`。

| 字段 | 类型 | 约束 | 取值 |
|------|------|------|------|
| `ok` | boolean | `artifacts.length > 0 && artifacts.every(a => a.status !== 'failed')`；空列表为 `false` | — |
| `status` | enum | 顶层兼容字段，取 `artifacts[0].status` | 六个取值之一，见下行 |
| `path` | string | 顶层兼容字段，取 `artifacts[0].path` | — |
| `artifacts[].id` | string | 见 E1 | — |
| `artifacts[].status` | enum | 六类之一，与 `verdict` + 覆盖意图一一对应 | `written`（`not_installed`，或 `user_modified` / `unknown` 且显式覆盖成功）\| `unchanged`（`installed_consistent`）\| `skipped_user_modified`（`user_modified` 且未显式覆盖）\| `skipped_stale`（`stale_upstream` 且未显式覆盖）\| `refreshed`（仅 `stale_upstream` 且显式覆盖）\| `failed` |
| `artifacts[].verdict` | enum | 见 E2 | — |
| `artifacts[].reason` | string \| null | 失败时 MUST 非空且含错误码前缀 | `"E_SYMLINK: /abs/x"` |
| `artifacts[].nextAction` | object \| null | 仅「需要用户决定」时非空；形如 `{ tool, args }` | `{ "tool": "sdd_bridge", "args": { "action": "install_overrides", "overwrite": true } }` |
| `artifacts[].snapshot` | object \| null | 本次是否产生/刷新快照 | `{ "captured": true, "refreshed": false, "path": "…" }` |

**不变量**

- `INV-19`：`status === 'unchanged'` 时 MUST NOT 产生快照、MUST NOT 触碰目标文件。
- `INV-20`：`verdict === 'user_modified'` 且未显式覆盖时，`status` MUST 为 `skipped_user_modified` 且 `nextAction` MUST 非空（REQ-03 的「给出显式覆盖方式」）。
- `INV-20a`：`verdict === 'stale_upstream'` 且未显式覆盖时，`status` MUST 为 `skipped_stale`，`nextAction` MUST 非空，且 `localVersion` 与 `bundledVersion` MUST 同时非空（REQ-04 的「同时给出两个版本」）。
- `INV-21`：单个产物失败 MUST NOT 使其他产物条目缺失（REQ-16）；`artifacts` 长度 MUST 恒等于产物清单长度。
- `INV-22`：`nextAction.args` MUST NOT 出现在 `skills/*/SKILL.md` 正文中（技能只做原样展示，不硬编码动作名——`test/sdd-kit.test.mjs:1135` 的 forbidden 名单必须保持绿）。

**校验责任**：`src/core/bridge.mjs` 的 `installOverrides` 组装；`src/core/setup.mjs` 透传到 `steps[].detail`。

---

## E7. 集成验证结果（Integration Verification Result）

**载体**：`scripts/verify-upstream.mjs` 的 stdout（JSON）+ 进程退出码；`test/upstream-contract.test.mjs` 复用同一函数。

| 字段 | 类型 | 约束 | 取值 |
|------|------|------|------|
| `status` | enum | 三选一 | `passed` \| `failed` \| `not_executed` |
| `checks` | array | `status === 'passed'` 或 `'failed'` 时 MUST 含四个契约点各 1 项；`not_executed` 时可为空数组 | 见下 |
| `checks[].id` | string | 稳定标识 | `init-args` \| `extension-add-args` \| `manifest-contract` \| `hooks-registered` |
| `checks[].ok` | boolean | — | — |
| `checks[].detail` | string | 失败时 MUST 指明具体命令/参数/字段 | `"extension list --json: provides.hooks = 3, expected 4"` |
| `checks[].stderr` | string \| null | 失败且来自子进程时附片段（截断 ≤ 2000 字符） | — |
| `reason` | string \| null | 仅 `not_executed` 时非空 | `"uv not found"` |
| `versions` | object | 实际观测到的上游版本 | `{ "specify": "1.4.4.dev0", "uv": "0.13.9" }` |

**不变量**

- `INV-23`：`status === 'not_executed'` 时进程退出码 MUST 为 `0`，且 stdout MUST 明确含「未执行」字样；MUST NOT 输出 `passed`（REQ-19）。
- `INV-24`：`status === 'failed'` 时退出码 MUST 为 `1`，且 `checks` 中至少一项 `ok === false` 且 `detail` 非空（REQ-18）。
- `INV-25`：该脚本 MUST NOT 被 `npm test` 的默认入口（`test/sdd-kit.test.mjs`）引用（REQ-18 的「不阻塞日常测试」）。

**校验责任**：`scripts/verify-upstream.mjs`；`test/upstream-contract.test.mjs` 在 `DSH_SDD_KIT_INTEGRATION=1` 时调用它。
