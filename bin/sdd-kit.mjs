#!/usr/bin/env node
/**
 * Host-neutral CLI for dsh-sdd-kit. Zero third-party dependencies.
 * Every subcommand delegates to src/core/action.mjs; no logic is duplicated here.
 *
 * Parsing is strict on purpose: a misspelled option used to be swallowed by
 * `strict: false`, which silently ran a different command than the user asked
 * for. Unknown options now fail with the same four-field error contract the
 * rest of the system uses (REQ-39/AC-03).
 */

import { parseArgs } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runAction, unknownActionError } from '../src/core/action.mjs';
import { HOST_CAPABILITIES } from '../src/core/host-capabilities.mjs';
import { formatGuidanceText } from '../src/core/guidance.mjs';
import { clearHostMarker as clearHostMarkerCore, markerPath } from '../src/core/marker.mjs';

/**
 * Text-channel rendering for a disabled guidance switch (T067). The discipline
 * payload is withheld on purpose; only the switch state and its origin remain so
 * an operator can see why nothing was injected and where to flip it back.
 * @param {{effectiveScope?: string, source?: string|null, warnings?: string[]}} bundle
 */
export function formatGuidanceDisabledText(bundle) {
  const scope = bundle?.effectiveScope ?? 'default';
  const origin = bundle?.source ? ` (${bundle.source})` : '';
  return `guidance disabled: 引导已停用（scope=${scope}${origin}）。未注入任何纪律正文；如需恢复，把该文件中的 guidance.enabled 设为 true。`;
}

const SUBCOMMANDS = ['update', 'bridge', 'doctor', 'guard', 'guidance'];

/** Single source of truth for the accepted flags, shared by parsing and help. */
const OPTIONS = Object.freeze({
  json: { type: 'boolean', default: false },
  text: { type: 'boolean', default: false },
  trigger: { type: 'string' },
  cwd: { type: 'string' },
  action: { type: 'string' },
  integration: { type: 'string' },
  host: { type: 'string' },
  featureName: { type: 'string' },
  bugSlug: { type: 'string' },
  artifact: { type: 'string' },
  overwrite: { type: 'boolean' },
  upgrade: { type: 'boolean' },
  'switch-integration': { type: 'boolean' },
  'use-skills': { type: 'boolean' },
  python: { type: 'string' },
  'superpowers-dir': { type: 'string' },
  repoUrl: { type: 'string' },
  'extension-dir': { type: 'string' },
  // Update inputs owned by T083: an extension/command change list and an
  // explicit request to reinstall the extension during the update (I6).
  'extension-changes': { type: 'string' },
  'reinstall-extension': { type: 'boolean', default: false },
  // Cursor auto-trust dispatch flags. Values often start with `-`, so the
  // equal-sign form (`--trust-flags=--trust,--force`) is the documented usage.
  'trust-flags': { type: 'string', multiple: true },
  // Maintenance escape hatch (T081): drop one host's pending-change marker
  // without touching the other hosts sharing the same repository file.
  'clear-marker': { type: 'boolean', default: false },
});

/** camelCase keys that need an explicit rename onto the core parameter names. */
const RENAMES = Object.freeze({
  'superpowers-dir': 'superpowersDir',
  'extension-dir': 'extensionDir',
  'switch-integration': 'switchIntegration',
  'use-skills': 'useSkills',
  'reinstall-extension': 'reinstallExtension',
  'clear-marker': 'clearMarker',
});

function cliError(code, message, fix) {
  const error = new Error(message);
  error.code = code;
  error.fix = fix;
  return error;
}

/** Levenshtein distance, small enough to inline and dependency free. */
function distance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, index) => index);
  for (let i = 1; i < rows; i += 1) {
    const current = [i];
    for (let j = 1; j < cols; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[cols - 1];
}

/** Nearest accepted flag, so the error tells the user what to type instead. */
function suggestOption(name) {
  const candidate = String(name ?? '').replace(/^--?/, '');
  let best = null;
  for (const option of Object.keys(OPTIONS)) {
    const score = distance(candidate, option);
    if (!best || score < best.score) best = { option, score };
  }
  return best && best.score <= Math.max(2, Math.floor(candidate.length / 3)) ? `--${best.option}` : null;
}

function optionError(error) {
  const raw = String(error?.message ?? error);
  const unknown = /Unknown option '([^']+)'/.exec(raw) ?? /option '([^']+)' is ambiguous/.exec(raw);
  if (unknown) {
    const name = unknown[1];
    const suggestion = suggestOption(name);
    return cliError(
      'E_UNKNOWN_OPTION',
      `Unknown option '${name}'.`,
      `${suggestion ? `Did you mean ${suggestion}? ` : ''}Use one of: ${Object.keys(OPTIONS).map((key) => `--${key}`).join(', ')}.`
    );
  }
  return cliError(
    'E_INVALID_OPTION',
    raw,
    'Check the option values; pass values that start with "-" using the equal-sign form (--trust-flags=--trust,--force).'
  );
}

/**
 * `--trust-flags` accepts space or comma separated values inside one argument:
 * `--trust-flags=--trust,--force` or `--trust-flags="--trust --force"`.
 */
function parseTrustFlags(value) {
  if (value === undefined) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw.flatMap((entry) => String(entry).split(/[\s,]+/)).filter(Boolean);
}

/**
 * `--extension-changes=extension,commands` is the CLI form of the T083
 * extension_command records. Each named command becomes an `updated`
 * component so runUpdate/changedLayers can see the extension layer (I6).
 */
function parseExtensionChanges(value) {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .flatMap((entry) => String(entry).split(/[\s,]+/))
    .filter(Boolean)
    .map((name) => ({
      component: 'extension_command',
      before: null,
      after: name,
      outcome: 'updated',
    }));
}

function parse(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw optionError(error);
  }

  const command = parsed.positionals[0] ?? '';
  const params = {
    ...parsed.values,
    ...(parsed.values.cwd ? {} : { cwd: process.cwd() }),
  };

  for (const [flag, key] of Object.entries(RENAMES)) {
    if (parsed.values[flag] !== undefined) params[key] = parsed.values[flag];
    delete params[flag];
  }

  params.trustFlags = parseTrustFlags(parsed.values['trust-flags']);
  delete params['trust-flags'];
  const extensionChanges = parseExtensionChanges(parsed.values['extension-changes']);
  if (extensionChanges !== undefined) params.extensionChanges = extensionChanges;
  delete params['extension-changes'];
  delete params.json;
  delete params.text;
  return { command, params };
}

