/**
 * Five-zone read-only doctor. No writes, no network probes, deterministic
 * ordering, and a failure in one zone never suppresses the remaining zones.
 *
 * Zone status semantics:
 *   pass         at least one item ran and nothing failed
 *   fail         at least one item failed
 *   skipped      nothing was observable (empty zone, or every item is `skip`)
 *   not_executed an explicit dry-run was not requested, so nothing ran at all
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HOST_CAPABILITIES,
  HOST_KEYS,
  checkTrustFlags,
  isDisciplineSkill,
} from './host-capabilities.mjs';
import { resolveGuidanceSwitch } from './guidance.mjs';
import { readMarkers, classifyMarkers } from './marker.mjs';
import { scoreSkills } from './trigger.mjs';
import { selectSuperpowersDir } from './candidates.mjs';
import { DEFAULT_SUPERPOWERS_REPO } from './upstream.mjs';

/** Package root: src/core/doctor.mjs -> src/core -> src -> package root. */
const PKG_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Toolchain the kit shells out to, probed on PATH only.
 *
 * `specify` is required rather than optional: every host artifact this kit
 * renders (command skills, execution hooks) is produced by the Spec Kit CLI, so
 * a machine without it cannot install or repair a single integration end. The
 * doctor must report that as a failure instead of a warning (AC-07).
 */
const REQUIRED_TOOLS = ['node', 'npm', 'specify'];
const OPTIONAL_TOOLS = ['uv', 'git'];

/** Skill file naming used by the packaged extension commands. */
const HOOK_SKILL_RE = /^speckit-superpowers-hooks-[A-Za-z0-9-]+(?:\.md)?$/;

/** Integration keys are what `.specify/integration*.yml|json` records; hosts are their DSH keys. */
const INTEGRATION_KEY_TO_HOST = Object.freeze(Object.fromEntries(
  HOST_KEYS.map((host) => [HOST_CAPABILITIES[host].integrationKey, host])
));

/** The four hook skills that actually render as host skills (guard/guidance are event-only). */
const EXECUTION_HOOK_COMMANDS = Object.freeze([
  'speckit-superpowers-hooks-before-implement',
  'speckit-superpowers-hooks-after-implement',
  'speckit-superpowers-hooks-before-bug-fix',
  'speckit-superpowers-hooks-after-bug-fix',
]);

/** Six contract hook events defined by spec-kit-extension/extension.yml. */
const HOOK_EVENTS = Object.freeze([
  'before_clarify', 'before_plan', 'before_implement', 'after_implement', 'before_bug_fix', 'after_bug_fix',
]);

/** Concrete commands (REQ-34): every failed probe carries an actionable fix. */
const TOOL_FIX_COMMANDS = Object.freeze({
  node: 'nvm install --lts && nvm use --lts',
  npm: 'npm install -g npm',
  uv: 'curl -LsSf https://astral.sh/uv/install.sh | sh',
  specify: 'uv tool install specify-cli --from git+https://github.com/github/spec-kit.git',
  git: 'apt-get install -y git（或：brew install git）',
});

/** User-authored skills win same-name conflicts: the kit must never shadow them (REQ-46). */
const SKILL_PROVIDER_ORDER = ['user', 'host', 'project', 'plugin', 'bundled'];

function item(status, code, message, fix, extra) {
  return { status, code, message, fix, ...(extra ? { ...extra } : {}) };
}

function aggregate(items) {
  if (items.length === 0) return 'skipped';
  if (items.some((entry) => entry.status === 'fail')) return 'fail';
  if (items.every((entry) => entry.status === 'skip')) return 'skipped';
  return 'pass';
}

function zone(items) {
  return { status: aggregate(items), items };
}

