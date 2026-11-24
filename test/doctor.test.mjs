import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDoctor } from '../src/core/doctor.mjs';

const ZONES = ['environment', 'host', 'repository', 'runtime', 'triggerDryRun'];
const ZONE_STATUSES = new Set(['pass', 'fail', 'skipped', 'not_executed']);
const ITEM_STATUSES = new Set(['pass', 'fail', 'warn', 'skip']);
const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));

async function makeRepo() {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-doctor-'));
  await fs.mkdir(path.join(repo, '.specify'), { recursive: true });
  await fs.writeFile(
    path.join(repo, '.specify', 'feature.json'),
    JSON.stringify({ feature_directory: 'specs/004-multihost-runtime-governance' }),
    'utf8'
  );
  await fs.mkdir(path.join(repo, 'specs', '004-multihost-runtime-governance'), { recursive: true });
  await fs.writeFile(path.join(repo, 'specs', '004-multihost-runtime-governance', 'spec.md'), '# spec\n', 'utf8');
  return repo;
}

function assertShape(report) {
  assert.deepEqual(Object.keys(report), ZONES);
  for (const zone of ZONES) {
    assert.ok(ZONE_STATUSES.has(report[zone].status), `${zone} status invalid: ${report[zone].status}`);
    assert.ok(Array.isArray(report[zone].items));
    for (const item of report[zone].items) {
      assert.ok(ITEM_STATUSES.has(item.status), `${zone} item status invalid: ${item.status}`);
      for (const key of ['status', 'code', 'message', 'fix']) {
        assert.ok(key in item, `${zone} item missing ${key}`);
      }
    }
  }
}

async function makeBinDir(names) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-doctor-bin-'));
  for (const name of names) {
    const file = path.join(dir, name);
    await fs.writeFile(file, '#!/bin/sh\nexit 0\n', 'utf8');
    await fs.chmod(file, 0o755);
  }
  return dir;
}

function findItem(zoneReport, code) {
  return zoneReport.items.find((entry) => entry.code === code);
}

async function writeIntegrationManifest(repo, { installed, active, file = 'integration.json' }) {
  const target = path.join(repo, '.specify', file);
  if (file.endsWith('.json')) {
    await fs.writeFile(target, JSON.stringify({
      version: '1.4.4.dev0',
      installed_integrations: installed,
      integration: active,
      default_integration: active,
    }), 'utf8');
  } else {
    await fs.writeFile(target, [
      'installed_integrations:',
      ...installed.map((key) => `  - ${key}`),
      `integration: ${active}`,
      '',
    ].join('\n'), 'utf8');
  }
}

async function installRenderedSkills(repo, host, names) {
  const dir = path.join(repo, host, 'skills');
  for (const name of names) {
    const skillDir = path.join(dir, name);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\n---\n`, 'utf8');
  }
}

async function makeMirrorFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-doctor-mirror-'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'superpowers', version: '7.0.2' }), 'utf8');
  const skills = path.join(root, 'skills');
  await fs.mkdir(skills, { recursive: true });
  for (const name of ['test-driven-development', 'systematic-debugging']) {
    const dir = path.join(skills, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n`, 'utf8');
  }
  return root;
}

async function snapshot(root) {
  const out = {};
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out[path.relative(root, full)] = await fs.readFile(full, 'utf8');
    }
  }
  await walk(root);
  return out;
}

test('doctor reports all five zones with the two distinct status enums (REQ-33/REQ-39)', async () => {
  const repo = await makeRepo();
  const report = await runDoctor({ cwd: repo, host: 'dsh' });
  assertShape(report);
});

test('a failing zone does not suppress the other four (REQ-33)', async () => {
  const repo = await makeRepo();
  const report = await runDoctor({
    cwd: repo,
    host: 'dsh',
    deps: {
      environment: async () => { throw new Error('probe exploded'); },
    },
  });
  assertShape(report);
  assert.equal(report.environment.status, 'fail');
  for (const zone of ZONES.filter((z) => z !== 'environment')) {
    assert.notEqual(report[zone].items.length, 0, `${zone} must still report`);
  }
});

