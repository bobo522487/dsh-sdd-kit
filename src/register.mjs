import { runUpstream } from './core/upstream.mjs';
import { runBridge } from './core/bridge.mjs';

function renderJsonText(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

export function registerSddTools(ctx, defineTool) {
  const disposers = [];

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'sdd_upstream',
        description:
          'Delegate directly to upstream GitHub Spec Kit (specify CLI) and sync the local obra/superpowers Git mirror (~/.dsh/upstream/superpowers) without reimplementing either tool.',
        parameters: {
          action: {
            type: 'string',
            required: true,
            description: 'One of: status, sync_superpowers, specify_upgrade, specify_init, install_bug_ext.',
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
            description: 'Pass --integration-options=--skills on specify_init (default true).',
          },
          force: {
            type: 'boolean',
            description: 'Pass --force on specify_init when re-initializing.',
          },
          superpowersDir: {
            type: 'string',
            description: 'Override local obra/superpowers mirror path (default ~/.dsh/upstream/superpowers).',
          },
          repoUrl: {
            type: 'string',
            description: 'Override upstream superpowers git URL.',
          },
        },
        output: {
          schema: { type: 'json' },
          render: renderJsonText,
        },
        async execute(args) {
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
