/**
 * DSH guidance adapter — registers the shared guidance bundle as an ordered,
 * always-present system prompt section. Host-only APIs stay in this file; the
 * text itself comes from src/core/guidance.mjs (REQ-08/REQ-10).
 *
 * It also hosts the startup host selector: src/index.mjs imports this module
 * anyway, and keeping the pure selector here makes it unit-testable without
 * loading the DSH runtime.
 */

import os from 'node:os';
import path from 'node:path';

import { HOST_CAPABILITIES, HOST_KEYS } from '../../core/host-capabilities.mjs';
import { resolveRunContext } from '../../core/action.mjs';
import { getRunContext } from '../../core/run-context.mjs';
import { assembleGuidance, formatGuidanceText } from '../../core/guidance.mjs';
import { clearMarker } from '../../core/marker.mjs';

const CAP = HOST_CAPABILITIES.dsh;
const HOST_PREFIX = CAP.key.toUpperCase();
const CANDIDATE_ENV_KEYS = Object.freeze({
  mirror: `${HOST_PREFIX}_SDD_KIT_SUPERPOWERS_DIR`,
  home: `${HOST_PREFIX}_HOME`,
});
function defaultSuperpowersDir() {
  return path.join(os.homedir(), path.dirname(CAP.skillsDir), 'upstream', 'superpowers');
}

export function renderGuidanceText(bundle) {
  return formatGuidanceText(bundle);
}

/** Pure startup host resolution: explicit env > context marker > dsh (T086). */
export function resolveGuidanceHost({ ctx, env = process.env } = {}) {
  let declared = env?.DSH_SDD_KIT_HOST;
  if (declared == null && typeof ctx?.sddKitHost === 'string') declared = ctx.sddKitHost;
  if (declared == null && typeof ctx?.get === 'function') {
    try {
      const value = ctx.get('sddKitHost');
      if (typeof value === 'string') declared = value;
    } catch {
      // ctx may not know this service; fall through to the default host.
    }
  }
  const host = typeof declared === 'string' ? declared.trim().toLowerCase() : '';
  return HOST_KEYS.includes(host) ? host : 'dsh';
}

function withStatus(dispose, status) {
  const fn = typeof dispose === 'function' ? dispose : () => {};
  fn.status = { ...status };
  return fn;
}

/**
 * Read the optional systemPrompt service without requiring it in `inject`.
 * A missing service must never block plugin loading.
 */
export async function applyDshGuidance(ctx, { cwd = process.cwd(), env = process.env, warnings = [], sessionStart, runId, runContext: supplied } = {}) {
  const runContext = resolveRunContext({ params: { sessionStart, runId, runContext: supplied ?? getRunContext({ cwd }) }, env });
  // Startup is the completion point of a previous pending change: clear only
  // this repository's entry for this host (REQ-18).
  await clearMarker({ cwd, host: CAP.key }).catch(() => {});

  const service = typeof ctx?.get === 'function' ? ctx.get(CAP.guidanceConfig.service) : undefined;
  if (!service || typeof service.section !== 'function') {
    warnings.push('ctx.systemPrompt 服务缺失，会话引导静默缺席。');
    return withStatus(() => {}, { enabled: null, registered: false, reason: 'no-service', warnings, runContext });
  }

  const bundle = await assembleGuidance({
    host: CAP.key,
    cwd,
    env,
    envKeys: CANDIDATE_ENV_KEYS,
    defaultDir: defaultSuperpowersDir(),
  });
  warnings.push(...bundle.warnings);
  const enabled = bundle.enabled !== false;
  const hasText = Boolean(bundle.upstreamText?.trim?.());
  if (!enabled) {
    return withStatus(() => {}, { enabled, registered: false, reason: 'disabled', warnings, runContext });
  }
  if (!hasText) {
    return withStatus(() => {}, { enabled, registered: false, reason: 'no-upstream', warnings, runContext });
  }

  const anchorOrder = typeof service.getSectionOrder === 'function'
    ? service.getSectionOrder(CAP.guidanceConfig.sectionOrderAnchor)
    : 0;
  const text = renderGuidanceText(bundle);
  const dispose = service.section({
    name: CAP.guidanceConfig.sectionName,
    order: anchorOrder + CAP.guidanceConfig.sectionOrderOffset,
    text,
  });
  return withStatus(dispose, { enabled, registered: true, reason: 'registered', warnings, runContext });
}