test('repeated doctor runs are byte-identical and change no file (REQ-39)', async () => {
  const repo = await makeRepo();
  const before = await snapshot(repo);
  const first = await runDoctor({ cwd: repo, host: 'dsh' });
  const second = await runDoctor({ cwd: repo, host: 'dsh' });
  const after = await snapshot(repo);
  assert.deepEqual(first, second);
  assert.deepEqual(before, after);
});

test('doctor without network probes finishes within 5 seconds (AC-18)', async () => {
  const repo = await makeRepo();
  const started = process.hrtime.bigint();
  await runDoctor({ cwd: repo, host: 'dsh' });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs <= 5000, `doctor took ${elapsedMs.toFixed(1)}ms`);
});

test('the trigger zone scores only visible skills and executes nothing (REQ-38/AC-19)', async () => {
  const repo = await makeRepo();
  const skills = [{
    name: 'debugging', description: 'debug failing test', whenToUse: '',
    source: 'plugin', provider: 'plugin', path: '/skills/debugging',
    invocation: { userInvocable: true, modelInvocable: true },
  }];
  const report = await runDoctor({ cwd: repo, host: 'dsh', trigger: 'debug failing test', skills });
  assertShape(report);
  assert.equal(report.triggerDryRun.status, 'pass');
  assert.equal(report.triggerDryRun.items[0].code, 'TRIGGER_SCORES');
  assert.ok(report.triggerDryRun.items[0].scores[0].score > 0);
});

test('the environment zone probes uv, specify and git through the injected PATH (REQ-33)', async () => {
  const repo = await makeRepo();
  const full = await makeBinDir(['node', 'npm', 'uv', 'specify', 'git']);
  const fullReport = await runDoctor({ cwd: repo, host: 'dsh', env: { PATH: full } });
  for (const code of ['TOOL_NODE', 'TOOL_NPM', 'TOOL_UV', 'TOOL_SPECIFY', 'TOOL_GIT']) {
    const entry = findItem(fullReport.environment, code);
    assert.ok(entry, `environment zone must report ${code}`);
    assert.equal(entry.status, 'pass', `${code} should pass with an injected PATH`);
  }

  const partial = await makeBinDir(['node', 'npm']);
  const partialReport = await runDoctor({ cwd: repo, host: 'dsh', env: { PATH: partial } });
  for (const code of ['TOOL_UV', 'TOOL_GIT']) {
    const entry = findItem(partialReport.environment, code);
    assert.ok(entry, `environment zone must report ${code}`);
    assert.equal(entry.status, 'warn', `${code} should warn when absent from the injected PATH`);
  }
  // I5: rendering host artifacts is impossible without the specify CLI, so it is
  // a required tool rather than an optional convenience.
  assert.equal(findItem(partialReport.environment, 'TOOL_SPECIFY').status, 'fail');
  assert.equal(partialReport.environment.status, 'fail', 'a missing required tool must fail the zone (AC-07)');
});

test('the repository zone compares the project template override with the packaged copy (REQ-33)', async () => {
  const repo = await makeRepo();
  const packaged = await fs.readFile(path.join(PKG_ROOT, 'overrides', 'spec-template.md'), 'utf8');
  const target = path.join(repo, '.specify', 'templates', 'overrides', 'spec-template.md');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, packaged, 'utf8');

  const aligned = await runDoctor({ cwd: repo, host: 'dsh' });
  const alignedCodes = aligned.repository.items.map((entry) => entry.code);
  for (const legacy of ['VERSION_FLOOR', 'HOOK_COUNT', 'SESSION_EVENT']) {
    assert.ok(!alignedCodes.includes(legacy), `repository zone must not self-check the packaged manifest (${legacy})`);
  }
  assert.equal(findItem(aligned.repository, 'TEMPLATE_DRIFT').status, 'pass');

  await fs.writeFile(target, `${packaged}\n<!-- locally edited -->\n`, 'utf8');
  const drifted = await runDoctor({ cwd: repo, host: 'dsh' });
  assert.equal(findItem(drifted.repository, 'TEMPLATE_DRIFT').status, 'warn');

  await fs.rm(target);
  const missing = await runDoctor({ cwd: repo, host: 'dsh' });
  assert.equal(findItem(missing.repository, 'TEMPLATE_MISSING').status, 'warn');
  assert.ok(!findItem(missing.repository, 'TEMPLATE_DRIFT'), 'a missing template is not drift');
});

