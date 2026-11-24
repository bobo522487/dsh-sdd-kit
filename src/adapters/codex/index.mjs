/**
 * Codex adapter — answers the three contract faces plus reload semantics
 * without embedding business rules. Text and host facts come from src/core.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { HOST_CAPABILITIES } from '../../core/host-capabilities.mjs';
import { resolveRunContext } from '../../core/action.mjs';
import { getRunContext } from '../../core/run-context.mjs';
import { assembleGuidance, formatGuidanceText } from '../../core/guidance.mjs';
import { clearMarker } from '../../core/marker.mjs';
import { removeManagedBlockFile } from '../../core/fsutil.mjs';

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

export async function applyCodexGuidance({
  cwd = process.cwd(),
  env = process.env,
  skills,
  nativeEventsAvailable = false,
  sessionStart,
  runId,
  runContext: supplied,
} = {}) {
  const runContext = resolveRunContext({
    params: { sessionStart, runId, runContext: supplied ?? getRunContext({ cwd }) },
    env,
  });
  // Startup completes a previous pending change: drop only this repository's
  // entry for this host (REQ-18). A failed clear never blocks guidance.
  await clearMarker({ cwd, host: CAP.key }).catch(() => {});

  const bundle = await assembleGuidance({ host: CAP.key, cwd, env, skills });
  const text = formatGuidanceText(bundle);
  const target = path.join(cwd, CAP.guidanceConfig.managedBlockPath);
  const enabled = bundle.enabled !== false;
  const written = enabled && Boolean(bundle.upstreamText?.trim()) && !nativeEventsAvailable;
  let removed = false;
  if (written) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, codexManagedBlock(text), 'utf8');
  } else {
    // Closed switch, empty upstream, or a host that injects natively: a block
    // left over from an earlier run must not stay resident (REQ-12/AC-08).
    removed = await removeManagedBlockFile({ file: target, ...CAP.guidanceConfig });
  }
  return {
    channel: nativeEventsAvailable ? 'native-event' : 'managed-block',
    text,
    target,
    enabled,
    written,
    removed,
    warnings: bundle.warnings,
    bundle,
    runContext,
  };
}
