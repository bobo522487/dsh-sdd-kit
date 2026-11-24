# 契约：`scripts/verify-upstream.mjs`（真实上游集成验证）

**对应**：REQ-17、REQ-18、REQ-19 / AC-10
**数据形状**：[data-model.md E7](../data-model.md)

本契约描述一个**独立脚本**（不是工具、不是技能）的输入、输出与退出码。它的存在只为回答一个问题：上游 `specify` CLI 的参数与扩展契约**今天**还成立吗？

---

## 1. 入参（命令行与环境）

| 来源 | 名称 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| argv | `--json` | 否 | `false` | 只输出 JSON（CI 与测试用）；缺省输出人类可读报告 + 末尾 JSON 块 |
| argv | `--keep` | 否 | `false` | 保留临时项目目录（排错用），并打印其路径 |
| env | `DSH_SDD_KIT_INTEGRATION` | 否 | — | 值为 `1` 时测试文件执行本脚本；脚本本身不依赖它 |
| env | `PATH` | 是 | — | 需能找到 `specify` 与 `uv`（缺失即 `not_executed`） |

**禁止新增的入参**：`--repo` / `--ref`（被测对象是本仓库的 `spec-kit-extension/`，允许指向别处等于测别人的东西）、`--offline`（离线即 `not_executed`，不需要开关）、`--fix`（验证器不修东西）。

## 2. 行为

```text
1. 探针：specify --version / uv --version / git --version
   任一缺失 → status='not_executed', reason='<tool> not found on PATH', exit 0   # REQ-19
2. tmp ← mkdtemp(join(tmpdir(),'dsh-sdd-upstream-'))
3. check('init-args'):        runner('specify', ['init','--here','--integration','dsh',
                               '--non-interactive','--force','--ignore-agent-tools'], {cwd:tmp})
   断言 exit 0 且 .specify/templates/ 含 5 个模板、.dsh/skills/ 存在
4. check('extension-add-args'): runner('specify', ['extension','add','--dev',
                               <repo>/spec-kit-extension,'--force'], {cwd:tmp})
   断言 exit 0
5. check('manifest-contract'):  runner('specify', ['extension','list','--json'], {cwd:tmp})
   解析 JSON，找 id === 'superpowers-hooks'；断言 version 存在、provides.hooks === 4、enabled === true
6. check('hooks-registered'):   读 tmp/.specify/extensions.yml，断言四个事件名各出现 1 次
                               （文本断言，不锚定换行与缩进）
7. 网络/凭据类失败（init 或 add 的 stderr 命中 ECONNREFUSED/ETIMEDOUT/network）→ not_executed
8. 其余失败 → status='failed'，逐项 detail 写明「哪个命令 / 哪个参数 / 哪个字段」
9. finally: 若 !--keep 则 rm -rf tmp
10. 输出报告；exit code = status==='failed' ? 1 : 0
```

**关键约束**：

- **真实执行**（REQ-17）：MUST NOT 用 mock、MUST NOT 复用单测的 fake runner。所有断言基于真实子进程的 stdout/exit code 与真实生成的文件。
- **契约点可定位**（REQ-18）：每个 `check.id` 对应一个具体的上游交互；`detail` 必须包含命令字符串或字段名，例如 `"extension list --json: provides.hooks = 3, expected 4"`。
- **不阻塞日常**（REQ-18）：本脚本 MUST NOT 被 `test/sdd-kit.test.mjs` 引用；`npm test` 的入口只有那一个文件，故默认永不执行本脚本。
- **未执行 ≠ 通过**（REQ-19）：`not_executed` 时退出码为 0（不让 CI 因环境缺失变红），但 stdout 必须明确含「未执行」与原因，MUST NOT 输出 `passed`；`--json` 模式下 `status` 字段为 `"not_executed"`。
- **不写仓库**：所有写入都在 `mkdtemp` 目录内；`--keep` 只影响是否删除。
- **超时**：每条子进程命令 120 s（复用 `defaultRunner` 的量级），总时长上限 10 分钟。
- **零依赖**：只用 `node:` 内置模块与既有 `defaultRunner`。

## 3. 返回（成功）

人类可读模式：

