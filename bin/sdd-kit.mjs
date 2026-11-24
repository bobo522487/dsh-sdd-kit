#!/usr/bin/env node
/**
 * Host-neutral CLI for dsh-sdd-kit. Zero third-party dependencies.
 * Every subcommand delegates to src/core/action.mjs; no logic is duplicated here.
 */

import { parseArgs } from 'node:util';

import { runAction, unknownActionError } from '../src/core/action.mjs';

const SUBCOMMANDS = ['update', 'bridge', 'doctor', 'guard', 'guidance'];

function parse(argv) {
  const parsed = parseArgs({
    args: argv,
    options: {
      json: { type: 'boolean', default: false },
      trigger: { type: 'string' },
      cwd: { type: 'string' },
      integration: { type: 'string' },
      host: { type: 'string' },
      featureName: { type: 'string' },
      bugSlug: { type: 'string' },
      artifact: { type: 'string' },
      overwrite: { type: 'boolean' },
      upgrade: { type: 'boolean' },
      'switch-integration': { type: 'boolean' },
      python: { type: 'string' },
      'superpowers-dir': { type: 'string' },
      repoUrl: { type: 'string' },
      'extension-dir': { type: 'string' },
    },
    allowPositionals: true,
    strict: false,
  });
  const command = parsed.positionals[0] ?? '';
  const params = {
    ...parsed.values,
    ...(parsed.values.cwd ? {} : { cwd: process.cwd() }),
  };
  if (parsed.values.trigger !== undefined) params.trigger = parsed.values.trigger;
  if (parsed.values.integration !== undefined) params.integration = parsed.values.integration;
  if (parsed.values.host !== undefined) params.host = parsed.values.host;
  if (parsed.values.featureName !== undefined) params.featureName = parsed.values.featureName;
  if (parsed.values.bugSlug !== undefined) params.bugSlug = parsed.values.bugSlug;
  if (parsed.values.artifact !== undefined) params.artifact = parsed.values.artifact;
  if (parsed.values.python !== undefined) params.python = parsed.values.python;
  if (parsed.values.repoUrl !== undefined) params.repoUrl = parsed.values.repoUrl;
  if (parsed.values['superpowers-dir'] !== undefined) params.superpowersDir = parsed.values['superpowers-dir'];
  if (parsed.values['extension-dir'] !== undefined) params.extensionDir = parsed.values['extension-dir'];
  if (parsed.values.upgrade !== undefined) params.upgrade = parsed.values.upgrade;
  if (parsed.values.overwrite !== undefined) params.overwrite = parsed.values.overwrite;
  if (parsed.values['switch-integration'] !== undefined) params.switchIntegration = parsed.values['switch-integration'];
  delete params.json;
  delete params['switch-integration'];
  delete params['superpowers-dir'];
  delete params['extension-dir'];
  return { command, params };
}

async function main() {
  const { command, params } = parse(process.argv.slice(2));
  const result = SUBCOMMANDS.includes(command)
    ? await runAction(command, params)
    : unknownActionError(command);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result && result.status === 'error') process.exitCode = 1;
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    status: 'error',
    code: error?.code ?? 'E_CLI',
    message: error?.message ?? String(error),
    fix: 'Check the command arguments and retry.',
  }, null, 2)}\n`);
  process.exitCode = 1;
});
