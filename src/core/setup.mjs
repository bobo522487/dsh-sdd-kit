import path from 'node:path';

import { runUpstream } from './upstream.mjs';
import { runBridge } from './bridge.mjs';

/**
 * The /sdd-setup state machine, in code so it can be asserted.
 * Pure orchestration of existing actions — no upstream logic lives here.
 */
export async function runSetup(args = {}, deps = {}) {
  const upstream = deps.runUpstream ?? runUpstream;
  const bridge = deps.runBridge ?? runBridge;
  const cwd = path.resolve(args.cwd || process.cwd());
  const steps = [];
  const record = (name, status, detail = null) => steps.push({ name, status, detail });
  const finish = (extra = {}) => ({
    action: 'setup',
    ok: steps.every((s) => s.status !== 'failed'),
    cwd,
    steps,
    ...extra,
  });

  const info = await bridge({ action: 'inspect', cwd });
  record('inspect', 'performed', { hasSpecifyDir: info.hasSpecifyDir, hasConstitution: info.hasConstitution });

  // REQ-11: a mirror sync failure must not abort the extension install.
  const sync = await upstream({ action: 'sync_superpowers', cwd, superpowersDir: args.superpowersDir, repoUrl: args.repoUrl });
  record('sync_superpowers', sync.ok ? 'performed' : 'failed',
    sync.ok ? { mode: sync.mode, skillCount: sync.skillCount } : { stderr: sync.stderr });
  const restartRequired = sync.mode === 'clone';

  const status = await upstream({ action: 'status', cwd, superpowersDir: args.superpowersDir });
  if (!status.uv.installed) {
    record('specify_cli', 'failed', { hint: 'uv is required: https://docs.astral.sh/uv/getting-started/installation/' });
    return finish({ restartRequired });
  }
  if (!status.specifyCli.installed || args.upgrade === true) {
    const up = await upstream({ action: 'specify_upgrade', cwd, python: args.python });
    record('specify_cli', up.ok ? 'performed' : 'failed', up.ok ? { mode: up.mode } : { stderr: up.stderr });
  } else {
    record('specify_cli', 'skipped', { version: status.specifyCli.version });
  }

  // REQ-15: never re-run init on an existing layout.
  if (!info.hasSpecifyDir) {
    const init = await upstream({ action: 'specify_init', cwd, integration: args.integration });
    record('specify_init', init.ok ? 'performed' : 'failed', init.ok ? null : { stderr: init.stderr });
    if (!init.ok) return finish({ restartRequired });
  } else {
    record('specify_init', 'skipped', { reason: 'existing .specify layout preserved (REQ-15)' });
  }

  // Install artifacts are untracked, so a legacy checkout can lack the generated
  // command skills: repair them before the extensions write their own skills.
  const native = await upstream({ action: 'ensure_integration_commands', cwd });
  record(
    'integration_commands',
    native.ok ? (native.repaired ? 'performed' : 'skipped') : 'failed',
    native.ok
      ? { skillsDir: native.skillsDir, commands: native.commands }
      : { error: native.error, skillsDir: native.skillsDir }
  );

  // Both extensions are ensured on every run (idempotent via --force).
  const bug = await upstream({ action: 'install_bug_ext', cwd });
  record('install_bug_ext', bug.ok ? 'performed' : 'failed', bug.ok ? null : { stderr: bug.stderr });
  const hooks = await upstream({ action: 'install_hooks_ext', cwd, extensionDir: args.extensionDir });
  record('install_hooks_ext', hooks.ok ? 'performed' : 'failed',
    hooks.ok ? { extension: hooks.extension, hooks: hooks.hooks } : { stderr: hooks.stderr ?? hooks.error });

  const ov = await bridge({ action: 'install_overrides', cwd });
  const ovDetail = {
    status: ov.status,
    verdict: ov.artifacts?.[0]?.verdict ?? null,
    reason: ov.artifacts?.[0]?.reason ?? null,
    nextAction: ov.artifacts?.[0]?.nextAction ?? null,
    artifacts: ov.artifacts ?? [],
  };
  const ovStep = ov.status === 'failed'
    ? 'failed'
    : ov.status === 'written' || ov.status === 'refreshed'
      ? 'performed'
      : 'skipped';
  record('install_overrides', ovStep, ovDetail);

  // REQ-16: the switch is explicit opt-in only, then hooks are regenerated.
  let mismatch = hooks.integrationMismatch ?? null;
  if (args.switchIntegration === true && mismatch) {
    const sw = await upstream({ action: 'switch_integration', cwd });
    record('switch_integration', sw.ok ? 'performed' : 'failed', sw.ok ? null : { stderr: sw.stderr });
    if (sw.ok) {
      const re = await upstream({ action: 'install_hooks_ext', cwd, extensionDir: args.extensionDir });
      record('reinstall_hooks_ext', re.ok ? 'performed' : 'failed', re.ok ? null : { stderr: re.stderr ?? re.error });
      mismatch = re.integrationMismatch ?? null;
    }
  }

  return finish({
    integration: hooks.integration ?? null,
    skillsDir: hooks.skillsDir ?? null,
    integrationMismatch: mismatch,
    restartRequired,
    constitutionPresent: info.hasConstitution,
  });
}
