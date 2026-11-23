# Research: SDD Unified Update Command

Date: 2026-11-23 | Spec: [spec.md](./spec.md) | Constitution: [constitution.md](../../../.specify/memory/constitution.md)

## 1. Command Surface — how `/sdd-update` becomes invocable

**Decision**: 新增第三个薄技能 `skills/sdd-update/SKILL.md`，frontmatter 为 `name: sdd-update`、`description: ...`、`disable-model-invocation: true`，H1 为 `# /sdd-update`。其正文只委托 `sdd_upstream(action: "update_all", ...)`。对应的 MAJOR 章程修正已由独立治理命令完成并继续升至 v2.1.0：原则 I 现已允许三个命名技能（`sdd-setup`、`sdd-implement`、`sdd-update`）与两个 Host 工具；功能内 T001 仅核验该状态，不得重复修正。

**Rationale / evidence**:
- 本插件的斜杠命令是 Cordis 挂载的技能，而非 Host 工具：`/home/bobo/Projects/dsh-sdd-kit/cordis.patch.yml:1-4` 挂载桥接技能，`:5-11` 配置 `@deepseek-ai/dsh-skill-filesystem` 的 `bundledSkillDir` → 打包的 `skills/` 目录。`package.json:13-20` 打包整个目录。
- 既有技能遵循同一契约：`/home/bobo/Projects/dsh-sdd-kit/skills/sdd-setup/SKILL.md:1-7` 与 `/home/bobo/Projects/dsh-sdd-kit/skills/sdd-implement/SKILL.md:1-7`，即 frontmatter `name` / `description` / `disable-model-invocation: true` 与 H1 `/<name>`。
- DSH 的手势匹配是精确的、以空白为边界的 `/name` 正则：`/home/bobo/.nvm/versions/node/v26.13.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-skill/src/index.ts:422-449`，正则在第 429 行。不存在技能别名或子命令机制。
- 此处 Host 工具仅供模型调用：`/home/bobo/Projects/dsh-sdd-kit/src/register.mjs:9-123` 恰好注册 `sdd_upstream`（第 16 行）与 `sdd_bridge`（第 80 行）；`/home/bobo/Projects/dsh-sdd-kit/src/index.mjs:1-9` 只注入 `tools`，从不使用 `ctx.commands`。
- 章程状态：此前 `.specify/memory/constitution.md` 的“两个技能”上限已通过独立治理命令修订，当前 v2.1.0 原则 I 允许三个命名技能；`test/sdd-kit.test.mjs` 的技能断言已由 T005 更新为 `['sdd-implement','sdd-setup','sdd-update']`。薄胶水条款仍满足，因为该技能不含任何更新算法。
- 修正机制：`/home/bobo/Projects/dsh-sdd-kit/.specify/memory/constitution.md:99-105` 要求版本行 + Sync Impact Report、负责人批准、迁移说明，且重定义原则须升 MAJOR。用户对 `/sdd-update` 的字面要求即为 plan 中记录的授权依据。

**Alternatives rejected**:
| Alternative | Why rejected |
| :--- | :--- |
| `/sdd-setup update` 旗标/子命令 | DSH 无子命令手势（`dsh-tool-skill/src/index.ts:429`）；且可能重跑原则 V 禁止的 setup 语义（`constitution.md:57-63`）。 |
| 只新增 `update_all` 动作，不加第三个技能 | 章程上干净，并作为 Host 工具基底保留，但无法产生精确的 `/sdd-update` 用户手势。 |
| 技能 frontmatter 别名 | `dsh-skill-filesystem` 无别名字段（`.../dsh-skill-filesystem/README.md:34-38`）；内置别名仅限第一方。 |
| `ctx.commands.register({ name: 'sdd-update' })` | 确实存在独立的 DSH Human Command 注册表（`.../dsh-commands/README.md:28-50`），但 `src/index.mjs:5` 需新增注入，且会引入未枚举的第三表面、缺少 ACP 等价能力，仅限 UI。仅作退路。 |

