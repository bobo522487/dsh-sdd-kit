import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { assembleGuidance, estimateTokens } from '../src/core/guidance.mjs';
import { detectFeaturePhase } from '../src/core/feature-phase.mjs';

async function makeRepo(withLedger = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-guidance-'));
  const home = path.join(root, 'home');
  await fs.mkdir(path.join(home, '.dsh'), { recursive: true });
  await fs.mkdir(path.join(root, 'repo', '.specify'), { recursive: true });
  await fs.mkdir(path.join(root, 'repo', 'specs', '004-multihost-runtime-governance'), { recursive: true });
  await fs.mkdir(path.join(root, 'skills', 'discipline-one'), { recursive: true });
  await fs.mkdir(path.join(root, 'skills', 'discipline-two'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'skills', 'discipline-one', 'SKILL.md'),
    '---\nname: discipline-one\ndescription: 纪律一：先写测试再写实现。\n---\nbody ignored\n',
    'utf8'
  );
  await fs.writeFile(
    path.join(root, 'skills', 'discipline-two', 'SKILL.md'),
    '---\nname: discipline-two\ndescription: Discipline two: always read the spec first.\n---\nbody ignored\n',
    'utf8'
  );
  if (withLedger) {
    await fs.writeFile(
      path.join(root, 'repo', '.specify', 'feature.json'),
      JSON.stringify({ feature_directory: 'specs/004-multihost-runtime-governance' }),
      'utf8'
    );
    await fs.writeFile(path.join(root, 'repo', 'specs', '004-multihost-runtime-governance', 'tasks.md'), '- [x] T001 done\n- [ ] T002 pending\n', 'utf8');
  }
  return { root, repo: path.join(root, 'repo'), home, skills: path.join(root, 'skills') };
}

function baseParams(fixture, overrides = {}) {
  return {
    host: 'dsh',
    cwd: fixture.repo,
    superpowersDir: fixture.skills,
    env: { ...process.env, HOME: fixture.home },
    ...overrides,
  };
}

test('assembleGuidance returns all three parts plus token estimate and warnings (REQ-08)', async () => {
  const fixture = await makeRepo();
  const bundle = await assembleGuidance(baseParams(fixture));
  assert.match(bundle.upstreamText, /discipline-one/);
  assert.match(bundle.upstreamText, /先写测试再写实现/);
  assert.match(bundle.upstreamText, /discipline-two/);
  assert.deepEqual(bundle.toolMapping, {
    upstream: 'sdd_upstream',
    bridge: 'sdd_bridge',
    doctor: 'sdd_upstream',
    guard: 'sdd_upstream',
    guidance: 'sdd_upstream',
  });
  assert.equal(bundle.sddPointer.feature, '004-multihost-runtime-governance');
  assert.equal(bundle.sddPointer.phase, 'implement');
  assert.match(bundle.sddPointer.nextCommand, /speckit/);
  assert.ok(bundle.tokenEstimate > 0 && bundle.tokenEstimate <= 1200);
  assert.deepEqual(bundle.warnings, []);
});

