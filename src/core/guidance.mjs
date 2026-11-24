/**
 * Single source of guidance text. Every host receives the same assembled bundle;
 * adapters only choose how to register it. No host-only APIs live here.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { HOST_CAPABILITIES, HOST_NEUTRAL_TOOL_NAMES, getHostCapability } from './host-capabilities.mjs';
import { detectFeaturePhase } from './feature-phase.mjs';
import { selectSuperpowersDir } from './candidates.mjs';

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

/**
 * Upstream text = the upstream author's own `name` + `description` reference
 * entry, one line per discipline skill.
 *
 * T071/AC-06 reads "上游正文" as this injection unit, NOT the whole SKILL.md:
 * the body stays in the mirror. Injecting it verbatim would blow the 1.2k
 * resident budget (measured: 15 real skills ≈ 40.7k tok vs 774 tok here) and
 * would copy upstream text into every session instead of referencing it
 * (REQ-08), contradicting the success criterion in spec.md ("常驻开销不超过
 * 1.2k token"). Only the SDD pointer is ever trimmed; these lines are not.
 */
async function readUpstreamText(dir, warnings) {
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

/** Explicit paths stay byte-compatible; otherwise share the declared candidate selection. */
async function resolveSkillsDir({ superpowersDir, candidateDirs, env, envKeys, defaultDir }) {
  if (superpowersDir) return superpowersDir;
  const selection = await selectSuperpowersDir({ candidateDirs, envKeys, defaultDir }, env);
  return path.join(selection.dir, 'skills');
}

/**
 * Read one of the two incremental guidance switches. This is the single
 * source of truth for the doctor's "effective scope" report as well.
 * @returns {Promise<{present: boolean, enabled: boolean}>}
 */
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
  if (project.present) return { enabled: project.enabled, effectiveScope: 'project', source: projectFile };
  if (user.present) return { enabled: user.enabled, effectiveScope: 'user', source: userFile };
  return { enabled: true, effectiveScope: 'default', source: null };
}

/** Shared with the read-only doctor so both report the same effective scope. */
export async function resolveGuidanceSwitch({ cwd = process.cwd(), env = process.env } = {}) {
  const warnings = [];
  const state = await resolveSwitch({ cwd, env, warnings });
  return { ...state, warnings };
}

/**
 * Tool mapping for one host, derived from HOST_CAPABILITIES (T068).
 * DSH keeps its native tool names; every other host reaches the same core
 * actions through the host-neutral CLI, so no DSH-only name leaks out.
 * Unknown hosts fall back to the host-neutral face rather than inheriting DSH.
 */
export function toolMapping(host) {
  const cap = getHostCapability(host);
  return { ...(cap?.toolNames ?? HOST_NEUTRAL_TOOL_NAMES) };
}

/**
 * Render a bundle as the plain text injected by host session-start hooks.
 * This is the only measurement surface: the budget gate counts the title,
 * the 工具映射 label and the 当前进度 label too, not just the payload (T070).
 */
export function formatGuidanceText(bundle) {
  // Defensive: this renders whatever a caller passes. The CLI's `--clear-marker`
  // result is a legitimate non-bundle (it carries no sddPointer/toolMapping), so
  // a missing section is omitted rather than throwing (C4).
  const pointer = Object.entries(bundle?.sddPointer ?? {})
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  const mapping = Object.entries(bundle?.toolMapping ?? {})
    .map(([action, tool]) => `${action} -> ${tool}`)
    .join('\n');
  return [
    '## SDD 运行时纪律（dsh-sdd-kit）',
    bundle?.upstreamText,
    mapping ? `工具映射：\n${mapping}` : '',
    pointer ? `当前进度：\n${pointer}` : '',
  ].filter(Boolean).join('\n\n');
}

/**
 * Assemble one guidance bundle shared by every host adapter.
 * @param {{host?: string, cwd?: string, skills?: Array<{name:string,description:string}>, superpowersDir?: string, candidateDirs?: string[], envKeys?: {mirror?: string, home?: string}, defaultDir?: string, env?: object}} options
 */
export async function assembleGuidance({
  host = HOST_CAPABILITIES.dsh.key,
  cwd = process.cwd(),
  skills,
  superpowersDir,
  candidateDirs,
  envKeys,
  defaultDir,
  env,
} = {}) {
  const warnings = [];
  const switchState = await resolveSwitch({ cwd, env, warnings });
  const providedSkills = Array.isArray(skills)
    ? skills.filter((s) => s?.name && s?.description)
    : null;
  if (providedSkills && providedSkills.length === 0) {
    warnings.push('调用方提供的技能列表为空，引导不含上游原文。');
  }
  const upstreamText = providedSkills
    ? providedSkills.map((s) => `- ${s.name}: ${s.description}`).join('\n')
    : await readUpstreamText(
      await resolveSkillsDir({ superpowersDir, candidateDirs, env, envKeys, defaultDir }),
      warnings
    );
  const pointerRaw = detectFeaturePhase ? await detectFeaturePhase({ cwd }) : null;
  const sddPointer = pointerRaw
    ? { feature: pointerRaw.feature, phase: pointerRaw.phase, nextCommand: pointerRaw.nextCommand }
    : { feature: '', phase: '', nextCommand: '' };

  const bundle = {
    upstreamText,
    toolMapping: toolMapping(host),
    sddPointer,
    tokenEstimate: 0,
    warnings,
    enabled: switchState.enabled,
    effectiveScope: switchState.effectiveScope,
  };
  const measure = () => {
    const text = formatGuidanceText(bundle);
    bundle.text = text;
    bundle.tokenEstimate = estimateTokens(text);
    return bundle.tokenEstimate;
  };
  measure();

  if (bundle.tokenEstimate > TOKEN_BUDGET) {
    // Only the pointer may be trimmed; upstream text is immutable (REQ-09).
    if (bundle.sddPointer.nextCommand) {
      bundle.sddPointer.nextCommand = '';
      measure();
    }
    if (bundle.tokenEstimate > TOKEN_BUDGET && bundle.sddPointer.phase) {
      bundle.sddPointer.phase = '';
      measure();
    }
    if (bundle.tokenEstimate > TOKEN_BUDGET && bundle.sddPointer.feature) {
      bundle.sddPointer.feature = '';
      measure();
    }
    if (bundle.tokenEstimate > TOKEN_BUDGET) {
      warnings.push(`引导内容超过 1.2k token 上限（估算 ${bundle.tokenEstimate}），上游原文按规范保留，请缩短上游描述。`);
    } else {
      warnings.push(`引导内容超出 1.2k token 上限，已仅裁剪 SDD 指针至 ${bundle.tokenEstimate} token；上游原文保持完整。`);
    }
  }

  return bundle;
}
