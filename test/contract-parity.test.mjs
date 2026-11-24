import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAction } from '../src/core/action.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PKG_ROOT, 'bin', 'sdd-kit.mjs');

/** Structural shape: sorted keys + value types, ignoring exact strings. */
function shape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.map(shape);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])]));
  }
  return typeof value;
}

function invokeCli(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: PKG_ROOT,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.error, undefined, `CLI spawn failed: ${result.error?.message}`);
  let stdout;
  try {
    stdout = JSON.parse(result.stdout);
  } catch {
    assert.fail(`CLI stdout is not JSON: ${result.stdout.slice(0, 400)}`);
  }
  return { stdout, status: result.status };
}

test('core entry and CLI entry produce structurally identical JSON for the same action (REQ-05/14/AC-03)', async () => {
  const params = { cwd: PKG_ROOT };
  const coreResult = await runAction('guidance', params);
  const cli = invokeCli(['guidance', '--json']);
  assert.deepEqual(shape(cli.stdout), shape(coreResult));
});

test('unimplemented CLI subcommand uses the four-field error contract and non-zero exit (AC-03)', () => {
  const cli = invokeCli(['definitely-not-an-action', '--json']);
  assert.notEqual(cli.status, 0);
  assert.deepEqual(Object.keys(cli.stdout).sort(), ['code', 'fix', 'message', 'status']);
  assert.equal(cli.stdout.status, 'error');
});
