import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readMarkers, writeMarker, clearMarker, clearHostMarker, classifyMarkers, markerPath } from '../src/core/marker.mjs';

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
  assert.deepEqual(Object.keys(entry).sort(), ['host', 'layer', 'layers', 'reason', 'runId', 'timestamp']);
  assert.equal(entry.host, 'dsh');
  assert.equal(entry.layer, 'tool_code');
  assert.deepEqual(entry.layers, ['tool_code']);
  assert.equal(entry.runId, null);
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

test('a marker records every changed layer, not only the first (T080)', async () => {
  const repo = await makeRepo();
  const layers = ['tool_code', 'skill_data', 'extension_command'];
  const entry = await writeMarker({
    cwd: repo,
    host: 'dsh',
    layers,
    reason: 'multi-component update',
    now: '2026-11-24T10:00:00.000Z',
  });
  assert.deepEqual(entry.layers, layers);
  assert.equal(entry.layer, 'tool_code', 'the legacy layer field stays the first layer');
  assert.deepEqual((await readMarkers({ cwd: repo })).dsh.layers, layers);
});

test('clearHostMarker removes only the explicitly requested host (T081)', async () => {
  const repo = await makeRepo();
  await writeMarker({ cwd: repo, host: 'dsh', layer: 'tool_code', now: '2026-11-24T10:00:00.000Z' });
  await writeMarker({ cwd: repo, host: 'claude', layer: 'skill_data', now: '2026-11-24T10:01:00.000Z' });
  assert.equal(await clearHostMarker({ cwd: repo, host: 'dsh' }), true);
  assert.deepEqual(Object.keys(await readMarkers({ cwd: repo })), ['claude']);
  assert.equal(await clearHostMarker({ cwd: repo, host: 'dsh' }), false);
});

test('clearHostMarker requires a known explicit host (T081)', async () => {
  const repo = await makeRepo();
  await assert.rejects(clearHostMarker({ cwd: repo }), /requires an explicit host/);
  await assert.rejects(clearHostMarker({ cwd: repo, host: 'unknown-host' }), /unknown host/);
});

test('classifyMarkers keeps this run pending even across a day boundary (T084)', async () => {
  const repo = await makeRepo();
  await writeMarker({
    cwd: repo,
    host: 'dsh',
    layer: 'tool_code',
    now: '2026-11-20T00:00:00.000Z',
    runId: 'run-A',
  });
  const classified = classifyMarkers(await readMarkers({ cwd: repo }), {
    now: Date.parse('2026-11-22T00:00:00.000Z'),
    sessionStart: Date.parse('2026-11-21T00:00:00.000Z'),
    runId: 'run-A',
  });
  assert.deepEqual(classified.pending, ['dsh']);
  assert.deepEqual(classified.history, []);
});

test('classifyMarkers treats a 23-hour-old leftover from another run as history (T084)', async () => {
  const repo = await makeRepo();
  const now = Date.parse('2026-11-24T12:00:00.000Z');
  await writeMarker({
    cwd: repo,
    host: 'claude',
    layer: 'skill_data',
    now: new Date(now - 23 * 60 * 60 * 1000).toISOString(),
    runId: 'previous-run',
  });
  const classified = classifyMarkers(await readMarkers({ cwd: repo }), {
    now,
    sessionStart: now - 60 * 60 * 1000,
    runId: 'current-run',
  });
  assert.deepEqual(classified.pending, []);
  assert.deepEqual(classified.history, ['claude']);
});

test('classifyMarkers stays empty when the marker file is corrupt (T084)', async () => {
  const repo = await makeRepo();
  await fs.writeFile(path.join(repo, '.specify', 'sdd-pending.json'), '{not json', 'utf8');
  const now = Date.parse('2026-11-24T12:00:00.000Z');
  assert.deepEqual(
    classifyMarkers(await readMarkers({ cwd: repo }), { now, sessionStart: now - 1000, runId: 'run-A' }),
    { pending: [], history: [] },
  );
});