## 2. Update Mechanics — what the command actually calls

**Decision**: 在 `src/core/update.mjs` 实现 `runUpdate(args, deps)`。仅复用 `runUpstream` 的 `status`、`specify_upgrade`、`sync_superpowers` 动作，外加 `src/core/kit-copy.mjs` 中新的 `refreshInstalledKit` 胶水。在 `src/register.mjs` 增加 `action: "update_all"` 分派。此路径绝不调用会写入的 setup 命令。

**Rationale / evidence**:
- `runUpstream(args = {}, runner = defaultRunner)` 位于 `/home/bobo/Projects/dsh-sdd-kit/src/core/upstream.mjs:95`；第二参数允许测试注入依赖。默认 runner 失败时返回 `{ok:false,...}`（`:45-61`）而不抛错，故调用方必须检查 `ok`。
- 默认 Superpowers 镜像路径为 `~/.dsh/upstream/superpowers`，由 `src/core/upstream.mjs:41-43` 的 `getDefaultSuperpowersDir()` 提供；不硬编码机器相关路径。
- 标识可得性（通过两次 `status` 调用取得 before/after）：

| Component | Before | Updater | After | Notes |
| :--- | :--- | :--- | :--- | :--- |
| Spec Kit CLI | `status.specifyCli.version`，来自 `specify --version`（`src/core/upstream.mjs:103,:120`）；`uv.version` / `git.version` 见 `:104-105,:121-122` | `specify_upgrade`（`:145-153`）返回 `mode`、`python`、`command`、`ok/code/stdout/stderr`，但不返回版本 | 重跑 `status` → `specifyCli.version` | 全新安装固定稳定 Python（默认 `3.14`，可覆盖）。 |
| Superpowers mirror | `status.superpowers.head`，即 `git -C <dir> rev-parse --short HEAD` 的短 SHA（`:108-115,:123-128`），另有 `skillCount`、`installed`、`dir` | `sync_superpowers`（`:91-102`）返回 `mode: 'pull'|'clone'`、`skillCount`、`ok/...` | 重跑 `status` → 新的 `head` / `skillCount` | 首次克隆会改变已挂载技能；需要重启。 |
| dsh-sdd-kit | 对 allowlist 相对路径与内容计算 SHA-256 树哈希；`package.json` 版本仅作信息展示（`package.json:3`，`0.3.0`） | `refreshInstalledKit`（新增） | 复制后重新哈希；返回 `{changedFiles, mode}` | 已安装目录无 `.git`，其版本无法证明树一致，故以哈希为准。 |

- `/sdd-update` 禁止调用：`specify_init`（`src/core/upstream.mjs:155-167`，会传 `--force` 并写入 `.specify/`）与 `install_bug_ext`（`:168-172`，执行 `specify extension add bug`）；以及全部 `sdd_bridge` 写入动作：`installOverrides`（`src/core/bridge.mjs:142-153`）、`checkTask`（`:155-196`）、`syncIndex`（`:198-230`）。这些会违反 REQ-06（`spec.md:21`）与 `spec.md:26-27` 的 Non-Goals。`inspectRepo`（`src/core/bridge.mjs:61-140`）为只读，但本命令不需要。
- REQ-02 采用幂等更新器 + 标识比较，因为薄上游表面没有只读的“最新版本”探测。`git pull --ff-only` 与 `uv tool upgrade specify-cli` 在已最新时即为空操作。严格的 `git ls-remote` / PyPI 查询会重复上游网络逻辑（违反零分叉）。可观测的 AC-02 得以保留：结果为 `unchanged` 且无有效变化；`specify_upgrade` 命令调用本身仍作为薄上游委托保留。

**Alternatives rejected**: 解析 `pull`/`uv` 的 stdout（脆弱）；新增只读的 `check_latest` 上游动作（新增并行网络逻辑）；版本等于本地就跳过调用更新器（无网络则无法得知“最新”）。

