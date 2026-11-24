/**
 * Five-zone read-only doctor. No writes, no network probes, deterministic
 * ordering, and a failure in one zone never suppresses the remaining zones.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { HOST_CAPABILITIES, HOST_KEYS } from './host-capabilities.mjs';
import { readMarkers } from './marker.mjs';
import { scoreSkills } from './trigger.mjs';

const PKG_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function item(status, code, message, fix, extra) {
  return { status, code, message, fix, ...(extra ? { ...extra } : {}) };
}

function aggregate(items) {
  if (items.length === 0) return 'skipped';
  return items.some((entry) => entry.status === 'fail') ? 'fail' : 'pass';
}

function zone(items) {
  return { status: aggregate(items), items };
}

function findOnPath(binary) {
  const paths = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return paths.some((dir) => {
    try {
      fs.accessSync(path.join(dir, binary), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function environmentZone() {
  const items = [];
  const major = Number(process.versions.node.split('.')[0]);
  items.push(major >= 18
    ? item('pass', 'NODE_VERSION', `Node ${process.versions.node} satisfies >=18`, 'No action needed.')
    : item('fail', 'NODE_VERSION', `Node ${process.versions.node} is older than 18`, 'Install Node >=18.'));
  for (const binary of ['node', 'npm']) {
    items.push(findOnPath(binary)
      ? item('pass', `TOOL_${binary.toUpperCase()}`, `${binary} is on PATH`, 'No action needed.')
      : item('fail', `TOOL_${binary.toUpperCase()}`, `${binary} is missing from PATH`, `Install ${binary} and add it to PATH.`));
  }
  items.push(item(
    'skip', 'NETWORK_PROBE',
    'Network probes are intentionally omitted to keep the doctor read-only and bounded',
    'Run the CI matrix for network-dependent checks.'
  ));
  return zone(items);
}

async function hostZone({ host, cwd, env, skills, trustFlags }) {
  const items = [];
  const cap = HOST_CAPABILITIES[host];
  items.push(cap
    ? item('pass', 'HOST_CAPABILITY', `host=${host} integration=${cap.integrationKey}`, 'No action needed.')
    : item('fail', 'HOST_CAPABILITY', `unknown host: ${host}`, `Use one of: ${HOST_KEYS.join(', ')}.`));
  if (cap?.guidanceChannel === 'rule-dir') {
    const flags = trustFlags ?? [];
    items.push(flags.length === 0
      ? item('pass', 'CURSOR_TRUST', 'no auto-trust dispatch flags configured', 'No action needed.')
      : item('warn', 'CURSOR_TRUST', `auto-trust flags detected: ${flags.join(' ')}; use only in controlled projects`, 'Remove the flags from the dispatch configuration.'));
  }
  const visible = (skills ?? []).length;
  items.push(item('pass', 'VISIBLE_SKILLS', `${visible} visible skills provided`, 'No action needed.'));
  const manifest = path.join(cwd, '.specify', 'extensions.yml');
  const hasManifest = fs.existsSync(manifest);
  items.push(hasManifest
    ? item('pass', 'EXTENSION_STATE', 'project extension manifest found', 'No action needed.')
    : item('warn', 'EXTENSION_STATE', 'project extension manifest not found', 'Run specify extension add --dev spec-kit-extension.'));
  return zone(items);
}

async function repositoryZone({ cwd }) {
  const items = [];
  const specifyDir = path.join(cwd, '.specify');
  items.push(fs.existsSync(specifyDir)
    ? item('pass', 'SPECIFY_DIR', '.specify/ present', 'No action needed.')
    : item('fail', 'SPECIFY_DIR', '.specify/ missing', 'Run specify init in this repository.'));
  const manifest = path.join(PKG_ROOT, 'spec-kit-extension', 'extension.yml');
  let text = '';
  try { text = await fsp.readFile(manifest, 'utf8'); } catch { /* reported below */ }
  for (const [code, pattern, hint] of [
    ['VERSION_FLOOR', /requires:\s*\n\s*speckit_version:\s*">=1\.4\.0"/m, 'restore requires.speckit_version >=1.4.0'],
    ['HOOK_COUNT', /optional:\s*false/g, 'restore six mandatory hooks'],
    ['SESSION_EVENT', /session_start:/, 'restore events.session_start'],
  ]) {
    const matched = code === 'HOOK_COUNT' ? (text.match(pattern) ?? []).length === 6 : pattern.test(text);
    items.push(matched
      ? item('pass', code, `${code} matches the packaged manifest`, 'No action needed.')
      : item('warn', code, `${code} drifted from the packaged manifest`, `Review spec-kit-extension/extension.yml: ${hint}.`));
  }
  return zone(items);
}

