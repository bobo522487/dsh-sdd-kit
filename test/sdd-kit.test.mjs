import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { runUpstream } from '../src/core/upstream.mjs';
import { runBridge } from '../src/core/bridge.mjs';
import {
  assertInside,
  assertNoSymlinkComponent,
  atomicWriteFile,
  findSymlinkComponent,
} from '../src/core/fsutil.mjs';
import { bundledVersion, listArtifacts, readLedger, sha256Bytes, sha256File } from '../src/core/artifacts.mjs';
import { captureSnapshot, readManifest } from '../src/core/snapshot.mjs';
import { selectSuperpowersDir } from '../src/core/candidates.mjs';
import { runUpdate } from '../src/core/update.mjs';
import { runSetup } from '../src/core/setup.mjs';
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
    assert.ok(calls.some((c) => c.join(' ') === 'specify extension add bug --force'));
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

test('sdd_bridge inspects features & bugs, installs EARS overrides, and syncs specs/INDEX.md', async () => {
  const cwd = await makeTempDir();
  try {
    // Seed a Spec Kit feature and bug directory (T001 already checked off by upstream implement)
    const featDir = path.join(cwd, 'specs', '001-user-auth');
    const bugDir = path.join(cwd, '.specify', 'bugs', 'login-crash');
    await fs.mkdir(featDir, { recursive: true });
    await fs.mkdir(bugDir, { recursive: true });
    await fs.writeFile(path.join(featDir, 'spec.md'), '# Spec\n', 'utf8');
    await fs.writeFile(path.join(featDir, 'plan.md'), '# Plan\n', 'utf8');
    await fs.writeFile(
      path.join(featDir, 'tasks.md'),
      `# Tasks\n- [x] T001 Setup JWT helper\n- [ ] T002 [P] Add login endpoint\n`,
      'utf8'
    );
    await fs.writeFile(path.join(bugDir, 'assessment.md'), '# Bug Assessment\n', 'utf8');

    // Install EARS + Non-Goals override
    const ov1 = await runBridge({ action: 'install_overrides', cwd });
    assert.equal(ov1.status, 'written');
    assert.equal(ov1.artifacts[0].verdict, 'not_installed');
    const ov2 = await runBridge({ action: 'install_overrides', cwd });
    assert.equal(ov2.status, 'unchanged');
    assert.equal(ov2.artifacts[0].verdict, 'installed_consistent');

    // Inspect (read-only view of upstream-owned task state)
    const info = await runBridge({ action: 'inspect', cwd });
    assert.equal(info.hasEarsOverride, true);
    assert.equal(info.selectedFeature.name, '001-user-auth');
    assert.equal(info.selectedFeature.tasks.total, 2);
    assert.equal(info.selectedFeature.tasks.done, 1);
    assert.equal(info.selectedFeature.tasks.parallelCount, 1);
    assert.equal(info.selectedBug.slug, 'login-crash');

    // Sync specs/INDEX.md
    const idx = await runBridge({ action: 'sync_index', cwd });
    assert.equal(idx.featureCount, 1);
    const indexMd = await fs.readFile(idx.indexPath, 'utf8');
    assert.match(indexMd, /`001-user-auth` \| In Progress \(1\/2\)/);

    // The parallel checkbox writer is retired: upstream /speckit.implement owns tasks.md
    const retired = await runBridge({ action: 'check_task', cwd, featureName: '001-user-auth', taskMatch: 'T002' });
    assert.equal(retired.ok, false);
    assert.equal(retired.error.code, 'E_ARGS');
    const tasksAfter = await fs.readFile(path.join(featDir, 'tasks.md'), 'utf8');
    assert.match(tasksAfter, /- \[ \] T002/, 'the bridge must never write task checkboxes');
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

test('runUpdate AC-01: all-behind components produce two updated records with before/after', async () => {
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

  try {
    const report = await runUpdate({ cwd }, { runUpstream: runUpstreamFake });
    assert.equal(report.action, 'update');
    assert.equal(report.ok, true);
    assert.equal(report.cwd, path.resolve(cwd));
    assert.equal(report.requiresRestart, true);
    assert.deepEqual(
      report.components.map((record) => record.component),
      ['spec-kit', 'superpowers']
    );
    assert.deepEqual(
      report.components.map((record) => record.outcome),
      ['updated', 'updated']
    );
    assert.equal(report.components[0].before, 'specify 1.3.1');
    assert.equal(report.components[0].after, 'specify 1.4.0');
    assert.equal(report.components[1].before, 'aaaaaaa');
    assert.equal(report.components[1].after, 'bbbbbbb');
    assert.match(report.components[1].followUp, /Restart DSH/, 'a skill-count change must ask for a restart');
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

  try {
    const report = await runUpdate({ cwd }, { runUpstream: runUpstreamFake });
    assert.equal(report.ok, true);
    assert.equal(report.requiresRestart, false);
    assert.deepEqual(
      report.components.map((record) => record.outcome),
      ['unchanged', 'unchanged']
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

  try {
    const report = await runUpdate({ cwd }, { runUpstream: runUpstreamFake });
    assert.equal(report.ok, false);
    assert.deepEqual(
      report.components.map((record) => record.component),
      ['spec-kit', 'superpowers']
    );
    assert.deepEqual(
      report.components.map((record) => record.outcome),
      ['updated', 'failed']
    );
    assert.equal(report.components[1].error !== null, true);
    assert.match(report.components[1].error.message, /Superpowers update failed:/);
    assert.match(report.components[1].error.message, /could not read from remote repository/);
    assert.equal(report.components[0].after, 'specify 1.4.0');
    assert.deepEqual(
      report.errors.map((entry) => entry.component),
      ['superpowers']
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runUpdate AC-05: leaves project specs, plans, tasks, and app source byte-identical', async () => {
  const cwd = await makeTempDir();
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

    const before = await snapshotTree(cwd);
    const report = await runUpdate({ cwd }, { runUpstream: runUpstreamFake });
    const after = await snapshotTree(cwd);

    assert.deepEqual(after, before);
    assert.equal(actions.includes('specify_init'), false);
    assert.equal(actions.includes('install_bug_ext'), false);
    assert.equal(report.components.length, 2);
    assert.deepEqual(
      report.components.map((record) => record.component),
      ['spec-kit', 'superpowers'],
      'update_all must never touch an installed profile copy'
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
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

  try {
    const report = await runUpdate({ cwd }, { runUpstream: runUpstreamFake });
    assert.equal(report.ok, false);
    assert.equal(report.components[0].before, 'specify 1.3.1');
    assert.equal(report.components[0].after, null);
    assert.match(report.components[0].error.message, /Spec Kit update failed:/);
    assert.equal(report.components[1].before, 'aaaaaaa');
    assert.equal(report.components[1].after, null);
    assert.match(report.components[1].error.message, /Superpowers update failed:/);
    assert.deepEqual(
      report.errors.map((entry) => entry.component),
      ['spec-kit', 'superpowers']
    );
    assert.equal(report.requiresRestart, false);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('sdd_upstream routes action "update_all" to runUpdate without profile-copy parameters', async () => {
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
  assert.equal(tool.parameters.dshKitSourceDir, undefined, 'the self-copy parameter must be gone');
  assert.equal(tool.parameters.dshProfileDir, undefined, 'the profile-copy parameter must be gone');
  assert.equal(tool.parameters.force, undefined, 'the deprecated no-op force parameter must be gone');

  const result = await tool.execute({ action: 'update_all', cwd: '/tmp/demo' });

  assert.equal(result.action, 'update');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, '/tmp/demo');
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
  assert.match(body, /dsh plugin/, 'the skill must point plugin self-upgrades at the package manager');
  assert.match(body, /`spec-kit`、`superpowers`/, 'the report order must cover exactly the two upstream layers');
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

  try {
    const startedAt = Date.now();
    const report = await runUpdate({ cwd }, { runUpstream: runUpstreamFake });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(report.ok, true);
    assert.equal(report.requiresRestart, false);
    assert.ok(elapsedMs < 5 * 60 * 1000, `all-current pass took ${elapsedMs}ms, over the 5-minute budget`);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
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

test('release allowlist ships the Spec Kit extension source directory', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(PKG_ROOT, 'package.json'), 'utf8'));
  const files = manifest.files.map((entry) => entry.replace(/\/$/, ''));
  assert.ok(
    files.includes('spec-kit-extension'),
    `package.json files must include spec-kit-extension/, got: ${files.join(', ')}`
  );
});

test('install outputs are gitignored so cross-platform reinstalls never churn the repo', async () => {
  const ignore = await fs.readFile(path.join(PKG_ROOT, '.gitignore'), 'utf8');
  for (const pattern of ['.dsh/', '.specify/extensions/', '.specify/extensions.yml', '.specify/integrations/*.manifest.json']) {
    assert.ok(ignore.includes(pattern), `.gitignore must contain ${pattern}`);
  }
});

const EXTENSION_DIR = path.join(PKG_ROOT, 'spec-kit-extension');
const HOOK_COMMAND_FILES = [
  'speckit.superpowers-hooks.before-implement.md',
  'speckit.superpowers-hooks.after-implement.md',
  'speckit.superpowers-hooks.before-bug-fix.md',
  'speckit.superpowers-hooks.after-bug-fix.md',
  'speckit.superpowers-hooks.guard.md',
  'speckit.superpowers-hooks.guidance.md',
];
const HOOK_EVENTS = [
  'before_implement', 'after_implement', 'before_bug_fix', 'after_bug_fix',
  'before_clarify', 'before_plan',
];

async function seedExtensionManifest(dir, { id = 'superpowers-hooks', version = '0.1.0' } = {}) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'extension.yml'),
    [
      'schema_version: "1.0"',
      'extension:',
      `  id: ${id}`,
      '  name: Demo Hooks',
      `  version: "${version}"`,
      'hooks:',
      '  before_implement:',
      '    command: speckit.demo.before-implement',
      '    optional: false',
      '  after_implement:',
      '    command: speckit.demo.after-implement',
      '    optional: false',
      '  before_bug_fix:',
      '    command: speckit.demo.before-bug-fix',
      '    optional: false',
      '  after_bug_fix:',
      '    command: speckit.demo.after-bug-fix',
      '    optional: false',
      '',
    ].join('\n'),
    'utf8'
  );
}

test('install_hooks_ext reads id/version/events from the manifest, not hardcoded constants', async () => {
  const cwd = await makeTempDir();
  const extensionDir = path.join(cwd, 'ext-src');
  await seedExtensionManifest(extensionDir, { id: 'demo-hooks', version: '9.9.9' });
  const mockRunner = async () => ({ ok: true, code: 0, stdout: 'installed', stderr: '' });
  try {
    const report = await runUpstream({ action: 'install_hooks_ext', cwd, extensionDir }, mockRunner);
    assert.equal(report.ok, true);
    assert.deepEqual(report.extension, { id: 'demo-hooks', version: '9.9.9' });
    assert.deepEqual(report.hooks, ['before_implement', 'after_implement', 'before_bug_fix', 'after_bug_fix']);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('extension manifest declares six commands, six mandatory hooks and a session_start event', async () => {
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
    declaredEvents.filter((name) => HOOK_EVENTS.includes(name)),
    HOOK_EVENTS,
    'manifest must declare exactly the six implement/bug-fix/planning hooks'
  );

  assert.equal(
    (manifest.match(/^\s+optional:\s*false$/gm) || []).length,
    6,
    'all six hooks must be optional: false so Spec Kit renders **Automatic Hook**'
  );
  assert.match(manifest, /^events:$/m, 'the Claude/Codex/Cursor session_start event must be declared');
  assert.match(manifest, /session_start:/, 'session_start must point at the guidance command');
  assert.equal(manifest.includes('templates:'), false, 'must not inject templates (INV-2)');
  assert.equal(/^settings:/m.test(manifest), false, 'must not write project settings (INV-3)');

  for (const file of HOOK_COMMAND_FILES) {
    const command = file.replace(/\.md$/, '');
    assert.ok(manifest.includes(`name: ${command}`), `provides.commands must declare ${command}`);
    assert.ok(manifest.includes(`file: commands/${file}`), `provides.commands must point at commands/${file}`);
  }
  assert.equal(
    (manifest.match(/^\s+- name: speckit\.superpowers-hooks\./gm) || []).length,
    6,
    'provides.commands must declare exactly six commands (INV-1)'
  );
});

test('install_hooks_ext delegates once with --dev and reports the six hooks', async () => {
  const cwd = await makeTempDir();
  const extensionDir = path.join(cwd, 'ext-src');
  await seedExtensionManifest(extensionDir);
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
    assert.deepEqual(report.hooks, [
      'before_implement', 'after_implement', 'before_bug_fix', 'after_bug_fix',
    ]);
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

const NATIVE_COMMAND_SENTINEL = 'speckit-implement';

async function seedNativeCommand(cwd, skillsDir = '.dsh/skills') {
  await writeSeed(cwd, `${skillsDir}/${NATIVE_COMMAND_SENTINEL}/SKILL.md`, '# Skill\n');
}

test('ensure_integration_commands skips the CLI when the native commands are already on disk', async () => {
  const cwd = await makeTempDir();
  await seedNativeCommand(cwd);
  const calls = [];
  const mockRunner = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    return { ok: true, code: 0, stdout: '', stderr: '' };
  };

  try {
    const report = await runUpstream({ action: 'ensure_integration_commands', cwd }, mockRunner);
    assert.equal(report.ok, true);
    assert.equal(report.present, true);
    assert.equal(report.repaired, false);
    assert.equal(report.integration, 'dsh');
    assert.equal(report.skillsDir, '.dsh/skills');
    assert.deepEqual(calls, [], 'no CLI call when the native commands are already present');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('ensure_integration_commands restores missing commands through integration upgrade', async () => {
  const cwd = await makeTempDir();
  await fs.mkdir(path.join(cwd, '.specify'), { recursive: true });
  await fs.writeFile(
    path.join(cwd, '.specify', 'init-options.json'),
    JSON.stringify({ ai: 'dsh', integration: 'dsh' })
  );
  const calls = [];
  const mockRunner = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (args.join(' ') === 'integration upgrade dsh') {
      // A diff-aware upgrade reinstalls the managed command files.
      await seedNativeCommand(cwd);
      return { ok: true, code: 0, stdout: "Upgraded integration: dsh", stderr: '' };
    }
    return { ok: false, code: 1, stdout: '', stderr: 'unexpected call' };
  };

  try {
    const report = await runUpstream({ action: 'ensure_integration_commands', cwd }, mockRunner);
    assert.equal(report.ok, true);
    assert.equal(report.repaired, true);
    assert.equal(report.present, true);
    assert.deepEqual(report.commands, ['specify integration upgrade dsh']);
    assert.deepEqual(calls, ['specify integration upgrade dsh']);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('ensure_integration_commands falls back to integration install when upgrade cannot repair', async () => {
  const cwd = await makeTempDir();
  const calls = [];
  const mockRunner = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (args.join(' ') === 'integration install dsh') {
      await seedNativeCommand(cwd);
      return { ok: true, code: 0, stdout: "Installed integration: dsh", stderr: '' };
    }
    return { ok: true, code: 0, stdout: 'Nothing to upgrade', stderr: '' };
  };

  try {
    const report = await runUpstream({ action: 'ensure_integration_commands', cwd }, mockRunner);
    assert.equal(report.ok, true);
    assert.equal(report.repaired, true);
    assert.deepEqual(report.commands, ['specify integration upgrade dsh', 'specify integration install dsh']);
    assert.deepEqual(calls, ['specify integration upgrade dsh', 'specify integration install dsh']);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('ensure_integration_commands reports failure when no repair step restores the commands', async () => {
  const cwd = await makeTempDir();
  const mockRunner = async () => ({ ok: true, code: 0, stdout: 'no-op', stderr: '' });

  try {
    const report = await runUpstream({ action: 'ensure_integration_commands', cwd }, mockRunner);
    assert.equal(report.ok, false);
    assert.equal(report.present, false);
    assert.equal(report.error.code, 'E_INTEGRATION_COMMANDS');
    assert.match(report.error.hint, /specify init --here --force/);
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
  assert.match(body, /^---\r?\ndescription: \S[^\n]*\r?\n---\r?\n/, `${file} must open with a description-only frontmatter`);
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
    await seedExtensionManifest(dir);
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

test('sdd-setup skill delegates once to the setup action and contains no state machine', async () => {
  const raw = await fs.readFile(path.join(PKG_ROOT, 'skills', 'sdd-setup', 'SKILL.md'), 'utf8');
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  assert.equal((body.match(/sdd_upstream\(action: "setup"/g) || []).length, 1);
  for (const forbidden of ['specify_init', 'install_bug_ext', 'install_hooks_ext', 'sync_superpowers', 'specify_upgrade', 'switch_integration', 'install_overrides']) {
    assert.equal(body.includes(forbidden), false, `skill must not orchestrate ${forbidden} itself`);
  }
  assert.match(body, /switchIntegration/);
  assert.match(body, /restartRequired/);
  assert.match(body, /integrationMismatch/);
  assert.equal(/fs\.|child_process|exec\(/.test(body), false);
});

test('sdd_upstream exposes the setup action with opt-in switch and upgrade parameters', () => {
  const registered = [];
  const ctx = { tools: { register: (t) => { registered.push(t); return () => {}; } } };
  registerSddTools(ctx, (d) => d);
  const tool = registered.find((t) => t.name === 'sdd_upstream');
  assert.match(tool.parameters.action.description, /\bsetup\b/);
  assert.ok(tool.parameters.switchIntegration);
  assert.ok(tool.parameters.upgrade);
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

    for (const skillName of [
      'speckit-superpowers-hooks-before-implement',
      'speckit-superpowers-hooks-after-implement',
      'speckit-superpowers-hooks-before-bug-fix',
      'speckit-superpowers-hooks-after-bug-fix',
      'speckit-superpowers-hooks-guard',
      'speckit-superpowers-hooks-guidance',
    ]) {
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
        'speckit.superpowers-hooks.guard',
        'speckit.superpowers-hooks.guard',
      ],
      'AC-01: every hook event must carry exactly one extension entry'
    );
    assert.equal(
      (cfg.match(/optional: false/g) || []).length,
      6,
      'every hook must be mandatory (REQ-06)'
    );
    assert.equal(
      (cfg.match(/priority: 5/g) || []).length,
      4,
      'pre-hooks must run at priority 5'
    );
    assert.equal(
      (cfg.match(/priority: 15/g) || []).length,
      2,
      'post-hooks must run at priority 15'
    );
    assert.equal(
      (cfg.match(/condition: null/g) || []).length,
      6,
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
  assert.match(readme, /宿主中立 CLI/, 'README must advertise the v5.0.0 CLI surface');

  const constitution = await fs.readFile(
    path.join(PKG_ROOT, '.specify', 'memory', 'constitution.md'),
    'utf8'
  );
  assert.match(
    constitution,
    /严格限定为两个命名技能/,
    'the constitution must state the two-skill surface (AC-05)'
  );
  assert.match(
    constitution,
    /一个宿主中立的命令行入口/,
    'the constitution must state the v5.0.0 CLI surface (C1)'
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
        'speckit.superpowers-hooks.guard',
        'speckit.superpowers-hooks.guard',
      ],
      'INV-7: every event must carry exactly one entry after a reinstall'
    );
    assert.deepEqual(installedEntriesOf(afterSecond), ['superpowers-hooks'], 'INV-10: installed must not duplicate');
    assert.equal(
      (afterSecond.match(/optional: false/g) || []).length,
      6,
      'a reinstall must not duplicate hook entries'
    );
    assert.equal(second.restartRequired, false, 'INV-13: a pure reinstall must not demand a restart');
    assert.equal(second.skillsDir, '.dsh/skills', 'INV-12: the report must reflect the dsh skill root');

    const events = (cfg) => cfg.split(/\r?\n/).filter((line) => /^  [a-z_]+:$/.test(line)).map((line) => line.trim());
    assert.deepEqual(events(afterSecond), events(afterFirst), 'INV-8: a reinstall must not add orphan event keys');
    assert.deepEqual(
      events(afterSecond),
      [
        'before_implement:', 'after_implement:', 'before_bug_fix:', 'after_bug_fix:',
        'before_clarify:', 'before_plan:',
      ]
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
      cfg.split(/\r?\n/).filter((line) => /^  [a-z_]+:$/.test(line)).length,
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

function setupFakes({ hasSpecifyDir = true, uvInstalled = true, specifyInstalled = true, syncOk = true, mismatch = null, commandsOk = true } = {}) {
  const calls = [];
  let switched = false;
  const upstream = async (args) => {
    calls.push(args.action);
    switch (args.action) {
      case 'status':
        return {
          uv: { installed: uvInstalled },
          specifyCli: { installed: specifyInstalled, version: 'specify 1.4.4.dev0' },
          superpowers: { installed: true, head: 'abc1234', skillCount: 15 },
        };
      case 'sync_superpowers':
        return syncOk ? { ok: true, mode: 'pull', skillCount: 15 } : { ok: false, code: 128, stderr: 'fatal: offline' };
      case 'specify_upgrade': return { ok: true, mode: 'install' };
      case 'specify_init': return { ok: true };
      case 'ensure_integration_commands':
        return commandsOk
          ? { ok: true, present: true, repaired: true, integration: 'dsh', skillsDir: '.dsh/skills', commands: ['specify integration upgrade dsh'] }
          : { ok: false, present: false, error: { code: 'E_INTEGRATION_COMMANDS', message: 'native commands missing', hint: 'run specify init --here --force' } };
      case 'install_bug_ext': return { ok: true };
      case 'install_hooks_ext': {
        const active = switched ? null : mismatch;
        return {
          ok: true,
          extension: { id: 'superpowers-hooks', version: '0.1.0' },
          hooks: ['before_implement', 'after_implement', 'before_bug_fix', 'after_bug_fix'],
          integration: active ? 'claude' : 'dsh',
          skillsDir: active ? '.claude/skills' : '.dsh/skills',
          integrationMismatch: active,
        };
      }
      case 'switch_integration':
        switched = true;
        return { ok: true, integration: 'dsh' };
      default: throw new Error(`unexpected upstream action: ${args.action}`);
    }
  };
  const bridge = async (args) =>
    args.action === 'inspect'
      ? { hasSpecifyDir, hasConstitution: true, hasEarsOverride: false, features: [], bugs: [] }
      : {
          action: 'install_overrides',
          ok: true,
          status: 'written',
          path: '/tmp/project/.specify/templates/overrides/spec-template.md',
          artifacts: [{
            id: 'ears-spec-template',
            status: 'written',
            verdict: 'not_installed',
            reason: null,
            nextAction: null,
            snapshot: null,
          }],
        };
  return { calls, deps: { runUpstream: upstream, runBridge: bridge } };
}

const SETUP_STEP_ORDER = [
  'inspect', 'sync_superpowers', 'specify_cli', 'specify_init', 'integration_commands',
  'install_bug_ext', 'install_hooks_ext', 'install_overrides',
];

test('runSetup: the install_overrides step reports the classification detail (REQ-05)', async () => {
  const { deps } = setupFakes({ hasSpecifyDir: true });
  const report = await runSetup({ cwd: process.cwd() }, deps);
  const step = report.steps.find((s) => s.name === 'install_overrides');
  assert.equal(step.status, 'performed');
  assert.equal(step.detail.status, 'written');
  assert.equal(step.detail.verdict, 'not_installed');
  assert.equal(step.detail.nextAction, null);
  assert.equal(step.detail.artifacts.length, 1);
});

test('runSetup: a partial artifact failure fails the whole run even when the top status looks written (REQ-16)', async () => {
  const { deps } = setupFakes({ hasSpecifyDir: true });
  const partial = async (args) =>
    args.action === 'inspect'
      ? { hasSpecifyDir: true, hasConstitution: true, hasEarsOverride: false, features: [], bugs: [] }
      : {
          action: 'install_overrides',
          ok: false,
          status: 'written',
          path: '/tmp/x/.specify/templates/overrides/spec-template.md',
          artifacts: [
            { id: 'ears-spec-template', status: 'written', verdict: 'not_installed', reason: null, nextAction: null, snapshot: null },
            { id: 'other', status: 'failed', verdict: 'unknown', reason: 'EACCES', nextAction: null, snapshot: null },
          ],
        };
  const report = await runSetup({ cwd: process.cwd() }, { ...deps, runBridge: partial });
  const step = report.steps.find((s) => s.name === 'install_overrides');
  assert.equal(step.status, 'failed', 'ok:false must win over the backwards-compatible top status');
  assert.equal(step.detail.artifacts.length, 2);
  assert.equal(report.ok, false);
});

test('runSetup: a failed override install fails the whole run without hiding other steps (REQ-16)', async () => {
  const { deps } = setupFakes({ hasSpecifyDir: true });
  const failing = async (args) =>
    args.action === 'inspect'
      ? { hasSpecifyDir: true, hasConstitution: true, hasEarsOverride: false, features: [], bugs: [] }
      : {
          action: 'install_overrides',
          ok: false,
          status: 'failed',
          path: '/tmp/x/.specify/templates/overrides/spec-template.md',
          artifacts: [{
            id: 'ears-spec-template',
            status: 'failed',
            verdict: 'unknown',
            reason: 'EACCES',
            nextAction: null,
            snapshot: null,
          }],
        };
  const report = await runSetup({ cwd: process.cwd() }, { ...deps, runBridge: failing });
  const step = report.steps.find((s) => s.name === 'install_overrides');
  assert.equal(step.status, 'failed');
  assert.equal(step.detail.reason, 'EACCES');
  assert.equal(report.ok, false);
  assert.equal(report.steps.some((s) => s.name === 'install_hooks_ext'), true);
});

test('runSetup: fresh project runs init and installs both extensions in order', async () => {
  const { calls, deps } = setupFakes({ hasSpecifyDir: false, specifyInstalled: false });
  const report = await runSetup({ cwd: process.cwd() }, deps);
  assert.equal(report.ok, true);
  assert.deepEqual(report.steps.map((s) => s.name), SETUP_STEP_ORDER);
  assert.equal(report.steps.find((s) => s.name === 'specify_init').status, 'performed');
  assert.equal(report.steps.find((s) => s.name === 'specify_cli').status, 'performed');
  assert.ok(calls.includes('install_bug_ext'), 'bug extension must be installed even on fresh init');
  assert.ok(calls.includes('install_hooks_ext'));
});

test('runSetup: existing project skips init and stays idempotent across reruns', async () => {
  const { calls, deps } = setupFakes({ hasSpecifyDir: true });
  const first = await runSetup({ cwd: process.cwd() }, deps);
  const second = await runSetup({ cwd: process.cwd() }, deps);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(calls.includes('specify_init'), false, 'REQ-15: never re-init an existing layout');
  assert.deepEqual(
    second.steps.map((s) => [s.name, s.status]),
    first.steps.map((s) => [s.name, s.status])
  );
  assert.equal(second.steps.find((s) => s.name === 'specify_init').status, 'skipped');
  assert.equal(second.steps.find((s) => s.name === 'install_bug_ext').status, 'performed', 'extensions are ensured on every run');
});

test('runSetup: repairs missing native commands after skipping init (legacy checkout)', async () => {
  const { calls, deps } = setupFakes({ hasSpecifyDir: true });
  const report = await runSetup({ cwd: process.cwd() }, deps);
  const step = report.steps.find((s) => s.name === 'integration_commands');
  assert.equal(step.status, 'performed');
  assert.ok(
    calls.indexOf('specify_init') < calls.indexOf('ensure_integration_commands'),
    'the repair runs after the REQ-15 init decision'
  );
  assert.ok(
    calls.indexOf('ensure_integration_commands') < calls.indexOf('install_bug_ext'),
    'integration-managed commands are repaired before extension skills are installed'
  );
});

test('runSetup: a failed command repair fails the run but still installs both extensions', async () => {
  const { deps } = setupFakes({ commandsOk: false });
  const report = await runSetup({ cwd: process.cwd() }, deps);
  assert.equal(report.ok, false);
  assert.equal(report.steps.find((s) => s.name === 'integration_commands').status, 'failed');
  assert.equal(report.steps.find((s) => s.name === 'install_hooks_ext').status, 'performed');
});

test('runSetup: a Superpowers sync failure does not abort the extension install (REQ-11)', async () => {
  const { deps } = setupFakes({ syncOk: false });
  const report = await runSetup({ cwd: process.cwd() }, deps);
  assert.equal(report.ok, false);
  assert.equal(report.steps.find((s) => s.name === 'sync_superpowers').status, 'failed');
  assert.equal(report.steps.find((s) => s.name === 'install_hooks_ext').status, 'performed');
});

test('runSetup: missing uv stops before touching the repository', async () => {
  const { calls, deps } = setupFakes({ hasSpecifyDir: false, uvInstalled: false });
  const report = await runSetup({ cwd: process.cwd() }, deps);
  assert.equal(report.ok, false);
  assert.equal(calls.includes('specify_init'), false);
  assert.equal(calls.includes('install_bug_ext'), false);
  assert.match(report.steps.find((s) => s.name === 'specify_cli').detail.hint, /uv/);
});

test('runSetup: integration switch happens only on explicit opt-in', async () => {
  const mismatch = { current: 'claude', expected: 'dsh', switchCommand: 'specify integration switch dsh', note: 'x' };
  const auto = setupFakes({ mismatch });
  const reportAuto = await runSetup({ cwd: process.cwd() }, auto.deps);
  assert.equal(auto.calls.includes('switch_integration'), false, 'default path must never switch');
  assert.ok(reportAuto.integrationMismatch, 'mismatch must be reported, not silently fixed');

  const optIn = setupFakes({ mismatch });
  const reportOpt = await runSetup({ cwd: process.cwd(), switchIntegration: true }, optIn.deps);
  assert.ok(optIn.calls.includes('switch_integration'));
  assert.ok(optIn.calls.filter((a) => a === 'install_hooks_ext').length === 2, 'hooks must be regenerated after the switch');
  assert.equal(reportOpt.integrationMismatch, null);
});

test('unknown actions return structured E_ARGS instead of throwing', async () => {
  const up = await runUpstream({ action: 'nope' });
  assert.equal(up.ok, false);
  assert.equal(up.error.code, 'E_ARGS');
  assert.match(up.error.hint, /setup|status/);
  const br = await runBridge({ action: 'check_task', featureName: 'x', taskMatch: 'T001' });
  assert.equal(br.ok, false);
  assert.equal(br.error.code, 'E_ARGS');
  assert.match(br.error.message, /Unknown sdd_bridge action/);
});

test('ensure_integration_commands repairs a real project whose .dsh/skills was deleted', async (t) => {
  if (!(await specifyAvailable())) {
    t.skip('specify CLI not available');
    return;
  }
  const cwd = await makeTempDir();
  try {
    const init = await runUpstream({ action: 'specify_init', cwd });
    assert.equal(init.ok, true, init.stderr);

    const skillsDir = path.join(cwd, '.dsh', 'skills');
    assert.ok(
      await fs.access(path.join(skillsDir, 'speckit-implement', 'SKILL.md')).then(() => true, () => false),
      'a fresh init must generate the native command skills'
    );
    await fs.rm(skillsDir, { recursive: true, force: true });

    const repaired = await runUpstream({ action: 'ensure_integration_commands', cwd });
    assert.equal(repaired.ok, true, JSON.stringify(repaired));
    assert.equal(repaired.repaired, true);
    assert.equal(repaired.present, true);
    assert.ok(repaired.commands.length >= 1);
    assert.deepEqual(
      await fs.readdir(skillsDir),
      ['speckit-analyze', 'speckit-checklist', 'speckit-clarify', 'speckit-constitution',
        'speckit-converge', 'speckit-implement', 'speckit-plan', 'speckit-specify', 'speckit-tasks']
    );

    const again = await runUpstream({ action: 'ensure_integration_commands', cwd });
    assert.equal(again.repaired, false, 'a healthy layout needs no repair');
    assert.deepEqual(again.commands, []);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 003-install-safety-hardening · 底座原语（原子写 / 守卫 / 产物清单 / 快照）
// ---------------------------------------------------------------------------

test('fsutil: atomicWriteFile swaps the inode and leaves no temp residue', async () => {
  const cwd = await makeTempDir();
  try {
    const target = path.join(cwd, 'a.md');
    await fs.writeFile(target, 'v1', 'utf8');
    const before = await fs.stat(target, { bigint: true });

    await atomicWriteFile(target, Buffer.from('v2', 'utf8'));

    assert.equal(await fs.readFile(target, 'utf8'), 'v2');
    const after = await fs.stat(target, { bigint: true });
    assert.notEqual(after.ino, before.ino, 'the swap must publish a new inode, not rewrite in place');
    assert.deepEqual(await fs.readdir(cwd), ['a.md'], 'no temp file may survive a successful write');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('fsutil: atomicWriteFile keeps the target intact and cleans up when the publish step fails', async () => {
  const cwd = await makeTempDir();
  try {
    const target = path.join(cwd, 'a.md');
    await fs.writeFile(target, 'v1', 'utf8');
    // A non-empty directory at the target path makes rename() fail (ENOTEMPTY/EISDIR)
    // after the temp file has been written and fsynced — a real failure, not a mock.
    await fs.rm(target);
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'keep'), 'x', 'utf8');

    await assert.rejects(() => atomicWriteFile(target, Buffer.from('v2', 'utf8')));

    assert.deepEqual(await fs.readdir(cwd), ['a.md'], 'the temp file must be removed on failure');
    assert.equal((await fs.stat(target)).isDirectory(), true, 'the original entry must be untouched');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('fsutil: guards reject path escapes and symlinked components', async (t) => {
  if (process.platform === 'win32') {
    return t.skip('creating symlinks on Windows needs elevation; covered on POSIX only');
  }
  const cwd = await makeTempDir();
  const outside = await makeTempDir();
  try {
    assert.throws(() => assertInside(cwd, path.join(cwd, '..', 'x.md')), /E_ESCAPE/);
    assert.equal(assertInside(cwd, path.join(cwd, 'a', 'x.md')), path.join(cwd, 'a', 'x.md'));

    const link = path.join(cwd, 'a-link');
    await fs.symlink(outside, link);

    assert.equal(await findSymlinkComponent(cwd, path.join(cwd, 'a', 'x.md')), null);
    assert.equal(await findSymlinkComponent(cwd, path.join(cwd, 'a-link', 'x.md')), link);
    await assert.rejects(() => assertNoSymlinkComponent(cwd, path.join(cwd, 'a-link', 'x.md')), /E_SYMLINK/);
    assert.equal(await assertNoSymlinkComponent(cwd, path.join(cwd, 'a', 'x.md')), null);

    if (process.getuid?.() !== 0) {
      const locked = path.join(cwd, 'locked');
      await fs.mkdir(locked);
      await fs.writeFile(path.join(locked, 'x.md'), 'x\n', 'utf8');
      await fs.chmod(locked, 0o000);
      await assert.rejects(
        () => findSymlinkComponent(cwd, path.join(locked, 'x.md')),
        /EACCES/,
        'an unreadable component is not the same as a missing one'
      );
      await fs.chmod(locked, 0o755);
    }
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('artifacts: the managed list and the fingerprint ledger agree with the bundled bytes', async () => {
  const cwd = await makeTempDir();
  try {
    const artifacts = await listArtifacts(cwd);
    assert.equal(artifacts.length, 1);
    const [artifact] = artifacts;
    assert.equal(artifact.id, 'ears-spec-template');
    assert.equal(artifact.owner, 'plugin');
    assert.equal(artifact.path, path.join(cwd, '.specify', 'templates', 'overrides', 'spec-template.md'));
    assert.equal(artifact.snapshotDir, path.join(cwd, '.specify', 'templates', 'overrides', '.backup'));
    assert.equal(artifact.bundledSha256, await sha256File(artifact.bundledPath));

    const ledger = await readLedger(artifact.ledgerPath);
    assert.equal(ledger.artifact, 'spec-template.md');
    assert.equal(ledger.versions.at(-1).sha256, artifact.bundledSha256, 'INV-2: the last ledger entry is the shipped fingerprint');
    assert.equal(new Set(ledger.versions.map((v) => v.sha256)).size, ledger.versions.length, 'INV-8: no duplicate fingerprints');
    assert.equal(await bundledVersion(artifact), ledger.versions.at(-1).sinceVersion);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('snapshot: capture self-ignores the backup directory and refreshes only on content change', async () => {
  const cwd = await makeTempDir();
  try {
    const [artifact] = await listArtifacts(cwd);
    await writeSeed(cwd, '.specify/templates/overrides/spec-template.md', 'v1\n');

    const first = await captureSnapshot(cwd, artifact, { clock: () => '2026-01-01T00:00:00.000Z' });
    assert.equal(first.captured, true);
    assert.equal(await fs.readFile(path.join(artifact.snapshotDir, '.gitignore'), 'utf8'), '*\n');
    assert.equal(await fs.readFile(path.join(artifact.snapshotDir, 'ears-spec-template.bak'), 'utf8'), 'v1\n');

    const manifest = await readManifest(artifact);
    assert.equal(manifest.schema, 1);
    const entry = manifest.snapshots['ears-spec-template'];
    assert.equal(entry.relativePath, '.specify/templates/overrides/spec-template.md');
    assert.equal(entry.sha256, await sha256File(artifact.path));
    assert.equal(entry.sourceVersion, null, 'content that no ledger entry knows has no version');
    assert.equal(entry.capturedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(Object.keys(manifest.snapshots).includes('.gitignore'), false, 'the ignore file is not a snapshot entry');

    const second = await captureSnapshot(cwd, artifact, { clock: () => '2026-01-02T00:00:00.000Z' });
    assert.equal(second.captured, false, 'INV-14: an up-to-date snapshot is not refreshed');
    assert.equal(second.restorable, true, 'the existing .bak is still the copy to roll back to');
    assert.equal(second.path, path.join(artifact.snapshotDir, 'ears-spec-template.bak'));
    assert.equal((await readManifest(artifact)).snapshots['ears-spec-template'].capturedAt, '2026-01-01T00:00:00.000Z');

    await writeSeed(cwd, '.specify/templates/overrides/spec-template.md', 'v2\n');
    const third = await captureSnapshot(cwd, artifact, { clock: () => '2026-01-03T00:00:00.000Z' });
    assert.equal(third.captured, true);
    assert.equal(await fs.readFile(path.join(artifact.snapshotDir, 'ears-spec-template.bak'), 'utf8'), 'v2\n');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 003 US1 · 幂等状态检测（四分类 + unknown 兜底）
// ---------------------------------------------------------------------------

const EARS_OVERRIDE = path.join('.specify', 'templates', 'overrides', 'spec-template.md');
const EARS_BACKUP = path.join('.specify', 'templates', 'overrides', '.backup');

test('install_overrides: writes only when absent and then leaves a consistent file untouched (AC-01)', async () => {
  const cwd = await makeTempDir();
  try {
    const first = await runBridge({ action: 'install_overrides', cwd });
    assert.equal(first.ok, true);
    assert.equal(first.status, 'written');
    assert.equal(first.path, path.join(cwd, EARS_OVERRIDE));
    assert.equal(first.artifacts.length, 1);
    assert.equal(first.artifacts[0].id, 'ears-spec-template');
    assert.equal(first.artifacts[0].verdict, 'not_installed');
    assert.equal(
      await fs.readFile(path.join(cwd, EARS_OVERRIDE), 'utf8'),
      await fs.readFile(path.join(PKG_ROOT, 'overrides', 'spec-template.md'), 'utf8')
    );

    const before = await fs.stat(path.join(cwd, EARS_OVERRIDE), { bigint: true });
    const second = await runBridge({ action: 'install_overrides', cwd });
    const after = await fs.stat(path.join(cwd, EARS_OVERRIDE), { bigint: true });

    assert.equal(second.ok, true);
    assert.equal(second.status, 'unchanged');
    assert.equal(second.artifacts[0].verdict, 'installed_consistent');
    assert.equal(second.artifacts[0].localVersion, null, 'localVersion is only meaningful for stale_upstream');
    assert.equal(after.mtimeNs, before.mtimeNs, 'INV-5: a consistent install must not touch the file');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('install_overrides: leaves hand edits alone and offers a machine-readable next action (AC-02)', async () => {
  const cwd = await makeTempDir();
  try {
    await runBridge({ action: 'install_overrides', cwd });
    await writeSeed(cwd, EARS_OVERRIDE, 'hand edited\n');

    const result = await runBridge({ action: 'install_overrides', cwd });
    const [artifact] = result.artifacts;

    assert.equal(result.ok, true, 'refusing to overwrite is not a failure');
    assert.equal(result.status, 'skipped_user_modified');
    assert.equal(artifact.verdict, 'user_modified');
    assert.equal(artifact.reason, null);
    assert.deepEqual(artifact.nextAction, {
      tool: 'sdd_bridge',
      args: { action: 'install_overrides', overwrite: true },
    });
    assert.equal(await fs.readFile(path.join(cwd, EARS_OVERRIDE), 'utf8'), 'hand edited\n');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('install_overrides: reports a stale shipped template with both versions (AC-03)', async () => {
  const cwd = await makeTempDir();
  const bundledDir = path.join(cwd, 'bundled');
  const target = path.join(cwd, EARS_OVERRIDE);
  try {
    const oldBytes = 'old template\n';
    const newBytes = 'new template\n';
    await fs.mkdir(bundledDir, { recursive: true });
    await fs.writeFile(path.join(bundledDir, 'spec-template.md'), newBytes, 'utf8');
    await fs.writeFile(
      path.join(bundledDir, 'spec-template.versions.json'),
      `${JSON.stringify({
        artifact: 'spec-template.md',
        versions: [
          { sinceVersion: '0.1.0', sha256: sha256Bytes(Buffer.from(oldBytes, 'utf8')) },
          { sinceVersion: '0.2.0', sha256: sha256Bytes(Buffer.from(newBytes, 'utf8')) },
        ],
      }, null, 2)}\n`,
      'utf8'
    );
    const artifacts = await listArtifacts(cwd, { bundledDir });
    await writeSeed(cwd, EARS_OVERRIDE, oldBytes);

    const result = await runBridge({ action: 'install_overrides', cwd }, { artifacts });
    const [artifact] = result.artifacts;
    assert.equal(result.status, 'skipped_stale');
    assert.equal(artifact.verdict, 'stale_upstream');
    assert.equal(artifact.localVersion, '0.1.0');
    assert.equal(artifact.bundledVersion, '0.2.0');
    assert.equal(artifact.nextAction.args.overwrite, true, 'INV-20a: a stale file must offer a next action');
    assert.equal(await fs.readFile(target, 'utf8'), oldBytes, 'a stale file is not rewritten without intent');

    const forced = await runBridge({ action: 'install_overrides', cwd, overwrite: true }, { artifacts });
    assert.equal(forced.status, 'refreshed');
    assert.equal(forced.artifacts[0].verdict, 'stale_upstream');
    assert.equal(await fs.readFile(target, 'utf8'), newBytes);
    const manifest = JSON.parse(await fs.readFile(path.join(cwd, EARS_BACKUP, 'manifest.json'), 'utf8'));
    assert.equal(manifest.snapshots['ears-spec-template'].sha256, sha256Bytes(Buffer.from(oldBytes, 'utf8')));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('install_overrides: an unreadable target is unknown, never treated as absent (AC-04)', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX permission bits are not enforceable on Windows');
  if (process.getuid?.() === 0) return t.skip('root ignores file permission bits');
  const cwd = await makeTempDir();
  const target = path.join(cwd, EARS_OVERRIDE);
  try {
    await runBridge({ action: 'install_overrides', cwd });
    await fs.chmod(target, 0o000);

    const result = await runBridge({ action: 'install_overrides', cwd });
    const [artifact] = result.artifacts;
    assert.equal(artifact.verdict, 'unknown');
    assert.equal(result.status, 'failed');
    assert.equal(result.ok, false);
    assert.ok(artifact.reason, 'INV-4: unknown must carry a reason');
  } finally {
    await fs.chmod(target, 0o644).catch(() => {});
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('install_overrides: an empty artifact list is not success (report aggregation)', async () => {
  const cwd = await makeTempDir();
  try {
    const result = await runBridge({ action: 'install_overrides', cwd }, { artifacts: [] });
    assert.equal(result.ok, false, 'an empty list proves nothing and must not report ok');
    assert.deepEqual(result.artifacts, []);
    assert.equal(result.action, 'install_overrides');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 003 US2 · 快照刷新与一键回滚
// ---------------------------------------------------------------------------

test('restore_overrides: restores the pre-overwrite bytes and keeps the snapshot reusable (AC-06/AC-07)', async () => {
  const cwd = await makeTempDir();
  const target = path.join(cwd, EARS_OVERRIDE);
  try {
    await runBridge({ action: 'install_overrides', cwd });
    const shipped = await fs.readFile(target, 'utf8');
    await writeSeed(cwd, EARS_OVERRIDE, 'hand edited\n');

    const forced = await runBridge({ action: 'install_overrides', cwd, overwrite: true });
    assert.equal(forced.status, 'written', 'only stale_upstream + overwrite is `refreshed`');
    assert.deepEqual(forced.artifacts[0].snapshot, {
      captured: true,
      refreshed: false,
      path: path.join(cwd, EARS_BACKUP, 'ears-spec-template.bak'),
    });
    assert.equal(await fs.readFile(target, 'utf8'), shipped);

    const restored = await runBridge({ action: 'restore_overrides', cwd });
    assert.equal(restored.ok, true);
    assert.equal(restored.status, 'restored');
    assert.equal(restored.restored.length, 1);
    assert.equal(restored.restored[0].id, 'ears-spec-template');
    assert.equal(restored.restored[0].path, target);
    assert.equal(restored.restored[0].sourceVersion, null, 'an unledgered snapshot has no version');
    assert.equal(await fs.readFile(target, 'utf8'), 'hand edited\n');
    assert.equal(
      await fs.readFile(path.join(cwd, EARS_BACKUP, 'ears-spec-template.bak'), 'utf8'),
      'hand edited\n',
      'INV-18: the snapshot survives a restore'
    );

    const again = await runBridge({ action: 'restore_overrides', cwd });
    assert.equal(again.ok, true, 'a second restore must still succeed');
    assert.equal(await fs.readFile(target, 'utf8'), 'hand edited\n');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('restore_overrides: an empty or missing snapshot set is a failure, never a fake success (AC-07)', async () => {
  const cwd = await makeTempDir();
  try {
    const fresh = await runBridge({ action: 'restore_overrides', cwd });
    assert.equal(fresh.ok, false);
    assert.equal(fresh.status, 'no_snapshot');
    assert.deepEqual(fresh.restored, []);
    assert.equal(fresh.reason, 'E_NO_SNAPSHOT');

    await writeSeed(cwd, path.join(EARS_BACKUP, 'manifest.json'), '{"schema":1,"snapshots":{}}\n');
    const empty = await runBridge({ action: 'restore_overrides', cwd });
    assert.equal(empty.ok, false, 'an empty manifest must not report ok');
    assert.equal(empty.status, 'no_snapshot');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('restore_overrides: a tampered or missing snapshot fails loudly and writes nothing (INV-15)', async () => {
  const cwd = await makeTempDir();
  const target = path.join(cwd, EARS_OVERRIDE);
  try {
    await runBridge({ action: 'install_overrides', cwd });
    await writeSeed(cwd, EARS_OVERRIDE, 'hand edited\n');
    await runBridge({ action: 'install_overrides', cwd, overwrite: true });
    const current = await fs.readFile(target, 'utf8');

    await fs.appendFile(path.join(cwd, EARS_BACKUP, 'ears-spec-template.bak'), 'tampered\n', 'utf8');
    const tampered = await runBridge({ action: 'restore_overrides', cwd });
    assert.equal(tampered.ok, false);
    assert.equal(tampered.status, 'partial');
    assert.equal(tampered.restored[0].reason, 'E_SNAPSHOT_CHECKSUM_MISMATCH');
    assert.equal(await fs.readFile(target, 'utf8'), current, 'a failed verification must not write');

    await fs.rm(path.join(cwd, EARS_BACKUP, 'ears-spec-template.bak'));
    const missing = await runBridge({ action: 'restore_overrides', cwd });
    assert.equal(missing.ok, false);
    assert.equal(missing.restored[0].reason, 'E_SNAPSHOT_MISSING');
    assert.equal(await fs.readFile(target, 'utf8'), current);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('restore_overrides: an unknown artifact id is an argument error and touches nothing (E_ARGS)', async () => {
  const cwd = await makeTempDir();
  const target = path.join(cwd, EARS_OVERRIDE);
  try {
    await runBridge({ action: 'install_overrides', cwd });
    await writeSeed(cwd, EARS_OVERRIDE, 'hand edited\n');
    await runBridge({ action: 'install_overrides', cwd, overwrite: true });

    const result = await runBridge({ action: 'restore_overrides', cwd, artifact: 'nope' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'E_ARGS');
    assert.notEqual(await fs.readFile(target, 'utf8'), 'hand edited\n');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('restore_overrides: stays inside the project and refuses a symlinked target (REQ-11/REQ-15)', async (t) => {
  if (process.platform === 'win32') return t.skip('creating symlinks on Windows needs elevation; covered on POSIX only');
  const cwd = await makeTempDir();
  const outside = await makeTempDir();
  try {
    await runBridge({ action: 'install_overrides', cwd });
    await writeSeed(cwd, EARS_OVERRIDE, 'hand edited\n');
    await runBridge({ action: 'install_overrides', cwd, overwrite: true });

    const sentinel = path.join(cwd, 'sentinel.txt');
    await fs.writeFile(sentinel, 'untouched\n', 'utf8');
    const sentinelBefore = await fs.stat(sentinel, { bigint: true });

    const target = path.join(cwd, EARS_OVERRIDE);
    await fs.rm(target);
    const external = path.join(outside, 'spec-template.md');
    await fs.writeFile(external, 'outside\n', 'utf8');
    await fs.symlink(external, target);

    const result = await runBridge({ action: 'restore_overrides', cwd });
    assert.equal(result.ok, false);
    assert.match(result.restored[0].reason, /^E_SYMLINK: /);
    assert.equal(await fs.readFile(external, 'utf8'), 'outside\n', 'the link target must not be written');
    assert.equal((await fs.lstat(target)).isSymbolicLink(), true, 'the link itself must survive');

    const sentinelAfter = await fs.stat(sentinel, { bigint: true });
    assert.equal(sentinelAfter.mtimeNs, sentinelBefore.mtimeNs, 'REQ-11: files outside the manifest are untouched');
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'untouched\n');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('restore_overrides: an artifact filter restores only the requested entry', async () => {
  const cwd = await makeTempDir();
  const other = path.join(cwd, '.specify', 'templates', 'overrides', 'other.md');
  try {
    const [base] = await listArtifacts(cwd);
    const second = {
      ...base,
      id: 'other-artifact',
      path: other,
      bundledPath: path.join(cwd, 'bundled-other.md'),
      snapshotDir: base.snapshotDir,
    };
    await fs.writeFile(second.bundledPath, 'other shipped\n', 'utf8');
    await writeSeed(cwd, '.specify/templates/overrides/other.md', 'other hand\n');
    await writeSeed(cwd, EARS_OVERRIDE, 'ears hand\n');

    const artifacts = [base, second];
    await runBridge({ action: 'install_overrides', cwd, overwrite: true }, { artifacts });
    await fs.writeFile(second.path, 'other shipped v2\n', 'utf8');
    await fs.writeFile(base.path, 'ears shipped v2\n', 'utf8');

    const result = await runBridge({ action: 'restore_overrides', cwd, artifact: 'other-artifact' }, { artifacts });
    assert.equal(result.ok, true);
    assert.deepEqual(result.restored.map((r) => r.id), ['other-artifact']);
    assert.equal(await fs.readFile(other, 'utf8'), 'other hand\n', 'the snapshot holds the pre-overwrite bytes');
    assert.equal(await fs.readFile(base.path, 'utf8'), 'ears shipped v2\n', 'the unrequested artifact is untouched');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('sdd_bridge: an unknown action enumerates all four supported actions (REQ-12)', async () => {
  const result = await runBridge({ action: 'nope' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'E_ARGS');
  assert.match(result.error.message, /Unknown sdd_bridge action "nope"/);
  for (const name of ['inspect', 'install_overrides', 'restore_overrides', 'sync_index']) {
    assert.match(result.error.message, new RegExp(name), `the hint must list ${name}`);
  }
});

// ---------------------------------------------------------------------------
// 003 US3 · 原子写入与符号链接防护（AC-08/AC-09）
// ---------------------------------------------------------------------------

test('install_overrides: a symlinked target is refused before any write (AC-08)', async (t) => {
  if (process.platform === 'win32') return t.skip('creating symlinks on Windows needs elevation; covered on POSIX only');
  const cwd = await makeTempDir();
  const outside = await makeTempDir();
  try {
    await fs.mkdir(path.join(cwd, path.dirname(EARS_OVERRIDE)), { recursive: true });
    const external = path.join(outside, 'spec-template.md');
    await fs.writeFile(external, 'outside\n', 'utf8');
    await fs.symlink(external, path.join(cwd, EARS_OVERRIDE));

    const result = await runBridge({ action: 'install_overrides', cwd });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.match(result.artifacts[0].reason, /^E_SYMLINK: /);
    assert.equal(await fs.readFile(external, 'utf8'), 'outside\n');
    assert.equal((await fs.lstat(path.join(cwd, EARS_OVERRIDE))).isSymbolicLink(), true);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('install_overrides: a symlinked parent directory is refused on first install (REQ-15)', async (t) => {
  if (process.platform === 'win32') return t.skip('creating symlinks on Windows needs elevation; covered on POSIX only');
  const cwd = await makeTempDir();
  const outside = await makeTempDir();
  try {
    await fs.mkdir(path.join(cwd, '.specify', 'templates'), { recursive: true });
    await fs.symlink(outside, path.join(cwd, '.specify', 'templates', 'overrides'));

    const result = await runBridge({ action: 'install_overrides', cwd });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.match(result.artifacts[0].reason, /^E_SYMLINK: /);
    assert.deepEqual(await fs.readdir(outside), [], 'nothing may be created behind the link');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('install_overrides: explicit overwrite guards the snapshot path before writing outside (REQ-15)', async (t) => {
  if (process.platform === 'win32') return t.skip('creating symlinks on Windows needs elevation; covered on POSIX only');
  const cwd = await makeTempDir();
  const outside = await makeTempDir();
  try {
    await fs.mkdir(path.join(cwd, '.specify', 'templates'), { recursive: true });
    await fs.writeFile(path.join(outside, 'spec-template.md'), 'outside hand edit\n', 'utf8');
    await fs.symlink(outside, path.join(cwd, '.specify', 'templates', 'overrides'));

    const result = await runBridge({ action: 'install_overrides', cwd, overwrite: true });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.match(result.artifacts[0].reason, /^E_SYMLINK: /);
    assert.deepEqual(await fs.readdir(outside), ['spec-template.md'], 'no snapshot may be created behind the link');
    assert.equal(await fs.readFile(path.join(outside, 'spec-template.md'), 'utf8'), 'outside hand edit\n');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('install_overrides: an unreadable target is never overwritten without a snapshot (REQ-09/REQ-11)', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX permission bits are not enforceable on Windows');
  if (process.getuid?.() === 0) return t.skip('root ignores file permission bits');
  const cwd = await makeTempDir();
  const target = path.join(cwd, EARS_OVERRIDE);
  const irreplaceable = 'IRREPLACEABLE USER CONTENT\n';
  try {
    await runBridge({ action: 'install_overrides', cwd });
    await fs.writeFile(target, irreplaceable, 'utf8');
    await fs.chmod(target, 0o000);

    const forced = await runBridge({ action: 'install_overrides', cwd, overwrite: true });
    assert.equal(forced.ok, false, 'an unrecoverable overwrite must not be reported as success');
    assert.equal(forced.status, 'failed');
    assert.equal(forced.artifacts[0].verdict, 'unknown');
    assert.match(forced.artifacts[0].reason, /E_SNAPSHOT_UNREADABLE/);
    assert.equal(forced.artifacts[0].snapshot, null);

    await fs.chmod(target, 0o644);
    assert.equal(await fs.readFile(target, 'utf8'), irreplaceable, 'the user content must still be there');

    const restored = await runBridge({ action: 'restore_overrides', cwd });
    assert.equal(restored.ok, false, 'and no snapshot may be pretended into existence');
    assert.equal(restored.status, 'no_snapshot');
  } finally {
    await fs.chmod(target, 0o644).catch(() => {});
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('install_overrides: a repeated overwrite still reports the reusable snapshot path (REQ-10)', async () => {
  const cwd = await makeTempDir();
  const target = path.join(cwd, EARS_OVERRIDE);
  try {
    await runBridge({ action: 'install_overrides', cwd });
    await writeSeed(cwd, EARS_OVERRIDE, 'first hand edit\n');
    await runBridge({ action: 'install_overrides', cwd, overwrite: true });

    await writeSeed(cwd, EARS_OVERRIDE, 'second hand edit\n');
    const again = await runBridge({ action: 'install_overrides', cwd, overwrite: true });
    assert.equal(again.ok, true);
    assert.deepEqual(again.artifacts[0].snapshot, {
      captured: true,
      refreshed: true,
      path: path.join(cwd, EARS_BACKUP, 'ears-spec-template.bak'),
    });

    const restored = await runBridge({ action: 'restore_overrides', cwd });
    assert.equal(restored.ok, true);
    assert.equal(await fs.readFile(target, 'utf8'), 'second hand edit\n');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('install_overrides: a failed write leaves the target intact and no temp residue (AC-08)', async () => {
  const cwd = await makeTempDir();
  try {
    const [base] = await listArtifacts(cwd);
    await writeSeed(cwd, EARS_OVERRIDE, 'hand edited\n');
    const artifacts = [{ ...base, bundledPath: path.join(cwd, 'not-a-file-directory') }];
    await fs.mkdir(artifacts[0].bundledPath);

    const result = await runBridge({ action: 'install_overrides', cwd, overwrite: true }, { artifacts });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.match(result.artifacts[0].reason, /^EISDIR/);
    assert.equal(await fs.readFile(path.join(cwd, EARS_OVERRIDE), 'utf8'), 'hand edited\n');
    assert.equal(
      (await fs.readdir(path.dirname(path.join(cwd, EARS_OVERRIDE)))).some((name) => name.endsWith('.tmp')),
      false,
      'no temp residue'
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('install_overrides: one failed artifact does not block the next one (AC-09)', async () => {
  const cwd = await makeTempDir();
  try {
    const [base] = await listArtifacts(cwd);
    const broken = { ...base, id: 'broken-artifact', path: path.join(cwd, '.specify', 'templates', 'overrides', 'broken.md'), bundledPath: path.join(cwd, 'missing-bundle-dir') };
    const healthy = { ...base, id: 'healthy-artifact', path: path.join(cwd, '.specify', 'templates', 'overrides', 'healthy.md') };
    await fs.mkdir(broken.bundledPath);

    const result = await runBridge({ action: 'install_overrides', cwd }, { artifacts: [broken, healthy] });
    assert.equal(result.artifacts.length, 2, 'INV-21: every artifact gets a report entry');
    assert.equal(result.artifacts[0].status, 'failed');
    assert.equal(result.artifacts[1].status, 'written');
    assert.equal(result.ok, false, 'one failed artifact fails the whole report');
    assert.equal(await fs.readFile(healthy.path, 'utf8'), await fs.readFile(healthy.bundledPath, 'utf8'));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 003 US4 · 多候选目录选择（AC-05）
// ---------------------------------------------------------------------------

async function seedCandidateDirs(root, names, baseMs) {
  const dirs = [];
  for (let i = 0; i < names.length; i++) {
    const dir = path.join(root, names[i]);
    await fs.mkdir(dir, { recursive: true });
    const when = new Date(baseMs - (names.length - i) * 10000);
    await fs.utimes(dir, when, when);
    dirs.push(dir);
  }
  return dirs;
}

test('candidates: dedupes by realpath and prefers the most recently modified (AC-05)', async (t) => {
  if (process.platform === 'win32') return t.skip('symlink creation on Windows needs elevation; covered on POSIX only');
  const root = await makeTempDir();
  const baseMs = Date.now();
  try {
    const [a, b, c] = await seedCandidateDirs(root, ['a', 'b', 'c'], baseMs);
    const alias = path.join(root, 'alias-to-a');
    await fs.symlink(a, alias);

    const result = await selectSuperpowersDir(
      { candidateDirs: [a, alias, b, c] },
      { HOME: root, DSH_HOME: path.join(root, 'empty-home') }
    );
    assert.equal(result.reason, 'candidateDirs');
    assert.equal(result.dir, c);
    assert.equal(result.realPath, c);
    assert.equal(result.fallback, false);

    const realPaths = result.candidates.filter((x) => x.eligible).map((x) => x.realPath);
    assert.equal(new Set(realPaths).size, realPaths.length, 'INV-10: eligible realPaths are unique');
    assert.equal(result.candidates.filter((x) => x.selected).length, 1, 'INV-12: exactly one winner');
    const aliasEntry = result.candidates.find((x) => x.input === alias);
    assert.equal(aliasEntry.realPath, a);
    assert.equal(aliasEntry.eligible, false, 'an alias of an earlier candidate is ineligible');
    const winner = result.candidates.find((x) => x.selected);
    assert.equal(winner.declaredIndex, 1, 'all candidateDirs entries share declaration index 1');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('candidates: mtime ties fall back to declaration order; nothing resolvable means a default fallback', async (t) => {
  if (process.platform === 'win32') return t.skip('HOME does not control os.homedir() on Windows; covered on POSIX only');
  const root = await makeTempDir();
  const savedHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const [a, b] = await seedCandidateDirs(root, ['a', 'b'], Date.now());
    const when = (await fs.stat(a)).mtimeMs;
    const same = new Date(when);
    await fs.utimes(b, same, same);

    const tied = await selectSuperpowersDir({ candidateDirs: [b, a] }, { HOME: root, DSH_HOME: path.join(root, 'empty-home') });
    assert.equal(tied.dir, b, 'REQ-07: an mtime tie keeps the earlier declared candidate');

    const fallback = await selectSuperpowersDir({ candidateDirs: [] }, { HOME: root, DSH_HOME: path.join(root, 'empty-home') });
    assert.equal(fallback.fallback, true);
    assert.equal(fallback.reason, 'default');
    assert.equal(fallback.realPath, null);
    assert.equal(fallback.candidates.length, 2, 'INV-13: every declaration is kept, even the unresolvable ones');
    assert.equal(fallback.candidates.every((x) => x.eligible === false), true);
    assert.equal(fallback.candidates.filter((x) => x.selected).length, 1);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('candidates: explicit overrides env, and env overrides the DSH home source (REQ-08)', async (t) => {
  if (process.platform === 'win32') return t.skip('HOME does not control os.homedir() on Windows; covered on POSIX only');
  const root = await makeTempDir();
  try {
    const [explicit, mirrored, dshHome] = await seedCandidateDirs(root, ['explicit', 'mirrored', 'dsh-home'], Date.now());
    const env = {
      HOME: root,
      DSH_SDD_KIT_SUPERPOWERS_DIR: mirrored,
      DSH_HOME: path.join(root, 'dsh-root'),
    };
    await fs.mkdir(path.join(root, 'dsh-root', 'upstream'), { recursive: true });
    await fs.symlink(dshHome, path.join(root, 'dsh-root', 'upstream', 'superpowers'));
    const when = (await fs.stat(explicit)).mtimeMs;
    const same = new Date(when);
    for (const dir of [mirrored, dshHome]) await fs.utimes(dir, same, same);

    const envFirst = await selectSuperpowersDir({}, env);
    assert.equal(envFirst.reason, 'env');
    assert.equal(envFirst.dir, mirrored);

    const explicitFirst = await selectSuperpowersDir({ superpowersDir: explicit }, env);
    assert.equal(explicitFirst.reason, 'explicit');
    assert.equal(explicitFirst.dir, explicit);
    assert.equal(explicitFirst.candidates.find((x) => x.declaredIndex === 3).realPath, dshHome);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('candidates: selection never scans the filesystem for undeclared roots', async () => {
  const source = await fs.readFile(path.join(PKG_ROOT, 'src', 'core', 'candidates.mjs'), 'utf8');
  assert.equal(source.includes('readdir'), false, 'candidate discovery is declaration-driven, not a directory walk');
  assert.match(source, /DSH_SDD_KIT_SUPERPOWERS_DIR/);
  assert.match(source, /DSH_HOME/);
});

test('upstream: status and sync_superpowers report the selected directory (REQ-08)', async (t) => {
  if (process.platform === 'win32') return t.skip('HOME does not control os.homedir() on Windows; covered on POSIX only');
  const root = await makeTempDir();
  try {
    const [explicit] = await seedCandidateDirs(root, ['explicit'], Date.now());
    const runner = async (command, args) => ({
      ok: true,
      stdout: `${command} ${(args ?? []).join(' ')}`,
      stderr: '',
    });
    const status = await runUpstream({ action: 'status', cwd: root, superpowersDir: explicit }, runner);
    assert.equal(status.superpowers.dir, explicit);
    assert.equal(status.superpowers.selection.reason, 'explicit');
    assert.equal(status.superpowers.selection.realPath, explicit);
    assert.equal(status.superpowers.selection.fallback, false);
    assert.ok(Array.isArray(status.superpowers.selection.candidates), 'the report must keep every declaration');
    assert.ok(status.superpowers.selection.candidates.length >= 3, 'explicit, dsh_home and default are always declared');
    for (const candidate of status.superpowers.selection.candidates) {
      assert.equal(candidate.mtimeNs === null || typeof candidate.mtimeNs === 'string', true,
        'bigint mtimeNs must be JSON-safe in the report');
    }

    const synced = await runUpstream({ action: 'sync_superpowers', cwd: root, superpowersDir: explicit }, runner);
    assert.equal(synced.dir, explicit);
    assert.equal(synced.selection.reason, 'explicit');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('setup: sync_superpowers step reports dir and selection evidence', async () => {
  const { deps } = setupFakes();
  const calls = [];
  const upstream = async (args) => {
    calls.push(args);
    if (args.action === 'sync_superpowers') {
      return {
        ok: true,
        mode: 'pull',
        skillCount: 15,
        dir: '/mirror/superpowers',
        selection: { reason: 'env', realPath: '/mirror/superpowers' },
      };
    }
    return deps.runUpstream(args);
  };
  const cwd = await makeTempDir();
  try {
    const result = await runSetup({ cwd }, { runUpstream: upstream, runBridge: deps.runBridge });
    const step = result.steps.find((entry) => entry.name === 'sync_superpowers');
    assert.equal(step.detail.dir, '/mirror/superpowers');
    assert.deepEqual(step.detail.selection, { reason: 'env', realPath: '/mirror/superpowers' });
    assert.equal(calls.some((args) => args.action === 'sync_superpowers'), true);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('tools: sdd_upstream and sdd_bridge expose the new parameters', () => {
  const defs = [];
  const ctx = { tools: { register: (def) => { defs.push(def); return () => {}; } } };
  registerSddTools(ctx, (def) => def);
  const upstreamTool = defs.find((def) => def.name === 'sdd_upstream');
  const bridgeTool = defs.find((def) => def.name === 'sdd_bridge');
  assert.equal(upstreamTool.parameters.candidateDirs.type, 'array');
  assert.equal(bridgeTool.parameters.artifact.type, 'string');
  for (const action of ['inspect', 'install_overrides', 'restore_overrides', 'sync_index']) {
    assert.match(bridgeTool.parameters.action.description, new RegExp(action));
  }
});

// ---------------------------------------------------------------------------
// US5: real upstream verification script (REQ-17..REQ-19)
// The script is spawned as a subprocess with a stubbed PATH so npm test never
// touches the network or a real specify install.
// ---------------------------------------------------------------------------

const VERIFY_SCRIPT = path.join(PKG_ROOT, 'scripts', 'verify-upstream.mjs');

function runNode(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env,
      encoding: 'utf8',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function makeShimBin(root, shims) {
  const binDir = path.join(root, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  for (const [name, body] of Object.entries(shims)) {
    const file = path.join(binDir, name);
    await fs.writeFile(file, `#!/bin/sh\n${body}\n`, 'utf8');
    await fs.chmod(file, 0o755);
  }
  return binDir;
}

// Phase 13 T099 reverses the Phase 12 reading of INV-23: "not executed" is
// still a distinct report status, but the process must now fail so a missing
// toolchain can never be mistaken for a green run. The JSON contract is intact.
test('verify-upstream: a missing toolchain reports not_executed with a non-zero exit (INV-23/T099)', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX shell shims; covered on POSIX only');
  const result = await runNode([VERIFY_SCRIPT, '--json'], {
    PATH: '',
    HOME: os.tmpdir(),
  });
  assert.equal(result.code, 1, 'T099: not_executed must fail the process, never exit 0');
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'not_executed');
  assert.equal(report.checks.length, 0);
  assert.equal(typeof report.reason, 'string');
  assert.ok(report.reason.length > 0, 'INV-23: not_executed must explain itself');
});

test('verify-upstream: a broken specify exits 1 and names the failing contract point (INV-24)', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX shell shims; covered on POSIX only');
  const root = await makeTempDir();
  try {
    const binDir = await makeShimBin(root, {
      specify: 'echo "boom: unknown option" >&2\nexit 2',
      uv: 'echo "uv 0.13.9"',
      git: 'echo "git version 2.43.0"',
    });
    const result = await runNode([VERIFY_SCRIPT, '--json'], {
      PATH: binDir,
      HOME: root,
      TMPDIR: root,
    });
    assert.equal(result.code, 1, 'INV-24: a broken contract must fail the run');
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'failed');
    const failed = report.checks.filter((check) => check.ok === false);
    assert.ok(failed.length > 0);
    for (const check of failed) {
      assert.deepEqual(Object.keys(check).sort(), ['detail', 'id', 'ok', 'stderr'],
        'the four-field check error contract must survive the T099 exit-code change');
    }
    assert.ok(failed.every((check) => typeof check.detail === 'string' && check.detail.length > 0));
    assert.ok(failed.some((check) => check.id === 'init-args'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('verify-upstream: the daily workflow exists with schedule and manual dispatch (REQ-18)', async () => {
  const workflow = await fs.readFile(path.join(PKG_ROOT, '.github', 'workflows', 'upstream-integration.yml'), 'utf8');
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /verify-upstream/);
  assert.match(workflow, /uv tool install specify-cli/, 'CI must install the tool it verifies');
  assert.match(workflow, /status\s*!==\s*['"]passed['"]/, 'CI must fail on not_executed instead of silently going green');
});

test('verify-upstream: the unit suite never imports the real verification module (REQ-18)', async () => {
  const source = await fs.readFile(new URL(import.meta.url), 'utf8');
  assert.equal(/^import[^;]*verify-upstream\.mjs/m.test(source), false,
    'REQ-18: the unit suite must not import the integration module; it may only spawn it with a stubbed PATH');
  const gate = ['DSH', 'SDD', 'KIT', 'INTEGRATION'].join('_');
  assert.equal(source.includes(gate), false,
    'REQ-18: the unit suite must not switch the integration suite on');
  const integrationSuite = await fs.readFile(path.join(PKG_ROOT, 'test', 'upstream-contract.test.mjs'), 'utf8');
  assert.match(integrationSuite, /verifyUpstream/);
  assert.match(integrationSuite, /skip:/, 'the integration suite must be opt-in');
});

test('sdd-setup skill reports nextAction and selection evidence without naming actions (INV-22/REQ-08)', async () => {
  const raw = await fs.readFile(path.join(PKG_ROOT, 'skills', 'sdd-setup', 'SKILL.md'), 'utf8');
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  assert.match(body, /nextAction/, 'REQ-05: the report must surface the recommended next step');
  assert.match(body, /selection/, 'REQ-08: the report must surface why that mirror was chosen');
  assert.match(body, /等待确认|等用户确认|confirm/, 'the next step needs explicit user consent');
  for (const forbidden of ['install_overrides', 'restore_overrides', 'sync_index']) {
    assert.equal(body.includes(forbidden), false, `INV-22: the skill must not hardcode the action name ${forbidden}`);
  }
});

test('README documents the safety behaviours without the disproven gitignore claim (INV-17)', async () => {
  const readme = await fs.readFile(path.join(PKG_ROOT, 'README.md'), 'utf8');
  assert.match(readme, /安装安全性/);
  for (const verdict of ['not_installed', 'installed_consistent', 'user_modified', 'stale_upstream', 'unknown']) {
    assert.match(readme, new RegExp(verdict), `README must document the ${verdict} verdict`);
  }
  assert.match(readme, /\.backup\//);
  assert.match(readme, /verify:upstream/);
  assert.equal(/\.gitignore[^\n]*忽略[^\n]*\.backup|宿主 \.gitignore/.test(readme), false,
    'INV-17: the snapshot directory ignores itself; never claim the host .gitignore covers it');
});
