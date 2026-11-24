import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAction } from '../src/core/action.mjs';
import { formatGuidanceText } from '../src/core/guidance.mjs';
import { runUpdate } from '../src/core/update.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PKG_ROOT, 'bin', 'sdd-kit.mjs');

/** Structural shape: sorted keys + value types, ignoring exact strings. */
function shape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.map(shape);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])]));
  }
  return typeof value;
}

function invokeCli(args, env = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: PKG_ROOT,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, ...env },
  });
  assert.equal(result.error, undefined, `CLI spawn failed: ${result.error?.message}`);
  let stdout;
  try {
    stdout = JSON.parse(result.stdout);
  } catch {
    assert.fail(`CLI stdout is not JSON: ${result.stdout.slice(0, 400)}`);
  }
  return { stdout, status: result.status };
}

test('core entry and CLI entry produce structurally identical JSON for the same action (REQ-05/14/AC-03)', async () => {
  const params = { cwd: PKG_ROOT };
  const coreResult = await runAction('guidance', params);
  const cli = invokeCli(['guidance', '--json']);
  assert.deepEqual(shape(cli.stdout), shape(coreResult));
});

test('unimplemented CLI subcommand uses the four-field error contract and non-zero exit (AC-03)', () => {
  const cli = invokeCli(['definitely-not-an-action', '--json']);
  assert.notEqual(cli.status, 0);
  assert.deepEqual(Object.keys(cli.stdout).sort(), ['code', 'fix', 'message', 'status']);
  assert.equal(cli.stdout.status, 'error');
});

test('a misspelled option is rejected with the four-field error contract (AC-03)', () => {
  const cli = invokeCli(['guidance', '--jsn']);
  assert.notEqual(cli.status, 0);
  assert.deepEqual(Object.keys(cli.stdout).sort(), ['code', 'fix', 'message', 'status']);
  assert.equal(cli.stdout.status, 'error');
  assert.match(cli.stdout.message, /--jsn/);
  assert.match(cli.stdout.fix, /--json/);
});

test('a misspelled option never falls through to a silent success (AC-03)', () => {
  const cli = invokeCli(['doctor', '--triger', 'x']);
  assert.notEqual(cli.status, 0);
  assert.equal(cli.stdout.status, 'error');
});

test('a valid subcommand with an unknown option refuses to run (AC-03)', () => {
  const cli = invokeCli(['guidance', '--nope']);
  assert.notEqual(cli.status, 0);
  assert.deepEqual(Object.keys(cli.stdout).sort(), ['code', 'fix', 'message', 'status']);
  assert.match(cli.stdout.message, /--nope/);
});

test('doctor receives --trust-flags as an array, empty when omitted (REQ-20/AC-11)', () => {
  const withFlags = invokeCli(['doctor', '--json', '--host', 'cursor', '--trust-flags=--trust --force']);
  assert.equal(withFlags.status, 0);
  const cursorTrust = withFlags.stdout.host.items.find((entry) => entry.code === 'CURSOR_TRUST');
  assert.ok(cursorTrust, 'doctor host zone must report the trust-flag posture');
  assert.equal(cursorTrust.status, 'warn');
  assert.match(cursorTrust.message, /--trust/);

  const withoutFlags = invokeCli(['doctor', '--json', '--host', 'cursor']);
  assert.equal(withoutFlags.status, 0);
  const quiet = withoutFlags.stdout.host.items.find((entry) => entry.code === 'CURSOR_TRUST');
  assert.equal(quiet.status, 'pass');
});

test('--trust-flags also accepts a comma separated list (AC-11)', () => {
  const cli = invokeCli(['doctor', '--json', '--host', 'cursor', '--trust-flags=--trust,--force']);
  assert.equal(cli.status, 0);
  const cursorTrust = cli.stdout.host.items.find((entry) => entry.code === 'CURSOR_TRUST');
  assert.equal(cursorTrust.status, 'warn');
  assert.match(cursorTrust.message, /--trust/);
  assert.match(cursorTrust.message, /--force/);
});

