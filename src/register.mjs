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
          '直接委托上游 GitHub Spec Kit（specify CLI）并同步本地 obra/superpowers Git 镜像（~/.dsh/upstream/superpowers），不重新实现两者。使用 action "update_all" 可在一次调用中检查并更新两层上游（Spec Kit + Superpowers）；action "doctor"、"guard"、"guidance" 也经 action 字段委托，因此无需第三个宿主工具。升级 dsh-sdd-kit 本身由包管理器负责（dsh plugin update dsh-sdd-kit --latest，随后重启 DSH）。',
        parameters: {
          action: {
            type: 'string',
            required: true,
            description:
              '取值之一：setup、status、sync_superpowers、specify_upgrade、specify_init、ensure_integration_commands、install_bug_ext、install_hooks_ext、switch_integration、update_all、doctor、guard、guidance。',
          },
          cwd: {
            type: 'string',
            description: '仓库根目录（缺省为 process.cwd()）。',
          },
          candidateDirs: {
            type: 'array',
            items: { type: 'string' },
            description:
              '对 action "status" 与 "sync_superpowers"：额外镜像候选目录（声明索引 1，位于显式 superpowersDir 与 DSH_SDD_KIT_SUPERPOWERS_DIR / DSH_HOME / 默认 ~/.dsh 之间）。按 realpath 去重，取 mtime 最新者。',
          },
          switchIntegration: {
            type: 'boolean',
            description: '对 action "setup"：显式选择把非 dsh 集成切换到 dsh，然后重装钩子（默认 false；默认路径只报告不匹配）。',
          },
          upgrade: {
            type: 'boolean',
            description: '对 action "setup"：即使已安装也强制升级 specify-cli（默认 false）。',
          },
          integration: {
            type: 'string',
            description: 'specify_init 使用的 Spec Kit 集成键（默认 "dsh"，会在 DSH 默认技能根写入 .dsh/skills）。',
          },
          useSkills: {
            type: 'boolean',
            description: '选择加入已废弃的 --integration-options=--skills 参数（默认 false；新版 spec-kit 默认安装技能）。',
          },
          python: {
            type: 'string',
            description: '全新安装 specify-cli 时使用的 Python 解释器（默认 3.14；若稳定版不同可覆盖）。',
          },
          superpowersDir: {
            type: 'string',
            description: '覆盖本地 obra/superpowers 镜像路径（默认 ~/.dsh/upstream/superpowers）。',
          },
          repoUrl: {
            type: 'string',
            description: '覆盖上游 superpowers Git 地址。',
          },
          extensionDir: {
            type: 'string',
            description:
              '对 action "install_hooks_ext"：覆盖 Spec Kit 扩展源目录（默认为包内 spec-kit-extension/）。',
          },
          extensionChanges: {
            type: 'array',
            items: { type: 'object' },
            description:
              '对 action "update_all"：宿主集成已应用的扩展/命令变更。每条记录作为 extension_command 组件上报，使更新报告与重载判定都能看到扩展层。',
          },
          reinstallExtension: {
            type: 'boolean',
            description:
              '对 action "update_all"：作为更新的一部分重装 Spec Kit 扩展（install_hooks_ext），并把结果作为 extension_command 组件上报（默认 false）。',
          },
          trigger: {
            type: 'string',
            description:
              '对 action "doctor"：在只读 triggerDryRun 区打分的任务描述字符串；不会执行技能。',
          },
          host: {
            type: 'string',
            description: 'action "doctor" 与 "guidance" 的宿主键（默认 "dsh"）。',
          },
          skills: {
            type: 'array',
            items: { type: 'object' },
            description:
              'action "doctor" 与 "guidance" 可见的 SkillSummary[]（插件 + 用户安装技能，不含仅镜像中的条目）。',
          },
          trustFlags: {
            type: 'array',
            items: { type: 'string' },
            description: '对 action "doctor"：需要报告的 Cursor 自动信任分发参数。',
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
          if (action === 'doctor' || action === 'guard' || action === 'guidance') {
            return runAction(action, args, deps);
          }
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
          'Spec Kit 工件（specs/<NNN>/ 与 .specify/bugs/<slug>/）与 Superpowers 执行之间的薄只读桥：检查进度、安装 EARS+Non-Goals 模板覆盖，或刷新 specs/INDEX.md。tasks.md 的任务勾选由上游 /speckit.implement 独占。',
        parameters: {
          action: {
            type: 'string',
            required: true,
            description: '取值之一：inspect、install_overrides、restore_overrides、sync_index。',
          },
          cwd: {
            type: 'string',
            description: '仓库根目录（缺省为 process.cwd()）。',
          },
          featureName: {
            type: 'string',
            description: 'specs/ 下的 Spec Kit 特性目录（如 "001-user-auth"）。',
          },
          bugSlug: {
            type: 'string',
            description: '.specify/bugs/ 下的 Spec Kit bug slug（如 "login-crash"）。',
          },
          overwrite: {
            type: 'boolean',
            description:
              '对 action "install_overrides"：覆盖用户修改或过期的 .specify/templates/overrides/spec-template.md（默认 false；默认路径不触碰手工修改）。',
          },
          artifact: {
            type: 'string',
            description: '对 action "restore_overrides"：只恢复该工件 id（默认恢复清单中的所有快照）。',
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
