import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The Spec Kit extension scripts (spec-kit-extension/scripts/bash/*.sh) are POSIX
 * shell, and the tests run them verbatim so the assertion covers the shipped
 * bytes rather than a re-implementation. POSIX hosts always have `sh`.
 *
 * Windows only has `sh` when Git for Windows is installed, so resolve it
 * explicitly and let the caller skip the shell-backed assertions instead of
 * failing the suite on a machine that can never render those scripts.
 */
export function resolvePosixShell(env = process.env) {
  if (process.platform !== 'win32') return { shell: 'sh', available: true };

  const onPath = spawnSync('sh', ['-c', 'exit 0'], { encoding: 'utf8', env, timeout: 5000 });
  if (!onPath.error && onPath.status === 0) return { shell: 'sh', available: true };

  const roots = [
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs') : null,
  ].filter(Boolean);
  for (const root of roots) {
    for (const relative of [path.join('Git', 'bin', 'sh.exe'), path.join('Git', 'usr', 'bin', 'sh.exe')]) {
      const candidate = path.join(root, relative);
      if (fs.existsSync(candidate)) return { shell: candidate, available: true };
    }
  }
  return { shell: null, available: false };
}

export const POSIX_SHELL_SKIP =
  'no POSIX shell: install Git for Windows (provides sh.exe) or export sh on PATH';
