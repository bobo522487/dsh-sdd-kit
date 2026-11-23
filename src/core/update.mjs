import path from 'node:path';

import { runUpstream } from './upstream.mjs';

// 插件自身的安装与升级归 DSH 包管理器（dsh plugin add/update --latest），
// 本模块只刷新两层上游：specify CLI 与 obra/superpowers 镜像。
export const COMPONENT_NAMES = ['spec-kit', 'superpowers'];
export const OUTCOMES = ['unchanged', 'updated', 'failed'];

const RESTART_FOLLOW_UP = 'Restart DSH to load updated tools/skills';

function failureDetail(result) {
  const parts = [];
  if (result?.stderr && String(result.stderr).trim()) parts.push(String(result.stderr).trim());
  if (result?.stdout && String(result.stdout).trim()) parts.push(String(result.stdout).trim());
  if (parts.length === 0 && result?.code !== undefined) parts.push(`exit code ${result.code}`);
  return parts.join(' ');
}

function toError(error) {
  if (error instanceof Error) return error;
  return new Error(typeof error === 'string' ? error : JSON.stringify(error));
}

function failure(message, before = null) {
  const error = new Error(message);
  error.before = before;
  return error;
}

function normalizeRecord(component, record) {
  return {
    component,
    before: record.before ?? null,
    after: record.after ?? null,
    outcome: record.outcome,
    followUp: record.followUp ?? null,
    error: record.error ?? null,
  };
}

async function readStatus(upstream, args) {
  return upstream({
    action: 'status',
    cwd: args.cwd,
    superpowersDir: args.superpowersDir,
    repoUrl: args.repoUrl,
  });
}

async function updateSpecKit(upstream, args) {
  let before;
  try {
    const status = await readStatus(upstream, args);
    before = status?.specifyCli?.version ?? null;
  } catch (error) {
    throw new Error(`Unable to read Spec Kit version: ${toError(error).message}`);
  }

  const result = await upstream({ action: 'specify_upgrade', cwd: args.cwd, python: args.python });
  if (result && result.ok === false) {
    throw failure(`Spec Kit update failed: ${failureDetail(result)}`, before);
  }

  let after;
  try {
    const status = await readStatus(upstream, args);
    after = status?.specifyCli?.version ?? null;
  } catch (error) {
    throw failure(`Unable to read Spec Kit version after update: ${toError(error).message}`, before);
  }

  return {
    before,
    after,
    outcome: before === after ? 'unchanged' : 'updated',
    followUp: null,
    error: null,
  };
}

async function updateSuperpowers(upstream, args) {
  let before;
  let beforeSkillCount;
  try {
    const status = await readStatus(upstream, args);
    before = status?.superpowers?.head ?? null;
    beforeSkillCount = status?.superpowers?.skillCount ?? null;
  } catch (error) {
    throw new Error(`Unable to read Superpowers revision: ${toError(error).message}`);
  }

  const result = await upstream({
    action: 'sync_superpowers',
    cwd: args.cwd,
    superpowersDir: args.superpowersDir,
    repoUrl: args.repoUrl,
  });
  if (result && result.ok === false) {
    throw failure(`Superpowers update failed: ${failureDetail(result)}`, before);
  }

  let after;
  let afterSkillCount;
  try {
    const status = await readStatus(upstream, args);
    after = status?.superpowers?.head ?? null;
    afterSkillCount = status?.superpowers?.skillCount ?? null;
  } catch (error) {
    throw failure(`Unable to read Superpowers revision after update: ${toError(error).message}`, before);
  }

  const cloned = result?.mode === 'clone';
  const skillCountChanged =
    typeof beforeSkillCount === 'number' &&
    typeof afterSkillCount === 'number' &&
    beforeSkillCount !== afterSkillCount;
  const restartRequired = cloned || skillCountChanged;

  return {
    before,
    after,
    outcome: before === after ? 'unchanged' : 'updated',
    followUp: restartRequired ? RESTART_FOLLOW_UP : null,
    error: null,
  };
}

export async function runUpdate(args = {}, deps = {}) {
  const upstream = deps.runUpstream ?? runUpstream;
  const cwd = path.resolve(args.cwd || process.cwd());

  const resolvedArgs = {
    cwd,
    superpowersDir: args.superpowersDir,
    repoUrl: args.repoUrl,
    python: args.python,
  };

  const tasks = [
    () => updateSpecKit(upstream, resolvedArgs),
    () => updateSuperpowers(upstream, resolvedArgs),
  ];

  const settled = await Promise.allSettled(tasks.map((task) => task()));

  const components = settled.map((result, index) => {
    const component = COMPONENT_NAMES[index];
    if (result.status === 'fulfilled') return normalizeRecord(component, result.value);
    const error = toError(result.reason);
    return normalizeRecord(component, {
      before: error.before ?? null,
      after: null,
      outcome: 'failed',
      followUp: null,
      error: { message: error.message },
    });
  });

  const errors = components
    .filter((record) => record.outcome === 'failed')
    .map((record) => ({ component: record.component, message: record.error.message }));

  return {
    action: 'update',
    ok: errors.length === 0,
    components,
    requiresRestart: components.some((record) => record.followUp !== null),
    errors,
    cwd,
  };
}
