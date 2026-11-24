/**
 * Claude Code adapter — answers the three contract faces plus reload semantics
 * without embedding any business rules. All text comes from src/core.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { HOST_CAPABILITIES } from '../../core/host-capabilities.mjs';
import { assembleGuidance, formatGuidanceText } from '../../core/guidance.mjs';

const CAP = HOST_CAPABILITIES.claude;

export function describeClaude() {
  return {
    toolFace: `宿主工具经 ${CAP.toolPrefix} 前缀暴露，动作委托宿主中立 CLI（bin/sdd-kit.mjs）`,
    guidanceFace: `优先 ${CAP.guidanceChannel}（events.${CAP.guidanceConfig.event}），不可用时降级 ${CAP.guidanceConfig.managedBlockPath}`,
    skillFace: `项目级技能目录 ${CAP.skillsDir}，由 specify integration install claude 安装`,
    reloadSemantics: Object.entries(CAP.reloadPolicy).map(([k, v]) => `${k}=${v}`).join('; '),
  };
}

export function claudeManagedBlock(text) {
  return `<!-- sdd-kit:discipline:start -->\n${text}\n<!-- sdd-kit:discipline:end -->\n`;
}

export async function applyClaudeGuidance({
  cwd = process.cwd(),
  env = process.env,
  skills,
  nativeEventsAvailable = true,
} = {}) {
  const bundle = await assembleGuidance({ host: CAP.key, cwd, env, skills });
  const text = formatGuidanceText(bundle);
  const channel = nativeEventsAvailable ? 'native-event' : 'managed-block';
  const warnings = [...bundle.warnings];

  let installHint = null;
  const skillsDir = path.join(cwd, CAP.skillsDir);
  const entries = await fs.readdir(skillsDir).catch(() => []);
  const hasDiscipline = entries.some((name) => /sdd-(setup|update)/.test(name));
  if (!hasDiscipline) {
    installHint = '缺少 SDD 纪律技能：运行 /sdd-setup 或 specify extension add --dev spec-kit-extension 安装。';
    warnings.push(installHint);
  }

  if (!nativeEventsAvailable) {
    const target = path.join(cwd, CAP.guidanceConfig.managedBlockPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, claudeManagedBlock(text), 'utf8');
  }

  return { channel, text, installHint, warnings, bundle };
}
