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

import { runAction, unknownActionError } from '../src/core/action.mjs';
import { formatGuidanceText } from '../src/core/guidance.mjs';

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
  // Cursor auto-trust dispatch flags. Values often start with `-`, so the
  // equal-sign form (`--trust-flags=--trust,--force`) is the documented usage.
  'trust-flags': { type: 'string', multiple: true },
});

/** camelCase keys that need an explicit rename onto the core parameter names. */
const RENAMES = Object.freeze({
  'superpowers-dir': 'superpowersDir',
  'extension-dir': 'extensionDir',
  'switch-integration': 'switchIntegration',
  'use-skills': 'useSkills',
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
  delete params.json;
  delete params.text;
  return { command, params };
}

async function main() {
  const argv = process.argv.slice(2);
  const asText = argv.includes('--text');
  const { command, params } = parse(argv);
  const result = SUBCOMMANDS.includes(command)
    ? await runAction(command, params)
    : unknownActionError(command);
  if (asText && command === 'guidance' && result && result.status !== 'error') {
    process.stdout.write(`${formatGuidanceText(result)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result && result.status === 'error') process.exitCode = 1;
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
