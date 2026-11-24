#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = path.join(PKG_ROOT, 'spec-kit-extension');
const HOOK_EVENTS = [
  'before_implement', 'after_implement', 'before_bug_fix', 'after_bug_fix',
  'before_clarify', 'before_plan',
];
const NETWORK_PATTERN = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|Temporary failure in name resolution/i;

async function run(cmd, args, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, code: 0, stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), command: `${cmd} ${args.join(' ')}` };
  } catch (error) {
    return {
      ok: false,
      // Keep the string code (ENOENT) so callers can tell "absent" from "broken".
      code: typeof error.code === 'number' ? error.code : (typeof error.code === 'string' ? error.code : 1),
      stdout: (error.stdout || '').trim(),
      stderr: (error.stderr || error.message || '').trim(),
      command: `${cmd} ${args.join(' ')}`,
    };
  }
}

async function probe(cmd, args) {
  const result = await run(cmd, args, PKG_ROOT);
  // Only a genuinely absent executable counts as "environment unavailable".
  // A tool that exists but rejects --version is a contract failure we must report.
  if (!result.ok && result.code === 'ENOENT') return null;
  if (!result.ok) return 'unknown';
  const firstLine = result.stdout.split('\n')[0] ?? '';
  const version = firstLine.replace(new RegExp(`^${cmd}\\s+`), '').trim();
  return version || firstLine || 'unknown';
}

function snippet(text) {
  return (text || '').slice(0, 2000);
}

/** `>=1.4.0` → [1, 4, 0]; anything unparsable → null. */
function parseBound(text) {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(text ?? ''));
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/** `>=0.2.2-rc.3` / `1.4.4.dev0` → `rc.3` / `dev0`; finals → null. */
function parsePrerelease(text) {
  const match = /^[^\d]*\d+(?:\.\d+){0,2}[.\-+]([A-Za-z][0-9A-Za-z.-]*)/.exec(String(text ?? '').trim());
  return match?.[1] ?? null;
}

/** Semver prerelease identifier order: numeric < non-numeric, then lexical. */
function comparePrereleases(left, right) {
  const a = String(left).split('.');
  const b = String(right).split('.');
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (index >= a.length) return -1;
    if (index >= b.length) return 1;
    const aNumeric = /^\d+$/.test(a[index]);
    const bNumeric = /^\d+$/.test(b[index]);
    if (aNumeric && bNumeric) {
      const difference = Number(a[index]) - Number(b[index]);
      if (difference !== 0) return difference < 0 ? -1 : 1;
    } else if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    } else if (a[index] !== b[index]) {
      return a[index] < b[index] ? -1 : 1;
    }
  }
  return 0;
}