async function makeSkillTree({ hostDir = '.dsh/skills', project, user }) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-cli-skills-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-cli-home-'));
  const writeSkill = async (base, name, frontmatter) => {
    const dir = path.join(base, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'SKILL.md'),
      `---\n${frontmatter}\n---\n\nRun \`touch ${path.join(repo, 'EXECUTED')}\` if this skill is executed.\n`,
      'utf8'
    );
  };
  if (project) await writeSkill(path.join(repo, hostDir), project.name, project.frontmatter);
  if (user) await writeSkill(path.join(home, '.dsh', 'skills'), user.name, user.frontmatter);
  return { repo, home };
}

test('doctor --trigger collects host/project SKILL.md summaries and scores them without executing (T077)', async () => {
  const { repo, home } = await makeSkillTree({
    project: {
      name: 'debug-helper',
      frontmatter: 'name: debug-helper\ndescription: debug a failing test\nprovider: plugin\nsource: host\nuser-invocable: true\n',
    },
  });
  const cli = invokeCli(
    ['doctor', '--json', '--cwd', repo, '--host', 'dsh', '--trigger', 'debug failing test'],
    { HOME: home }
  );
  assert.equal(cli.status, 1, 'a synthetic HOME fails the environment zone and the CLI must report it');
  assert.equal(cli.stdout.triggerDryRun.status, 'pass');
  const item = cli.stdout.triggerDryRun.items.find((entry) => entry.code === 'TRIGGER_SCORES');
  assert.ok(item, 'trigger zone must expose scored skills');
  const entry = item.scores.find((score) => score.skill.name === 'debug-helper');
  assert.ok(entry, 'CLI must pass scanned SkillSummary[] to the doctor action');
  assert.ok(entry.score > 0);
  assert.equal(typeof entry.skill.path, 'string');
  assert.match(entry.skill.path, /debug-helper\/SKILL\.md$/);
  assert.equal(entry.skill.provider, 'plugin');
  assert.equal(entry.skill.source, 'host');
  assert.deepEqual(entry.skill.invocation, { userInvocable: true, modelInvocable: true });
  await assert.rejects(fs.access(path.join(repo, 'EXECUTED')), 'dry-run must never execute a skill');
});

test('doctor --trigger also reads user-level skills and keeps excluded entries listed (T077)', async () => {
  const { repo, home } = await makeSkillTree({
    user: {
      name: 'internal-debug',
      frontmatter: 'name: internal-debug\ndescription: debug failing test\nuser-invocable: false\ndisable-model-invocation: true\n',
    },
  });
  const cli = invokeCli(
    ['doctor', '--json', '--cwd', repo, '--host', 'dsh', '--trigger', 'debug failing test'],
    { HOME: home }
  );
  assert.equal(cli.status, 1, 'a synthetic HOME fails the environment zone and the CLI must report it');
  const item = cli.stdout.triggerDryRun.items.find((entry) => entry.code === 'TRIGGER_SCORES');
  assert.ok(item);
  const entry = item.scores.find((score) => score.skill.name === 'internal-debug');
  assert.ok(entry, 'excluded skills are still listed');
  assert.equal(entry.excluded, 'not_user_invocable');
  assert.deepEqual(entry.skill.invocation, { userInvocable: false, modelInvocable: false });
  assert.equal(entry.skill.source, 'user');
});

test('doctor --trigger falls back to packaged skills/ when no host skill dir exists (T077)', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-cli-bundled-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-cli-empty-home-'));
  const dir = path.join(repo, 'skills', 'bundled-debug');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    '---\nname: bundled-debug\ndescription: debug failing test\n---\n\nbody\n',
    'utf8'
  );
  const cli = invokeCli(
    ['doctor', '--json', '--cwd', repo, '--host', 'dsh', '--trigger', 'debug failing test'],
    { HOME: home }
  );
  assert.equal(cli.status, 1, 'an empty HOME is a failed environment zone and must be visible in the exit code');
  const item = cli.stdout.triggerDryRun.items.find((entry) => entry.code === 'TRIGGER_SCORES');
  const entry = item.scores.find((score) => score.skill.name === 'bundled-debug');
  assert.ok(entry, 'packaged skills/ is the last-resort scan target');
  assert.equal(entry.skill.source, 'bundled');
});

