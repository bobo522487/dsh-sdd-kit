/**
 * Planning-phase guard — a read-only check that refuses to let a project drift
 * back into planning once implementation has started (REQ-23).
 *
 * The phase itself comes from feature-phase.mjs so the guidance pointer and the
 * guard can never disagree; this module only turns the phase into a decision.
 */

import { detectFeaturePhase } from './feature-phase.mjs';

export async function checkPlanningGuard({ cwd = process.cwd() } = {}) {
  const { feature, phase, featureDir } = await detectFeaturePhase({ cwd });
  if (phase === 'implement') {
    return {
      blocked: true,
      status: 'error',
      code: 'E_PLANNING_GUARD',
      phase,
      feature,
      featureDir,
      message: `${feature || '当前特性'} 已进入实现阶段（tasks.md 存在已勾选任务），不得回到定义阶段。`,
      fix: '若要重新规划，先新建一个特性目录；不要复用已开工的 tasks.md。',
    };
  }
  return {
    blocked: false,
    status: 'ok',
    phase,
    feature,
    featureDir,
    message: '规划期护栏未拦截。',
  };
}
