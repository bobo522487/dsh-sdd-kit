# dsh-sdd-kit 宏观架构评审（Linus 判据）

| 项 | 值 |
|---|---|
| 评审对象 | `D:\Project\dsh-sdd-kit` @ `1965139`（v0.4.0 之后的工作树，clean） |
| 评审日期 | 2026-11-23 |
| 评审环境 | Windows 10/11 + node v22.23.2；本机**未安装** `specify` CLI |
| 评审方法 | 全读 `src/`、`skills/`、`spec-kit-extension/`、测试、章程、两份规格、扩展清单、安装产物；实跑 `npm test`；未执行扩展端到端安装 |
| 角色 | 资深架构师，以"好品味 / 不造第二套机制 / 不维护多份事实"为唯一判据 |

---

## 一、结论

**方向是对的，而且难得地对；产品是薄的，但薄在了不该薄的地方，厚在了不该厚的地方。**

一句话：这个项目从事上看只有 955 行代码，却已经造出了四套"第二套机制"，并把同一件事写在三处；同时它在一台 Windows 机器上是红的。

三个判定：

- **战略（A）**：把"做什么"交给 `specify`、把"怎么做"交给 superpowers、用 Spec Kit 原生扩展钩子取代自研 `/sdd-implement`。这是全项目最正确的一步——它不是"加适配层"，而是**删掉一整条并行路径**，把调度权还给上游。零分叉在**语义**上成立。
- **结构（C）**：`kit-copy` 自研安装器、`check_task` 平行任务勾选、`KIT_ALLOWLIST`/`files`/测试夹具三份白名单、`HOOKS_EXTENSION` 常量与 `extension.yml` 双份元数据。零分叉在**产物**上不成立。
- **卫生（D）**：`npm test` → 43 tests / 36 pass / **3 fail** / 4 skipped；而 v0.4.0 release notes 写的是 38/38 pass。章程原则 III 要求"完成声明必须以实际命令输出为依据"，这 3 个红就是它要防的事。

评审不代改代码、不代改章程。下面每条给出**判定 / 证据 / 改法 / 验收**，改与不改由拥有者决定。

---

## 二、基线（可复现的测量）

| 层 | 规模 | 性质 |
|---|---|---|
| `src/` | 6 文件 / 955 行 / 40 KB | 产品代码 |
| `test/` | 1 文件 / 1523 行 / 71 KB | 测试（比产品代码多 60%） |
| `skills/` + `spec-kit-extension/` | 7 文件 / ~10 KB | 数据（提示词契约） |
| `specs/` | 19 文件 / 188 KB | 过程产物（001、002） |
| `.specify/` | 38 文件 / 186 KB | **上游生成物**，已入库 |
| `.dsh/skills/` | 16 文件 / 174 KB | **上游生成物**，已入库 |
| git 跟踪总计 | 96 文件 | 其中产品自有 18 个 |

产品自有源码 40 KB : 非产品跟踪内容 548 KB ≈ **1 : 13**。也就是说，这个"极简桥接插件"的仓库里，95% 的字节不是它自己。

再看一处比例：`src/core/kit-copy.mjs` 245 行，占 `src/` 的 **26%**——四分之一的产品代码，在实现"把文件复制到 profile"。

### 实测测试结果（HEAD，clean 工作树）

```text
# tests 43 / pass 36 / fail 3 / skipped 4 / duration_ms 954
not ok 13  refreshInstalledKit ...        EPERM: operation not permitted, symlink ...
not ok 33  US1 hook commands ...          before-implement must open with a description-only frontmatter
not ok 34  US2 hook commands ...          before-bug-fix must open with a description-only frontmatter
```

三条失败的根因各不相同，且**都不是产品逻辑错了**：