function findOnPath(binary, env, platform = process.platform) {
  // PATH is platform-shaped: ';' on Windows, ':' elsewhere. The doctor never
  // guesses suffix variants on POSIX; Windows honours PATHEXT plus the three
  // built-in executable suffixes even when PATHEXT is absent.
  const delimiter = platform === 'win32' ? path.win32.delimiter : path.posix.delimiter;
  const paths = String(env?.PATH ?? '').split(delimiter).filter(Boolean);
  let candidates = [binary];
  if (platform === 'win32') {
    const fromEnv = String(env?.PATHEXT ?? '').split(delimiter).filter(Boolean);
    const extensions = [...new Set([...fromEnv, '.exe', '.cmd', '.ps1'].map((ext) => ext.toLowerCase()))];
    candidates = extensions.map((ext) => (binary.toLowerCase().endsWith(ext) ? binary : `${binary}${ext}`));
  }
  return paths.some((dir) => candidates.some((candidate) => {
    try {
      fs.accessSync(path.join(dir, candidate), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }));
}

async function readableDir(dir) {
  if (!dir) return false;
  try {
    await fsp.access(dir, fs.constants.R_OK);
    return (await fsp.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function environmentZone({ env, platform = process.platform }) {
  const items = [];
  const major = Number(process.versions.node.split('.')[0]);
  items.push(major >= 18
    ? item('pass', 'NODE_VERSION', `Node ${process.versions.node} 满足 >=18`, '无需处理。')
    : item('fail', 'NODE_VERSION', `Node ${process.versions.node} 低于 18`, TOOL_FIX_COMMANDS.node));
  for (const binary of REQUIRED_TOOLS) {
    items.push(findOnPath(binary, env, platform)
      ? item('pass', `TOOL_${binary.toUpperCase()}`, `${binary} 已在 PATH 中`, '无需处理。')
      : item('fail', `TOOL_${binary.toUpperCase()}`, `${binary} 不在 PATH 中`, TOOL_FIX_COMMANDS[binary]));
  }
  for (const binary of OPTIONAL_TOOLS) {
    items.push(findOnPath(binary, env, platform)
      ? item('pass', `TOOL_${binary.toUpperCase()}`, `${binary} 已在 PATH 中`, '无需处理。')
      : item('warn', `TOOL_${binary.toUpperCase()}`, `${binary} 不在 PATH 中`, TOOL_FIX_COMMANDS[binary]));
  }

  // Read-only mirror probe: declared sources only, never a network fetch.
  //
  // A missing mirror is a `fail`, not a `warn` (AC-07). The upstream mirror is
  // where the discipline skills come from, so without it the guidance bundle has
  // no upstream text to reference and the environment is not merely degraded —
  // it cannot deliver the kit's core promise. Reporting `warn` here while the
  // zone still said `pass` was exactly the dishonesty the review flagged (I5).
  const selection = await selectSuperpowersDir({}, env ?? {});
  const mirrorDir = selection.realPath;
  const mirrorReadable = await readableDir(mirrorDir);
  items.push(mirrorReadable
    ? item('pass', 'UPSTREAM_MIRROR', `上游镜像可读：${mirrorDir}（via ${selection.reason}）`, '无需处理。', { path: mirrorDir, via: selection.reason })
    : item('fail', 'UPSTREAM_MIRROR', `上游镜像不可读：${selection.dir}（via ${selection.reason}）`, `git clone --depth 1 ${DEFAULT_SUPERPOWERS_REPO} ${selection.dir}`, { path: selection.dir, via: selection.reason }));

  const skillsRoot = mirrorReadable ? path.join(mirrorDir, 'skills') : null;
  let skillCount = 0;
  if (skillsRoot) {
    try {
      for (const entry of await fsp.readdir(skillsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
          await fsp.access(path.join(skillsRoot, entry.name, 'SKILL.md'));
          skillCount += 1;
        } catch { /* an incomplete skill directory is not a usable discipline skill */ }
      }
    } catch { /* unreadable skills root is diagnosed below */ }
  }
  items.push(skillCount > 0
    ? item('pass', 'DISCIPLINE_SKILLS', `在 ${skillsRoot} 中读取到 ${skillCount} 个纪律技能`, '无需处理。', { count: skillCount, path: skillsRoot })
    : item('fail', 'DISCIPLINE_SKILLS', `纪律技能目录缺失或不可读：${skillsRoot ?? path.join(selection.dir, 'skills')}`, `specify self upgrade && git -C ${mirrorDir ?? selection.dir} pull --ff-only`, { count: 0, path: skillsRoot ?? path.join(selection.dir, 'skills') }));

  items.push(item(
    'skip', 'NETWORK_PROBE',
    '为保持 doctor 只读且有界，故意不执行网络探测',
    '网络相关检查请在 CI 矩阵中运行。'
  ));
  return zone(items);
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function readText(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** Packaged extension command basenames, mapped to their skill directory names. */
async function packagedCommandSkills() {
  const dir = path.join(PKG_ROOT, 'spec-kit-extension', 'commands');
  let names = [];
  try {
    names = (await fsp.readdir(dir)).filter((name) => name.endsWith('.md')).sort();
  } catch {
    return [];
  }
  return names.map((name) => name.slice(0, -'.md'.length).replace(/\./g, '-'));
}

/** Skill names installed under a host skills directory (file or directory form). */
async function installedSkillNames(skillsDir) {
  let entries = [];
  try {
    entries = await fsp.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = new Set();
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!HOOK_SKILL_RE.test(entry.name)) continue;
    if (entry.isFile()) {
      found.add(entry.name.replace(/\.md$/, ''));
    } else if (entry.isDirectory()) {
      try {
        await fsp.access(path.join(skillsDir, entry.name, 'SKILL.md'));
        found.add(entry.name);
      } catch { /* an incomplete skill directory is not an installed skill */ }
    }
  }
  return [...found].sort();
}

function skillsDirFor(cwd, host) {
  const cap = HOST_CAPABILITIES[host];
  return cap ? path.join(cwd, cap.skillsDir) : null;
}

/**
 * Read-only view of the installed integrations recorded by the specify CLI.
 * Both on-disk spellings are supported; no other file is consulted.
 */
async function readIntegrationState({ cwd }) {
  const jsonFile = path.join(cwd, '.specify', 'integration.json');
  const jsonText = await readText(jsonFile);
  if (jsonText !== null) {
    try {
      const parsed = JSON.parse(jsonText);
      const listed = Array.isArray(parsed.installed_integrations)
        ? parsed.installed_integrations.filter((key) => typeof key === 'string' && key.length > 0)
        : [];
      const active = typeof (parsed.integration ?? parsed.default_integration) === 'string'
        ? (parsed.integration ?? parsed.default_integration)
        : null;
      if (listed.length > 0 || active) {
        const installed = [...new Set([...listed, ...(active ? [active] : [])])].sort((a, b) => a.localeCompare(b));
        return { source: jsonFile, installed, active };
      }
    } catch { /* malformed state is reported by other zones; try the YAML spelling */ }
  }

  const ymlFile = path.join(cwd, '.specify', 'integrations.yml');
  const ymlText = await readText(ymlFile);
  if (ymlText !== null) {
    const listed = [];
    let active = null;
    let inInstalled = false;
    for (const line of ymlText.split(/\r?\n/)) {
      const top = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (top) {
        inInstalled = /^(installed_integrations|installed)$/.test(top[1]);
        if (/^(integration|active_integration|default_integration)$/.test(top[1]) && top[2].trim()) {
          active = top[2].trim().replace(/^['"]|['"]$/g, '');
        }
        continue;
      }
      const entry = line.match(/^\s+-\s+([\w.-]+)\s*$/);
      if (inInstalled && entry) listed.push(entry[1]);
    }
    if (listed.length > 0 || active) {
      const installed = [...new Set([...listed, ...(active ? [active] : [])])].sort((a, b) => a.localeCompare(b));
      return { source: ymlFile, installed, active };
    }
  }
  return { source: null, installed: [], active: null };
}

function guidanceChannelFor(skill, cap) {
  const text = `${skill?.provider ?? ''} ${skill?.source ?? ''} ${skill?.path ?? ''}`.toLowerCase();
  if (/superpowers|mirror/.test(text)) return 'upstream-mirror';
  if (/plugin/.test(text)) return 'plugin';
  if (/user/.test(text)) return 'user-skills';
  return cap?.guidanceChannel ?? 'unknown';
}

async function skillVersionFromPath(skill) {
  if (typeof skill?.path !== 'string' || skill.path.length === 0) return null;
  const candidates = skill.path.endsWith('.md') ? [skill.path] : [path.join(skill.path, 'SKILL.md')];
  for (const file of candidates) {
    const text = await readText(file);
    if (!text) continue;
    const version = text.match(/^(?:version|\s{2}version):\s*['"]?([^\s'"]+)/m)?.[1];
    if (version) return version;
  }
  return null;
}

function isUserSkill(skill) {
  const source = String(skill?.source ?? '').toLowerCase();
  const provider = String(skill?.provider ?? '').toLowerCase();
  const pathText = String(skill?.path ?? '').replace(/\\/g, '/').toLowerCase();
  return provider === 'user' || /^user\b|^user[-_:]/.test(source)
    || /\/(?:\.dsh|\.claude|\.codex|\.cursor)\/skills\//.test(pathText);
}

function providerRank(provider) {
  const index = SKILL_PROVIDER_ORDER.indexOf(String(provider ?? '').toLowerCase());
  return index === -1 ? SKILL_PROVIDER_ORDER.length : index;
}

async function hostZone({ host, cwd, env, skills, trustFlags }) {
  const items = [];
  const cap = HOST_CAPABILITIES[host];
  items.push(cap
    ? item('pass', 'HOST_CAPABILITY', `host=${host} integration=${cap.integrationKey}`, '无需处理。')
    : item('fail', 'HOST_CAPABILITY', `未知 host：${host}`, `可用 host：${HOST_KEYS.join(', ')}。`));
  if (cap?.guidanceChannel === 'rule-dir') {
    // The capability pattern is the single source of truth: an unknown flag is
    // harmless, a configured trust/force flag is an explicit warning. The matcher
    // is imported statically from core — no adapter specifier is built here.
    const matched = checkTrustFlags({ args: trustFlags ?? [] }, cap);
    items.push(matched.length === 0
      ? item('pass', 'CURSOR_TRUST', '未配置自动信任的 dispatch flag', '无需处理。', { matched })
      : item('warn', 'CURSOR_TRUST', `检测到自动信任的 dispatch flag：${matched.join(' ')}；仅限受控项目使用`, '请从 dispatch 配置中移除这些 flag。', { matched }));
  }
  const visible = (skills ?? []).length;
  items.push(item('pass', 'VISIBLE_SKILLS', `已提供 ${visible} 个可见 skill`, '无需处理。'));
  const guidanceSwitch = await resolveGuidanceSwitch({ cwd, env });
  items.push(item(
    guidanceSwitch.warnings.length === 0 ? 'pass' : 'warn',
    'GUIDANCE_SCOPE',
    `enabled=${guidanceSwitch.enabled} effectiveScope=${guidanceSwitch.effectiveScope} source=${guidanceSwitch.source ?? 'default'}`,
    guidanceSwitch.warnings.length === 0 ? '无需处理。' : guidanceSwitch.warnings.join(' '),
    {
      enabled: guidanceSwitch.enabled,
      effectiveScope: guidanceSwitch.effectiveScope,
      source: guidanceSwitch.source,
    }
  ));
  const manifest = path.join(cwd, '.specify', 'extensions.yml');
  items.push(fs.existsSync(manifest)
    ? item('pass', 'EXTENSION_STATE', '项目扩展清单已找到', '无需处理。')
    : item('warn', 'EXTENSION_STATE', '未找到项目扩展清单', '请运行 specify extension add --dev spec-kit-extension。'));

  const integrationState = await readIntegrationState({ cwd });
  items.push(integrationState.source
    ? item(
      'pass', 'INTEGRATION_STATE',
      `已安装的集成：${integrationState.installed.join(', ')}；active=${integrationState.active ?? 'none'} source=${path.basename(integrationState.source)}`,
      '无需处理。',
      { installed: integrationState.installed, active: integrationState.active, source: integrationState.source }
    )
    : item(
      'skip', 'INTEGRATION_STATE',
      '未找到已安装集成清单，无法验证各宿主的渲染状态',
      '请运行 specify init --integration <host> 记录集成状态。',
      { installed: [], active: null, source: null }
    ));

  // Discipline guidance channel: report the real source/version carried by the
  // visible skill entries. The kit package version is only a labelled fallback
  // when no discipline skill is visible at all.
  if (cap) {
    const evidence = (skills ?? []).find(isDisciplineSkill) ?? null;
    let channel;
    let version;
    let source;
    let versionSource;
    if (evidence) {
      channel = guidanceChannelFor(evidence, cap);
      version = (await skillVersionFromPath(evidence)) ?? 'unknown';
      versionSource = version === 'unknown' ? 'skill-version-unavailable' : 'skill-metadata';
      source = String(evidence.source ?? evidence.provider ?? evidence.path ?? 'skill-entry');
    } else {
      const pkg = await readJson(path.join(PKG_ROOT, 'package.json'));
      channel = cap.guidanceChannel;
      version = pkg?.version ?? 'unknown';
      versionSource = 'kit-package-fallback';
      source = 'kit-package-fallback';
    }
    items.push(item(
      'pass', 'GUIDANCE_CHANNEL',
      `host=${host} channel=${channel} version=${version} source=${source} versionSource=${versionSource}`,
      evidence ? '无需处理。' : '请安装纪律技能，以报告真实的 channel 和 version。',
      {
        host, channel, version, source, versionSource,
        provider: evidence?.provider ?? null,
        path: evidence?.path ?? null,
      }
    ));
  } else {
    items.push(item('skip', 'GUIDANCE_CHANNEL', `host=${host} 的 guidance channel 未知`, '请选择受支持的 host。'));
  }

  // Hook command rendering: verify every installed integration end, not just
  // the current host. An uninstalled/inactive end must never be claimed healthy.
  const skillsDir = skillsDirFor(cwd, host);
  const rendered = skillsDir ? await installedSkillNames(skillsDir) : [];
  const renderedHooks = rendered.filter((name) => name.includes('hooks-'));
  const expectedNames = await packagedCommandSkills();
  const expected = expectedNames.length;
  if (!integrationState.source) {
    // No manifest means nothing about hook rendering is verifiable. Zero rendered
    // hook skills is therefore an unverified state, not a healthy one: claiming
    // `pass` while the message itself says `rendered=0 of 6` is the contradiction
    // review finding I4 called out. Only a host that actually rendered something
    // may pass without a manifest.
    const renderedSomething = renderedHooks.length > 0;
    items.push(item(
      renderedSomething ? 'pass' : 'warn', 'HOOK_RENDERING',
      `host=${host} rendered=${renderedHooks.length}/${expected} 个 hook command skill（无集成清单）`,
      renderedSomething
        ? '无需处理。'
        : '未找到集成清单，无法验证 hook 渲染；请运行 `specify integration switch <key>`（或安装 Spec Kit 扩展），再运行 `sdd-kit doctor`。',
      { host, rendered: renderedHooks, renderedCount: renderedHooks.length, expected, integrations: [] }
    ));
  } else {
    const checks = [];
    for (const key of integrationState.installed) {
      const endHost = INTEGRATION_KEY_TO_HOST[key] ?? null;
      const endCap = endHost ? HOST_CAPABILITIES[endHost] : null;
      const endDir = endCap ? path.join(cwd, endCap.skillsDir) : null;
      const names = endDir ? await installedSkillNames(endDir) : [];
      const hookNames = names.filter((name) => name.includes('hooks-'));
      const missingCommands = expectedNames.filter((name) => !names.includes(name));
      const missingHooks = EXECUTION_HOOK_COMMANDS.filter((name) => !names.includes(name));
      const active = key === integrationState.active;
      const fullyRendered = missingCommands.length === 0 && missingHooks.length === 0;
      const status = fullyRendered ? 'pass' : (hookNames.length === 0 && active ? 'fail' : 'warn');
      checks.push({
        integration: key,
        host: endHost,
        active,
        skillsDir: endCap?.skillsDir ?? null,
        rendered: names,
        renderedCount: names.length,
        expected,
        hookCount: hookNames.length,
        expectedHookEvents: [...HOOK_EVENTS],
        missingCommands,
        missingHooks,
        status,
        fix: status === 'pass'
          ? '无需处理。'
          : `specify integration switch ${key} && specify extension add --dev spec-kit-extension --force && 重启 ${endHost ?? key}`,
      });
    }
    checks.sort((a, b) => a.integration.localeCompare(b.integration));
    const worst = checks.some((entry) => entry.status === 'fail') ? 'fail'
      : checks.some((entry) => entry.status === 'warn') ? 'warn' : 'pass';
    const detail = checks.map((entry) => `${entry.integration}${entry.active ? '(active)' : ''}:${entry.renderedCount}/${entry.expected}`).join(', ');
    items.push(item(
      worst, 'HOOK_RENDERING',
      `host=${host} rendered=${renderedHooks.length}/${expected} 个 hook command skill；integrations=${detail}`,
      worst === 'pass' ? '无需处理。' : '请重新渲染缺失的宿主产物：specify integration switch <key> && specify extension add --dev spec-kit-extension --force。',
      { host, rendered: renderedHooks, renderedCount: renderedHooks.length, expected, integrations: checks }
    ));
  }
  return zone(items);
}

async function repositoryZone({ cwd, host }) {
  const items = [];
  const specifyDir = path.join(cwd, '.specify');
  items.push(fs.existsSync(specifyDir)
    ? item('pass', 'SPECIFY_DIR', '.specify/ 存在', '无需处理。')
    : item('fail', 'SPECIFY_DIR', '.specify/ 缺失', '请在本仓库运行 specify init。'));

  // Managed template override: compare the project copy with the packaged one.
  const packagedTemplate = path.join(PKG_ROOT, 'overrides', 'spec-template.md');
  const projectTemplate = path.join(cwd, '.specify', 'templates', 'overrides', 'spec-template.md');
  const [packagedText, projectText] = await Promise.all([
    readText(packagedTemplate),
    readText(projectTemplate),
  ]);
  if (packagedText === null) {
    items.push(item('warn', 'TEMPLATE_PACKAGED_MISSING', '套件中缺少打包的 overrides/spec-template.md', '请重新安装套件，或恢复 overrides/spec-template.md。'));
  } else if (projectText === null) {
    items.push(item('warn', 'TEMPLATE_MISSING', '项目缺少 .specify/templates/overrides/spec-template.md', '请运行 specify extension add --dev spec-kit-extension 安装该覆盖文件。'));
  } else if (projectText === packagedText) {
    items.push(item('pass', 'TEMPLATE_DRIFT', '项目模板覆盖文件与打包副本一致', '无需处理。'));
  } else {
    items.push(item('warn', 'TEMPLATE_DRIFT', '项目模板覆盖文件与打包副本不同', '请重新安装该覆盖文件，或在打包副本之上重新应用本地修改。'));
  }

  // Extension command skills installed into this host's skill directory.
  const expected = await packagedCommandSkills();
  const skillsDir = skillsDirFor(cwd, host);
  const installed = skillsDir ? await installedSkillNames(skillsDir) : [];
  const present = expected.filter((name) => installed.includes(name));
  const missing = expected.filter((name) => !installed.includes(name));
  items.push(item(
    missing.length === 0 ? 'pass' : 'warn',
    'COMMAND_SKILLS',
    `${present.length}/${expected.length} 个扩展 command skill 已安装${missing.length ? `；缺失：${missing.join(', ')}` : ''}`,
    missing.length === 0
      ? '无需处理。'
      : '请重新安装扩展，以渲染该 host 缺失的 command skill。',
    { installed: present, missing, expected }
  ));
  return zone(items);
}

/** Candidate bridge configuration files: explicit paths first, then well-known ones. */
function bridgeCandidates({ cwd, env }) {
  const candidates = [];
  const cap = HOST_CAPABILITIES.dsh;
  const hostPrefix = cap.key.toUpperCase();
  for (const key of ['SDD_BRIDGE_CONFIG', `${hostPrefix}_CONFIG`, `${hostPrefix}_PROFILE_DIR`]) {
    const value = env?.[key];
    if (typeof value !== 'string' || value.length === 0) continue;
    let isDir = false;
    try { isDir = fs.statSync(value).isDirectory(); } catch { /* a missing path is simply not a candidate */ }
    if (isDir) {
      candidates.push({ key, file: path.join(value, 'cordis.patch.yml') });
      candidates.push({ key, file: path.join(value, 'cordis.yml') });
      candidates.push({ key, file: path.join(value, 'package.json') });
    } else {
      candidates.push({ key, file: value });
    }
  }
  const hostRoot = path.dirname(cap.skillsDir);
  candidates.push({ key: 'cwd', file: path.join(cwd, hostRoot, 'cordis.patch.yml') });
  candidates.push({ key: 'cwd', file: path.join(cwd, hostRoot, 'cordis.yml') });
  candidates.push({ key: 'cwd', file: path.join(cwd, hostRoot, 'package.json') });
  return candidates;
}

async function probeBridgeSource({ cwd, env }) {
  const observed = [];
  for (const candidate of bridgeCandidates({ cwd, env })) {
    const text = await readText(candidate.file);
    if (text === null) continue;
    observed.push({ ...candidate, mounted: /dsh-sdd-kit|sdd-kit|superpowers/i.test(text) });
  }
  const mounted = observed.find((entry) => entry.mounted);
  const chosen = mounted ?? observed[0];
  if (!chosen) {
    return item(
      'skip', 'BRIDGE_SOURCE',
      '未从环境或仓库发现宿主桥接配置；未探测来源',
      `请将 SDD_BRIDGE_CONFIG（或 ${HOST_CAPABILITIES.dsh.key.toUpperCase()}_CONFIG）指向宿主插件配置以启用该探针。`
    );
  }
  const where = `${path.relative(cwd, chosen.file) || chosen.file}（via ${chosen.key}）`;
  return item(
    mounted ? 'pass' : 'warn',
    'BRIDGE_SOURCE',
    `桥接来源发现于 ${where}${mounted ? '；发现 sdd-kit 挂载' : '；未发现 sdd-kit 挂载'}`,
    mounted ? '无需处理。' : '请检查该 host 是否已挂载桥接插件。',
    { source: chosen.file, via: chosen.key, observed: observed.map((entry) => entry.file) }
  );
}

async function runtimeZone({ cwd, env, skills, now, sessionStart, runId }) {
  const items = [];
  const markers = await readMarkers({ cwd });
  const classified = classifyMarkers(markers, { now, sessionStart, runId });
  const pending = [...classified.pending].sort();
  const history = [...classified.history].sort();
  const markerFix = pending.length > 0
    ? `受影响的宿主重载后，请对每个待生效宿主运行 node bin/sdd-kit.mjs guidance --host <host> --cwd <repo> --clear-marker。`
    : '遗留项可通过 node bin/sdd-kit.mjs guidance --host <host> --cwd <repo> --clear-marker 清理。';
  if (pending.length > 0) {
    items.push(item(
      'warn', 'PENDING_MARKERS',
      `待生效标记：${pending.join(', ')}${history.length ? `；早期运行的历史记录：${history.join(', ')}` : ''}`,
      markerFix,
      { pending, history }
    ));
  } else if (history.length > 0) {
    items.push(item(
      'warn', 'PENDING_MARKERS',
      `无待生效标记，仅有早期运行的历史记录：${history.join(', ')}`,
      markerFix,
      { pending, history }
    ));
  } else {
    items.push(item('pass', 'PENDING_MARKERS', '无待生效的重载标记', '无需处理。', { pending, history }));
  }

  const visibleSkills = (skills ?? []).filter((skill) => skill?.name);
  const inventory = visibleSkills.map((skill) => ({
    name: skill.name,
    provider: skill.provider ?? 'unknown',
    path: skill.path ?? null,
    source: skill.source ?? 'unknown',
  }));
  items.push(inventory.length > 0
    ? item(
      'pass', 'SKILL_INVENTORY',
      `可见 skill：${inventory.map((entry) => `${entry.name}(${entry.provider})`).join(', ')}`,
      '无需处理。',
      { skills: inventory }
    )
    : item('skip', 'SKILL_INVENTORY', '没有可盘点的可见 skill', '请在运行 doctor 前加载 skill provider。', { skills: [] }));

  // Same-name conflicts report the winner and its deterministic provider order.
  const byName = new Map();
  visibleSkills.forEach((skill, index) => {
    const provider = skill.provider ?? 'unknown';
    if (!byName.has(skill.name)) byName.set(skill.name, []);
    byName.get(skill.name).push({ skill, provider, index, source: skill.source ?? 'unknown' });
  });
  const sortByPriority = (a, b) => providerRank(a.provider) - providerRank(b.provider) || a.index - b.index;
  const conflicts = [];
  for (const [name, entries] of [...byName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const providers = [...new Set(entries.map((entry) => entry.provider))].sort((a, b) => a.localeCompare(b));
    if (providers.length < 2) continue;
    const ordered = [...entries].sort(sortByPriority);
    const winner = ordered[0];
    conflicts.push({
      name,
      providers,
      order: ordered.map((entry) => entry.provider),
      origins: entries.map((entry) => `${entry.provider}:${entry.source}`),
      winner: {
        name,
        provider: winner.provider,
        source: winner.source,
        path: winner.skill.path ?? null,
        origin: isUserSkill(winner.skill) ? 'user' : 'bundled',
      },
    });
  }
  items.push(conflicts.length === 0
    ? item('pass', 'SKILL_CONFLICT', '无跨 provider 的 skill 名称冲突', '无需处理。', { conflicts: [] })
    : item(
      'warn', 'SKILL_CONFLICT',
      `存在 skill 名称冲突：${conflicts.map((entry) => `${entry.name}（${entry.origins.join(' / ')}；winner=${entry.winner.provider}）`).join(', ')}`,
      '请停用冲突的 provider 之一；用户自有 skill 保持优先。',
      { conflicts }
    ));

  // User-authored skills are explicitly labelled as non-kit artifacts so they
  // are never mistaken for kit drift or silently managed by the kit.
  const userSkills = visibleSkills.filter(isUserSkill).map((skill) => ({
    name: skill.name,
    provider: skill.provider ?? 'unknown',
    source: skill.source ?? 'unknown',
    path: skill.path ?? null,
  }));
  const kitSkills = visibleSkills.filter((skill) => !isUserSkill(skill)).map((skill) => ({
    name: skill.name,
    provider: skill.provider ?? 'unknown',
    source: skill.source ?? 'unknown',
    path: skill.path ?? null,
  }));
  items.push(item(
    'pass', 'SKILL_PROVENANCE',
    userSkills.length > 0
      ? `${userSkills.length} 个用户自有 skill 标记为非本套件产物：${userSkills.map((entry) => entry.name).join(', ')}`
      : '未观察到用户自有 skill',
    userSkills.length > 0 ? '请勿改动用户自有 skill；套件仅管理自身产物。' : '无需处理。',
    { userSkills, bundled: kitSkills }
  ));

  items.push(await probeBridgeSource({ cwd, env }));
  return zone(items);
}

function triggerZone({ trigger, skills }) {
  if (!trigger) {
    return {
      status: 'not_executed',
      items: [item('skip', 'TRIGGER_NOT_PROVIDED', '未执行 dry-run：未提供 --trigger', '请传入 --trigger "<task description>" 以对可见 skill 评分。')],
    };
  }
  const visible = skills ?? [];
  if (visible.length === 0) {
    return {
      status: 'skipped',
      items: [item('skip', 'TRIGGER_NO_VISIBLE_SKILLS', '未执行 dry-run：没有可评分的可见 skill', '请在运行 trigger dry-run 前加载 skill provider。')],
    };
  }
  const scores = scoreSkills(trigger, visible);
  return {
    status: 'pass',
    items: [item('pass', 'TRIGGER_SCORES', `已对 ${scores.length} 个可见 skill 评分，未执行任何操作。`, '无需处理。', { scores })],
  };
}

async function safe(name, runner, fallback) {
  try {
    return await runner();
  } catch (error) {
    return fallback(error);
  }
}

/**
 * @param {object} options
 * @param {string} options.trigger optional task description for the dry-run zone
 * @param {string} options.host current host key
 * @param {string} options.cwd repository root (read only)
 * @param {object} [options.env] environment used for PATH and bridge discovery
 * @param {Array} options.skills visible SkillSummary[] (no mirror-only entries)
 * @param {object} [options.deps] zone overrides for tests
 */
export async function runDoctor({
  trigger,
  host = HOST_CAPABILITIES.dsh.key,
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  skills = [],
  trustFlags = [],
  now,
  sessionStart,
  runId,
  deps = {},
} = {}) {
  const failZone = (error) => zone([item('fail', 'ZONE_PROBE_ERROR', error?.message ?? String(error), '请修复探针错误后重新运行 doctor。')]);
  const [environment, hostReport, repository, runtime, triggerDryRun] = await Promise.all([
    safe('environment', () => deps.environment ? deps.environment() : environmentZone({ env, platform }), failZone),
    safe('host', () => deps.host ? deps.host() : hostZone({ host, cwd, env, skills, trustFlags }), failZone),
    safe('repository', () => deps.repository ? deps.repository() : repositoryZone({ cwd, host }), failZone),
    safe('runtime', () => deps.runtime ? deps.runtime() : runtimeZone({ cwd, env, skills, now, sessionStart, runId }), failZone),
    safe('triggerDryRun', () => deps.triggerDryRun ? deps.triggerDryRun() : triggerZone({ trigger, skills }), failZone),
  ]);
  return { environment, host: hostReport, repository, runtime, triggerDryRun };
}
