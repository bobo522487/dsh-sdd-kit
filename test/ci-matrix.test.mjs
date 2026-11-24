import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
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
    host: { status: 'pass', items: [{ status: 'pass', code: 'HOST_CAPABILITY' }] },
    repository: { status: 'pass', items: [{ status: 'pass', code: 'SPECIFY_DIR' }] },
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
