import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  describeClaude,
  applyClaudeGuidance,
  claudeManagedBlock,
  detectNativeEvents,
} from '../src/adapters/claude/index.mjs';
import {
  DISCIPLINE_SKILL_NAMES,
  HOST_CAPABILITIES,
  hasDisciplineSkills,
  isDisciplineSkill,
} from '../src/core/host-capabilities.mjs';
import { readMarkers, writeMarker } from '../src/core/marker.mjs';

const ADAPTER_SRC = await fs.readFile(
  new URL('../src/adapters/claude/index.mjs', import.meta.url),
  'utf8'
);

async function makeRepo({ switchEnabled, skills = ['speckit-implement'] } = {}) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-claude-'));
  for (const name of skills) {
    await fs.mkdir(path.join(repo, '.claude', 'skills', name), { recursive: true });
    await fs.writeFile(path.join(repo, '.claude', 'skills', name, 'SKILL.md'), `# ${name}\n`, 'utf8');
  }
  await fs.mkdir(path.join(repo, '.specify'), { recursive: true });
  await fs.writeFile(
    path.join(repo, '.specify', 'feature.json'),
    JSON.stringify({ feature_directory: 'specs/004-multihost-runtime-governance' }),
    'utf8'
  );
  await fs.mkdir(path.join(repo, 'specs', '004-multihost-runtime-governance'), { recursive: true });
  await fs.writeFile(path.join(repo, 'specs', '004-multihost-runtime-governance', 'spec.md'), '# spec\n', 'utf8');
  if (typeof switchEnabled === 'boolean') {
    await fs.writeFile(
      path.join(repo, '.specify', 'sdd-kit.json'),
      JSON.stringify({ guidance: { enabled: switchEnabled } }),
      'utf8'
    );
  }
  return repo;
}

async function emptyMirrorEnv() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-claude-empty-mirror-'));
  const mirror = path.join(root, 'superpowers');
  await fs.mkdir(path.join(mirror, 'skills'), { recursive: true });
  return { ...process.env, DSH_SDD_KIT_SUPERPOWERS_DIR: mirror, HOME: root };
}

test('Claude adapter answers all four contract items with host-specific facts (REQ-26)', () => {
  const contract = describeClaude();
  assert.deepEqual(Object.keys(contract).sort(), [
    'guidanceFace', 'reloadSemantics', 'skillFace', 'toolFace',
  ]);
  assert.match(contract.toolFace, /CLI/);
  assert.match(contract.guidanceFace, /session_start|托管块/);
  assert.match(contract.skillFace, /\.claude\/skills/);
  assert.match(contract.reloadSemantics, /new_session/);
});

test('Claude prefers the native session_start event and produces the shared text (REQ-26/REQ-27)', async () => {
  const repo = await makeRepo();
  const result = await applyClaudeGuidance({ cwd: repo, nativeEventsAvailable: true });
  assert.equal(result.channel, 'native-event');
  assert.match(result.text, /## SDD 运行时纪律（dsh-sdd-kit）/);
  assert.equal(result.installHint, null);
  assert.equal(result.enabled, true);
  assert.equal(result.written, false);
});

test('Claude falls back to an idempotent managed block when native events are unavailable (REQ-26/REQ-28)', async () => {
  const repo = await makeRepo();
  const first = await applyClaudeGuidance({ cwd: repo, nativeEventsAvailable: false });
  const bytes1 = await fs.readFile(path.join(repo, '.claude', 'sdd-kit-discipline.md'), 'utf8');
  const second = await applyClaudeGuidance({ cwd: repo, nativeEventsAvailable: false });
  const bytes2 = await fs.readFile(path.join(repo, '.claude', 'sdd-kit-discipline.md'), 'utf8');
  assert.equal(first.channel, 'managed-block');
  assert.equal(second.channel, 'managed-block');
  assert.equal(first.written, true);
  assert.equal(bytes1, bytes2, 'managed block must be byte-identical on repeat');
  assert.equal(claudeManagedBlock(first.text), bytes1);
});

test('a closed guidance switch removes a previously written Claude block (T067/REQ-12)', async () => {
  const repo = await makeRepo({ switchEnabled: false });
  const target = path.join(repo, '.claude', 'sdd-kit-discipline.md');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, claudeManagedBlock('OLD'), 'utf8');
  const result = await applyClaudeGuidance({ cwd: repo, nativeEventsAvailable: false });
  assert.equal(result.enabled, false);
  assert.equal(result.written, false);
  assert.equal(result.removed, true);
  await assert.rejects(fs.access(target));
});

