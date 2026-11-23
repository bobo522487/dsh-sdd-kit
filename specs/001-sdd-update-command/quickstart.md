# Quickstart: `/sdd-update`

日期：2026-11-23 | 规格：[spec.md](./spec.md) | 契约：[contracts/sdd-update.contract.md](./contracts/sdd-update.contract.md)

## What it does

`/sdd-update` 在一次非交互式调用中检查并（在需要时）刷新恰好三个工具层：

1. **Spec Kit** — 即 `specify` CLI，通过 `uv tool upgrade specify-cli` 升级（缺失时则采用固定版本的 Python 安装）。
2. **Superpowers** — 本地 `~/.dsh/upstream/superpowers` Git 镜像，通过克隆或 `git pull --ff-only` 更新。
3. **dsh-sdd-kit** — 已安装的 DSH profile 副本，通过从本地源码检出目录执行带暂存的白名单复制来刷新。

它为每个组件打印一条记录，包含 `before`、`after`、`outcome` 以及任何必需的后续操作。它绝不运行项目初始化，绝不编辑 specs/plans/tasks/应用源码，也绝不替你重启 DSH。

> 首次采用：`/sdd-update` 技能本身必须已安装在当前生效的 profile 中。对于本功能自身的上线，请将更新后的插件复制到 profile 中并重启 DSH 一次（见下文）；后续刷新即可使用该命令。

## Prerequisites

- 一个已由 `/sdd-setup` 初始化的项目。
- `specify` 与 `uv` 可用（或 `uv` 可安装）；`git` 可用。
- 第三个组件所需的本地 dsh-sdd-kit 源码检出目录，例如 `/home/bobo/Projects/dsh-sdd-kit`。
- 当上游确实需要更新时，需要网络访问。

## Run

在你项目的 DSH 会话中：

```text
/sdd-update
```

如果 DSH 无法推断路径，请在同一条消息中指明，以便技能将其转发：

```text
/sdd-update dshKitSourceDir=/home/bobo/Projects/dsh-sdd-kit
```

可选覆盖项：`cwd`、`dshProfileDir`、`superpowersDir`、`python`（默认 `3.14`）、`repoUrl`。

已安装套件的目标位置解析：

```text
$dshProfileDir/node_modules/dsh-sdd-kit
  → default $DSH_PROFILE_DIR/node_modules/dsh-sdd-kit
  → fallback ~/.dsh/profiles/${DSH_PROFILE:-web}/node_modules/dsh-sdd-kit
```

## Read the report

```text
spec-kit      before=specify 1.3.1  after=specify 1.4.0  outcome=updated
superpowers   before=86f9e18        after=9ab2c31        outcome=updated  followUp=restart
dsh-sdd-kit   before=sha256:4d1f…   after=sha256:7c0e…   outcome=updated  followUp=restart
OVERALL: success
Restart DSH to load updated tools/skills.
```

- `unchanged` — 组件已是最新；未执行任何有效更新。
- `updated` — 标识符发生变化且更新成功。
- `failed` — 该组件出错；其余两个仍会被尝试。会显示 `OVERALL: unsuccessful` 与组件名称。
- 当只有 Spec Kit CLI 发生变化时，会显示 `No restart required`。

当 profile 副本发生变化、Superpowers 首次被克隆，或 Superpowers 技能数量发生变化时，需要重启。重启是用户操作；该命令不会执行重启。

## Profile-copy safety

已安装套件的刷新通过临时暂存目录和逐条目 `fs.rename` 完成，因为已安装副本可能由与 pnpm store 硬链接的文件组成（`nlink > 1`）。就地写入会改动该共享 store，因此刷新总是先暂存一份新副本再替换进去；生成的文件具有 `nlink == 1`，不再与 store 共享存储。不要手动向 profile 副本中 `fs.writeFile`。

仅从源码检出目录复制以下条目：`src/`、`skills/`、`overrides/`、`cordis.patch.yml`、`README.md`、`LICENSE` 和 `package.json`。项目文件、`.specify/`、`specs/`、`.git/` 与应用源码绝不会被复制或删除。目标位置中已存在的白名单之外条目（例如 `UNLISTED.txt`）保持原样，暂存/备份目录在成功与失败时都会被删除。

