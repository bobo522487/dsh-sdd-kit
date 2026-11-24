/**
 * Host capability table — the single editable source of host differences.
 * Core modules must stay free of host-only package names and registration APIs;
 * all per-host facts (integration key, tool prefix, skill directory, guidance
 * channel, reload semantics, trust flag pattern) live here.
 */

const RELOAD_KEYS = ['tool_code', 'skill_data', 'extension_command'];

/** Installed Spec Kit extension directory name; adapters must not hard-code it. */
export const EXTENSION_ID = 'superpowers-hooks';

/**
 * Host-neutral invocation face: every non-DSH host reaches the same core actions
 * through the CLI (`bin/sdd-kit.mjs`), so guidance never names a DSH-only tool.
 */
export const HOST_NEUTRAL_TOOL_NAMES = Object.freeze({
  upstream: 'sdd-kit update',
  bridge: 'sdd-kit bridge',
  doctor: 'sdd-kit doctor',
  guard: 'sdd-kit guard',
  guidance: 'sdd-kit guidance',
});

const DSH_TOOL_NAMES = Object.freeze({
  upstream: 'sdd_upstream',
  bridge: 'sdd_bridge',
  doctor: 'sdd_upstream',
  guard: 'sdd_upstream',
  guidance: 'sdd_upstream',
});

/**
 * Managed-block markers, shared by every host whose guidance channel writes a
 * marked block into a file (Codex managed block, Claude fallback block). Keeping
 * one definition means an adapter never has to borrow another host's config.
 */
const MANAGED_BLOCK_MARKERS = Object.freeze({
  markerStart: '<!-- sdd-kit:discipline:start -->',
  markerEnd: '<!-- sdd-kit:discipline:end -->',
});

function freezeCapabilities(entries) {
  for (const [key, cap] of Object.entries(entries)) {
    Object.freeze(cap.reloadPolicy);
    Object.freeze(cap.guidanceConfig);
    Object.freeze(cap.toolNames);
    Object.freeze(cap);
    if (cap.key !== key) throw new Error(`HOST_CAPABILITIES 键不匹配：${key}`);
    for (const layer of RELOAD_KEYS) {
      if (!['restart_host', 'new_session', 'none'].includes(cap.reloadPolicy[layer])) {
        throw new Error(`无效的 reloadPolicy：${key}.${layer}`);
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
    toolNames: DSH_TOOL_NAMES,
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
    toolNames: HOST_NEUTRAL_TOOL_NAMES,
    skillsDir: '.claude/skills',
    guidanceChannel: 'native-event',
    guidanceConfig: Object.freeze({
      event: 'session_start',
      managedBlockPath: '.claude/sdd-kit-discipline.md',
      ...MANAGED_BLOCK_MARKERS,
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
    toolNames: HOST_NEUTRAL_TOOL_NAMES,
    skillsDir: '.agents/skills',
    guidanceChannel: 'managed-block',
    guidanceConfig: Object.freeze({
      managedBlockPath: '.codex/sdd-kit-discipline.md',
      ...MANAGED_BLOCK_MARKERS,
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
    toolNames: HOST_NEUTRAL_TOOL_NAMES,
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

/**
 * Match configured dispatch flags against a host's `trustFlagPattern`.
 *
 * This is a pure function of the capability table — it reads no files, imports
 * no adapter, and holds no host-specific knowledge beyond the declared pattern.
 * It lives in core (rather than in a host-side adapter module) so callers such
 * as the read-only doctor can report trust flags without a runtime import of an
 * adapter path, which would breach the core-purity contract (AC-01).
 *
 * @param {{args?: string[]}|string[]|string|undefined|null} input flag list, or an object carrying `args`
 * @param {object} [cap] capability entry; defaults to the cursor capability
 * @returns {string[]} the flags that match the pattern, in input order
 */
export function checkTrustFlags(input, cap = HOST_CAPABILITIES.cursor) {
  const pattern = cap?.trustFlagPattern;
  if (!pattern) return [];
  const source = typeof input === 'string'
    ? input
    : (Array.isArray(input) ? input : (input?.args ?? []));
  const flags = Array.isArray(source) ? source : String(source).split(/\s+/);
  return flags.filter((arg) => pattern.test(arg));
}

/**
 * Discipline skill names shipped by the upstream Superpowers mirror.
 *
 * This is the ONE list: the read-only doctor, the guidance assembly and every
 * host adapter import it from here. Duplicating it per caller is how Claude's
 * copy drifted to 14 entries and silently dropped `diagnosing-superpowers`
 * (review finding I9), so the list lives in core and nowhere else.
 *
 * Frozen array (not a Set) so immutability is actually enforced at runtime —
 * `Object.freeze` does not stop `Set.prototype.add`.
 */
export const DISCIPLINE_SKILL_NAMES = Object.freeze([
  'brainstorming',
  'diagnosing-superpowers',
  'dispatching-parallel-agents',
  'executing-plans',
  'finishing-a-development-branch',
  'receiving-code-review',
  'requesting-code-review',
  'subagent-driven-development',
  'systematic-debugging',
  'test-driven-development',
  'using-git-worktrees',
  'using-superpowers',
  'verification-before-completion',
  'writing-plans',
  'writing-skills',
]);

const DISCIPLINE_SKILL_INDEX = new Set(DISCIPLINE_SKILL_NAMES);
const DISCIPLINE_PROVENANCE = /superpowers|upstream-mirror|plugin:/;

/**
 * Pure predicate answering "is this a discipline skill?".
 *
 * Two call shapes share one rule, which is exactly why it belongs in core: the
 * Claude adapter asks about a bare name (what the host reports as installed),
 * while the doctor asks about a discovered skill record and also needs the
 * provenance fallback for skills installed under an unrecognised name.
 *
 * @param {string|{name?: string, provider?: string, source?: string, path?: string}|null|undefined} input
 * @returns {boolean}
 */
export function isDisciplineSkill(input) {
  if (typeof input === 'string') {
    const name = input.trim();
    if (name.length === 0) return false;
    return /^speckit-/.test(name) || DISCIPLINE_SKILL_INDEX.has(name);
  }
  if (!input || typeof input !== 'object') return false;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length > 0 && (/^speckit-/.test(name) || DISCIPLINE_SKILL_INDEX.has(name))) return true;
  const provenance = `${input.provider ?? ''} ${input.source ?? ''} ${input.path ?? ''}`.toLowerCase();
  return DISCIPLINE_PROVENANCE.test(provenance);
}

/** Does any entry in a discovered skill list belong to the discipline set? */
export function hasDisciplineSkills(entries = []) {
  return Array.isArray(entries) ? entries.some((entry) => isDisciplineSkill(entry)) : false;
}