/**
 * CLI fallback for `ctx.skills.list()`: read SKILL.md frontmatter from the
 * host/project skill dir, the user-level DSH dir, and (as a last resort) a
 * packaged `skills/` dir. Pure filesystem reads; no skill is ever executed.
 * The returned shape is the core `SkillSummary` used by runDoctor.
 */
async function readSkillSummary(file, { source, provider }) {
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  if (text === null) return null;
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const field = (key) => {
    const match = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(frontmatter);
    return match?.[1].trim().replace(/^["']|["']$/g, '') ?? '';
  };
  const name = field('name') || path.basename(path.dirname(file));
  return {
    name,
    description: field('description'),
    whenToUse: field('whenToUse') || field('when_to_use'),
    source: field('source') || source,
    provider: field('provider') || provider,
    path: file,
    invocation: {
      userInvocable: !/^user-invocable:[ \t]*false\s*$/m.test(frontmatter),
      modelInvocable: !/^disable-model-invocation:[ \t]*true\s*$/m.test(frontmatter),
    },
  };
}

async function scanSkillDir(directory, meta, found) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(directory, entry.name, 'SKILL.md');
    try {
      await fs.access(file);
    } catch {
      continue;
    }
    const summary = await readSkillSummary(file, meta);
    if (summary && !found.some((item) => item.path === summary.path)) found.push(summary);
  }
}

export async function collectSkillSummaries({ cwd = process.cwd(), host = 'dsh' } = {}) {
  const capability = HOST_CAPABILITIES[host] ?? HOST_CAPABILITIES.dsh;
  const found = [];
  await scanSkillDir(path.join(cwd, capability.skillsDir), { source: 'host', provider: capability.key }, found);
  await scanSkillDir(path.join(os.homedir(), '.dsh', 'skills'), { source: 'user', provider: capability.key }, found);
  if (found.length === 0) {
    await scanSkillDir(path.join(cwd, 'skills'), { source: 'bundled', provider: capability.key }, found);
  }
  return found;
}

/**
 * Per-subcommand option allowlists. `parseArgs` accepts the union of all flags,
 * so without this table `doctor --upgrade` would parse cleanly and then silently
 * ignore the flag — the exact silent no-op AC-03 forbids (T088). Anything that
 * is parsed but not reachable for the chosen subcommand is rejected loudly.
 */
const ALLOWED = Object.freeze({
  update: ['json', 'cwd', 'host', 'python', 'superpowers-dir', 'repoUrl', 'extension-changes', 'reinstall-extension'],
  bridge: ['json', 'cwd', 'action', 'featureName', 'bugSlug', 'artifact', 'overwrite'],
  doctor: ['json', 'cwd', 'host', 'trigger', 'trust-flags', 'clear-marker'],
  guard: ['json', 'cwd'],
  guidance: ['json', 'text', 'cwd', 'host', 'clear-marker'],
});

/** Flags that only exist for subcommands outside the CLI's reachable set. */
const CORE_ONLY = Object.freeze({
  'switch-integration': 'the setup action',
  'use-skills': 'the setup action',
  'extension-dir': 'the setup action',
  upgrade: 'the setup action',
  integration: 'the setup action',
});

function providedFlags(argv) {
  const flags = new Set();
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    flags.add(arg.slice(2).split('=')[0]);
  }
  return flags;
}

function rejectUnreachableOptions(command, argv) {
  const allowed = ALLOWED[command];
  if (!allowed) return;
  for (const flag of providedFlags(argv)) {
    if (allowed.includes(flag)) continue;
    const owner = CORE_ONLY[flag] ? ` Only ${CORE_ONLY[flag]} uses it.` : '';
    throw cliError(
      'E_UNSUPPORTED_OPTION',
      `Option '--${flag}' is not supported by '${command}'.${owner}`,
      `'${command}' accepts: ${allowed.map((key) => `--${key}`).join(', ')}.`
    );
  }
}

