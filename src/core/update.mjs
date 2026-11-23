export const COMPONENT_NAMES = ['spec-kit', 'superpowers', 'dsh-sdd-kit'];
export const OUTCOMES = ['unchanged', 'updated', 'failed'];

// Behavior-free skeleton; T009/T010 implement the orchestrator and adapters.
export async function runUpdate(_args = {}, _deps = {}) {
  throw new Error('runUpdate is not implemented yet');
}