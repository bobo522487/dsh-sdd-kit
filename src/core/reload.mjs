/**
 * Reload decision — the single implementation of "what does the user do next".
 * Pure table lookup over HOST_CAPABILITIES[*].reloadPolicy; no filesystem, no host APIs.
 */

import { HOST_CAPABILITIES } from './host-capabilities.mjs';

const SEVERITY = Object.freeze({ none: 0, new_session: 1, restart_host: 2 });

/**
 * @param {{layers?: string[]}} changes changed layers: tool_code|skill_data|extension_command
 * @param {string} host normalized host key
 * @returns {{result: 'restart_host'|'new_session'|'none', layers: string[], reason: string, host: string}}
 */
export function decideReload(changes = {}, host = 'dsh') {
  const cap = HOST_CAPABILITIES[host];
  if (!cap) throw new Error(`unknown host: ${host}`);

  const layers = Array.isArray(changes.layers) ? changes.layers.filter(Boolean) : [];
  if (layers.length === 0) {
    return {
      result: 'none',
      layers: [],
      reason: `${host}: 无改动层，无需动作。`,
      host,
    };
  }

  let result = 'none';
  const parts = [];
  for (const layer of layers) {
    const policy = cap.reloadPolicy[layer];
    if (!policy) throw new Error(`unknown change layer: ${layer}`);
    parts.push(`${layer}=${policy}`);
    if (SEVERITY[policy] > SEVERITY[result]) result = policy;
  }

  const reason = result === 'restart_host'
    ? `${host}: ${parts.join(', ')} 命中宿主策略，需重启宿主后生效。`
    : `${host}: ${parts.join(', ')} 命中宿主策略，需新开会话后生效。`;
  return { result, layers, reason, host };
}
