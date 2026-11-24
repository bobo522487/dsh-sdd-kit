/**
 * Host capability table — the single editable source of host differences.
 * Core modules must stay free of host-only package names and registration APIs;
 * all per-host facts (integration key, tool prefix, skill directory, guidance
 * channel, reload semantics, trust flag pattern) live here.
 */

const RELOAD_KEYS = ['tool_code', 'skill_data', 'extension_command'];

function freezeCapabilities(entries) {
  for (const [key, cap] of Object.entries(entries)) {
    Object.freeze(cap.reloadPolicy);
    Object.freeze(cap.guidanceConfig);
    Object.freeze(cap);
    if (cap.key !== key) throw new Error(`HOST_CAPABILITIES key mismatch: ${key}`);
    for (const layer of RELOAD_KEYS) {
      if (!['restart_host', 'new_session', 'none'].includes(cap.reloadPolicy[layer])) {
        throw new Error(`invalid reloadPolicy for ${key}.${layer}`);
      }
    }
  }
  return Object.freeze(entries);
}

export const HOST_CAPABILITIES = freezeCapabilities({
  dsh: {
    key: 'dsh',
    integrationKey: 'dsh',
    toolPrefix: '@',
    skillsDir: '.dsh/skills',
    guidanceChannel: 'system-prompt',
    guidanceConfig: Object.freeze({
      service: 'systemPrompt',
      sectionName: 'sdd-kit:discipline',
      sectionOrderAnchor: 'PLAN_POLICY',
      sectionOrderOffset: 1,
    }),
    reloadPolicy: Object.freeze({
      tool_code: 'restart_host',
      skill_data: 'new_session',
      extension_command: 'new_session',
    }),
    trustFlagPattern: null,
  },
  claude: {
    key: 'claude',
    integrationKey: 'claude',
    toolPrefix: '/',
    skillsDir: '.claude/skills',
    guidanceChannel: 'native-event',
    guidanceConfig: Object.freeze({
      event: 'session_start',
      managedBlockPath: '.claude/sdd-kit-discipline.md',
    }),
    reloadPolicy: Object.freeze({
      tool_code: 'new_session',
      skill_data: 'new_session',
      extension_command: 'new_session',
    }),
    trustFlagPattern: null,
  },
  codex: {
    key: 'codex',
    integrationKey: 'codex',
    toolPrefix: '$',
    skillsDir: '.agents/skills',
    guidanceChannel: 'managed-block',
    guidanceConfig: Object.freeze({
      managedBlockPath: '.codex/sdd-kit-discipline.md',
      markerStart: '<!-- sdd-kit:discipline:start -->',
      markerEnd: '<!-- sdd-kit:discipline:end -->',
    }),
    reloadPolicy: Object.freeze({
      tool_code: 'new_session',
      skill_data: 'new_session',
      extension_command: 'new_session',
    }),
    trustFlagPattern: null,
  },
  cursor: {
    key: 'cursor',
    integrationKey: 'cursor-agent',
    toolPrefix: '/',
    skillsDir: '.cursor/skills',
    guidanceChannel: 'rule-dir',
    guidanceConfig: Object.freeze({
      rulePath: '.cursor/rules/sdd-kit-discipline.mdc',
    }),
    reloadPolicy: Object.freeze({
      tool_code: 'new_session',
      skill_data: 'new_session',
      extension_command: 'none',
    }),
    trustFlagPattern: /--trust\b|--approve-mcps\b|--force\b|(?:^|\s)-p(?:\s|$)/,
  },
});

export const HOST_KEYS = Object.freeze(Object.keys(HOST_CAPABILITIES));

export function getHostCapability(host) {
  return HOST_CAPABILITIES[host] ?? null;
}
