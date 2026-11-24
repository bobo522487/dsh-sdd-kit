/**
 * Host-neutral production run context.
 *
 * A pending marker must stay associated with the run that produced it even
 * after the 24-hour age window. This module derives that association from
 * neutral inputs only: no host package, no host variables, no default host,
 * and no pid/ppid in the seed. A small anchor in the workspace makes the value
 * stable across independent CLI processes; explicit caller values still win.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CACHE_SYMBOL = Symbol.for('dsh-sdd-kit.run-context');
const ANCHOR_FILE = 'sdd-run-context.json';
const DAY_MS = 24 * 60 * 60 * 1000;
const USER_HZ = 100;

function firstFinite(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

function neutralUserId(inputs = {}) {
  if (inputs.uid !== undefined && inputs.uid !== null && String(inputs.uid).trim() !== '') {
    return String(inputs.uid);
  }
  try {
    return String(os.userInfo().uid ?? '');
  } catch {
    return '';
  }
}

function anchorPath(cwd) {
  // `.specify/extensions/` is the kit's ignored install-artifact area, so the
  // runtime anchor never dirties `git status` or competes with tracked specs.
  return path.join(cwd, '.specify', 'extensions', ANCHOR_FILE);
}

function validAnchor(value) {
  if (!value || typeof value !== 'object') return null;
  const sessionStart = firstFinite(value.sessionStart);
  const runId = firstText(value.runId);
  if (sessionStart === null || !runId || !/^[0-9a-f]{32}$/.test(runId)) return null;
  return { sessionStart, runId };
}

/** Read-only anchor lookup; a missing or corrupt file is simply no anchor. */
function readAnchor(cwd) {
  try {
    return validAnchor(JSON.parse(fs.readFileSync(anchorPath(cwd), 'utf8')));
  } catch {
    return null;
  }
}

function readProcText(injected, filePath) {
  if (typeof injected === 'string') return injected;
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** Field 22 of /proc/<pid>/stat is starttime in clock ticks since boot. */
function procStartTicks(text) {
  if (typeof text !== 'string') return null;
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const fields = text.slice(close + 2).trim().split(/\s+/);
  const ticks = Number(fields[19]);
  return Number.isFinite(ticks) && ticks >= 0 ? ticks : null;
}

function procBootTimeMs(text) {
  if (typeof text !== 'string') return null;
  const match = /(?:^|\n)btime\s+(\d+)/.exec(text);
  if (!match) return null;
  const bootMs = Number(match[1]) * 1000;
  return Number.isFinite(bootMs) && bootMs > 0 ? bootMs : null;
}

/**
 * Current-process fact for the read-only/degraded path. Linux uses btime plus
 * fixed USER_HZ; every other platform falls back to now - process uptime.
 * Boot time is never used as a session start.
 */
function processStartFacts(inputs, now, pid) {
  const platform = firstText(inputs.platform, process.platform) ?? process.platform;
  if (platform === 'linux') {
    const stat = readProcText(inputs.procStatText, `/proc/${pid}/stat`);
    const boot = readProcText(inputs.procBootStatText, '/proc/stat');
    const ticks = procStartTicks(stat);
    const bootMs = procBootTimeMs(boot);
    if (ticks !== null && bootMs !== null) {
      const candidate = bootMs + ((ticks * 1000) / USER_HZ);
      if (candidate > bootMs && candidate <= now) return Math.round(candidate);
    }
  }
  const uptime = firstFinite(inputs.uptimeSeconds, process.uptime()) ?? 0;
  const candidate = now - (uptime * 1000);
  return Math.round(Math.max(0, Number.isFinite(candidate) && candidate <= now ? candidate : now));
}

function cacheKey(inputs, cwd) {
  const anchor = inputs.anchor === null
    ? null
    : (validAnchor(inputs.anchor) ?? readAnchor(cwd));
  const now = firstFinite(inputs.now, Date.now()) ?? Date.now();
  return JSON.stringify({
    cwd,
    uid: neutralUserId(inputs),
    hostname: firstText(inputs.hostname, os.hostname()) ?? 'unknown',
    runId: firstText(inputs.runId),
    sessionStart: firstFinite(inputs.sessionStart),
    anchor,
    platform: firstText(inputs.platform, process.platform) ?? process.platform,
    pid: firstFinite(inputs.pid, process.pid) ?? process.pid,
    processStart: firstFinite(inputs.processStart),
    fallbackToProcessStart: inputs.fallbackToProcessStart === true,
    uptimeSeconds: firstFinite(inputs.uptimeSeconds),
    procStatText: typeof inputs.procStatText === 'string' ? inputs.procStatText : null,
    procBootStatText: typeof inputs.procBootStatText === 'string' ? inputs.procBootStatText : null,
    dayBucket: Math.floor(now / DAY_MS) * DAY_MS,
  });
}

/**
 * Build a run context from neutral inputs. Every external fact can be injected,
 * which keeps the derivation deterministic in tests and embedded runtimes.
 */
export function createRunContext(inputs = {}) {
  const now = firstFinite(inputs.now, Date.now()) ?? Date.now();
  const cwd = path.resolve(firstText(inputs.cwd, process.cwd()) ?? process.cwd());
  const name = firstText(inputs.hostname, os.hostname()) ?? 'unknown';
  const uid = neutralUserId(inputs);
  const pid = firstFinite(inputs.pid, process.pid) ?? process.pid;
  const anchor = inputs.anchor === null
    ? null
    : (validAnchor(inputs.anchor) ?? readAnchor(cwd));
  const dayBucket = Math.floor(now / DAY_MS) * DAY_MS;
  const fallback = inputs.fallbackToProcessStart === true
    ? processStartFacts(inputs, now, pid)
    : dayBucket;
  const sessionStart = firstFinite(
    inputs.sessionStart,
    anchor?.sessionStart,
    fallback,
    now
  ) ?? now;
  const seed = [uid, name, cwd, sessionStart].join('\u0000');
  const generated = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32);
  const runId = firstText(inputs.runId, anchor?.runId, generated) ?? generated;
  return { sessionStart, runId };
}

