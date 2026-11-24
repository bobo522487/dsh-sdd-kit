/**
 * Five-zone read-only doctor. No writes, no network probes, deterministic
 * ordering, and a failure in one zone never suppresses the remaining zones.
 *
 * Zone status semantics:
 *   pass         at least one item ran and nothing failed
 *   fail         at least one item failed
 *   skipped      nothing was observable (empty zone, or every item is `skip`)
 *   not_executed an explicit dry-run was not requested, so nothing ran at all
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOST_CAPABILITIES, HOST_KEYS } from './host-capabilities.mjs';
import { readMarkers } from './marker.mjs';
import { scoreSkills } from './trigger.mjs';

/** Package root: src/core/doctor.mjs -> src/core -> src -> package root. */
const PKG_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** A pending marker older than this is history, not a pending change. */
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Toolchain the kit shells out to, probed on PATH only. */
const REQUIRED_TOOLS = ['node', 'npm'];
const OPTIONAL_TOOLS = ['uv', 'specify', 'git'];

/** Skill file naming used by the packaged extension commands. */
const HOOK_SKILL_RE = /^speckit-superpowers-hooks-[A-Za-z0-9-]+(?:\.md)?$/;

function item(status, code, message, fix, extra) {
  return { status, code, message, fix, ...(extra ? { ...extra } : {}) };
}

function aggregate(items) {
  if (items.length === 0) return 'skipped';
  if (items.some((entry) => entry.status === 'fail')) return 'fail';
  if (items.every((entry) => entry.status === 'skip')) return 'skipped';
  return 'pass';
}

function zone(items) {
  return { status: aggregate(items), items };
}

