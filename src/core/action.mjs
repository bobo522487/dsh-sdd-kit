/**
 * Unified action entry point shared by the host tools and the CLI.
 * Business logic stays in the existing core modules; this module only routes.
 */

import { runUpstream } from './upstream.mjs';
import { runBridge } from './bridge.mjs';
import { runUpdate } from './update.mjs';
import { runSetup } from './setup.mjs';
import { assembleGuidance } from './guidance.mjs';

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
 * @param {string} action one of update|bridge|upstream|doctor|guard|guidance
 * @param {object} params shared parameters (cwd, trigger, ...)
 */
export async function runAction(action, params = {}, deps = {}) {
  switch (action) {
    case 'update':
      return (deps.runUpdate ?? runUpdate)(params);
    case 'setup':
      return (deps.runSetup ?? runSetup)(params);
    case 'bridge':
      return (deps.runBridge ?? runBridge)(params);
    case 'upstream':
      return (deps.runUpstream ?? runUpstream)(params);
    case 'guidance':
      return (deps.assembleGuidance ?? assembleGuidance)(params);
    case 'doctor':
    case 'guard':
      return unknownActionError(action);
    default:
      return unknownActionError(action);
  }
}
