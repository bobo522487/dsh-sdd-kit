import { runAction } from './core/action.mjs';

function renderJsonText(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

export function registerSddTools(ctx, defineTool, deps = {}) {
  const disposers = [];

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'sdd_upstream',
        description:
          'Delegate directly to upstream GitHub Spec Kit (specify CLI) and sync the local obra/superpowers Git mirror (~/.dsh/upstream/superpowers) without reimplementing either tool. Use action "update_all" to check and update both upstream layers (Spec Kit + Superpowers) in one invocation; upgrading dsh-sdd-kit itself is the package manager\'s job (dsh plugin update dsh-sdd-kit --latest, then restart DSH).',
        parameters: {
          action: {
            type: 'string',
            required: true,
            description:
              'One of: setup, status, sync_superpowers, specify_upgrade, specify_init, ensure_integration_commands, install_bug_ext, install_hooks_ext, switch_integration, update_all.',
          },
          cwd: {
            type: 'string',
            description: 'Repository root directory (defaults to process.cwd()).',
          },
          candidateDirs: {
            type: 'array',
            items: { type: 'string' },
            description:
              'For actions "status" and "sync_superpowers": extra mirror candidates to consider (declaration index 1, below an explicit superpowersDir and above DSH_SDD_KIT_SUPERPOWERS_DIR / DSH_HOME / the default ~/.dsh path). Deduplicated by realpath, newest mtime wins.',
          },
          switchIntegration: {
            type: 'boolean',
            description: 'Explicit opt-in for action "setup": switch a non-dsh integration to dsh, then reinstall hooks (default false; the default path only reports the mismatch).',
          },
          upgrade: {
            type: 'boolean',
            description: 'For action "setup": force a specify-cli upgrade even when already installed (default false).',
          },
          integration: {
            type: 'string',
            description: 'Spec Kit integration key for specify_init (default "dsh", which writes .dsh/skills inside DSH default skill roots).',
          },
          useSkills: {
            type: 'boolean',
            description: 'Opt in to the deprecated --integration-options=--skills flag (default false; new spec-kit installs skills by default).',
          },
          python: {
            type: 'string',
            description: 'Python interpreter for fresh specify-cli installs (default 3.14; override if your stable Python differs).',
          },
          superpowersDir: {
            type: 'string',
            description: 'Override local obra/superpowers mirror path (default ~/.dsh/upstream/superpowers).',
          },
          repoUrl: {
            type: 'string',
            description: 'Override upstream superpowers git URL.',
          },
          extensionDir: {
            type: 'string',
            description:
              'Override the Spec Kit extension source directory for action "install_hooks_ext" (defaults to the bundled spec-kit-extension/ inside this package).',
          },
        },
        output: {
          schema: { type: 'json' },
          render: renderJsonText,
        },
        async execute(args) {
          const action = args?.action || '';
          if (action === 'setup') return runAction('setup', args, deps);
          if (action === 'update_all') return runAction('update', args, deps);
          return runAction('upstream', args, deps);
        },
      })
    )
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'sdd_bridge',
        description:
          'Thin read-mostly bridge between Spec Kit artifacts (specs/<NNN>/ and .specify/bugs/<slug>/) and Superpowers execution: inspect progress, install EARS+Non-Goals template overrides, or refresh specs/INDEX.md. Task checkboxes in tasks.md are owned by upstream /speckit.implement.',
        parameters: {
          action: {
            type: 'string',
            required: true,
            description: 'One of: inspect, install_overrides, restore_overrides, sync_index.',
          },
          cwd: {
            type: 'string',
            description: 'Repository root directory (defaults to process.cwd()).',
          },
          featureName: {
            type: 'string',
            description: 'Spec Kit feature folder under specs/ (e.g. "001-user-auth").',
          },
          bugSlug: {
            type: 'string',
            description: 'Spec Kit bug slug under .specify/bugs/ (e.g. "login-crash").',
          },
          overwrite: {
            type: 'boolean',
            description:
              'For action "install_overrides": overwrite a user-modified or outdated .specify/templates/overrides/spec-template.md (default false; the default path never touches hand edits).',
          },
          artifact: {
            type: 'string',
            description: 'For action "restore_overrides": restore only this artifact id (default: every snapshot in the manifest).',
          },
        },
        output: {
          schema: { type: 'json' },
          render: renderJsonText,
        },
        isConcurrencySafe: (args) => (args?.action || 'inspect') === 'inspect',
        async execute(args) {
          return runAction('bridge', args, deps);
        },
      })
    )
  );

  return disposers;
}
