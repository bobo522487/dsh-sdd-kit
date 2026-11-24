# 契约：`sdd_bridge(action: "install_overrides")`

**对应**：REQ-01、REQ-02、REQ-03、REQ-04、REQ-05、REQ-09、REQ-10、REQ-13、REQ-14、REQ-15、REQ-16 / AC-01、AC-02、AC-03、AC-04、AC-06、AC-08、AC-09
**数据形状**：[data-model.md E1/E2/E5/E6](../data-model.md)

本契约是模板覆盖文件的**唯一写入口**。职责是：判定状态 → （必要时）留快照 → 原子写入 → 结构化报告。它不解析 YAML、不改 `.specify/extensions.yml`、不生成技能产物（那三类由上游 `specify` CLI 负责，见 research R1「范围收敛」）。

---

## 1. 入参

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `action` | string | 是 | — | 固定 `"install_overrides"` |
| `cwd` | string | 否 | `process.cwd()` | 项目根；产物落在 `<cwd>/.specify/templates/overrides/` |
| `overwrite` | boolean | 否 | `false` | 显式覆盖意图。`true` 时允许改写 `user_modified` / `stale_upstream` / `unknown`（`unknown` 仍受 symlink 与越界拒绝约束） |

**禁止新增的入参**：

- `artifact` / `artifacts`：产物清单由插件随包决定（`src/core/artifacts.mjs`），调用方不得指定，否则用户可让插件写任意路径。
- `content` / `template`：内容事实来源唯一为 `<PKG_ROOT>/overrides/spec-template.md`（章程原则 I「单一可编辑源」）。
- `backupDir` / `snapshotDir`：快照位置是协议的一部分（data-model E5），可配置会让「自忽略」保证失效（`.backup/.gitignore` 只在固定位置被创建）。
- `force`：语义与 `overwrite` 重叠，双参数会产生「哪个优先」的歧义。

> **测试注入通道**：多产物失败隔离（REQ-16 / AC-09）与「无网络」类用例需要替换产物清单，注入点**不是工具入参**，而是 JS 层的第二参数 `runBridge(args, deps)`（沿用 `src/core/setup.mjs` 的 `runSetup(args, deps)` 既有惯例）：`deps.artifacts` 可传入 2 项清单，`deps.clock` 可固定 `capturedAt`。工具层（`sdd_bridge`）永远只暴露上表三个入参。

## 2. 行为

```text
1. cwd ← resolve(args.cwd || process.cwd())
2. artifacts ← 随包产物清单（当前 1 项：ears-spec-template）
3. for each a in artifacts:            # 单产物失败不阻断其余（REQ-16）
4.   verdict ← classifyArtifact(a)     # E2 的判定顺序，短路
5.   if verdict == not_installed:
6.       guard ← assertInside(cwd, a.path) then assertNoSymlinkComponent(cwd, a.path)
7.       if guard fails → status ← 'failed'; reason ← 'E_ESCAPE: …' | 'E_SYMLINK: …'
8.       else atomicWriteFile(a.path, bundledBytes); status ← 'written'   # 无需快照
9.   else if verdict == installed_consistent:
10.      status ← 'unchanged'; nextAction ← null     # 不打开、不 utimes（INV-5）
11.  else if verdict == user_modified and not overwrite:
12.      status ← 'skipped_user_modified'
13.      nextAction ← { tool:'sdd_bridge', args:{ action:'install_overrides', overwrite:true } }
14.  else if verdict == stale_upstream and not overwrite:
15.      status ← 'skipped_stale'; nextAction ← 同上
16.  else if verdict == unknown and not overwrite:
17.      status ← 'failed'; reason ← <error.code>
18.  else:                              # 显式覆盖路径
19.      guard ← assertInside(cwd, a.path) then assertNoSymlinkComponent(cwd, a.path)
20.      if guard fails → status ← 'failed'; reason ← 'E_ESCAPE: …' | 'E_SYMLINK: …'
21.      else captureSnapshot(a) then atomicWriteFile(a.path, bundledBytes)
22.           status ← (verdict == stale_upstream ? 'refreshed' : 'written')
23. return { action:'install_overrides', ok, status, path, artifacts:[…] }
```