```text
Upstream contract verification (specify 1.4.4.dev0, uv 0.13.9)
  ✔ init-args            specify init --here --integration dsh --non-interactive --force --ignore-agent-tools
  ✔ extension-add-args   specify extension add --dev <repo>/spec-kit-extension --force
  ✔ manifest-contract    superpowers-hooks 0.1.0, provides.hooks = 4, enabled
  ✔ hooks-registered     before_implement, after_implement, before_bug_fix, after_bug_fix
Status: passed
```

`--json` 模式：

```jsonc
{
  "status": "passed",
  "versions": { "specify": "1.4.4.dev0", "uv": "0.13.9", "git": "2.43.0" },
  "checks": [
    { "id": "init-args", "ok": true, "detail": "specify init … exit 0; 5 templates; .dsh/skills present", "stderr": null },
    { "id": "extension-add-args", "ok": true, "detail": "… exit 0", "stderr": null },
    { "id": "manifest-contract", "ok": true, "detail": "id=superpowers-hooks version=0.1.0 provides.hooks=4 enabled=true", "stderr": null },
    { "id": "hooks-registered", "ok": true, "detail": "4/4 events registered once", "stderr": null }
  ],
  "reason": null,
  "tmpDir": null
}
```

## 4. 返回（失败 / 未执行）

| 场景 | `status` | 退出码 | 输出要求 |
|---|---|---|---|
| `specify` 不在 PATH | `not_executed` | `0` | 「未执行（环境不可用）：specify not found on PATH」 |
| `uv` 不在 PATH | `not_executed` | `0` | 同上 |
| 无网络（`init` 需下载模板） | `not_executed` | `0` | 含原始 stderr 片段与「未执行（环境不可用）：network」 |
| `init` 参数被上游改名 | `failed` | `1` | `checks[init-args].detail` 含完整命令与 exit code；附 stderr 前 2000 字符 |
| `extension add --dev` 被移除 | `failed` | `1` | 同上，指明 `--dev` 参数 |
| `provides.hooks` 数量变化 | `failed` | `1` | `manifest-contract` 的 detail 写明实际值 vs 期望值 |
| `extension.yml` 少一个事件 | `failed` | `1` | `hooks-registered` 的 detail 列出缺失事件名 |

## 5. 调用位置与报告要求

- **本地手动**：`node scripts/verify-upstream.mjs`（`--keep` 排错，`--json` 给 CI）。
- **CI**：`.github/workflows/upstream-integration.yml` —— `schedule`（每日 03:00 UTC）+ `workflow_dispatch`，`ubuntu-latest`，`astral-sh/setup-uv` 后执行脚本；失败即 workflow 红。
- **测试**：`test/upstream-contract.test.mjs` 仅在 `DSH_SDD_KIT_INTEGRATION=1` 时 import 并调用 `verifyUpstream()`，断言 `status !== 'failed'`。
- **报告要求**：任何一次「未执行」都必须在报告里出现「未执行」字样，禁止只写「跳过」——用户需要区分「没跑」与「跑了没问题」。

## 6. 测试契约

| 断言 | 方法 |
|---|---|
| 默认 `npm test` 不执行本脚本 | 断言 `test/sdd-kit.test.mjs` 不含 `verify-upstream` 字样 |
| `DSH_SDD_KIT_INTEGRATION` 未设时测试文件整体 skip | `test/upstream-contract.test.mjs` 顶层条件 + `t.skip('set DSH_SDD_KIT_INTEGRATION=1')` |
| 环境缺失 ⇒ `not_executed` 且退出码 0 | 用 `PATH=` 空环境跑脚本（子进程），断言 exit 0 且输出含「未执行」 |
| 契约失败 ⇒ 退出码 1 且 detail 非空 | 用假的 `specify` shim（打印错误并 exit 2）跑脚本，断言 exit 1 且 `checks` 有 `ok:false` |
| `--json` 输出可解析 | `JSON.parse(stdout)` 成功且含 `status`/`checks`/`versions` |
| `not_executed` 时 `checks` 可为空数组，但 `reason` MUST 非空 | 空 `PATH` 环境跑 `--json`，断言 `checks.length === 0` 且 `reason` 非空 |
| `passed` 时 `checks` 恰含四个契约点 | 真实运行后断言 `checks.map(c=>c.id).sort()` 等于四个 id |
| 不写仓库 | 运行前后对 `git status --porcelain` 比对为空 |
| CI 工作流存在且触发条件正确 | 读 `.github/workflows/upstream-integration.yml`，断言含 `schedule` 与 `workflow_dispatch` |