test('core/CLI parity now covers doctor, bridge and update (T088)', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-cli-parity-'));
  const emptyBin = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-cli-empty-bin-'));
  const savedPath = process.env.PATH;
  const savedMirror = process.env.DSH_SDD_KIT_SUPERPOWERS_DIR;
  process.env.PATH = emptyBin;
  process.env.DSH_SDD_KIT_SUPERPOWERS_DIR = path.join(repo, 'mirror');
  try {
    for (const command of ['doctor', 'bridge', 'update']) {
      const cli = invokeCli([command, '--json', '--cwd', repo]);
      const core = await runAction(command, { cwd: repo });
      assert.deepEqual(shape(cli.stdout), shape(core), `${command} CLI and core shapes must match`);
    }
  } finally {
    process.env.PATH = savedPath;
    if (savedMirror === undefined) delete process.env.DSH_SDD_KIT_SUPERPOWERS_DIR;
    else process.env.DSH_SDD_KIT_SUPERPOWERS_DIR = savedMirror;
  }
});

test('--action is reachable only through bridge; other subcommands reject it explicitly (T088)', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-cli-action-'));
  const bridge = invokeCli(['bridge', '--action', 'inspect', '--cwd', repo]);
  assert.equal(bridge.status, 0);
  assert.equal(bridge.stdout.action, 'inspect');
  for (const command of ['update', 'doctor', 'guard', 'guidance']) {
    const cli = invokeCli([command, '--action', 'inspect', '--json']);
    assert.notEqual(cli.status, 0, `${command} must not silently ignore --action`);
    assert.equal(cli.stdout.status, 'error');
    assert.equal(cli.stdout.code, 'E_UNSUPPORTED_OPTION');
    assert.match(cli.stdout.message, /--action/);
  }
});

test('a failed bridge action exits non-zero with the four-field error contract (I7)', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-cli-bridge-error-'));
  const failed = invokeCli(['bridge', '--action', 'bogus', '--cwd', repo]);
  assert.equal(failed.status, 1, JSON.stringify(failed.stdout));
  assert.deepEqual(Object.keys(failed.stdout).sort(), ['code', 'fix', 'message', 'status']);
  assert.equal(failed.stdout.status, 'error');
  assert.equal(failed.stdout.code, 'E_ARGS');
  assert.match(failed.stdout.message, /Unknown sdd_bridge action/);
  assert.match(failed.stdout.fix, /Task checkbox updates/);

  // Success keeps the bridge's own documented shape.
  const ok = invokeCli(['bridge', '--action', 'inspect', '--cwd', repo]);
  assert.equal(ok.status, 0, JSON.stringify(ok.stdout));
  assert.deepEqual(Object.keys(ok.stdout).sort(), [
    'action', 'bugs', 'cwd', 'features', 'hasConstitution', 'hasEarsOverride',
    'hasSpecifyDir', 'selectedBug', 'selectedFeature',
  ]);
});

test('update --extension-changes reaches changedLayers as extension_command (I6)', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-cli-extension-changes-'));
  const emptyBin = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-cli-extension-empty-bin-'));
  const savedPath = process.env.PATH;
  const savedMirror = process.env.DSH_SDD_KIT_SUPERPOWERS_DIR;
  const records = [
    { component: 'extension_command', before: null, after: 'extension', outcome: 'updated' },
    { component: 'extension_command', before: null, after: 'commands', outcome: 'updated' },
  ];
  process.env.PATH = emptyBin;
  process.env.DSH_SDD_KIT_SUPERPOWERS_DIR = path.join(repo, 'mirror');
  try {
    const cli = invokeCli([
      'update', '--json', '--cwd', repo, '--host', 'dsh', '--extension-changes=extension,commands',
    ]);
    const core = await runAction('update', { cwd: repo, host: 'dsh', extensionChanges: records });
    assert.deepEqual(shape(cli.stdout), shape(core), 'CLI and core must agree on extension changes');

    const extension = cli.stdout.components.filter((entry) => entry.component === 'extension_command');
    assert.equal(extension.length, 2);
    assert.deepEqual(extension.map((entry) => entry.after), ['extension', 'commands']);
    assert.ok(extension.every((entry) => entry.outcome === 'updated'));
    assert.deepEqual(cli.stdout.reload.layers, ['extension_command']);
    assert.equal(cli.stdout.reload.result, 'new_session');
  } finally {
    process.env.PATH = savedPath;
    if (savedMirror === undefined) delete process.env.DSH_SDD_KIT_SUPERPOWERS_DIR;
    else process.env.DSH_SDD_KIT_SUPERPOWERS_DIR = savedMirror;
  }
});

