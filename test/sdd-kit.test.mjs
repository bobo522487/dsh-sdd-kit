import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runUpstream } from '../src/core/upstream.mjs';
import { runBridge } from '../src/core/bridge.mjs';
import { runUpdate } from '../src/core/update.mjs';
import { refreshInstalledKit } from '../src/core/kit-copy.mjs';
import { registerSddTools } from '../src/register.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sdd-kit-v2-test-'));
}

async function writeSeed(root, relativePath, content) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

async function seedKitSource(root, { marker = 'source' } = {}) {
  await writeSeed(
    root,
    'package.json',
    `${JSON.stringify({ name: 'dsh-sdd-kit', version: '0.3.0', type: 'module', files: ['src/', 'skills/', 'overrides/', 'cordis.patch.yml', 'README.md', 'LICENSE'] }, null, 2)}\n`
  );
  await writeSeed(root, 'src/index.mjs', `export const marker = '${marker}';\n`);
  await writeSeed(root, 'src/core/update.mjs', `export const marker = '${marker}';\n`);
  await writeSeed(root, 'skills/sdd-update/SKILL.md', `---\nname: sdd-update\n---\n# /sdd-update\n${marker}\n`);
  await writeSeed(root, 'overrides/spec-template.md', `# override ${marker}\n`);
  await writeSeed(root, 'cordis.patch.yml', `# ${marker}\n`);
  await writeSeed(root, 'README.md', `# ${marker}\n`);
  await writeSeed(root, 'LICENSE', `MIT ${marker}\n`);
}

async function snapshotTree(root) {
  const snapshot = {};
  async function walk(dir, relative = '') {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(absolute, relativePath);
      } else if (entry.isSymbolicLink()) {
        snapshot[relativePath] = `symlink:${await fs.readlink(absolute)}`;
      } else {
        snapshot[relativePath] = (await fs.readFile(absolute)).toString('base64');
      }
    }
  }
  await walk(root);
  return snapshot;
}

