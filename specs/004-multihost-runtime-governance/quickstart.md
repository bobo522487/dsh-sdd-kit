# 快速验证指南：跨宿主 SDD 运行时治理层

> 本指南给出可运行的端到端验证场景；实现细节见 `data-model.md` 与 `contracts/`。
> 里程碑 M1~M4 按 spec §2.H 前置验证门槛推进；平台受限用例显式 skip 并注明原因。

## 前置条件

- Node >=18、npm、`npx uv`（上游 specify CLI）、`git`。
- `npm test` 全绿（基线 91/91，具体数不固定）。
- 四端验证需要对应宿主运行时；缺失时该项标记 skip 并在报告注明，不计为失败。

## 场景 1：核心纯度与 DSH 回归（AC-01、AC-02、AC-22）

```bash
npm test -- --test-name-pattern="core purity|adapters|regression"
```
预期：`src/core/` 静态扫描无宿主引用（AC-01）；注入一条宿主引用时测试变红（AC-01）；逐个适配实现 ≤100 行且无业务判定（AC-02）；既有工具输入/输出字段与成功失败语义逐项一致，新增字段为增量（AC-22）。

## 场景 2：统一 CLI 与宿主工具同构（AC-03、AC-04）

```bash
node bin/sdd-kit.mjs doctor --json > cli-doctor.json
# 经宿主工具 sdd_upstream({action:'doctor'}) 得到 host-doctor.json
diff <(jq -S . cli-doctor.json) <(jq -S . host-doctor.json)
```
预期：结构 100% 一致；CLI 在无宿主运行时可独立运行（AC-03）。新增第二个宿主适配后核心用例全部保持通过且未修改（AC-04）。

## 场景 3：引导常驻、预算与开关（AC-05、AC-06、AC-07、AC-08）

```bash
npm test -- --test-name-pattern="guidance"
```
预期：拼装含上游原文、工具映射、SDD 指针且 ≤1200 tok，模拟压缩后仍存在（AC-05）；替换超长正文后仅裁 SDD 指针、正文完整、记录超限告警（AC-06）；删除上游镜像目录后插件照常加载、引导静默缺席并留告警、体检环境区报失败并给修复命令（AC-07）；关闭开关后常驻段消失且技能目录与可用性不受影响，项目级覆盖全局级、体检报告生效层级与来源，两宿主文案逐字一致且无第二份文案源（AC-08）。开关验证用两级既有配置文件的增量键：项目级写 `<repo>/.specify/sdd-kit.json` 的 `guidance.enabled=false`，全局级写 `~/.dsh/sdd-kit.json`（测试用临时 HOME 覆盖），断言仓库内不出现独立的开关文件或状态文件。

## 场景 4：三态重载与待生效标记（AC-09、AC-10）

```bash
npm test -- --test-name-pattern="reload|pending marker"
```
预期：同一改动集在三类宿主得到「重启宿主 / 新开会话 / 无需动作」对应结论，空改动集给出无需动作且不落盘（AC-09）；标记含 layer/timestamp/reason/host，宿主启动仅清当前仓库当前 host 条目、其他条目保留，历史残留按时间戳判为历史而非本次，同仓库两端各有标记时同时可见（AC-10）。

## 场景 5：依赖下界与规划期护栏（AC-13、AC-14）

```bash
# 在临时 specify 项目内把 requires.speckit_version 改为 >=99.0.0 后安装
specify extension add --dev ./spec-kit-extension
# 预期：安装期失败、退出码 1、无半装产物；恢复 >=1.4.0 后通过
npm test -- --test-name-pattern="guard|compatibility"
```
预期：下界以下安装期即失败并报所需版本，无半装产物；以下界本身安装通过，预发布版本得到确定结论而非静默放行（AC-14）。规划期护栏只读拦截已勾选 tasks.md 的 feature，仅存在未勾选 tasks.md 时不拦截，断言无文件变更、无状态文件（AC-13）。