1. `git ls-files --eol` 显示 `i/lf w/crlf`：`core.autocrlf=true`、仓库**没有 `.gitattributes`**，而测试用 `/^---\ndescription: \S.*\n---\n/` 锚定 LF。POSIX 检出上是绿的，Windows 检出上是红的。
2. 测试用 `fs.symlink` 构造场景，Windows 非开发者模式必然 EPERM。
3. 4 个 skip 是本机没有 `specify` CLI——而仓库里 `.specify/integrations/dsh.manifest.json` 的 `installed_at` 与 `/home/bobo/...` 路径说明这些产物是在另一个环境（Linux/WSL）生成的。

这不是"产品回归"，是**证据链在地理上分裂了**：代码在 Linux 上验证，仓库在 Windows 上使用。对一份宣称"严格 TDD、完成必须有证据"的项目，这比一个功能 bug 更值得修。

---

## 三、先说不要改的东西（好品味）

Linus 式的评审，先确认哪些动一下就会变坏：

1. **用扩展钩子取代 `/sdd-implement`**。这是"删掉特例"的教科书动作：执行纪律原本由一条自研入口承载，现在由 Spec Kit 自己的调度器在 `before_implement`/`after_implement` 上调用。路径少一条，冲突面随之消失（Spec Kit 升级 implement 模板不再打架）。**不要为了"更可控"把它加回来。**
2. **钩子只按名字引用上游技能，不内联纪律正文**。纪律的唯一来源是 `~/.dsh/upstream/superpowers/skills`，插件里只有引用。这是唯一正确的做法，任何"顺手复制一段 TDD 要点"的改动都是在制造第二份真相。
3. **刻意软门禁，并明说不启用 Runtime Events**。承认权衡、不做半硬半软，比"看起来能拦"的半成品强得多。产品文档已经写清了边界，这点应保留。
4. **生命周期交给 CLI**：`extension add --dev --force`、`remove --force` 回滚、插件**不解析** `extensions.yml`。幂等与卸载都有真实 CLI 在场证明，比自写 YAML 状态机可靠。
5. **`describeIntegration` 只报告不切换**（REQ-15）。不擅自改用户布局，这与 "don't break userspace" 同构，是难得的克制。

---

## 四、P0：已经在违反自己章程的四件事

### P0-1 自研 profile 安装器 = 第二套包管理器

**证据**

- `src/core/kit-copy.mjs` 245 行：allowlist 收集、sha256 树哈希、staging 目录、backup 目录、逐项 rename 交换、失败回滚、symlink 拒绝。
- 白名单存在**三份**：`package.json.files`、`KIT_ALLOWLIST`、测试里的 `seedKitSource`（测试断言"三处都含 `spec-kit-extension`"——这条测试的存在本身就是在给重复打补丁）。
- 旗舰命令 `update_all` 的第 3 个组件默认**必然失败**：不传 `dshKitSourceDir` 就报 "No dsh-sdd-kit source configured"。一个"一条命令刷新三层"的命令，默认只能刷新两层。
- 把正在被 DSH 加载的 `node_modules/dsh-sdd-kit` 目录原地 rename 交换——在 Windows 上这是文件锁重灾区，也是"必须重启 DSH"这条提示的真正来源。
- 装好的副本**没有身份**：无 origin、无 commit、无版本来源，所以只能靠人记路径。

**判定**：这是本项目最严重的结构问题。**插件无法可靠地替换正在运行的自己**——`restartRequired` 的存在就是这条定律的证据。把"替换运行中的进程"做成一个工具动作，本身就注定了失败模式：要么换不动，要么换一半，要么换完还得重启（等于没换）。

README 里其实已经写了正确路径：`dsh plugin --profile web update dsh-sdd-kit --latest`。现在的问题是**同时存在两条升级路径**，一条官方、一条自研，而自研那条更显眼（在 `/sdd-update` 里）。

