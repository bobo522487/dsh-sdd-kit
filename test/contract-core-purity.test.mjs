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
  const violations = await scanCore(CORE_DIR);
  assert.deepEqual(violations, [], `core purity violations: ${JSON.stringify(violations)}`);
});

test('purity scanner self-check: an injected host reference must turn the assertion red (AC-01)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sdd-kit-purity-'));
  try {
    await fs.writeFile(
      path.join(tmp, 'injected.mjs'),
      "import { defineTool } from '@deepseek-ai/dsh-tools';\nexport const x = ctx.tools;\n",
      'utf8'
    );
    const violations = await scanCore(tmp);
    assert.ok(violations.length >= 2, 'injected host references must be detected');
    assert.ok(violations.some((v) => v.code === 'HOST_PACKAGE'));
    assert.ok(violations.some((v) => v.code === 'HOST_CTX'));
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
