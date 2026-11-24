# 契约：`sdd_bridge(action: "restore_overrides")`

**对应**：REQ-11、REQ-12、REQ-14、REQ-15 / AC-07
**数据形状**：[data-model.md E5/E6](../data-model.md)

本契约是**一键回滚**的唯一入口：用最近一次有效快照还原受管产物。它是一个独立动作而非 `install_overrides` 的参数，理由见 §2 末尾「为什么不复用 install_overrides」。

---

## 1. 入参

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `action` | string | 是 | — | 固定 `"restore_overrides"` |
| `cwd` | string | 否 | `process.cwd()` | 项目根；从 `<cwd>/.specify/templates/overrides/.backup/` 读取快照 |
| `artifact` | string | 否 | 全部 | 只还原指定产物 `id`；未知 id ⇒ `E_ARGS` |

**禁止新增的入参**：

- `content` / `sha256`：回滚内容只能来自快照，调用方指定内容即等于任意写文件。
- `version` / `snapshotId`：每产物只保留 1 份快照（data-model INV-16），没有「选哪一份」的语义。
- `overwrite`：回滚本身就是覆盖意图；再叠加 `overwrite` 会产生「回滚也要二次确认」的歧义。
- `dryRun`：spec 未要求，且会让「未成功状态」与「预演成功」难以区分（REQ-12 禁止伪造还原结果）。

## 2. 行为

```text
1. cwd ← resolve(args.cwd || process.cwd())
2. if args.artifact 给定且不在随包产物清单里 → return { ok:false, error:{code:'E_ARGS', …} }
3. manifest ← 读 <cwd>/.specify/templates/overrides/.backup/manifest.json（读失败/不存在 ⇒ null）
   （`.backup/.gitignore` 不是快照条目，读清单时 MUST 忽略它）
4. entries ← (manifest?.snapshots ?? []) 按产物清单顺序过滤；args.artifact 给定时只保留该 id
5. if entries 为空:
6.     return { ok:false, status:'no_snapshot', restored:[], reason:'E_NO_SNAPSHOT' }   # REQ-12
7. for each entry in entries:
8.     bak ← <snapshotDir>/<id>.bak
9.     if bak 不存在 → restored.push({id, status:'failed', reason:'E_SNAPSHOT_MISSING'}); continue
10.    if sha256(bak) !== entry.sha256:
11.        restored.push({id, status:'failed', reason:'E_SNAPSHOT_CHECKSUM_MISMATCH'}); continue  # INV-15
12.    target ← resolve(cwd, entry.relativePath)
13.    guard ← assertInside(cwd, target) then assertNoSymlinkComponent(cwd, target)
14.    if guard fails → restored.push({id, status:'failed', reason:'E_ESCAPE…'|'E_SYMLINK…'}); continue
15.    atomicWriteFile(target, 读 bak 的字节)
16.    restored.push({id, status:'restored', sourceVersion: entry.sourceVersion, path: target})
17. ok ← restored.length > 0 && restored.every(r => r.status === 'restored')   # 空数组不算成功
18. status ← ok ? 'restored' : 'partial'
19. return { action:'restore_overrides', ok, status, restored, snapshotDir }
```

**关键约束**：

- **无快照即未成功**（REQ-12）：`ok:false` + `status:'no_snapshot'`，`restored:[]`；MUST NOT 返回 `ok:true` 或空 `restored` 配 `ok:true`。
- **空集不等于成功**：`restored` 为空时 `ok` MUST 为 `false`（第 17 行的 `restored.length > 0` 守卫）——`Array.prototype.every` 对空数组返回 `true`，直接用会把「什么都没还原」报成成功，正是 REQ-12 禁止的伪造。
- **校验后才还原**（INV-15）：`.bak` 指纹与清单不符 ⇒ 该产物 `failed`，MUST NOT 写入。
- **范围严格受限**（REQ-11）：只写 `manifest.snapshots` 列出的 `relativePath`；MUST NOT 触碰清单外的任何文件，MUST NOT 删除快照目录之外的东西。
- **保留快照**（INV-18）：还原成功后不删除 `.bak` 与清单条目，允许重复回滚到同一内容。
- **原子性**（REQ-14）：还原走同一个 `atomicWriteFile`，异常时目标保持还原前内容。
- **防护顺序**（REQ-15）：`E_ESCAPE` → `E_SYMLINK` → 任何 `open`；清单里的 `relativePath` 是数据而非可信输入，必须重新校验（清单可能被用户编辑）。
- **不做上游动作**：本动作不调用 `specify`、不重新安装扩展、不重启 DSH（spec §3 明确排除）。

**为什么不复用 `install_overrides`**：

