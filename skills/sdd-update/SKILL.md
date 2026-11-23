---
name: sdd-update
description: Check and update Spec Kit, Superpowers, and the installed dsh-sdd-kit in one invocation with a per-component before/after report.
disable-model-invocation: true
---

# /sdd-update

One-command refresh for the three parts of the stack — upstream Spec Kit (`specify` CLI), the local `obra/superpowers` mirror, and the dsh-sdd-kit plugin installed in the active DSH profile. The skill is declarative: it delegates once and renders the result. It performs no update logic itself.

## Workflow

1. **Collect optional arguments** only when the user supplied them explicitly:
   - `dshKitSourceDir`: local dsh-sdd-kit checkout to copy into the profile. Omit when the user did not name one — the report will then show a clear `dsh-sdd-kit` failure while still updating the other two.
   - `dshProfileDir`: profile root (defaults to `$DSH_PROFILE_DIR`, then `~/.dsh/profiles/${DSH_PROFILE:-web}`).
   - `superpowersDir`, `repoUrl`, `python`, `cwd`: forward only if the user gave them.
2. **Delegate exactly once**:
   `sdd_upstream(action: "update_all", ...)` — the only call in this workflow. Do not call any other `sdd_upstream` action and do not call `sdd_bridge` at all.
3. **Render the report** from the returned `components` array, one line per component in the fixed order `spec-kit`, `superpowers`, `dsh-sdd-kit`:

   ```text
   <component>: <before> -> <after> [<outcome>]
   ```

   - Use `-` for a `null` `before` or `after`.
   - Append the record's `followUp` text when it is non-null.
   - Add an overall line: `Overall: ok` or `Overall: failed (<n> component(s))`, listing each entry of `errors` as `<component>: <message>`.
4. **Report required user actions**:
   - When `requiresRestart` is `true`, say plainly that DSH must be restarted before the updated tools and skills take effect.
   - Otherwise state that no restart is required.
   - Never restart DSH yourself and never prompt for confirmation.
5. **Never modify project artifacts**: `specs/`, `plan.md`, `tasks.md`, `.specify/`, and application source are out of scope. If the user asks for spec or task changes, point them at `/speckit-*` commands instead.

## Notes

- Already-current components come back as `unchanged` with identical `before`/`after`; do not retry them.
- A failed component does not stop the others; always report every record, even when `ok` is `false`.
- Field semantics are defined in `specs/001-sdd-update-command/data-model.md` and the output rules in `specs/001-sdd-update-command/contracts/sdd-update.contract.md`.