**改法 A（首选：删）**
- 删除 `kit-copy.mjs` 与 `update.mjs` 中的 `dsh-sdd-kit` 组件，`update_all` 退化为两层（spec-kit、superpowers）。
- 插件自身升级只走 `dsh plugin ... update --latest` + 重启，由 README/技能告诉用户敲这一条。
- 收益：`src` −245 行；三份白名单归零；Windows 文件锁风险消失；`/sdd-update` 不再有一个"注定失败的分支"；测试少 8 个与拷贝实现耦合的用例。

**改法 B（若坚持保留自更新）**
- 安装期写入 `.dsh-sdd-kit-provenance.json`（origin / ref / commit / version / installedAt），更新从 provenance 推导源，而不是要人传路径。
- allowlist 从 `package.json.files` 派生（读它，不再抄它）。
- swap 改为"写 pending 标记 + 下次启动时切换"，因为运行中替换必然不安全。

**验收**：`src/` ≤ 720 行；`update_all` 返回的 `components` 只有 2 项且无 `dshKitSourceDir` 参数；README 只剩一条升级路径。

> 注：这条要动章程原则 I、V 的措辞（"profile 副本刷新 MUST 报告重启"），属拥有者决策的 MAJOR 修订，评审只提出判定。

---

### P0-2 同一事实被声明三处

| 事实 | 声明点 | 现实 |
|---|---|---|
| EARS 模板 | `overrides/spec-template.md` 与 `.specify/templates/overrides/spec-template.md` | 实测 sha256 完全相同（`6F598F1B…`），后者是前者的安装产物，却一起入库 |
| 扩展元数据 | `HOOKS_EXTENSION` / `HOOKS_EXTENSION_EVENTS` 常量 与 `spec-kit-extension/extension.yml` | `plan.md` 明写"用常量避免 YAML 解析"，靠一条文本断言把两者粘住 |
| 打包白名单 | `package.json.files` / `KIT_ALLOWLIST` / 测试夹具 | 三处，缺一处就丢文件（`tasks.md` T002/T003/T004 三次提醒同一件事） |

**判定**：零分叉的判据不是"没抄上游逻辑"，而是"**同一事实只有一个可编辑的地方**"。现在每个事实都有两到三个编辑点，漂移只是时间问题——`T003`/`T004` 的存在就是漂移已经发生过的化石。

**改法**
- 模板只保留 `overrides/spec-template.md` 作为源；`.specify/templates/overrides/` 是安装产物，`gitignore` 掉（dogfood 需要时由 `/sdd-setup` 幂等生成）。
- `extension.yml` 为唯一源；用一个 20 行、零依赖的构建脚本（按固定键做行解析，不引 YAML 库）生成 `src/generated/extension-meta.mjs`；CI 加一条"生成物与源一致"的测试（`git diff --exit-code`）。这既满足"不引 YAML 依赖"，也满足"不维护两份"。
- 白名单只留 `package.json.files`；若采纳 P0-1 则其中两份自然消失。

**验收**：`grep -rn "superpowers-hooks" src/` 只命中生成文件；重新生成后 `git diff --exit-code` 为空；`git ls-files | grep overrides` 只有一处。

---

### P0-3 仓库在作者自己的机器上是红的

**证据**：见第二节。3 fail / 4 skip，且 release note 声称 38/38。

**判定**：产品代码没有回归，但**契约测试对平台过敏**，而项目没有把平台写进契约。对一个把"证据"写进章程的项目，这属于证据链断裂——你在 Linux 拿到的绿灯，不能在 Windows 上代表同一件事。

**改法**
- 加 `.gitattributes`：`* text=auto eol=lf`（至少 `*.md eol=lf`）。
- 换行锚定的断言改为 `/^---\r?\ndescription: \S.*\r?\n---\r?\n/`，或干脆不锚定换行（契约关心结构，不关心字节）。
- symlink 用例：捕获 EPERM 后 `t.skip('Windows requires developer mode for symlinks')`；或改用 junction。
- CI 至少两平台（Linux + Windows）；`specify` 缺失时 skip 必须写明原因（现在写了，好）。
- README 增加"支持矩阵"：POSIX（Linux/macOS/WSL）为一级，Windows 原生未验证（`.specify/scripts/` 只有 bash 版本，无 `.ps1`）。

