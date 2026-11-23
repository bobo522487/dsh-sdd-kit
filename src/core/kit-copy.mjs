export const KIT_ALLOWLIST = [
  'src',
  'skills',
  'overrides',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
  'package.json',
];

// Behavior-free skeleton; T011 implements the staged, allowlisted profile copy.
export async function refreshInstalledKit(_args = {}, _deps = {}) {
  throw new Error('refreshInstalledKit is not implemented yet');
}