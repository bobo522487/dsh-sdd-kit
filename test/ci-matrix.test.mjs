import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('CI matrix covers three upstream and two host dimensions (REQ-40)', async () => {
  const workflow = await fs.readFile(path.join(PKG_ROOT, '.github', 'workflows', 'upstream-integration.yml'), 'utf8');
  assert.match(workflow, /upstream:\s*\[[^\]]*latest[^\]]*pinned-spec-kit[^\]]*pinned-mirror[^\]]*\]/);
  assert.match(workflow, /host:\s*\[[^\]]*dsh[^\]]*claude[^\]]*\]/);
  assert.match(workflow, /install[\s\S]*init[\s\S]*doctor/);
  assert.match(workflow, /matrix\.upstream/);
  assert.match(workflow, /matrix\.host/);
});

test('CI never treats not_executed as success (REQ-42)', async () => {
  const workflow = await fs.readFile(path.join(PKG_ROOT, '.github', 'workflows', 'upstream-integration.yml'), 'utf8');
  assert.match(workflow, /status !== 'passed'/);
  assert.match(workflow, /not_executed/);
});

test('verify-upstream checks the expanded six-hook contract (REQ-22)', async () => {
  const source = await fs.readFile(path.join(PKG_ROOT, 'scripts', 'verify-upstream.mjs'), 'utf8');
  assert.match(source, /'before_clarify'/);
  assert.match(source, /'before_plan'/);
  assert.match(source, /session_start/);
  assert.doesNotMatch(source, /hookCount === 4/);
});

const WORKFLOW = path.join(PKG_ROOT, '.github', 'workflows', 'upstream-integration.yml');

/** The doctor gate ships as an inline heredoc; the tests execute that same code. */
async function doctorGateSource() {
  const workflow = await fs.readFile(WORKFLOW, 'utf8');
  const match = /cat > "\$RUNNER_TEMP\/verify-doctor\.mjs" <<'NODE'\n([\s\S]*?)\n\s*NODE\n/.exec(workflow);
  assert.ok(match, 'the workflow must define the doctor gate as a verify-doctor.mjs heredoc');
  return match[1];
}

