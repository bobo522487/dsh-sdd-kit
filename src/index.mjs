import { defineTool } from '@deepseek-ai/dsh-tools';
import { registerSddTools } from './register.mjs';
import { applyDshGuidance, resolveGuidanceHost } from './adapters/dsh/index.mjs';
import { applyClaudeGuidance } from './adapters/claude/index.mjs';
import { applyCodexGuidance } from './adapters/codex/index.mjs';
import { applyCursorGuidance } from './adapters/cursor/index.mjs';

export const name = 'dsh-sdd-kit';
export const inject = ['tools'];

const GUIDANCE_APPLIERS = {
  dsh: (ctx, options) => applyDshGuidance(ctx, options),
  claude: (ctx, options) => applyClaudeGuidance(options),
  codex: (ctx, options) => applyCodexGuidance(options),
  cursor: (ctx, options) => applyCursorGuidance(options),
};

export function apply(ctx) {
  const disposers = registerSddTools(ctx, defineTool);
  const disposeAll = () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // a failing disposer must not break plugin teardown
      }
    }
  };

  // Host selection is explicit (DSH_SDD_KIT_HOST or a context marker) and
  // defaults to dsh; an unknown value must never break startup (T086).
  const host = resolveGuidanceHost({ ctx, env: process.env });
  const applyGuidance = GUIDANCE_APPLIERS[host] ?? GUIDANCE_APPLIERS.dsh;

  // Cordis collects the returned (possibly async) disposer for this plugin.
  // Guidance failures are contained here: a missing or broken guidance channel
  // must never prevent the tools from loading (REQ-10).
  return applyGuidance(ctx, { cwd: process.cwd(), env: process.env })
    .then((dispose) => {
      if (typeof dispose === 'function') disposers.push(dispose);
      return disposeAll;
    })
    .catch(() => disposeAll);
}