/**
 * Stable context for one process/workspace. The cache key contains every input
 * that can change the seed, so cwd alone can no longer pin a stale run id.
 */
export function getRunContext(inputs = {}) {
  let cache = globalThis[CACHE_SYMBOL];
  if (!cache || typeof cache !== 'object') {
    cache = new Map();
    globalThis[CACHE_SYMBOL] = cache;
  }
  const cwd = path.resolve(firstText(inputs.cwd, process.cwd()) ?? process.cwd());
  const key = cacheKey(inputs, cwd);
  if (!cache.has(key)) cache.set(key, createRunContext({ ...inputs, cwd }));
  return { ...cache.get(key) };
}

/**
 * Persist the neutral anchor for non-read-only actions. The write is atomic
 * (temp file + rename) and touches only the kit-owned
 * `.specify/extensions/sdd-run-context.json`.
 * Doctor never calls this, so REQ-38/REQ-39 zero-write体检 stays intact.
 * Returns the anchor in effect, or null when the workspace is read-only.
 */
export async function ensureRunAnchor({ cwd = process.cwd(), context = {} } = {}) {
  const root = path.resolve(cwd);
  const target = anchorPath(root);
  const dir = path.dirname(target);
  const sessionStart = firstFinite(context.sessionStart);
  const runId = firstText(context.runId);
  if (sessionStart === null || !runId) return null;

  const existing = readAnchor(root);
  if (existing) return existing;

  const payload = `${JSON.stringify({
    version: 1,
    sessionStart,
    runId,
    createdAt: Date.now(),
    creator: 'dsh-sdd-kit',
  })}\n`;
  const nonce = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(6).toString('hex');
  const temp = path.join(dir, `.${ANCHOR_FILE}.${process.pid}.${nonce}.tmp`);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const raced = readAnchor(root);
    if (raced) return raced;
    await fs.promises.writeFile(temp, payload, { encoding: 'utf8', mode: 0o600 });
    const afterWrite = readAnchor(root);
    if (afterWrite) {
      await fs.promises.unlink(temp).catch(() => {});
      return afterWrite;
    }
    await fs.promises.rename(temp, target);
    return { sessionStart, runId };
  } catch {
    await fs.promises.unlink(temp).catch(() => {});
    return null;
  }
}
