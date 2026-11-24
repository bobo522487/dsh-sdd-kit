import test from 'node:test';
import assert from 'node:assert/strict';

import { registerSddTools } from '../src/register.mjs';

function captureTools(deps = {}) {
  const registered = [];
  const ctx = {
    tools: {
      register(def) {
        registered.push(def);
        return () => {};
      },
    },
  };
  registerSddTools(ctx, (def) => def, deps);
  return registered;
}

test('sdd_upstream and sdd_bridge preserve their public input/output contract (REQ-45/AC-22)', () => {
  const tools = captureTools();
  assert.deepEqual(tools.map((t) => t.name), ['sdd_upstream', 'sdd_bridge']);

  const upstream = tools[0];
  const bridge = tools[1];
  const upstreamParams = Object.keys(upstream.parameters).sort();
  assert.deepEqual(upstreamParams, [
    'action', 'candidateDirs', 'cwd', 'extensionDir', 'integration', 'python',
    'repoUrl', 'superpowersDir', 'switchIntegration', 'upgrade', 'useSkills',
  ]);
  assert.equal(upstream.parameters.action.required, true);
  assert.match(upstream.parameters.action.description, /setup/);
  assert.match(upstream.parameters.action.description, /update_all/);

  const bridgeParams = Object.keys(bridge.parameters).sort();
  assert.deepEqual(bridgeParams, ['action', 'artifact', 'bugSlug', 'cwd', 'featureName', 'overwrite']);
  assert.equal(bridge.parameters.action.required, true);
  assert.match(bridge.parameters.action.description, /inspect/);
  assert.match(bridge.parameters.action.description, /sync_index/);

  for (const tool of tools) {
    assert.deepEqual(tool.output.schema, { type: 'json' });
    const rendered = tool.output.render({}, { ok: true, value: 1 });
    assert.equal(rendered.length, 1);
    assert.equal(rendered[0].type, 'text');
    assert.deepEqual(JSON.parse(rendered[0].text), { ok: true, value: 1 });
  }
});

test('tools remain thin delegates to the unified core action entry (REQ-14)', async () => {
  const calls = [];
  const tools = captureTools({
    runUpdate: async (args) => { calls.push(['update', args]); return { delegated: 'update' }; },
    runSetup: async (args) => { calls.push(['setup', args]); return { delegated: 'setup' }; },
  });
  const setupResult = await tools[0].execute({ action: 'setup', cwd: '/tmp/x' });
  assert.deepEqual(setupResult, { delegated: 'setup' });
  assert.equal(calls[0][0], 'setup');
});
