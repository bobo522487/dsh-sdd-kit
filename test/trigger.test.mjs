import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreSkills } from '../src/core/trigger.mjs';

function skill(name, overrides = {}) {
  return {
    name,
    description: overrides.description ?? 'general helper',
    whenToUse: overrides.whenToUse ?? '',
    source: overrides.source ?? 'bundled',
    provider: overrides.provider ?? 'plugin',
    path: overrides.path ?? `/skills/${name}`,
    invocation: overrides.invocation ?? { userInvocable: true, modelInvocable: true },
  };
}

test('trigger scores deterministically by token overlap with name weighted twice (REQ-38)', () => {
  const skills = [
    skill('systematic-debugging', { description: 'use when debug a failing test' }),
    skill('test-driven-development', { description: 'write failing tests before committing code changes' }),
    skill('writing-plans', { description: 'prepare an implementation plan' }),
  ];
  const first = scoreSkills('debug failing test', skills);
  const second = scoreSkills('debug failing test', [...skills].reverse());
  assert.deepEqual(first, second, 'input order must not affect the result');
  assert.equal(first[0].skill.name, 'systematic-debugging');
  assert.ok(first[0].score > first[1].score);
  assert.deepEqual(first[0].matchedTerms, ['debug', 'failing', 'test']);
});

test('ties resolve by name then provider, and zero-score skills stay listed (REQ-38/AC-19)', () => {
  const list = [
    skill('zeta', { provider: 'a', description: 'unrelated' }),
    skill('alpha', { provider: 'b', description: 'unrelated' }),
    skill('alpha', { provider: 'a', description: 'unrelated' }),
  ];
  const scored = scoreSkills('totally different words', list);
  const zero = scored.filter((item) => item.score === 0).map((item) => [item.skill.name, item.skill.provider]);
  assert.deepEqual(zero, [['alpha', 'a'], ['alpha', 'b'], ['zeta', 'a']]);
  assert.equal(scored.length, 3, 'every visible skill must be listed');
});

test('non-user-invocable skills are excluded but counted (REQ-38)', () => {
  const skills = [
    skill('debug', { description: 'debugging helper' }),
    skill('internal', { description: 'debugging helper', invocation: { userInvocable: false, modelInvocable: true } }),
  ];
  const scored = scoreSkills('debugging', skills);
  const internal = scored.find((item) => item.skill.name === 'internal');
  assert.equal(internal.excluded, 'not_user_invocable');
  assert.equal(scored.filter((item) => !item.excluded).length, 1);
});

test('CJK tasks are tokenised into whole segments plus bigrams (REQ-38)', () => {
  const skills = [skill('中文技能', { description: '修复登录崩溃', whenToUse: '调试登录问题' })];
  const scored = scoreSkills('修复登录崩溃', skills);
  assert.ok(scored[0].score > 0);
  assert.ok(scored[0].matchedTerms.includes('登录'));
});

test('100 visible skills are scored within one second without executing them (REQ-38/AC-19)', () => {
  const skills = Array.from({ length: 100 }, (_, i) => skill(`skill-${i}`, { description: 'shared token payload' }));
  const started = process.hrtime.bigint();
  const scored = scoreSkills('shared token payload', skills);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(scored.length, 100);
  assert.ok(elapsedMs <= 1000, `scoring took ${elapsedMs.toFixed(1)}ms`);
});