test('the repository zone reports which extension command skills are installed (REQ-33)', async () => {
  const repo = await makeRepo();
  const installed = path.join(repo, '.dsh', 'skills', 'speckit-superpowers-hooks-before-implement');
  await fs.mkdir(installed, { recursive: true });
  await fs.writeFile(path.join(installed, 'SKILL.md'), '---\nname: speckit-superpowers-hooks-before-implement\n---\n', 'utf8');

  const report = await runDoctor({ cwd: repo, host: 'dsh' });
  const entry = findItem(report.repository, 'COMMAND_SKILLS');
  assert.ok(entry, 'repository zone must report COMMAND_SKILLS');
  assert.match(entry.message, /1 of 6/, entry.message);
});

test('the host zone reports the effective guidance switch scope and its source (REQ-12/AC-08)', async () => {
  const repo = await makeRepo();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-doctor-home-'));
  await fs.mkdir(path.join(home, '.dsh'), { recursive: true });
  await fs.writeFile(path.join(home, '.dsh', 'sdd-kit.json'), JSON.stringify({ guidance: { enabled: false } }), 'utf8');
  const env = { ...process.env, HOME: home };

  const userOnly = findItem((await runDoctor({ cwd: repo, host: 'dsh', env })).host, 'GUIDANCE_SCOPE');
  assert.ok(userOnly, 'the host zone must report the effective guidance switch scope');
  assert.equal(userOnly.status, 'pass');
  assert.equal(userOnly.enabled, false);
  assert.equal(userOnly.effectiveScope, 'user');
  assert.match(userOnly.source, /sdd-kit\.json$/);

  const projectFile = path.join(repo, '.specify', 'sdd-kit.json');
  await fs.writeFile(projectFile, JSON.stringify({ guidance: { enabled: true } }), 'utf8');
  const overridden = findItem((await runDoctor({ cwd: repo, host: 'dsh', env })).host, 'GUIDANCE_SCOPE');
  assert.equal(overridden.enabled, true);
  assert.equal(overridden.effectiveScope, 'project');
  assert.equal(overridden.source, projectFile);
});

test('the host zone reports the guidance channel version and the rendered hook skills (REQ-33)', async () => {
  const repo = await makeRepo();
  const pkg = JSON.parse(await fs.readFile(path.join(PKG_ROOT, 'package.json'), 'utf8'));
  const report = await runDoctor({ cwd: repo, host: 'dsh' });

  const guidance = findItem(report.host, 'GUIDANCE_CHANNEL');
  assert.ok(guidance, 'host zone must report GUIDANCE_CHANNEL');
  assert.match(guidance.message, /host=dsh/);
  assert.match(guidance.message, /channel=system-prompt/);
  assert.match(guidance.message, new RegExp(`version=${pkg.version.replace(/\./g, '\\.')}`));

  const rendering = findItem(report.host, 'HOOK_RENDERING');
  assert.ok(rendering, 'host zone must report HOOK_RENDERING');
  assert.match(rendering.message, /rendered=0/, rendering.message);
  // I4: without an integration manifest nothing can be verified, so zero rendered
  // hook skills is an unverified state, not a healthy one.
  assert.equal(rendering.status, 'warn', 'zero rendered hooks without a manifest cannot be claimed healthy');
  assert.match(rendering.fix, /安装扩展|specify integration/);
});

test('I4: with a manifest an active unrendered end fails and an inactive one warns', async () => {
  const repo = await makeRepo();
  await writeIntegrationManifest(repo, { installed: ['dsh'], active: 'dsh' });
  const activeUnrendered = findItem((await runDoctor({ cwd: repo, host: 'dsh' })).host, 'HOOK_RENDERING');
  assert.equal(activeUnrendered.status, 'fail', activeUnrendered.message);
  assert.match(activeUnrendered.fix, /specify integration switch/);

  // The active/inactive distinction must drive the verdict, not just the label:
  // a fully rendered active end passes while an unrendered inactive end warns,
  // and the zone-level verdict takes the worst end.
  await writeIntegrationManifest(repo, { installed: ['dsh', 'claude'], active: 'dsh' });
  await installRenderedSkills(repo, '.dsh', HOOK_COMMAND_SKILLS);
  const mixed = findItem((await runDoctor({ cwd: repo, host: 'dsh' })).host, 'HOOK_RENDERING');
  assert.equal(mixed.status, 'warn', mixed.message);
  const dshEnd = mixed.integrations.find((entry) => entry.integration === 'dsh');
  assert.equal(dshEnd.active, true);
  assert.equal(dshEnd.status, 'pass', dshEnd.fix);
  const claudeEnd = mixed.integrations.find((entry) => entry.integration === 'claude');
  assert.equal(claudeEnd.active, false);
  assert.equal(claudeEnd.status, 'warn');
});

