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

async function scanCore(coreDir) {
  const violations = [];
  const entries = (await fs.readdir(coreDir, { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const text = await fs.readFile(path.join(coreDir, entry.name), 'utf8');
    for (const pattern of HOST_PATTERNS) {
      if (pattern.re.test(text)) {
        violations.push({ file: entry.name, code: pattern.code });
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
