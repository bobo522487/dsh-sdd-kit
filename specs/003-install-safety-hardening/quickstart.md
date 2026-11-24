# Quickstart：验证安装安全加固

**面向**：维护本插件的开发者，以及想确认「我的手工定制还在、我的项目没被写到外面去」的 DSH 用户。
**前提**：Node.js >= 18（本机 v26.13.1）、`specify` CLI（本机 `1.4.4.dev0`）、`uv`、`git`；全部在 `/home/bobo/.local/bin/` 可用。

---

## 1. 日常：跑一遍单元与契约测试

```bash
cd /home/bobo/Projects/dsh-sdd-kit
npm test
```

期望末尾：

```text
ℹ tests <N>
ℹ pass <N>
ℹ fail 0
```

> 用例总数会随任务增长；判据是 `fail 0` 且 `skipped` 只来自平台受限用例（Windows 的符号链接、root 下的 POSIX 权限位）。基线（本特性开工前）为 `tests 51 / pass 51 / fail 0`。

## 2. 看一个真实项目里发生了什么

在一个临时项目里跑安装，观察状态判定与快照：

```bash
cd $(mktemp -d)
specify init --here --integration dsh --non-interactive --force --ignore-agent-tools
node -e '
import("/home/bobo/Projects/dsh-sdd-kit/src/core/bridge.mjs").then(async ({ runBridge }) => {
  const cwd = process.cwd();
  console.log(JSON.stringify(await runBridge({ action: "install_overrides", cwd }), null, 2));
});
'
```

第一次应看到 `status: "written"`、`verdict: "not_installed"`；再跑一次应看到 `status: "unchanged"`、`verdict: "installed_consistent"`，且文件 mtime 不变。

## 3. 验证「不覆盖我的手工定制」

```bash
echo '# 我的定制' >> .specify/templates/overrides/spec-template.md
node -e '
import("/home/bobo/Projects/dsh-sdd-kit/src/core/bridge.mjs").then(async ({ runBridge }) => {
  const r = await runBridge({ action: "install_overrides", cwd: process.cwd() });
  console.log(r.status, r.artifacts[0].verdict, JSON.stringify(r.artifacts[0].nextAction));
});
'
```

期望：`skipped_user_modified user_modified {"tool":"sdd_bridge","args":{"action":"install_overrides","overwrite":true}}` —— 文件内容仍是你的定制。

显式覆盖时才改写：

```bash
node -e '
import("/home/bobo/Projects/dsh-sdd-kit/src/core/bridge.mjs").then(async ({ runBridge }) => {
  const r = await runBridge({ action: "install_overrides", cwd: process.cwd(), overwrite: true });
  console.log(r.status, JSON.stringify(r.artifacts[0].snapshot));
});
'
```

期望：`written {"captured":true,"refreshed":false,"path":"…"}` —— 覆盖前留下了你的定制内容作为快照；`written` 表示显式覆盖成功，`refreshed` 只用于「历史版本刷新」（`stale_upstream` + 显式覆盖）。

检查快照目录是否**自忽略**（关键：新 `specify init` 项目的 `.specify/.gitignore` 并**不**忽略 `templates/overrides/`，所以本插件必须自带忽略规则；快照目录只在首次显式覆盖时创建）：

```bash
git init -q . && cat .specify/templates/overrides/.backup/.gitignore
git check-ignore -v .specify/templates/overrides/.backup/manifest.json
git status --porcelain
```

期望：`cat` 输出 `*`；`check-ignore` 命中 `.specify/templates/overrides/.backup/.gitignore`；`git status` **不含** `.backup`。

## 4. 一键回滚

```bash
node -e '
import("/home/bobo/Projects/dsh-sdd-kit/src/core/bridge.mjs").then(async ({ runBridge }) => {
  const r = await runBridge({ action: "restore_overrides", cwd: process.cwd() });
  console.log(JSON.stringify(r, null, 2));
});
'
```

期望 `ok: true`、`restored[0].sourceVersion` 非空，且 `spec-template.md` 逐字节等于你刚才的定制内容。再跑一次仍应成功（快照被保留）。

在干净项目里（没有 `.backup/`）执行同一命令：

```bash
cd $(mktemp -d) && node -e '
import("/home/bobo/Projects/dsh-sdd-kit/src/core/bridge.mjs").then(async ({ runBridge }) => {
  console.log(JSON.stringify(await runBridge({ action: "restore_overrides", cwd: process.cwd() })));
});
'
```

期望 `{"ok":false,"status":"no_snapshot","restored":[],...}` —— **不是** `ok:true`。

## 5. 验证拒绝符号链接