async function runDoctorGate(report) {
  const gate = await doctorGateSource();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ci-gate-'));
  try {
    const script = path.join(dir, 'verify-doctor.mjs');
    const file = path.join(dir, 'doctor.json');
    await fs.writeFile(script, gate, 'utf8');
    await fs.writeFile(file, JSON.stringify(report), 'utf8');
    return spawnSync(process.execPath, [script, file], { encoding: 'utf8', timeout: 20_000 });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function zones(overrides = {}) {
  const base = {
    environment: { status: 'pass', items: [{ status: 'pass', code: 'NODE_VERSION' }] },
    host: {
      status: 'pass',
      items: [
        { status: 'pass', code: 'HOST_CAPABILITY' },
        { status: 'pass', code: 'EXTENSION_STATE' },
      ],
    },
    repository: {
      status: 'pass',
      items: [
        { status: 'pass', code: 'SPECIFY_DIR' },
        { status: 'pass', code: 'TEMPLATE_DRIFT' },
        { status: 'pass', code: 'COMMAND_SKILLS' },
      ],
    },
    runtime: { status: 'pass', items: [{ status: 'pass', code: 'PENDING_MARKERS' }] },
    triggerDryRun: { status: 'pass', items: [{ status: 'pass', code: 'TRIGGER_SCORES' }] },
  };
  return { ...base, ...overrides };
}

test('CI installs the packaged extension into the sample project before doctor (REQ-40)', async () => {
  const workflow = await fs.readFile(WORKFLOW, 'utf8');
  assert.match(
    workflow,
    /specify extension add --dev "\$GITHUB_WORKSPACE\/spec-kit-extension"/,
    'the sample project must receive the packaged extension, addressed by workspace path'
  );
  const init = workflow.indexOf('specify init');
  const add = workflow.indexOf('specify extension add');
  const doctor = workflow.indexOf('doctor --json');
  assert.ok(init >= 0 && add > init, 'the extension must be added after specify init');
  assert.ok(doctor > add, 'doctor must run after the extension is installed');
});

test('CI asserts every doctor zone status instead of only the key names (REQ-40)', async () => {
  const gate = await doctorGateSource();
  assert.match(gate, /'environment',\s*'host',\s*'repository',\s*'runtime',\s*'triggerDryRun'/);
  assert.match(gate, /pass',\s*'fail',\s*'skipped',\s*'not_executed'/);
  assert.match(gate, /triggerDryRun/);
});

test('CI doctor gate fails the job when a zone fails or is not executed (REQ-40/REQ-42)', async () => {
  const ok = await runDoctorGate(zones());
  assert.equal(ok.status, 0, ok.stderr);

  const skippedTrigger = await runDoctorGate(zones({ triggerDryRun: { status: 'skipped', items: [] } }));
  assert.equal(skippedTrigger.status, 0, 'triggerDryRun may be skipped when no trigger is supplied');

  for (const zone of ['environment', 'host', 'repository', 'runtime']) {
    const failed = await runDoctorGate(zones({ [zone]: { status: 'fail', items: [{ status: 'fail', code: 'X' }] } }));
    assert.notEqual(failed.status, 0, `${zone}=fail must fail the job`);
    assert.match(failed.stderr, new RegExp(zone));

    const skipped = await runDoctorGate(zones({ [zone]: { status: 'skipped', items: [] } }));
    assert.notEqual(skipped.status, 0, `${zone}=skipped must not pass silently`);

    const notExecuted = await runDoctorGate(zones({ [zone]: { status: 'not_executed', items: [] } }));
    assert.notEqual(notExecuted.status, 0, `${zone}=not_executed must not pass silently`);
  }
});

test('CI doctor gate rejects unknown zone states and missing zones (REQ-40)', async () => {
  const unknown = await runDoctorGate(zones({ host: { status: 'green', items: [] } }));
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /green/);

  const report = zones();
  delete report.runtime;
  const missing = await runDoctorGate(report);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /runtime/);

  const failedItem = await runDoctorGate(zones({
    repository: { status: 'pass', items: [{ status: 'fail', code: 'SPECIFY_DIR', message: 'missing' }] },
  }));
  assert.notEqual(failedItem.status, 0, 'a failing diagnostic item must fail the job even inside a passing zone');
});

test('CI runs on pull_request and push in addition to the nightly schedule (T089)', async () => {
  const workflow = await fs.readFile(WORKFLOW, 'utf8');
  assert.match(workflow, /^on:\n(?:.*\n)*?\s{2}pull_request:/m, 'pull_request must trigger the matrix');
  assert.match(workflow, /^on:\n(?:.*\n)*?\s{2}push:/m, 'push must trigger the matrix');
  assert.match(workflow, /schedule:/, 'the nightly schedule must survive');
  assert.match(workflow, /workflow_dispatch:/, 'manual dispatch must survive');
  // A pull request must not pay for the nightly matrix on every doc-only change.
  assert.match(workflow, /pull_request:[\s\S]*?paths:/, 'the pull_request trigger needs path filters');
});

test('CI feeds the pinned discipline mirror into init and doctor instead of cloning it unused (T089)', async () => {
  const workflow = await fs.readFile(WORKFLOW, 'utf8');
  const clone = workflow.indexOf('superpowers-pinned');
  assert.ok(clone >= 0, 'the pinned-mirror variant must clone the mirror');
  const afterClone = workflow.slice(clone);
  assert.match(
    afterClone,
    /DSH_SDD_KIT_SUPERPOWERS_DIR/,
    'the cloned mirror must reach the CLI through the documented env channel'
  );
  assert.match(
    afterClone,
    /\$GITHUB_ENV/,
    'the mirror path must be exported so every later step inherits it'
  );
  assert.match(
    workflow,
    /doctor --json --host "\$HOST_KEY"/,
    'doctor must be told which host it is verifying'
  );
});

test('CI installs the managed overrides so the repository zone can actually pass (T090)', async () => {
  const workflow = await fs.readFile(WORKFLOW, 'utf8');
  const add = workflow.indexOf('specify extension add');
  const overrides = workflow.indexOf('bridge --action install_overrides');
  const doctor = workflow.indexOf('doctor --json');
  assert.ok(overrides > add, 'overrides are installed after the extension');
  assert.ok(doctor > overrides, 'doctor must observe the installed overrides');
  assert.match(workflow, /--cwd "\$WORKDIR"/, 'the overrides install must target the sample project');
});

test('CI doctor gate demands the repository and host items that prove the extension works (T090)', async () => {
  const gate = await doctorGateSource();
  assert.match(gate, /MUST_PASS_ITEMS/, 'the gate must pin the decisive item codes');
  for (const code of ['EXTENSION_STATE', 'COMMAND_SKILLS', 'TEMPLATE_DRIFT']) {
    assert.match(gate, new RegExp(code), `${code} must be asserted by the gate`);
  }
  assert.match(gate, /TEMPLATE_MISSING/, 'a missing override template must fail the gate');
});

test('CI doctor gate fails when a decisive item is missing, warned or replaced by a template warning (T090)', async () => {
  const ok = await runDoctorGate(zones());
  assert.equal(ok.status, 0, ok.stderr);

  const missingExtension = zones();
  missingExtension.host = { status: 'pass', items: [{ status: 'pass', code: 'HOST_CAPABILITY' }] };
  const missing = await runDoctorGate(missingExtension);
  assert.notEqual(missing.status, 0, 'a missing EXTENSION_STATE item must fail');
  assert.match(missing.stderr, /EXTENSION_STATE/);

  const warnedCommands = zones();
  warnedCommands.repository = {
    status: 'pass',
    items: [
      { status: 'pass', code: 'SPECIFY_DIR' },
      { status: 'pass', code: 'TEMPLATE_DRIFT' },
      { status: 'warn', code: 'COMMAND_SKILLS', message: 'missing: guard' },
    ],
  };
  const warned = await runDoctorGate(warnedCommands);
  assert.notEqual(warned.status, 0, 'COMMAND_SKILLS=warn must fail the gate');
  assert.match(warned.stderr, /COMMAND_SKILLS/);

  const templateMissing = zones();
  templateMissing.repository = {
    status: 'pass',
    items: [
      { status: 'pass', code: 'SPECIFY_DIR' },
      { status: 'warn', code: 'TEMPLATE_MISSING', message: 'no overrides' },
      { status: 'pass', code: 'COMMAND_SKILLS' },
    ],
  };
  const template = await runDoctorGate(templateMissing);
  assert.notEqual(template.status, 0, 'TEMPLATE_MISSING must fail even inside a passing zone');
  assert.match(template.stderr, /TEMPLATE_MISSING/);
});

/** Build a PATH with shims so verify-upstream can be exercised without a real toolchain. */
async function makeShimPath(root, shims) {
  const binDir = path.join(root, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  for (const [name, body] of Object.entries(shims)) {
    const file = path.join(binDir, name);
    await fs.writeFile(file, `#!/bin/sh\n${body}\n`, 'utf8');
    await fs.chmod(file, 0o755);
  }
  return binDir;
}

async function runVerifyUpstream(env) {
  const script = path.join(PKG_ROOT, 'scripts', 'verify-upstream.mjs');
  return spawnSync(process.execPath, [script, '--json'], { encoding: 'utf8', timeout: 60_000, env });
}

const SPECIFY_SHIM = (version) => `case "$1" in
  --version) echo "specify ${version}" ;;
  init) echo "boom: cannot init" >&2; exit 2 ;;
  extension) echo "boom: cannot add" >&2; exit 2 ;;
  *) exit 2 ;;
esac`;

test('verify-upstream reports the declared/observed version bound drift (T090)', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX shell shims; covered on POSIX only');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-drift-'));
  try {
    const stale = path.join(root, 'stale');
    await fs.mkdir(stale, { recursive: true });
    const staleBin = await makeShimPath(stale, {
      specify: SPECIFY_SHIM('1.3.0'),
      uv: 'echo "uv 0.13.9"',
      git: 'echo "git version 2.43.0"',
    });
    const staleRun = await runVerifyUpstream({ PATH: staleBin, HOME: stale, TMPDIR: stale });
    const staleReport = JSON.parse(staleRun.stdout);
    assert.equal(typeof staleReport.versionDrift, 'object', 'the report must carry the version bound drift');
    assert.equal(staleReport.versionDrift.declared, '>=1.4.0');
    assert.equal(staleReport.versionDrift.observed, '1.3.0');
    assert.equal(staleReport.versionDrift.needsAdjustment, true, 'a toolchain below the declared floor is drift');
    assert.equal(staleReport.versionDrift.suggestedBound, '>=1.3.0');

    const fresh = path.join(root, 'fresh');
    await fs.mkdir(fresh, { recursive: true });
    const freshBin = await makeShimPath(fresh, {
      specify: SPECIFY_SHIM('1.4.4.dev0'),
      uv: 'echo "uv 0.13.9"',
      git: 'echo "git version 2.43.0"',
    });
    const freshRun = await runVerifyUpstream({ PATH: freshBin, HOME: fresh, TMPDIR: fresh });
    const freshReport = JSON.parse(freshRun.stdout);
    assert.equal(freshReport.versionDrift.observed, '1.4.4.dev0');
    assert.equal(freshReport.versionDrift.needsAdjustment, false, 'a prerelease of a satisfying release is inside the floor');
    assert.equal(freshReport.versionDrift.suggestedBound, '>=1.4.0');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CI fails the job when the version bound drifts (T090)', async () => {
  const workflow = await fs.readFile(WORKFLOW, 'utf8');
  assert.match(workflow, /versionDrift/, 'the gate must read the drift field');
  assert.match(workflow, /needsAdjustment/, 'the gate must act on the drift verdict');
});

