/**
 * Cursor adapter — answers the three contract faces plus reload semantics
 * without embedding business rules. Trust flags are surfaced, never enabled.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { HOST_CAPABILITIES } from '../../core/host-capabilities.mjs';
import { assembleGuidance, formatGuidanceText } from '../../core/guidance.mjs';
import { clearMarker } from '../../core/marker.mjs';

const CAP = HOST_CAPABILITIES.cursor;

export function describeCursor() {
  return {
    toolFace: `原生调用前缀 ${CAP.toolPrefix}，动作委托宿主中立 CLI（bin/sdd-kit.mjs）`,
    guidanceFace: `常驻规则目录 ${CAP.guidanceConfig.rulePath}`,
    skillFace: `技能目录 ${CAP.skillsDir}，由 specify integration install cursor-agent 安装`,
    reloadSemantics: Object.entries(CAP.reloadPolicy).map(([k, v]) => `${k}=${v}`).join('; '),
  };
}

export function checkTrustFlags(input) {
  const source = typeof input === 'string' ? input : (input?.args ?? []);
  const flags = Array.isArray(source) ? source : source.split(/\s+/);
  return flags.filter((arg) => CAP.trustFlagPattern?.test(arg));
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
    await fs.writeFile(target, text, 'utf8');
  } else {
    // The rule file lives at a kit-owned path, so a closed switch or an empty
    // upstream mirror must leave no resident rule behind (REQ-12/AC-08).
    const present = await fs.access(target).then(() => true, () => false);
    removed = present && await fs.rm(target, { force: true }).then(() => true, () => false);
  }
  const warnings = [...bundle.warnings];
  return { channel: 'rule-dir', text, target, enabled, written, removed, warnings, bundle };
}
