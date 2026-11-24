import path from 'node:path';

import { runUpstream } from './upstream.mjs';
import { HOST_CAPABILITIES, HOST_KEYS } from './host-capabilities.mjs';

// 插件自身的安装与升级归 DSH 包管理器（dsh plugin add/update --latest），
// 本模块只刷新两层上游：specify CLI 与 obra/superpowers 镜像。
export const COMPONENT_NAMES = ['spec-kit', 'superpowers'];
export const OUTCOMES = ['unchanged', 'updated', 'failed'];

const DEFAULT_HOST = HOST_KEYS[0];

/**
 * Build the reload follow-up from the host capability table. The update action
 * refreshes tool code, so its guidance follows the `tool_code` policy: a host
 * that restarts asks for a restart, every other host asks for a new session.
 * No whole sentence is hard-coded for a particular host.
 */
export function reloadFollowUp({ host = DEFAULT_HOST, layer = 'tool_code' } = {}) {
  const cap = HOST_CAPABILITIES[host] ?? HOST_CAPABILITIES[DEFAULT_HOST];
  const policy = cap.reloadPolicy[layer] ?? cap.reloadPolicy.tool_code;
  const label = String(cap.key ?? host).toUpperCase();
  if (policy === 'restart_host') return `Restart ${label} to load updated tools/skills`;
  if (policy === 'new_session') return `Open a new ${label} session to load updated tools/skills`;
  return null;
}

/**
 * Extension/command changes are part of the update report even though their
 * upstream action is owned by the host integration. They only appear when the
 * caller reports a change, so an ordinary two-component update is unchanged.
 */
function extensionRecords(args) {
  const records = Array.isArray(args.extensionChanges) ? [...args.extensionChanges] : [];
  for (const key of ['extension', 'commands', 'extensionCommands']) {
    const value = args[key];
    if (!value) continue;
    const changed = value === true || value.changed === true
      || (typeof value.outcome === 'string' && value.outcome !== 'unchanged');
    if (changed) records.push(typeof value === 'object' ? value : {});
  }
  return records.map((record) => ({
    component: 'extension_command',
    before: record.before ?? null,
    after: record.after ?? null,
    outcome: record.outcome ?? 'updated',
    followUp: record.followUp ?? null,
    error: record.error ?? null,
  }));
}

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
    followUp: restartRequired ? reloadFollowUp({ host: args.host }) : null,
    error: null,
  };
}

export async function runUpdate(args = {}, deps = {}) {
  const upstream = deps.runUpstream ?? runUpstream;
  const cwd = path.resolve(args.cwd || process.cwd());

  const resolvedArgs = {
    cwd,
    host: args.host ?? DEFAULT_HOST,
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

  components.push(...extensionRecords(args));

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
