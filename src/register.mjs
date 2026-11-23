import { runUpstream } from './core/upstream.mjs';
import { runBridge } from './core/bridge.mjs';
import { runUpdate } from './core/update.mjs';

function renderJsonText(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

export function registerSddTools(ctx, defineTool, deps = {}) {
  const disposers = [];
  const runUpdateImpl = deps.runUpdate ?? runUpdate;

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'sdd_upstream',
        description:
          'Delegate directly to upstream GitHub Spec Kit (specify CLI) and sync the local obra/superpowers Git mirror (~/.dsh/upstream/superpowers) without reimplementing either tool. Use action "update_all" to check and update Spec Kit, Superpowers, and the installed dsh-sdd-kit profile copy in one invocation.',
        parameters: {
          action: {
            type: 'string',
            required: true,
            description:
              'One of: status, sync_superpowers, specify_upgrade, specify_init, install_bug_ext, update_all.',
          },
          cwd: {
            type: 'string',
            description: 'Repository root directory (defaults to process.cwd()).',
          },
          integration: {
            type: 'string',
            description: 'Spec Kit integration key for specify_init (default "claude").',
          },
          useSkills: {
            type: 'boolean',
            description: 'Opt in to the deprecated --integration-options=--skills flag (default false; new spec-kit installs skills by default).',
          },
          force: {
            type: 'boolean',
            description: 'Deprecated/no-op: specify_init always passes --force now.',
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
          dshKitSourceDir: {
            type: 'string',
            description:
              'Local dsh-sdd-kit checkout to copy into the DSH profile for action "update_all" (required for that component).',
          },
          dshProfileDir: {
            type: 'string',
            description:
              'DSH profile root for action "update_all" (defaults to $DSH_PROFILE_DIR, then ~/.dsh/profiles/${DSH_PROFILE:-web}).',
          },
        },
        output: {
          schema: { type: 'json' },
          render: renderJsonText,
        },
        async execute(args) {
          if ((args?.action || '') === 'update_all') return runUpdateImpl(args);
          return runUpstream(args);
        },
      })
    )
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'sdd_bridge',
        description:
          'Thin bridge between Spec Kit artifacts (specs/<NNN>/ and .specify/bugs/<slug>/) and Superpowers execution: inspect progress, install EARS+Non-Goals template overrides, check off tasks.md items, or refresh specs/INDEX.md.',
        parameters: {
          action: {
            type: 'string',
            required: true,
            description: 'One of: inspect, install_overrides, check_task, sync_index.',
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
          taskMatch: {
            type: 'string',
            description: 'Task ID or unique substring to mark [x] for action="check_task".',
          },
          overwrite: {
            type: 'boolean',
            description: 'Overwrite existing .specify/templates/overrides/spec-template.md when true.',
          },
        },
        output: {
          schema: { type: 'json' },
          render: renderJsonText,
        },
        isConcurrencySafe: (args) => (args?.action || 'inspect') === 'inspect',
        async execute(args) {
          return runBridge(args);
        },
      })
    )
  );

  return disposers;
}
