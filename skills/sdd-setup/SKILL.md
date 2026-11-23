---
name: sdd-setup
description: Bootstrap or upgrade upstream GitHub Spec Kit (specify CLI + bug extension + Superpowers hooks extension) and obra/superpowers mirror (~/.dsh/upstream/superpowers), then install EARS + Non-Goals template overrides in the current repository.
disable-model-invocation: true
---

# /sdd-setup

One-command bootstrap and upgrade for the **Spec Kit (what) × Superpowers (how)** stack — zero reimplementation of upstream tools.

## Workflow

1. **Check upstream health**: Call `sdd_upstream(action: "status")` and `sdd_bridge(action: "inspect")`.
2. **Sync upstream `obra/superpowers`**:
   - Call `sdd_upstream(action: "sync_superpowers")` to clone or `git pull --ff-only` `~/.dsh/upstream/superpowers`.
   - Remind the user to restart DSH once if this was the first clone (so the `superpowers-upstream` skill provider picks up all upstream skills).
   - If the sync fails, continue with steps 3–7 anyway (REQ-11): the extension install is independent of the mirror. In the summary, state the sync failure explicitly and warn that each hook will fail closed at `REQ-06` until the mirror is restored.
3. **Install or upgrade `specify-cli`**:
   - If `specifyCli.installed` is `false` (or the user asked to upgrade), call `sdd_upstream(action: "specify_upgrade")`. Fresh installs pin a stable Python (`3.14` default, overridable via `python`) to avoid source-building on alpha interpreters.
   - If `uv` is missing, tell the user cleanly how to install `uv` and stop without guessing.
4. **Initialize repository with Spec Kit** (only when `hasSpecifyDir` is `false`):
   - Call `sdd_upstream(action: "specify_init")`. It passes `--integration dsh --non-interactive --force --ignore-agent-tools`, so generated skills land in `.dsh/skills` inside the DSH default skill roots.
   - Never re-run `specify init` when `hasSpecifyDir` is `true`: an existing project keeps its layout (REQ-15).
   - Install Spec Kit's official bug-fixing extension by calling `sdd_upstream(action: "install_bug_ext")` (`specify extension add bug`).
5. **Install the bundled Superpowers hooks extension**:
   - Call `sdd_upstream(action: "install_hooks_ext")`. It delegates once to `specify extension add --dev <bundled spec-kit-extension> --force` and returns the report described in `data-model.md` E4.
   - Read back `ok`, `integration`, `skillsDir`, `skillsDirInDshRoots`, `integrationMismatch`, `hooks`. Do not parse `.specify/extensions.yml` yourself.
   - **Explicit opt-in switch (REQ-16)**: only when the user explicitly asks to switch (they pass `switchIntegration: true` to this skill or say "switch to dsh"), and `integrationMismatch` is not `null`, call `sdd_upstream(action: "switch_integration")`. Verify its post-switch report has `integration: "dsh"` and `skillsDirInDshRoots: true`, then repeat step 5 so the four command skills are regenerated into `.dsh/skills`. The switch itself preserves `.specify/extensions.yml`, templates and scripts; no reinstall of the extension is lost by switching.
   - Otherwise (the default path) report only — never run the switch yourself. Repeating `/sdd-setup` without the explicit opt-in will never change the integration.
6. **Install EARS + Non-Goals override**:
   - Call `sdd_bridge(action: "install_overrides")` to place `.specify/templates/overrides/spec-template.md` (highest precedence in Spec Kit; preserved across `specify-cli` upgrades).
7. **Summary & Next Step**:
   - Report versions/status concisely.
   - The extension section must state: extension id and version, the four hook events (`before_implement`, `after_implement`, `before_bug_fix`, `after_bug_fix`), the active `integration`, and the skill directory the commands were written to. Add the restart reminder only when the report says it is needed.
   - When `integrationMismatch` is not `null`, append a short warning: this project is on `integration=<current>`, so the hook commands landed in `<skillsDir>` and are **not** inside the DSH default skill roots. Tell the user that an explicit opt-in is required: pass `switchIntegration: true` to `/sdd-setup` (or ask to "switch to dsh"), which calls `sdd_upstream(action: "switch_integration")` → `specify integration switch dsh`. State its scope: unmodified generated files are replaced, locally modified ones are preserved, and `.specify/extensions.yml`, `.specify/templates`, `.specify/scripts` are untouched. On the default path, report only — never run the switch yourself.
   - If `.specify/memory/constitution.md` does not exist yet, invite the user to run Spec Kit's native `/speckit.constitution` next.
