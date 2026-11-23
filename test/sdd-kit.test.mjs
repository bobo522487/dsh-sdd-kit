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
    `${JSON.stringify({ name: 'dsh-sdd-kit', version: '0.3.0', type: 'module', files: ['src/', 'skills/', 'overrides/', 'spec-kit-extension/', 'cordis.patch.yml', 'README.md', 'LICENSE'] }, null, 2)}\n`
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

test('skills/ contains exactly 2 user-only bridge skills matching DSH frontmatter contract', async () => {
  const skillsDir = path.join(PKG_ROOT, 'skills');
  const dirs = (await fs.readdir(skillsDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  assert.deepEqual(dirs, ['sdd-setup', 'sdd-update']);

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

test('README install commands point at the real repository and release version', async () => {
  const readme = await fs.readFile(path.join(PKG_ROOT, 'README.md'), 'utf8');
  const pkg = JSON.parse(await fs.readFile(path.join(PKG_ROOT, 'package.json'), 'utf8'));

  assert.doesNotMatch(readme, /<your-username>/, 'README must not ship a placeholder GitHub owner');
  assert.match(
    readme,
    /https:\/\/github\.com\/bobo522487\/dsh-sdd-kit/,
    'README must install from the published repository URL'
  );
  assert.match(
    readme,
    new RegExp(`dsh-sdd-kit-${pkg.version.replaceAll('.', '\\.')}\\.tgz`),
    `README tarball example must match package.json version ${pkg.version}`
  );
  assert.match(
    readme,
    new RegExp(`releases/tag/v${pkg.version.replaceAll('.', '\\.')}`),
    `README release link must point at the current package.json version v${pkg.version}`
  );
  assert.match(
    readme,
    /update dsh-sdd-kit --latest/,
    'README must explain that git dependencies upgrade via update --latest (plain re-add is skipped when the specifier is unchanged)'
  );

  const cordis = await fs.readFile(path.join(PKG_ROOT, 'cordis.patch.yml'), 'utf8');
  const header = cordis.split('\n')[0];
  assert.match(
    header,
    new RegExp(`v${pkg.version.replaceAll('.', '\\.')}`),
    `cordis.patch.yml header must name the current package.json version v${pkg.version}`
  );
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

async function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

test('artifact line references point at the content they cite', async () => {
  const artifacts = [
    'specs/001-sdd-update-command/plan.md',
    'specs/001-sdd-update-command/research.md',
    'specs/001-sdd-update-command/tasks.md',
    'specs/001-sdd-update-command/data-model.md',
    'specs/001-sdd-update-command/contracts/sdd-update.contract.md',
  ];
  const aliases = { 'constitution.md': '.specify/memory/constitution.md' };
  const cache = new Map();
  const readLines = async (absolute) => {
    if (!cache.has(absolute)) cache.set(absolute, (await fs.readFile(absolute, 'utf8')).split('\n'));
    return cache.get(absolute);
  };

  const anchors = [
    ['constitution.md', 22, 37, '零分叉'],
    ['constitution.md', 46, 50, '严格测试先行'],
    ['constitution.md', 52, 55, '原子提交'],
    ['constitution.md', 57, 63, '可升级'],
    ['constitution.md', 62, 62, '重启 DSH'],
    ['constitution.md', 78, 78, 'Node.js >=18'],
    ['constitution.md', 81, 83, 'node_modules/dsh-sdd-kit'],
    ['constitution.md', 99, 105, '治理'],
    ['src/register.mjs', 9, 9, 'registerSddTools'],
    ['src/register.mjs', 5, 7, 'renderJsonText'],
    ['test/sdd-kit.test.mjs', 16, 59, 'snapshotTree'],
    ['test/sdd-kit.test.mjs', 161, 200, 'registerSddTools'],
    ['src/register.mjs', 14, 74, 'update_all'],
    ['specs/001-sdd-update-command/contracts/sdd-update.contract.md', 22, 22, 'src/register.mjs:14-74'],
  ];
  for (const [file, start, end, needle] of anchors) {
    const absolute = path.join(PKG_ROOT, aliases[file] || file);
    const slice = (await readLines(absolute)).slice(start - 1, end).join('\n');
    assert.ok(slice.includes(needle), `${file}:${start}-${end} must contain ${needle}`);
  }

  const reference = /([\w./-]+\.(?:md|mjs|yml|json)):(\d+)(?:-(\d+))?/g;
  for (const artifact of artifacts) {
    const artifactPath = path.join(PKG_ROOT, artifact);
    const text = (await readLines(artifactPath)).join('\n');
    for (const match of text.matchAll(reference)) {
      const [, refPath, rawStart, rawEnd] = match;
      const candidates = [];
      if (path.isAbsolute(refPath)) candidates.push(refPath);
      else {
        if (aliases[refPath]) candidates.push(path.join(PKG_ROOT, aliases[refPath]));
        candidates.push(path.join(PKG_ROOT, refPath), path.join(path.dirname(artifactPath), refPath));
      }
      const resolved = await firstExisting(candidates);
      if (!resolved) continue; // reference into an external checkout, not this repo
      const targetLines = await readLines(resolved);
      const start = Number(rawStart);
      const end = rawEnd ? Number(rawEnd) : start;
      const label = `${refPath}:${rawStart}${rawEnd ? `-${rawEnd}` : ''}`;
      assert.ok(
        start >= 1 && end <= targetLines.length && start <= end,
        `${artifact} cites ${label} outside ${targetLines.length} lines`
      );
      assert.ok(targetLines[start - 1].trim().length > 0, `${artifact} cites blank line ${label}`);
    }
  }
});

test('release allowlist ships the Spec Kit extension source directory', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(PKG_ROOT, 'package.json'), 'utf8'));
  const files = manifest.files.map((entry) => entry.replace(/\/$/, ''));
  assert.ok(
    files.includes('spec-kit-extension'),
    `package.json files must include spec-kit-extension/, got: ${files.join(', ')}`
  );

  const kitCopySource = await fs.readFile(path.join(PKG_ROOT, 'src', 'core', 'kit-copy.mjs'), 'utf8');
  const allowlistBlock = kitCopySource.match(/export const KIT_ALLOWLIST = \[([\s\S]*?)\];/)?.[1] || '';
  assert.ok(
    /'spec-kit-extension'/.test(allowlistBlock),
    'KIT_ALLOWLIST must include spec-kit-extension so update_all copies it into the DSH profile'
  );

  const seededRoot = await makeTempDir();
  try {
    await seedKitSource(seededRoot);
    const seededManifest = JSON.parse(await fs.readFile(path.join(seededRoot, 'package.json'), 'utf8'));
    const seededFiles = seededManifest.files.map((entry) => entry.replace(/\/$/, ''));
    assert.ok(
      seededFiles.includes('spec-kit-extension'),
      'seedKitSource must mirror the real package.json files array'
    );
  } finally {
    await fs.rm(seededRoot, { recursive: true, force: true });
  }
});

const EXTENSION_DIR = path.join(PKG_ROOT, 'spec-kit-extension');
const HOOK_COMMAND_FILES = [
  'speckit.superpowers-hooks.before-implement.md',
  'speckit.superpowers-hooks.after-implement.md',
  'speckit.superpowers-hooks.before-bug-fix.md',
  'speckit.superpowers-hooks.after-bug-fix.md',
];
const HOOK_EVENTS = ['before_implement', 'after_implement', 'before_bug_fix', 'after_bug_fix'];

test('extension manifest declares four commands and four mandatory hooks', async () => {
  const manifest = await fs.readFile(path.join(EXTENSION_DIR, 'extension.yml'), 'utf8');

  assert.match(manifest, /^schema_version:\s*"1\.0"$/m);
  assert.match(manifest, /^\s+id:\s*superpowers-hooks$/m);
  assert.match(manifest, /^\s+name:\s*\S+/m);
  assert.match(manifest, /^\s+description:\s*\S+/m);
  assert.match(manifest, /^\s+author:\s*\S+/m);
  assert.match(manifest, /^\s+version:\s*"0\.1\.0"$/m);
  assert.match(manifest, /^\s+speckit_version:\s*"[>=<^~0-9.\s]+"$/m);

  for (const event of HOOK_EVENTS) {
    assert.match(manifest, new RegExp(`^  ${event}:$`, 'm'), `manifest must declare hooks.${event}`);
  }
  const declaredEvents = [...manifest.matchAll(/^  ([a-z_]+):$/gm)].map((m) => m[1]);
  assert.deepEqual(
    declaredEvents.filter((name) => name.includes('_')),
    HOOK_EVENTS,
    'manifest must declare exactly the four implement/bug-fix hook events'
  );

  assert.equal(
    (manifest.match(/^\s+optional:\s*false$/gm) || []).length,
    4,
    'all four hooks must be optional: false so Spec Kit renders **Automatic Hook**'
  );
  assert.equal(manifest.includes('events:'), false, 'must not declare runtime events (INV-2)');
  assert.equal(manifest.includes('templates:'), false, 'must not inject templates (INV-2)');
  assert.equal(manifest.includes('scripts:'), false, 'must not inject scripts (INV-2)');
  assert.equal(/^settings:/m.test(manifest), false, 'must not write project settings (INV-3)');

  for (const file of HOOK_COMMAND_FILES) {
    const command = file.replace(/\.md$/, '');
    assert.ok(manifest.includes(`name: ${command}`), `provides.commands must declare ${command}`);
    assert.ok(manifest.includes(`file: commands/${file}`), `provides.commands must point at commands/${file}`);
  }
  assert.equal(
    (manifest.match(/^\s+- name: speckit\.superpowers-hooks\./gm) || []).length,
    4,
    'provides.commands must declare exactly four commands (INV-1)'
  );
});

test('install_hooks_ext delegates once with --dev and reports the four hooks', async () => {
  const cwd = await makeTempDir();
  const extensionDir = path.join(cwd, 'ext-src');
  await fs.mkdir(extensionDir, { recursive: true });
  const calls = [];
  const mockRunner = async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return { ok: true, code: 0, stdout: 'Extension installed successfully!', stderr: '' };
  };

  try {
    const report = await runUpstream({ action: 'install_hooks_ext', cwd, extensionDir }, mockRunner);
    assert.equal(calls.length, 1, 'must delegate exactly once');
    assert.equal(calls[0].cmd, 'specify');
    assert.deepEqual(calls[0].args, ['extension', 'add', '--dev', extensionDir, '--force']);
    assert.equal(calls[0].options.cwd, cwd);

    assert.equal(report.action, 'install_hooks_ext');
    assert.equal(report.ok, true);
    assert.equal(report.cwd, cwd);
    assert.equal(report.extensionDir, extensionDir);
    assert.match(report.command, /^specify extension add --dev .+ --force$/);
    assert.deepEqual(report.extension, { id: 'superpowers-hooks', version: '0.1.0' });
    assert.deepEqual(report.hooks, HOOK_EVENTS);
    assert.equal(typeof report.restartRequired, 'boolean');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('install_hooks_ext refuses a missing extension source without calling specify', async () => {
  const cwd = await makeTempDir();
  const calls = [];
  const mockRunner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { ok: true, code: 0, stdout: '', stderr: '' };
  };

  try {
    const missing = path.join(cwd, 'nope');
    const report = await runUpstream({ action: 'install_hooks_ext', cwd, extensionDir: missing }, mockRunner);
    assert.equal(calls.length, 0, 'must not shell out when the source directory is missing');
    assert.equal(report.ok, false);
    assert.match(report.error, /extension source not found at /);
    assert.equal(report.extensionDir, missing);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('install_hooks_ext surfaces CLI failures without throwing', async () => {
  const cwd = await makeTempDir();
  const extensionDir = path.join(cwd, 'ext-src');
  await fs.mkdir(extensionDir, { recursive: true });
  const mockRunner = async () => ({ ok: false, code: 1, stdout: '', stderr: 'Invalid command name' });

  try {
    const report = await runUpstream({ action: 'install_hooks_ext', cwd, extensionDir }, mockRunner);
    assert.equal(report.ok, false);
    assert.equal(report.code, 1);
    assert.equal(report.stderr, 'Invalid command name');
    assert.equal(report.error, undefined, 'CLI failures keep raw stderr instead of a synthesized error');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('sdd_upstream exposes install_hooks_ext and extensionDir to the model', () => {
  const registered = [];
  const ctx = { tools: { register: (tool) => { registered.push(tool); return () => {}; } } };
  registerSddTools(ctx, (definition) => definition);

  const upstream = registered.find((tool) => tool.name === 'sdd_upstream');
  assert.ok(upstream.parameters.action.description.includes('install_hooks_ext'));
  assert.ok(upstream.parameters.extensionDir, 'extensionDir must be a declared parameter');
});

test('sdd_upstream exposes switch_integration so the mismatch report is actionable', () => {
  const registered = [];
  const ctx = { tools: { register: (tool) => { registered.push(tool); return () => {}; } } };
  registerSddTools(ctx, (definition) => definition);

  const upstream = registered.find((tool) => tool.name === 'sdd_upstream');
  assert.ok(
    upstream.parameters.action.description.includes('switch_integration'),
    'REQ-16: the model must be able to opt in to the integration switch'
  );
});

test('switch_integration delegates once to specify integration switch dsh', async () => {
  const cwd = await makeTempDir();
  await fs.mkdir(path.join(cwd, '.specify'), { recursive: true });
  await fs.writeFile(
    path.join(cwd, '.specify', 'init-options.json'),
    JSON.stringify({ ai: 'claude', integration: 'claude' })
  );
  const calls = [];
  const mockRunner = async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    if (args[0] === 'integration' && args[1] === 'switch') {
      // The CLI rewrites init-options.json as part of the switch.
      await fs.writeFile(
        path.join(cwd, '.specify', 'init-options.json'),
        JSON.stringify({ ai: 'dsh', integration: 'dsh' })
      );
      return { ok: true, code: 0, stdout: "Switched to integration 'DeepSeek Harness'", stderr: '' };
    }
    return { ok: false, code: 1, stdout: '', stderr: 'unexpected call' };
  };

  try {
    const report = await runUpstream({ action: 'switch_integration', cwd }, mockRunner);
    assert.equal(calls.length, 1, 'must delegate exactly once');
    assert.equal(calls[0].cmd, 'specify');
    assert.deepEqual(calls[0].args, ['integration', 'switch', 'dsh']);
    assert.equal(calls[0].options.cwd, cwd);

    assert.equal(report.action, 'switch_integration');
    assert.equal(report.ok, true);
    assert.equal(report.cwd, cwd);
    assert.equal(report.command, 'specify integration switch dsh');
    assert.equal(report.integration, 'dsh', 'REQ-16: the report must re-read the post-switch integration');
    assert.equal(report.skillsDir, '.dsh/skills');
    assert.equal(report.skillsDirInDshRoots, true);
    assert.equal(report.integrationMismatch, null, 'a completed switch must clear the mismatch');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('switch_integration reports an already-switched project without failing', async () => {
  const cwd = await makeTempDir();
  await fs.mkdir(path.join(cwd, '.specify'), { recursive: true });
  await fs.writeFile(
    path.join(cwd, '.specify', 'init-options.json'),
    JSON.stringify({ ai: 'dsh', integration: 'dsh' })
  );
  const mockRunner = async () => ({
    ok: true,
    code: 0,
    stdout: "Integration 'dsh' is already the default integration. Nothing to switch.",
    stderr: '',
  });

  try {
    const report = await runUpstream({ action: 'switch_integration', cwd }, mockRunner);
    assert.equal(report.ok, true);
    assert.equal(report.integration, 'dsh');
    assert.equal(report.integrationMismatch, null);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('switch_integration surfaces CLI failures without throwing', async () => {
  const cwd = await makeTempDir();
  const mockRunner = async () => ({
    ok: false,
    code: 1,
    stdout: '',
    stderr: 'Error: Not a Spec Kit project (no .specify/ directory)',
  });

  try {
    const report = await runUpstream({ action: 'switch_integration', cwd }, mockRunner);
    assert.equal(report.ok, false);
    assert.equal(report.code, 1);
    assert.match(report.stderr, /Not a Spec Kit project/);
    assert.equal(report.error, undefined, 'CLI failures keep raw stderr instead of a synthesized error');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

const HOOK_COMMAND_SECTIONS = [
  '## 何时触发',
  '## 上游依赖检查',
  '## 必须加载的技能',
  '## 执行纪律',
  '## 出口条件',
];

async function readHookCommand(file) {
  return fs.readFile(path.join(EXTENSION_DIR, 'commands', file), 'utf8');
}

function assertHookCommandShape(body, file) {
  assert.match(body, /^---\ndescription: \S.*\n---\n/, `${file} must open with a description-only frontmatter`);
  const frontmatter = body.slice(0, body.indexOf('\n---', 4));
  assert.equal(/^allowed-tools:/m.test(frontmatter), false, `${file} must not declare allowed-tools (INV-7)`);
  assert.equal(/^model:/m.test(frontmatter), false, `${file} must not declare model (INV-7)`);
  assert.equal(/\$ARGUMENTS/.test(body), false, `${file} must not use $ARGUMENTS (INV-8)`);
  for (const section of HOOK_COMMAND_SECTIONS) {
    assert.ok(body.includes(section), `${file} must contain ${section}`);
  }
  assert.ok(
    body.includes('~/.dsh/upstream/superpowers/skills'),
    `${file} must name the Superpowers skill root for the missing-dependency check (INV-5)`
  );
  assert.match(
    body,
    /缺失[\s\S]{0,80}停止/,
    `${file} must tell the agent to stop when an upstream skill is missing (INV-5)`
  );
  assert.match(
    body,
    /\/sdd-setup/,
    `${file} must name the repair command when the upstream skills are missing (REQ-06)`
  );
  assert.ok(
    body.split('\n').length <= 61,
    `${file} must stay within 60 lines (INV-9), got ${body.split('\n').length}`
  );
}

test('US1 hook commands inject TDD discipline and converge follow-up', async () => {
  const before = await readHookCommand('speckit.superpowers-hooks.before-implement.md');
  const after = await readHookCommand('speckit.superpowers-hooks.after-implement.md');

  assertHookCommandShape(before, 'before-implement');
  assertHookCommandShape(after, 'after-implement');

  assert.match(before, /`test-driven-development`/, 'before-implement must load test-driven-development by name');
  assert.match(before, /`systematic-debugging`/, 'before-implement must load systematic-debugging by name');
  assert.match(before, /Red/, 'before-implement must name the Red stage');
  assert.match(before, /Green/, 'before-implement must name the Green stage');
  assert.match(before, /npm test/, 'before-implement must gate on npm test');
  assert.match(before, /git commit/, 'before-implement must require one atomic commit per task');

  assert.match(after, /`verification-before-completion`/, 'after-implement must load verification-before-completion');
  assert.match(after, /`requesting-code-review`/, 'after-implement must load requesting-code-review');
  assert.match(after, /阶段一/, 'after-implement must describe the first review stage');
  assert.match(after, /阶段二/, 'after-implement must describe the second review stage');
  assert.equal(
    (after.match(/__SPECKIT_COMMAND_CONVERGE__/g) || []).length,
    1,
    'after-implement must reference converge through the CLI placeholder exactly once (INV-6)'
  );
  assert.equal(
    /\/speckit[.-]converge/.test(after),
    false,
    'after-implement must not hardcode a slash/dot command form (INV-6)'
  );

  for (const [file, body] of [['before-implement', before], ['after-implement', after]]) {
    assert.equal(
      /Red-Green-Refactor 的具体步骤|假设检验五步法/.test(body),
      false,
      `${file} must not inline upstream discipline prose (INV-4)`
    );
  }
});

test('US2 hook commands inject debugging discipline and bug-test follow-up', async () => {
  const before = await readHookCommand('speckit.superpowers-hooks.before-bug-fix.md');
  const after = await readHookCommand('speckit.superpowers-hooks.after-bug-fix.md');

  assertHookCommandShape(before, 'before-bug-fix');
  assertHookCommandShape(after, 'after-bug-fix');

  assert.match(before, /`systematic-debugging`/, 'before-bug-fix must load systematic-debugging by name');
  assert.match(before, /`test-driven-development`/, 'before-bug-fix must load test-driven-development by name');
  assert.match(before, /复现/, 'before-bug-fix must require a reproducing test');

  assert.match(after, /`verification-before-completion`/, 'after-bug-fix must load verification-before-completion');
  assert.match(after, /`requesting-code-review`/, 'after-bug-fix must load requesting-code-review');
  assert.match(after, /阶段一/, 'after-bug-fix must describe the first review stage');
  assert.match(after, /阶段二/, 'after-bug-fix must describe the second review stage');
  assert.equal(
    (after.match(/__SPECKIT_COMMAND_BUG_TEST__/g) || []).length,
    1,
    'after-bug-fix must reference bug-test through the CLI placeholder exactly once (INV-6)'
  );
  assert.equal(
    /\/speckit[.-]bug-test/.test(after),
    false,
    'after-bug-fix must not hardcode a slash/dot command form (INV-6)'
  );
});

test('US3 specify_init defaults to the dsh integration and keeps the unattended flags', async () => {
  const calls = [];
  const mockRunner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { ok: true, code: 0, stdout: '', stderr: '' };
  };

  await runUpstream({ action: 'specify_init', cwd: process.cwd() }, mockRunner);
  const initCall = calls.find((c) => c[0] === 'specify' && c[1] === 'init');
  assert.ok(initCall, 'expected a specify init call');
  assert.equal(
    initCall[initCall.indexOf('--integration') + 1],
    'dsh',
    'REQ-14: specify_init must default to --integration dsh'
  );
  for (const flag of ['--non-interactive', '--force', '--ignore-agent-tools']) {
    assert.ok(initCall.includes(flag), `expected ${flag} in: ${initCall.join(' ')}`);
  }

  calls.length = 0;
  await runUpstream({ action: 'specify_init', cwd: process.cwd(), integration: 'claude' }, mockRunner);
  const override = calls.find((c) => c[0] === 'specify' && c[1] === 'init');
  assert.equal(
    override[override.indexOf('--integration') + 1],
    'claude',
    'an explicit integration argument must still win'
  );
});

test('US3 install_hooks_ext derives the skills directory and mismatch report from integration', async () => {
  const extensionDirOf = async (cwd) => {
    const dir = path.join(cwd, 'ext-src');
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };
  const okRunner = async () => ({ ok: true, code: 0, stdout: 'ok', stderr: '' });

  const dshCwd = await makeTempDir();
  const claudeCwd = await makeTempDir();
  try {
    await fs.mkdir(path.join(dshCwd, '.specify'), { recursive: true });
    await fs.writeFile(
      path.join(dshCwd, '.specify', 'init-options.json'),
      JSON.stringify({ ai: 'dsh', integration: 'dsh' })
    );
    const dshReport = await runUpstream(
      { action: 'install_hooks_ext', cwd: dshCwd, extensionDir: await extensionDirOf(dshCwd) },
      okRunner
    );
    assert.equal(dshReport.integration, 'dsh');
    assert.equal(dshReport.skillsDir, '.dsh/skills');
    assert.equal(dshReport.skillsDirInDshRoots, true);
    assert.equal(dshReport.integrationMismatch, null);
    assert.equal(dshReport.skillsDirGuessed, undefined);

    await fs.mkdir(path.join(claudeCwd, '.specify'), { recursive: true });
    await fs.writeFile(
      path.join(claudeCwd, '.specify', 'init-options.json'),
      JSON.stringify({ ai: 'claude', integration: 'claude' })
    );
    const claudeReport = await runUpstream(
      { action: 'install_hooks_ext', cwd: claudeCwd, extensionDir: await extensionDirOf(claudeCwd) },
      okRunner
    );
    assert.equal(claudeReport.integration, 'claude');
    assert.equal(claudeReport.skillsDir, '.claude/skills');
    assert.equal(claudeReport.skillsDirInDshRoots, false);
    assert.ok(claudeReport.integrationMismatch, 'REQ-15: a non-dsh project must surface a mismatch report');
    assert.equal(claudeReport.integrationMismatch.current, 'claude');
    assert.equal(claudeReport.integrationMismatch.expected, 'dsh');
    assert.equal(
      claudeReport.integrationMismatch.switchCommand,
      'specify integration switch dsh'
    );
  } finally {
    await fs.rm(dshCwd, { recursive: true, force: true });
    await fs.rm(claudeCwd, { recursive: true, force: true });
  }
});

test('US3 sdd-setup installs the hooks extension and reports integration mismatches', async () => {
  const body = await fs.readFile(path.join(PKG_ROOT, 'skills', 'sdd-setup', 'SKILL.md'), 'utf8');

  assert.equal(
    (body.match(/install_hooks_ext/g) || []).length,
    1,
    'sdd-setup must install the bundled extension exactly once'
  );
  assert.match(body, /hasSpecifyDir/, 'sdd-setup must gate specify_init on hasSpecifyDir');
  assert.match(body, /specify integration switch dsh/, 'sdd-setup must surface the explicit switch command');
  assert.match(body, /integrationMismatch/, 'sdd-setup must branch on the mismatch report');
  assert.match(
    body,
    /sync fails[\s\S]{0,120}continue/,
    'sdd-setup must keep installing the extension when the upstream sync fails (REQ-11)'
  );
  assert.equal(
    /--integration claude/.test(body),
    false,
    'sdd-setup must no longer document a hardcoded claude integration'
  );
});

test('US6 sdd-setup exposes the explicit integration switch without making it automatic', async () => {
  const body = await fs.readFile(path.join(PKG_ROOT, 'skills', 'sdd-setup', 'SKILL.md'), 'utf8');

  assert.match(body, /switch_integration/, 'REQ-16: the opt-in action must be documented in sdd-setup');
  assert.match(
    body,
    /switchIntegration/,
    'REQ-16: sdd-setup must name the explicit opt-in signal'
  );
  assert.match(
    body,
    /only when the user explicitly asks|explicit opt-in/i,
    'REQ-15: the switch must stay opt-in, never automatic'
  );
  assert.match(
    body,
    /never run the switch yourself/i,
    'REQ-15: the default path must still refuse to switch on its own'
  );
});

test('US3 end-to-end install writes the extension into the dsh skill root', async (t) => {
  const probe = await runUpstream({ action: 'status', cwd: process.cwd() });
  if (!probe.specifyCli.installed) {
    t.skip('specify CLI is not installed');
    return;
  }

  const cwd = await makeTempDir();
  try {
    const init = await runUpstream({ action: 'specify_init', cwd });
    assert.equal(init.ok, true, `specify init failed: ${init.stderr}`);

    const report = await runUpstream({ action: 'install_hooks_ext', cwd, extensionDir: EXTENSION_DIR });
    assert.equal(report.ok, true, `install_hooks_ext failed: ${report.stderr}`);
    assert.equal(report.integration, 'dsh');
    assert.equal(report.skillsDir, '.dsh/skills');

    for (const event of HOOK_EVENTS) {
      const skillName = `speckit-superpowers-hooks-${event.replace(/_/g, '-')}`;
      const stat = await fs.stat(path.join(cwd, '.dsh', 'skills', skillName, 'SKILL.md'));
      assert.ok(stat.isFile(), `expected .dsh/skills/${skillName}/SKILL.md`);
    }

    const claudeEntries = await fs.readdir(path.join(cwd, '.claude')).catch(() => null);
    assert.equal(claudeEntries, null, 'AC-12: a fresh dsh project must not create .claude/');

    const options = JSON.parse(
      await fs.readFile(path.join(cwd, '.specify', 'init-options.json'), 'utf8')
    );
    assert.equal(options.integration, 'dsh');
    assert.equal(options.ai, 'dsh');

    const cfg = await fs.readFile(path.join(cwd, '.specify', 'extensions.yml'), 'utf8');
    assert.deepEqual(
      cfg
        .split('\n')
        .filter((line) => /^\s+command: speckit\.superpowers-hooks\./.test(line))
        .map((line) => line.trim().replace('command: ', '')),
      [
        'speckit.superpowers-hooks.before-implement',
        'speckit.superpowers-hooks.after-implement',
        'speckit.superpowers-hooks.before-bug-fix',
        'speckit.superpowers-hooks.after-bug-fix',
      ],
      'AC-01: every hook event must carry exactly one extension entry'
    );
    assert.equal(
      (cfg.match(/optional: false/g) || []).length,
      4,
      'every hook must be mandatory (REQ-06)'
    );
    assert.equal(
      (cfg.match(/priority: 5/g) || []).length,
      2,
      'pre-hooks must run at priority 5'
    );
    assert.equal(
      (cfg.match(/priority: 15/g) || []).length,
      2,
      'post-hooks must run at priority 15'
    );
    assert.equal(
      (cfg.match(/condition: null/g) || []).length,
      4,
      'hooks must stay unconditional (REQ-07)'
    );
    assert.match(cfg, /auto_execute_hooks: true/, 'the global switch must stay untouched');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('US4 the retired /sdd-implement entry point leaves no trace in shipped surfaces', async () => {
  const surfaces = ['README.md', 'cordis.patch.yml'];
  for (const relative of surfaces) {
    const body = await fs.readFile(path.join(PKG_ROOT, relative), 'utf8');
    assert.equal(
      /sdd-implement/.test(body),
      false,
      `${relative} must not reference the retired /sdd-implement entry point (AC-05)`
    );
  }

  const skillsDir = path.join(PKG_ROOT, 'skills');
  const dirs = await fs.readdir(skillsDir, { withFileTypes: true });
  for (const entry of dirs.filter((e) => e.isDirectory())) {
    const body = await fs.readFile(path.join(skillsDir, entry.name, 'SKILL.md'), 'utf8');
    assert.equal(
      /sdd-implement/.test(body),
      false,
      `skills/${entry.name}/SKILL.md must not reference the retired entry point (AC-05)`
    );
  }

  const readme = await fs.readFile(path.join(PKG_ROOT, 'README.md'), 'utf8');
  assert.match(readme, /2 个技能/, 'README must advertise two skills (AC-05)');
  assert.equal(/3 个技能/.test(readme), false, 'README must not still advertise three skills (AC-05)');
  assert.match(readme, /spec-kit-extension/, 'README must point at the bundled extension source');

  const constitution = await fs.readFile(
    path.join(PKG_ROOT, '.specify', 'memory', 'constitution.md'),
    'utf8'
  );
  assert.match(
    constitution,
    /严格限定为两个命名技能/,
    'the constitution must state the two-skill surface (AC-05)'
  );
});

async function readExtensionsYml(cwd) {
  return fs.readFile(path.join(cwd, '.specify', 'extensions.yml'), 'utf8');
}

function hookCommandsOf(cfg) {
  return cfg
    .split('\n')
    .filter((line) => /^\s+command: speckit\.superpowers-hooks\./.test(line))
    .map((line) => line.trim().replace('command: ', ''));
}

function installedEntriesOf(cfg) {
  const lines = cfg.split('\n');
  const start = lines.findIndex((line) => /^installed:/.test(line));
  assert.notEqual(start, -1, 'extensions.yml must carry an installed: block');
  const entries = [];
  for (const line of lines.slice(start + 1)) {
    if (/^[a-z_]+:/.test(line)) break;
    const match = line.match(/^\s*-\s*(\S+)\s*$/);
    if (match) entries.push(match[1]);
  }
  return entries;
}

async function specifyAvailable() {
  const probe = await runUpstream({ action: 'status', cwd: process.cwd() });
  return probe.specifyCli.installed;
}

test('US5 reinstalling the hooks extension stays idempotent', async (t) => {
  if (!(await specifyAvailable())) {
    t.skip('specify CLI is not installed');
    return;
  }

  const cwd = await makeTempDir();
  try {
    const init = await runUpstream({ action: 'specify_init', cwd });
    assert.equal(init.ok, true, `specify init failed: ${init.stderr}`);

    const first = await runUpstream({ action: 'install_hooks_ext', cwd, extensionDir: EXTENSION_DIR });
    assert.equal(first.ok, true, `first install failed: ${first.stderr}`);
    const afterFirst = await readExtensionsYml(cwd);

    const second = await runUpstream({ action: 'install_hooks_ext', cwd, extensionDir: EXTENSION_DIR });
    assert.equal(second.ok, true, `reinstall failed: ${second.stderr}`);
    const afterSecond = await readExtensionsYml(cwd);

    assert.deepEqual(
      hookCommandsOf(afterSecond),
      [
        'speckit.superpowers-hooks.before-implement',
        'speckit.superpowers-hooks.after-implement',
        'speckit.superpowers-hooks.before-bug-fix',
        'speckit.superpowers-hooks.after-bug-fix',
      ],
      'INV-7: every event must carry exactly one entry after a reinstall'
    );
    assert.deepEqual(installedEntriesOf(afterSecond), ['superpowers-hooks'], 'INV-10: installed must not duplicate');
    assert.equal(
      (afterSecond.match(/optional: false/g) || []).length,
      4,
      'a reinstall must not duplicate hook entries'
    );
    assert.equal(second.restartRequired, false, 'INV-13: a pure reinstall must not demand a restart');
    assert.equal(second.skillsDir, '.dsh/skills', 'INV-12: the report must reflect the dsh skill root');

    const events = (cfg) => cfg.split('\n').filter((line) => /^  [a-z_]+:$/.test(line)).map((line) => line.trim());
    assert.deepEqual(events(afterSecond), events(afterFirst), 'INV-8: a reinstall must not add orphan event keys');
    assert.deepEqual(
      events(afterSecond),
      ['before_implement:', 'after_implement:', 'before_bug_fix:', 'after_bug_fix:']
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('US5 removing the extension rolls the project back to a hook-free state', async (t) => {
  if (!(await specifyAvailable())) {
    t.skip('specify CLI is not installed');
    return;
  }

  const cwd = await makeTempDir();
  try {
    const init = await runUpstream({ action: 'specify_init', cwd });
    assert.equal(init.ok, true, `specify init failed: ${init.stderr}`);
    const installed = await runUpstream({ action: 'install_hooks_ext', cwd, extensionDir: EXTENSION_DIR });
    assert.equal(installed.ok, true, `install failed: ${installed.stderr}`);

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    await run('specify', ['extension', 'remove', 'superpowers-hooks', '--force'], { cwd });

    const cfg = await readExtensionsYml(cwd);
    assert.deepEqual(installedEntriesOf(cfg), [], 'INV-8: removal must drop the installed entry');
    assert.deepEqual(hookCommandsOf(cfg), [], 'INV-8: removal must drop every hook entry');
    assert.equal(
      cfg.split('\n').filter((line) => /^  [a-z_]+:$/.test(line)).length,
      0,
      'INV-8: removal must not leave orphan event keys'
    );

    const skillDirs = await fs.readdir(path.join(cwd, '.dsh', 'skills'));
    assert.equal(
      skillDirs.some((name) => name.startsWith('speckit-superpowers-hooks-')),
      false,
      'AC-10: removal must delete the generated hook skills'
    );
    const backup = await fs.stat(path.join(cwd, '.specify', 'extensions', '.backup', 'superpowers-hooks'));
    assert.ok(backup.isDirectory(), 'removal must back up the extension config');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('US5 the global hook switch and shared templates stay untouched', async (t) => {
  if (!(await specifyAvailable())) {
    t.skip('specify CLI is not installed');
    return;
  }

  const cwd = await makeTempDir();
  try {
    const init = await runUpstream({ action: 'specify_init', cwd });
    assert.equal(init.ok, true, `specify init failed: ${init.stderr}`);

    const templatesBefore = await snapshotTree(path.join(cwd, '.specify', 'templates'));
    const scriptsBefore = await snapshotTree(path.join(cwd, '.specify', 'scripts'));

    // Seed an explicit "off" switch so the test proves the value is preserved, not just defaulted.
    await fs.writeFile(
      path.join(cwd, '.specify', 'extensions.yml'),
      'installed: []\nsettings:\n  auto_execute_hooks: false\nhooks: {}\n',
      'utf8'
    );
    const switchBefore = (await readExtensionsYml(cwd)).match(/auto_execute_hooks:\s*(\S+)/)?.[1];
    assert.equal(switchBefore, 'false', 'the seeded switch must be off before installing');

    const report = await runUpstream({ action: 'install_hooks_ext', cwd, extensionDir: EXTENSION_DIR });
    assert.equal(report.ok, true, `install failed: ${report.stderr}`);

    const switchAfter = (await readExtensionsYml(cwd)).match(/auto_execute_hooks:\s*(\S+)/)?.[1];
    assert.equal(switchAfter, 'false', 'INV-9: the global switch must keep its original value');
    assert.deepEqual(
      await snapshotTree(path.join(cwd, '.specify', 'templates')),
      templatesBefore,
      'REQ-07: installing hooks must not touch shared templates'
    );
    assert.deepEqual(
      await snapshotTree(path.join(cwd, '.specify', 'scripts')),
      scriptsBefore,
      'REQ-07: installing hooks must not touch shared scripts'
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
