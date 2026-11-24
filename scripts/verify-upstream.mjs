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
const HOOK_EVENTS = ['before_implement', 'after_implement', 'before_bug_fix', 'after_bug_fix'];
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
  const missing = ['specify', 'uv', 'git'].filter((tool) => versions[tool] === null);
  if (missing.length > 0) {
    const report = {
      status: 'not_executed',
      reason: `${missing.join(', ')} not found on PATH`,
      versions,
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
          manifestOk = Boolean(entry) && typeof entry.version === 'string' && hookCount === 4 && entry.enabled === true;
          manifestDetail = `id=${entry?.id ?? 'missing'} version=${entry?.version ?? 'missing'} provides.hooks=${hookCount ?? 'missing'} enabled=${entry?.enabled ?? 'missing'}`;
        } catch (error) {
          manifestDetail = `extension list --json: unparsable output (${error.message})`;
        }
      }
      checks.push(check('manifest-contract', manifestOk, manifestDetail, list.stderr));

      const extensionsYml = await fs.readFile(path.join(tmpDir, '.specify', 'extensions.yml'), 'utf8').catch(() => '');
      const registered = HOOK_EVENTS.filter((event) => {
        const matches = extensionsYml.match(new RegExp(`^\\s*${event}:`, 'gm'));
        return (matches?.length ?? 0) === 1;
      });
      checks.push(check(
        'hooks-registered',
        registered.length === HOOK_EVENTS.length,
        `${registered.length}/${HOOK_EVENTS.length} events registered once${registered.length === HOOK_EVENTS.length ? '' : `; missing: ${HOOK_EVENTS.filter((e) => !registered.includes(e)).join(', ')}`}`
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
  process.exitCode = report.status === 'failed' ? 1 : 0;
}
