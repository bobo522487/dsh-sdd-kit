---
name: sdd-implement
description: Bridge Spec Kit planning artifacts (specs/<NNN>/tasks.md or .specify/bugs/<slug>/) into upstream Superpowers execution discipline on the current branch — strict TDD for every task, systematic debugging, atomic per-task git commits, and native /speckit.converge or /speckit-bug-test closeout.
disable-model-invocation: true
---

# /sdd-implement

Execute a Spec Kit **Feature** (`specs/<NNN>/tasks.md`) or **Bug** (`.specify/bugs/<slug>/`) using upstream **Superpowers** engineering discipline.

## 1. Detect Target & Load Context

1. Call `sdd_bridge(action: "inspect", featureName?, bugSlug?)`.
2. **Resolve mode**:
   - **Bug mode** (when user passes `bug=<slug>` or only `.specify/bugs/<slug>/` is active): read `.specify/bugs/<slug>/` assessment report and `.specify/memory/constitution.md`.
   - **Feature mode** (default): read `.specify/memory/constitution.md`, `specs/<feature>/spec.md`, `specs/<feature>/plan.md`, and `specs/<feature>/tasks.md`.
   - If multiple unfinished targets exist and none was specified, list them concisely and ask the user which one to run.
3. **Branch policy**: Work directly on the **current git branch** by default (do not force `using-git-worktrees` unless the user explicitly asks for an isolated worktree).
4. **Clean-context discipline (GSD principle)**: Keep context lean — default to sequential single-session execution task by task; only dispatch DSH `subagent`s for `[P]`-marked parallel tasks when the user explicitly requests parallel execution.

## 2. Delegate Execution Discipline to Upstream Superpowers

Load and follow the mounted upstream `obra/superpowers` skills when executing (soft-gate overridable if the user explicitly asks to skip):
- **`test-driven-development`**: Apply **strict Red → Green → Refactor** uniformly to **every** task (backend, API, state, and UI alike). Never skip observing a real failing test first.
- **`systematic-debugging`**: On any failure or bug, follow root-cause diagnosis instead of guessing. If two consecutive fix attempts fail on the same error, stop and surface the diagnosis to the user.
- **`verification-before-completion`**: Never claim a task or fix is done without fresh passing output from the real test/typecheck/build command.
- **`requesting-code-review`**: Run a 2-stage self-review (Spec Compliance against `spec.md` + Code Quality against `constitution.md`) once all tasks are checked off.

## 3. Per-Task Atomic Loop (Feature Mode)

For each unchecked task in `specs/<feature>/tasks.md`:
1. **RED**: Write the smallest failing test for this task and run the real test command to observe it fail for the expected reason.
2. **GREEN**: Write minimal code to make the test pass and verify green output.
3. **REFACTOR**: Clean up duplication while keeping all tests green.
4. **CHECK OFF & ATOMIC COMMIT**:
   - Call `sdd_bridge(action: "check_task", featureName, taskMatch)` to flip `- [ ]` → `- [x]`.
   - Check `git status --short`, stage **only** the files touched by this task plus `specs/<feature>/tasks.md` (never `git add -A`), and commit with a Conventional Commit message (`feat(<feature>): <task summary>`).
   - Print a 1–2 line progress note (task done, verification passed, commit SHA) and proceed to the next task.

## 4. Closeout (Hand Back to Spec Kit Native Verification)

- **Feature Mode**: Once `tasks.md` has `remaining: 0` and 2-stage self-review passes, run Spec Kit's native **`/speckit.converge`** so Spec Kit verifies zero spec drift against the codebase, then call `sdd_bridge(action: "sync_index")` to refresh `specs/INDEX.md`.
- **Bug Mode**: After strict TDD fix + atomic commit (`fix(<slug>): ...`), run Spec Kit's native **`/speckit-bug-test slug=<slug>`** — only a `verified` verdict confirms completion.
