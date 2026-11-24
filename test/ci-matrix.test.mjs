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

test('CI never treats not_executed as success (REQ-42/T099)', async () => {
  const workflow = await fs.readFile(path.join(PKG_ROOT, '.github', 'workflows', 'upstream-integration.yml'), 'utf8');
  assert.match(workflow, /status !== 'passed'/);
  assert.match(workflow, /not_executed/);

  // T099: the workflow is a second line of defence, not the only one. The
  // verifier process itself must also fail when nothing could be executed.
  const emptyBin = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-empty-bin-'));
  try {
    const result = spawnSync(process.execPath, [path.join(PKG_ROOT, 'scripts', 'verify-upstream.mjs'), '--json'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { PATH: emptyBin, HOME: emptyBin, TMPDIR: emptyBin },
    });
    assert.notEqual(result.status, 0, 'T099: the verifier itself must fail on not_executed');
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'not_executed');
  } finally {
    await fs.rm(emptyBin, { recursive: true, force: true });
  }
});

test('verify-upstream checks the expanded six-hook contract (REQ-22)', async () => {
  const source = await fs.readFile(path.join(PKG_ROOT, 'scripts', 'verify-upstream.mjs'), 'utf8');
  assert.match(source, /'before_clarify'/);
  assert.match(source, /'before_plan'/);
  assert.match(source, /session_start/);
  assert.doesNotMatch(source, /hookCount === 4/);
});

const WORKFLOW = path.join(PKG_ROOT, '.github', 'workflows', 'upstream-integration.yml');

/**
 * Every CI gate ships as an inline heredoc; the tests execute that same code so
 * a gate that asserts nothing cannot pass review by looking plausible.
 */
async function gateSource(name) {
  const workflow = await fs.readFile(WORKFLOW, 'utf8');
  const match = new RegExp(`cat > "\\$RUNNER_TEMP/${name}" <<'NODE'\\n([\\s\\S]*?)\\n\\s*NODE\\n`).exec(workflow);
  assert.ok(match, `the workflow must define ${name} as a heredoc`);
  return match[1];
}