function findOnPath(binary, env) {
  const paths = String(env?.PATH ?? '').split(path.delimiter).filter(Boolean);
  return paths.some((dir) => {
    try {
      fs.accessSync(path.join(dir, binary), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function environmentZone({ env }) {
  const items = [];
  const major = Number(process.versions.node.split('.')[0]);
  items.push(major >= 18
    ? item('pass', 'NODE_VERSION', `Node ${process.versions.node} satisfies >=18`, 'No action needed.')
    : item('fail', 'NODE_VERSION', `Node ${process.versions.node} is older than 18`, 'Install Node >=18.'));
  for (const binary of REQUIRED_TOOLS) {
    items.push(findOnPath(binary, env)
      ? item('pass', `TOOL_${binary.toUpperCase()}`, `${binary} is on PATH`, 'No action needed.')
      : item('fail', `TOOL_${binary.toUpperCase()}`, `${binary} is missing from PATH`, `Install ${binary} and add it to PATH.`));
  }
  for (const binary of OPTIONAL_TOOLS) {
    items.push(findOnPath(binary, env)
      ? item('pass', `TOOL_${binary.toUpperCase()}`, `${binary} is on PATH`, 'No action needed.')
      : item('warn', `TOOL_${binary.toUpperCase()}`, `${binary} is missing from PATH`, `Install ${binary} and add it to PATH (for example ~/.local/bin).`));
  }
  items.push(item(
    'skip', 'NETWORK_PROBE',
    'Network probes are intentionally omitted to keep the doctor read-only and bounded',
    'Run the CI matrix for network-dependent checks.'
  ));
  return zone(items);
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function readText(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** Packaged extension command basenames, mapped to their skill directory names. */
async function packagedCommandSkills() {
  const dir = path.join(PKG_ROOT, 'spec-kit-extension', 'commands');
  let names = [];
  try {
    names = (await fsp.readdir(dir)).filter((name) => name.endsWith('.md')).sort();
  } catch {
    return [];
  }
  return names.map((name) => name.slice(0, -'.md'.length).replace(/\./g, '-'));
}

/** Skill names installed under a host skills directory (file or directory form). */
async function installedSkillNames(skillsDir) {
  let entries = [];
  try {
    entries = await fsp.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = new Set();
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!HOOK_SKILL_RE.test(entry.name)) continue;
    if (entry.isFile()) {
      found.add(entry.name.replace(/\.md$/, ''));
    } else if (entry.isDirectory()) {
      try {
        await fsp.access(path.join(skillsDir, entry.name, 'SKILL.md'));
        found.add(entry.name);
      } catch { /* an incomplete skill directory is not an installed skill */ }
    }
  }
  return [...found].sort();
}

function skillsDirFor(cwd, host) {
  const cap = HOST_CAPABILITIES[host];
  return cap ? path.join(cwd, cap.skillsDir) : null;
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
  items.push(fs.existsSync(manifest)
    ? item('pass', 'EXTENSION_STATE', 'project extension manifest found', 'No action needed.')
    : item('warn', 'EXTENSION_STATE', 'project extension manifest not found', 'Run specify extension add --dev spec-kit-extension.'));

  // Discipline guidance channel: which channel this host uses and which kit version feeds it.
  if (cap) {
    const pkg = await readJson(path.join(PKG_ROOT, 'package.json'));
    const version = pkg?.version ?? 'unknown';
    items.push(item(
      'pass', 'GUIDANCE_CHANNEL',
      `host=${host} channel=${cap.guidanceChannel} version=${version}`,
      'No action needed.',
      { host, channel: cap.guidanceChannel, version }
    ));
  } else {
    items.push(item('skip', 'GUIDANCE_CHANNEL', `guidance channel unknown for host=${host}`, 'Pick a supported host.'));
  }

  // Hook command rendering: how many of the packaged hook skills this host renders.
  const skillsDir = skillsDirFor(cwd, host);
  const rendered = skillsDir ? await installedSkillNames(skillsDir) : [];
  const expected = (await packagedCommandSkills()).length;
  const renderedHooks = rendered.filter((name) => name.includes('hooks-'));
  items.push(item(
    'pass', 'HOOK_RENDERING',
    `host=${host} rendered=${renderedHooks.length} of ${expected} hook command skills`,
    renderedHooks.length === 0
      ? 'No hook command skills rendered for this host; that is expected when the host is not active here.'
      : 'No action needed.',
    { host, rendered: renderedHooks, renderedCount: renderedHooks.length, expected }
  ));
  return zone(items);
}

async function repositoryZone({ cwd, host }) {
  const items = [];
  const specifyDir = path.join(cwd, '.specify');
  items.push(fs.existsSync(specifyDir)
    ? item('pass', 'SPECIFY_DIR', '.specify/ present', 'No action needed.')
    : item('fail', 'SPECIFY_DIR', '.specify/ missing', 'Run specify init in this repository.'));

  // Managed template override: compare the project copy with the packaged one.
  const packagedTemplate = path.join(PKG_ROOT, 'overrides', 'spec-template.md');
  const projectTemplate = path.join(cwd, '.specify', 'templates', 'overrides', 'spec-template.md');
  const [packagedText, projectText] = await Promise.all([
    readText(packagedTemplate),
    readText(projectTemplate),
  ]);
  if (packagedText === null) {
    items.push(item('warn', 'TEMPLATE_PACKAGED_MISSING', 'packaged overrides/spec-template.md is missing from the kit', 'Reinstall the kit or restore overrides/spec-template.md.'));
  } else if (projectText === null) {
    items.push(item('warn', 'TEMPLATE_MISSING', 'project has no .specify/templates/overrides/spec-template.md', 'Run specify extension add --dev spec-kit-extension to install the override.'));
  } else if (projectText === packagedText) {
    items.push(item('pass', 'TEMPLATE_DRIFT', 'project template override matches the packaged copy', 'No action needed.'));
  } else {
    items.push(item('warn', 'TEMPLATE_DRIFT', 'project template override differs from the packaged copy', 'Reinstall the override or re-apply local edits on top of the packaged copy.'));
  }

  // Extension command skills installed into this host's skill directory.
  const expected = await packagedCommandSkills();
  const skillsDir = skillsDirFor(cwd, host);
  const installed = skillsDir ? await installedSkillNames(skillsDir) : [];
  const present = expected.filter((name) => installed.includes(name));
  const missing = expected.filter((name) => !installed.includes(name));
  items.push(item(
    missing.length === 0 ? 'pass' : 'warn',
    'COMMAND_SKILLS',
    `${present.length} of ${expected.length} extension command skills installed${missing.length ? `; missing: ${missing.join(', ')}` : ''}`,
    missing.length === 0
      ? 'No action needed.'
      : 'Reinstall the extension to render the missing command skills for this host.',
    { installed: present, missing, expected }
  ));
  return zone(items);
}

/** Candidate bridge configuration files: explicit paths first, then well-known ones. */
function bridgeCandidates({ cwd, env }) {
  const candidates = [];
  for (const key of ['SDD_BRIDGE_CONFIG', 'DSH_CONFIG', 'DSH_PROFILE_DIR']) {
    const value = env?.[key];
    if (typeof value !== 'string' || value.length === 0) continue;
    let isDir = false;
    try { isDir = fs.statSync(value).isDirectory(); } catch { /* a missing path is simply not a candidate */ }
    if (isDir) {
      candidates.push({ key, file: path.join(value, 'cordis.patch.yml') });
      candidates.push({ key, file: path.join(value, 'cordis.yml') });
      candidates.push({ key, file: path.join(value, 'package.json') });
    } else {
      candidates.push({ key, file: value });
    }
  }
  candidates.push({ key: 'cwd', file: path.join(cwd, '.dsh', 'cordis.patch.yml') });
  candidates.push({ key: 'cwd', file: path.join(cwd, '.dsh', 'cordis.yml') });
  candidates.push({ key: 'cwd', file: path.join(cwd, '.dsh', 'package.json') });
  return candidates;
}

async function probeBridgeSource({ cwd, env }) {
  const observed = [];
  for (const candidate of bridgeCandidates({ cwd, env })) {
    const text = await readText(candidate.file);
    if (text === null) continue;
    observed.push({ ...candidate, mounted: /dsh-sdd-kit|sdd-kit|superpowers/i.test(text) });
  }
  const mounted = observed.find((entry) => entry.mounted);
  const chosen = mounted ?? observed[0];
  if (!chosen) {
    return item(
      'skip', 'BRIDGE_SOURCE',
      'no host bridge configuration discoverable from the environment or the repository; provenance not probed',
      'Point SDD_BRIDGE_CONFIG (or DSH_CONFIG) at the host plugin configuration to enable this probe.'
    );
  }
  const where = `${path.relative(cwd, chosen.file) || chosen.file} (via ${chosen.key})`;
  return item(
    mounted ? 'pass' : 'warn',
    'BRIDGE_SOURCE',
    `bridge source observed at ${where}${mounted ? '; sdd-kit mount found' : '; no sdd-kit mount found'}`,
    mounted ? 'No action needed.' : 'Check whether the bridge plugin is mounted for this host.',
    { source: chosen.file, via: chosen.key, observed: observed.map((entry) => entry.file) }
  );
}

async function runtimeZone({ cwd, env, skills }) {
  const items = [];
  const markers = await readMarkers({ cwd });
  const entries = Object.entries(markers)
    .filter(([, value]) => value && typeof value === 'object')
    .sort(([a], [b]) => a.localeCompare(b));
  const now = Date.now();
  const pending = [];
  const history = [];
  for (const [host, marker] of entries) {
    const stamped = Date.parse(String(marker.timestamp ?? ''));
    const age = Number.isFinite(stamped) ? now - stamped : Number.POSITIVE_INFINITY;
    if (age > PENDING_MAX_AGE_MS) history.push(host);
    else pending.push(host);
  }
  if (pending.length > 0) {
    items.push(item(
      'warn', 'PENDING_MARKERS',
      `pending markers: ${pending.join(', ')}${history.length ? `; history (older than 24h, not pending for this run): ${history.join(', ')}` : ''}`,
      `Restart ${pending.join(', ')} to apply pending changes.`,
      { pending, history }
    ));
  } else if (history.length > 0) {
    items.push(item(
      'warn', 'PENDING_MARKERS',
      `no pending markers; only history older than 24h: ${history.join(', ')} (not pending for this run)`,
      'Clear stale markers with the kit CLI if the reload already happened.',
      { pending, history }
    ));
  } else {
    items.push(item('pass', 'PENDING_MARKERS', 'no pending reload markers', 'No action needed.', { pending, history }));
  }

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

  items.push(await probeBridgeSource({ cwd, env }));
  return zone(items);
}

function triggerZone({ trigger, skills }) {
  if (!trigger) {
    return {
      status: 'not_executed',
      items: [item('skip', 'TRIGGER_NOT_PROVIDED', 'dry-run not executed: no --trigger supplied', 'Pass --trigger "<task description>" to score visible skills.')],
    };
  }
  const visible = skills ?? [];
  if (visible.length === 0) {
    return {
      status: 'skipped',
      items: [item('skip', 'TRIGGER_NO_VISIBLE_SKILLS', 'dry-run not executed: no visible skills to score', 'Load a skill provider before running the trigger dry-run.')],
    };
  }
  const scores = scoreSkills(trigger, visible);
  return {
    status: 'pass',
    items: [item('pass', 'TRIGGER_SCORES', `${scores.length} visible skills scored, none executed`, 'No action needed.', { scores })],
  };
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
 * @param {object} [options.env] environment used for PATH and bridge discovery
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
    safe('environment', () => deps.environment ? deps.environment() : environmentZone({ env }), failZone),
    safe('host', () => deps.host ? deps.host() : hostZone({ host, cwd, env, skills, trustFlags }), failZone),
    safe('repository', () => deps.repository ? deps.repository() : repositoryZone({ cwd, host }), failZone),
    safe('runtime', () => deps.runtime ? deps.runtime() : runtimeZone({ cwd, env, skills }), failZone),
    safe('triggerDryRun', () => deps.triggerDryRun ? deps.triggerDryRun() : triggerZone({ trigger, skills }), failZone),
  ]);
  return { environment, host: hostReport, repository, runtime, triggerDryRun };
}
