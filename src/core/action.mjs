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

export function actionError(code, message, fix) {
  return { status: 'error', code, message, fix };
}

export function unknownActionError(action) {
  return actionError(
    'E_UNKNOWN_ACTION',
    `Unknown action: ${action || '(empty)'}`,
    'Use one of: update, bridge, doctor, guard, guidance.'
  );
}

/**
 * Derive the changed layers of an update report. `spec-kit` refreshes the CLI
 * (tool code), `superpowers` refreshes the skill mirror (skill data).
 */
function changedLayers(report) {
  const layers = new Set();
  for (const record of report?.components ?? []) {
    if (record?.outcome !== 'updated') continue;
    layers.add(record.component === 'superpowers' ? 'skill_data' : 'tool_code');
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
  const host = params.host || 'dsh';
  const layers = changedLayers(report);
  const decision = decideReload({ layers }, host);
  const result = { ...report, reload: { ...decision, markerPath: markerPath(report.cwd ?? params.cwd ?? process.cwd()) } };
  if (decision.result === 'none') return result;
  if (!isSuccessfulUpdate(report)) return result;

  await writeMarker({
    cwd: report.cwd ?? params.cwd ?? process.cwd(),
    host,
    layer: layers[0],
    reason: decision.reason,
  });
  return result;
}

/**
 * @param {string} action one of update|bridge|upstream|doctor|guard|guidance
 * @param {object} params shared parameters (cwd, trigger, ...)
 */
export async function runAction(action, params = {}, deps = {}) {
  switch (action) {
    case 'update':
      return withReload(await (deps.runUpdate ?? runUpdate)(params), params);
    case 'setup':
      return (deps.runSetup ?? runSetup)(params);
    case 'bridge':
      return (deps.runBridge ?? runBridge)(params);
    case 'upstream':
      return (deps.runUpstream ?? runUpstream)(params);
    case 'guidance':
      return (deps.assembleGuidance ?? assembleGuidance)(params);
    case 'guard':
      return (deps.checkPlanningGuard ?? checkPlanningGuard)(params);
    case 'doctor':
      return (deps.runDoctor ?? runDoctor)(params);
    default:
      return unknownActionError(action);
  }
}
