# Phase 0 Research：安装与覆盖层的安全性加固

**Date**: 2026-11-23 | **Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)

本文件记录实现所需的事实与决策。所有「实测」结论都在本机（Node v26.13.1、Linux x86_64、`specify 1.4.4.dev0`、`uv 0.13.9`）用一次性探针脚本与一次性临时项目验证过，不是文档推测；探针目录 `.probe003/`、`.probe003b/` 用完即删，不入库。

---

## R1. 状态判定：四分类如何落到唯一可写的产物上

**问题**：`installOverrides` 现在只判断「文件是否存在」（`src/core/bridge.mjs:145`），存在即 `skipped_existing`。要做到 REQ-01 的四分类 + `unknown` 兜底（共五个判定取值），判据是什么？

**实测**：

| 探针 | 结果 |
|------|------|
| `sha256(overrides/spec-template.md)` | `803203dce4e93f53d25cc3bf77774f91769a21cfac44be055015bfd6fe5458fb`，与项目内 `.specify/templates/overrides/spec-template.md` **逐字节一致** |
| `git log -S"spec-template" -- overrides/` | 该文件自 `6373527`（v0.2.0）起内容从未变过 → 现网所有「旧版」内容都等于当前内容 |
| `chmod 000` 后 `fs.readFile`（uid 1000，非 root） | 抛 `EACCES`（`code === 'EACCES'`）→ 可真实构造「存在但不可读」的 `unknown` 夹具 |
| `sha256` 单次（4 KB） | 0.0285 ms/op（200 次均值）→ 比对成本可忽略 |

**决策**：判据是**内容指纹**，不是版本号、不是 mtime、不是存在性：

```text
1. lstat(target) → 不存在 ⇒ not_installed
2. 读失败（EACCES/EPERM/EISDIR/其他）⇒ unknown（附 error.code）
3. hash(target) === hash(随包文件) ⇒ installed_consistent
4. hash(target) ∈ 版本台账的历史指纹（非当前项）⇒ stale_upstream（附 localVersion）
5. 其余 ⇒ user_modified
```

判定优先级固定为「存在性 → 可读性 → 当前指纹 → 历史指纹 → 其余」，任何一步抛异常都只能落到 `unknown`，**MUST NOT** 降级为 `not_installed`（REQ-05 的原文要求）。

**替代方案被否**：

- 用文件 `mtime` 或大小判定：用户用 `touch` 或编辑器重写都会误判，且 AC-01 要求「修改时间未变化」，用 mtime 做判据会自我矛盾。
- 用 `specify` CLI 判定模板覆盖文件：CLI 不认识 `overrides/` 目录（它是我们自己的约定），`specify extension list` 也不覆盖它。
- 存 `.installed` 标记文件：多一个可被用户删除/复制的状态源，违反「同一事实只有一处可编辑源」。

**范围收敛（重要）**：REQ-01 列举了三类受管产物，但**只有一类由本插件写入**——`.specify/templates/overrides/spec-template.md`。`.specify/extensions.yml` 的注册项与 `.dsh/skills/speckit-*` 技能产物全部由上游 `specify` CLI 写入（`extension add`）。按章程原则 I「MUST NOT 形成并行逻辑」，本插件对后两类**只映射 CLI 自己的结论**（`extension add` 的退出码 + stdout），不自行判定、不自行写入、不留快照。四分类判定的完整实现只作用于模板覆盖文件。

---

## R2. 「已知历史版本」如何随包携带

**问题**：`stale_upstream` 要求区分「用户改的」与「上游改的」，但插件安装后只有当前版本的随包文件，历史内容不在磁盘上。

**实测**：`overrides/` 目前只有 `spec-template.md` 一个文件；`package.json` 的 `files` 已含 `"overrides/"`（整目录打包）→ 在 `overrides/` 内新增文件**无需**改 `files`，也不会触碰 `test/sdd-kit.test.mjs:530-570` 的打包一致性断言。

