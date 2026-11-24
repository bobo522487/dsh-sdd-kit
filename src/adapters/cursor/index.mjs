/**
 * Cursor adapter — answers the three contract faces plus reload semantics
 * without embedding business rules. Trust flags are surfaced, never enabled.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { HOST_CAPABILITIES, checkTrustFlags } from '../../core/host-capabilities.mjs';
import { assembleGuidance, formatGuidanceText } from '../../core/guidance.mjs';
import { clearMarker } from '../../core/marker.mjs';
import { removeManagedBlockFile } from '../../core/fsutil.mjs';
export { checkTrustFlags };

const CAP = HOST_CAPABILITIES.cursor;
const MARKERS = {
  markerStart: '<!-- sdd-kit:rules:start -->',
  markerEnd: '<!-- sdd-kit:rules:end -->',
};

export function describeCursor() {
  return {
    toolFace: `原生调用前缀 ${CAP.toolPrefix}，动作委托宿主中立 CLI（bin/sdd-kit.mjs）`,
    guidanceFace: `常驻规则目录 ${CAP.guidanceConfig.rulePath}`,
    skillFace: `技能目录 ${CAP.skillsDir}，由 specify integration install cursor-agent 安装`,
    reloadSemantics: Object.entries(CAP.reloadPolicy).map(([k, v]) => `${k}=${v}`).join('; '),
  };
}

export function cursorDefaultConfig() {
  return { guidanceChannel: CAP.guidanceChannel, skillsDir: CAP.skillsDir, toolPrefix: CAP.toolPrefix };
}

export async function applyCursorGuidance({ cwd = process.cwd(), env = process.env, skills } = {}) {
  // Startup completes a previous pending change: drop only this repository's
  // entry for this host (REQ-18). A failed clear never blocks guidance.
  await clearMarker({ cwd, host: CAP.key }).catch(() => {});

  const bundle = await assembleGuidance({ host: CAP.key, cwd, env, skills });
  const text = formatGuidanceText(bundle);
  const target = path.join(cwd, CAP.guidanceConfig.rulePath);
  const enabled = bundle.enabled !== false;
  const written = enabled && Boolean(bundle.upstreamText?.trim());
  let removed = false;
  if (written) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    // An ownership marker makes later removal provably safe: a user-authored
    // file at the same path must never disappear when the switch is closed.
    await fs.writeFile(target, `${MARKERS.markerStart}\n${text}\n${MARKERS.markerEnd}\n`, 'utf8');
  } else {
    removed = await removeManagedBlockFile({ file: target, ...MARKERS });
  }
  const warnings = [...bundle.warnings];
  return { channel: 'rule-dir', text, target, enabled, written, removed, warnings, bundle };
}
