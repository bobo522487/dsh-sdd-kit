import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_SUPERPOWERS_REPO = 'https://github.com/obra/superpowers.git';

export function getDefaultSuperpowersDir() {
  return path.join(os.homedir(), '.dsh', 'upstream', 'superpowers');
}

async function defaultRunner(cmd, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 120000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, code: 0, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() };
  } catch (err) {
    return {
      ok: false,
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: (err.stdout || '').trim(),
      stderr: (err.stderr || err.message || '').trim(),
    };
  }
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function countSkills(skillsDir) {
  if (!(await exists(skillsDir))) return 0;
  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  let count = 0;
  for (const e of entries) {
    if (e.isDirectory() && (await exists(path.join(skillsDir, e.name, 'SKILL.md')))) {
      count += 1;
    }
  }
  return count;
}

export async function runUpstream(args = {}, runner = defaultRunner) {
  const action = args.action || 'status';
  const cwd = path.resolve(args.cwd || process.cwd());
  const superpowersDir = path.resolve(args.superpowersDir || getDefaultSuperpowersDir());
  const repoUrl = args.repoUrl || DEFAULT_SUPERPOWERS_REPO;

  if (action === 'status') {
    const [specify, uv, git] = await Promise.all([
      runner('specify', ['--version'], { cwd }),
      runner('uv', ['--version'], { cwd }),
      runner('git', ['--version'], { cwd }),
    ]);

    const spExists = await exists(path.join(superpowersDir, '.git'));
    const spSkillsDir = path.join(superpowersDir, 'skills');
    const spSkillCount = await countSkills(spSkillsDir);
    let spHead = null;
    if (spExists) {
      const rev = await runner('git', ['-C', superpowersDir, 'rev-parse', '--short', 'HEAD']);
      if (rev.ok) spHead = rev.stdout;
    }

    return {
      action: 'status',
      cwd,
      specifyCli: { installed: specify.ok, version: specify.ok ? specify.stdout : null, error: specify.ok ? null : specify.stderr },
      uv: { installed: uv.ok, version: uv.ok ? uv.stdout : null },
      git: { installed: git.ok, version: git.ok ? git.stdout : null },
      superpowers: {
        dir: superpowersDir,
        installed: spExists,
        head: spHead,
        skillCount: spSkillCount,
      },
    };
  }

  if (action === 'sync_superpowers') {
    const isCloned = await exists(path.join(superpowersDir, '.git'));
    if (isCloned) {
      const pull = await runner('git', ['-C', superpowersDir, 'pull', '--ff-only']);
      const skillCount = await countSkills(path.join(superpowersDir, 'skills'));
      return { action, mode: 'pull', dir: superpowersDir, skillCount, ...pull };
    }
    await fs.mkdir(path.dirname(superpowersDir), { recursive: true });
    const clone = await runner('git', ['clone', '--depth', '1', repoUrl, superpowersDir]);
    const skillCount = await countSkills(path.join(superpowersDir, 'skills'));
    return { action, mode: 'clone', dir: superpowersDir, repoUrl, skillCount, ...clone };
  }

  if (action === 'specify_upgrade') {
    const check = await runner('specify', ['--version'], { cwd });
    const uvArgs = check.ok
      ? ['tool', 'upgrade', 'specify-cli']
      : ['tool', 'install', 'specify-cli', '--from', 'git+https://github.com/github/spec-kit.git'];
    const res = await runner('uv', uvArgs, { cwd });
    return { action, mode: check.ok ? 'upgrade' : 'install', command: `uv ${uvArgs.join(' ')}`, ...res };
  }

  if (action === 'specify_init') {
    const integration = args.integration || 'claude';
    const cliArgs = [
      'init', '--here', '--integration', integration,
      '--non-interactive', '--force', '--ignore-agent-tools',
    ];
    if (args.useSkills === true) {
      cliArgs.push('--integration-options=--skills');
    }
    const res = await runner('specify', cliArgs, { cwd });
    return { action, cwd, command: `specify ${cliArgs.join(' ')}`, ...res };
  }

  if (action === 'install_bug_ext') {
    const res = await runner('specify', ['extension', 'add', 'bug'], { cwd });
    return { action, cwd, command: 'specify extension add bug', ...res };
  }

  throw new Error(
    `Unknown sdd_upstream action "${action}". Expected one of: status, sync_superpowers, specify_upgrade, specify_init, install_bug_ext.`
  );
}
