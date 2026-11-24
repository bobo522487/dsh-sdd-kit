/**
 * Pending-change marker: one repository-shared file, one entry per host.
 * Atomic writes (temp file + rename) so a crash never leaves a half file.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { HOST_CAPABILITIES, HOST_KEYS } from './host-capabilities.mjs';

const DEFAULT_HOST = HOST_KEYS[0];

export function markerPath(cwd) {
  return path.join(cwd, '.specify', 'sdd-pending.json');
}

export async function readMarkers({ cwd = process.cwd() } = {}) {
  try {
    const raw = await fs.readFile(markerPath(cwd), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

async function writeAll(cwd, data) {
  const target = markerPath(cwd);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fs.rename(temp, target);
}

/**
 * Every affected layer is recorded. `layer` remains the first layer so older
 * consumers (host startup cleanup, doctor) keep working unchanged.
 *
 * @returns {Promise<{host: string, layer: string, layers: string[], timestamp: string, reason: string, runId: string|null}>}
 */
export async function writeMarker({
  cwd = process.cwd(),
  host = DEFAULT_HOST,
  layer,
  layers,
  reason = '',
  runId = null,
  now = new Date().toISOString(),
} = {}) {
  const allLayers = [...new Set(layers ?? [layer ?? 'tool_code'])];
  const entry = {
    host,
    layer: allLayers[0],
    layers: allLayers,
    timestamp: now,
    reason,
    runId,
  };
  const all = await readMarkers({ cwd });
  all[host] = entry;
  await writeAll(cwd, all);
  return entry;
}

/**
 * Remove only the current host's entry; other hosts and repositories stay untouched.
 * @returns {Promise<boolean>} whether an entry was removed
 */
export async function clearMarker({ cwd = process.cwd(), host = DEFAULT_HOST } = {}) {
  const all = await readMarkers({ cwd });
  if (!(host in all)) return false;
  delete all[host];
  await writeAll(cwd, all);
  return true;
}

/**
 * Explicit-host cleanup entry point for a host startup path or CLI `--host`
 * handler. Unlike `clearMarker`, it refuses an implicit or unknown host so a
 * startup path cannot accidentally clear somebody else's marker.
 * @returns {Promise<boolean>} whether an entry was removed
 */
export async function clearHostMarker({ cwd = process.cwd(), host } = {}) {
  if (!host) throw new Error('clearHostMarker 需要显式提供 host');
  if (!Object.hasOwn(HOST_CAPABILITIES, host)) throw new Error(`未知的宿主：${host}`);
  return clearMarker({ cwd, host });
}

/**
 * Pure pending/history partition relative to the current run or session.
 * A marker carrying this run's id is pending even across a wall-clock day
 * boundary; otherwise a timestamp at/after the session baseline is pending.
 * Everything else is history (bad timestamps included).
 *
 * Without a usable baseline the baseline falls back to a bounded history
 * window before `now`. This keeps a freshly written marker pending on the
 * production CLI path while still letting years-old leftovers be reported as
 * history instead of warning forever (final review C1).
 */
export const MARKER_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function classifyMarkers(markers = {}, { now = Date.now(), sessionStart, runId } = {}) {
  const parsed = typeof sessionStart === 'number'
    ? sessionStart
    : (typeof sessionStart === 'string' ? Date.parse(sessionStart) : Number.NaN);
  const baseline = Number.isFinite(parsed) ? parsed : now - MARKER_HISTORY_WINDOW_MS;
  const pending = [];
  const history = [];
  for (const [host, marker] of Object.entries(markers ?? {})) {
    if (!marker || typeof marker !== 'object') continue;
    const sameRun = runId != null && marker.runId === runId;
    const stamped = Date.parse(String(marker.timestamp ?? ''));
    const withinSession = Number.isFinite(stamped) && stamped >= baseline;
    (sameRun || withinSession ? pending : history).push(host);
  }
  return { pending, history };
}