已验证演练（临时 `DSH_PROFILE_DIR`、真实源码检出目录）：

- 首次运行：`changed: true`、`mode: "updated"`，目标位置恰好包含 `LICENSE`、`README.md`、`cordis.patch.yml`、`overrides`、`package.json`、`skills`、`src`；`node_modules/` 中只有 `dsh-sdd-kit`（没有残留的 stage/backup 目录）。
- 源码未变的第二次运行：`changed: false`、`mode: "unchanged"`、`beforeHash === afterHash`。

运维注意事项：`.modules.yaml` 可能仍锁定较旧的 `dsh-sdd-kit` tarball。之后的 `dsh plugin` 安装可能覆盖已刷新的副本；若发生这种情况，请重新运行 `/sdd-update`（或重做手动复制）并重启 DSH。

## Manual profile copy (first adoption / recovery)

从源码检出目录执行：

已安装副本中的文件可能与 pnpm store 共享存储（`nlink > 1`）。就地写入（例如 `cp -R` 覆盖同名文件）会顺着硬链接改动 store 中的共享内容，因此下面的流程始终先在暂存目录中构建新副本，再用 `mv` 逐条目换入。它绝不递归删除目标条目，也绝不在目标目录内原地写文件。

```bash
# Run from the dsh-sdd-kit source checkout.
PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
DEST="$PROFILE_DIR/node_modules/dsh-sdd-kit"
ENTRIES="src skills overrides cordis.patch.yml README.md LICENSE package.json"

# 1. Stage a fresh copy next to the destination (same filesystem, so mv is atomic).
STAGE="$(mktemp -d "$PROFILE_DIR/node_modules/.dsh-sdd-kit-stage-XXXXXX")"
for entry in $ENTRIES; do
  cp -R "$entry" "$STAGE/$entry"
done

# 2. Move the current entries aside, then move the staged ones in.
BACKUP="$(mktemp -d "$PROFILE_DIR/node_modules/.dsh-sdd-kit-backup-XXXXXX")"
for entry in $ENTRIES; do
  if [ -e "$DEST/$entry" ]; then mv "$DEST/$entry" "$BACKUP/$entry"; fi
  mv "$STAGE/$entry" "$DEST/$entry"
done

# 3. Confirm the copy looks right, then discard the staging and backup directories.
#    Deleting the backup only drops the extra hardlink; the pnpm store keeps its own.
ls "$DEST"
rm -r "$STAGE" "$BACKUP"

# 4. Restart DSH so tools/skills reload.
```

若 `mv` 中途失败，可把 `$BACKUP` 中的条目移回 `$DEST`，再排查权限或符号链接问题。安装完成后，日常刷新请直接运行 `/sdd-update`：它执行同样的暂存加重命名流程，并额外报告每个组件的 `before → after`。

## Troubleshooting

| 现象 | 处理 |
| :--- | :--- |
| `No dsh-sdd-kit source configured` | 传入 `dshKitSourceDir=/path/to/checkout`，或修正技能传入的参数。Spec Kit 与 Superpowers 的结果仍会显示。 |
| `Unable to read Spec Kit version` | 确认 `specify` 在 PATH 中且 `uv` 能管理工具；然后重新运行。 |
| `Superpowers update failed` | 检查访问 `https://github.com/obra/superpowers.git` 的网络与 Git 凭据；其余组件仍会被尝试。 |
| `dsh-sdd-kit profile copy failed` | 检查 `$DSH_PROFILE_DIR/node_modules` 的写权限，移除白名单源码条目中的符号链接，然后重新运行。不要删除整个 profile 目录。 |
| 成功之后技能/工具看起来仍是旧的 | 重启 DSH；报告中的 `followUp` 行会告诉你何时需要这样做。 |
| 项目 specs/tasks 意外发生变化 | 并非本命令所致；它没有任何写入 `cwd` 的路径。请核查 `/sdd-setup` 或 `/sdd-implement` 等其他命令。 |

## Related artifacts

- 决策记录：[research.md](./research.md)
- 数据形状：[data-model.md](./data-model.md)
- 完整实现计划：[plan.md](./plan.md)
