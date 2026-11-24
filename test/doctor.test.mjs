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
  for (const code of ['TOOL_UV', 'TOOL_SPECIFY', 'TOOL_GIT']) {
    const entry = findItem(partialReport.environment, code);
    assert.ok(entry, `environment zone must report ${code}`);
    assert.equal(entry.status, 'warn', `${code} should warn when absent from the injected PATH`);
  }
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
  assert.equal(rendering.status, 'pass', 'a non-active host legitimately renders zero hook skills');
});

test('pending markers distinguish recent entries from history (REQ-33)', async () => {
  const repo = await makeRepo();
  const now = Date.now();
  const markerFile = path.join(repo, '.specify', 'sdd-pending.json');
  await fs.writeFile(markerFile, JSON.stringify({
    dsh: { host: 'dsh', layer: 'tool_code', timestamp: new Date(now - 48 * 3600 * 1000).toISOString(), reason: 'old' },
    claude: { host: 'claude', layer: 'skill_data', timestamp: new Date(now - 60 * 1000).toISOString(), reason: 'fresh' },
  }), 'utf8');

  const mixed = findItem((await runDoctor({ cwd: repo, host: 'dsh' })).runtime, 'PENDING_MARKERS');
  assert.equal(mixed.status, 'warn');
  assert.deepEqual(mixed.pending, ['claude']);
  assert.deepEqual(mixed.history, ['dsh']);

  await fs.writeFile(markerFile, JSON.stringify({
    dsh: { host: 'dsh', layer: 'tool_code', timestamp: new Date(now - 48 * 3600 * 1000).toISOString(), reason: 'old' },
  }), 'utf8');
  const historyOnly = findItem((await runDoctor({ cwd: repo, host: 'dsh' })).runtime, 'PENDING_MARKERS');
  assert.deepEqual(historyOnly.pending, []);
  assert.deepEqual(historyOnly.history, ['dsh']);
  assert.match(historyOnly.message, /history/i, historyOnly.message);
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