async function makeMirrorSkills(mirrorRoot, name, description) {
  const skillsDir = path.join(mirrorRoot, 'skills', name);
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.writeFile(path.join(skillsDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nbody ignored\n`, 'utf8');
  return skillsDir;
}

// selectSuperpowersDir's default candidate uses os.homedir(), which reads the
// process environment (HOME on POSIX, USERPROFILE on Windows), not the injected env.
async function withProcessHome(home, fn) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('assembleGuidance selects the DSH_SDD_KIT_SUPERPOWERS_DIR mirror when no explicit dir is given (REQ-08)', async () => {
  const fixture = await makeRepo();
  const mirror = path.join(fixture.root, 'env-mirror');
  await makeMirrorSkills(mirror, 'env-skill', '环境候选纪律。');
  const bundle = await withProcessHome(fixture.home, () => assembleGuidance({
    host: 'dsh',
    cwd: fixture.repo,
    env: { HOME: fixture.home, DSH_HOME: '', DSH_SDD_KIT_SUPERPOWERS_DIR: mirror },
  }));
  assert.match(bundle.upstreamText, /env-skill/);
  assert.match(bundle.upstreamText, /环境候选纪律/);
  assert.deepEqual(bundle.warnings, []);
});

test('assembleGuidance selects the DSH_HOME mirror when the env override is absent (REQ-08)', async () => {
  const fixture = await makeRepo();
  const dshHome = path.join(fixture.root, 'dsh-home');
  await makeMirrorSkills(path.join(dshHome, 'upstream', 'superpowers'), 'home-skill', 'DSH_HOME 纪律。');
  const bundle = await withProcessHome(fixture.home, () => assembleGuidance({
    host: 'dsh',
    cwd: fixture.repo,
    env: { HOME: fixture.home, DSH_HOME: dshHome, DSH_SDD_KIT_SUPERPOWERS_DIR: '' },
  }));
  assert.match(bundle.upstreamText, /home-skill/);
  assert.match(bundle.upstreamText, /DSH_HOME 纪律/);
  assert.deepEqual(bundle.warnings, []);
});

test('no explicit dir and no readable mirror still degrades to a warning (REQ-11/AC-07)', async () => {
  const fixture = await makeRepo();
  const bundle = await withProcessHome(fixture.home, () => assembleGuidance({
    host: 'dsh',
    cwd: fixture.repo,
    env: { HOME: fixture.home, DSH_HOME: path.join(fixture.root, 'empty-home'), DSH_SDD_KIT_SUPERPOWERS_DIR: '' },
  }));
  assert.equal(bundle.upstreamText, '');
  assert.ok(bundle.warnings.some((w) => /install|安装|缺失|不可读/.test(w)));
});

test('over-budget assembly trims only the SDD pointer and never the upstream text (REQ-09/AC-06)', async () => {
  const fixture = await makeRepo();
  const longLine = `name: huge\ndescription: ${'测试内容'.repeat(2000)}\n---\n`;
  await fs.mkdir(path.join(fixture.skills, 'huge'), { recursive: true });
  await fs.writeFile(path.join(fixture.skills, 'huge', 'SKILL.md'), `---\n${longLine}`, 'utf8');
  const bundle = await assembleGuidance(baseParams(fixture));
  assert.match(bundle.upstreamText, /测试内容/);
  assert.ok(bundle.tokenEstimate > 1200 || bundle.sddPointer.feature === '');
  assert.ok(bundle.warnings.some((w) => /1\.2k|1200|超限/.test(w)));
});

test('missing mirror degrades to warning and never throws (REQ-11/AC-07)', async () => {
  const fixture = await makeRepo();
  const bundle = await assembleGuidance(baseParams(fixture, { superpowersDir: path.join(fixture.root, 'missing') }));
  assert.equal(bundle.upstreamText, '');
  assert.ok(bundle.warnings.some((w) => /install|安装|missing|缺失/.test(w)));
  assert.equal(bundle.enabled, true);
});

test('two-level switch: project overrides user; unparsable file warns but does not fail (REQ-12/AC-08)', async () => {
  const fixture = await makeRepo();
  await fs.writeFile(path.join(fixture.home, '.dsh', 'sdd-kit.json'), JSON.stringify({ guidance: { enabled: false } }), 'utf8');
  let bundle = await assembleGuidance(baseParams(fixture));
  assert.equal(bundle.enabled, false);
  assert.equal(bundle.effectiveScope, 'user');

  await fs.writeFile(
    path.join(fixture.repo, '.specify', 'sdd-kit.json'),
    JSON.stringify({ guidance: { enabled: true } }),
    'utf8'
  );
  bundle = await assembleGuidance(baseParams(fixture));
  assert.equal(bundle.enabled, true);
  assert.equal(bundle.effectiveScope, 'project');

  await fs.writeFile(path.join(fixture.repo, '.specify', 'sdd-kit.json'), '{ broken json', 'utf8');
  bundle = await assembleGuidance(baseParams(fixture));
  assert.equal(bundle.enabled, false);
  assert.equal(bundle.effectiveScope, 'user');
  assert.ok(bundle.warnings.some((w) => /sdd-kit\.json/.test(w)));
});

test('same assembly content across hosts, and phase detection is shared with guard (REQ-13/T019)', async () => {
  const fixture = await makeRepo();
  const dsh = await assembleGuidance(baseParams(fixture, { host: 'dsh' }));
  const claude = await assembleGuidance(baseParams(fixture, { host: 'claude' }));
  assert.equal(dsh.upstreamText, claude.upstreamText);
  assert.deepEqual(dsh.toolMapping, claude.toolMapping);
  assert.deepEqual(dsh.sddPointer, claude.sddPointer);
  assert.equal((await detectFeaturePhase({ cwd: fixture.repo })).phase, dsh.sddPointer.phase);

  await fs.writeFile(path.join(fixture.repo, 'specs', '004-multihost-runtime-governance', 'tasks.md'), '- [ ] T001 pending\n', 'utf8');
  await fs.writeFile(path.join(fixture.repo, 'specs', '004-multihost-runtime-governance', 'plan.md'), 'plan', 'utf8');
  const planned = await detectFeaturePhase({ cwd: fixture.repo });
  assert.equal(planned.phase, 'plan');
  assert.equal(planned.nextCommand, '/speckit-tasks');
});

test('estimateTokens counts CJK as one and non-CJK as ceil(chars/3.5)', () => {
  assert.equal(estimateTokens('测试'), 2);
  assert.equal(estimateTokens('abcdefgh'), 3);
});