test('a native event supersedes and removes a stale Claude managed block (I1/REQ-12)', async () => {
  const repo = await makeRepo();
  const target = path.join(repo, '.claude', 'sdd-kit-discipline.md');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, claudeManagedBlock('OLD'), 'utf8');
  const result = await applyClaudeGuidance({ cwd: repo, nativeEventsAvailable: true });
  assert.equal(result.channel, 'native-event');
  assert.equal(result.removed, true);
  await assert.rejects(fs.access(target));
});

test('an empty upstream mirror writes no Claude file but keeps warnings readable (T069)', async () => {
  const repo = await makeRepo();
  const result = await applyClaudeGuidance({
    cwd: repo,
    nativeEventsAvailable: false,
    env: await emptyMirrorEnv(),
  });
  assert.equal(result.enabled, true, 'the switch still decides enabled');
  assert.equal(result.written, false);
  assert.ok(result.warnings.some((w) => /纪律技能/.test(w)), `warnings must be readable: ${result.warnings}`);
  await assert.rejects(fs.access(path.join(repo, '.claude', 'sdd-kit-discipline.md')));
});

test('a missing upstream skill only yields an install hint, not a failure (T085)', async () => {
  const repo = await makeRepo({ skills: [] });
  const result = await applyClaudeGuidance({ cwd: repo, nativeEventsAvailable: true });
  assert.match(result.installHint, /specify extension add|specify integration install/);
  assert.doesNotMatch(result.installHint, /\/sdd-(setup|update)/);
  assert.match(result.text, /## SDD 运行时纪律/);
});

test('skill-name judgement is a pure function over upstream names, not kit skills (T085/T087)', () => {
  assert.equal(isDisciplineSkill('speckit-implement'), true);
  assert.equal(isDisciplineSkill('speckit-superpowers-hooks-before-implement'), true);
  assert.equal(isDisciplineSkill('test-driven-development'), true);
  assert.equal(isDisciplineSkill('writing-plans'), true);
  assert.equal(isDisciplineSkill('sdd-setup'), false, 'kit skills are not upstream evidence');
  assert.equal(isDisciplineSkill('sdd-update'), false);
  assert.equal(isDisciplineSkill('my-private-skill'), false);
  assert.equal(hasDisciplineSkills(['sdd-setup', 'sdd-update']), false);
  assert.equal(hasDisciplineSkills([]), false);
  assert.equal(hasDisciplineSkills(['sdd-setup', 'speckit-plan']), true);
  assert.equal(hasDisciplineSkills(['test-driven-development']), true);
  assert.doesNotMatch(ADAPTER_SRC, /sdd-\(setup\|update\)/, 'the obsolete predicate must be gone');
});

test('an upstream command skill satisfies the install check while kit skills do not (T085)', async () => {
  const satisfied = await makeRepo({ skills: ['speckit-implement'] });
  assert.equal((await applyClaudeGuidance({ cwd: satisfied })).installHint, null);
  const kitOnly = await makeRepo({ skills: ['sdd-setup', 'sdd-update'] });
  assert.match((await applyClaudeGuidance({ cwd: kitOnly })).installHint, /specify/);
});

test('the Claude managed block is a thin formatter over its own capability markers (T087)', () => {
  // The canonical markers live in the shared MANAGED_BLOCK_MARKERS constant;
  // Claude must not borrow Codex's capability entry or carry a second literal.
  const { markerStart, markerEnd } = HOST_CAPABILITIES.claude.guidanceConfig;
  assert.equal(claudeManagedBlock('X'), `${markerStart}\nX\n${markerEnd}\n`);
  assert.equal(
    claudeManagedBlock('X', { markerStart: '<!--a-->', markerEnd: '<!--b-->' }),
    '<!--a-->\nX\n<!--b-->\n',
    'markers must be injectable so core can own them'
  );
  assert.match(ADAPTER_SRC, /markerStart/, 'the adapter must read markers from the capability source');
  assert.doesNotMatch(ADAPTER_SRC, /HOST_CAPABILITIES\.codex/, 'Claude must not fall back to another host capability');
});

test('Claude startup clears only its own pending marker (T081)', async () => {
  const repo = await makeRepo({ switchEnabled: false });
  await writeMarker({ cwd: repo, host: 'dsh', reason: 'dsh pending' });
  await writeMarker({ cwd: repo, host: 'claude', reason: 'claude pending' });
  const result = await applyClaudeGuidance({ cwd: repo });
  assert.equal(result.enabled, false, 'clearing happens before the guidance gates');
  assert.deepEqual(Object.keys(await readMarkers({ cwd: repo })), ['dsh']);
});

test('a marker that cannot be cleared never blocks Claude guidance (T081)', async () => {
  const repo = await makeRepo();
  await writeMarker({ cwd: repo, host: 'claude' });
  const specifyDir = path.join(repo, '.specify');
  await fs.chmod(specifyDir, 0o500);
  try {
    const result = await applyClaudeGuidance({ cwd: repo, nativeEventsAvailable: true });
    assert.equal(result.enabled, true);
    assert.match(result.text, /## SDD 运行时纪律/);
  } finally {
    await fs.chmod(specifyDir, 0o700);
  }
});

test('the Claude adapter contains no business judgement over the shared bundle (T087)', () => {
  assert.doesNotMatch(ADAPTER_SRC, /bundle\.toolMapping/, 'adapters only format/IO the shared bundle');
  assert.doesNotMatch(ADAPTER_SRC, /bundle\.sddPointer/, 'adapters only format/IO the shared bundle');
  assert.doesNotMatch(ADAPTER_SRC, /upstreamText\s*[=!]==/, 'no upstream-text policy belongs in an adapter');
});

// ---- I9: one shared discipline-skill list, owned by core ----

test('the discipline skill list is a single core-owned export that includes diagnosing-superpowers (I9)', () => {
  assert.ok(Array.isArray(DISCIPLINE_SKILL_NAMES), 'core must export the shared name list');
  assert.equal(DISCIPLINE_SKILL_NAMES.length, 15, [...DISCIPLINE_SKILL_NAMES].sort().join(','));
  assert.equal(DISCIPLINE_SKILL_NAMES.includes('diagnosing-superpowers'), true);
  assert.equal(isDisciplineSkill('diagnosing-superpowers'), true, 'the Claude-side predicate must accept every shared name');
  for (const name of DISCIPLINE_SKILL_NAMES) {
    assert.equal(isDisciplineSkill(name), true, `${name} must be accepted`);
  }
});

test('the Claude adapter holds no skill-name list or business predicate of its own (I9/T087)', () => {
  // A second copy of the list is exactly the drift I9 reported: the adapter must
  // import the judgement from core and keep only IO.
  for (const name of ['diagnosing-superpowers', 'test-driven-development', 'brainstorming', 'writing-plans']) {
    assert.doesNotMatch(ADAPTER_SRC, new RegExp(`['"\`]${name}['"\`]`), `adapter must not literalise ${name}`);
  }
  assert.doesNotMatch(ADAPTER_SRC, /new\s+Set\s*\(/, 'no local name set may live in the adapter');
  assert.doesNotMatch(ADAPTER_SRC, /\^speckit-/, 'the upstream-command predicate belongs to core');
  assert.doesNotMatch(ADAPTER_SRC, /superpowers|upstream-mirror/, 'no provenance matching in the adapter');
  assert.match(ADAPTER_SRC, /isDisciplineSkill|hasDisciplineSkills/, 'the adapter must consume the core judgement');
});

// ---- I1: production probe for the native session_start event ----

test('detectNativeEvents is a read-only probe over the project settings and extension manifest (I1)', async () => {
  const bare = await makeRepo();
  assert.equal(await detectNativeEvents({ cwd: bare, env: {} }), false, 'no settings and no manifest means no native event');

  const settingsRepo = await makeRepo();
  await fs.mkdir(path.join(settingsRepo, '.claude'), { recursive: true });
  await fs.writeFile(
    path.join(settingsRepo, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'sdd-kit guidance --text' }] }] } }),
    'utf8'
  );
  assert.equal(await detectNativeEvents({ cwd: settingsRepo, env: {} }), true, 'a SessionStart hook that mentions sdd-kit counts');

  const foreignRepo = await makeRepo();
  await fs.mkdir(path.join(foreignRepo, '.claude'), { recursive: true });
  await fs.writeFile(
    path.join(foreignRepo, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }),
    'utf8'
  );
  assert.equal(await detectNativeEvents({ cwd: foreignRepo, env: {} }), false, 'an unrelated SessionStart hook is not ours');

  const manifestRepo = await makeRepo();
  await fs.writeFile(
    path.join(manifestRepo, '.specify', 'extensions.yml'),
    'installed:\n  - superpowers-hooks\nhooks:\n  session_start:\n    - command: guidance\n',
    'utf8'
  );
  assert.equal(await detectNativeEvents({ cwd: manifestRepo, env: {} }), true, 'a manifest session_start event counts');

  const brokenRepo = await makeRepo();
  await fs.mkdir(path.join(brokenRepo, '.claude'), { recursive: true });
  await fs.writeFile(path.join(brokenRepo, '.claude', 'settings.json'), '{ not json', 'utf8');
  assert.equal(await detectNativeEvents({ cwd: brokenRepo, env: {} }), false, 'malformed settings must not throw');
});

