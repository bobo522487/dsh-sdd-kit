/**
 * Cursor adapter — answers the three contract faces plus reload semantics
 * without embedding business rules. Trust flags are surfaced, never enabled.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { HOST_CAPABILITIES } from '../../core/host-capabilities.mjs';
import { assembleGuidance, formatGuidanceText } from '../../core/guidance.mjs';

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
  const bundle = await assembleGuidance({ host: CAP.key, cwd, env, skills });
  const text = formatGuidanceText(bundle);
  const target = path.join(cwd, CAP.guidanceConfig.rulePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text, 'utf8');
  const warnings = [...bundle.warnings];
  return { channel: 'rule-dir', text, target, warnings, bundle };
}