test('I4: a manifest with zero installed ends still reports the manifest, never a silent pass', async () => {
  const repo = await makeRepo();
  await fs.writeFile(
    path.join(repo, '.specify', 'integration.json'),
    JSON.stringify({ version: '1.4.4.dev0', installed_integrations: [], integration: null }),
    'utf8'
  );
  const report = await runDoctor({ cwd: repo, host: 'dsh' });
  const state = findItem(report.host, 'INTEGRATION_STATE');
  assert.equal(state.status, 'skip', state.message);
  const rendering = findItem(report.host, 'HOOK_RENDERING');
  assert.equal(rendering.status, 'warn', rendering.message);
});

test('pending markers are classified relative to the run/session, not a fixed 24h', async () => {
  const repo = await makeRepo();
  const now = Date.now();
  const markerFile = path.join(repo, '.specify', 'sdd-pending.json');
  const stale = new Date(now - 48 * 3600 * 1000).toISOString();
  const fresh = new Date(now - 60 * 1000).toISOString();
  await fs.writeFile(markerFile, JSON.stringify({
    dsh: { host: 'dsh', layer: 'tool_code', timestamp: stale, reason: 'old', runId: 'run-A' },
    claude: { host: 'claude', layer: 'skill_data', timestamp: fresh, reason: 'fresh' },
  }), 'utf8');

  const sameRun = findItem((await runDoctor({
    cwd: repo, host: 'dsh', now, sessionStart: new Date(now - 30 * 60 * 1000).toISOString(), runId: 'run-A',
  })).runtime, 'PENDING_MARKERS');
  assert.deepEqual(sameRun.pending, ['claude', 'dsh']);
  assert.deepEqual(sameRun.history, []);
  assert.match(sameRun.fix, /bin\/sdd-kit\.mjs/);
  assert.match(sameRun.fix, /--cwd/);

  const baseline = findItem((await runDoctor({
    cwd: repo, host: 'dsh', now, sessionStart: new Date(now - 30 * 60 * 1000).toISOString(), runId: 'run-B',
  })).runtime, 'PENDING_MARKERS');
  assert.deepEqual(baseline.pending, ['claude']);
  assert.deepEqual(baseline.history, ['dsh']);
  assert.match(baseline.fix, /bin\/sdd-kit\.mjs/);
});

test('a marker just written is pending even when the caller passes no baseline (C1)', async () => {
  const repo = await makeRepo();
  const now = Date.parse('2026-11-24T12:00:00.000Z');
  await fs.writeFile(path.join(repo, '.specify', 'sdd-pending.json'), JSON.stringify({
    dsh: { host: 'dsh', layer: 'tool_code', timestamp: new Date(now - 2000).toISOString(), reason: 'just now', runId: null },
  }), 'utf8');

  // The production CLI/register path forwards neither sessionStart nor runId.
  const item = findItem((await runDoctor({ cwd: repo, host: 'dsh', now })).runtime, 'PENDING_MARKERS');
  assert.equal(item.status, 'warn');
  assert.deepEqual(item.pending, ['dsh'], `a fresh marker must not be history: ${item.message}`);
  assert.deepEqual(item.history, []);
  assert.match(item.message, /pending markers: dsh/);
});

