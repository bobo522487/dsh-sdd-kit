/**
 * Unified action entry point shared by the host tools and the CLI.
 * Business logic stays in the existing core modules; this module only routes.
 */

import { runUpstream } from './upstream.mjs';
import { runBridge } from './bridge.mjs';
import { runUpdate } from './update.mjs';

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
export async function runAction(action, params = {}) {
  switch (action) {
    case 'update':
      return runUpdate(params);
    case 'bridge':
      return runBridge(params);
    case 'upstream':
      return runUpstream(params);
    case 'doctor':
    case 'guard':
    case 'guidance':
      return unknownActionError(action);
    default:
      return unknownActionError(action);
  }
}