async function runGate(name, payload, env = {}) {
  const source = await gateSource(name);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ci-gate-'));
  try {
    const script = path.join(dir, name);
    const file = path.join(dir, 'report.json');
    await fs.writeFile(script, source, 'utf8');
    // An undefined payload leaves the file absent: the gate must not treat an
    // unreadable report as a pass either.
    if (payload !== undefined) await fs.writeFile(file, JSON.stringify(payload), 'utf8');
    // The gates read host env channels, so an inherited DSH_SDD_KIT_SUPERPOWERS_DIR
    // would silently change what each case is testing. Only the case may set it.
    const inherited = { ...process.env };
    delete inherited.DSH_SDD_KIT_SUPERPOWERS_DIR;
    return spawnSync(process.execPath, [script, file], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...inherited, ...env },
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** The doctor gate ships as an inline heredoc; the tests execute that same code. */
async function doctorGateSource() {
  return gateSource('verify-doctor.mjs');
}

async function runDoctorGate(report, env = {}) {
  return runGate('verify-doctor.mjs', report, env);
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

// A spec-kit shim that really satisfies all four contract points, so a test
// can isolate the version-bound verdict from a broken contract.
const PASSING_SPECIFY_SHIM = (version) => `case "$1" in
  --version) echo "specify ${version}" ;;
  init)
    mkdir -p .specify/templates .dsh/skills
    for i in 1 2 3 4 5; do : > ".specify/templates/\${i}-template.md"; done
    ;;
  extension)
    case "$2" in
      add)
        printf '%s\\n' \\
          'hooks:' \\
          '  before_implement:' \\
          '  after_implement:' \\
          '  before_bug_fix:' \\
          '  after_bug_fix:' \\
          '  before_clarify:' \\
          '  before_plan:' \\
          > .specify/extensions.yml
        ;;
      list)
        printf '%s\\n' '[{"id":"superpowers-hooks","version":"0.5.1","enabled":true,"provides":{"hooks":6}}]'
        ;;
      *) exit 2 ;;
    esac
    ;;
  *) exit 2 ;;
esac`;

test('verify-upstream exits non-zero when only the version bound drifts (T099)', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX shell shims; covered on POSIX only');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-drift-only-'));
  try {
    const bin = await makeShimPath(root, {
      specify: PASSING_SPECIFY_SHIM('1.3.0'),
      uv: 'echo "uv 0.13.9"',
      git: 'echo "git version 2.43.0"',
    });
    const result = await runVerifyUpstream({
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HOME: root,
      TMPDIR: root,
    });
    assert.equal(result.error, undefined, result.error?.message);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'passed', 'the shim must satisfy all four contract points');
    assert.equal(report.checks.length, 4);
    assert.ok(report.checks.every((check) => check.ok === true), JSON.stringify(report.checks));
    for (const check of report.checks) {
      assert.deepEqual(Object.keys(check).sort(), ['detail', 'id', 'ok', 'stderr'],
        'T099 must not break the four-field check error contract');
    }
    assert.equal(report.versionDrift.needsAdjustment, true, '1.3.0 is below the >=1.4.0 floor');
    assert.notEqual(result.status, 0, 'T099: version drift alone must fail the process');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

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

test('CI pins the discipline mirror to an immutable ref instead of a moving branch (I8)', async () => {
  const workflow = await fs.readFile(WORKFLOW, 'utf8');
  const declaration = /^\s*SUPERPOWERS_REF:\s*(.+)$/m.exec(workflow);
  assert.ok(declaration, 'the workflow must declare SUPERPOWERS_REF');
  // The declaration is a matrix expression; the ref is the literal in the
  // truthy arm, or a bare literal when the matrix indirection is dropped.
  const ref = /&&\s*'([^']*)'\s*\|\|/.exec(declaration[1])?.[1]
    ?? declaration[1].trim().replace(/^['"]|['"]$/g, '');
  assert.ok(ref, `SUPERPOWERS_REF must carry a literal ref, got: ${declaration[1]}`);
  assert.doesNotMatch(
    ref,
    /^(?:main|master|HEAD)$/,
    `pinned-mirror must not follow a moving branch, got: ${ref}`
  );
  // `git clone --branch` resolves refs only, so the pin must be a release tag.
  // A bare sha would need the fetch-by-sha dance documented in the header.
  assert.match(
    ref,
    /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/,
    `pinned-mirror must pin a release tag that --branch can resolve, got: ${ref}`
  );
  // The pin is only honest if the next maintainer knows how to move it.
  assert.match(
    workflow,
    /^#.*SUPERPOWERS_REF/m,
    'the workflow header must document how to upgrade SUPERPOWERS_REF'
  );
});

test('CI fails the job when install_overrides reports ok:false (I8)', async () => {
  const workflow = await fs.readFile(WORKFLOW, 'utf8');
  const bridge = workflow.indexOf('bridge --action install_overrides');
  const gate = workflow.indexOf('verify-overrides.mjs');
  assert.ok(bridge >= 0, 'the workflow must install the managed overrides');
  assert.ok(gate > bridge, 'an overrides gate must run after the bridge call, not before it');

  const source = await gateSource('verify-overrides.mjs');
  assert.match(source, /\.ok/, 'the gate must read the ok field instead of trusting the exit code');

  const passed = await runGate('verify-overrides.mjs', {
    action: 'install_overrides',
    ok: true,
    artifacts: [{ id: 'plan-template', status: 'written' }],
  });
  assert.equal(passed.status, 0, passed.stderr);

  // bin/sdd-kit.mjs only sets exitCode for status === 'error', so a bridge that
  // reports ok:false still exits 0. The gate has to catch that itself.
  const failed = await runGate('verify-overrides.mjs', {
    action: 'install_overrides',
    ok: false,
    artifacts: [{ id: 'plan-template', status: 'failed' }],
  });
  assert.notEqual(failed.status, 0, 'ok:false must fail the job even when the CLI exits 0');
  assert.match(failed.stderr, /ok/);

  const empty = await runGate('verify-overrides.mjs', {
    action: 'install_overrides',
    ok: false,
    artifacts: [],
  });
  assert.notEqual(empty.status, 0, 'an install that touched no artifact must fail');

  const unreadable = await runGate('verify-overrides.mjs', undefined);
  assert.notEqual(unreadable.status, 0, 'a missing overrides report must not pass');
});

test('CI proves the pinned mirror reaches the CLI through the exported env channel (I8)', async () => {
  const workflow = await fs.readFile(WORKFLOW, 'utf8');
  // Exporting a path is not proof: the pin step must confirm the checkout it
  // exported really sits on the pinned ref, otherwise a stale cache or a
  // fallback clone would sail through.
  const pinStep = workflow.slice(workflow.indexOf('Pin the discipline mirror'), workflow.indexOf('Install → init'));
  assert.match(pinStep, /git -C "\$RUNNER_TEMP\/superpowers-pinned" rev-parse HEAD/, 'the pin step must read the cloned HEAD');
  assert.match(pinStep, /SUPERPOWERS_REF/, 'the pin step must compare the checkout against the pinned ref');
  assert.match(pinStep, /DSH_SDD_KIT_SUPERPOWERS_DIR=.*\$GITHUB_ENV/, 'the pin step must export the clone it verified');

  const gate = await gateSource('verify-doctor.mjs');
  assert.match(gate, /DSH_SDD_KIT_SUPERPOWERS_DIR/, 'the doctor gate must read the exported pin');
  assert.match(gate, /via !== 'env'/, 'the gate must reject a mirror resolved through any other channel');

  const mirror = '/tmp/superpowers-pinned';
  const withMirror = ({ via = 'env', resolvedAt = mirror } = {}) => ({
    ...zones(),
    environment: {
      status: 'pass',
      items: [
        { status: 'pass', code: 'NODE_VERSION' },
        { status: 'pass', code: 'UPSTREAM_MIRROR', path: resolvedAt, via },
      ],
    },
  });

  const env = { DSH_SDD_KIT_SUPERPOWERS_DIR: mirror };
  const consumed = await runGate('verify-doctor.mjs', withMirror(), env);
  assert.equal(consumed.status, 0, consumed.stderr);

  const ignored = await runGate('verify-doctor.mjs', withMirror({ via: 'dsh_home' }), env);
  assert.notEqual(ignored.status, 0, 'a pinned job that fell back to the home mirror must fail');

  const elsewhere = await runGate(
    'verify-doctor.mjs',
    withMirror({ resolvedAt: '/home/runner/.dsh/upstream/superpowers' }),
    env
  );
  assert.notEqual(elsewhere.status, 0, 'the env channel must point at the pinned clone, not any old path');
});

test('CI runs verify-upstream from the workspace root, not the current directory (M6)', async () => {
  const workflow = await fs.readFile(WORKFLOW, 'utf8');
  assert.match(
    workflow,
    /node "\$GITHUB_WORKSPACE\/scripts\/verify-upstream\.mjs"/,
    'the verifier must be addressed by workspace path so the step cwd cannot break it'
  );
  assert.doesNotMatch(
    workflow,
    /(?:^|[\s;&|])node scripts\/verify-upstream\.mjs/m,
    'a relative verifier path resolves against whatever cwd the step happens to inherit'
  );
});
