# sdd-setup upstream command hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `sdd_upstream`'s `specify_init` and `specify_upgrade` actions generate commands that succeed unattended on current spec-kit + DSH (no Claude Code, stable Python), so `/sdd-setup` never reproduces the four known failures.

**Architecture:** Harden command construction in the two `runUpstream` branches: `specify_init` always emits `--non-interactive --force --ignore-agent-tools` and only emits the deprecated `--skills` option on explicit opt-in; `specify_upgrade` passes an overridable `--python` (default `3.14`) on fresh installs. Tests pin each flag via a mock runner; docs and the installed profile copy are synced last.

**Tech Stack:** Node >=18 ESM, node:test, `uv tool`, spec-kit CLI; no new deps.

**Spec:** `docs/superpowers/specs/2026-11-23-sdd-setup-upstream-hardening-design.md`

## Global Constraints

- Node >=18, ESM, no new dependencies.
- New behavior is the DEFAULT: `--force`, `--non-interactive`, `--ignore-agent-tools` always on for `specify_init`; `--skills` off unless `args.useSkills === true`.
- `python` is an overridable argument (default `3.14`), never a hardcoded path.
- Installed plugin copy at `/home/bobo/.dsh/profiles/web/node_modules/dsh-sdd-kit` is a plain directory copy, not a symlink — changed files must be copied there.
- New tool code requires a DSH restart to load; do not restart the host from inside this session.

## Review Focus

- Re-running `/sdd-setup` in a non-empty dir must not prompt/hang → Task 1 test asserts `--force` + `--non-interactive`.
- DSH host with no Claude Code binary must not abort agent detection → Task 1 test asserts `--ignore-agent-tools`.
- Current spec-kit rejects `--skills` → Task 1 test asserts its absence by default; Task 1 also asserts `useSkills:true` still emits it for older spec-kit.
- Fresh `specify-cli` install on this machine must avoid Python 3.16 alpha / `ffi.h` build failure → Task 2 test asserts `--python 3.14` default and override.
- Tool parameter docs and the installed copy must match source, or `/sdd-setup` still calls stale behavior → Task 3 verifies docs assertions and copied-file diff.

---

### Task 1: Harden `specify_init` flags

**Files:**
- Modify: `src/core/upstream.mjs:113-124`
- Test: `test/sdd-kit.test.mjs` (first test, lines 40-42)

**Interfaces:**
- Consumes: `runUpstream(args, runner)` signature (unchanged), mockRunner shape `[cmd, ...args]`.
- Produces: `specify_init` always emits `--non-interactive --force --ignore-agent-tools`; `--integration-options=--skills` only when `args.useSkills === true`; returned `command` string reflects flags.

- [ ] **Step 1: Write failing test for new default flags**

Replace the assertion at `test/sdd-kit.test.mjs:40-42` with:
```js
    const initRes = await runUpstream({ action: 'specify_init', cwd }, mockRunner);
    assert.equal(initRes.ok, true);
    const initCall = calls.find((c) => c[0] === 'specify' && c[1] === 'init');
    assert.ok(initCall, 'expected a specify init call');
    for (const flag of ['--non-interactive', '--force', '--ignore-agent-tools']) {
      assert.ok(initCall.includes(flag), `expected ${flag} in: ${initCall.join(' ')}`);
    }
    assert.ok(!initCall.includes('--integration-options=--skills'), 'must not emit deprecated --skills by default');
```

Add a new test right after it:
```js
test('specify_init emits --skills only on explicit opt-in', async () => {
  const calls = [];
  const mockRunner = async (cmd, args) => { calls.push([cmd, ...args]); return { ok: true, code: 0, stdout: '', stderr: '' }; };
  await runUpstream({ action: 'specify_init', cwd: process.cwd(), useSkills: true }, mockRunner);
  const initCall = calls.find((c) => c[0] === 'specify' && c[1] === 'init');
  assert.ok(initCall.includes('--integration-options=--skills'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/bobo/Projects/dsh-sdd-kit && npm test`
Expected: FAIL — missing `--non-interactive`, `--force`, `--ignore-agent-tools` in init call.

- [ ] **Step 3: Implement in `src/core/upstream.mjs:113-124`**

Replace the `specify_init` branch body so `cliArgs` is initialized as:
```js
    const cliArgs = [
      'init', '--here', '--integration', integration,
      '--non-interactive', '--force', '--ignore-agent-tools',
    ];
    if (args.useSkills === true) {
      cliArgs.push('--integration-options=--skills');
    }
```
Remove the old `if (args.force)` and `if (args.useSkills !== false)` blocks. Keep the runner call and return unchanged.

- [ ] **Step 4: Run tests to verify pass**