/** Compare two [major, minor, patch] triples: -1, 0 or 1. */
function compareTriples(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

/**
 * T090: report the gap between the floor we declare (`requires.speckit_version`
 * in the extension manifest) and the toolchain actually present.
 *
 * A prerelease such as `1.4.4.dev0` is compared by its numeric triple, which is
 * exactly what upstream's `version_satisfies` does for a `>=X` floor (see
 * research R7): it satisfies `>=1.4.0` and fails `>=1.4.4`. Keeping the same rule
 * here means the report and the installer never disagree.
 */
export function compareBound(declared, observed) {
  const floor = parseBound(declared);
  const actual = observed === null || observed === 'unknown' ? null : parseBound(observed);
  if (floor === null || actual === null) {
    return {
      declared,
      observed: observed ?? null,
      needsAdjustment: false,
      suggestedBound: declared,
      reason: observed === null ? 'specify is not installed, nothing to compare' : 'unparsable version, nothing to compare',
    };
  }
  const order = compareTriples(actual, floor);
  const suggestedBound = `>=${actual.join('.')}`;
  if (order > 0) {
    return { declared, observed, needsAdjustment: false, suggestedBound: declared, reason: null };
  }
  // `1.4.4.dev0` carries a prerelease suffix. Upstream's `version_satisfies`
  // (prereleases=True) still refuses it against a final-release floor of the
  // same triple, so equality is not enough: the suffix decides (research R7).
  if (order === 0) {
    const observedPre = parsePrerelease(observed);
    const declaredPre = parsePrerelease(declared);
    // T100: a peer floor can itself be a prerelease measured in a real host
    // (e.g. >=0.2.2-rc.3). That floor is met by the same prerelease, by a
    // later prerelease of the same triple, and by the final release. Only a
    // final-release floor rejects a same-triple prerelease (research R7).
    if (!observedPre || (declaredPre && comparePrereleases(observedPre, declaredPre) >= 0)) {
      return { declared, observed, needsAdjustment: false, suggestedBound: declared, reason: null };
    }
    const prereleaseFloorBound = declaredPre
      ? `>=${String(observed).trim().replace(/^[^0-9]*/, '')}`
      : suggestedBound;
    return {
      declared,
      observed,
      needsAdjustment: true,
      suggestedBound: prereleaseFloorBound,
      reason: declaredPre
        ? `the installed ${observed} is below the prerelease floor (${declared}); pin a newer release or declare ${prereleaseFloorBound}`
        : `the installed specify (${observed}) is a prerelease of ${actual.join('.')}, which does not satisfy the final-release floor (${declared}); pin a released version or declare ${suggestedBound}`,
    };
  }
  return {
    declared,
    observed,
    needsAdjustment: true,
    suggestedBound,
    reason: `the installed specify (${observed}) is below the declared floor (${declared}); either raise the floor to ${suggestedBound} or pin a newer toolchain`,
  };
}

async function inspectVersionBound(observed) {
  const declared = await fs
    .readFile(path.join(EXTENSION_DIR, 'extension.yml'), 'utf8')
    .then((text) => /speckit_version:\s*"([^"]+)"/.exec(text)?.[1] ?? null)
    .catch(() => null);
  return compareBound(declared, observed);
}

function check(id, ok, detail, stderr = null) {
  return { id, ok, detail, stderr: stderr ? snippet(stderr) : null };
}