**关键约束**：

- **判定先于任何写入**（REQ-01）：`classifyArtifact` 必须在第 4 步完成，MUST NOT 先写后判。
- **`installed_consistent` 零副作用**（REQ-02 / INV-5）：不 `open` 目标、不 `utimes`、不留快照、不刷新清单。
- **`user_modified` 默认不改写**（REQ-03 / INV-20）：`nextAction` 必须非空，且是**机器可读对象**而非命令行字符串——技能正文因此不必硬编码动作名。
- **`stale_upstream` 默认不改写**（REQ-04）：报告必须同时含 `localVersion` 与 `bundledVersion`；只有 `overwrite:true` 才刷新，且此时 `status === 'refreshed'`（与首次安装的 `written` 可区分）。
- **`unknown` 不降级**（REQ-05 / INV-4）：异常只能落 `unknown`；`unknown` 且未显式覆盖时 `status` 为 `failed` 并附 `error.code`，MUST NOT 当作 `not_installed` 写入。
- **快照先于覆盖**（REQ-09）：只在「目标已存在且将被改写」时留快照；刷新语义见 [restore 契约](./sdd-bridge-restore-overrides.md) 的 INV-14。
- **快照目录自忽略**（INV-17）：创建 `.backup/` 时 MUST 同时写入 `.backup/.gitignore`（内容恰为 `*`）。MUST NOT 依赖宿主项目的 `.gitignore`——实测下游 `specify init` 项目并不忽略 `templates/overrides/`，也 MUST NOT 改写宿主的 `.gitignore`。
- **原子写入**（REQ-13/14）：同目录临时文件 `.<basename>.<pid>.<random>.tmp` → `writeFile` → `sync` → `close` → `rename`；`finally` 清理残留；异常上抛但目标保持原内容。
- **拒绝顺序**（REQ-15）：`E_ESCAPE`（realpath 越界）先于 `E_SYMLINK`（路径分量是链接），二者都先于任何 `open`。目标自身是符号链接同样拒绝——`rename` 会替换链接本身（实测），不检查就是静默破坏。
- **守卫覆盖两条写入分支**（REQ-15）：首次安装（第 5–8 行）与显式覆盖（第 18–22 行）MUST 走同一组守卫；`not_installed` 不等于安全——父目录 `.specify/templates/overrides/` 本身可能是符号链接，首次写入会顺着它落到项目外。
- **向后兼容**：顶层 `status` / `path` 保留，取 `artifacts[0]`；`artifacts[]` 为增量字段。
- **不新增动作**：本契约只扩展 `install_overrides` 的返回与行为，不新增 `install_extension_registry` / `install_skills`（那两个写权在 CLI，拆出来即并行逻辑）。

## 3. 返回（成功）

```jsonc
{
  "action": "install_overrides",
  "ok": true,
  "status": "written",
  "path": "/abs/project/.specify/templates/overrides/spec-template.md",
  "artifacts": [
    {
      "id": "ears-spec-template",
      "path": "/abs/project/.specify/templates/overrides/spec-template.md",
      "status": "written",
      "verdict": "not_installed",
      "reason": null,
      "localSha256": null,
      "localVersion": null,
      "bundledVersion": "0.2.0",
      "nextAction": null,
      "snapshot": { "captured": false, "refreshed": false, "path": null }
    }
  ]
}
```

字段语义见 data-model E6。`ok === true` 表示**没有任何产物 failed**（`artifacts.every(a => a.status !== 'failed')`，且 `artifacts` 非空——空列表不算成功）；`skipped_user_modified` / `skipped_stale` 属于「按预期跳过」，不是失败（AC-02 / AC-03 要求默认不改写，因此整体仍为 `ok:true`）。任一产物 `failed` 时 `ok` MUST 为 `false`（AC-09「整体状态为未成功」），但其余产物的 `status` 仍如实列出（REQ-16）。

## 4. 返回（失败）

