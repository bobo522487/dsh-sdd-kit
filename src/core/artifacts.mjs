import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUNDLED_DIR = path.join(PKG_ROOT, 'overrides');

export const MANAGED_ARTIFACT_DIR = path.join('.specify', 'templates', 'overrides');

export function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export async function sha256File(filePath) {
  return sha256Bytes(await fs.readFile(filePath));
}

/**
 * Read the shipped fingerprint ledger. It is the single offline source of truth
 * for "which content came from which release", because a template can stay
 * unchanged across several releases.
 */
export async function readLedger(ledgerPath) {
  const parsed = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
  return { artifact: parsed.artifact, versions: parsed.versions };
}

/**
 * The descriptors of every file this plugin owns the write for. Anything else
 * under `.specify/` belongs to the upstream `specify` CLI.
 */
export async function listArtifacts(cwd, deps = {}) {
  const root = path.resolve(cwd || process.cwd());
  const destDir = path.join(root, MANAGED_ARTIFACT_DIR);
  const bundledDir = deps.bundledDir ? path.resolve(deps.bundledDir) : BUNDLED_DIR;

  const descriptor = {
    id: 'ears-spec-template',
    owner: 'plugin',
    path: path.join(destDir, 'spec-template.md'),
    bundledPath: path.join(bundledDir, 'spec-template.md'),
    ledgerPath: path.join(bundledDir, 'spec-template.versions.json'),
    snapshotDir: path.join(destDir, '.backup'),
  };

  const bundledSha256 = await sha256File(descriptor.bundledPath).catch(() => null);
  return [{ ...descriptor, bundledSha256 }];
}

/** The release that ships the current bundled bytes (the ledger's last entry). */
export async function bundledVersion(artifact) {
  const ledger = await readLedger(artifact.ledgerPath);
  return ledger.versions.at(-1).sinceVersion;
}

/** The release a given fingerprint came from, or `null` when unknown. */
export async function versionForSha(artifact, sha256) {
  const ledger = await readLedger(artifact.ledgerPath).catch(() => null);
  if (!ledger) return null;
  const hit = ledger.versions.find((entry) => entry.sha256 === sha256);
  return hit ? hit.sinceVersion : null;
}