```bash
cd $(mktemp -d) && mkdir -p .specify/templates/overrides && echo SECRET > /tmp/outside-$$.md
ln -s /tmp/outside-$$.md .specify/templates/overrides/spec-template.md
node -e '
import("/home/bobo/Projects/dsh-sdd-kit/src/core/bridge.mjs").then(async ({ runBridge }) => {
  const r = await runBridge({ action: "install_overrides", cwd: process.cwd(), overwrite: true });
  console.log(r.ok, r.artifacts[0].reason);
});
'
cat /tmp/outside-$$.md
```

期望：`false E_SYMLINK: …`，且 `cat` 仍输出 `SECRET` —— 项目外文件未被修改。

> Windows 上创建符号链接需要管理员权限或开发者模式；该用例在 Windows 上会被 `t.skip` 并注明原因（章程技术约束）。

## 6. 验证候选目录选择

```bash
cd $(mktemp -d)
mkdir -p a b c && ln -s "$PWD/a" "$PWD/a-link"
touch -d '2020-01-01' a a-link b
node -e '
import("/home/bobo/Projects/dsh-sdd-kit/src/core/upstream.mjs").then(async ({ runUpstream }) => {
  const r = await runUpstream({ action: "status", cwd: process.cwd(),
    candidateDirs: ["a", "a-link", "b", "c"] });
  console.log(r.superpowers.selection);
});
'
```

期望：`candidateDirs` 中 `a` 与 `a-link` 的 `realPath` 相同，但只有首次声明的 `a` 为 `eligible: true`、`a-link` 被标 `false`（留在报告里供排错）；选中的是 `c`（最近修改），`reason: "candidateDirs"`。重复运行结果一致。

## 7. 手动跑一次真实上游集成验证

```bash
cd /home/bobo/Projects/dsh-sdd-kit
node scripts/verify-upstream.mjs
```

期望（联网、`uv`/`specify` 可用）：

```text
Upstream contract verification (specify 1.4.4.dev0, uv 0.13.9)
  ✔ init-args
  ✔ extension-add-args
  ✔ manifest-contract
  ✔ hooks-registered
Status: passed
```

无网络时期望：

```text
Status: not_executed
未执行（环境不可用）：network — <stderr 片段>
```

退出码仍为 0。**看到 `not_executed` 不等于通过**，只是「没跑成」。

> **已被 T099 取代**：当前 `not_executed`（含无网络）退出码为 1；版本漂移（`versionDrift.needsAdjustment`）与契约失败同样退出 1。上文「退出码仍为 0」为历史规格，仅作留档。

## 8. 排错表

| 现象 | 原因 | 处理 |
|---|---|---|
| `verdict: "unknown"` + `reason: "EACCES"` | 目标文件不可读 | `chmod 644` 后重试；或先回滚。加 `overwrite:true` 也不会绕过——读不出字节就没有可回滚快照，会报 `E_SNAPSHOT_UNREADABLE` |
| `E_SYMLINK: /abs/path` | 路径某一层是符号链接 | 用真实路径重跑；不要用软链指向模板目录 |
| `E_ESCAPE: /abs/outside` | 目标解析后落在项目根外 | 检查 `cwd` 是否传错；插件不会写项目外 |
| `status: "no_snapshot"` | 从未发生过覆盖 | 先跑一次带 `overwrite:true` 的安装 |
| `E_SNAPSHOT_CHECKSUM_MISMATCH` | 快照被手工改过 | 删除 `.backup/` 后重新安装（会重新留快照） |
| `not_executed`（集成验证） | 缺 `uv`/`specify`/网络 | 装依赖或换联网环境；不要当通过 |
| `skipped_user_modified` 反复出现 | 你手工改过模板覆盖文件（这是预期保护） | 保留你的定制；确需随包版本时按 `nextAction` 显式覆盖（`overwrite:true`） |
| `skipped_stale` 反复出现 | 随包模板已更新，本地是旧版 | 按 `nextAction` 显式覆盖（`overwrite:true`） |

## 9. 自检清单

- [ ] `npm test` 全绿，`skipped` 只来自平台受限用例
- [ ] 连续两次安装：第二次全为 `unchanged`，`mtime` 未变
- [ ] 手工定制后安装：`skipped_user_modified`，文件未变
- [ ] 显式覆盖：产生快照，`snapshot.captured === true`
- [ ] 回滚：内容逐字节还原，报告含 `sourceVersion`
- [ ] 干净项目回滚：`ok:false` + `no_snapshot`
- [ ] 符号链接目标：`E_SYMLINK`，项目外文件未变
- [ ] 候选选择：同一 realpath 只算一次，最近活跃者胜出，重复运行一致
- [ ] `git status --porcelain` 不含 `.backup/`（在**新 `specify init` 项目**里验证，不靠本仓库的 `.gitignore`）
- [ ] `node scripts/verify-upstream.mjs` 给出 `passed` 或明确的 `not_executed`