**决策**：新增随包台账 `overrides/spec-template.versions.json`，形态为**按时间追加的指纹序列**：

```jsonc
{
  "artifact": "spec-template.md",
  "versions": [
    { "sinceVersion": "0.2.0", "sha256": "803203dce4e93f53d25cc3bf77774f91769a21cfac44be055015bfd6fe5458fb" }
  ]
}
```

- 最后一项的 `sha256` **必须**等于 `overrides/spec-template.md` 的实际指纹（不变量，由测试强制，见 data-model INV-2）→ 台账不可能与随包内容漂移。
- 当前内容变更时，**同时**改 `spec-template.md` 与在台账末尾追加一项（一次提交，同一原子单元）。
- `stale_upstream` 的 `localVersion` 取命中项的 `sinceVersion`；「当前随包版本」取台账末项的 `sinceVersion`（而非 `package.json.version`，因为模板可能多个插件版本不变——现网就是如此）。

**替代方案被否**：

- 内联在 `bridge.mjs` 里的常量数组：与「模板内容」这一事实分离在代码与数据两处，改模板时容易忘记改常量；放 `overrides/` 内与模板同目录，改动必然被同一个 diff 审阅到。
- 联网查 git 历史：违反「不要求联网查询历史版本」（spec §5）与离线可用性。
- 只存 `package.json.version` 单值：无法表达「模板跨多个插件版本不变」，会把现网所有正确安装误判为 `stale_upstream`。

---

## R3. 候选目录选择：去重键与排序键

**问题**：`getDefaultSuperpowersDir()`（`src/core/upstream.mjs:54`）恒返回 `~/.dsh/upstream/superpowers`，硬编码单一位置。REQ-06 要求「真实路径去重 + 最近活跃优先 + 声明顺序决胜」。

**实测**：

| 探针 | 结果 |
|------|------|
| `fs.realpath(a)` vs `fs.realpath(a-link)`（link → a） | 相等 → 可作去重键 |
| `fs.realpath(不存在路径)` | 抛 `ENOENT`（`code === 'ENOENT'`）→ 未落盘的候选必须容错跳过 |
| `fs.utimes` 后读回 `stat.mtimeMs` | 不精确（设 1000/2000 读回均为 2000）；`fs.stat(p,{bigint:true}).mtimeNs` 可用且稳定 → 排序用 `mtimeNs` |
| `git commit` 后 `.git/HEAD` 的 mtime | **不变**（两次提交后仍为 `1795448502`）→ 不能用 `.git/HEAD` 当「最近活跃」判据 |
| 4 个候选（含 1 个 symlink 别名）解析 + 去重 + stat | 1.409 ms（单次）→ 远低于 2 s 预算 |
| 本机 `~/.dsh` 布局 | `profiles/web`（唯一）、`upstream/superpowers`、`integrations` → 无历史残留，去重逻辑需靠夹具验证 |

**决策**：候选按**声明顺序**构造，逐个 `realpath`（失败者标 `eligible:false`、`realPath:null`，**仍留在列表里供排错**，但不参与决胜），以 realpath 为键对可解析项去重（保留**首次**出现者的声明序号），再用 `mtimeNs` 降序排序，**相同 `mtimeNs` 时按声明序号升序决胜**（REQ-07）：

```text
声明顺序（reason）：
  0 explicit      ← args.superpowersDir（用户显式指定）
  1 candidateDirs ← args.candidateDirs（调用方/测试注入的候选列表）
  2 env           ← DSH_SDD_KIT_SUPERPOWERS_DIR
  3 dsh_home      ← $DSH_HOME/upstream/superpowers（DSH_HOME 存在时）
  4 default       ← ~/.dsh/upstream/superpowers
```