test('update --reinstall-extension reinstalls the extension and reports extension_command (I6)', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-core-reinstall-extension-'));
  const calls = [];
  const runUpstream = async (args) => {
    if (args.action === 'status') {
      return { specifyCli: { version: '1.4.0' }, superpowers: { head: 'deadbeef', skillCount: 3 } };
    }
    if (args.action === 'install_hooks_ext') {
      calls.push(args);
      return { ok: true, extension: { id: 'sdd-kit', version: '0.5.1' } };
    }
    return { ok: true };
  };
  const report = await runUpdate({ cwd: repo, reinstallExtension: true }, { runUpstream });
  assert.equal(calls.length, 1, 'the reinstall must call install_hooks_ext exactly once');
  assert.equal(calls[0].cwd, repo);
  const record = report.components.find((entry) => entry.component === 'extension_command');
  assert.ok(record, 'a reinstall must be reported as an extension_command component');
  assert.equal(record.outcome, 'updated');
  assert.equal(record.after, 'sdd-kit@0.5.1');
  assert.equal(report.ok, true);

  const ordinary = await runUpdate({ cwd: repo }, { runUpstream });
  assert.equal(calls.length, 1, 'an ordinary update must not reinstall the extension');
  assert.equal(ordinary.components.length, 2);
});

test('setup/upstream-only flags are rejected by every CLI subcommand (T088)', () => {
  const cases = ['--upgrade', '--switch-integration', '--use-skills', '--extension-dir=/tmp/ext'];
  for (const flag of cases) {
    const cli = invokeCli(['doctor', flag]);
    assert.notEqual(cli.status, 0, `${flag} must not be a silent no-op`);
    assert.equal(cli.stdout.status, 'error');
    assert.equal(cli.stdout.code, 'E_UNSUPPORTED_OPTION');
    assert.match(cli.stdout.message, new RegExp(flag.replace(/=.*$/, '')));
  }
});

function runCliRaw(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: PKG_ROOT,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, ...env },
  });
}

