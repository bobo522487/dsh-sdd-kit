/**
 * Host-neutral production run context.
 *
 * A pending marker must stay associated with the run that produced it even
 * after the 24-hour age window. This module derives that association from
 * neutral process facts only: no host package, no host variables, no default
 * host. Explicit values from callers still win; this is only the production
 * fallback used when a CLI, tool call or host startup did not supply one.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CACHE_SYMBOL = Symbol.for('dsh-sdd-kit.run-context');

/** Ticks since boot for one process, from field 22 of /proc/<pid>/stat. */
function processTicks(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const ticks = Number(fields[19]);
    return Number.isFinite(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

function ticksPerSecond(selfTicks, uptimeSeconds) {
  if (!(selfTicks > 0) || !(uptimeSeconds > 0)) return null;
  const estimated = selfTicks / uptimeSeconds;
  for (const candidate of [100, 250, 1000]) {
    if (Math.abs(estimated - candidate) / candidate < 0.2) return candidate;
  }
  return estimated;
}

/** Parent-process start time, so multiple child CLI calls share one run. */
function readParentStart(pid, now) {
  const ticks = processTicks(pid);
  if (ticks === null) return null;
  try {
    const text = fs.readFileSync('/proc/stat', 'utf8');
    const match = /(?:^|\n)btime\s+(\d+)/.exec(text);
    if (!match) return null;
    const rate = ticksPerSecond(processTicks(process.pid), process.uptime());
    if (!rate || !(rate > 0)) return null;
    const parentStart = (Number(match[1]) * 1000) + ((ticks * 1000) / rate);
    return Number.isFinite(parentStart) && parentStart > 0 && parentStart <= now
      ? Math.round(parentStart)
      : null;
  } catch {
    return null;
  }
}

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

/**
 * Build a run context from neutral inputs. Every external fact can be injected,
 * which keeps the derivation deterministic in tests and in embedded runtimes.
 */
export function createRunContext(inputs = {}) {
  const now = firstFinite(inputs.now, Date.now()) ?? Date.now();
  const cwd = path.resolve(firstText(inputs.cwd, process.cwd()) ?? process.cwd());
  const name = firstText(inputs.hostname, os.hostname()) ?? 'unknown';
  const pid = firstFinite(inputs.pid, process.pid) ?? process.pid;
  const parent = firstFinite(inputs.ppid, process.ppid) ?? process.ppid;
  const processStart = firstFinite(
    inputs.processStart,
    Math.round(now - (process.uptime() * 1000))
  ) ?? now;
  const parentStart = inputs.parentStart === null
    ? null
    : firstFinite(inputs.parentStart, readParentStart(parent, now));
  const sessionStart = firstFinite(inputs.sessionStart, parentStart, processStart, now) ?? now;
  const seed = [name, cwd, parent, parentStart ?? processStart, sessionStart].join('\u0000');
  const runId = firstText(inputs.runId, crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32));
  return { sessionStart, runId };
}

/**
 * Stable context for one process/workspace. A workspace key avoids leaking one
 * repository's run id into another workspace handled by the same runtime.
 */
export function getRunContext(inputs = {}) {
  let cache = globalThis[CACHE_SYMBOL];
  if (!cache || typeof cache !== 'object') {
    cache = new Map();
    globalThis[CACHE_SYMBOL] = cache;
  }
  const cwd = path.resolve(firstText(inputs.cwd, process.cwd()) ?? process.cwd());
  if (!cache.has(cwd)) cache.set(cwd, createRunContext({ ...inputs, cwd }));
  return { ...cache.get(cwd) };
}
