import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { assembleGuidance, estimateTokens, formatGuidanceText, toolMapping } from '../src/core/guidance.mjs';
import { HOST_CAPABILITIES } from '../src/core/host-capabilities.mjs';
import { detectFeaturePhase } from '../src/core/feature-phase.mjs';

const DSH_FACE = {
  upstream: 'sdd_upstream',
  bridge: 'sdd_bridge',
  doctor: 'sdd_upstream',
  guard: 'sdd_upstream',
  guidance: 'sdd_upstream',
};

const CLI_FACE = {
  upstream: 'sdd-kit update',
  bridge: 'sdd-kit bridge',
  doctor: 'sdd-kit doctor',
  guard: 'sdd-kit guard',
  guidance: 'sdd-kit guidance',
};

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
  assert.deepEqual(bundle.toolMapping, DSH_FACE);
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
  assert.notDeepEqual(dsh.toolMapping, claude.toolMapping);
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

test('toolMapping derives from HOST_CAPABILITIES for every host (T068/REQ-13)', () => {
  for (const host of Object.keys(HOST_CAPABILITIES)) {
    const cap = HOST_CAPABILITIES[host];
    assert.deepEqual(toolMapping(host), { ...cap.toolNames }, `${host} tool mapping must come from its capability row`);
    assert.ok(Object.isFrozen(cap.toolNames), `${host}.toolNames must be frozen`);
    assert.deepEqual(
      Object.keys(cap.toolNames).sort(),
      ['bridge', 'doctor', 'guard', 'guidance', 'upstream'],
      `${host}.toolNames must cover the five actions`
    );
  }
  assert.deepEqual(toolMapping('dsh'), DSH_FACE);
  for (const host of ['claude', 'codex', 'cursor']) {
    assert.deepEqual(toolMapping(host), CLI_FACE, `${host} must use the host-neutral CLI form`);
  }
  // Missing host must not inherit DSH-only tool names.
  assert.deepEqual(toolMapping('unknown-host'), CLI_FACE);
  assert.deepEqual(toolMapping(), CLI_FACE, 'no injected host uses the host-neutral face');
});

test('assembleGuidance threads host into the tool mapping (T068/REQ-13)', async () => {
  const fixture = await makeRepo();
  const dsh = await assembleGuidance(baseParams(fixture, { host: 'dsh' }));
  assert.deepEqual(dsh.toolMapping, DSH_FACE);
  for (const host of ['claude', 'codex', 'cursor']) {
    const bundle = await assembleGuidance(baseParams(fixture, { host }));
    assert.deepEqual(bundle.toolMapping, CLI_FACE, `${host} must map to sdd-kit <subcommand>`);
    assert.match(formatGuidanceText(bundle), /sdd-kit guidance/);
  }
});