test('the bridge source probe is read-only and honestly skipped when nothing is discoverable (REQ-33)', async () => {
  const repo = await makeRepo();
  const bareEnv = { PATH: process.env.PATH ?? '' };
  const unprobed = findItem((await runDoctor({ cwd: repo, host: 'dsh', env: bareEnv })).runtime, 'BRIDGE_SOURCE');
  assert.equal(unprobed.status, 'skip');
  assert.match(unprobed.message, /not/i, unprobed.message);

  const config = path.join(repo, 'host-cordis.yml');
  await fs.writeFile(config, 'plugins:\n  - name: dsh-sdd-kit\n    source: local\n', 'utf8');
  const probed = findItem((await runDoctor({ cwd: repo, host: 'dsh', env: { ...bareEnv, DSH_CONFIG: config } })).runtime, 'BRIDGE_SOURCE');
  assert.equal(probed.status, 'pass', probed.message);
  assert.match(probed.message, /host-cordis\.yml/, probed.message);

  // A host profile directory keeps the mount in cordis.patch.yml, not cordis.yml.
  const profile = path.join(repo, 'profile');
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(profile, 'cordis.yml'), 'plugins: []\n', 'utf8');
  await fs.writeFile(path.join(profile, 'cordis.patch.yml'), '- name: dsh-sdd-kit\n', 'utf8');
  const viaProfile = findItem((await runDoctor({ cwd: repo, host: 'dsh', env: { ...bareEnv, DSH_PROFILE_DIR: profile } })).runtime, 'BRIDGE_SOURCE');
  assert.equal(viaProfile.status, 'pass', viaProfile.message);
  assert.match(viaProfile.message, /cordis\.patch\.yml/, viaProfile.message);

  // A profile may also declare the mount only in its package.json bundles list.
  const pkgProfile = path.join(repo, 'profile-pkg');
  await fs.mkdir(pkgProfile, { recursive: true });
  await fs.writeFile(path.join(pkgProfile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: { 'dsh-sdd-kit': 'github:bobo522487/dsh-sdd-kit' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-sdd-kit'] } },
  }), 'utf8');
  const viaPackageJson = findItem((await runDoctor({ cwd: repo, host: 'dsh', env: { ...bareEnv, DSH_PROFILE_DIR: pkgProfile } })).runtime, 'BRIDGE_SOURCE');
  assert.equal(viaPackageJson.status, 'pass', viaPackageJson.message);
  assert.match(viaPackageJson.message, /package\.json/, viaPackageJson.message);
});

test('a zone with no executed work is skipped or not_executed, never pass (REQ-33)', async () => {
  const repo = await makeRepo();
  const notRun = await runDoctor({ cwd: repo, host: 'dsh' });
  assert.equal(notRun.triggerDryRun.status, 'not_executed');
  assert.equal(notRun.triggerDryRun.items[0].code, 'TRIGGER_NOT_PROVIDED');

  const nothingVisible = await runDoctor({ cwd: repo, host: 'dsh', trigger: 'debug failing test', skills: [] });
  assert.equal(nothingVisible.triggerDryRun.status, 'skipped');
  assert.equal(nothingVisible.triggerDryRun.items[0].code, 'TRIGGER_NO_VISIBLE_SKILLS');
});

test('CLI doctor exposes the five zones as JSON (T054)', async () => {
  const repo = await makeRepo();
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['bin/sdd-kit.mjs', 'doctor', '--json', '--cwd', repo], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assertShape(JSON.parse(result.stdout));
});

// Phase 12 fixtures: every path below lives in a temp dir, never the real HOME.
const HOOK_COMMAND_SKILLS = [
  'speckit-superpowers-hooks-before-implement',
  'speckit-superpowers-hooks-after-implement',
  'speckit-superpowers-hooks-before-bug-fix',
  'speckit-superpowers-hooks-after-bug-fix',
  'speckit-superpowers-hooks-guard',
  'speckit-superpowers-hooks-guidance',
];

