/**
 * Single source of guidance text. Every host receives the same assembled bundle;
 * adapters only choose how to register it. No host-only APIs live here.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { HOST_CAPABILITIES } from './host-capabilities.mjs';
import { detectFeaturePhase } from './feature-phase.mjs';

export const TOKEN_BUDGET = 1200;

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

export function estimateTokens(text) {
  let cjk = 0;
  let ascii = 0;
  for (const ch of String(text ?? '')) {
    if (CJK.test(ch)) cjk += 1;
    else ascii += 1;
  }
  return cjk + Math.ceil(ascii / 3.5);
}

function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (pair) data[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, '');
  }
  return data;
}

async function readUpstreamText(dir, warnings) {
  if (!dir) dir = path.join(os.homedir(), '.dsh', 'upstream', 'superpowers', 'skills');
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    warnings.push(`纪律技能目录不可读（${error.code ?? 'E_READ'}）：${dir}；请安装上游纪律技能镜像后重试。`);
    return '';
  }
  const lines = [];
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const raw = await fs.readFile(path.join(dir, entry.name, 'SKILL.md'), 'utf8');
      const meta = frontmatter(raw);
      if (!meta?.name || !meta?.description) continue;
      lines.push(`- ${meta.name}: ${meta.description}`);
    } catch {
      // a partially installed skill is not a reason to fail the whole bundle
    }
  }
  if (lines.length === 0) {
    warnings.push(`未发现可用的纪律技能（目录 ${dir}）；请运行上游安装命令。`);
  }
  return lines.join('\n');
}

async function readJsonLevel(file, warnings) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    const value = parsed?.guidance?.enabled;
    if (typeof value !== 'boolean') return { present: false, enabled: true };
    return { present: true, enabled: value };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      warnings.push(`开关配置不可解析，按未设置处理：${file}`);
    }
    return { present: false, enabled: true };
  }
}

async function resolveSwitch({ cwd, env, warnings }) {
  const home = env?.HOME || os.homedir();
  const userFile = path.join(home, '.dsh', 'sdd-kit.json');
  const projectFile = path.join(cwd, '.specify', 'sdd-kit.json');
  const user = await readJsonLevel(userFile, warnings);
  const project = await readJsonLevel(projectFile, warnings);
  if (project.present) return { enabled: project.enabled, effectiveScope: 'project' };
  if (user.present) return { enabled: user.enabled, effectiveScope: 'user' };
  return { enabled: true, effectiveScope: 'default' };
}

function toolMapping() {
  // Canonical tool names are shared verbatim across hosts (REQ-13/AC-08);
  // host-specific invocation prefixes live in HOST_CAPABILITIES.
  return {
    upstream: 'sdd_upstream',
    bridge: 'sdd_bridge',
    doctor: 'sdd_doctor',
  };
}

function textOf(bundle) {
  return [
    bundle.upstreamText,
    Object.entries(bundle.toolMapping).map(([action, tool]) => `${action} -> ${tool}`).join('\n'),
    Object.entries(bundle.sddPointer).map(([key, value]) => `${key}: ${value}`).join('\n'),
  ].filter(Boolean).join('\n');
}

/**
 * Assemble one guidance bundle shared by every host adapter.
 * @param {{host?: string, cwd?: string, skills?: Array<{name:string,description:string}>, superpowersDir?: string, env?: object}} options
 */
export async function assembleGuidance({
  host = 'dsh',
  cwd = process.cwd(),
  skills,
  superpowersDir,
  env,
} = {}) {
  const warnings = [];
  const switchState = await resolveSwitch({ cwd, env, warnings });
  const upstreamText = Array.isArray(skills)
    ? skills
      .filter((s) => s?.name && s?.description)
      .map((s) => `- ${s.name}: ${s.description}`)
      .join('\n')
    : await readUpstreamText(superpowersDir, warnings);
  const pointerRaw = detectFeaturePhase ? await detectFeaturePhase({ cwd }) : null;
  const sddPointer = pointerRaw
    ? { feature: pointerRaw.feature, phase: pointerRaw.phase, nextCommand: pointerRaw.nextCommand }
    : { feature: '', phase: '', nextCommand: '' };

  const bundle = {
    upstreamText,
    toolMapping: toolMapping(),
    sddPointer,
    tokenEstimate: 0,
    warnings,
    enabled: switchState.enabled,
    effectiveScope: switchState.effectiveScope,
  };
  bundle.tokenEstimate = estimateTokens(textOf(bundle));

  if (bundle.tokenEstimate > TOKEN_BUDGET) {
    // Only the pointer may be trimmed; upstream text is immutable (REQ-09).
    if (bundle.sddPointer.nextCommand) {
      bundle.sddPointer.nextCommand = '';
      bundle.tokenEstimate = estimateTokens(textOf(bundle));
    }
    if (bundle.tokenEstimate > TOKEN_BUDGET && bundle.sddPointer.phase) {
      bundle.sddPointer.phase = '';
      bundle.tokenEstimate = estimateTokens(textOf(bundle));
    }
    if (bundle.tokenEstimate > TOKEN_BUDGET && bundle.sddPointer.feature) {
      bundle.sddPointer.feature = '';
      bundle.tokenEstimate = estimateTokens(textOf(bundle));
    }
    if (bundle.tokenEstimate > TOKEN_BUDGET) {
      warnings.push(`引导内容超过 1.2k token 上限（估算 ${bundle.tokenEstimate}），上游原文按规范保留，请缩短上游描述。`);
    } else {
      warnings.push('引导内容超过 1.2k token 上限，已仅裁剪 SDD 指针；上游原文保持完整。');
    }
  }

  return bundle;
}

/** Render a bundle as the plain text injected by host session-start hooks. */
export function formatGuidanceText(bundle) {
  const pointer = Object.entries(bundle.sddPointer)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  const mapping = Object.entries(bundle.toolMapping)
    .map(([action, tool]) => `${action} -> ${tool}`)
    .join('\n');
  return [
    '## SDD 运行时纪律（dsh-sdd-kit）',
    bundle.upstreamText,
    mapping ? `工具映射：\n${mapping}` : '',
    pointer ? `当前进度：\n${pointer}` : '',
  ].filter(Boolean).join('\n\n');
}