test('the stop-loss milestones are executable gates, not prose (T092)', async () => {
  const doc = await fs.readFile(path.join(PKG_ROOT, 'docs', 'adapters', 'stop-loss.md'), 'utf8');
  const sections = doc.split(/^## /m).slice(1);
  const milestones = sections.filter((section) => /^M[1-4] 门槛：/.test(section));
  assert.equal(milestones.length, 4, 'each of M1-M4 needs its own gate section');

  const guidanceSource = await fs.readFile(path.join(PKG_ROOT, 'src', 'core', 'guidance.mjs'), 'utf8');
  const budget = /TOKEN_BUDGET\s*=\s*(\d+)/.exec(guidanceSource)?.[1];
  assert.ok(budget, 'the guidance token budget must be discoverable');

  for (const section of milestones) {
    const id = /^(M[1-4]) 门槛：/.exec(section)[1];
    // A gate without a runnable command is just a wish.
    const fence = /```sh\n([\s\S]*?)```/.exec(section);
    assert.ok(fence, `${id} must ship a runnable shell block`);
    for (const line of fence[1].split('\n').map((entry) => entry.trim()).filter(Boolean)) {
      assert.match(line, /^node |^npm |^git /, `${id} command must be runnable as written: ${line}`);
      const script = /(?:node|npm(?: run)?)\s+(\S+\.mjs)/.exec(line)?.[1];
      if (script && script.endsWith('.mjs') && !script.startsWith('--')) {
        const target = path.join(PKG_ROOT, script);
        assert.ok(fsSync.existsSync(target), `${id} points at a script that exists: ${script}`);
      }
    }
    // Every gate must name the automated test that keeps it honest, otherwise it
    // decays the moment the milestone ships.
    const guard = /自动化守护：`([^`]+)`/.exec(section);
    assert.ok(guard, `${id} must name the automated check that enforces it`);
    assert.ok(fsSync.existsSync(path.join(PKG_ROOT, guard[1])), `${id} guard file exists: ${guard[1]}`);
    assert.match(section, /判负即触发 M[1-4] 处置/, `${id} must state the fallback it triggers`);
    assert.match(section, /断言：/, `${id} must list assertions, not only commands`);
    if (id === 'M1' || id === 'M2') {
      assert.ok(section.includes(budget), `${id} must use the real token budget (${budget})`);
    }
    if (id === 'M4') {
      assert.match(section, /versionDrift/, 'M4 must read the drift field the verifier now reports');
      assert.match(section, /not_executed/, 'M4 must refuse to record not_executed as a pass');
    }
  }
});
