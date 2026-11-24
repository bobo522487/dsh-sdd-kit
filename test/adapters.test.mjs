import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { applyDshGuidance, resolveGuidanceHost } from '../src/adapters/dsh/index.mjs';

const INDEX_SRC = await fs.readFile(new URL('../src/index.mjs', import.meta.url), 'utf8');
const DSH_SRC = await fs.readFile(new URL('../src/adapters/dsh/index.mjs', import.meta.url), 'utf8');

function mockCtx() {
  const sections = [];
  return {
    sections,
    get: (name) => (name === 'systemPrompt'
      ? {
          getSectionOrder: (anchor) => (anchor === 'PLAN_POLICY' ? 500 : 0),
          section: (section) => {
            sections.push(section);
            return () => { section.disposed = true; };
          },
        }
      : undefined),
  };
}

async function makeRepo({ switchEnabled } = {}) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-adapter-'));
  await fs.mkdir(path.join(repo, '.specify'), { recursive: true });
  if (typeof switchEnabled === 'boolean') {
    await fs.writeFile(
      path.join(repo, '.specify', 'sdd-kit.json'),
      JSON.stringify({ guidance: { enabled: switchEnabled } }),
      'utf8'
    );
  }
  return repo;
}

/**
 * An existing but empty mirror: the host resolves a mirror, yet sees zero
 * visible discipline skills, so upstreamText is empty (T069).
 */
async function emptyMirrorEnv() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-empty-mirror-'));
  const mirror = path.join(root, 'superpowers');
  await fs.mkdir(path.join(mirror, 'skills'), { recursive: true });
  return { ...process.env, DSH_SDD_KIT_SUPERPOWERS_DIR: mirror, HOME: root };
}

test('DSH adapter loads without systemPrompt and registers no section (REQ-10/AC-05)', async () => {
  const ctx = { get: (name) => (name === 'systemPrompt' ? undefined : {}) };
  const warnings = [];
  const dispose = await applyDshGuidance(ctx, { cwd: process.cwd(), warnings, env: process.env });
  assert.equal(typeof dispose, 'function');
  assert.deepEqual(warnings, ['ctx.systemPrompt 服务缺失，会话引导静默缺席。']);
  dispose();
});

test('DSH adapter registers one ordered section and disposes it (REQ-08)', async () => {
  const ctx = mockCtx();
  const dispose = await applyDshGuidance(ctx, { cwd: process.cwd(), env: process.env });
  assert.equal(ctx.sections.length, 1);
  assert.equal(ctx.sections[0].name, 'sdd-kit:discipline');
  assert.equal(ctx.sections[0].order, 501);
  assert.match(ctx.sections[0].text, /sdd_upstream/);
  dispose();
  assert.equal(ctx.sections[0].disposed, true);
});

test('a closed guidance switch registers no DSH section and reports the state (T067)', async () => {
  const repo = await makeRepo({ switchEnabled: false });
  const ctx = mockCtx();
  const warnings = [];
  const dispose = await applyDshGuidance(ctx, { cwd: repo, env: process.env, warnings });
  assert.equal(ctx.sections.length, 0, 'a closed switch must not register a section');
  assert.equal(typeof dispose, 'function', 'a closed switch still returns a disposer');
  assert.equal(dispose.status.enabled, false);
  assert.equal(dispose.status.registered, false);
  assert.equal(dispose.status.reason, 'disabled');
  dispose();
});

test('an empty upstream mirror keeps the DSH section out and surfaces its warning (T069)', async () => {
  const repo = await makeRepo();
  const ctx = mockCtx();
  const warnings = [];
  const dispose = await applyDshGuidance(ctx, { cwd: repo, env: await emptyMirrorEnv(), warnings });
  assert.equal(ctx.sections.length, 0, 'empty upstream text must not register a section');
  assert.equal(dispose.status.enabled, true, 'the switch still decides enabled');
  assert.equal(dispose.status.registered, false);
  assert.equal(dispose.status.reason, 'no-upstream');
  assert.ok(dispose.status.warnings.length > 0, 'warnings must stay readable on the status');
  assert.ok(warnings.some((w) => /纪律技能/.test(w)), `warnings must reach the caller: ${warnings}`);
});

test('startup host selection reads the env, then the context, then defaults to dsh (T086)', () => {
  assert.equal(resolveGuidanceHost({ env: {} }), 'dsh');
  assert.equal(resolveGuidanceHost({ env: { DSH_SDD_KIT_HOST: 'codex' } }), 'codex');
  assert.equal(resolveGuidanceHost({ env: { DSH_SDD_KIT_HOST: ' Cursor ' } }), 'cursor');
  assert.equal(resolveGuidanceHost({ env: {}, ctx: { sddKitHost: 'claude' } }), 'claude');
  assert.equal(
    resolveGuidanceHost({ env: { DSH_SDD_KIT_HOST: 'claude' }, ctx: { sddKitHost: 'codex' } }),
    'claude',
    'an explicit env declaration wins over the context marker'
  );
  assert.equal(resolveGuidanceHost({ env: { DSH_SDD_KIT_HOST: 'nope' } }), 'dsh', 'an unknown host never breaks startup');
  assert.equal(resolveGuidanceHost({ env: {}, ctx: { get: () => 'cursor' } }), 'cursor');
  assert.equal(resolveGuidanceHost({ env: {}, ctx: { get: () => { throw new Error('no service'); } } }), 'dsh');
});

test('startup dispatches every host adapter without blocking tool loading (T086)', () => {
  for (const fn of ['applyDshGuidance', 'applyClaudeGuidance', 'applyCodexGuidance', 'applyCursorGuidance']) {
    assert.match(INDEX_SRC, new RegExp(`\\b${fn}\\b`), `src/index.mjs must reach ${fn}`);
  }
  assert.match(INDEX_SRC, /resolveGuidanceHost/);
  assert.match(INDEX_SRC, /\.catch\(/, 'a failing guidance channel must never prevent the tools from loading');
});

test('the DSH adapter contains no business judgement over the shared bundle (T087)', () => {
  assert.doesNotMatch(DSH_SRC, /bundle\.toolMapping/, 'adapters only format/IO the shared bundle');
  assert.doesNotMatch(DSH_SRC, /bundle\.sddPointer/, 'adapters only format/IO the shared bundle');
});

test('every host doc explains how to switch the startup host (T086)', async () => {
  for (const host of ['claude', 'codex', 'cursor']) {
    const doc = await fs.readFile(new URL(`../docs/adapters/${host}.md`, import.meta.url), 'utf8');
    assert.match(doc, /DSH_SDD_KIT_HOST=/, `${host}.md must document the host switch`);
    assert.match(doc, /T067/, `${host}.md must document the closed-switch behaviour`);
    assert.match(doc, /T069/, `${host}.md must document the empty-upstream behaviour`);
  }
});
