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

import {
  HOST_CAPABILITIES,
  HOST_KEYS,
  checkTrustFlags,
  isDisciplineSkill,
} from './host-capabilities.mjs';
import { resolveGuidanceSwitch } from './guidance.mjs';
import { readMarkers, classifyMarkers } from './marker.mjs';
import { scoreSkills } from './trigger.mjs';
import { selectSuperpowersDir } from './candidates.mjs';
import { DEFAULT_SUPERPOWERS_REPO } from './upstream.mjs';

/** Package root: src/core/doctor.mjs -> src/core -> src -> package root. */
const PKG_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Toolchain the kit shells out to, probed on PATH only.
 *
 * `specify` is required rather than optional: every host artifact this kit
 * renders (command skills, execution hooks) is produced by the Spec Kit CLI, so
 * a machine without it cannot install or repair a single integration end. The
 * doctor must report that as a failure instead of a warning (AC-07).
 */
const REQUIRED_TOOLS = ['node', 'npm', 'specify'];
const OPTIONAL_TOOLS = ['uv', 'git'];

/** Skill file naming used by the packaged extension commands. */
const HOOK_SKILL_RE = /^speckit-superpowers-hooks-[A-Za-z0-9-]+(?:\.md)?$/;

/** Integration keys are what `.specify/integration*.yml|json` records; hosts are their DSH keys. */
const INTEGRATION_KEY_TO_HOST = Object.freeze(Object.fromEntries(
  HOST_KEYS.map((host) => [HOST_CAPABILITIES[host].integrationKey, host])
));

/** The four hook skills that actually render as host skills (guard/guidance are event-only). */
const EXECUTION_HOOK_COMMANDS = Object.freeze([
  'speckit-superpowers-hooks-before-implement',
  'speckit-superpowers-hooks-after-implement',
  'speckit-superpowers-hooks-before-bug-fix',
  'speckit-superpowers-hooks-after-bug-fix',
]);

/** Six contract hook events defined by spec-kit-extension/extension.yml. */
const HOOK_EVENTS = Object.freeze([
  'before_clarify', 'before_plan', 'before_implement', 'after_implement', 'before_bug_fix', 'after_bug_fix',
]);

/** Concrete commands (REQ-34): every failed probe carries an actionable fix. */
const TOOL_FIX_COMMANDS = Object.freeze({
  node: 'nvm install --lts && nvm use --lts',
  npm: 'npm install -g npm',
  uv: 'curl -LsSf https://astral.sh/uv/install.sh | sh',
  specify: 'uv tool install specify-cli --from git+https://github.com/github/spec-kit.git',
  git: 'apt-get install -y git (or: brew install git)',
});

/** User-authored skills win same-name conflicts: the kit must never shadow them (REQ-46). */
const SKILL_PROVIDER_ORDER = ['user', 'host', 'project', 'plugin', 'bundled'];

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