test('guidance --text never prints discipline text when the switch is off (T067)', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-cli-guidance-off-'));
  await fs.mkdir(path.join(repo, '.specify'), { recursive: true });
  await fs.writeFile(
    path.join(repo, '.specify', 'sdd-kit.json'),
    `${JSON.stringify({ guidance: { enabled: false } }, null, 2)}\n`,
    'utf8'
  );

  const text = runCliRaw(['guidance', '--text', '--cwd', repo]);
  assert.equal(text.status, 0, text.stderr);
  assert.doesNotMatch(text.stdout, /## SDD 运行时纪律/, 'the discipline header must not be injected when disabled');
  assert.doesNotMatch(text.stdout, /工具映射/, 'the tool mapping must not be injected when disabled');
  assert.match(text.stdout, /guidance disabled|已停用|已关闭/, 'the CLI must say the switch is off instead of printing nothing');

  // The JSON path is the diagnostic surface: it keeps the switch state.
  const json = invokeCli(['guidance', '--json', '--cwd', repo]);
  assert.equal(json.status, 0);
  assert.equal(json.stdout.enabled, false);
  assert.equal(json.stdout.effectiveScope, 'project');

  // A default (no config) project still renders the full text.
  const on = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-cli-guidance-on-'));
  const enabled = runCliRaw(['guidance', '--text', '--cwd', on]);
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.match(enabled.stdout, /## SDD 运行时纪律/);
});

test('--text is implemented only for guidance and rejected elsewhere (T088)', () => {
  const cli = invokeCli(['doctor', '--text']);
  assert.notEqual(cli.status, 0);
  assert.equal(cli.stdout.code, 'E_UNSUPPORTED_OPTION');
  assert.match(cli.stdout.message, /--text/);
});

test('guidance --host <host> --clear-marker clears only that host marker (T081)', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-cli-marker-'));
  const marker = path.join(repo, '.specify', 'sdd-pending.json');

  // An empty repository must stay empty: clearing never creates the file.
  const absent = invokeCli(['guidance', '--cwd', repo, '--host', 'claude', '--clear-marker']);
  assert.equal(absent.status, 0, JSON.stringify(absent.stdout));
  assert.equal(absent.stdout.cleared, false);
  assert.equal(absent.stdout.host, 'claude');
  await assert.rejects(fs.access(marker), 'clearing an absent marker must not create the file');

  await fs.mkdir(path.dirname(marker), { recursive: true });
  const seed = {
    dsh: { host: 'dsh', layer: 'tool_code', timestamp: '2026-01-01T00:00:00.000Z', reason: 'update' },
    claude: { host: 'claude', layer: 'skill_data', timestamp: '2026-01-01T00:00:01.000Z', reason: 'update' },
  };
  await fs.writeFile(marker, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');

  const cleared = invokeCli(['guidance', '--cwd', repo, '--host', 'claude', '--clear-marker']);
  assert.equal(cleared.status, 0, JSON.stringify(cleared.stdout));
  assert.equal(cleared.stdout.cleared, true);
  assert.equal(cleared.stdout.host, 'claude');
  assert.equal(cleared.stdout.path, marker);

  const remaining = JSON.parse(await fs.readFile(marker, 'utf8'));
  assert.deepEqual(Object.keys(remaining), ['dsh'], 'only the requested host entry may be removed');
  assert.equal(remaining.dsh.layer, 'tool_code');

  // An unknown host is refused instead of silently doing nothing.
  const bogus = invokeCli(['guidance', '--cwd', repo, '--host', 'not-a-host', '--clear-marker']);
  assert.notEqual(bogus.status, 0);
  assert.equal(bogus.stdout.status, 'error');
  assert.equal(bogus.stdout.code, 'E_UNKNOWN_HOST');
  assert.match(bogus.stdout.fix, /dsh/);

  // T081/I3: doctor is a second supported entry point for the same operation.
  const doctor = invokeCli(['doctor', '--cwd', repo, '--host', 'dsh', '--clear-marker']);
  assert.equal(doctor.status, 0, JSON.stringify(doctor.stdout));
  for (const zone of ['environment', 'host', 'repository', 'runtime', 'triggerDryRun']) {
    assert.ok(Object.hasOwn(doctor.stdout, zone), 'a doctor clearing run still renders the full exam');
  }
  assert.equal(doctor.stdout.clearMarker.status, 'ok');
  assert.equal(doctor.stdout.clearMarker.action, 'clear_marker');
  assert.equal(doctor.stdout.clearMarker.cleared, true, 'dsh was the remaining entry');
  assert.equal(doctor.stdout.clearMarker.host, 'dsh');
  assert.equal(doctor.stdout.clearMarker.path, marker);

  const afterDoctor = JSON.parse(await fs.readFile(marker, 'utf8'));
  assert.deepEqual(Object.keys(afterDoctor), [], 'doctor cleared only the requested host');

  // Still rejected where there is no reason to clear a marker.
  for (const command of ['bridge', 'update', 'guard']) {
    const refused = invokeCli([command, '--cwd', repo, '--clear-marker']);
    assert.notEqual(refused.status, 0, `${command} must not accept --clear-marker`);
    assert.equal(refused.stdout.code, 'E_UNSUPPORTED_OPTION');
  }
});

test('doctor --host <host> --clear-marker works like guidance and never crashes in text mode (I3)', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-cli-doctor-marker-'));
  const marker = path.join(repo, '.specify', 'sdd-pending.json');
  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(
    marker,
    `${JSON.stringify({
      dsh: { host: 'dsh', layer: 'tool_code', timestamp: '2026-01-01T00:00:00.000Z', reason: 'update' },
      claude: { host: 'claude', layer: 'skill_data', timestamp: '2026-01-01T00:00:01.000Z', reason: 'update' },
    }, null, 2)}\n`,
    'utf8'
  );

  const cleared = invokeCli(['doctor', '--json', '--cwd', repo, '--host', 'claude', '--clear-marker']);
  assert.equal(cleared.status, 0, JSON.stringify(cleared.stdout));
  for (const zone of ['environment', 'host', 'repository', 'runtime', 'triggerDryRun']) {
    assert.ok(Object.hasOwn(cleared.stdout, zone), 'doctor keeps all five zones');
  }
  assert.equal(cleared.stdout.clearMarker.status, 'ok');
  assert.equal(cleared.stdout.clearMarker.host, 'claude');
  assert.equal(cleared.stdout.clearMarker.cleared, true);
  const guidance = invokeCli(['guidance', '--json', '--cwd', repo, '--host', 'claude', '--clear-marker']);
  assert.equal(guidance.status, 0);
  assert.deepEqual(Object.keys(guidance.stdout.clearMarker ?? guidance.stdout).sort(), ['action', 'cleared', 'host', 'path', 'status'], 'the shared clear result shape is unchanged');

  const remaining = JSON.parse(await fs.readFile(marker, 'utf8'));
  assert.deepEqual(Object.keys(remaining), ['dsh']);
  assert.equal(remaining.dsh.layer, 'tool_code');

  // Unknown hosts and absent markers behave exactly as on the guidance path.
  const bogus = invokeCli(['doctor', '--cwd', repo, '--host', 'not-a-host', '--clear-marker']);
  assert.notEqual(bogus.status, 0);
  assert.equal(bogus.stdout.status, 'error');
  assert.equal(bogus.stdout.code, 'E_UNKNOWN_HOST');
  assert.match(bogus.stdout.fix, /dsh/);

  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-cli-doctor-marker-empty-'));
  const absent = invokeCli(['doctor', '--cwd', empty, '--host', 'dsh', '--clear-marker']);
  assert.equal(absent.status, 1, 'the exam still runs and reports the missing .specify/');
  assert.equal(absent.stdout.clearMarker.cleared, false);
  await assert.rejects(fs.access(path.join(empty, '.specify', 'sdd-pending.json')));

  // --text is guidance-only: doctor refuses it with a structured error, never a crash.
  const text = runCliRaw(['doctor', '--text', '--cwd', repo, '--host', 'dsh', '--clear-marker']);
  assert.notEqual(text.status, 0);
  assert.equal(JSON.parse(text.stdout).code, 'E_UNSUPPORTED_OPTION');
});