function emit(report, { json, keep }) {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const lines = [];
  if (report.status === 'not_executed') {
    lines.push(`未执行（环境不可用）：${report.reason}`);
  } else {
    lines.push(`Upstream contract verification (${Object.entries(report.versions).map(([k, v]) => `${k} ${v ?? 'unknown'}`).join(', ')})`);
    for (const entry of report.checks) {
      lines.push(`  ${entry.ok ? '✔' : '✖'} ${entry.id.padEnd(20)} ${entry.detail}`);
      if (entry.stderr) lines.push(`      stderr: ${entry.stderr.split('\n')[0]}`);
    }
    lines.push(`Status: ${report.status}`);
  }
  if (report.versionDrift) {
    const drift = report.versionDrift;
    lines.push(`Version bound: declared ${drift.declared ?? 'unknown'} observed ${drift.observed ?? 'unknown'}${drift.needsAdjustment ? ` → DRIFT, consider ${drift.suggestedBound}` : ''}`);
    if (drift.needsAdjustment && drift.reason) lines.push(`  ${drift.reason}`);
  }
  if (keep && report.tmpDir) lines.push(`Kept: ${report.tmpDir}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * Verify today's upstream contract by actually running specify in a throwaway
 * project. No mocks: every check is a real subprocess or a real file on disk.
 *
 * @param {{json?: boolean, keep?: boolean}} options
 */
export async function verifyUpstream(options = {}) {
  const json = options.json === true;
  const keep = options.keep === true;
  const versions = { specify: null, uv: null, git: null };

  for (const tool of ['specify', 'uv', 'git']) {
    versions[tool] = await probe(tool, ['--version']);
  }
  const versionDrift = await inspectVersionBound(versions.specify);
  const missing = ['specify', 'uv', 'git'].filter((tool) => versions[tool] === null);
  if (missing.length > 0) {
    const report = {
      status: 'not_executed',
      reason: `${missing.join(', ')} not found on PATH`,
      versions,
      versionDrift,
      checks: [],
      tmpDir: null,
    };
    emit(report, { json, keep });
    return report;
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sdd-upstream-'));
  const checks = [];
  let network = null;
  try {
    const init = await run('specify', ['init', '--here', '--integration', 'dsh', '--non-interactive', '--force', '--ignore-agent-tools'], tmpDir);
    if (!init.ok && NETWORK_PATTERN.test(`${init.stderr}\n${init.stdout}`)) network = init.stderr || init.stdout;
    let initDetail = `${init.command} → exit ${init.code}`;
    if (init.ok) {
      const templates = await fs.readdir(path.join(tmpDir, '.specify', 'templates')).catch(() => []);
      const templateCount = templates.filter((name) => name.endsWith('-template.md')).length;
      const skillsPresent = await fs.access(path.join(tmpDir, '.dsh', 'skills')).then(() => true).catch(() => false);
      initDetail += `; ${templateCount} templates; .dsh/skills ${skillsPresent ? 'present' : 'missing'}`;
      checks.push(check('init-args', templateCount === 5 && skillsPresent, initDetail, init.stderr));
    } else {
      checks.push(check('init-args', false, initDetail, init.stderr));
    }

    if (init.ok) {
      const add = await run('specify', ['extension', 'add', '--dev', EXTENSION_DIR, '--force'], tmpDir);
      if (!add.ok && NETWORK_PATTERN.test(`${add.stderr}\n${add.stdout}`)) network = add.stderr || add.stdout;
      checks.push(check('extension-add-args', add.ok, `${add.command} → exit ${add.code}`, add.stderr));

      const list = await run('specify', ['extension', 'list', '--json'], tmpDir);
      let manifestOk = false;
      let manifestDetail = `${list.command} → exit ${list.code}`;
      if (list.ok) {
        try {
          const parsed = JSON.parse(list.stdout);
          const entry = (Array.isArray(parsed) ? parsed : []).find((item) => item?.id === 'superpowers-hooks');
          const hooks = entry?.provides?.hooks;
          const hookCount = Array.isArray(hooks) ? hooks.length : (typeof hooks === 'number' ? hooks : null);
          manifestOk = Boolean(entry) && typeof entry.version === 'string' && hookCount === HOOK_EVENTS.length && entry.enabled === true;
          manifestDetail = `id=${entry?.id ?? 'missing'} version=${entry?.version ?? 'missing'} provides.hooks=${hookCount ?? 'missing'} enabled=${entry?.enabled ?? 'missing'}`;
        } catch (error) {
          manifestDetail = `extension list --json: unparsable output (${error.message})`;
        }
      }
      checks.push(check('manifest-contract', manifestOk, manifestDetail, list.stderr));

      const extensionsYml = await fs.readFile(path.join(tmpDir, '.specify', 'extensions.yml'), 'utf8').catch(() => '');
      const manifestText = await fs.readFile(path.join(EXTENSION_DIR, 'extension.yml'), 'utf8');
      const sessionEvent = /session_start:/.test(manifestText);
      const registered = HOOK_EVENTS.filter((event) => {
        const matches = extensionsYml.match(new RegExp(`^\\s*${event}:`, 'gm'));
        return (matches?.length ?? 0) === 1;
      });
      checks.push(check(
        'hooks-registered',
        registered.length === HOOK_EVENTS.length && sessionEvent,
        `${registered.length}/${HOOK_EVENTS.length} events registered once${sessionEvent ? ' + session_start' : ' (session_start MISSING)'}${registered.length === HOOK_EVENTS.length ? '' : `; missing: ${HOOK_EVENTS.filter((e) => !registered.includes(e)).join(', ')}`}`
      ));
    }

    const failed = checks.filter((entry) => entry.ok === false);
    const status = failed.length === 0 && checks.length === 4 ? 'passed' : (network ? 'not_executed' : 'failed');
    const report = {
      status,
      reason: status === 'not_executed'
        ? `network: ${snippet(network).split('\n')[0]}`
        : (failed.length > 0 ? `${failed.length} contract check(s) failed` : null),
      versions,
      versionDrift,
      checks,
      tmpDir: keep ? tmpDir : null,
    };
    emit(report, { json, keep });
    return report;
  } finally {
    if (!keep) await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const report = await verifyUpstream({
    json: process.argv.includes('--json'),
    keep: process.argv.includes('--keep'),
  });
  // T099: a run that did not execute, or that found the declared floor needs
  // adjustment, is as blocking as a failed contract check. The CI gate still
  // re-checks both fields; this is the first line of defence in the process.
  const blocked = report.status !== 'passed' || report.versionDrift?.needsAdjustment === true;
  process.exitCode = blocked ? 1 : 0;
}
