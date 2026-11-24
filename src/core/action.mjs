/**
 * Unified action entry point shared by the host tools and the CLI.
 * Business logic stays in the existing core modules; this module only routes.
 */

import { runUpstream } from './upstream.mjs';
import { runBridge } from './bridge.mjs';
import { runUpdate } from './update.mjs';
import { runSetup } from './setup.mjs';
import { assembleGuidance } from './guidance.mjs';
import { decideReload } from './reload.mjs';
import { markerPath, writeMarker } from './marker.mjs';
import { checkPlanningGuard } from './guard.mjs';
import { runDoctor } from './doctor.mjs';
import { HOST_KEYS } from './host-capabilities.mjs';
import { createRunContext, ensureRunAnchor, getRunContext } from './run-context.mjs';

const DEFAULT_HOST = HOST_KEYS[0];

const COMPONENT_LAYERS = Object.freeze({
  superpowers: 'skill_data',
  extension: 'extension_command',
  extension_command: 'extension_command',
  commands: 'extension_command',
});

export function actionError(code, message, fix) {
  return { status: 'error', code, message, fix };
}

export function unknownActionError(action) {
  return actionError(
    'E_UNKNOWN_ACTION',
    `未知的 action：${action || '（空）'}`,
    '可用 action：update、bridge、doctor、guard、guidance。'
  );
}

/**
 * Resolve the shared run context once per call. Explicit parameters win over
 * environment values; a generated neutral context is the production fallback
 * for a CLI/tool/startup that did not supply either. Passing the generated
 * context in `params.runContext` keeps every branch of one call identical.
 */
export function resolveRunContext({ params = {}, env = process.env } = {}) {
  const supplied = params.runContext && typeof params.runContext === 'object'
    ? params.runContext
    : null;
  // Merge supplied facts into the generator: a partial context (for example an
  // explicit runId without sessionStart) must still get a generated start.
  const generated = getRunContext({
    cwd: params.cwd ?? process.cwd(),
    ...(supplied ?? {}),
  });
  const declared = params.sessionStart ?? env?.DSH_SDD_KIT_SESSION_START
    ?? supplied?.sessionStart ?? generated?.sessionStart;
  const numeric = typeof declared === 'string' && declared.trim() !== '' ? Number(declared) : Number.NaN;
  const parsed = typeof declared === 'number'
    ? declared
    : (Number.isFinite(numeric) ? numeric : (typeof declared === 'string' ? Date.parse(declared) : Number.NaN));
  const runId = params.runId ?? env?.DSH_SDD_KIT_RUN_ID
    ?? supplied?.runId ?? generated?.runId ?? null;
  return {
    ...(Number.isFinite(parsed) ? { sessionStart: parsed } : {}),
    ...(typeof runId === 'string' && runId !== '' ? { runId } : {}),
  };
}

function hasExplicitRunOverride(params = {}, env = process.env) {
  const present = (value) => value !== undefined && value !== null && value !== '';
  return present(params.sessionStart) || present(params.runId)
    || present(env?.DSH_SDD_KIT_SESSION_START) || present(env?.DSH_SDD_KIT_RUN_ID);
}

async function stableActionContext(action, params, env) {
  const resolved = resolveRunContext({ params, env });
  // Doctor must stay read-only (REQ-38/REQ-39); explicit params/env never persist.
  // Only the CLI/Host/startup paths that hand in a generated runContext create
  // the shared anchor; a bare direct runAction call stays side-effect free.
  const supplied = params.runContext && typeof params.runContext === 'object'
    ? params.runContext
    : null;
  if (!supplied || action === 'doctor' || hasExplicitRunOverride(params, env)) return resolved;

  const cwd = params.cwd ?? process.cwd();
  const anchor = await ensureRunAnchor({ cwd, context: resolved });
  const merged = anchor
    ? { ...supplied, ...anchor }
    : {
      ...supplied,
      ...createRunContext({ cwd, ...supplied, fallbackToProcessStart: true }),
    };
  return resolveRunContext({
    params: { ...params, runContext: merged },
    env,
  });
}

/**
 * Derive the changed layers of an update report. `spec-kit` refreshes the CLI
 * (tool code), `superpowers` refreshes the skill mirror (skill data), and an
 * extension/commands change touches the extension_command layer.
 */
function changedLayers(report) {
  const layers = new Set();
  for (const record of report?.components ?? []) {
    if (record?.outcome !== 'updated') continue;
    layers.add(COMPONENT_LAYERS[record.component] ?? 'tool_code');
  }
  return [...layers];
}

/**
 * A reload marker is a promise that a *successful* change is waiting to be
 * picked up. `runUpdate` reports failure as `{ok: false, errors}` without a
 * `status` field, so success must be decided from both shapes — otherwise a
 * failed update would leave a marker the user can never clear.
 */
function isSuccessfulUpdate(report) {
  if (!report || report.action !== 'update') return false;
  if (report.status === 'error') return false;
  if (report.ok === false) return false;
  return !(Array.isArray(report.errors) && report.errors.length > 0);
}

/**
 * Attach the reload conclusion to an update result and persist the pending
 * marker only when the user actually has to act (REQ-17/REQ-20).
 */
async function withReload(report, params) {
  if (!report || report.status === 'error' || report.action !== 'update') return report;
  const host = params.host ?? DEFAULT_HOST;
  const layers = changedLayers(report);
  const decision = decideReload({ layers }, host);
  const result = { ...report, reload: { ...decision, markerPath: markerPath(report.cwd ?? params.cwd ?? process.cwd()) } };
  if (decision.result === 'none') return result;
  if (!isSuccessfulUpdate(report)) return result;

  await writeMarker({
    cwd: report.cwd ?? params.cwd ?? process.cwd(),
    host,
    layers,
    reason: decision.reason,
    runId: params.runId ?? report.runId ?? null,
  });
  return result;
}

/**
 * @param {string} action one of update|bridge|upstream|doctor|guard|guidance
 * @param {object} params shared parameters (cwd, trigger, ...)
 */
export async function runAction(action, params = {}, deps = {}) {
  const env = params.env ?? process.env;
  const context = await stableActionContext(action, params, env);
  const withContext = { ...params, ...context };
  switch (action) {
    case 'update':
      return withReload(await (deps.runUpdate ?? runUpdate)(withContext), withContext);
    case 'setup':
      return (deps.runSetup ?? runSetup)(withContext);
    case 'bridge': {
      // I7: bridge reports failures as `{ok:false, error}` with no `status`, so a
      // CLI caller could not tell success from failure and exited 0. Tag the
      // failure here (bridge.mjs keeps its documented shape for tool callers);
      // the success payload is returned untouched.
      const result = await (deps.runBridge ?? runBridge)(withContext);
      if (result && result.ok === false && result.status === undefined) {
        return { ...result, status: 'error' };
      }
      return result;
    }
    case 'upstream':
      return (deps.runUpstream ?? runUpstream)(withContext);
    case 'guidance':
      return (deps.assembleGuidance ?? assembleGuidance)(withContext);
    case 'guard':
      return (deps.checkPlanningGuard ?? checkPlanningGuard)(withContext);
    case 'doctor':
      return (deps.runDoctor ?? runDoctor)(withContext);
    default:
      return unknownActionError(action);
  }
}
