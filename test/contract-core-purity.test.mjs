import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE_DIR = path.join(PKG_ROOT, 'src', 'core');

/**
 * Static purity scan: core modules must not reference host-only package names,
 * registration objects, CommonJS require, or adapter directory paths.
 * Returns the list of violations (empty means pure).
 */
const HOST_PATTERNS = [
  { code: 'HOST_PACKAGE', re: /@deepseek-ai\// },
  { code: 'HOST_CTX', re: /\bctx\./ },
  { code: 'COMMONJS_REQUIRE', re: /\brequire\s*\(/ },
  { code: 'HOST_ADAPTER_PATH', re: /\badapters\/(dsh|claude|codex|cursor)\b/ },
  { code: 'HOST_ENV_DSH', re: /\bDSH_[A-Z0-9_]+/ },
  { code: 'HOST_DEFAULT_DSH', re: /\bhost\s*(?:=|\|\|)\s*['"]dsh['"]/ },
];

/**
 * T079: a host-owned legacy reference is tolerated only when the file, the
 * pattern code and the reason are all recorded here. New core code must take
 * injected values (envKeys / defaultDir / HOST_KEYS[0]) instead.
 */
const LEGACY_HOST_REFERENCES = Object.freeze({
  'candidates.mjs': {
    codes: ['HOST_ENV_DSH'],
    reason: 'Legacy DSH_* environment names are kept as compatibility defaults; injected envKeys/defaultDir are the supported path.',
  },
  'doctor.mjs': {
    codes: ['HOST_ENV_DSH', 'HOST_DEFAULT_DSH'],
    reason: 'Doctor belongs to the host-integration owner; the lead wires classifyMarkers and the real CLI fix text there.',
  },
  'guidance.mjs': {
    codes: ['HOST_DEFAULT_DSH'],
    reason: 'Guidance belongs to the host-integration owner and still carries its legacy default host.',
  },
  'host-capabilities.mjs': {
    codes: ['HOST_ENV_DSH'],
    reason: 'The capability table intentionally names the host-owned DSH_TOOL_NAMES map; another agent owns this file.',
  },
});

const VALID_PATTERN_CODES = new Set(HOST_PATTERNS.map((pattern) => pattern.code));

function isAllowlisted(violation) {
  const entry = LEGACY_HOST_REFERENCES[violation.file];
  return Boolean(entry && entry.codes.includes(violation.code));
}

/**
 * Collect every `.mjs` file under `coreDir`, at any depth, as paths relative to
 * `coreDir` with forward slashes. A top-level-only scan would let a host
 * reference hide in `src/core/<sub>/x.mjs`.
 */
async function listCoreModules(coreDir, prefix = '') {
  const entries = await fs.readdir(coreDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await listCoreModules(path.join(coreDir, entry.name), relative));
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      files.push(relative);
    }
  }
  return files;
}

async function scanCore(coreDir) {
  const violations = [];
  for (const relative of await listCoreModules(coreDir)) {
    const text = await fs.readFile(path.join(coreDir, ...relative.split('/')), 'utf8');
    for (const pattern of HOST_PATTERNS) {
      if (pattern.re.test(text)) {
        violations.push({ file: relative, code: pattern.code });
      }
    }
  }
  return violations;
}

test('core directory stays free of host-specific references (REQ-01/REQ-02/AC-01)', async () => {
  const violations = (await scanCore(CORE_DIR)).filter((violation) => !isAllowlisted(violation));
  assert.deepEqual(violations, [], `core purity violations: ${JSON.stringify(violations)}`);
});

test('legacy host references are confined to an explicit, documented allowlist (T079)', async () => {
  for (const [file, entry] of Object.entries(LEGACY_HOST_REFERENCES)) {
    assert.ok((await fs.stat(path.join(CORE_DIR, file))).isFile(), `allowlisted file must exist: ${file}`);
    assert.ok(entry.reason.length > 20, `allowlisted file must carry a reason: ${file}`);
    for (const code of entry.codes) {
      assert.ok(VALID_PATTERN_CODES.has(code), `unknown allowlist code ${code} for ${file}`);
    }
  }
  const violations = await scanCore(CORE_DIR);
  const stray = violations.filter((violation) => !isAllowlisted(violation));
  assert.deepEqual(stray, [], `unallowlisted host references: ${JSON.stringify(stray)}`);
});

test('purity scanner self-check: an injected host reference must turn the assertion red (AC-01)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sdd-kit-purity-'));
  try {
    await fs.writeFile(
      path.join(tmp, 'injected.mjs'),
      "import { defineTool } from '@deepseek-ai/dsh-tools';\nexport const x = ctx.tools;\nconst envName = 'DSH_HOME';\nconst defaultHost = host = 'dsh';\n",
      'utf8'
    );
    const violations = await scanCore(tmp);
    assert.ok(violations.length >= 4, 'injected host references must be detected');
    assert.ok(violations.some((v) => v.code === 'HOST_PACKAGE'));
    assert.ok(violations.some((v) => v.code === 'HOST_CTX'));
    assert.ok(violations.some((v) => v.code === 'HOST_ENV_DSH'));
    assert.ok(violations.some((v) => v.code === 'HOST_DEFAULT_DSH'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('the purity scan also walks nested core subdirectories (REQ-01/AC-01)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sdd-kit-purity-nested-'));
  try {
    await fs.mkdir(path.join(tmp, 'nested', 'deeper'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, 'nested', 'deeper', 'host.mjs'),
      "import { x } from '@deepseek-ai/dsh-tools';\nexport const y = x;\n",
      'utf8'
    );
    const violations = await scanCore(tmp);
    assert.ok(
      violations.some((v) => v.code === 'HOST_PACKAGE' && v.file.endsWith(path.join('nested', 'deeper', 'host.mjs'))),
      `nested violation must be detected, got ${JSON.stringify(violations)}`
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('the purity scan ignores non-.mjs files at any depth (REQ-01)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sdd-kit-purity-filter-'));
  try {
    await fs.mkdir(path.join(tmp, 'nested'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'nested', 'notes.md'), "import '@deepseek-ai/dsh-tools';\n", 'utf8');
    await fs.writeFile(path.join(tmp, 'nested', 'legacy.cjs'), "require('@deepseek-ai/dsh-tools');\n", 'utf8');
    assert.deepEqual(await scanCore(tmp), []);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
