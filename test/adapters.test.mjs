import test from 'node:test';
import assert from 'node:assert/strict';

import { applyDshGuidance } from '../src/adapters/dsh/index.mjs';

test('DSH adapter loads without systemPrompt and registers no section (REQ-10/AC-05)', async () => {
  const ctx = { get: (name) => (name === 'systemPrompt' ? undefined : {}) };
  const warnings = [];
  const dispose = await applyDshGuidance(ctx, { cwd: process.cwd(), warnings, env: process.env });
  assert.equal(typeof dispose, 'function');
  assert.deepEqual(warnings, ['ctx.systemPrompt 服务缺失，会话引导静默缺席。']);
  dispose();
});

test('DSH adapter registers one ordered section and disposes it (REQ-08)', async () => {
  const sections = [];
  const ctx = {
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
  const dispose = await applyDshGuidance(ctx, { cwd: process.cwd(), env: process.env });
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'sdd-kit:discipline');
  assert.equal(sections[0].order, 501);
  assert.match(sections[0].text, /sdd_upstream/);
  dispose();
  assert.equal(sections[0].disposed, true);
});