**验收**：两平台 `npm test` 均 0 fail；`git ls-files --eol` 全为 `i/lf w/lf`。

---

## 五、P1：结构性问题

### P1-1 12 个动作挤进 2 个工具：schema 已经变成 CLI

`sdd_upstream` 8 个动作、`sdd_bridge` 4 个动作，共 **15 个可选参数**。这些动作跨三个域：

- **读环境**（`status`，只读、可并发）
- **改机器全局**（`specify_upgrade` → `uv tool install`，`sync_superpowers` → clone 到 `~/.dsh`）
- **改当前仓库**（`specify_init`、`install_bug_ext`、`install_hooks_ext`、`switch_integration`、`install_overrides`）
- **改当前分支内容**（`check_task`、`sync_index`）

`action` 判别器加 15 个可选参数，等于把一个 CLI 塞进一个函数签名：`featureName` 只对 `check_task` 有意义，`extensionDir` 只对 `install_hooks_ext` 有意义，`taskMatch` 与 `bugSlug` 互斥——这些约束在 schema 里**全部不可表达**，只能在运行时撞墙。模型要记住"哪个动作要哪些参数"，而它没有可靠的记忆。

另外，`force` 参数自述 "Deprecated/no-op"，却还挂在 schema 上。**死接口比没有接口更糟**：模型会以为它有用。

**改法（按收益排序）**
1. **读与写分离**：新增只读工具 `sdd_doctor`（`status` + 模板漂移 + 扩展安装态 + integration + pending-restart），永久并发安全、永远可先调。写入动作留在现在的位置。
2. **每个动作自己校验参数**，非法组合返回 `E_ARGS` 而不是让底层命令报错。
3. 删 `force`；`useSkills` 若只为兼容旧 spec-kit，明确标注弃用期限或直接删。

**验收**：`sdd_doctor` 不含任何 spawn 写操作；缺参/非法组合返回 `E_ARGS` 且不产生副作用；schema 中不再有自认 no-op 的参数。

---

### P1-2 控制流住在 markdown 里

`sdd-setup/SKILL.md` 是一个**有分支的状态机**：`hasSpecifyDir` 决定是否 init、同步失败要"继续 3–7 步"、`integrationMismatch` 只在显式 opt-in 时才切换、第 7 步要求报告 5 类字段。它靠一段散文让模型按顺序执行 7 步。

后果很具体：**漏步无法被检测**。`npm test` 只能断言"SKILL.md 里提到了 embed"，不能断言"用户真的装上了扩展"。于是测试退化成语料校验（见 P2-1），而真正的失败要等用户手动跑一遍才暴露。

**改法**：把状态机搬进代码——`sdd_upstream(action: "setup")` 内部按幂等顺序执行并返回：

```json
{ "ok": true, "steps": [ { "name": "sync_superpowers", "status": "skipped|performed|failed", "detail": "..." } ] }
```

技能缩到 20 行，只负责渲染 `steps`。测试从"读文档"变成"断言 steps 序列"。代码会多 ~150 行，但 P0-1 删掉 245 行，净账为负。

**验收**：二次运行全部 `skipped`（幂等）；setup 的测试断言落在 `steps` 上；`skills/sdd-setup/SKILL.md` ≤ 40 行。

---

### P1-3 `check_task` 是上游职责的平行实现

**证据**：上游生成的 `/speckit.implement` 自己就负责勾选——

`.dsh/skills/speckit-implement/SKILL.md:173`：
> For completed tasks, make sure to mark the task off as [X] in the tasks file.

而本插件又提供了 `sdd_bridge(action:"check_task")` 做同一件事（读→改→写 `tasks.md`），钩子文档再规定"勾选前必须 `npm test` 通过"。**同一协议三处声明、两个写者。**

