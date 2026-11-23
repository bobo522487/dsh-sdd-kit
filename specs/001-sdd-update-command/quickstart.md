# Quickstart: `/sdd-update`

Date: 2026-11-23 | Spec: [spec.md](./spec.md) | Contract: [contracts/sdd-update.contract.md](./contracts/sdd-update.contract.md)

## What it does

`/sdd-update` checks and, when needed, refreshes exactly three tooling layers in one non-interactive invocation:

1. **Spec Kit** — the `specify` CLI, via `uv tool upgrade specify-cli` (or a pinned-Python install when missing).
2. **Superpowers** — the local `~/.dsh/upstream/superpowers` Git mirror, via clone or `git pull --ff-only`.
3. **dsh-sdd-kit** — the installed DSH profile copy, via a staged, allowlisted copy from your local source checkout.

It prints one record per component with `before`, `after`, `outcome`, and any required follow-up. It never runs project initialization, never edits specs/plans/tasks/application source, and never restarts DSH for you.

> First adoption: the `/sdd-update` skill itself must already be installed in the active profile. For this feature's own rollout, copy the updated plugin into the profile and restart DSH once (see below); subsequent refreshes can use the command.

## Prerequisites

- A project already initialized by `/sdd-setup`.
- `specify` and `uv` available (or `uv` installable); `git` available.
- A local dsh-sdd-kit source checkout for the third component, e.g. `/home/bobo/Projects/dsh-sdd-kit`.
- Network access when an upstream actually needs updating.

## Run

In the DSH chat for your project:

```text
/sdd-update
```

If DSH cannot infer paths, name them in the same message so the skill forwards them:

```text
/sdd-update dshKitSourceDir=/home/bobo/Projects/dsh-sdd-kit
```

Optional overrides: `cwd`, `dshProfileDir`, `superpowersDir`, `python` (default `3.14`), `repoUrl`.

Destination resolution for the installed kit:

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

- `unchanged` — component already current; no effective update was performed.
- `updated` — identifier changed and the update succeeded.
- `failed` — that component errored; the other two were still attempted. `OVERALL: unsuccessful` and the component name are shown.
- `No restart required` appears when only the Spec Kit CLI changed.

A restart is required when the profile copy changed, Superpowers was cloned for the first time, or the Superpowers skill count changed. Restart is a user action; the command does not perform it.

## Profile-copy safety

The installed kit is refreshed through a temporary staging directory and per-entry `fs.rename`, because an installed copy may consist of files hardlinked to the pnpm store (`nlink > 1`). Writing in place would mutate that shared store, so the refresh always stages a fresh copy and swaps it in; the resulting files have `nlink == 1` and no longer share storage with the store. Do not manually `fs.writeFile` into the profile copy.

Only these entries are copied from the source checkout: `src/`, `skills/`, `overrides/`, `cordis.patch.yml`, `README.md`, `LICENSE`, and `package.json`. Project files, `.specify/`, `specs/`, `.git/` and application source are never copied or deleted. Entries outside the allowlist that already exist in the destination (for example `UNLISTED.txt`) are left untouched, and the staging/backup directories are removed on both success and failure.

Verified drill (temp `DSH_PROFILE_DIR`, real source checkout):

- first run: `changed: true`, `mode: "updated"`, destination contains exactly `LICENSE`, `README.md`, `cordis.patch.yml`, `overrides`, `package.json`, `skills`, `src`; `node_modules/` holds only `dsh-sdd-kit` (no leftover stage/backup dirs).
- second run with an unchanged source: `changed: false`, `mode: "unchanged"`, `beforeHash === afterHash`.

Operational caveat: `.modules.yaml` may still pin an older `dsh-sdd-kit` tarball. A later `dsh plugin` install can overwrite the refreshed copy; if that happens, rerun `/sdd-update` (or redo the manual copy) and restart DSH.

## Manual profile copy (first adoption / recovery)

From the source checkout:

```bash
# Adjust profile name if needed
PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
DEST="$PROFILE_DIR/node_modules/dsh-sdd-kit"

# Example: copy the packaged payload without touching .git/specs/.specify
for entry in src skills overrides cordis.patch.yml README.md LICENSE package.json; do
  rm -rf "$DEST/$entry"
  cp -R "$entry" "$DEST/$entry"
done

# Then restart DSH so tools/skills reload.
```

For a hardlink-safe automated refresh, prefer running `/sdd-update` after it is installed; it stages and renames instead of writing in place.

## Troubleshooting

| Symptom | Action |
| :--- | :--- |
| `No dsh-sdd-kit source configured` | Pass `dshKitSourceDir=/path/to/checkout` or fix the argument passed by the skill. Spec Kit and Superpowers results are still shown. |
| `Unable to read Spec Kit version` | Confirm `specify` is on PATH and `uv` can manage tools; rerun. |
| `Superpowers update failed` | Check network access and Git credentials for `https://github.com/obra/superpowers.git`; the other components were still attempted. |
| `dsh-sdd-kit profile copy failed` | Check write permission on `$DSH_PROFILE_DIR/node_modules`, remove symlinks from the allowlisted source entries, and rerun. Do not delete the whole profile directory. |
| Skills/tooling look stale after success | Restart DSH; the report's `followUp` line tells you when this is required. |
| Project specs/tasks changed unexpectedly | Not caused by this command; it has no write path into `cwd`. Verify other commands such as `/sdd-setup` or `/sdd-implement`. |

## Related artifacts

- Decision record: [research.md](./research.md)
- Data shapes: [data-model.md](./data-model.md)
- Full implementation plan: [plan.md](./plan.md)