/**
 * C4 regression: `guidance --text --clear-marker` used to reach
 * formatGuidanceText() with the clear_marker result, which carries no
 * sddPointer, and crashed with "Cannot convert undefined or null to object".
 */
test('guidance --text --clear-marker renders human text instead of crashing (C4)', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-cli-marker-text-'));
  const marker = path.join(repo, '.specify', 'sdd-pending.json');
  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(
    marker,
    `${JSON.stringify({
      dsh: { host: 'dsh', layer: 'tool_code', timestamp: '2026-01-01T00:00:00.000Z', reason: 'update' },
      claude: { host: 'claude', layer: 'skill_data', timestamp: '2026-01-01T00:00:01.000Z', reason: 'update' },
    }, null, 2)}\n`,
    'utf8'
  );

  const text = runCliRaw(['guidance', '--text', '--clear-marker', '--host', 'dsh', '--cwd', repo]);
  assert.equal(text.status, 0, `expected exit 0, got ${text.status}: ${text.stderr || text.stdout}`);
  assert.doesNotMatch(text.stdout, /Cannot convert undefined or null to object/);
  assert.doesNotMatch(text.stdout, /"status":\s*"error"/, 'the text channel must not emit a JSON error envelope');
  assert.match(text.stdout, /已清除/, 'the text channel must confirm the cleared marker');
  assert.match(text.stdout, /dsh/, 'the text channel must name the host');

  const remaining = JSON.parse(await fs.readFile(marker, 'utf8'));
  assert.deepEqual(Object.keys(remaining), ['claude'], 'only the requested host entry may be removed');

  // The JSON shape keeps its four documented fields.
  await fs.writeFile(
    marker,
    `${JSON.stringify({ dsh: { host: 'dsh', layer: 'tool_code', timestamp: '2026-01-01T00:00:00.000Z', reason: 'update' } }, null, 2)}\n`,
    'utf8'
  );
  const json = invokeCli(['guidance', '--json', '--clear-marker', '--host', 'dsh', '--cwd', repo]);
  assert.equal(json.status, 0);
  assert.deepEqual(Object.keys(json.stdout).sort(), ['action', 'cleared', 'host', 'path', 'status']);
  assert.equal(json.stdout.status, 'ok');
  assert.equal(json.stdout.action, 'clear_marker');
  assert.equal(json.stdout.cleared, true);
  assert.equal(json.stdout.host, 'dsh');
});

