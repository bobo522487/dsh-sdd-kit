---
name: sdd-setup
description: Bootstrap or upgrade upstream GitHub Spec Kit (specify CLI + bug extension) and obra/superpowers mirror (~/.dsh/upstream/superpowers), then install EARS + Non-Goals template overrides in the current repository.
disable-model-invocation: true
---

# /sdd-setup

One-command bootstrap and upgrade for the **Spec Kit (what) × Superpowers (how)** stack — zero reimplementation of upstream tools.

## Workflow

1. **Check upstream health**: Call `sdd_upstream(action: "status")` and `sdd_bridge(action: "inspect")`.
2. **Sync upstream `obra/superpowers`**:
   - Call `sdd_upstream(action: "sync_superpowers")` to clone or `git pull --ff-only` `~/.dsh/upstream/superpowers`.
   - Remind the user to restart DSH once if this was the first clone (so the `superpowers-upstream` skill provider picks up all upstream skills).
3. **Install or upgrade `specify-cli`**:
   - If `specifyCli.installed` is `false` (or the user asked to upgrade), call `sdd_upstream(action: "specify_upgrade")`.
   - If `uv` is missing, tell the user cleanly how to install `uv` and stop without guessing.
4. **Initialize repository with Spec Kit**:
   - If `hasSpecifyDir` is `false`, call `sdd_upstream(action: "specify_init")` (runs `specify init --here --integration claude --integration-options=--skills`).
   - Install Spec Kit's official bug-fixing extension by calling `sdd_upstream(action: "install_bug_ext")` (`specify extension add bug`).
5. **Install EARS + Non-Goals override**:
   - Call `sdd_bridge(action: "install_overrides")` to place `.specify/templates/overrides/spec-template.md` (highest precedence in Spec Kit; preserved across `specify-cli` upgrades).
6. **Summary & Next Step**:
   - Report versions/status concisely.
   - If `.specify/memory/constitution.md` does not exist yet, invite the user to run Spec Kit's native `/speckit.constitution` next.