test('sdd_upstream delegates cleanly to specify CLI and git without reimplementing them', async () => {
  const cwd = await makeTempDir();
  const spDir = path.join(cwd, 'superpowers-mirror');
  const calls = [];
  const mockRunner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'specify' && args[0] === '--version') return { ok: true, code: 0, stdout: 'specify 1.3.1', stderr: '' };
    if (cmd === 'uv') return { ok: true, code: 0, stdout: 'uv 0.6.0', stderr: '' };
    if (cmd === 'git') return { ok: true, code: 0, stdout: 'git version 2.45', stderr: '' };
    return { ok: true, code: 0, stdout: 'ok', stderr: '' };
  };

  try {
    const status = await runUpstream({ action: 'status', cwd, superpowersDir: spDir }, mockRunner);
    assert.equal(status.specifyCli.installed, true);
    assert.equal(status.specifyCli.version, 'specify 1.3.1');
    assert.equal(status.superpowers.installed, false);

    const cloneRes = await runUpstream({ action: 'sync_superpowers', cwd, superpowersDir: spDir }, mockRunner);
    assert.equal(cloneRes.mode, 'clone');
    assert.ok(calls.some((c) => c[0] === 'git' && c[1] === 'clone'));

    const initRes = await runUpstream({ action: 'specify_init', cwd }, mockRunner);
    assert.equal(initRes.ok, true);
    const initCall = calls.find((c) => c[0] === 'specify' && c[1] === 'init');
    assert.ok(initCall, 'expected a specify init call');
    for (const flag of ['--non-interactive', '--force', '--ignore-agent-tools']) {
      assert.ok(initCall.includes(flag), `expected ${flag} in: ${initCall.join(' ')}`);
    }
    assert.ok(!initCall.includes('--integration-options=--skills'), 'must not emit deprecated --skills by default');

    const bugRes = await runUpstream({ action: 'install_bug_ext', cwd }, mockRunner);
    assert.equal(bugRes.ok, true);
    assert.ok(calls.some((c) => c.join(' ') === 'specify extension add bug'));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('specify_init emits --skills only on explicit opt-in', async () => {
  const calls = [];
  const mockRunner = async (cmd, args) => { calls.push([cmd, ...args]); return { ok: true, code: 0, stdout: '', stderr: '' }; };
  await runUpstream({ action: 'specify_init', cwd: process.cwd(), useSkills: true }, mockRunner);
  const initCall = calls.find((c) => c[0] === 'specify' && c[1] === 'init');
  assert.ok(initCall.includes('--integration-options=--skills'));
});

test('sdd_bridge inspects features & bugs, installs EARS overrides, checks tasks, and syncs specs/INDEX.md', async () => {
  const cwd = await makeTempDir();
  try {
    // Seed a Spec Kit feature and bug directory
    const featDir = path.join(cwd, 'specs', '001-user-auth');
    const bugDir = path.join(cwd, '.specify', 'bugs', 'login-crash');
    await fs.mkdir(featDir, { recursive: true });
    await fs.mkdir(bugDir, { recursive: true });
    await fs.writeFile(path.join(featDir, 'spec.md'), '# Spec\n', 'utf8');
    await fs.writeFile(path.join(featDir, 'plan.md'), '# Plan\n', 'utf8');
    await fs.writeFile(
      path.join(featDir, 'tasks.md'),
      `# Tasks\n- [ ] T001 Setup JWT helper\n- [ ] T002 [P] Add login endpoint\n`,
      'utf8'
    );
    await fs.writeFile(path.join(bugDir, 'assessment.md'), '# Bug Assessment\n', 'utf8');

    // Install EARS + Non-Goals override
    const ov1 = await runBridge({ action: 'install_overrides', cwd });
    assert.equal(ov1.status, 'written');
    const ov2 = await runBridge({ action: 'install_overrides', cwd });
    assert.equal(ov2.status, 'skipped_existing');

    // Inspect
    const info = await runBridge({ action: 'inspect', cwd });
    assert.equal(info.hasEarsOverride, true);
    assert.equal(info.selectedFeature.name, '001-user-auth');
    assert.equal(info.selectedFeature.tasks.total, 2);
    assert.equal(info.selectedFeature.tasks.parallelCount, 1);
    assert.equal(info.selectedBug.slug, 'login-crash');

    // Check off T001
    const chk = await runBridge({ action: 'check_task', cwd, featureName: '001-user-auth', taskMatch: 'T001' });
    assert.equal(chk.progress.done, 1);
    assert.equal(chk.progress.remaining, 1);
    assert.equal(chk.nextTask.id, 'T002');

    // Sync specs/INDEX.md
    const idx = await runBridge({ action: 'sync_index', cwd });
    assert.equal(idx.featureCount, 1);
    const indexMd = await fs.readFile(idx.indexPath, 'utf8');
    assert.match(indexMd, /`001-user-auth` \| In Progress \(1\/2\)/);

    // Path traversal guard
    await assert.rejects(
      () => runBridge({ action: 'check_task', cwd, featureName: '../escape', taskMatch: 'T001' }),
      /Invalid featureName/
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('Cordis registerSddTools registers sdd_upstream and sdd_bridge with valid render contract', () => {
  const registered = [];
  const mockCtx = {
    tools: {
      register(def) {
        registered.push(def);
        return () => {};
      },
    },
  };
  const disposers = registerSddTools(mockCtx, (d) => d);
  assert.equal(disposers.length, 2);
  assert.deepEqual(
    registered.map((t) => t.name),
    ['sdd_upstream', 'sdd_bridge']
  );
  for (const tool of registered) {
    const out = tool.output.render({}, { ok: true });
    assert.equal(out[0].type, 'text');
  }
});

test('skills/ contains exactly 3 user-only bridge skills matching DSH frontmatter contract', async () => {
  const skillsDir = path.join(PKG_ROOT, 'skills');
  const dirs = (await fs.readdir(skillsDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  assert.deepEqual(dirs, ['sdd-implement', 'sdd-setup', 'sdd-update']);

  for (const dir of dirs) {
    const raw = await fs.readFile(path.join(skillsDir, dir, 'SKILL.md'), 'utf8');
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || '';
    assert.match(fm, new RegExp(`^name:\\s*${dir}$`, 'm'));
    assert.match(fm, /^description:\s*.+/m);
    assert.match(fm, /^disable-model-invocation:\s*true$/m);
  }
});

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

test('runUpdate AC-01: all-behind components produce three updated records with before/after', async () => {
  const cwd = await makeTempDir();
  let specifyVersion = 'specify 1.3.1';
  let superpowersHead = 'aaaaaaa';
  let superpowersSkillCount = 2;
  const runUpstreamFake = async (args) => {
    if (args.action === 'status') {
      return {
        action: 'status',
        cwd: args.cwd,
        specifyCli: { installed: true, version: specifyVersion, error: null },
        superpowers: { installed: true, dir: args.superpowersDir, head: superpowersHead, skillCount: superpowersSkillCount },
      };
    }
    if (args.action === 'specify_upgrade') {
      specifyVersion = 'specify 1.4.0';
      return { action: 'specify_upgrade', ok: true, code: 0, mode: 'upgrade', stdout: '', stderr: '' };
    }
    if (args.action === 'sync_superpowers') {
      superpowersHead = 'bbbbbbb';
      superpowersSkillCount = 3;
      return { action: 'sync_superpowers', ok: true, code: 0, mode: 'pull', skillCount: 3, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected upstream action: ${args.action}`);
  };
  const refreshKit = async () => ({
    changed: true,
    beforeHash: 'sha256:old',
    afterHash: 'sha256:new',
    changedFiles: ['src/core/update.mjs'],
    destDir: '/tmp/profile/node_modules/dsh-sdd-kit',
    mode: 'updated',
  });

  try {
    const report = await runUpdate(
      { cwd, dshKitSourceDir: '/tmp/kit-source', dshProfileDir: '/tmp/profile' },
      { runUpstream: runUpstreamFake, refreshKit }
    );
    assert.equal(report.action, 'update');
    assert.equal(report.ok, true);
    assert.equal(report.cwd, path.resolve(cwd));
    assert.equal(report.requiresRestart, true);
    assert.deepEqual(
      report.components.map((record) => record.component),
      ['spec-kit', 'superpowers', 'dsh-sdd-kit']
    );
    assert.deepEqual(
      report.components.map((record) => record.outcome),
      ['updated', 'updated', 'updated']
    );
    assert.equal(report.components[0].before, 'specify 1.3.1');
    assert.equal(report.components[0].after, 'specify 1.4.0');
    assert.equal(report.components[1].before, 'aaaaaaa');
    assert.equal(report.components[1].after, 'bbbbbbb');
    assert.equal(report.components[2].before, 'sha256:old');
    assert.equal(report.components[2].after, 'sha256:new');
    assert.deepEqual(report.errors, []);
    for (const record of report.components) assert.equal(record.error, null);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runUpdate AC-02: all-current components are unchanged without effective changes', async () => {
  const cwd = await makeTempDir();
  const runUpstreamFake = async (args) => {
    if (args.action === 'status') {
      return {
        action: 'status',
        cwd: args.cwd,
        specifyCli: { installed: true, version: 'specify 1.4.0', error: null },
        superpowers: { installed: true, dir: args.superpowersDir, head: 'bbbbbbb', skillCount: 3 },
      };
    }
    if (args.action === 'specify_upgrade') {
      return { action: 'specify_upgrade', ok: true, code: 0, mode: 'upgrade', stdout: 'already current', stderr: '' };
    }
    if (args.action === 'sync_superpowers') {
      return { action: 'sync_superpowers', ok: true, code: 0, mode: 'pull', skillCount: 3, stdout: 'Already up to date.', stderr: '' };
    }
    throw new Error(`unexpected upstream action: ${args.action}`);
  };
  const refreshKit = async () => ({
    changed: false,
    beforeHash: 'sha256:same',
    afterHash: 'sha256:same',
    changedFiles: [],
    destDir: '/tmp/profile/node_modules/dsh-sdd-kit',
    mode: 'unchanged',
  });

  try {
    const report = await runUpdate(
      { cwd, dshKitSourceDir: '/tmp/kit-source', dshProfileDir: '/tmp/profile' },
      { runUpstream: runUpstreamFake, refreshKit }
    );
    assert.equal(report.ok, true);
    assert.equal(report.requiresRestart, false);
    assert.deepEqual(
      report.components.map((record) => record.outcome),
      ['unchanged', 'unchanged', 'unchanged']
    );
    for (const record of report.components) {
      assert.equal(record.before, record.after);
      assert.equal(record.followUp, null);
      assert.equal(record.error, null);
    }
    assert.deepEqual(report.errors, []);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runUpdate AC-03: a Superpowers failure is isolated and still reports other components', async () => {
  const cwd = await makeTempDir();
  let specifyVersion = 'specify 1.3.1';
  const runUpstreamFake = async (args) => {
    if (args.action === 'status') {
      return {
        action: 'status',
        cwd: args.cwd,
        specifyCli: { installed: true, version: specifyVersion, error: null },
        superpowers: { installed: true, dir: args.superpowersDir, head: 'aaaaaaa', skillCount: 3 },
      };
    }
    if (args.action === 'specify_upgrade') {
      specifyVersion = 'specify 1.4.0';
      return { action: 'specify_upgrade', ok: true, code: 0, mode: 'upgrade', stdout: '', stderr: '' };
    }
    if (args.action === 'sync_superpowers') {
      return {
        action: 'sync_superpowers',
        ok: false,
        code: 128,
        mode: 'pull',
        skillCount: 3,
        stdout: '',
        stderr: 'fatal: could not read from remote repository',
      };
    }
    throw new Error(`unexpected upstream action: ${args.action}`);
  };
  const refreshKit = async () => ({
    changed: true,
    beforeHash: 'sha256:old',
    afterHash: 'sha256:new',
    changedFiles: ['skills/sdd-update/SKILL.md'],
    destDir: '/tmp/profile/node_modules/dsh-sdd-kit',
    mode: 'updated',
  });

  try {
    const report = await runUpdate(
      { cwd, dshKitSourceDir: '/tmp/kit-source', dshProfileDir: '/tmp/profile' },
      { runUpstream: runUpstreamFake, refreshKit }
    );
    assert.equal(report.ok, false);
    assert.deepEqual(
      report.components.map((record) => record.component),
      ['spec-kit', 'superpowers', 'dsh-sdd-kit']
    );
    assert.deepEqual(
      report.components.map((record) => record.outcome),
      ['updated', 'failed', 'updated']
    );
    assert.equal(report.components[1].error !== null, true);
    assert.match(report.components[1].error.message, /Superpowers update failed:/);
    assert.match(report.components[1].error.message, /could not read from remote repository/);
    assert.equal(report.components[0].after, 'specify 1.4.0');
    assert.equal(report.components[2].after, 'sha256:new');
    assert.deepEqual(
      report.errors.map((entry) => entry.component),
      ['superpowers']
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runUpdate AC-04: missing dsh-kit source fails that component but keeps upstream records', async () => {
  const cwd = await makeTempDir();
  const profileDir = await makeTempDir();
  const runUpstreamFake = async (args) => {
    if (args.action === 'status') {
      return {
        action: 'status',
        cwd: args.cwd,
        specifyCli: { installed: true, version: 'specify 1.4.0', error: null },
        superpowers: { installed: true, dir: args.superpowersDir, head: 'bbbbbbb', skillCount: 3 },
      };
    }
    if (args.action === 'specify_upgrade') {
      return { action: 'specify_upgrade', ok: true, code: 0, mode: 'upgrade', stdout: '', stderr: '' };
    }
    if (args.action === 'sync_superpowers') {
      return { action: 'sync_superpowers', ok: true, code: 0, mode: 'pull', skillCount: 3, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected upstream action: ${args.action}`);
  };

  try {
    const report = await runUpdate(
      { cwd, dshProfileDir: profileDir },
      { runUpstream: runUpstreamFake }
    );
    assert.equal(report.ok, false);
    assert.equal(report.components.length, 3);
    assert.deepEqual(
      report.components.map((record) => record.outcome),
      ['unchanged', 'unchanged', 'failed']
    );
    assert.match(report.components[2].error.message, /No dsh-sdd-kit source configured/);
    assert.deepEqual(
      report.errors.map((entry) => entry.component),
      ['dsh-sdd-kit']
    );
    assert.equal(report.errors[0].message, report.components[2].error.message);
    assert.equal(report.requiresRestart, false);
    assert.equal(await fs.stat(profileDir).then((s) => s.isDirectory()), true);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(profileDir, { recursive: true, force: true });
  }
});

test('runUpdate AC-05: leaves project specs, plans, tasks, and app source byte-identical', async () => {
  const cwd = await makeTempDir();
  const sourceDir = await makeTempDir();
  const profileDir = await makeTempDir();
  const actions = [];
  const runUpstreamFake = async (args) => {
    actions.push(args.action);
    if (args.action === 'status') {
      return {
        action: 'status',
        cwd: args.cwd,
        specifyCli: { installed: true, version: 'specify 1.4.0', error: null },
        superpowers: { installed: true, dir: args.superpowersDir, head: 'bbbbbbb', skillCount: 3 },
      };
    }
    if (args.action === 'specify_upgrade') {
      return { action: 'specify_upgrade', ok: true, code: 0, mode: 'upgrade', stdout: '', stderr: '' };
    }
    if (args.action === 'sync_superpowers') {
      return { action: 'sync_superpowers', ok: true, code: 0, mode: 'pull', skillCount: 3, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected upstream action: ${args.action}`);
  };

  try {
    await writeSeed(cwd, 'specs/001-demo/spec.md', '# demo spec\n');
    await writeSeed(cwd, 'specs/001-demo/plan.md', '# demo plan\n');
    await writeSeed(cwd, 'specs/001-demo/tasks.md', '- [ ] T001 demo\n');
    await writeSeed(cwd, '.specify/memory/constitution.md', '# constitution\n');
    await writeSeed(cwd, 'src/app.js', 'export const app = true;\n');
    await seedKitSource(sourceDir, { marker: 'source' });

    const before = await snapshotTree(cwd);
    const report = await runUpdate(
      { cwd, dshKitSourceDir: sourceDir, dshProfileDir: profileDir },
      { runUpstream: runUpstreamFake }
    );
    const after = await snapshotTree(cwd);

    assert.deepEqual(after, before);
    assert.equal(actions.includes('specify_init'), false);
    assert.equal(actions.includes('install_bug_ext'), false);
    assert.equal(report.components.length, 3);
    assert.equal(report.components[2].outcome, 'updated');
    const copiedPackage = JSON.parse(
      await fs.readFile(path.join(profileDir, 'node_modules', 'dsh-sdd-kit', 'package.json'), 'utf8')
    );
    assert.equal(copiedPackage.name, 'dsh-sdd-kit');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(sourceDir, { recursive: true, force: true });
    await fs.rm(profileDir, { recursive: true, force: true });
  }
});

test('runUpdate AC-06: a changed kit hash requires a DSH restart with guidance', async () => {
  const cwd = await makeTempDir();
  const sourceDir = await makeTempDir();
  const profileDir = await makeTempDir();
  const runUpstreamFake = async (args) => {
    if (args.action === 'status') {
      return {
        action: 'status',
        cwd: args.cwd,
        specifyCli: { installed: true, version: 'specify 1.4.0', error: null },
        superpowers: { installed: true, dir: args.superpowersDir, head: 'bbbbbbb', skillCount: 3 },
      };
    }
    if (args.action === 'specify_upgrade') {
      return { action: 'specify_upgrade', ok: true, code: 0, mode: 'upgrade', stdout: '', stderr: '' };
    }
    if (args.action === 'sync_superpowers') {
      return { action: 'sync_superpowers', ok: true, code: 0, mode: 'pull', skillCount: 3, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected upstream action: ${args.action}`);
  };

  try {
    await seedKitSource(sourceDir, { marker: 'new' });
    await seedKitSource(path.join(profileDir, 'node_modules', 'dsh-sdd-kit'), { marker: 'old' });

    const report = await runUpdate(
      { cwd, dshKitSourceDir: sourceDir, dshProfileDir: profileDir },
      { runUpstream: runUpstreamFake }
    );
    const kit = report.components[2];

    assert.equal(report.ok, true);
    assert.equal(report.requiresRestart, true);
    assert.equal(kit.outcome, 'updated');
    assert.match(kit.followUp, /Restart DSH/);
    assert.match(kit.before, /^sha256:/);
    assert.match(kit.after, /^sha256:/);
    assert.notEqual(kit.before, kit.after);
    assert.equal(report.components[0].followUp, null);
    assert.equal(report.components[1].followUp, null);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(sourceDir, { recursive: true, force: true });
    await fs.rm(profileDir, { recursive: true, force: true });
  }
});

test('refreshInstalledKit validates the source, stages swaps, and preserves unlisted files', async () => {
  const cwd = await makeTempDir();
  const sourceDir = await makeTempDir();
  const profileDir = await makeTempDir();

  try {
    await assert.rejects(
      () => refreshInstalledKit({ cwd }, { env: {}, homedir: () => profileDir }),
      /No dsh-sdd-kit source configured/
    );

    await seedKitSource(sourceDir);
    const destDir = path.join(profileDir, 'node_modules', 'dsh-sdd-kit');

    const first = await refreshInstalledKit(
      { cwd, dshKitSourceDir: sourceDir, dshProfileDir: profileDir },
      { env: {}, homedir: () => profileDir }
    );
    assert.equal(first.changed, true);
    assert.equal(first.beforeHash, null);
    assert.match(first.afterHash, /^sha256:/);
    assert.equal(first.destDir, destDir);

    await fs.writeFile(path.join(destDir, 'UNLISTED.txt'), 'keep', 'utf8');
    const second = await refreshInstalledKit(
      { cwd, dshKitSourceDir: sourceDir, dshProfileDir: profileDir },
      { env: {}, homedir: () => profileDir }
    );
    assert.equal(second.changed, false);
    assert.equal(second.beforeHash, second.afterHash);
    assert.deepEqual(second.changedFiles, []);
    assert.equal(await fs.readFile(path.join(destDir, 'UNLISTED.txt'), 'utf8'), 'keep');

    await fs.writeFile(path.join(sourceDir, 'README.md'), '# changed\n', 'utf8');
    const third = await refreshInstalledKit(
      { cwd, dshKitSourceDir: sourceDir, dshProfileDir: profileDir },
      { env: {}, homedir: () => profileDir }
    );
    assert.equal(third.changed, true);
    assert.ok(third.changedFiles.includes('README.md'));
    assert.equal(await fs.readFile(path.join(destDir, 'UNLISTED.txt'), 'utf8'), 'keep');

    const insideSource = path.join(sourceDir, 'profile');
    await assert.rejects(
      () => refreshInstalledKit({ cwd, dshKitSourceDir: sourceDir, dshProfileDir: insideSource }, { env: {}, homedir: () => profileDir }),
      /Invalid dsh-sdd-kit source:/
    );

    const symlinkSource = path.join(cwd, 'symlink-source');
    await seedKitSource(symlinkSource);
    await fs.symlink(path.join(symlinkSource, 'README.md'), path.join(symlinkSource, 'src', 'link.md'));
    await assert.rejects(
      () => refreshInstalledKit({ cwd, dshKitSourceDir: symlinkSource, dshProfileDir: profileDir }, { env: {}, homedir: () => profileDir }),
      /symlink/
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(sourceDir, { recursive: true, force: true });
    await fs.rm(profileDir, { recursive: true, force: true });
  }
});

test('runUpdate keeps the readable before identifier on a failed component', async () => {
  const cwd = await makeTempDir();
  const runUpstreamFake = async (args) => {
    if (args.action === 'status') {
      return {
        action: 'status',
        cwd: args.cwd,
        specifyCli: { installed: true, version: 'specify 1.3.1', error: null },
        superpowers: { installed: true, dir: args.superpowersDir, head: 'aaaaaaa', skillCount: 2 },
      };
    }
    if (args.action === 'specify_upgrade') {
      return { action: 'specify_upgrade', ok: false, code: 1, mode: 'upgrade', stdout: '', stderr: 'uv: command failed' };
    }
    if (args.action === 'sync_superpowers') {
      return { action: 'sync_superpowers', ok: false, code: 128, mode: 'pull', skillCount: 2, stdout: '', stderr: 'fatal: offline' };
    }
    throw new Error(`unexpected upstream action: ${args.action}`);
  };
  const refreshKit = async () => ({
    changed: false,
    beforeHash: 'sha256:same',
    afterHash: 'sha256:same',
    changedFiles: [],
    destDir: '/tmp/profile/node_modules/dsh-sdd-kit',
    mode: 'unchanged',
  });

  try {
    const report = await runUpdate(
      { cwd, dshKitSourceDir: '/tmp/kit-source', dshProfileDir: '/tmp/profile' },
      { runUpstream: runUpstreamFake, refreshKit }
    );
    assert.equal(report.ok, false);
    assert.equal(report.components[0].before, 'specify 1.3.1');
    assert.equal(report.components[0].after, null);
    assert.match(report.components[0].error.message, /Spec Kit update failed:/);
    assert.equal(report.components[1].before, 'aaaaaaa');
    assert.equal(report.components[1].after, null);
    assert.match(report.components[1].error.message, /Superpowers update failed:/);
    assert.equal(report.components[2].outcome, 'unchanged');
    assert.deepEqual(
      report.errors.map((entry) => entry.component),
      ['spec-kit', 'superpowers']
    );
    assert.equal(report.requiresRestart, false);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('sdd_upstream routes action "update_all" to runUpdate and exposes the update parameters', async () => {
  const registered = [];
  const mockCtx = {
    tools: {
      register(def) {
        registered.push(def);
        return () => {};
      },
    },
  };
  const calls = [];
  const fakeRunUpdate = async (args) => {
    calls.push(args);
    return { action: 'update', ok: true, components: [], requiresRestart: false, errors: [], cwd: args.cwd };
  };

  registerSddTools(mockCtx, (def) => def, { runUpdate: fakeRunUpdate });

  const tool = registered.find((entry) => entry.name === 'sdd_upstream');
  assert.match(tool.parameters.action.description, /update_all/);
  assert.ok(tool.parameters.dshKitSourceDir);
  assert.ok(tool.parameters.dshProfileDir);

  const result = await tool.execute({
    action: 'update_all',
    cwd: '/tmp/demo',
    dshKitSourceDir: '/tmp/kit',
    dshProfileDir: '/tmp/profile',
  });

  assert.equal(result.action, 'update');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dshKitSourceDir, '/tmp/kit');
  assert.equal(calls[0].dshProfileDir, '/tmp/profile');
});

test('sdd-update skill delegates once and contains no update logic', async () => {
  const raw = await fs.readFile(path.join(PKG_ROOT, 'skills', 'sdd-update', 'SKILL.md'), 'utf8');
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');

  assert.equal((body.match(/sdd_upstream\(action: "update_all"/g) || []).length, 1);
  assert.match(body, /# \/sdd-update/);
  for (const forbidden of [
    'specify_upgrade',
    'sync_superpowers',
    'specify_init',
    'install_bug_ext',
    'install_overrides',
    'check_task',
    'sync_index',
  ]) {
    assert.equal(body.includes(forbidden), false, `skill must not reference ${forbidden}`);
  }
  assert.equal(/fs\.|child_process|exec\(/.test(body), false);
  assert.match(body, /requiresRestart/);
});

test('runUpdate completes an all-current pass well under the five-minute budget', async () => {
  // Premise: identifiers are read locally; upstream calls are faked here so the
  // measurement is deterministic. A real pass adds network latency bounded by the
  // existing 120 s upstream timeout per command, still inside the 5-minute budget.
  const cwd = await makeTempDir();
  const runUpstreamFake = async (args) => {
    if (args.action === 'status') {
      return {
        action: 'status',
        cwd: args.cwd,
        specifyCli: { installed: true, version: 'specify 1.4.0', error: null },
        superpowers: { installed: true, dir: args.superpowersDir, head: 'bbbbbbb', skillCount: 3 },
      };
    }
    if (args.action === 'specify_upgrade') {
      return { action: 'specify_upgrade', ok: true, code: 0, mode: 'upgrade', stdout: '', stderr: '' };
    }
    if (args.action === 'sync_superpowers') {
      return { action: 'sync_superpowers', ok: true, code: 0, mode: 'pull', skillCount: 3, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected upstream action: ${args.action}`);
  };
  const refreshKit = async () => ({
    changed: false,
    beforeHash: 'sha256:same',
    afterHash: 'sha256:same',
    changedFiles: [],
    destDir: '/tmp/profile/node_modules/dsh-sdd-kit',
    mode: 'unchanged',
  });

  try {
    const startedAt = Date.now();
    const report = await runUpdate(
      { cwd, dshKitSourceDir: '/tmp/kit-source', dshProfileDir: '/tmp/profile' },
      { runUpstream: runUpstreamFake, refreshKit }
    );
    const elapsedMs = Date.now() - startedAt;

    assert.equal(report.ok, true);
    assert.equal(report.requiresRestart, false);
    assert.ok(elapsedMs < 5 * 60 * 1000, `all-current pass took ${elapsedMs}ms, over the 5-minute budget`);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('README states that dshKitSourceDir must be passed explicitly', async () => {
  const readme = await fs.readFile(path.join(PKG_ROOT, 'README.md'), 'utf8');

  assert.match(readme, /dshKitSourceDir/);
  assert.match(readme, /必须显式/, 'README must say the source directory has to be passed explicitly');
  assert.doesNotMatch(readme, /自动发现/, 'README must not imply the local checkout is discovered automatically');
});

test('quickstart manual recovery uses staged swaps instead of in-place copies', async () => {
  const quickstart = await fs.readFile(
    path.join(PKG_ROOT, 'specs/001-sdd-update-command/quickstart.md'),
    'utf8'
  );

  assert.doesNotMatch(quickstart, /rm -rf/, 'quickstart must not delete profile entries in place');
  assert.match(quickstart, /mktemp/, 'quickstart must stage the copy in a temporary directory');
  assert.match(quickstart, /mv /, 'quickstart must swap entries in with mv/rename');
  assert.match(quickstart, /nlink/, 'quickstart must explain the hardlink hazard it avoids');
});

test('contract injection points match the deps the implementation actually reads', async () => {
  const contract = await fs.readFile(
    path.join(PKG_ROOT, 'specs/001-sdd-update-command/contracts/sdd-update.contract.md'),
    'utf8'
  );
  const updateSource = await fs.readFile(path.join(PKG_ROOT, 'src/core/update.mjs'), 'utf8');
  const kitCopySource = await fs.readFile(path.join(PKG_ROOT, 'src/core/kit-copy.mjs'), 'utf8');

  const documented = [...contract.matchAll(/^\/\/\s{3}(\w+):/gm)].map((match) => match[1]);
  assert.ok(documented.length > 0, 'contract must document its injection points');

  for (const key of documented) {
    const used = new RegExp(`deps\\.${key}\\b`).test(updateSource) || new RegExp(`deps\\.${key}\\b`).test(kitCopySource);
    assert.ok(used, `contract documents deps.${key} but no module reads it`);
  }

  for (const key of ['runner', 'fs', 'crypto']) {
    assert.ok(!documented.includes(key), `contract must not document unsupported deps.${key}`);
  }
});