- 全部候选都不可解析（都不存在）时，回落 `~/.dsh/upstream/superpowers` 并把 `reason` 记为 `default`、`fallback: true`、`realPath: null`——因为 `sync_superpowers` 需要一个「将被克隆到」的目标，此时不能报错退出。`candidates` 仍列出全部声明项，不裁剪。
- 选中结果附带 `{ dir, realPath, reason, mtimeNs, candidates: [{declaredIndex, input, realPath, mtimeNs, eligible, selected}] }`（REQ-08 的报告要求）。
- 读取环境变量是本仓库 `src/` 的**首次** `process.env` 使用。约束：只读 `DSH_SDD_KIT_SUPERPOWERS_DIR` 与 `DSH_HOME` 两个具名变量，不做前缀扫描，不写环境变量；测试必须显式设置并在 `finally` 中恢复原值。

**替代方案被否**：

- 只按硬编码顺序取第一个存在者：正是本特性要消除的行为；多 profile / 历史残留场景会选到旧镜像。
- 按目录内文件数或 `.git` 存在性排序：不反映「最近活跃」，且刚 clone 的空镜像会赢过有内容的镜像。
- 用 `fs.statSync` 跟随 symlink 的 mtime 排序而不先去重：同一真实目录的两个别名会互相竞争，结果依赖声明顺序而非活跃度。

---

## R4. 快照位置、刷新语义与保留份数

**问题**：REQ-09/10 要求覆盖前留快照、过期自动刷新；REQ-11/12 要求一键回滚与「无快照时明确失败」。快照放哪、留几份？

**实测**：

| 探针 | 结果 |
|------|------|
| `git check-ignore -v .specify/templates/overrides/.backup/x.bak`（**本仓库**） | 命中 `.gitignore:8:.specify/templates/overrides/` —— 但这是**本仓库自己的规则**，不可外推 |
| 新 `specify init --here` 项目的 `.specify/.gitignore` | 只含 `feature.json`、`extensions/*/local-config.yml`、`integrations/packages/`、`integrations/packages.json` —— **不含** `templates/overrides/` |
| 下游项目里直接建 `.backup/` 后 `git status --porcelain` | 出现 `?? .specify/templates/overrides/.backup/` ⇒ **快照会进版本库** |
| 在 `.backup/` 内写 `.gitignore`（内容 `*`）后 `git status --porcelain` | 干净；`git check-ignore -v …/manifest.json` 命中 `.backup/.gitignore:2:*`，退出码 0 |
| `fs.copyFile(a, b, COPYFILE_EXCL)` 目标已存在 | 抛 `EEXIST` → 可用于「不覆盖已有快照」的守卫 |
| `fs.open(p, 'wx')` 目标已存在 | 抛 `EEXIST` → 临时文件互斥创建 |

**决策**：

- 快照目录：`<project>/.specify/templates/overrides/.backup/`（与被保护文件同层，且在项目根内）。
- **自忽略**：创建 `.backup/` 时同时写入 `.backup/.gitignore`，内容恰为 `*\n`。理由：下游项目的 `.specify/.gitignore` 由上游 CLI 管理且**不**覆盖 `templates/overrides/`（实测），所以「安装产物不入库」这条章程约束不能依赖宿主项目的忽略规则；自忽略让该保证随目录一起移动、与宿主无关，且不修改宿主任何既有 `.gitignore`。
- 布局：每个产物一份内容快照 `<artifact-id>.bak` + 一份清单 `manifest.json`（含 `sha256`、`sourceVersion`、`capturedAt`、`relativePath`）。
- 保留份数：**每产物 1 份**（就地刷新）。理由：REQ-10 的语义是「快照始终等于最近一次覆盖前的内容」，多份历史会引入「回滚到哪一份」的歧义与无界增长；AC-06 的「旧快照不会覆盖更新的快照」由「先比对再写」保证——仅当快照指纹 ≠ 目标当前指纹时才刷新，因此永远只会写入更新的内容。
- 清单写 `relativePath`（相对项目根）而非绝对路径：快照随项目移动仍可解释，且不泄漏宿主绝对路径。
- 回滚（REQ-11）：校验 `.bak` 指纹与清单一致后才原子写回目标；不一致 ⇒ `ok:false` + `E_SNAPSHOT_CHECKSUM_MISMATCH`（`restored[]` 该项 `status:'failed'`），**MUST NOT** 报告成功（REQ-12 的禁止行为）。回滚后**保留**快照，使同一快照可重复回滚。
- 无快照 ⇒ `ok:false` + `status:'no_snapshot'`，`restored: []`。

