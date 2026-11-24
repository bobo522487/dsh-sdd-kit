/**
 * Claude Code adapter — answers the three contract faces plus reload semantics
 * without embedding any business rules. All text comes from src/core.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { HOST_CAPABILITIES } from '../../core/host-capabilities.mjs';
import { assembleGuidance, formatGuidanceText } from '../../core/guidance.mjs';
import { clearMarker } from '../../core/marker.mjs';

const CAP = HOST_CAPABILITIES.claude;
// The managed-block markers belong to Claude's own capability entry, shared
// with Codex through MANAGED_BLOCK_MARKERS in the capability table (T087).
const MARKERS = {
  markerStart: CAP.guidanceConfig.markerStart,
  markerEnd: CAP.guidanceConfig.markerEnd,
};
const DISCIPLINE_SKILLS = new Set([
  'brainstorming', 'dispatching-parallel-agents', 'executing-plans',
  'finishing-a-development-branch', 'receiving-code-review', 'requesting-code-review',
  'subagent-driven-development', 'systematic-debugging', 'test-driven-development',
  'using-git-worktrees', 'using-superpowers', 'verification-before-completion',
  'writing-plans', 'writing-skills',
]);

/** Pure skill-name judgement: upstream command skills or discipline skills (T085). */
export function isDisciplineSkill(name) {
  const skill = typeof name === 'string' ? name.trim() : '';
  return /^speckit-/.test(skill) || DISCIPLINE_SKILLS.has(skill);
}

export function hasDisciplineSkills(entries = []) {
  return entries.some(isDisciplineSkill);
}

export function describeClaude() {
  return {
    toolFace: `宿主工具经 ${CAP.toolPrefix} 前缀暴露，动作委托宿主中立 CLI（bin/sdd-kit.mjs）`,
    guidanceFace: `优先 ${CAP.guidanceChannel}（events.${CAP.guidanceConfig.event}），不可用时降级 ${CAP.guidanceConfig.managedBlockPath}`,
    skillFace: `项目级技能目录 ${CAP.skillsDir}，由 specify integration install claude 安装`,
    reloadSemantics: Object.entries(CAP.reloadPolicy).map(([k, v]) => `${k}=${v}`).join('; '),
  };
}

export function claudeManagedBlock(text, markers = MARKERS) {
  const { markerStart, markerEnd } = markers;
  return `${markerStart}\n${text}\n${markerEnd}\n`;
}

export async function applyClaudeGuidance({
  cwd = process.cwd(),
  env = process.env,
  skills,
  nativeEventsAvailable = true,
} = {}) {
  // Startup completes a previous pending change: drop only this repository's
  // entry for this host (REQ-18). A failed clear never blocks guidance.
  await clearMarker({ cwd, host: CAP.key }).catch(() => {});

  const bundle = await assembleGuidance({ host: CAP.key, cwd, env, skills });
  const text = formatGuidanceText(bundle);
  const channel = nativeEventsAvailable ? 'native-event' : 'managed-block';
  const enabled = bundle.enabled !== false;
  const warnings = [...bundle.warnings];

  const entries = await fs.readdir(path.join(cwd, CAP.skillsDir)).catch(() => []);
  const installHint = hasDisciplineSkills(entries)
    ? null
    : '缺少上游 SDD 技能：运行 specify integration install claude，或 specify extension add --dev spec-kit-extension 安装。';
  if (installHint) warnings.push(installHint);

  const written = enabled && Boolean(bundle.upstreamText?.trim()) && !nativeEventsAvailable;
  if (written) {
    const target = path.join(cwd, CAP.guidanceConfig.managedBlockPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, claudeManagedBlock(text), 'utf8');
  }

  return { channel, text, installHint, enabled, written, warnings, bundle };
}
