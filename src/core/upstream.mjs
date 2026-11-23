import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DEFAULT_SUPERPOWERS_REPO = 'https://github.com/obra/superpowers.git';

/** Bundled Spec Kit extension source directory shipped inside this package. */
export const BUNDLED_EXTENSION_DIR = path.join(PKG_ROOT, 'spec-kit-extension');

/**
 * Read only the keys this plugin needs from the extension manifest.
 * The manifest itself is validated by the specify CLI; this is a targeted
 * fixed-key reader, not a YAML parser (zero-dependency constraint).
 * Single source of truth: spec-kit-extension/extension.yml.
 */
async function readExtensionManifest(extensionDir) {
  const raw = await fs.readFile(path.join(extensionDir, 'extension.yml'), 'utf8');
  const id = raw.match(/^  id:\s*(\S+)\s*$/m)?.[1] ?? null;
  const versionRaw = raw.match(/^  version:\s*(.+)$/m)?.[1] ?? null;
  const version = versionRaw ? versionRaw.trim().replace(/^"|"$/g, '') : null;
  const lines = raw.split(/\r?\n/);
  const hooksStart = lines.findIndex((line) => /^hooks:\s*$/.test(line));
  const events = [];
  if (hooksStart >= 0) {
    for (const line of lines.slice(hooksStart + 1)) {
      if (/^\S/.test(line)) break;
      const m = line.match(/^  ([a-z_]+):\s*$/);
      if (m) events.push(m[1]);
    }
  }
  return { id, version, events };
}

/** Expected integration for new projects; `.dsh/skills` is inside DSH's default skill roots. */
export const EXPECTED_INTEGRATION = 'dsh';

const SKILLS_DIR_BY_INTEGRATION = Object.freeze({
  dsh: '.dsh/skills',
  claude: '.claude/skills',
});

const INTEGRATION_MISMATCH_NOTE =
  '当前项目的 Spec Kit 技能落在非 DSH 技能根内，DSH 可能看不到 /speckit-* 命令。'
  + '显式执行 `specify integration switch dsh` 可切换：未修改的托管文件会被卸载重装，'
  + '被本地修改过的文件会保留为残留，.specify/extensions.yml、templates、scripts 不受影响。';

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

async function readIntegration(cwd) {
  try {
    const raw = await fs.readFile(path.join(cwd, '.specify', 'init-options.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const value = parsed?.integration || parsed?.ai;
    return typeof value === 'string' && value.trim() ? value.trim() : EXPECTED_INTEGRATION;
  } catch {
    return EXPECTED_INTEGRATION;
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
    const python = args.python || '3.14';
    const check = await runner('specify', ['--version'], { cwd });
    const uvArgs = check.ok
      ? ['tool', 'upgrade', 'specify-cli']
      : ['tool', 'install', 'specify-cli', '--from', 'git+https://github.com/github/spec-kit.git', '--python', python];
    const res = await runner('uv', uvArgs, { cwd });
    return { action, mode: check.ok ? 'upgrade' : 'install', python, command: `uv ${uvArgs.join(' ')}`, ...res };
  }

  if (action === 'specify_init') {
    const integration = args.integration || EXPECTED_INTEGRATION;
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
    const res = await runner('specify', ['extension', 'add', 'bug', '--force'], { cwd });
    return { action, cwd, command: 'specify extension add bug --force', ...res };
  }

  if (action === 'install_hooks_ext') {
    const extensionDir = path.resolve(args.extensionDir || BUNDLED_EXTENSION_DIR);
    if (!(await exists(extensionDir))) {
      return {
        action,
        cwd,
        extensionDir,
        ok: false,
        error: `extension source not found at ${extensionDir}`,
      };
    }

    const cliArgs = ['extension', 'add', '--dev', extensionDir, '--force'];
    const res = await runner('specify', cliArgs, { cwd });
    if (!res.ok) {
      return { action, cwd, extensionDir, command: `specify ${cliArgs.join(' ')}`, ...res };
    }
    const manifest = await readExtensionManifest(extensionDir).catch(() => null);
    if (!manifest?.id || !manifest?.version || manifest.events.length === 0) {
      return {
        action,
        cwd,
        extensionDir,
        ok: false,
        error: `cannot read extension manifest at ${path.join(extensionDir, 'extension.yml')}`,
      };
    }
    const integration = await readIntegration(cwd);
    return {
      action,
      cwd,
      extensionDir,
      command: `specify ${cliArgs.join(' ')}`,
      ...res,
      extension: { id: manifest.id, version: manifest.version },
      ...describeIntegration(integration),
      hooks: [...manifest.events],
      restartRequired: false,
    };
  }

  if (action === 'switch_integration') {
    const target = args.integration || EXPECTED_INTEGRATION;
    const cliArgs = ['integration', 'switch', target];
    const res = await runner('specify', cliArgs, { cwd });
    const integration = await readIntegration(cwd);
    return {
      action,
      cwd,
      command: `specify ${cliArgs.join(' ')}`,
      ...res,
      ...describeIntegration(integration),
      restartRequired: false,
    };
  }

  throw new Error(
    `Unknown sdd_upstream action "${action}". Expected one of: status, sync_superpowers, specify_upgrade, specify_init, install_bug_ext, install_hooks_ext, switch_integration.`
  );
}

/**
 * Describe where Spec Kit writes its generated skills for the given integration.
 * `integrationMismatch` is the only signal that a project is not on the DSH
 * layout; it is a report, never an instruction to switch on its own (REQ-15).
 */
function describeIntegration(integration) {
  const known = SKILLS_DIR_BY_INTEGRATION[integration];
  const description = {
    integration,
    skillsDir: known || '.dsh/skills',
    skillsDirInDshRoots: integration === EXPECTED_INTEGRATION,
    integrationMismatch:
      integration === EXPECTED_INTEGRATION
        ? null
        : {
            current: integration,
            expected: EXPECTED_INTEGRATION,
            switchCommand: `specify integration switch ${EXPECTED_INTEGRATION}`,
            note: INTEGRATION_MISMATCH_NOTE,
          },
  };
  if (!known) description.skillsDirGuessed = true;
  return description;
}