async function readableDir(dir) {
  if (!dir) return false;
  try {
    await fsp.access(dir, fs.constants.R_OK);
    return (await fsp.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function environmentZone({ env }) {
  const items = [];
  const major = Number(process.versions.node.split('.')[0]);
  items.push(major >= 18
    ? item('pass', 'NODE_VERSION', `Node ${process.versions.node} satisfies >=18`, 'No action needed.')
    : item('fail', 'NODE_VERSION', `Node ${process.versions.node} is older than 18`, TOOL_FIX_COMMANDS.node));
  for (const binary of REQUIRED_TOOLS) {
    items.push(findOnPath(binary, env)
      ? item('pass', `TOOL_${binary.toUpperCase()}`, `${binary} is on PATH`, 'No action needed.')
      : item('fail', `TOOL_${binary.toUpperCase()}`, `${binary} is missing from PATH`, TOOL_FIX_COMMANDS[binary]));
  }
  for (const binary of OPTIONAL_TOOLS) {
    items.push(findOnPath(binary, env)
      ? item('pass', `TOOL_${binary.toUpperCase()}`, `${binary} is on PATH`, 'No action needed.')
      : item('warn', `TOOL_${binary.toUpperCase()}`, `${binary} is missing from PATH`, TOOL_FIX_COMMANDS[binary]));
  }

  // Read-only mirror probe: declared sources only, never a network fetch.
  //
  // A missing mirror is a `fail`, not a `warn` (AC-07). The upstream mirror is
  // where the discipline skills come from, so without it the guidance bundle has
  // no upstream text to reference and the environment is not merely degraded —
  // it cannot deliver the kit's core promise. Reporting `warn` here while the
  // zone still said `pass` was exactly the dishonesty the review flagged (I5).
  const selection = await selectSuperpowersDir({}, env ?? {});
  const mirrorDir = selection.realPath;
  const mirrorReadable = await readableDir(mirrorDir);
  items.push(mirrorReadable
    ? item('pass', 'UPSTREAM_MIRROR', `upstream mirror readable at ${mirrorDir} (via ${selection.reason})`, 'No action needed.', { path: mirrorDir, via: selection.reason })
    : item('fail', 'UPSTREAM_MIRROR', `upstream mirror not readable at ${selection.dir} (via ${selection.reason})`, `git clone --depth 1 ${DEFAULT_SUPERPOWERS_REPO} ${selection.dir}`, { path: selection.dir, via: selection.reason }));

  const skillsRoot = mirrorReadable ? path.join(mirrorDir, 'skills') : null;
  let skillCount = 0;
  if (skillsRoot) {
    try {
      for (const entry of await fsp.readdir(skillsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
          await fsp.access(path.join(skillsRoot, entry.name, 'SKILL.md'));
          skillCount += 1;
        } catch { /* an incomplete skill directory is not a usable discipline skill */ }
      }
    } catch { /* unreadable skills root is diagnosed below */ }
  }
  items.push(skillCount > 0
    ? item('pass', 'DISCIPLINE_SKILLS', `${skillCount} discipline skills readable in ${skillsRoot}`, 'No action needed.', { count: skillCount, path: skillsRoot })
    : item('fail', 'DISCIPLINE_SKILLS', `discipline skills directory missing or unreadable at ${skillsRoot ?? path.join(selection.dir, 'skills')}`, `specify self upgrade && git -C ${mirrorDir ?? selection.dir} pull --ff-only`, { count: 0, path: skillsRoot ?? path.join(selection.dir, 'skills') }));

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

/**
 * Read-only view of the installed integrations recorded by the specify CLI.
 * Both on-disk spellings are supported; no other file is consulted.
 */
async function readIntegrationState({ cwd }) {
  const jsonFile = path.join(cwd, '.specify', 'integration.json');
  const jsonText = await readText(jsonFile);
  if (jsonText !== null) {
    try {
      const parsed = JSON.parse(jsonText);
      const listed = Array.isArray(parsed.installed_integrations)
        ? parsed.installed_integrations.filter((key) => typeof key === 'string' && key.length > 0)
        : [];
      const active = typeof (parsed.integration ?? parsed.default_integration) === 'string'
        ? (parsed.integration ?? parsed.default_integration)
        : null;
      if (listed.length > 0 || active) {
        const installed = [...new Set([...listed, ...(active ? [active] : [])])].sort((a, b) => a.localeCompare(b));
        return { source: jsonFile, installed, active };
      }
    } catch { /* malformed state is reported by other zones; try the YAML spelling */ }
  }

  const ymlFile = path.join(cwd, '.specify', 'integrations.yml');
  const ymlText = await readText(ymlFile);
  if (ymlText !== null) {
    const listed = [];
    let active = null;
    let inInstalled = false;
    for (const line of ymlText.split(/\r?\n/)) {
      const top = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (top) {
        inInstalled = /^(installed_integrations|installed)$/.test(top[1]);
        if (/^(integration|active_integration|default_integration)$/.test(top[1]) && top[2].trim()) {
          active = top[2].trim().replace(/^['"]|['"]$/g, '');
        }
        continue;
      }
      const entry = line.match(/^\s+-\s+([\w.-]+)\s*$/);
      if (inInstalled && entry) listed.push(entry[1]);
    }
    if (listed.length > 0 || active) {
      const installed = [...new Set([...listed, ...(active ? [active] : [])])].sort((a, b) => a.localeCompare(b));
      return { source: ymlFile, installed, active };
    }
  }
  return { source: null, installed: [], active: null };
}

function guidanceChannelFor(skill, cap) {
  const text = `${skill?.provider ?? ''} ${skill?.source ?? ''} ${skill?.path ?? ''}`.toLowerCase();
  if (/superpowers|mirror/.test(text)) return 'upstream-mirror';
  if (/plugin/.test(text)) return 'plugin';
  if (/user/.test(text)) return 'user-skills';
  return cap?.guidanceChannel ?? 'unknown';
}

async function skillVersionFromPath(skill) {
  if (typeof skill?.path !== 'string' || skill.path.length === 0) return null;
  const candidates = skill.path.endsWith('.md') ? [skill.path] : [path.join(skill.path, 'SKILL.md')];
  for (const file of candidates) {
    const text = await readText(file);
    if (!text) continue;
    const version = text.match(/^(?:version|\s{2}version):\s*['"]?([^\s'"]+)/m)?.[1];
    if (version) return version;
  }
  return null;
}

function isUserSkill(skill) {
  const source = String(skill?.source ?? '').toLowerCase();
  const provider = String(skill?.provider ?? '').toLowerCase();
  const pathText = String(skill?.path ?? '').replace(/\\/g, '/').toLowerCase();
  return provider === 'user' || /^user\b|^user[-_:]/.test(source)
    || /\/(?:\.dsh|\.claude|\.codex|\.cursor)\/skills\//.test(pathText);
}

function providerRank(provider) {
  const index = SKILL_PROVIDER_ORDER.indexOf(String(provider ?? '').toLowerCase());
  return index === -1 ? SKILL_PROVIDER_ORDER.length : index;
}

async function hostZone({ host, cwd, env, skills, trustFlags }) {
  const items = [];
  const cap = HOST_CAPABILITIES[host];
  items.push(cap
    ? item('pass', 'HOST_CAPABILITY', `host=${host} integration=${cap.integrationKey}`, 'No action needed.')
    : item('fail', 'HOST_CAPABILITY', `unknown host: ${host}`, `Use one of: ${HOST_KEYS.join(', ')}.`));
  if (cap?.guidanceChannel === 'rule-dir') {
    // The capability pattern is the single source of truth: an unknown flag is
    // harmless, a configured trust/force flag is an explicit warning. The matcher
    // is imported statically from core — no adapter specifier is built here.
    const matched = checkTrustFlags({ args: trustFlags ?? [] }, cap);
    items.push(matched.length === 0
      ? item('pass', 'CURSOR_TRUST', 'no auto-trust dispatch flags configured', 'No action needed.', { matched })
      : item('warn', 'CURSOR_TRUST', `auto-trust flags detected: ${matched.join(' ')}; use only in controlled projects`, 'Remove the flags from the dispatch configuration.', { matched }));
  }
  const visible = (skills ?? []).length;
  items.push(item('pass', 'VISIBLE_SKILLS', `${visible} visible skills provided`, 'No action needed.'));
  const guidanceSwitch = await resolveGuidanceSwitch({ cwd, env });
  items.push(item(
    guidanceSwitch.warnings.length === 0 ? 'pass' : 'warn',
    'GUIDANCE_SCOPE',
    `enabled=${guidanceSwitch.enabled} effectiveScope=${guidanceSwitch.effectiveScope} source=${guidanceSwitch.source ?? 'default'}`,
    guidanceSwitch.warnings.length === 0 ? 'No action needed.' : guidanceSwitch.warnings.join(' '),
    {
      enabled: guidanceSwitch.enabled,
      effectiveScope: guidanceSwitch.effectiveScope,
      source: guidanceSwitch.source,
    }
  ));
  const manifest = path.join(cwd, '.specify', 'extensions.yml');
  items.push(fs.existsSync(manifest)
    ? item('pass', 'EXTENSION_STATE', 'project extension manifest found', 'No action needed.')
    : item('warn', 'EXTENSION_STATE', 'project extension manifest not found', 'Run specify extension add --dev spec-kit-extension.'));

  const integrationState = await readIntegrationState({ cwd });
  items.push(integrationState.source
    ? item(
      'pass', 'INTEGRATION_STATE',
      `installed integrations: ${integrationState.installed.join(', ')}; active=${integrationState.active ?? 'none'} source=${path.basename(integrationState.source)}`,
      'No action needed.',
      { installed: integrationState.installed, active: integrationState.active, source: integrationState.source }
    )
    : item(
      'skip', 'INTEGRATION_STATE',
      'no installed-integration manifest found; per-host rendering cannot be verified',
      'Run specify init --integration <host> to record integration state.',
      { installed: [], active: null, source: null }
    ));

  // Discipline guidance channel: report the real source/version carried by the
  // visible skill entries. The kit package version is only a labelled fallback
  // when no discipline skill is visible at all.
  if (cap) {
    const evidence = (skills ?? []).find(isDisciplineSkill) ?? null;
    let channel;
    let version;
    let source;
    let versionSource;
    if (evidence) {
      channel = guidanceChannelFor(evidence, cap);
      version = (await skillVersionFromPath(evidence)) ?? 'unknown';
      versionSource = version === 'unknown' ? 'skill-version-unavailable' : 'skill-metadata';
      source = String(evidence.source ?? evidence.provider ?? evidence.path ?? 'skill-entry');
    } else {
      const pkg = await readJson(path.join(PKG_ROOT, 'package.json'));
      channel = cap.guidanceChannel;
      version = pkg?.version ?? 'unknown';
      versionSource = 'kit-package-fallback';
      source = 'kit-package-fallback';
    }
    items.push(item(
      'pass', 'GUIDANCE_CHANNEL',
      `host=${host} channel=${channel} version=${version} source=${source} versionSource=${versionSource}`,
      evidence ? 'No action needed.' : 'Install the discipline skills to report their real channel and version.',
      {
        host, channel, version, source, versionSource,
        provider: evidence?.provider ?? null,
        path: evidence?.path ?? null,
      }
    ));
  } else {
    items.push(item('skip', 'GUIDANCE_CHANNEL', `guidance channel unknown for host=${host}`, 'Pick a supported host.'));
  }

  // Hook command rendering: verify every installed integration end, not just
  // the current host. An uninstalled/inactive end must never be claimed healthy.
  const skillsDir = skillsDirFor(cwd, host);
  const rendered = skillsDir ? await installedSkillNames(skillsDir) : [];
  const renderedHooks = rendered.filter((name) => name.includes('hooks-'));
  const expectedNames = await packagedCommandSkills();
  const expected = expectedNames.length;
  if (!integrationState.source) {
    // No manifest means nothing about hook rendering is verifiable. Zero rendered
    // hook skills is therefore an unverified state, not a healthy one: claiming
    // `pass` while the message itself says `rendered=0 of 6` is the contradiction
    // review finding I4 called out. Only a host that actually rendered something
    // may pass without a manifest.
    const renderedSomething = renderedHooks.length > 0;
    items.push(item(
      renderedSomething ? 'pass' : 'warn', 'HOOK_RENDERING',
      `host=${host} rendered=${renderedHooks.length} of ${expected} hook command skills (no integration manifest)`,
      renderedSomething
        ? 'No action needed.'
        : 'No integration manifest is present, so hook rendering cannot be verified; run `specify integration switch <key>` (or install the Spec Kit extension) and re-run `sdd-kit doctor`.',
      { host, rendered: renderedHooks, renderedCount: renderedHooks.length, expected, integrations: [] }
    ));
  } else {
    const checks = [];
    for (const key of integrationState.installed) {
      const endHost = INTEGRATION_KEY_TO_HOST[key] ?? null;
      const endCap = endHost ? HOST_CAPABILITIES[endHost] : null;
      const endDir = endCap ? path.join(cwd, endCap.skillsDir) : null;
      const names = endDir ? await installedSkillNames(endDir) : [];
      const hookNames = names.filter((name) => name.includes('hooks-'));
      const missingCommands = expectedNames.filter((name) => !names.includes(name));
      const missingHooks = EXECUTION_HOOK_COMMANDS.filter((name) => !names.includes(name));
      const active = key === integrationState.active;
      const fullyRendered = missingCommands.length === 0 && missingHooks.length === 0;
      const status = fullyRendered ? 'pass' : (hookNames.length === 0 && active ? 'fail' : 'warn');
      checks.push({
        integration: key,
        host: endHost,
        active,
        skillsDir: endCap?.skillsDir ?? null,
        rendered: names,
        renderedCount: names.length,
        expected,
        hookCount: hookNames.length,
        expectedHookEvents: [...HOOK_EVENTS],
        missingCommands,
        missingHooks,
        status,
        fix: status === 'pass'
          ? 'No action needed.'
          : `specify integration switch ${key} && specify extension add --dev spec-kit-extension --force && restart ${endHost ?? key}`,
      });
    }
    checks.sort((a, b) => a.integration.localeCompare(b.integration));
    const worst = checks.some((entry) => entry.status === 'fail') ? 'fail'
      : checks.some((entry) => entry.status === 'warn') ? 'warn' : 'pass';
    const detail = checks.map((entry) => `${entry.integration}${entry.active ? '(active)' : ''}:${entry.renderedCount}/${entry.expected}`).join(', ');
    items.push(item(
      worst, 'HOOK_RENDERING',
      `host=${host} rendered=${renderedHooks.length} of ${expected} hook command skills; integrations=${detail}`,
      worst === 'pass' ? 'No action needed.' : 'Re-render missing host artifacts: specify integration switch <key> && specify extension add --dev spec-kit-extension --force.',
      { host, rendered: renderedHooks, renderedCount: renderedHooks.length, expected, integrations: checks }
    ));
  }
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

async function runtimeZone({ cwd, env, skills, now, sessionStart, runId }) {
  const items = [];
  const markers = await readMarkers({ cwd });
  const classified = classifyMarkers(markers, { now, sessionStart, runId });
  const pending = [...classified.pending].sort();
  const history = [...classified.history].sort();
  const markerFix = pending.length > 0
    ? `After the affected host reloads, run node bin/sdd-kit.mjs guidance --host <host> --cwd <repo> --clear-marker for each pending host.`
    : 'Stale leftovers can be dropped with node bin/sdd-kit.mjs guidance --host <host> --cwd <repo> --clear-marker.';
  if (pending.length > 0) {
    items.push(item(
      'warn', 'PENDING_MARKERS',
      `pending markers: ${pending.join(', ')}${history.length ? `; history from earlier runs: ${history.join(', ')}` : ''}`,
      markerFix,
      { pending, history }
    ));
  } else if (history.length > 0) {
    items.push(item(
      'warn', 'PENDING_MARKERS',
      `no pending markers; only history from earlier runs: ${history.join(', ')}`,
      markerFix,
      { pending, history }
    ));
  } else {
    items.push(item('pass', 'PENDING_MARKERS', 'no pending reload markers', 'No action needed.', { pending, history }));
  }

  const visibleSkills = (skills ?? []).filter((skill) => skill?.name);
  const inventory = visibleSkills.map((skill) => ({
    name: skill.name,
    provider: skill.provider ?? 'unknown',
    path: skill.path ?? null,
    source: skill.source ?? 'unknown',
  }));
  items.push(inventory.length > 0
    ? item(
      'pass', 'SKILL_INVENTORY',
      `visible skills: ${inventory.map((entry) => `${entry.name}(${entry.provider})`).join(', ')}`,
      'No action needed.',
      { skills: inventory }
    )
    : item('skip', 'SKILL_INVENTORY', 'no visible skills to inventory', 'Load a skill provider before running the doctor.', { skills: [] }));

  // Same-name conflicts report the winner and its deterministic provider order.
  const byName = new Map();
  visibleSkills.forEach((skill, index) => {
    const provider = skill.provider ?? 'unknown';
    if (!byName.has(skill.name)) byName.set(skill.name, []);
    byName.get(skill.name).push({ skill, provider, index, source: skill.source ?? 'unknown' });
  });
  const sortByPriority = (a, b) => providerRank(a.provider) - providerRank(b.provider) || a.index - b.index;
  const conflicts = [];
  for (const [name, entries] of [...byName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const providers = [...new Set(entries.map((entry) => entry.provider))].sort((a, b) => a.localeCompare(b));
    if (providers.length < 2) continue;
    const ordered = [...entries].sort(sortByPriority);
    const winner = ordered[0];
    conflicts.push({
      name,
      providers,
      order: ordered.map((entry) => entry.provider),
      origins: entries.map((entry) => `${entry.provider}:${entry.source}`),
      winner: {
        name,
        provider: winner.provider,
        source: winner.source,
        path: winner.skill.path ?? null,
        origin: isUserSkill(winner.skill) ? 'user' : 'bundled',
      },
    });
  }
  items.push(conflicts.length === 0
    ? item('pass', 'SKILL_CONFLICT', 'no cross-provider skill name conflicts', 'No action needed.', { conflicts: [] })
    : item(
      'warn', 'SKILL_CONFLICT',
      `conflicting skill names: ${conflicts.map((entry) => `${entry.name} (${entry.origins.join(' vs ')}; winner=${entry.winner.provider})`).join(', ')}`,
      'Disable one of the conflicting providers; user-authored skills keep precedence.',
      { conflicts }
    ));

  // User-authored skills are explicitly labelled as non-kit artifacts so they
  // are never mistaken for kit drift or silently managed by the kit.
  const userSkills = visibleSkills.filter(isUserSkill).map((skill) => ({
    name: skill.name,
    provider: skill.provider ?? 'unknown',
    source: skill.source ?? 'unknown',
    path: skill.path ?? null,
  }));
  const kitSkills = visibleSkills.filter((skill) => !isUserSkill(skill)).map((skill) => ({
    name: skill.name,
    provider: skill.provider ?? 'unknown',
    source: skill.source ?? 'unknown',
    path: skill.path ?? null,
  }));
  items.push(item(
    'pass', 'SKILL_PROVENANCE',
    userSkills.length > 0
      ? `${userSkills.length} user-authored skill(s) marked 非本套件产物: ${userSkills.map((entry) => entry.name).join(', ')}`
      : 'no user-authored skills observed',
    userSkills.length > 0 ? 'Leave user-authored skills untouched; the kit only manages its own artifacts.' : 'No action needed.',
    { userSkills, bundled: kitSkills }
  ));

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
  now,
  sessionStart,
  runId,
  deps = {},
} = {}) {
  const failZone = (error) => zone([item('fail', 'ZONE_PROBE_ERROR', error?.message ?? String(error), 'Fix the probe error and rerun the doctor.')]);
  const [environment, hostReport, repository, runtime, triggerDryRun] = await Promise.all([
    safe('environment', () => deps.environment ? deps.environment() : environmentZone({ env }), failZone),
    safe('host', () => deps.host ? deps.host() : hostZone({ host, cwd, env, skills, trustFlags }), failZone),
    safe('repository', () => deps.repository ? deps.repository() : repositoryZone({ cwd, host }), failZone),
    safe('runtime', () => deps.runtime ? deps.runtime() : runtimeZone({ cwd, env, skills, now, sessionStart, runId }), failZone),
    safe('triggerDryRun', () => deps.triggerDryRun ? deps.triggerDryRun() : triggerZone({ trigger, skills }), failZone),
  ]);
  return { environment, host: hostReport, repository, runtime, triggerDryRun };
}