- 语义相反：一个是「把随包内容推进去」，一个是「把快照内容退回来」；用 `restore:true` 参数会让同一动作有两种互斥的内容来源，`overwrite` 与 `restore` 同时为真时行为无法自洽。
- 报告形状不同：回滚报告的是 `restored[]`（含 `sourceVersion`），不是 `artifacts[].verdict`。
- 技能层需要能**独立描述**「回滚」这一步；独立动作让 `/sdd-update` 或用户口令可以只调一次，不必理解 `overwrite` 的语义。
- 代价可接受：`sdd_bridge` 的动作从 3 个变 4 个，工具数量不变（章程原则 I 约束的是**工具与技能**的数量，不是动作数量）。

## 3. 返回（成功）

```jsonc
{
  "action": "restore_overrides",
  "ok": true,
  "status": "restored",
  "snapshotDir": "/abs/project/.specify/templates/overrides/.backup",
  "restored": [
    {
      "id": "ears-spec-template",
      "status": "restored",
      "path": "/abs/project/.specify/templates/overrides/spec-template.md",
      "sourceVersion": "0.2.0",
      "snapshotCapturedAt": "2026-11-23T15:51:38.000Z"
    }
  ]
}
```

## 4. 返回（失败）

| 场景 | `ok` | `status` | `restored[]` |
|---|---|---|---|
| 干净项目（无 `.backup/`） | `false` | `no_snapshot` | `[]` |
| 清单存在但 `.bak` 丢失 | `false` | `partial` | `[{id, status:'failed', reason:'E_SNAPSHOT_MISSING'}]` |
| `.bak` 被篡改 | `false` | `partial` | `[{id, status:'failed', reason:'E_SNAPSHOT_CHECKSUM_MISMATCH'}]` |
| 目标现在是符号链接 | `false` | `partial` | `[{id, status:'failed', reason:'E_SYMLINK: /abs/link'}]` |
| 清单 `relativePath` 逃出项目根 | `false` | `partial` | `[{id, status:'failed', reason:'E_ESCAPE: /abs/outside'}]` |
| `artifact` 指定了未知 id | `false` | — | `error.code === 'E_ARGS'` |

`status` 取值：`restored`（全部成功）/ `partial`（部分失败）/ `no_snapshot`（无任何可用快照）。`partial` 时 MUST 逐项给出 `reason`，MUST NOT 只报整体失败。

## 5. 调用位置与报告要求

- **入口**：`sdd_bridge(action:"restore_overrides")`。`/sdd-setup` 与 `/sdd-update` 的正文 MUST NOT 硬编码本动作名（保持 `test/sdd-kit.test.mjs:1135`、`:480` 的 forbidden 名单为绿）；用户通过工具调用或未来的技能步骤触发。
- 报告 MUST 列出：还原了哪些文件（绝对路径）、每个文件的 `sourceVersion`、以及未还原项的原因。
- `runBridge` 的未知动作错误消息 MUST 更新为 `Expected one of: inspect, install_overrides, restore_overrides, sync_index.`（既有断言只匹配 `/Unknown sdd_bridge action/`，不受影响）。

## 6. 测试契约

| 断言 | 方法 |
|---|---|
| 安装 → 手工改 → 显式覆盖（产生快照）→ 回滚 ⇒ 内容逐字节等于快照 | 临时项目全流程；比对 `sha256`（AC-07） |
| 回滚报告含 `sourceVersion` 与绝对路径 | 断言 `restored[0].sourceVersion === '0.2.0'` |
| 干净项目回滚 ⇒ `ok:false` + `status:'no_snapshot'` | 空临时项目（AC-07 后半） |
| `.bak` 被篡改 ⇒ `E_SNAPSHOT_CHECKSUM_MISMATCH` 且目标未变 | 手工改写 `.bak` 后回滚 |
| 目标被替换为符号链接 ⇒ `E_SYMLINK` 且链接目标未变 | `fs.symlink` + 读目标；`t.skip` 条件：`process.platform === 'win32'` |
| 回滚后快照仍在，可重复回滚 | 连续回滚两次，第二次仍 `ok:true` |
| 回滚不触碰清单外文件 | 在项目内放一个哨兵文件，断言其 mtime 与内容不变 |
| 未知动作消息含 `restore_overrides` | `runBridge({action:'nope'})` 断言 message 包含四个动作名 |
| 清单存在但 `snapshots` 为空 ⇒ `ok:false` + `no_snapshot`（空数组不算成功） | 写 `{"schema":1,"snapshots":{}}` 后回滚，断言 `ok === false` 且 `status === 'no_snapshot'` |
| `artifact` 指定未知 id ⇒ `E_ARGS`，且未写任何文件 | `runBridge({action:'restore_overrides', artifact:'nope'})` |
| `artifact` 指定已知 id ⇒ 只还原该项 | 构造 2 项清单（`deps.artifacts`），断言另一项目标未变 |