/**
 * `--clear-marker` (T081): remove exactly one host's pending-change entry.
 * The marker file is shared by every host in one repository, so the host must be
 * named explicitly and validated — an unknown host is refused rather than
 * silently clearing nothing. An absent marker is never created by a clear.
 * The validation and the clear itself live in `src/core/marker.mjs`; this
 * wrapper only adds the CLI's structured error contract (M3).
 * @param {{cwd?: string, host?: string}} params
 */
async function clearHostMarker({ cwd = process.cwd(), host = 'dsh' } = {}) {
  let cleared;
  try {
    cleared = await clearHostMarkerCore({ cwd, host });
  } catch (error) {
    throw cliError(
      'E_UNKNOWN_HOST',
      error?.message ?? `Unknown host '${host}'.`,
      `Use one of: ${Object.keys(HOST_CAPABILITIES).join(', ')}.`
    );
  }
  return { status: 'ok', action: 'clear_marker', host, cleared, path: markerPath(cwd) };
}

/**
 * Text-channel rendering for `--clear-marker` (C4). This result is not a
 * guidance bundle: it carries no sddPointer/toolMapping, so it must be
 * rendered here instead of being handed to formatGuidanceText().
 * @param {{host?: string, cleared?: boolean, path?: string}} result
 */
export function formatClearMarkerText(result) {
  const host = result?.host ?? 'unknown';
  if (result?.cleared) {
    return `已清除 ${host} 的待生效标记（${result.path ?? 'marker'}）。`;
  }
  return `没有待生效标记需要清除：${host} 未登记任何待生效变更（${result?.path ?? 'marker'}）。`;
}

async function main() {
  const argv = process.argv.slice(2);
  const asText = argv.includes('--text');
  const { command, params } = parse(argv);
  rejectUnreachableOptions(command, argv);
  let result;
  if (params.clearMarker && SUBCOMMANDS.includes(command) && command !== 'doctor') {
    result = await clearHostMarker({ cwd: params.cwd, host: params.host });
  } else if (SUBCOMMANDS.includes(command)) {
    result = await runAction(
      command,
      command === 'doctor' && typeof params.trigger === 'string' && params.trigger.length > 0
        ? { ...params, skills: await collectSkillSummaries({ cwd: params.cwd, host: params.host }) }
        : params
    );
    // A doctor exam must never swallow `--clear-marker`; the clearing outcome
    // is attached to the full five-zone report (final review I3).
    if (command === 'doctor' && params.clearMarker) {
      result = { ...result, clearMarker: await clearHostMarker({ cwd: params.cwd, host: params.host }) };
    }
  } else {
    result = unknownActionError(command);
  }
  if (asText && command === 'guidance' && result && result.status !== 'error') {
    // A cleared marker is its own result shape (C4): render it directly, before
    // the bundle path below can mistake it for guidance content.
    if (result.action === 'clear_marker') {
      process.stdout.write(`${formatClearMarkerText(result)}\n`);
      return;
    }
    // The switch is authoritative for the text channel (T067): a disabled
    // guidance bundle must never leak the discipline text into a session.
    // The JSON path still carries enabled/effectiveScope/source for diagnosis.
    if (result.enabled === false) {
      process.stdout.write(`${formatGuidanceDisabledText(result)}\n`);
      return;
    }
    process.stdout.write(`${formatGuidanceText(result)}\n`);
    return;
  }
  // I7: a failure must never look like a success to a script. Three shapes
  // exist: the four-field error contract (status:'error'), a bridge/tool result
  // that only sets `ok:false`, and results that carry a bare `error`. All of
  // them exit non-zero.
  if (result?.status === 'error' || result?.ok === false || result?.error) process.exitCode = 1;
  // A failed bridge result keeps its documented `{ok,action,error:{code,message,hint}}`
  // shape for tool callers, but the CLI contract is the four-field envelope.
  if (command === 'bridge' && (result?.status === 'error' || result?.ok === false)) {
    const failure = typeof result.error === 'object' ? result.error : { message: String(result.error ?? '') };
    process.stdout.write(`${JSON.stringify({
      status: 'error',
      code: failure.code ?? 'E_CLI',
      message: failure.message ?? String(result.error),
      fix: failure.hint ?? failure.fix ?? 'Check the bridge action and retry.',
    }, null, 2)}\n`);
    return;
  }
  // A red zone is an exam failure even though the report itself is valid JSON.
  if (command === 'doctor' && result?.action !== 'clear_marker'
    && Object.values(result ?? {}).some((zone) => zone && typeof zone === 'object' && zone.status === 'fail')) {
    process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    status: 'error',
    code: error?.code ?? 'E_CLI',
    message: error?.message ?? String(error),
    fix: error?.fix ?? 'Check the command arguments and retry.',
  }, null, 2)}\n`);
  process.exitCode = 1;
});
