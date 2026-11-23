# dsh-sdd-kit

> **零分叉，薄胶水（Zero Fork, Thin Glue）。**
> 面向 **DeepSeek Harness（DSH）** 的极简 SDD 桥接插件：
> **GitHub Spec Kit** 决定*做什么*（`specify` CLI），**obra/superpowers** 决定*怎么做*（实时 Git 镜像），**`dsh-sdd-kit`** 用 **3 个技能 + 2 个薄 Host 工具**把两者粘合起来。

## 为什么采用这种架构？

- **可升级（Upgrade-Proof）**：从不重新实现 Spec Kit 或 Superpowers。随时运行 `/sdd-setup` 即可 `uv tool upgrade specify-cli` 并 `git pull` `~/.dsh/upstream/superpowers`。
- **SDD 生态最佳组合（零侵入）**：
  - **Spec Kit**：章程、`specify → clarify → plan → tasks → analyze → converge`，以及官方 `specify extension add bug`。
  - **Superpowers**：严格 TDD（Red → Green → Refactor）、系统化调试、完成前验证，以及两阶段代码评审。
  - **Kiro / cc-sdd**：通过 Spec Kit 官方 `.specify/templates/overrides/spec-template.md` 注入 EARS 验收语法（`WHEN ... THE SYSTEM SHALL ...`）与强制的 **Non-Goals**。
  - **GSD**：干净上下文的执行纪律 + 直接在当前分支上按任务原子 `git commit`。
  - **OpenSpec**：自动维护 `specs/INDEX.md` 活文档，便于在存量项目中保持可见性。

## 安装到 DSH

从 GitHub 安装（推送本仓库之后）：

```bash
# Web profile
dsh plugin --profile web add https://github.com/<your-username>/dsh-sdd-kit

# Desktop profile
dsh plugin --profile desktop add https://github.com/<your-username>/dsh-sdd-kit
```

或从本地 `.tgz` 压缩包安装：

```bash
dsh plugin --profile web add ./dsh-sdd-kit-0.3.0.tgz
```

安装后重启 DSH，然后在项目中运行 `/sdd-setup`。

## 日常流程

1. **初始化 / 升级**：`/sdd-setup`（同步 `~/.dsh/upstream/superpowers`、检查或升级 `specify-cli`、执行 `specify init --here` 与 `specify extension add bug`、安装 EARS/Non-Goals 模板覆盖）。init 以无人值守方式运行，跳过 agent 工具检查，并为安装固定稳定 Python。
2. **刷新全部三层**：`/sdd-update` 在一次调用中检查并更新三层——`specify-cli`、`~/.dsh/upstream/superpowers` 镜像，以及安装在当前 DSH profile 中的 dsh-sdd-kit 副本——并输出每个组件的 `before → after` 报告与所需的重启提示。若本地检出无法被自动发现，请传入 `dshKitSourceDir=/path/to/dsh-sdd-kit`。
3. **开发特性**：
   - 用原生 Spec Kit 规划：`/speckit.constitution` → `/speckit.specify` → `/speckit.clarify` → `/speckit.plan` → `/speckit.tasks` → `/speckit.analyze`
   - 用 `/sdd-implement` 执行（全流程严格 TDD + 在当前分支上按任务原子提交 → 原生 `/speckit.converge` + 同步 `specs/INDEX.md`）。
4. **修复缺陷**：
   - 用原生 Spec Kit 评估：`/speckit-bug-assess "<symptom>" slug=<slug>`
   - 用 `/sdd-implement bug=<slug>` 修复与验证（上游 Superpowers 调试 + 严格 TDD + 原子提交 → 原生 `/speckit-bug-test slug=<slug>` 直至 `verified`）。

## 本地测试

```bash
npm test
```