这正是章程原则 I 说的"MUST NOT 形成并行逻辑"——它在任务进度上发生了。附带代价：一条无锁的 read-modify-write 写路径（并发 agent 下丢更新）、15 个测试断言、以及一个"两套勾选规则可能不一致"的长期隐患。

**改法**：删 `check_task`；勾选交还 `/speckit.implement`；门禁只保留在钩子提示里（"未通过 `npm test` 不得进入下一个任务"）。`inspect` 里的任务统计是只读的，保留。

**验收**：`sdd_bridge` 只剩 3 个只读/安装类动作；`grep -rn "check_task" src skills` 为空；tasks.md 只有上游一个写者。

---

### P1-4 两套错误语义

`runUpstream` 外部命令失败 → `{ok:false, code, stderr}`（不抛）；参数错误 → `throw`。
`runBridge` 业务失败 → `throw`（"No unchecked task matching…"）。
工具执行抛异常 → 模型看到的是工具层 error；返回 `ok:false` → 模型必须自己判断。

调用方（也就是模型）得同时记住两种约定，而技能文档并没有把它写清。这会在"失败后被静默忽略"的场合咬人。

**改法**：统一出口 `{ok, action, error: {code, message, hint}}`，`code` 用固定枚举（`E_ARGS` / `E_NOT_FOUND` / `E_CLI` / `E_IO`）；`hint` 直接给修复命令。`INTEGRATION_MISMATCH_NOTE` 已经是这个好模式，推广到所有失败即可。

---

### P1-5 `restartRequired` 语义分散且未经验证

三处各自决定：

- `install_hooks_ext`：恒 `false`（但刚往 `.dsh/skills/` 写了 4 个命令技能，DSH 是否重扫目录**没有验证**）
- `updateSuperpowers`：`cloned || skillCountChanged`
- `updateInstalledKit`：`changed`

三个地方、三种口径、没有一个统一策略函数。而"要不要重启"是用户唯一真正会执行的动作，错的代价是"以为装好了其实没生效"。

**改法**：单一 `restartPolicy(changeSet)` 按"改动落在哪一层（tool 代码 / skill 数据 / 扩展命令）"判定；落地为 `.dsh/sdd-kit/.pending-restart` 标记文件，启动后自检并清除——**可观测，不靠记性**。

---

## 六、P2：工程卫生

1. **测试在断言散文**。约 7 个用例读 `README.md` / `quickstart.md` 并 `assert.match` 措辞，其中"artifact line references point at the content they cite"直接绑定**行号**——任何插入一行都会红。测试应该锁行为，不锁打字。删掉行号类断言，改"文件存在 + 锚点字符串存在"；README 只保留两条真正重要的（安装 URL、升级命令）。
2. **规格体量不随变更缩放**。`specs/002` 用了 19 份文件 / 188 KB 描述"新增 4 个 markdown + 1 个 action"的变更。对比之下，`docs/superpowers/specs/2026-11-23-...-design.md` 只有 4 KB 就把同样的事说清了——**轻量通道已经存在，只是没被承认**。建议明确变更分级：跨模块/接口变更走 `specs/`，单文件微型变更走单页设计 + ADR。这需要章程 MINOR 修订（原则 II），由拥有者决定。
3. **唯一决定"插件能否加载"的路径没有冒烟测试**。`cordis.patch.yml` 用 `!!js` + `createRequire(baseUrl)` 在 YAML 里做模块解析，定位 `skills/`。它一旦解析错，表现是**整个插件不加载且无提示**。要么加一个"按真实 profile 布局加载 patch"的测试，要么在 README 写明这是单点故障并给出排查命令。
4. **`peerDependencies: "*"`**。等于宣布"任何未来的破坏性 API 变更都可以接受"。写一个你实际验证过的下界，比星号诚实。
5. **能力探测后置**。`/sdd-setup` 第 2 步才因 `uv`/`git`/`specify` 缺失报错。应在入口一次性探测 `git`/`uv`/`specify`/`bash`/symlink 并一次性列出所有缺失（这是 `sdd_doctor` 的核心价值）。
6. **`check_task` 的 read-modify-write**（若 P1-3 不采纳）：写前校验 hash/mtime，5 行代码换掉一个并发丢更新。