## 3. dsh-sdd-kit Refresh — source, destination, safety

**Decision**: 要求显式 `dshKitSourceDir`（本地检出，例如 `/home/bobo/Projects/dsh-sdd-kit`）；目标路径由 `$DSH_PROFILE_DIR/node_modules/dsh-sdd-kit` 推导，回退到 `~/.dsh/profiles/${DSH_PROFILE:-web}/node_modules/dsh-sdd-kit`。只复制 `package.json:13-20` 的打包载荷 allowlist —— `src/`、`skills/`、`overrides/`、`cordis.patch.yml`、`README.md`、`LICENSE` —— 外加 `package.json` 元数据（npm 总会附带）。校验源包含 `package.json` 且 `name === 'dsh-sdd-kit'`，并含 `src/index.mjs`。使用仿照 `src/core/bridge.mjs:25-32` 的 `assertInside` 风格守卫：源 ≠ 目标、源不在目标内、目标不在源内、每个被复制条目均位于两个根之内。先把所有文件暂存到目标旁的临时目录，校验暂存树哈希，再用 `fs.rename` 逐条目换入。绝不 `rm -rf` 目标；只在该条目被换入前删除对应的 allowlist 条目。

**Rationale / evidence**:
- 章程规定安装即普通目录复制，路径为 `/home/bobo/Projects/dsh-sdd-kit/../../.dsh/profiles/web/node_modules/dsh-sdd-kit`（`.specify/memory/constitution.md:81-83`，文档写作 `/home/bobo/.dsh/profiles/web/node_modules/dsh-sdd-kit`）；源码变更必须复制到该处，工具代码变更时须请求重启。规范假设当前本地源为事实来源（`spec.md:46`）。
- 来自更新调研的关键风险：已安装文件与 pnpm 内容寻址存储硬链接（链接数为 2，指向 `/home/bobo/.local/share/pnpm/store/v11/files/84/60ce…`）。直接对目标执行 `fs.writeFile` / `fs.copyFile` 会污染共享存储及所有共享它的 profile。`fs.rename` 暂存文件只替换目录项并打断硬链接。
- `.modules.yaml` 仍固定较旧的 `dsh-sdd-kit` tarball，而文件内容已与源码 HEAD 一致；未来 `dsh plugin` 安装可能覆盖手工副本。这是迁移说明，不构成改变命令事实来源语义的理由。
- `dshKitSourceDir` 缺失或非法 → REQ-05（`spec.md:20`）：为 dsh-sdd-kit 记录清晰错误，仍尝试并报告 Spec Kit 与 Superpowers。
- 哈希算法：对 allowlist 内普通文件按 `[相对路径, 文件内容]` 排序（文本与二进制均按字节处理），取 SHA-256 十六进制。目录通过其包含的文件参与计算；symlink 一律拒绝。`package.json` 版本仅作为人类可读标签单独报告。

**Alternatives rejected**: 直接用 `fs.cp` / `copyFile`（污染 pnpm 存储）；官方 `dsh plugin --profile web add <tarball|URL>`（依赖网络、registry 滞后时可能降级、无法按 `spec.md:46` 指向本地检出）；仅按版本判断漂移（打包版本无法证明已安装树与源一致）。

## 4. Failure isolation and report shape

**Decision**: 三个组件任务彼此独立执行（例如 `Promise.allSettled`）并各自 `try/catch`；始终返回三条记录。结果取 `unchanged` | `updated` | `failed`。仅当所有结果均为 `unchanged` 或 `updated` 时总体 `ok` 为 true。包含 `errors[]`（组件名 + 消息）与 `requiresRestart` 布尔值。

