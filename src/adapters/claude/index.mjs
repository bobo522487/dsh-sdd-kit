/**
 * Claude Code adapter — contract faces and IO only; all text comes from src/core.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { HOST_CAPABILITIES, EXTENSION_ID, hasDisciplineSkills, isDisciplineSkill } from '../../core/host-capabilities.mjs';
import { resolveRunContext } from '../../core/action.mjs';
import { getRunContext } from '../../core/run-context.mjs';
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

/** Spec Kit renders an events.py SessionStart command with a `*.guidance` hook. */
function isGuidanceSessionStart(command) {
  return typeof command === 'string' && command.includes('session_start')
    && /events\.py/.test(command) && /\.guidance\b/.test(command);
}

/** Read-only probe of the artifacts the integration actually writes (I1). */
export async function detectNativeEvents({ cwd = process.cwd() } = {}) {
  try {
    const settings = JSON.parse(await fs.readFile(path.join(cwd, '.claude', 'settings.json'), 'utf8'));
    if (sessionStartCommands(settings).some(isGuidanceSessionStart)) return true;
  } catch { /* no settings means no native event */ }
  for (const manifest of [
    path.join(cwd, '.specify', 'extensions', EXTENSION_ID, 'extension.yml'),
    path.join(cwd, '.specify', 'extensions.yml'),
  ]) {
    try {
      const text = await fs.readFile(manifest, 'utf8');
      if (/events:\s*\n\s*session_start:[\s\S]*?command:\s*speckit\.[\w-]+\.guidance/.test(text)) return true;
    } catch { /* no installed manifest in this project */ }
  }
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
  return `${markers.markerStart}\n${text}\n${markers.markerEnd}\n`;
}

export async function applyClaudeGuidance({
  cwd = process.cwd(), env = process.env, skills, nativeEventsAvailable, sessionStart, runId, runContext: supplied,
} = {}) {
  const runContext = resolveRunContext({ params: { sessionStart, runId, runContext: supplied ?? getRunContext({ cwd }) }, env });
  await clearMarker({ cwd, host: CAP.key }).catch(() => {});
  const explicit = typeof nativeEventsAvailable === 'boolean';
  const nativeChannel = explicit ? nativeEventsAvailable : await detectNativeEvents({ cwd });
  const bundle = await assembleGuidance({ host: CAP.key, cwd, env, skills });
  const text = formatGuidanceText(bundle);
  const enabled = bundle.enabled !== false;
  const warnings = [...bundle.warnings];
  if (!explicit && !nativeChannel) {
    warnings.push('未探测到 Claude 原生 session_start 事件（events.py 钩子/V1 事件清单均缺失），已降级为托管块写入。');
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
    removed = await removeManagedBlockFile({ file: target, ...MARKERS });
  }
  return {
    channel: nativeChannel ? 'native-event' : 'managed-block',
    text, installHint, enabled, written, removed, warnings,
    nativeEventsAvailable: nativeChannel, bundle, runContext,
  };
}
