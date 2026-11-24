/**
 * Pending-change marker: one repository-shared file, one entry per host.
 * Atomic writes (temp file + rename) so a crash never leaves a half file.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

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
 * @returns {Promise<{host: string, layer: string, timestamp: string, reason: string}>}
 */
export async function writeMarker({
  cwd = process.cwd(),
  host = 'dsh',
  layer = 'tool_code',
  reason = '',
  now = new Date().toISOString(),
} = {}) {
  const entry = { host, layer, timestamp: now, reason };
  const all = await readMarkers({ cwd });
  all[host] = entry;
  await writeAll(cwd, all);
  return entry;
}

/**
 * Remove only the current host's entry; other hosts and repositories stay untouched.
 * @returns {Promise<boolean>} whether an entry was removed
 */
export async function clearMarker({ cwd = process.cwd(), host = 'dsh' } = {}) {
  const all = await readMarkers({ cwd });
  if (!(host in all)) return false;
  delete all[host];
  await writeAll(cwd, all);
  return true;
}