**Rationale**: REQ-03（`spec.md:18`）与 AC-03（`spec.md:33`）要求单个失败不得中断其他组件，且总体失败必须可见。上游失败以 `{ok:false}` 返回（`src/core/upstream.mjs:53-60`），kit 复制失败在本地返回或抛出；两者都必须归一化为同一记录形状。绝不把失败组件藏在总体成功之下（Non-Goal `spec.md:27`）。

**Alternatives rejected**: 顺序 `await` 并在首个错误抛出（违反 REQ-03）；单一聚合 try/catch（丢失逐组件识别）。

## 5. Restart reporting

**Decision**: 当以下任一成立时设 `requiresRestart = true`：(a) dsh-kit profile 树哈希变化；(b) Superpowers 更新器返回 `mode === 'clone'`；(c) 两次 `status` 之间 Superpowers 的 `skillCount` 变化。仅升级 Spec Kit CLI 不需要重启。最终报告始终说明“Restart DSH to load updated tools/skills”或“No restart required”。

**Rationale**: `constitution.md:62` 与 `:81-83`、`README.md:35`、`skills/sdd-setup/SKILL.md:16` 都要求在 profile/工具变更或首次 Superpowers 技能变更后重启。REQ-07（`spec.md:22`）与 AC-06（`spec.md:36`）要求面向用户的说明；自动重启是明确的 Non-Goal（`spec.md:26`）。

## 6. Test strategy

**Decision**: 扩展 `test/sdd-kit.test.mjs`（现有套件见 `package.json:42`）：
1. 用伪造的 `runUpstream` / `refreshKit` 与 mock `runner` 注入 `runUpdate`，风格参照 `test/sdd-kit.test.mjs:18-55` 与 `:157-181`。
2. 部分失败：mock `git ... pull` 失败 → Spec Kit 与 dsh-kit 条目仍存在，Superpowers 被标为失败，总体 `ok:false`（AC-03）。
3. 无副作用快照：在临时 cwd 写入 `specs/001-x/{spec,plan,tasks}.md`、`.specify/`、`src/app.js`；递归快照路径 → 前后 sha256；断言完全一致，并断言未调用 `specify init` / `specify extension add bug`（AC-05）。
4. 已最新：两次读取的 version/HEAD 与源/profile 哈希一致 → 全部 `unchanged`，无有效的 `uv tool upgrade|install`、无有效的 `git pull|clone`（AC-02）。
5. 缺少源：无 `dshKitSourceDir` → 清晰的 dsh-kit 错误，两条上游状态仍存在（AC-04）。
6. 已更新：v1→v2 / h1→h2 且源哈希变化 → 三条 `updated` 记录并带 before/after（AC-01）。
7. 重启：profile 变化或 Superpowers 克隆/技能数变化 → `requiresRestart: true` 与报告文案（AC-06）。
8. 把 `test/sdd-kit.test.mjs:140-155` 的精确技能断言改为 `['sdd-implement','sdd-setup','sdd-update']`；`:118-138` 的 Host 工具断言仍为两个工具。

**Rationale**: 严格 TDD 不可协商（constitution.md:46-50），且现有套件已提供临时目录、注入 runner 与精确表面断言，可在不新增依赖的前提下扩展。

## 7. Open risks / migration notes

- 首次采用 `/sdd-update` 仍需按文档手工复制 profile 并重启 DSH：命令自身的新代码必须先被安装才能运行。
- 第三个技能所需的 MAJOR 章程修正已先行完成（当前章程 `v2.1.0`）；功能内仍需协调插件版本 `0.3.0`（`package.json:3`）以及 `cordis.patch.yml:1-2`、`README.md:5` 的注释更新。
- 暂存换入对单个条目是原子的，但跨全部条目并非原子；换入中途崩溃可能留下混合 profile。缓解：先完成全部暂存与哈希校验，并在任何 kit 变更时始终报告重启。
- `.modules.yaml` 的固定关系意味着未来 `dsh plugin` 操作可能覆盖已刷新的副本；在 quickstart.md 中记为已知运维注意事项。
