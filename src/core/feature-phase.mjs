/**
 * Feature phase detection — one shared implementation for the SDD pointer and
 * the read-only planning guard. No state files, pure filesystem reads.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const CHECKED_TASK = /^- \[[xX]\]/m;

const NEXT_COMMANDS = Object.freeze({
  constitution: '/speckit-constitution',
  specify: '/speckit-clarify',
  plan: '/speckit-tasks',
  implement: '/speckit-implement',
});

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readFeatureName(cwd) {
  const ledgerPath = path.join(cwd, '.specify', 'feature.json');
  try {
    const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
    const dir = typeof ledger.feature_directory === 'string' ? ledger.feature_directory : '';
    const last = dir.split(/[\\/]/).filter(Boolean).at(-1);
    if (last) return last;
  } catch {
    // fall through to directory scan
  }
  const specsDir = path.join(cwd, 'specs');
  try {
    const entries = await fs.readdir(specsDir, { withFileTypes: true });
    const folders = entries
      .filter((entry) => entry.isDirectory() && /^\d+-/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    return folders.at(-1) ?? '';
  } catch {
    return '';
  }
}

export function nextCommandForPhase(phase) {
  return NEXT_COMMANDS[phase] ?? NEXT_COMMANDS.constitution;
}

/**
 * @returns {Promise<{feature: string, phase: string, nextCommand: string, featureDir: string}>}
 */
export async function detectFeaturePhase({ cwd = process.cwd() } = {}) {
  const feature = await readFeatureName(cwd);
  const featureDir = feature ? path.join(cwd, 'specs', feature) : '';
  let phase = 'constitution';
  if (featureDir) {
    const tasksPath = path.join(featureDir, 'tasks.md');
    if (await exists(tasksPath)) {
      const tasks = await fs.readFile(tasksPath, 'utf8').catch(() => '');
      // Only a checked task proves implementation started. An unchecked tasks.md
      // without plan.md is not a plan: the pointer falls back to specify (T093).
      if (CHECKED_TASK.test(tasks)) phase = 'implement';
    }
    if (phase === 'constitution') {
      if (await exists(path.join(featureDir, 'plan.md'))) phase = 'plan';
      else if (await exists(path.join(featureDir, 'spec.md'))) phase = 'specify';
    }
  }
  return { feature, phase, nextCommand: nextCommandForPhase(phase), featureDir };
}

export function implementationStarted(phase) {
  return phase === 'implement';
}
