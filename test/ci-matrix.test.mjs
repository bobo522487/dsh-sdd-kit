import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('CI matrix covers three upstream and two host dimensions (REQ-40)', async () => {
  const workflow = await fs.readFile(path.join(PKG_ROOT, '.github', 'workflows', 'upstream-integration.yml'), 'utf8');
  assert.match(workflow, /upstream:\s*\[[^\]]*latest[^\]]*pinned-spec-kit[^\]]*pinned-mirror[^\]]*\]/);
  assert.match(workflow, /host:\s*\[[^\]]*dsh[^\]]*claude[^\]]*\]/);
  assert.match(workflow, /install[\s\S]*init[\s\S]*doctor/);
  assert.match(workflow, /matrix\.upstream/);
  assert.match(workflow, /matrix\.host/);
});

test('CI never treats not_executed as success (REQ-42)', async () => {
  const workflow = await fs.readFile(path.join(PKG_ROOT, '.github', 'workflows', 'upstream-integration.yml'), 'utf8');
  assert.match(workflow, /status !== 'passed'/);
  assert.match(workflow, /not_executed/);
});

test('verify-upstream checks the expanded six-hook contract (REQ-22)', async () => {
  const source = await fs.readFile(path.join(PKG_ROOT, 'scripts', 'verify-upstream.mjs'), 'utf8');
  assert.match(source, /'before_clarify'/);
  assert.match(source, /'before_plan'/);
  assert.match(source, /session_start/);
  assert.doesNotMatch(source, /hookCount === 4/);
});