## 场景 6：Claude Code 适配（AC-15）

```bash
npm test -- --test-name-pattern="adapters"
```
预期：Claude 端等价更新与体检产出与 DSH 一致的结构；未装纪律技能插件时降级为一句安装提示，宿主其余功能可用（AC-15）。

## 场景 7：Codex 与 Cursor 适配（AC-16、AC-17）

```bash
npm test -- --test-name-pattern="adapters|cursor"
```
预期：两端以各自原生调用前缀与技能目录完成三面动作，适配实现各 ≤100 行（AC-16）；配置自动信任类派发参数后体检宿主区显式告警并提示仅限受控项目，插件默认写入配置不含该参数（AC-17）。

## 场景 8：四端共存与钩子等价（AC-12）

```bash
specify integration install dsh
specify integration install claude
specify integration install cursor-agent
specify integration install codex
specify integration use <key>   # 激活以获得扩展命令（实测：仅 active 端渲染钩子）
```
预期：四个执行钩子在该端激活后等价生效；把某端安装但保持非激活（`specify integration list` 显示已装、`Default integration` 指向别端）时，体检如实报告该端钩子命令未渲染而非报成功，且插件不自行写入第二套钩子配置（AC-12）；同一仓库多集成共存时各端技能产物互不覆盖，体检同时识别全部已装集成。

实测矩阵（specify 1.4.4.dev0，本机 2026-11-24；`hooks` 列统计含 `superpowers-hooks` 的目录数，共 6 个扩展命令）：

| 状态 | `.dsh/skills` | `.claude/skills` | `.cursor/skills` | `.agents/skills` |
|---|---|---|---|---|
| 四端依次 install，active=dsh | 15 / hooks 6 | 9 / hooks 0 | 9 / hooks 0 | 9 / hooks 0 |
| `switch claude --trust-integration` | 15 / hooks 6 | 15 / hooks 6 | 9 / hooks 0 | 9 / hooks 0 |

结论：扩展命令只在「曾成为 active」的端渲染（dsh 是 init 时的 active，故保留 6 个）；`switch` 不给其他端补渲染，切走也不清理原端。体检须按此真实状态报告，不得把非 active 端报成「钩子已生效」。

## 场景 9：五区体检与触发试跑（AC-18、AC-19）

```bash
node bin/sdd-kit.mjs doctor --json --trigger "修复登录崩溃"
```
预期：五区齐备、缺失依赖一次性列全并附修复命令，仓库区报模板漂移与技能完整性，运行时区报冲突与待生效标记，重复执行结果一致且无任何文件变更，单次体检在 5 秒内完成（AC-18）；宿主区报当前宿主/集成键/扩展状态/纪律技能渠道版本，触发试跑返回已挂载插件与用户级技能的排序候选且未执行任何技能，构造两个同分技能时顺序按技能名再按提供者名稳定、重复两次逐字相同，不可被用户直接调用的技能被标注排除而零分技能仍列出，镜像缺失时该区仍返回结果不判失败（AC-19）。

## 场景 10：回归矩阵（AC-20）

- CI 每日 cron 已存在（`.github/workflows/upstream-integration.yml`）；扩展矩阵覆盖上游维度（最新主干/锁定 Spec Kit/锁定纪律技能镜像）× 宿主维度（DSH + Claude Code，四端阶段扩至四端），每组合执行安装 → 初始化 → 体检冒烟；人为引入破坏性上游变更时矩阵在合并前变红并指出漂移点；无网络环境报告「未执行」而非通过（AC-20）。

## 场景 11：止损与零分叉（AC-21、AC-23）

```bash
npm test -- --test-name-pattern="guard|boundary"
```
预期：模拟前置最小验证失败（如引导通道在打包形态不可达）时不进入该里程碑并按止损线降级，其余功能保持可用（AC-21）；在含用户自建普通技能的仓库初始化后不改写、不迁移、不删除该技能，体检标注为非本套件产物，仓库内无上游逻辑复制品（AC-23）。
