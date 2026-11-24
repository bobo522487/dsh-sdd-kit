# 契约：`sdd_upstream(action: "status" | "sync_superpowers")` 的候选目录选择

**对应**：REQ-06、REQ-07、REQ-08 / AC-05
**数据形状**：[data-model.md E4](../data-model.md)

本契约只描述**候选目录如何选出唯一目标**，以及该选择如何出现在 `status` / `sync_superpowers` 的返回里。它不改变两个动作的既有语义：`status` 仍是只读探针，`sync_superpowers` 仍是「有 `.git` 就 `pull --ff-only`，否则 `clone --depth 1`」。

---

## 1. 入参（新增部分）

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `action` | string | 是 | — | `"status"` 或 `"sync_superpowers"` |
| `superpowersDir` | string | 否 | — | **显式指定**（`reason:'explicit'`），最高优先级；既有参数，语义不变 |
| `candidateDirs` | string[] | 否 | `[]` | **新增**：调用方/测试注入的候选列表（`reason:'candidateDirs'`），声明序号 1 |
| `repoUrl` | string | 否 | `DEFAULT_SUPERPOWERS_REPO` | 既有参数，仅在 clone 分支使用 |

**禁止新增的入参**：

- `env` / `envVars`：环境变量来源固定为两个具名变量（见 §2），可注入会让「同一台机器上的行为」依赖调用方。
- `sortBy` / `prefer`：排序规则是协议的一部分（REQ-06/07），暴露出来等于让每个调用者定义一套语义。
- `scanRoots` / `depth`：不做文件系统扫描，候选只来自声明的五个来源（避免遍历大目录）。

## 2. 行为

```text
1. candidates ← []
2. if args.superpowersDir            → push {declaredIndex:0, reason:'explicit',      input}
3. for d of args.candidateDirs ?? [] → push {declaredIndex:1, reason:'candidateDirs', input:d}
4. if env.DSH_SDD_KIT_SUPERPOWERS_DIR→ push {declaredIndex:2, reason:'env',            input}
5. if env.DSH_HOME                   → push {declaredIndex:3, reason:'dsh_home', input: join(DSH_HOME,'upstream','superpowers')}
6. push {declaredIndex:4, reason:'default', input: join(homedir(),'.dsh','upstream','superpowers')}
7. for c of candidates:
8.     realPath ← try realpath(resolve(c.input)) catch null
9.     mtimeNs  ← realPath ? stat(realPath,{bigint:true}).mtimeNs : null
10.    c.eligible ← realPath !== null
11. 按 realPath 去重：仅对 realPath !== null 的项，保留首次出现的 declaredIndex，其余标 eligible:false 并留在列表里；realPath === null 的项不去重、全部保留（供排错阅读）
12. eligible ← 去重后 eligible 项
13. if eligible 为空:
14.     selected ← candidates 中 reason === 'default' 的那一项；fallback ← true
15. else:
16.     selected ← 若存在 reason:'explicit' 的声明则直接选中（即使其 realPath 为 null——它是 clone 目标，
             静默改道会违背调用方意图）；否则取 eligible 按 (mtimeNs 降序, declaredIndex 升序) 排序后的首项；fallback ← false
17. 给 candidates 逐项打 selected 标记：仅 selected 那一项为 true（INV-12）
18. 返回 { dir: resolve(selected.input), realPath: selected.realPath ?? null,
           reason: selected.reason, mtimeNs: selected.mtimeNs ?? null, fallback, candidates }
```

**关键约束**：

- **去重键是 realpath**（REQ-06）：同一真实目录的多个别名（符号链接、`..`、大小写差异）只算一次，保留**首次声明**的 `declaredIndex`。
- **排序键是 `mtimeNs`**（REQ-06「最近修改时间较新者优先」）：用 `fs.stat(p,{bigint:true}).mtimeNs`，不用 `mtimeMs`（探针显示 `utimes` 后 `mtimeMs` 读回不精确）；`stat` 会跟随符号链接，这是期望行为（活跃度属于真实目录）。
- **确定性决胜**（REQ-07）：`mtimeNs` 相同时按 `declaredIndex` 升序；`mtimeNs` 都为 `null` 也可能发生（`realpath` 成功后 `stat` 抛错，见 §4 第 3 行），此时同样按 `declaredIndex` 决胜。同一台机器重复运行 MUST 得到同一 `realPath`。
- **回落不是报错**（`fallback:true`）：全部候选不可解析时选 `default` 声明项，因为 `sync_superpowers` 需要一个「将被 clone 到」的目标；此时 `reason === 'default'`、`realPath:null`、`selected` 仍恰有一项为 true（INV-12/13）。`candidates` 仍列出全部声明项（便于排错），不裁剪成 1 项。
- **环境变量只读两个具名变量**：`DSH_SDD_KIT_SUPERPOWERS_DIR`、`DSH_HOME`。MUST NOT 做前缀扫描、MUST NOT 写入环境变量、MUST NOT 读取其他变量。这是 `src/` 首次使用 `process.env`，须在代码注释里说明原因（跨进程/跨 profile 的唯一合法传递方式）。
- **报告依据**（REQ-08）：`reason` 必须如实反映「为什么选它」——`explicit`（用户指定）/ `candidateDirs` / `env` / `dsh_home` / `default`（唯一候选或回落）。
- **`dir` 与 `realPath` 都要返回**：`dir` 用于 clone 目标（用户看到的路径），`realPath` 用于去重与日志（消除歧义）。

