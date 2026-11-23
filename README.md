# dsh-sdd-kit

> **Zero Fork, Thin Glue.**
> A Linus-minimalist SDD bridge plugin for **DeepSeek Harness (DSH)**:
> **GitHub Spec Kit** decides *what* to build (`specify` CLI), **obra/superpowers** decides *how* to build (live Git mirror), and **`dsh-sdd-kit`** glues them together with **2 skills + 2 thin Host tools**.

## Why This Architecture?

- **Upgrade-Proof**: Never reimplements Spec Kit or Superpowers. Run `/sdd-setup` anytime to `uv tool upgrade specify-cli` and `git pull` `~/.dsh/upstream/superpowers`.
- **Best of the SDD Ecosystem (Zero Invasion)**:
  - **Spec Kit**: Constitution, `specify → clarify → plan → tasks → analyze → converge`, plus official `specify extension add bug`.
  - **Superpowers**: Strict TDD (Red → Green → Refactor), systematic debugging, verification before completion, and 2-stage code review.
  - **Kiro / cc-sdd**: Injects EARS acceptance syntax (`WHEN ... THE SYSTEM SHALL ...`) and mandatory **Non-Goals** via Spec Kit's official `.specify/templates/overrides/spec-template.md`.
  - **GSD**: Clean-context execution discipline + atomic per-task `git commit` directly on your current branch.
  - **OpenSpec**: Auto-maintained `specs/INDEX.md` living overview for brownfield visibility.

## Install into DSH

From GitHub (after pushing this repo):

```bash
# Web profile
dsh plugin --profile web add https://github.com/<your-username>/dsh-sdd-kit

# Desktop profile
dsh plugin --profile desktop add https://github.com/<your-username>/dsh-sdd-kit
```

Or from a local `.tgz` tarball:

```bash
dsh plugin --profile web add ./dsh-sdd-kit-0.2.0.tgz
```

Restart DSH after installing, then run `/sdd-setup` in your project.

## Daily Workflow

1. **Setup / Upgrade**: `/sdd-setup` (syncs `~/.dsh/upstream/superpowers`, checks/upgrades `specify-cli`, runs `specify init --here` + `specify extension add bug`, installs EARS/Non-Goals override). init runs unattended with agent-tool checks skipped and pins a stable Python for installs.
2. **Build a Feature**:
   - Plan with native Spec Kit: `/speckit.constitution` → `/speckit.specify` → `/speckit.clarify` → `/speckit.plan` → `/speckit.tasks` → `/speckit.analyze`
   - Execute with `/sdd-implement` (strict TDD everywhere + atomic commit per task on current branch → native `/speckit.converge` + `specs/INDEX.md` sync).
3. **Fix a Bug**:
   - Assess with native Spec Kit: `/speckit-bug-assess "<symptom>" slug=<slug>`
   - Fix & verify with `/sdd-implement bug=<slug>` (upstream Superpowers debugging + strict TDD + atomic commit → native `/speckit-bug-test slug=<slug>` until `verified`).

## Local Tests

```bash
npm test
```