test('tokenEstimate measures the final rendered text, including title and labels (T070)', async () => {
  const fixture = await makeRepo();
  const bundle = await assembleGuidance(baseParams(fixture));
  const text = formatGuidanceText(bundle);
  assert.equal(bundle.text, text, 'the bundle must expose the exact rendered text');
  assert.equal(bundle.tokenEstimate, estimateTokens(text), 'the gate must use formatGuidanceText output');
  assert.match(text, /^## SDD 运行时纪律（dsh-sdd-kit）/);
  assert.match(text, /工具映射：/);
  assert.match(text, /当前进度：/);
  assert.ok(bundle.tokenEstimate <= 1200);
  // The title and labels are part of the measured text, so textOf-only counting would under-report.
  assert.ok(estimateTokens(text) > estimateTokens(bundle.upstreamText));
});

test('budget gate measures the rendered text, so it trims the pointer before the text overflows (T070/REQ-09)', async () => {
  const fixture = await makeRepo();
  const seed = await assembleGuidance(baseParams(fixture));
  const withoutPointer = formatGuidanceText({ ...seed, sddPointer: { feature: '', phase: '', nextCommand: '' } });
  const bodyOnly = estimateTokens(withoutPointer);
  const pointerCost = seed.tokenEstimate - bodyOnly;
  assert.ok(pointerCost >= 10, `pointer must cost real tokens, got ${pointerCost}`);

  // Size the upstream body so the rendered text exceeds 1.2k by ~10 tokens:
  // dropping the pointer is then enough to land back under the gate.
  const grow = 1200 - bodyOnly - pointerCost + 10;
  assert.ok(grow > 0);
  await fs.mkdir(path.join(fixture.skills, 'medium'), { recursive: true });
  await fs.writeFile(
    path.join(fixture.skills, 'medium', 'SKILL.md'),
    `---\nname: medium\ndescription: ${'测'.repeat(grow)}\n---\n`,
    'utf8'
  );

  const bundle = await assembleGuidance(baseParams(fixture));
  assert.equal(bundle.tokenEstimate, estimateTokens(formatGuidanceText(bundle)));
  assert.ok(bundle.tokenEstimate <= 1200, `final text must fit the gate, got ${bundle.tokenEstimate}`);
  assert.match(bundle.upstreamText, /测/, 'the upstream body is never trimmed');
  assert.ok(bundle.warnings.some((w) => /1\.2k|1200|超限/.test(w)));

  // A textOf-only gate (no title, no labels) would have measured this as in-budget.
  const legacy = [
    bundle.upstreamText,
    Object.entries(bundle.toolMapping).map(([action, tool]) => `${action} -> ${tool}`).join('\n'),
    Object.entries(seed.sddPointer).map(([key, value]) => `${key}: ${value}`).join('\n'),
  ].filter(Boolean).join('\n');
  assert.ok(estimateTokens(legacy) <= 1200, 'the old textOf measurement missed the overage');
});

test('upstreamText injects only the frontmatter reference, never the SKILL.md body (T071/REQ-08/REQ-09)', async () => {
  const fixture = await makeRepo();
  const bundle = await assembleGuidance(baseParams(fixture));
  assert.doesNotMatch(bundle.upstreamText, /body ignored/, 'the body stays in the mirror, it is not copied into the prompt');

  await fs.mkdir(path.join(fixture.skills, 'with-body'), { recursive: true });
  const body = '## 执行纪律\n\n1. 先写失败测试。\n2. 再写最小实现。\n';
  await fs.writeFile(
    path.join(fixture.skills, 'with-body', 'SKILL.md'),
    `---\nname: with-body\ndescription: 正文不注入用例。\n---\n${body}`,
    'utf8'
  );
  const withBody = await assembleGuidance(baseParams(fixture));
  assert.match(withBody.upstreamText, /- with-body: 正文不注入用例。/, 'name + description is the injection unit');
  assert.doesNotMatch(withBody.upstreamText, /先写失败测试/, 'the body must never be injected');
  assert.doesNotMatch(withBody.upstreamText, /执行纪律/, 'the body must never be injected');
});

test('an over-long upstream description is preserved verbatim and only the pointer is trimmed (T071/AC-06)', async () => {
  const fixture = await makeRepo();
  const description = `${'超长描述'.repeat(3000)}尾部标记 END-OF-DESC`;
  await fs.mkdir(path.join(fixture.skills, 'huge-desc'), { recursive: true });
  await fs.writeFile(
    path.join(fixture.skills, 'huge-desc', 'SKILL.md'),
    `---\nname: huge-desc\ndescription: ${description}\n---\n正文不参与预算。\n`,
    'utf8'
  );
  const bundle = await assembleGuidance(baseParams(fixture));
  assert.ok(bundle.upstreamText.includes(description), 'the upstream description must never be trimmed');
  assert.match(bundle.upstreamText, /尾部标记 END-OF-DESC/);
  assert.doesNotMatch(bundle.upstreamText, /正文不参与预算/, 'the body must never be injected');
  assert.equal(bundle.sddPointer.feature, '');
  assert.equal(bundle.sddPointer.phase, '');
  assert.equal(bundle.sddPointer.nextCommand, '');
  assert.ok(bundle.tokenEstimate > 1200);
  assert.ok(bundle.warnings.some((w) => /1\.2k|1200|超限/.test(w)));
});
