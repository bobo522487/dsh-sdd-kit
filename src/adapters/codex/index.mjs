/**
 * Codex adapter — answers the three contract faces plus reload semantics
 * without embedding business rules. Text and host facts come from src/core.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { HOST_CAPABILITIES } from '../../core/host-capabilities.mjs';
import { assembleGuidance, formatGuidanceText } from '../../core/guidance.mjs';

const CAP = HOST_CAPABILITIES.codex;

export function describeCodex() {
  return {
    toolFace: `原生命令前缀 ${CAP.toolPrefix}，动作委托宿主中立 CLI（bin/sdd-kit.mjs）`,
    guidanceFace: `项目级幂等托管块 ${CAP.guidanceConfig.managedBlockPath}`,
    skillFace: `技能目录 ${CAP.skillsDir}，由 specify integration install codex 安装`,
    reloadSemantics: Object.entries(CAP.reloadPolicy).map(([k, v]) => `${k}=${v}`).join('; '),
  };
}

export function codexManagedBlock(text) {
  const { markerStart, markerEnd } = CAP.guidanceConfig;
  return `${markerStart}\n${text}\n${markerEnd}\n`;
}

export async function applyCodexGuidance({ cwd = process.cwd(), env = process.env, skills } = {}) {
  const bundle = await assembleGuidance({ host: CAP.key, cwd, env, skills });
  const text = formatGuidanceText(bundle);
  const target = path.join(cwd, CAP.guidanceConfig.managedBlockPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, codexManagedBlock(text), 'utf8');
  return { channel: 'managed-block', text, target, warnings: bundle.warnings, bundle };
}