**替代方案被否**：

- 放 `~/.dsh/backups/`：跨项目混放，且触碰项目外路径，与 REQ-15「不写项目外」的同一套心智模型冲突；也让「回滚」依赖全局状态。
- 用时间戳多份快照 + 保留 N 份轮转：无界增长需清理策略，而 AC 只要求「最近一次覆盖前内容」。
- 快照存到 `.specify/templates/overrides/../` 之外（如 `.specify/.backup/`）：离被保护文件更远，回滚范围与被保护范围不再同层，且同样需要自忽略，没有收益。
- 改写下游项目的 `.gitignore` 追加 `.specify/templates/overrides/`：MUST NOT —— 宿主 `.gitignore` 是用户资产，插件无写权（章程原则 I「单一可编辑源」与最小侵入）；且 `.specify/.gitignore` 由上游 CLI 生成，改写会与 CLI 刷新冲突。
- 假定「本仓库忽略了就等于下游也忽略」：实测证伪（见上表第 2、3 行）。

---

## R5. 原子替换与符号链接防护的具体原语

**问题**：REQ-13/14/15 要求「同目录临时文件 → 落盘 → 单次替换」「异常清理」「拒绝 symlink 与路径逃逸」。Node 内置能力够不够？

**实测**（`.probe003b/bench.mjs`，200 次迭代，4 KB 负载）：

| 方案 | 结果 |
|------|------|
| `fs.writeFile` 直写 | 0.555 ms/op（基线） |
| `open(tmp,'wx')` + `writeFile` + `fh.sync()` + `close` + `rename` | 1.906 ms/op |
| 上一行 + 对父目录 `fs.open(dir,'r')` + `sync()` | 3.071 ms/op |
| 目录 fsync（Linux） | **成功**；Windows 上 `open(dir,'r')` 会失败 → 必须 `try/catch` 忽略 |
| `fs.rename(tmp, symlinkPath)` | **替换的是链接本身**（重命名后 `isSymbolicLink() === false`，链接原目标内容未变）→ 不显式拒绝就会把用户的软链悄悄变成普通文件 |
| `lstat(link).isSymbolicLink()` | `true`；`realpath(link)` 解析到外部目标 |
| 自写 `hasSymlinkComponent(base, target)` | 对 `a-link/x.md` 返回 `symlink:<abs>`，对 `a/x.md` 返回 `null`，对 `../x.md` 返回 `escape` |

**决策**：

- 写入原语：`atomicWriteFile(target, content)` —— 临时文件名 `.<basename>.<pid>.<random>.tmp` 建在**同目录**（保证 `rename` 同文件系统、原子），`open(tmp,'wx')` 互斥创建，`writeFile` → `sync()` → `close()`，再 `rename(tmp, target)`；父目录 fsync 作为**尽力而为**步骤，失败仅忽略（Windows）。
- 清理：`finally` 中若临时文件仍存在则 `rm(..., {force:true})`；异常原样上抛，目标文件保持原内容（REQ-14）。
- symlink 防护：写入前用 `lstat` 逐层检查「从项目根到目标的每一段路径分量」，任一段为符号链接即拒绝，错误码 `E_SYMLINK`，消息含该段绝对路径；同时保留既有 `assertInside`（`src/core/bridge.mjs:25`）的字符串前缀校验，并把后者升级为「解析 realpath 后再比较」（防止 `..` 与符号链接组合逃逸），错误码 `E_ESCAPE`。
- 拒绝顺序：`E_ESCAPE`（越界）先于 `E_SYMLINK`（段检查），二者都先于任何 `open` 调用。
- 成本：单次覆盖 3 ms 量级，单次 `/sdd-setup` 只写 1–2 个产物，远低于 2 s 预算。