Run: `cd /home/bobo/Projects/dsh-sdd-kit && npm test`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
cd /home/bobo/Projects/dsh-sdd-kit && git add src/core/upstream.mjs test/sdd-kit.test.mjs && git commit -m "fix(sdd): harden specify_init defaults for unattended DSH setup"
```

---

### Task 2: Pin stable Python in `specify_upgrade`

**Files:**
- Modify: `src/core/upstream.mjs:104-111`
- Test: `test/sdd-kit.test.mjs` (new test)

**Interfaces:**
- Consumes: `runUpstream(args, runner)`; mockRunner shape.
- Produces: fresh-install uv args include `--python <resolved>`; `python` field in return = `args.python || '3.14'`; `command` string includes the resolved python.

- [ ] **Step 1: Write failing test**

Append to `test/sdd-kit.test.mjs`:
```js
test('specify_upgrade pins a stable python on fresh install and honors override', async () => {
  const cwd = await makeTempDir();
  const calls = [];
  const mockRunner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'specify' && args[0] === '--version') return { ok: false, code: 1, stdout: '', stderr: 'not found' };
    return { ok: true, code: 0, stdout: '', stderr: '' };
  };
  try {
    const def = await runUpstream({ action: 'specify_upgrade', cwd }, mockRunner);
    assert.equal(def.mode, 'install');
    assert.equal(def.python, '3.14');
    let uvCall = calls.find((c) => c[0] === 'uv');
    assert.ok(uvCall.includes('--python') && uvCall.includes('3.14'), `uv call: ${uvCall?.join(' ')}`);
    assert.match(def.command, /--python 3\.14/);

    calls.length = 0;
    const ovr = await runUpstream({ action: 'specify_upgrade', cwd, python: '3.12' }, mockRunner);
    assert.equal(ovr.python, '3.12');
    uvCall = calls.find((c) => c[0] === 'uv');
    assert.ok(uvCall.includes('3.12'));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/bobo/Projects/dsh-sdd-kit && npm test`
Expected: FAIL — no `python` field / no `--python` in uv args.

- [ ] **Step 3: Implement in `src/core/upstream.mjs:104-111`**

Set `const python = args.python || '3.14';`. On the install branch append `'--python', python` to `uvArgs` after the `--from` pair. Leave the upgrade branch (`['tool','upgrade','specify-cli']`) unchanged. Add `python,` to the returned object.

- [ ] **Step 4: Run tests to verify pass**

Run: `cd /home/bobo/Projects/dsh-sdd-kit && npm test`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
cd /home/bobo/Projects/dsh-sdd-kit && git add src/core/upstream.mjs test/sdd-kit.test.mjs && git commit -m "fix(sdd): pin stable python for fresh specify-cli installs"
```

---

### Task 3: Sync docs and installed profile copy

**Files:**
- Modify: `src/register.mjs:31-38` (param descriptions)
- Modify: `skills/sdd-setup/SKILL.md:18-22`
- Modify: `README.md:39` (setup line)
- Copy to: `/home/bobo/.dsh/profiles/web/node_modules/dsh-sdd-kit/` (changed files only)

**Interfaces:**
- Consumes: Task 1 & 2 behavior.
- Produces: docs describe real defaults; installed copy byte-identical to source for changed files.

- [ ] **Step 1: Update `src/register.mjs` parameter docs**

`useSkills` description → "Opt in to the deprecated --integration-options=--skills flag (default false; new spec-kit installs skills by default)."
`force` description → "Deprecated/no-op: specify_init always passes --force now."
Add `python` param: type string, description "Python interpreter for fresh specify-cli installs (default 3.14; override if your stable Python differs)."

- [ ] **Step 2: Update `skills/sdd-setup/SKILL.md`**

At the `specify_init` bullet (line 21): replace the literal command with "passes `--integration claude --non-interactive --force --ignore-agent-tools`; skills are installed by default by current spec-kit." At the `specify_upgrade` bullet (line 18): note it pins a stable Python (`3.14` default, overridable via `python`) to avoid source-building on alpha interpreters.

- [ ] **Step 3: Update `README.md:39`**

Append to the setup line: "init runs unattended with agent-tool checks skipped and pins a stable Python for installs."

- [ ] **Step 4: Run full test suite**

Run: `cd /home/bobo/Projects/dsh-sdd-kit && npm test`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Sync changed files into installed copy**

```bash
SRC=/home/bobo/Projects/dsh-sdd-kit
DST=/home/bobo/.dsh/profiles/web/node_modules/dsh-sdd-kit
cp "$SRC/src/core/upstream.mjs" "$DST/src/core/upstream.mjs"
cp "$SRC/src/register.mjs" "$DST/src/register.mjs"
cp "$SRC/skills/sdd-setup/SKILL.md" "$DST/skills/sdd-setup/SKILL.md"
cp "$SRC/README.md" "$DST/README.md"
cp "$SRC/test/sdd-kit.test.mjs" "$DST/test/sdd-kit.test.mjs"
for f in src/core/upstream.mjs src/register.mjs skills/sdd-setup/SKILL.md README.md test/sdd-kit.test.mjs; do cmp -s "$SRC/$f" "$DST/$f" && echo "OK $f" || echo "MISMATCH $f"; done
```
Expected: all `OK`.

- [ ] **Step 6: Commit source docs**

```bash
cd /home/bobo/Projects/dsh-sdd-kit && git add src/register.mjs skills/sdd-setup/SKILL.md README.md docs/superpowers && git commit -m "docs(sdd): document hardened setup defaults and add design/plan"
```

- [ ] **Step 7: Report restart requirement**

Tell the user the installed copy is updated but a DSH restart is required to load the new tool code; do not restart the host from inside the session.