## 3. 返回（成功，`status`）

```jsonc
{
  "action": "status",
  "cwd": "/abs/project",
  "specifyCli": { "installed": true, "version": "specify 1.4.4.dev0" },
  "uv": { "installed": true, "version": "uv 0.13.9" },
  "git": { "installed": true, "version": "git version 2.43.0" },
  "superpowers": {
    "dir": "/srv/mirrors/superpowers",
    "installed": true,
    "head": "a1b2c3d",
    "skillCount": 24,
    "selection": {
      "realPath": "/srv/mirrors/superpowers",
      "reason": "env",
      "mtimeNs": "1795448167413944525",
      "fallback": false,
      "candidates": [
        { "declaredIndex": 2, "input": "/srv/mirrors/superpowers", "realPath": "/srv/mirrors/superpowers", "mtimeNs": "1795448167413944525", "eligible": true, "selected": true },
        { "declaredIndex": 3, "input": "/home/u/.dsh/upstream/superpowers", "realPath": "/home/u/.dsh/upstream/superpowers", "mtimeNs": "1795440000000000000", "eligible": true, "selected": false },
        { "declaredIndex": 4, "input": "/home/u/.dsh/upstream/superpowers", "realPath": null, "mtimeNs": null, "eligible": false, "selected": false }
      ]
    }
  }
}
```

> 注：`declaredIndex:3`（`DSH_HOME`）与 `:4`（默认路径）解析到同一真实路径时，去重只保留首次出现的 `3`，`4` 标 `eligible:false` 并保留在列表里供排错阅读（它不参与决胜）。`mtimeNs` 为 bigint，JSON 序列化时转为字符串以避免精度丢失。`selected` 恰有一项为 `true`（INV-12）。

## 4. 返回（失败）

| 场景 | 表现 |
|---|---|
| `superpowersDir` 指向不可解析路径且无其他候选 | 不报错：回落 `default`，`fallback:true`，`installed:false`（`status`）/ `mode:'clone'`（`sync`） |
| `realpath` 抛 `EACCES`（父目录不可执行） | 该候选 `eligible:false`，其余候选照常参与 |
| `stat` 抛错（文件在 `realpath` 后被删除） | 该候选 `mtimeNs:null`，按 `declaredIndex` 参与决胜 |
| `git` 缺失且需要 clone | 既有行为不变：`{ok:false, error:{code:'E_GIT', …}}` |

本契约**不新增失败模式**：候选选择永不抛异常，只在返回里标注 `eligible` / `fallback`。

## 5. 调用位置与报告要求

- **调用者**：`src/core/upstream.mjs` 的 `status` 与 `sync_superpowers` 分支；`src/core/setup.mjs` 的 `sync_superpowers` 步骤把 `selection` 放进 `detail`。
- `/sdd-setup` 技能第 4 步新增一句：当 `detail.selection.reason !== 'explicit'` 时报告所选绝对路径与依据（不新增动作名）。
- 报告 MUST 出现：所选目录绝对路径、`reason`、以及 `fallback:true` 时的「未找到任何已有镜像，将克隆到默认路径」提示。

## 6. 测试契约

| 断言 | 方法 |
|---|---|
| 两个候选经符号链接指向同一真实路径 + 第三个更新 ⇒ 选中第三个 | `mkdtemp` 建 3 个目录，`fs.symlink` 造别名，`fs.utimes` 设置新旧 mtime（AC-05） |
| 去重后 `candidates` 中同一 realPath 只出现一次，保留最小 `declaredIndex` | 断言 `new Set(realPaths).size === realPaths.length` |
| `mtimeNs` 相同时按 `declaredIndex` 升序决胜 | 两个目录设同一 `utimes`（同 inode 差异可忽略），断言选 `declaredIndex` 小者 |
| 重复运行结果一致 | 连续调用 3 次，断言 `realPath` 相同（REQ-07） |
| 全部不可解析 ⇒ `fallback:true` + `reason:'default'` + `realPath:null` | 只传不存在的 `superpowersDir`，断言 `fallback === true`、`realPath === null`、`selected` 恰一项为 true（`candidates` 仍列出声明项） |
| `DSH_SDD_KIT_SUPERPOWERS_DIR` 生效且优先级高于 `DSH_HOME` | 设置两个环境变量后断言 `reason === 'env'`；`finally` 恢复原值 |
| `explicit` 最高优先级 | 同时传 `superpowersDir` 与环境变量，断言 `reason === 'explicit'` |
| 不扫描文件系统 | 断言实现源码不含 `readdir` 于 `candidates.mjs`（结构性断言，防回归） |
| 测试不触碰真实 `~/.dsh` | 默认路径来源用 `os.homedir()`；POSIX 上 `os.homedir()` 跟随 `HOME`（实测：`HOME=/tmp/fakehome` ⇒ 返回 `/tmp/fakehome`），故测试可设 `HOME` 指向临时目录并在 `finally` 恢复。Windows 上 `os.homedir()` 取 `USERPROFILE` 而非 `HOME`，该用例在 `process.platform === 'win32'` 时 `t.skip`（理由：无法用 `HOME` 隔离默认路径） |
