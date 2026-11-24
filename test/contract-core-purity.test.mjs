import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { toolMapping } from '../src/core/guidance.mjs';
import { HOST_NEUTRAL_TOOL_NAMES } from '../src/core/host-capabilities.mjs';
import { resolveGuidanceHost } from '../src/adapters/dsh/index.mjs';

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
  // A host environment name is a path/profile lookup (`DSH_PROFILE_DIR`,
  // `DSH_SDD_KIT_HOME`) or a direct process read. Anchoring on the suffixes keeps
  // identifier constants such as DSH_TOOL_NAMES from being flagged: those are
  // table keys, not host paths.
  { code: 'HOST_ENV_DSH', re: /\bDSH_(?:[A-Z0-9_]*_)?(?:HOME|DIR|CONFIG|PROFILE)\b|process\.env\.DSH_/ },
  // A host default is an assignment or a parameter default, including the
  // integration-key constant the update path compares against.
  { code: 'HOST_DEFAULT_DSH', re: /\b(?:host|EXPECTED_INTEGRATION)\s*(?:=|\|\|)\s*['"]dsh['"]/ },
  // C3 (AC-01): a computed specifier hides the adapter path from HOST_ADAPTER_PATH.
  // `import('./adapters/x.mjs')` stays legal; a non-literal argument does not.
  { code: 'DYNAMIC_IMPORT_SPECIFIER', re: /\bimport\s*\(\s*(?!['"`])(?=\S)/ },
  { code: 'DYNAMIC_IMPORT_TEMPLATE', re: /\bimport\s*\(\s*`[^`]*\$\{/ },
  // C3 (AC-01): literal specifier followed by runtime concatenation is the
  // common spelling of the same evasion and must not bypass the literal guard.
  { code: 'DYNAMIC_IMPORT_CONCAT', re: /\bimport\s*\(\s*['"`][^'"`]*['"`]\s*\+/ },
  // C3 (AC-01): the same evasion spelled as a segment array joined at runtime.
  { code: 'COMPUTED_ADAPTER_SPECIFIER', re: /\[[^\]]*['"](?:\.\.|adapters)['"][^\]]*\]\s*\.\s*join\s*\(/ },
];

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

/**
 * Remove source comments before matching: a comment may legitimately document
 * which host variables an adapter injects, while the executable module must
 * still derive them from HOST_CAPABILITIES.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

async function scanCore(coreDir) {
  const violations = [];
  for (const relative of await listCoreModules(coreDir)) {
    const text = await fs.readFile(path.join(coreDir, ...relative.split('/')), 'utf8');
    const code = stripComments(text);
    for (const pattern of HOST_PATTERNS) {
      if (pattern.re.test(code)) {
        violations.push({ file: relative, code: pattern.code });
      }
    }
  }
  return violations;
}

test('core directory stays free of host-specific references (REQ-01/REQ-02/AC-01/T097)', async () => {
  const violations = await scanCore(CORE_DIR);
  assert.deepEqual(violations, [], `core purity violations: ${JSON.stringify(violations)}`);
});

test('T097: DSH defaults live in the adapter, not in core tool mapping', () => {
  assert.equal(resolveGuidanceHost({ env: {} }), 'dsh', 'adapter supplies the DSH startup default');
  assert.deepEqual(
    toolMapping(),
    { ...HOST_NEUTRAL_TOOL_NAMES },
    'core with no injected host must use the host-neutral face'
  );
});

test('host environment and default-host patterns are precise enough to stay useful (I10)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sdd-kit-purity-precise-'));
  try {
    // Identifier constants and non-path host names must stay clean: the patterns
    // target host paths and defaults, not every identifier that starts with DSH_.
    await fs.writeFile(
      path.join(tmp, 'clean.mjs'),
      [
        "const DSH_TOOL_NAMES = Object.freeze({ upstream: 'sdd_upstream' });",
        "const DSH_TOOL_PREFIX = '@';",
        'const host = HOST_KEYS[0];',
        "const integration = resolveIntegration('dsh');",
        'export { DSH_TOOL_NAMES, DSH_TOOL_PREFIX, host, integration };',
        '',
      ].join('\n'),
      'utf8'
    );
    assert.deepEqual(await scanCore(tmp), [], 'DSH_* identifiers are not host paths');

    // The real evasions must still be caught: a profile path, a process read, a
    // parameter default, a fallback and the integration-key constant. Each shape
    // gets its own file because the scanner reports one violation per file/code.
    const evasions = {
      'env-path.mjs': "export const dir = env.DSH_PROFILE_DIR;\n",
      'env-process.mjs': 'export const home = process.env.DSH_HOME;\n',
      'param-default.mjs': "export function run({ host = 'dsh' } = {}) { return host; }\n",
      'expected-integration.mjs': "export const EXPECTED_INTEGRATION = 'dsh';\n",
      'fallback.mjs': "export const fallback = host || 'dsh';\n",
      'dynamic-concat.mjs': "export const load = (host) => import('./adapters/' + host + '/index.mjs');\n",
    };
    for (const [file, source] of Object.entries(evasions)) {
      await fs.writeFile(path.join(tmp, file), source, 'utf8');
    }
    const violations = await scanCore(tmp);
    for (const [file, code] of [
      ['env-path.mjs', 'HOST_ENV_DSH'],
      ['env-process.mjs', 'HOST_ENV_DSH'],
      ['param-default.mjs', 'HOST_DEFAULT_DSH'],
      ['expected-integration.mjs', 'HOST_DEFAULT_DSH'],
      ['fallback.mjs', 'HOST_DEFAULT_DSH'],
      ['dynamic-concat.mjs', 'DYNAMIC_IMPORT_CONCAT'],
    ]) {
      assert.ok(
        violations.some((violation) => violation.file === file && violation.code === code),
        `${file} must be reported as ${code}: ${JSON.stringify(violations)}`
      );
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
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

/**
 * C3 regression: the reviewer found `doctor.mjs` bypassing HOST_ADAPTER_PATH by
 * building the specifier at runtime. A literal dynamic import is fine; a
 * computed one is not. Both shapes must turn the scan red.
 */
test('a computed dynamic import specifier is a core purity violation (C3/AC-01)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sdd-kit-purity-import-'));
  try {
    await fs.writeFile(
      path.join(tmp, 'sneaky.mjs'),
      "const spec = ['..', 'adapters', 'cursor', 'index.mjs'].join('/');\nexport const m = await import(spec);\n",
      'utf8'
    );
    const violations = await scanCore(tmp);
    assert.ok(
      violations.some((v) => v.code === 'DYNAMIC_IMPORT_SPECIFIER'),
      `computed import() must be detected, got ${JSON.stringify(violations)}`
    );
    assert.ok(
      violations.some((v) => v.code === 'COMPUTED_ADAPTER_SPECIFIER'),
      `array-join specifier must be detected, got ${JSON.stringify(violations)}`
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('a template-literal import specifier with interpolation is a violation (C3/AC-01)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sdd-kit-purity-template-'));
  try {
    await fs.writeFile(
      path.join(tmp, 'sneaky.mjs'),
      'const dir = process.env.X;\nexport const m = await import(`../${dir}/index.mjs`);\n',
      'utf8'
    );
    const violations = await scanCore(tmp);
    assert.ok(
      violations.some((v) => v.code === 'DYNAMIC_IMPORT_TEMPLATE'),
      `interpolated template import must be detected, got ${JSON.stringify(violations)}`
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('a literal dynamic import stays legal so lazy loading is not banned outright (C3)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sdd-kit-purity-literal-'));
  try {
    await fs.writeFile(
      path.join(tmp, 'ok.mjs'),
      "export const load = () => import('./local-module.mjs');\n",
      'utf8'
    );
    assert.deepEqual(await scanCore(tmp), []);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
