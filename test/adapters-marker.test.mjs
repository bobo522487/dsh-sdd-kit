import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { applyDshGuidance } from '../src/adapters/dsh/index.mjs';
import { writeMarker } from '../src/core/marker.mjs';

function mockCtx() {
  const sections = [];
  return {
    sections,
    get: (name) => (name === 'systemPrompt'
      ? {
          getSectionOrder: () => 500,
          section: (section) => { sections.push(section); return () => {}; },
        }
      : undefined),
  };
}

test('DSH adapter clears only the current host marker at startup (REQ-18/AC-10)', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-startup-'));
  await fs.mkdir(path.join(repo, '.specify'), { recursive: true });
  await writeMarker({ cwd: repo, host: 'dsh', layer: 'tool_code', reason: '本次改动' });
  await writeMarker({ cwd: repo, host: 'claude', layer: 'skill_data', reason: '另一宿主' });

  const ctx = mockCtx();
  await applyDshGuidance(ctx, { cwd: repo, env: process.env, warnings: [] });

  const stored = JSON.parse(await fs.readFile(path.join(repo, '.specify', 'sdd-pending.json'), 'utf8'));
  assert.equal(stored.dsh, undefined);
  assert.equal(stored.claude.layer, 'skill_data');
});

test('a repository without a marker starts cleanly (AC-10)', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-startup-empty-'));
  const ctx = mockCtx();
  const dispose = await applyDshGuidance(ctx, { cwd: repo, env: process.env, warnings: [] });
  assert.equal(typeof dispose, 'function');
  await assert.rejects(fs.access(path.join(repo, '.specify', 'sdd-pending.json')));
});
