import { defineTool } from '@deepseek-ai/dsh-tools';
import { registerSddTools } from './register.mjs';

export const name = 'dsh-sdd-kit';
export const inject = ['tools'];

export function apply(ctx) {
  registerSddTools(ctx, defineTool);
}