async function runtimeZone({ cwd, skills }) {
  const items = [];
  const markers = await readMarkers({ cwd });
  const entries = Object.entries(markers);
  items.push(entries.length === 0
    ? item('pass', 'PENDING_MARKERS', 'no pending reload markers', 'No action needed.')
    : item('warn', 'PENDING_MARKERS', `pending markers: ${entries.map(([host]) => host).sort().join(', ')}`, 'Restart the listed hosts to apply pending changes.'));
  const seen = new Map();
  for (const skill of skills ?? []) {
    if (!skill?.name) continue;
    if (!seen.has(skill.name)) seen.set(skill.name, new Set());
    seen.get(skill.name).add(skill.provider ?? 'unknown');
  }
  const conflicts = [...seen.entries()].filter(([, providers]) => providers.size > 1).map(([name]) => name).sort();
  items.push(conflicts.length === 0
    ? item('pass', 'SKILL_CONFLICT', 'no cross-provider skill name conflicts', 'No action needed.')
    : item('warn', 'SKILL_CONFLICT', `conflicting skill names: ${conflicts.join(', ')}`, 'Disable one of the conflicting providers.'));
  items.push(item(
    'skip', 'BRIDGE_SOURCE',
    'External bridge plugin provenance requires a live host runtime and is not probed here',
    'Inspect the host plugin list manually.'
  ));
  return zone(items);
}

function triggerZone({ trigger, skills }) {
  if (!trigger) return zone([item('skip', 'TRIGGER_NOT_PROVIDED', 'no --trigger supplied', 'Pass --trigger "<task description>" to score visible skills.')]);
  const scores = scoreSkills(trigger, skills ?? []);
  return { status: 'pass', items: [item('pass', 'TRIGGER_SCORES', `${scores.length} visible skills scored, none executed`, 'No action needed.', { scores })] };
}

async function safe(name, runner, fallback) {
  try {
    return await runner();
  } catch (error) {
    return fallback(error);
  }
}

/**
 * @param {object} options
 * @param {string} options.trigger optional task description for the dry-run zone
 * @param {string} options.host current host key
 * @param {string} options.cwd repository root (read only)
 * @param {Array} options.skills visible SkillSummary[] (no mirror-only entries)
 * @param {object} [options.deps] zone overrides for tests
 */
export async function runDoctor({
  trigger,
  host = 'dsh',
  cwd = process.cwd(),
  env = process.env,
  skills = [],
  trustFlags = [],
  deps = {},
} = {}) {
  const failZone = (error) => zone([item('fail', 'ZONE_PROBE_ERROR', error?.message ?? String(error), 'Fix the probe error and rerun the doctor.')]);
  const [environment, hostReport, repository, runtime, triggerDryRun] = await Promise.all([
    safe('environment', () => deps.environment ? deps.environment() : environmentZone(), failZone),
    safe('host', () => deps.host ? deps.host() : hostZone({ host, cwd, env, skills, trustFlags }), failZone),
    safe('repository', () => deps.repository ? deps.repository() : repositoryZone({ cwd }), failZone),
    safe('runtime', () => deps.runtime ? deps.runtime() : runtimeZone({ cwd, skills }), failZone),
    safe('triggerDryRun', () => deps.triggerDryRun ? deps.triggerDryRun() : triggerZone({ trigger, skills }), failZone),
  ]);
  return { environment, host: hostReport, repository, runtime, triggerDryRun };
}
