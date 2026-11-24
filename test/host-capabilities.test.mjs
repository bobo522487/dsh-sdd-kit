import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOST_CAPABILITIES } from '../src/core/host-capabilities.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOSTS = ['dsh', 'claude', 'codex', 'cursor'];
const RELOAD_VALUES = ['restart_host', 'new_session', 'none'];

test('HOST_CAPABILITIES covers exactly four hosts with required fields', () => {
  assert.deepEqual(Object.keys(HOST_CAPABILITIES).sort(), [...HOSTS].sort());
  for (const host of HOSTS) {
    const cap = HOST_CAPABILITIES[host];
    for (const field of [
      'key', 'integrationKey', 'toolPrefix', 'skillsDir',
      'guidanceChannel', 'guidanceConfig', 'reloadPolicy', 'trustFlagPattern',
    ]) {
      assert.ok(Object.hasOwn(cap, field), `${host} missing ${field}`);
    }
    assert.equal(cap.key, host);
  }
  assert.ok(Object.isFrozen(HOST_CAPABILITIES), 'capabilities table must be frozen');
});

test('reloadPolicy values are limited to the three declared states (AC-04)', () => {
  for (const host of HOSTS) {
    const policy = HOST_CAPABILITIES[host].reloadPolicy;
    assert.deepEqual(Object.keys(policy).sort(), ['extension_command', 'skill_data', 'tool_code']);
    for (const layer of Object.keys(policy)) {
      assert.ok(RELOAD_VALUES.includes(policy[layer]), `${host}.${layer}=${policy[layer]}`);
    }
  }
});

test('skillsDir values are unique and adapter implementations stay ≤100 lines (REQ-07/AC-02)', async () => {
  const dirs = HOSTS.map((h) => HOST_CAPABILITIES[h].skillsDir);
  assert.equal(new Set(dirs).size, dirs.length, 'skillsDir must be unique per host');
  for (const host of HOSTS) {
    const file = path.join(PKG_ROOT, 'src', 'adapters', host, 'index.mjs');
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) continue; // adapter not written yet; its own test covers its arrival
    const lines = (await fs.readFile(file, 'utf8')).split('\n').length;
    assert.ok(lines <= 100, `${host} adapter has ${lines} lines (>100)`);
  }
});