---

## 七、改进路线（按"删→收→决策"分批）

### 批次 1：只删（约 1 天，净减代码）

| 动作 | 文件 | 收益 |
|---|---|---|
| 删自研安装器 | `src/core/kit-copy.mjs`、`update.mjs` | −245 行、−3 份白名单、−Windows 锁风险 |
| 删 `check_task` | `bridge.mjs`、`register.mjs`、`sdd-setup` 技能 | −1 写路径、−15 断言 |
| 删文档耦合测试 | `test/sdd-kit.test.mjs` | −7 脆弱用例 |
| 删 `force` 参数、重复模板 | `register.mjs`、`.specify/templates/overrides/` | −死接口、−漂移点 |
| 加 `.gitattributes` | 仓库根 | Windows 转绿 |
| symlink 用例平台门控 | `test/sdd-kit.test.mjs` | Windows 转绿 |

**完成判据**：`src` ≤ 710 行；Linux + Windows 双平台 `npm test` 0 fail；`update_all` 只剩两层。

### 批次 2：收口（2–3 天）

- `extension.yml` → 生成 `extension-meta.mjs`，删除手写常量。
- 拆出 `sdd_doctor`（只读），写入动作统一 `E_*` 错误码。
- `setup` 状态机进代码，技能降到 40 行内。
- `restartPolicy` 单一化 + pending 标记。

**完成判据**：新增测试全部针对 `steps`/`codes`/`doctor` 输出，而不是文档；二次运行 setup 全 `skipped`。

### 批次 3：决策（需要拥有者拍板，含章程修订）

- 插件不再自更新（ADR-001）→ 修订原则 I / V。
- 原则 I 的"薄"从**数技能个数**改为**动词数 + 自研行数预算**（真正的厚度是"可调用动词 × 参数 × 自研代码"，不是"技能目录数"）。现在 2 个技能 / 12 个动词的表象，正是"指标选错"的后果。
- 变更分级（ADR-003 的配套），避免 188 KB 的规格去描述 4 个 markdown。

---

## 八、目标形态

```text
包管理器（dsh plugin / pnpm）            ← 唯一安装与升级入口，插件不自替换
        │
   dsh-sdd-kit（只读自身目录，无拷贝逻辑）
        ├── sdd_doctor      只读：环境/仓库/漂移/重启待办，永远并发安全
        └── sdd_apply       写：setup | init | ext-install | switch | overrides
                │
        specify CLI（拥有 .specify/、.dsh/skills、扩展生命周期、任务勾选）
                │
   extension.yml + 4 个 hook 命令            ← 数据，不是代码
                │
   ~/.dsh/upstream/superpowers（git 镜像）    ← 技能唯一来源，只读
```

边界规则（可作为 review checklist）：

1. 插件**不复制**上游文件到别处（只安装，不搬运）。
2. 插件**不替换**正在运行的自己。
3. 插件**不解析**上游配置（`extensions.yml`、`init-options.json` 只读已知键，或干脆交给 CLI）。
4. 插件**不维护**第二份白名单/元数据/模板。
5. 每个"事实"只有一处可编辑。

---

## 九、建议记录的 ADR（简版）

### ADR-001：取消 profile 自拷贝，安装与升级归包管理器

