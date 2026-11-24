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

test('a misspelled option is rejected with the four-field error contract (AC-03)', () => {
  const cli = invokeCli(['guidance', '--jsn']);
  assert.notEqual(cli.status, 0);
  assert.deepEqual(Object.keys(cli.stdout).sort(), ['code', 'fix', 'message', 'status']);
  assert.equal(cli.stdout.status, 'error');
  assert.match(cli.stdout.message, /--jsn/);
  assert.match(cli.stdout.fix, /--json/);
});

test('a misspelled option never falls through to a silent success (AC-03)', () => {
  const cli = invokeCli(['doctor', '--triger', 'x']);
  assert.notEqual(cli.status, 0);
  assert.equal(cli.stdout.status, 'error');
});

test('a valid subcommand with an unknown option refuses to run (AC-03)', () => {
  const cli = invokeCli(['guidance', '--nope']);
  assert.notEqual(cli.status, 0);
  assert.deepEqual(Object.keys(cli.stdout).sort(), ['code', 'fix', 'message', 'status']);
  assert.match(cli.stdout.message, /--nope/);
});

test('doctor receives --trust-flags as an array, empty when omitted (REQ-20/AC-11)', () => {
  const withFlags = invokeCli(['doctor', '--json', '--host', 'cursor', '--trust-flags=--trust --force']);
  assert.equal(withFlags.status, 0);
  const cursorTrust = withFlags.stdout.host.items.find((entry) => entry.code === 'CURSOR_TRUST');
  assert.ok(cursorTrust, 'doctor host zone must report the trust-flag posture');
  assert.equal(cursorTrust.status, 'warn');
  assert.match(cursorTrust.message, /--trust/);

  const withoutFlags = invokeCli(['doctor', '--json', '--host', 'cursor']);
  assert.equal(withoutFlags.status, 0);
  const quiet = withoutFlags.stdout.host.items.find((entry) => entry.code === 'CURSOR_TRUST');
  assert.equal(quiet.status, 'pass');
});

test('--trust-flags also accepts a comma separated list (AC-11)', () => {
  const cli = invokeCli(['doctor', '--json', '--host', 'cursor', '--trust-flags=--trust,--force']);
  assert.equal(cli.status, 0);
  const cursorTrust = cli.stdout.host.items.find((entry) => entry.code === 'CURSOR_TRUST');
  assert.equal(cursorTrust.status, 'warn');
  assert.match(cursorTrust.message, /--trust/);
  assert.match(cursorTrust.message, /--force/);
});