**替代方案被否**：

- 先 `writeFile` 再「失败时回滚」：存在半写窗口，读者可能看到截断内容（REQ-13 明确禁止）。
- 用 `fs.rename` 覆盖 symlink 而不检查：实测会把链接变成普通文件（见上表），是静默破坏。
- 只 `realpath(target)` 后比较前缀：目标不存在时 `realpath` 抛 `ENOENT`（首次安装必经路径），且无法区分「目标本身是链接」与「父目录是链接」。

---

## R6. 单个产物失败不阻断其余产物

**问题**：REQ-16 / AC-09 要求「单产物失败不阻断其余，报告逐产物列成功/跳过/失败」。

**实测**：`installOverrides` 当前只处理一个产物，`syncIndex` 是独立动作；`runSetup` 的 `finish()` 用 `steps.every(s => s.status !== 'failed')` 汇总整体 `ok`（`src/core/setup.mjs:16-22`）。

**决策**：把「多产物」建模为**一个动作内的产物列表**（当前只有 1 项，结构上可扩展），每项独立 `try/catch`：

```jsonc
{
  "action": "install_overrides",
  "ok": false,              // 任一项 failed ⇒ false
  "artifacts": [
    { "id": "ears-spec-template", "path": "...", "status": "written",
      "verdict": "not_installed", "reason": null, "nextAction": null },
    { "id": "...", "path": "...", "status": "failed", "verdict": "unknown",
      "reason": "E_SYMLINK: /abs/path", "nextAction": null }
  ]
}
```

- 向后兼容：仍返回顶层 `status` 与 `path`（旧断言 `ov1.status === 'written'` 与 setup 的 `ov.status === 'written'` 继续可用），`status` 取「第一个产物」的状态；新增 `artifacts[]` 为增量字段（spec §3 兼容性边界允许）。
- `nextAction` 是**机器可读的下一步**（如 `{ tool: 'sdd_bridge', args: { action: 'install_overrides', overwrite: true } }`），供 `/sdd-setup` 技能原样展示给用户，从而让技能正文**不必**硬编码动作名（`test/sdd-kit.test.mjs:1135` 的 forbidden 名单含 `install_overrides`，必须保持绿）。

**替代方案被否**：

- 拆成多个工具动作（`install_overrides` + `install_extension_registry` + `install_skills`）：CLI 拥有后两者的写权，拆出来就是并行逻辑。
- 让 `/sdd-setup` 技能自己拼「显式覆盖」的命令文本：技能正文会绑定工具动作名，违反 `:1135` 的既有断言，且把状态机搬回技能（章程原则 I 禁止）。

---

## R7. 状态判定与报告如何进入 `/sdd-setup`

**问题**：REQ-08/16 要求报告里出现「所选绝对路径与选择依据」「逐产物状态」。现有 `/sdd-setup` 只逐行打印 `steps[].name: status`（`skills/sdd-setup/SKILL.md` 第 3 步）。

**实测**：`runSetup` 的 `record(name, status, detail)` 已支持任意 `detail` 对象（`src/core/setup.mjs:12`），`finish()` 原样返回 `steps`；技能正文第 4 步已要求「必报 integration / skillsDir / 扩展 id 版本与四钩子事件」。故**不需要**新增字段管道，只需在 `install_overrides` 与 `sync_superpowers` 两步的 `detail` 里放结构化信息。

**决策**：

- `install_overrides` 步骤的 `detail` 改为 `{ status, verdict, reason, nextAction, artifacts }`（旧字段 `status` 保留）。
- `sync_superpowers` 步骤的 `detail` 增加 `{ dir, selection: { reason, realPath } }`（`dir` 原本就有）。
- `skills/sdd-setup/SKILL.md` 第 3/4 步各加一句：当 `detail.nextAction` 非空时原样展示并等用户确认；当 `detail.selection.reason` 非 `explicit` 时报告所选绝对路径与依据。**不**新增动作名、**不**新增分支逻辑。