| 场景 | `ok` | `artifacts[0].status` | `verdict` | `reason` |
|---|---|---|---|---|
| 目标不可读（`chmod 000`） | `false` | `failed` | `unknown` | `EACCES` |
| 目标是符号链接（含显式覆盖） | `false` | `failed` | 原判定 | `E_SYMLINK: /abs/link` |
| realpath 逃出项目根 | `false` | `failed` | 原判定 | `E_ESCAPE: /abs/outside` |
| 临时文件创建失败（磁盘满/权限） | `false` | `failed` | 原判定 | `EEXIST` / `ENOSPC` / `EACCES` |
| 快照写入失败 | `false` | `failed` | 原判定 | 快照错误码；目标未被改写 |
| 随包文件缺失（打包错误） | `false` | `failed` | — | `E_BUNDLED_MISSING` |

失败时 MUST NOT 抛异常（与既有 `runBridge` 的 `E_ARGS` 风格一致），且 MUST NOT 留下临时文件或半写目标。

## 5. 调用位置与报告要求

- **唯一调用者**：`src/core/setup.mjs` 的 `install_overrides` 步骤（`setup.mjs:72-73`）。`/sdd-setup` 技能 MUST NOT 直接调用（`test/sdd-kit.test.mjs:1135` 的 forbidden 名单包含 `install_overrides`）。
- `setup` 步骤的 `detail` 改为 `{ status, verdict, reason, nextAction, artifacts }`；`steps[].status` 的映射为：`written`/`refreshed` → `performed`，`unchanged` → `skipped`，`skipped_user_modified`/`skipped_stale` → `skipped`，`failed` → `failed`。
- `/sdd-setup` 技能第 3/4 步新增两句（不新增动作名、不新增分支）：`detail.nextAction` 非空时**原样展示**并等用户确认；`detail.status` 为 `skipped_user_modified` 时说明「已保留你的自定义内容」。

## 6. 测试契约

| 断言 | 方法 |
|---|---|
| 首次安装 `status === 'written'`、`verdict === 'not_installed'` | 临时项目 + `runBridge({action:'install_overrides', cwd})` |
| 第二次 `status === 'unchanged'`、`verdict === 'installed_consistent'` | 同上再跑一次；并断言 `mtimeMs` 与内容均未变（AC-01） |
| 手工改内容后 `skipped_user_modified` 且 `nextAction` 非空、文件未变 | 写入自定义内容后运行（AC-02） |
| 换成台账历史内容后 `skipped_stale`，含 `localVersion`+`bundledVersion` | 从 `overrides/spec-template.versions.json` 取历史指纹的对应内容（AC-03） |
| `chmod 000` 后 `verdict === 'unknown'` 且未写入 | `t.skip` 条件：`process.platform === 'win32'`（POSIX 权限位不适用）或 `process.getuid?.() === 0`（root 无视权限位） |
| 目标为指向项目外的符号链接时 `E_SYMLINK`，链接目标未被修改 | `fs.symlink` + 读目标内容比对；`t.skip` 条件：`process.platform === 'win32'`（需管理员权限创建符号链接） |
| **首次安装**时父目录是符号链接同样 `E_SYMLINK`（不因 `not_installed` 放行） | 把 `.specify/templates/overrides` 换成为指向项目外的链接后首次安装，断言 `failed` + `E_SYMLINK` 且外部无新文件（REQ-15） |
| `..` 逃逸路径 `E_ESCAPE` | 直接调用 `assertInside` / 传入构造的 `cwd` |
| 注入写入异常后目标保持原内容、无残留 `.tmp` | `mock.method(fs, 'rename', () => { throw ... })` 或只读目录（AC-08） |
| 单产物失败不阻断其余 | `runBridge(args, { artifacts: [...2 项...] })` 注入清单、令第 1 项失败（AC-09） |
| 台账末项指纹 == 随包指纹 | 读 `overrides/spec-template.versions.json` 与 `sha256(overrides/spec-template.md)` 比对（INV-2） |
| 快照目录不出现在 `git status`（**下游项目**，无本仓库 `.gitignore` 帮助） | 在临时项目 `git init` 后安装，断言 `git status --porcelain` 不含 `.backup`，且 `git check-ignore .specify/templates/overrides/.backup/x.bak` 退出码 0（命中 `.backup/.gitignore`） |
| `.backup/.gitignore` 内容恰为 `*` | 读文件比对，防止有人误改成需要白名单的形式 |
