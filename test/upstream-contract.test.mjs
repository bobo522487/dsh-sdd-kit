import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyUpstream } from '../scripts/verify-upstream.mjs';

// REQ-17/REQ-18: this file is the only place allowed to talk to the real
// upstream toolchain, and it stays off unless someone opts in explicitly.
// `npm test` only runs test/sdd-kit.test.mjs, so it never reaches this file.
const GATE = ['DSH', 'SDD', 'KIT', 'INTEGRATION'].join('_');
const enabled = process.env[GATE] === '1';

test('real upstream contract', { skip: enabled ? false : `set ${GATE}=1 to run the real upstream verification` }, async () => {
  const report = await verifyUpstream({ json: true });
  assert.notEqual(report.status, 'failed', JSON.stringify(report, null, 2));
  if (report.status === 'not_executed') {
    assert.equal(typeof report.reason, 'string');
    assert.ok(report.reason.length > 0, 'not_executed must explain why');
  } else {
    assert.deepEqual(
      report.checks.map((check) => check.id).sort(),
      ['extension-add-args', 'hooks-registered', 'init-args', 'manifest-contract']
    );
    assert.ok(report.checks.every((check) => check.ok === true));
  }
});