**替代方案被否**：新增 `sdd_upstream(action: "report")` 动作——多余的一次调用，且报告事实已随 setup 返回。

---

## R8. 真实上游集成验证的形态

**问题**：REQ-17/18/19 要求「夜间/手动跑真实上游」「失败指出具体命令与契约点」「不阻塞日常测试」「无网络报未执行」。

**实测**：

| 探针 | 结果 |
|------|------|
| 仓库 `.github/` | **不存在**（无任何 CI） |
| `package.json` scripts | 只有 `"test": "node --test test/sdd-kit.test.mjs"`（单文件，新增测试文件不会自动被跑到） |
| `specify --version` | `specify 1.4.4.dev0`；`uv 0.13.9`；均在 `/home/bobo/.local/bin/` |
| `specify extension list --json` | 存在，返回 JSON 数组（`id/name/version/enabled/provides.{commands,hooks}`）→ 可作为契约断言的数据源，无需解析 YAML |
| `specify init --here --integration dsh --non-interactive --force --ignore-agent-tools` | 在临时目录成功，产物含 `.dsh/skills` + `.specify/{templates,scripts,workflows,...}` |

**决策**：

- 新增独立测试文件 `test/upstream-contract.test.mjs`，**默认整文件 `skip`**，仅当 `DSH_SDD_KIT_INTEGRATION=1` 时执行（`node --test test/upstream-contract.test.mjs`），因此 `npm test`（单文件）完全不受影响 → REQ-18 的「不阻塞日常」由文件隔离保证，而非 `t.skip` 的运行时判断。
- 新增 `scripts/verify-upstream.mjs`（可直接 `node scripts/verify-upstream.mjs` 手动跑，也可被测试文件复用）：在 `mkdtemp` 临时项目里跑 `specify init` → `specify extension add --dev <repo>/spec-kit-extension --force` → `specify extension list --json`，逐条断言**契约点**并输出结构化结果：

  | 契约点 | 断言 |
  |---|---|
  | `init` 参数 | 退出码 0；`.specify/templates/` 含 5 个模板；`.dsh/skills/` 存在 |
  | `extension add --dev` 参数 | 退出码 0；`--dev` 缺省会失败（负例由单测覆盖，集成测试只跑正例） |
  | 清单契约 | `list --json` 中 `id === 'superpowers-hooks'`、`version === '0.1.0'`、`provides.hooks === 4`、`enabled === true` |
  | 钩子注册 | `.specify/extensions.yml` 四个事件各 1 条（文本断言，不锚定换行） |

- 环境不可用（`uv` 缺失 / `specify` 缺失 / 网络失败）⇒ 结果 `{ status: 'not_executed', reason }`，退出码 **0** 但在报告里明确写「未执行（环境不可用）」，**MUST NOT** 写「通过」（REQ-19）。契约断言失败 ⇒ 退出码 **1** 并打印失败的契约点与原始 stdout/stderr 片段（REQ-18）。
- 新增 `.github/workflows/upstream-integration.yml`：`schedule`（每日 03:00 UTC）+ `workflow_dispatch`，`ubuntu-latest`，装 `uv` 后跑 `node scripts/verify-upstream.mjs`。CI 缺失不影响本地可用性。

**替代方案被否**：

- 把真实调用塞进现有 `test/sdd-kit.test.mjs` 并靠 `t.skip` 门控：该文件是日常测试的唯一入口，任何环境抖动都会污染 `npm test` 结论。
- 只做 mock：正是 spec 明确要消除的「自我安慰」（背景段）。
- 用 `specify extension list` 的文本输出做断言：格式随版本变，`--json` 是稳定契约面。