test('T072: installed integrations are listed and an inactive unrendered end is warned', async () => {
  const repo = await makeRepo();
  await writeIntegrationManifest(repo, { installed: ['dsh', 'claude'], active: 'dsh' });
  await installRenderedSkills(repo, '.dsh', HOOK_COMMAND_SKILLS);

  const report = await runDoctor({ cwd: repo, host: 'dsh' });
  const state = findItem(report.host, 'INTEGRATION_STATE');
  assert.ok(state, 'INTEGRATION_STATE must be reported');
  assert.equal(state.status, 'pass');
  assert.deepEqual(state.installed, ['claude', 'dsh']);
  assert.equal(state.active, 'dsh');

  const rendering = findItem(report.host, 'HOOK_RENDERING');
  assert.notEqual(rendering.status, 'pass', 'unrendered integration must not be claimed as healthy');
  assert.equal(rendering.status, 'warn');
  const claude = rendering.integrations.find((entry) => entry.integration === 'claude');
  assert.equal(claude.active, false);
  assert.equal(claude.renderedCount, 0);
  assert.deepEqual(claude.missingCommands, [...HOOK_COMMAND_SKILLS].sort());
  assert.equal(claude.missingHooks.length, 4);
  assert.match(claude.fix, /specify integration switch claude/);
  assert.match(claude.fix, /specify extension add/);
});

test('T072: a single fully rendered integration is pass, integrations.yml is readable', async () => {
  const repo = await makeRepo();
  await writeIntegrationManifest(repo, { installed: ['dsh', 'cursor-agent'], active: 'dsh', file: 'integrations.yml' });
  await installRenderedSkills(repo, '.dsh', HOOK_COMMAND_SKILLS);

  const report = await runDoctor({ cwd: repo, host: 'dsh' });
  const state = findItem(report.host, 'INTEGRATION_STATE');
  assert.equal(state.status, 'pass');
  assert.deepEqual(state.installed, ['cursor-agent', 'dsh']);
  assert.match(state.source, /integrations\.yml$/);
  const rendering = findItem(report.host, 'HOOK_RENDERING');
  assert.equal(rendering.status, 'warn');
  assert.match(rendering.message, /rendered=6 of 6/);
  const cursor = rendering.integrations.find((entry) => entry.integration === 'cursor-agent');
  assert.equal(cursor.skillsDir, '.cursor/skills');
  assert.equal(cursor.status, 'warn');
});

test('T073: Cursor trust warnings use the capability pattern, not flag count', async () => {
  const repo = await makeRepo();
  const harmless = findItem((await runDoctor({ cwd: repo, host: 'cursor', trustFlags: ['--harmless', '--verbose'] })).host, 'CURSOR_TRUST');
  assert.equal(harmless.status, 'pass', harmless.message);
  assert.doesNotMatch(harmless.message, /--harmless/);

  const unsafe = await runDoctor({ cwd: repo, host: 'cursor', trustFlags: ['--harmless', '--trust', '--force'] });
  const trust = findItem(unsafe.host, 'CURSOR_TRUST');
  assert.equal(trust.status, 'warn', trust.message);
  assert.match(trust.message, /--trust/);
  assert.match(trust.message, /--force/);
  assert.doesNotMatch(trust.message, /--harmless/);
});

test('T074: environment probes the upstream mirror and discipline skills read-only', async () => {
  const repo = await makeRepo();
  const bin = await makeBinDir(['node', 'npm', 'uv', 'specify', 'git']);
  const mirror = await makeMirrorFixture();
  const env = { PATH: bin, DSH_SDD_KIT_SUPERPOWERS_DIR: mirror };

  const ok = await runDoctor({ cwd: repo, host: 'dsh', env });
  const upstream = findItem(ok.environment, 'UPSTREAM_MIRROR');
  assert.equal(upstream.status, 'pass', upstream.message);
  const skills = findItem(ok.environment, 'DISCIPLINE_SKILLS');
  assert.equal(skills.status, 'pass', skills.message);
  assert.equal(skills.count, 2);
  assert.equal(findItem(ok.environment, 'NETWORK_PROBE').status, 'skip');

  // A file at the declared mirror path is unreadable as a directory; because
  // it resolves, the candidate selector does not fall back to the real HOME.
  const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-doctor-empty-mirror-'));
  const empty = path.join(emptyRoot, 'not-a-mirror');
  await fs.writeFile(empty, 'not a directory\n', 'utf8');
  const missing = await runDoctor({ cwd: repo, host: 'dsh', env: { PATH: bin, DSH_SDD_KIT_SUPERPOWERS_DIR: empty } });
  const noMirror = findItem(missing.environment, 'DISCIPLINE_SKILLS');
  assert.equal(noMirror.status, 'fail', noMirror.message);
  assert.match(noMirror.fix, /specify self upgrade/);
  const noUpstream = findItem(missing.environment, 'UPSTREAM_MIRROR');
  assert.equal(noUpstream.status, 'fail', noUpstream.message);
  assert.match(noUpstream.fix, /git clone/);
  // I5/AC-07: an unreadable upstream mirror is an environment failure, so the
  // zone may not keep claiming `pass` while both items only warn.
  assert.equal(missing.environment.status, 'fail', 'a missing upstream mirror must fail the environment zone');
});

