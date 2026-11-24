import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readMarkers, writeMarker, clearMarker, markerPath } from '../src/core/marker.mjs';

async function makeRepo() {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-marker-'));
  await fs.mkdir(path.join(repo, '.specify'), { recursive: true });
  return repo;
}

test('marker entry carries the four data-model fields (REQ-18/AC-10)', async () => {
  const repo = await makeRepo();
  const entry = await writeMarker({
    cwd: repo,
    host: 'dsh',
    layer: 'tool_code',
    reason: '核心动作入口变更',
    now: '2026-11-24T10:00:00.000Z',
  });
  assert.deepEqual(Object.keys(entry).sort(), ['host', 'layer', 'reason', 'timestamp']);
  assert.equal(entry.host, 'dsh');
  assert.equal(entry.layer, 'tool_code');
  assert.equal(entry.timestamp, '2026-11-24T10:00:00.000Z');

  const stored = await readMarkers({ cwd: repo });
  assert.deepEqual(stored, { dsh: entry });
  assert.equal(markerPath(repo), path.join(repo, '.specify', 'sdd-pending.json'));
});

test('markers are shared per repository but recorded per host (REQ-17/AC-10)', async () => {
  const repo = await makeRepo();
  await writeMarker({ cwd: repo, host: 'dsh', layer: 'tool_code', reason: 'dsh 侧变更', now: '2026-11-24T10:00:00.000Z' });
  await writeMarker({ cwd: repo, host: 'claude', layer: 'skill_data', reason: 'claude 侧变更', now: '2026-11-24T10:01:00.000Z' });
  const stored = await readMarkers({ cwd: repo });
  assert.deepEqual(Object.keys(stored).sort(), ['claude', 'dsh']);
  assert.equal(stored.dsh.layer, 'tool_code');
  assert.equal(stored.claude.layer, 'skill_data');
});

test('clearing only removes the current host entry (REQ-18/AC-10)', async () => {
  const repo = await makeRepo();
  await writeMarker({ cwd: repo, host: 'dsh', layer: 'tool_code', reason: 'a', now: '2026-11-24T10:00:00.000Z' });
  await writeMarker({ cwd: repo, host: 'claude', layer: 'tool_code', reason: 'b', now: '2026-11-24T10:01:00.000Z' });
  const removed = await clearMarker({ cwd: repo, host: 'dsh' });
  assert.equal(removed, true);
  const stored = await readMarkers({ cwd: repo });
  assert.deepEqual(Object.keys(stored), ['claude']);
  assert.equal(await clearMarker({ cwd: repo, host: 'dsh' }), false);
});

test('timestamps distinguish a stale leftover from this run (REQ-19)', async () => {
  const repo = await makeRepo();
  await writeMarker({ cwd: repo, host: 'dsh', layer: 'tool_code', reason: 'old', now: '2026-11-20T00:00:00.000Z' });
  const stored = await readMarkers({ cwd: repo });
  assert.equal(stored.dsh.timestamp < '2026-11-24T00:00:00.000Z', true);
});

test('a corrupt marker file degrades to empty instead of throwing (AC-10)', async () => {
  const repo = await makeRepo();
  await fs.writeFile(path.join(repo, '.specify', 'sdd-pending.json'), '{not json', 'utf8');
  assert.deepEqual(await readMarkers({ cwd: repo }), {});
});
