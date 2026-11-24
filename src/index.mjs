import { defineTool } from '@deepseek-ai/dsh-tools';
import { registerSddTools } from './register.mjs';
import { applyDshGuidance } from './adapters/dsh/index.mjs';

export const name = 'dsh-sdd-kit';
export const inject = ['tools'];

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

  // Cordis collects the returned (possibly async) disposer for this plugin.
  // Guidance failures are contained here: a missing or broken guidance channel
  // must never prevent the tools from loading (REQ-10).
  return applyDshGuidance(ctx, { cwd: process.cwd() })
    .then((dispose) => {
      if (typeof dispose === 'function') disposers.push(dispose);
      return disposeAll;
    })
    .catch(() => disposeAll);
}