test('Claude guidance auto-detects the channel and falls back to a written managed block (I1)', async () => {
  const repo = await makeRepo();
  const result = await applyClaudeGuidance({ cwd: repo });
  assert.equal(result.channel, 'managed-block', 'no detectable native event must fall back');
  assert.equal(result.written, true, 'the fallback must actually write the block');
  const bytes = await fs.readFile(path.join(repo, '.claude', 'sdd-kit-discipline.md'), 'utf8');
  assert.equal(bytes, claudeManagedBlock(result.text));
  assert.ok(result.nativeEventsAvailable === false, 'the detected verdict must be reported');
  assert.ok(
    result.warnings.some((w) => /session_start|原生事件|托管块/.test(w)),
    `the fallback must be explained: ${result.warnings}`
  );
});

test('Claude guidance uses the native channel when the probe finds a rendered event (I1)', async () => {
  const repo = await makeRepo();
  await fs.writeFile(
    path.join(repo, '.specify', 'extensions.yml'),
    'hooks:\n  session_start:\n    - command: guidance\n',
    'utf8'
  );
  const result = await applyClaudeGuidance({ cwd: repo });
  assert.equal(result.channel, 'native-event');
  assert.equal(result.written, false);
  assert.equal(result.nativeEventsAvailable, true);
  await assert.rejects(fs.access(path.join(repo, '.claude', 'sdd-kit-discipline.md')));
});

test('an explicit nativeEventsAvailable still overrides the probe in both directions (I1)', async () => {
  const forcedOff = await makeRepo();
  await fs.writeFile(
    path.join(forcedOff, '.specify', 'extensions.yml'),
    'hooks:\n  session_start:\n    - command: guidance\n',
    'utf8'
  );
  const off = await applyClaudeGuidance({ cwd: forcedOff, nativeEventsAvailable: false });
  assert.equal(off.channel, 'managed-block');
  assert.equal(off.written, true);

  const forcedOn = await makeRepo();
  const on = await applyClaudeGuidance({ cwd: forcedOn, nativeEventsAvailable: true });
  assert.equal(on.channel, 'native-event');
  assert.equal(on.written, false);
});

test('Claude adapter is a thin shell (≤100 lines) (REQ-01)', () => {
  assert.ok(ADAPTER_SRC.split('\n').length <= 100, 'Claude adapter must be ≤100 lines');
});