- **Status**：Proposed
- **Context**：`kit-copy` 用 245 行实现了一次目录级安装，与 `dsh plugin add/update` 的 pnpm 路径并行；需要人工传源路径；在运行中替换自身目录必然依赖重启。
- **Decision**：删除 `kit-copy` 与 `update_all` 的第三组件；插件自身升级只走包管理器 + 重启；若要保留可观测性，仅保留只读的"已安装版本 vs 发布版本"检查。
- **Consequences**：＋少 26% 源码、消灭三份白名单、消除 Windows 文件锁失败模式；－失去"一条命令刷新三层"的完整语义（改为"两层 + 一条外部命令"），需在 README 与 `/sdd-update` 报告里明确。
- **Alternatives**：保留但加 provenance（可接受的最小折中）；改成 pending-swap（复杂度不下于现状，收益有限）。

### ADR-002：工具面按"读/写"分离，控制流回代码

- **Status**：Proposed
- **Context**：2 个工具承载 12 个动作、15 个可选参数，跨读/改机器/改仓库三类副作用；`sdd-setup` 的 7 步分支状态机住在 markdown 里，漏步不可检测。
- **Decision**：新增只读 `sdd_doctor`；把 setup 状态机下沉为一个 `setup` 动作；统一结构化错误码。
- **Consequences**：＋行为可测、模型不必记参数矩阵；－代码量增加约 150 行（由批次 1 的净减抵消）。
- **Alternatives**：拆成 4 个按域命名的工具（更清晰，但触发章程"2 工具"上限的修订；本评审倾向于**改指标**而不是加工具）。

### ADR-003：平台支持矩阵与行尾/符号链接规范化

- **Status**：Proposed
- **Context**：仓库在 Windows 检出上 3 红 4 skip；`core.autocrlf=true` 且无 `.gitattributes`；`.specify/scripts/` 只有 bash；依赖 symlink。
- **Decision**：`.gitattributes` 统一 LF；契约断言不锚定换行；平台相关用例显式 skip 并写明理由；README 声明一级平台（POSIX）与未验证平台（Windows 原生）。
- **Consequences**：＋双平台绿、证据可迁移；－需要一次全仓 eol 规范化提交（会产生较大 diff，建议单独一个 commit）。

---

## 十、明确不做的事（防止过度设计）

- **不引 YAML 解析依赖**。清单合法性本来就该由 `specify` 校验；插件只需要"读 4 个固定键"，20 行生成脚本足够。
- **不为"未来支持 codex/claude 等其他宿主"抽象 integration 层**。现状已用"默认值 + 可覆盖参数"覆盖，再抽象就是为假想需求写代码。
- **不启用 Runtime Events 硬门禁**。软门禁 + 可核查证据（如 `.specify/evidence/<feature>.json`）成本更低、冲突更少。若将来要硬门禁，那是另一个 ADR。
- **不给历史 specs 补中文/补全**。原则 VI 已明确豁免存量。
- **不为了实现 P0-2 去引入构建流水线**。一个 `node scripts/gen-extension-meta.mjs` + 一条 diff 断言就够。
- **不要在批次 1 里顺手重构 `bridge.mjs` 的其他部分**。先让它变绿、变少。

---

## 附录：复现本评审的关键命令

```powershell
cd D:\Project\dsh-sdd-kit
npm test                                   # 43 tests, 3 fail, 4 skipped
git ls-files --eol 'spec-kit-extension/*'  # i/lf w/crlf
git config core.autocrlf                   # true（仓库无 .gitattributes）
(Get-FileHash overrides\spec-template.md).Hash -eq (Get-FileHash .specify\templates\overrides\spec-template.md).Hash  # True
(Get-ChildItem src -Recurse -File | Get-Content | Measure-Object -Line).Lines   # 955
(Get-ChildItem specs -Recurse -File | Measure-Object Length -Sum).Sum           # 188003
git ls-files | Measure-Object -ExpandProperty Count                             # 96
Select-String .dsh\skills\speckit-implement\SKILL.md -Pattern 'mark the task off'  # L173：上游自己勾选任务
```
