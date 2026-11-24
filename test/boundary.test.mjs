import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runDoctor } from '../src/core/doctor.mjs';
import { runAction } from '../src/core/action.mjs';

const PKG_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

test('a user-authored skill stays byte-identical after setup and doctor (REQ-03/REQ-39)', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-boundary-'));
  const skillDir = path.join(repo, '.claude', 'skills', 'my-private-skill');
  await fs.mkdir(skillDir, { recursive: true });
  const original = '---\nname: my-private-skill\ndescription: user owns this\n---\nDo not touch.\n';
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), original, 'utf8');
  await fs.mkdir(path.join(repo, '.specify'), { recursive: true });
  await fs.writeFile(path.join(repo, '.specify', 'feature.json'), JSON.stringify({ feature_directory: 'specs/004-multihost-runtime-governance' }), 'utf8');

  const report = await runDoctor({
    cwd: repo,
    host: 'claude',
    skills: [{
      name: 'my-private-skill', description: 'user owns this', whenToUse: '', source: 'user-dsh',
      provider: 'user', path: path.join(skillDir, 'SKILL.md'), invocation: { userInvocable: true },
    }],
  });
  assert.equal(await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8'), original);
  const runtimeCodes = report.runtime.items.map((entry) => entry.code);
  assert.ok(runtimeCodes.includes('SKILL_CONFLICT'), 'doctor must report skill mount information');
  assert.ok(!runtimeCodes.some((code) => code.includes('DRIFT')), 'user skill must not be flagged as a managed artifact');
});

test('the core carries no copy of upstream logic or host registration code (REQ-01)', async () => {
  const files = (await fs.readdir(path.join(PKG_ROOT, 'src', 'core'))).filter((name) => name.endsWith('.mjs'));
  for (const name of files) {
    const source = await fs.readFile(path.join(PKG_ROOT, 'src', 'core', name), 'utf8');
    assert.doesNotMatch(source, /from ['"]@deepseek-ai\//, `${name} must not import host packages`);
    assert.doesNotMatch(source, /\bctx\./, `${name} must not use a host context`);
  }
  const action = await fs.readFile(path.join(PKG_ROOT, 'src', 'core', 'action.mjs'), 'utf8');
  assert.match(action, /runAction/);
});

test('the doctor action remains read-only for arbitrary repository roots (REQ-39)', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-boundary-ro-'));
  const before = await fs.readdir(repo);
  const report = await runAction('doctor', { cwd: repo });
  assert.deepEqual(Object.keys(report), ['environment', 'host', 'repository', 'runtime', 'triggerDryRun']);
  assert.deepEqual(await fs.readdir(repo), before);
});

test('the package root resolves through fileURLToPath, not the raw URL pathname (REQ-01)', async () => {
  // A URL pathname keeps percent-encoding; on Windows it also keeps a leading
  // slash before the drive letter. fileURLToPath is the only portable form.
  const url = new URL('..', import.meta.url);
  assert.equal(PKG_ROOT, path.resolve(fileURLToPath(url)));
  assert.equal(PKG_ROOT, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));

  const awkward = path.join(os.tmpdir(), 'dsh sdd kit %20 root');
  assert.equal(fileURLToPath(pathToFileURL(awkward).href), awkward);
});
