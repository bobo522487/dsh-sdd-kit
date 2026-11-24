/**
 * DSH guidance adapter — registers the shared guidance bundle as an ordered,
 * always-present system prompt section. Host-only APIs stay in this file; the
 * text itself comes from src/core/guidance.mjs (REQ-08/REQ-10).
 */

import { HOST_CAPABILITIES } from '../../core/host-capabilities.mjs';
import { assembleGuidance } from '../../core/guidance.mjs';
import { clearMarker } from '../../core/marker.mjs';

const CAP = HOST_CAPABILITIES.dsh;

export function renderGuidanceText(bundle) {
  const pointer = Object.entries(bundle.sddPointer)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  const mapping = Object.entries(bundle.toolMapping)
    .map(([action, tool]) => `${action} -> ${tool}`)
    .join('\n');
  return [
    '## SDD 运行时纪律（dsh-sdd-kit）',
    bundle.upstreamText,
    mapping ? `工具映射：\n${mapping}` : '',
    pointer ? `当前进度：\n${pointer}` : '',
  ].filter(Boolean).join('\n\n');
}

/**
 * Read the optional systemPrompt service without requiring it in `inject`.
 * A missing service must never block plugin loading.
 */
export async function applyDshGuidance(ctx, { cwd = process.cwd(), env = process.env, warnings = [] } = {}) {
  // Startup is the completion point of a previous pending change: clear only
  // this repository's entry for this host (REQ-18).
  await clearMarker({ cwd, host: CAP.key }).catch(() => {});

  const service = typeof ctx?.get === 'function' ? ctx.get(CAP.guidanceConfig.service) : undefined;
  if (!service || typeof service.section !== 'function') {
    warnings.push('ctx.systemPrompt 服务缺失，会话引导静默缺席。');
    return () => {};
  }

  const bundle = await assembleGuidance({ host: CAP.key, cwd, env });
  warnings.push(...bundle.warnings);
  if (!bundle.enabled) return () => {};

  const anchorOrder = typeof service.getSectionOrder === 'function'
    ? service.getSectionOrder(CAP.guidanceConfig.sectionOrderAnchor)
    : 0;
  const text = renderGuidanceText(bundle);
  return service.section({
    name: CAP.guidanceConfig.sectionName,
    order: anchorOrder + CAP.guidanceConfig.sectionOrderOffset,
    text,
  });
}
