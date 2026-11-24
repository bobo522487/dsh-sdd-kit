/**
 * Claude Code adapter — contract faces and IO only; all text comes from src/core.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { HOST_CAPABILITIES, hasDisciplineSkills, isDisciplineSkill } from '../../core/host-capabilities.mjs';
import { assembleGuidance, formatGuidanceText } from '../../core/guidance.mjs';
import { clearMarker } from '../../core/marker.mjs';
import { removeManagedBlockFile } from '../../core/fsutil.mjs';
export { hasDisciplineSkills, isDisciplineSkill };

const CAP = HOST_CAPABILITIES.claude;
const MARKERS = { markerStart: CAP.guidanceConfig.markerStart, markerEnd: CAP.guidanceConfig.markerEnd };

/** SessionStart commands may sit in `hooks.SessionStart[].hooks[].command`. */
function sessionStartCommands(settings) {
  const groups = settings?.hooks?.SessionStart;
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
    .map((hook) => (typeof hook?.command === 'string' ? hook.command : ''))
    .filter(Boolean);
}

/** Probe the two artifacts the integration writes; any failure means "no native event" (I1). */
export async function detectNativeEvents({ cwd = process.cwd() } = {}) {
  try {
    const settings = JSON.parse(await fs.readFile(path.join(cwd, '.claude', 'settings.json'), 'utf8'));
    if (sessionStartCommands(settings).some((command) => command.includes('sdd-kit'))) return true;
  } catch { /* missing or malformed settings means no native event is registered */ }
  try {
    const manifest = await fs.readFile(path.join(cwd, '.specify', 'extensions.yml'), 'utf8');
    if (/^\s*session_start\s*:/m.test(manifest)) return true;
  } catch { /* a project that never installed the extension simply has no manifest */ }
  return false;
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
  nativeEventsAvailable,
} = {}) {
  // Startup completes a previous pending change: drop only this repository's entry for this host (REQ-18).
  await clearMarker({ cwd, host: CAP.key }).catch(() => {});

  // An explicit boolean always wins; only an absent value is probed, so the managed-block fallback stays reachable (I1).
  const explicit = typeof nativeEventsAvailable === 'boolean';
  const nativeChannel = explicit ? nativeEventsAvailable : await detectNativeEvents({ cwd });
  const bundle = await assembleGuidance({ host: CAP.key, cwd, env, skills });
  const text = formatGuidanceText(bundle);
  const enabled = bundle.enabled !== false;
  const warnings = [...bundle.warnings];
  if (!explicit && !nativeChannel) {
    warnings.push('未探测到 Claude 原生 session_start 事件（.claude/settings.json 无 sdd-kit 钩子，.specify/extensions.yml 无 session_start），已降级为托管块写入。');
  }

  const entries = await fs.readdir(path.join(cwd, CAP.skillsDir)).catch(() => []);
  const installHint = hasDisciplineSkills(entries)
    ? null
    : '缺少上游 SDD 技能：运行 specify integration install claude，或 specify extension add --dev spec-kit-extension 安装。';
  if (installHint) warnings.push(installHint);

  const target = path.join(cwd, CAP.guidanceConfig.managedBlockPath);
  const written = enabled && Boolean(bundle.upstreamText?.trim()) && !nativeChannel;
  let removed = false;
  if (written) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, claudeManagedBlock(text), 'utf8');
  } else {
    // A switch-off or a native event supersedes an earlier managed block; leaving it resident would double-inject (REQ-12/AC-08).
    removed = await removeManagedBlockFile({ file: target, ...MARKERS });
  }

  return {
    channel: nativeChannel ? 'native-event' : 'managed-block',
    text, installHint, enabled, written, removed, warnings, nativeEventsAvailable: nativeChannel, bundle,
  };
}