test('T075: guidance channel reports the real discipline skill version, not the kit version', async () => {
  const repo = await makeRepo();
  const pkg = JSON.parse(await fs.readFile(path.join(PKG_ROOT, 'package.json'), 'utf8'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-doctor-skill-'));
  const skillPath = path.join(root, 'SKILL.md');
  await fs.writeFile(skillPath, '---\nname: test-driven-development\nversion: 9.9.9\nmetadata:\n  author: obra\n---\n', 'utf8');

  const report = await runDoctor({
    cwd: repo,
    host: 'dsh',
    skills: [{
      name: 'test-driven-development',
      description: 'TDD',
      whenToUse: '',
      source: 'plugin:superpowers',
      provider: 'plugin',
      path: skillPath,
    }],
  });
  const channel = findItem(report.host, 'GUIDANCE_CHANNEL');
  assert.match(channel.message, /version=9\.9\.9/);
  assert.notEqual(channel.version, pkg.version);
  assert.equal(channel.versionSource, 'skill-metadata');
  assert.match(channel.message, /channel=/);
  assert.match(channel.source, /plugin/);

  const fallback = findItem((await runDoctor({ cwd: repo, host: 'dsh' })).host, 'GUIDANCE_CHANNEL');
  assert.equal(fallback.version, pkg.version);
  assert.match(fallback.message, /kit-package-fallback/);
});

test('T076: runtime reports every skill and a conflict winner with provider order', async () => {
  const repo = await makeRepo();
  const skills = [
    { name: 'speckit-implement', description: '', whenToUse: '', source: 'bundled', provider: 'dsh', path: '/fake/bundled/speckit-implement/SKILL.md' },
    { name: 'speckit-implement', description: '', whenToUse: '', source: 'user-dsh', provider: 'user', path: '/fake/user/speckit-implement/SKILL.md' },
    { name: 'debugging', description: '', whenToUse: '', source: 'plugin:superpowers', provider: 'plugin', path: '/fake/plugin/debugging/SKILL.md' },
  ];
  const report = await runDoctor({ cwd: repo, host: 'dsh', skills });
  const inventory = findItem(report.runtime, 'SKILL_INVENTORY');
  assert.equal(inventory.skills.length, 3);
  for (const skill of inventory.skills) {
    for (const key of ['name', 'provider', 'path', 'source']) assert.ok(skill[key], `${key} must be reported`);
  }

  const conflict = findItem(report.runtime, 'SKILL_CONFLICT');
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(conflict.conflicts[0].name, 'speckit-implement');
  assert.equal(conflict.conflicts[0].winner.provider, 'user');
  assert.deepEqual(conflict.conflicts[0].order, ['user', 'dsh']);
  assert.match(conflict.message, /user/);
  assert.match(conflict.message, /bundled|dsh/);
});

test('T078: user-authored skills are labeled non-kit artifacts, never drift', async () => {
  const repo = await makeRepo();
  const report = await runDoctor({
    cwd: repo,
    host: 'claude',
    skills: [{
      name: 'my-private-skill',
      description: 'private',
      whenToUse: '',
      source: 'user-dsh',
      provider: 'user',
      path: '/fake/home/.dsh/skills/my-private-skill',
    }],
  });
  const provenance = findItem(report.runtime, 'SKILL_PROVENANCE');
  assert.equal(provenance.status, 'pass');
  assert.equal(provenance.userSkills.length, 1);
  assert.equal(provenance.userSkills[0].name, 'my-private-skill');
  assert.match(provenance.message, /非本套件产物/);
  assert.ok(report.runtime.items.some((entry) => entry.code === 'SKILL_CONFLICT'));
  assert.ok(report.runtime.items.every((entry) => !entry.code.includes('DRIFT')));
});
