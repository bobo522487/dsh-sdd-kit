# sdd-setup upstream command hardening — design

Date: 2026-11-23
Scope: small change (3 tool actions + docs + tests + reinstall into profile)

## Intent / why

Running `/sdd-setup` in this environment hit 3 reproducible failures plus 1 dormant
risk. All four originate in the plugin's own generated commands, not in the
environment, so a fresh run reproduces them every time. The user wants future
`/sdd-setup` runs to just work without remembering manual flags.

## Pitfalls (root cause → fix)

1. Non-empty dir hangs on `[y/N]`. `specify_init` only adds `--force` when the
   caller passes `force:true`, and never adds `--non-interactive`; the skill calls
   it with neither. Fix: always add `--non-interactive` and `--force` by default.
2. "claude not found" agent check. This machine runs DSH, not Claude Code.
   Fix: always add `--ignore-agent-tools` by default.
3. Deprecated `--integration-options=--skills`. New spec-kit (v1.4.4.dev0) removed
   the `--skills` value; claude integration installs skills by default now.
   Fix: stop emitting it by default. Keep an opt-in `useSkills:true` path that,
   when explicitly requested, still emits the old flag (for older spec-kit).
4. (dormant) `specify_upgrade` uses bare `uv tool install`, which on this machine
   selects Python 3.16.0a2 (alpha) → no wheels → source build → missing `ffi.h`.
   Fix: add an optional `python` argument (default `3.14`, the installed stable
   interpreter) and pass `--python <value>` on the install path. Upgrade path
   (`uv tool upgrade`) is left unchanged (it reuses the existing env).

## Goals / non-goals / anti-goals

- Goals: default `sdd_upstream` actions generate commands that succeed on a
  current spec-kit + DSH (non-Claude) setup; tests pin the new behavior.
- Non-goals: not upgrading spec-kit version pinning; not changing bridge behavior.
- Anti-goals: do not reintroduce reimplementation of upstream tools; do not
  hardcode a version-specific path that breaks on other machines — `python` is
  an overridable argument, not a constant.

## Constraints

- Node >=18, ESM, no new deps.
- Installed profile copy is a plain directory copy (not symlink) at
  `/home/bobo/.dsh/profiles/web/node_modules/dsh-sdd-kit` — must be re-copied.
- New tool code needs a DSH restart to load (can't restart host from this session).

## Approach chosen

Single approach: harden `runUpstream` defaults in `src/core/upstream.mjs`, adjust
the tool parameter docs in `src/register.mjs`, update `skills/sdd-setup/SKILL.md`
narrative, and update the assertions in `test/sdd-kit.test.mjs`. Alternatives
(leave plugin broken + remember flags; docs-only note) were rejected by the user
because they don't stop recurrence.

## Detailed changes

- `src/core/upstream.mjs` `specify_init`: build cliArgs as
  `['init','--here','--integration',integration,'--non-interactive','--force','--ignore-agent-tools']`;
  append `--integration-options=--skills` only when `args.useSkills === true`.
- `src/core/upstream.mjs` `specify_upgrade`: read `const python = args.python || '3.14'`;
  on install path append `['--python', python]`; keep upgrade path as-is; include
  resolved python in the returned `command` string.
- `src/register.mjs`: update descriptions for `useSkills` (opt-in, default false),
  `force` (now default true — mark deprecated/no-op), add `python` param.
- `skills/sdd-setup/SKILL.md:21`: describe the new default flags; mention the
  `python` override and that skills are default in new spec-kit.
- `test/sdd-kit.test.mjs:40-42`: assert init call includes `--non-interactive`,
  `--force`, `--ignore-agent-tools`, and does NOT include `--integration-options=--skills`
  by default; add an upgrade-install assertion that `--python 3.14` is passed.

## Reinstall / verification

1. `npm test` in source — all tests pass.
2. Copy changed `src/`, `skills/`, `README.md` into profile node_modules copy
   (or rebuild tgz + `dsh plugin ... add`), preserve everything else.
3. Verify installed copy diff matches source for changed files.
4. Report that a DSH restart is required to load the new tool code; do not restart
   host from inside the session.