test('guidance --text --clear-marker on an absent marker still exits 0 with a readable message (C4)', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-cli-marker-text-absent-'));
  const text = runCliRaw(['guidance', '--text', '--clear-marker', '--host', 'dsh', '--cwd', repo]);
  assert.equal(text.status, 0, text.stderr || text.stdout);
  assert.doesNotMatch(text.stdout, /Cannot convert undefined or null to object/);
  assert.match(text.stdout, /已清除|无待生效标记|没有/, 'an absent marker must be reported, not crash');
  await assert.rejects(fs.access(path.join(repo, '.specify', 'sdd-pending.json')), 'clearing must not create the file');
});

test('formatGuidanceText tolerates a bundle without pointer or mapping (C4)', () => {
  const text = formatGuidanceText({ upstreamText: '- skill: desc' });
  assert.match(text, /^## SDD 运行时纪律（dsh-sdd-kit）/);
  assert.match(text, /- skill: desc/);
  assert.doesNotMatch(text, /undefined/, 'a missing section must be omitted, not rendered as undefined');

  assert.doesNotThrow(() => formatGuidanceText({ upstreamText: 'x', sddPointer: null, toolMapping: null }));
  assert.doesNotThrow(() => formatGuidanceText({}));
});

test('doctor --clear-marker with --trigger keeps the five-zone report (final review I3)', () => {
  const repo = PKG_ROOT;
  const result = invokeCli([
    'doctor', '--json', '--cwd', repo, '--host', 'dsh', '--clear-marker', '--trigger', 'do something',
  ]);
  assert.equal(result.status, 0, `the exam must still run: ${JSON.stringify(result.stdout)}`);
  for (const zone of ['environment', 'host', 'repository', 'runtime', 'triggerDryRun']) {
    assert.ok(Object.hasOwn(result.stdout, zone), `missing ${zone}: ${JSON.stringify(Object.keys(result.stdout))}`);
  }
  assert.ok(result.stdout.clearMarker, 'the clearing result is reported alongside the exam');
});

test('doctor and bridge failures are visible in the CLI exit code (final review I7)', async () => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-cli-fail-exit-'));
  const doctor = invokeCli(['doctor', '--json', '--cwd', empty, '--host', 'dsh'], {
    HOME: empty,
    DSH_SDD_KIT_SUPERPOWERS_DIR: empty,
  });
  assert.notEqual(doctor.status, 0, 'a failed zone must not look like a successful exam');
  assert.ok(Object.values(doctor.stdout).some((zone) => zone?.status === 'fail'));

  const bridge = invokeCli(['bridge', '--json', '--action', 'restore_overrides', '--artifact', 'not-an-artifact']);
  assert.notEqual(bridge.status, 0);
  assert.deepEqual(Object.keys(bridge.stdout).sort(), ['code', 'fix', 'message', 'status']);
  assert.equal(bridge.stdout.status, 'error');
});
