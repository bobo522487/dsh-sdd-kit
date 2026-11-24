import fs from 'node:fs/promises';
import path from 'node:path';

import { sha256File, versionForSha } from './artifacts.mjs';

const SCHEMA = 1;
const BACKUP_IGNORE = '*\n';

function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * The snapshot directory sits next to the files it protects, so it must ignore
 * itself: downstream projects do not ignore `.specify/templates/overrides/`.
 */
async function ensureSnapshotDir(snapshotDir) {
  await fs.mkdir(snapshotDir, { recursive: true });
  try {
    await fs.writeFile(path.join(snapshotDir, '.gitignore'), BACKUP_IGNORE, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

export async function readManifest(artifact) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(artifact.snapshotDir, 'manifest.json'), 'utf8'));
    return { schema: parsed.schema, snapshots: parsed.snapshots ?? {} };
  } catch {
    return null;
  }
}

async function writeManifest(artifact, manifest) {
  const target = path.join(artifact.snapshotDir, 'manifest.json');
  await fs.writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * Keep exactly one snapshot per artifact and refresh it only when the target's
 * content actually differs from what the snapshot holds.
 */
export async function captureSnapshot(cwd, artifact, deps = {}) {
  const root = path.resolve(cwd || process.cwd());
  const clock = deps.clock ?? (() => new Date().toISOString());

  const currentSha256 = await sha256File(artifact.path).catch(() => null);
  if (currentSha256 === null) return { captured: false, reason: 'target_missing' };

  const manifest = (await readManifest(artifact)) ?? { schema: SCHEMA, snapshots: {} };
  const existing = manifest.snapshots[artifact.id];
  if (existing && existing.sha256 === currentSha256) {
    return { captured: false, reason: 'up_to_date', entry: existing };
  }

  await ensureSnapshotDir(artifact.snapshotDir);
  await fs.copyFile(artifact.path, path.join(artifact.snapshotDir, `${artifact.id}.bak`));

  const entry = {
    relativePath: toPosix(path.relative(root, artifact.path)),
    sha256: currentSha256,
    sourceVersion: (await versionForSha(artifact, currentSha256)) ?? 'unknown',
    capturedAt: clock(),
  };
  manifest.schema = SCHEMA;
  manifest.snapshots = { ...manifest.snapshots, [artifact.id]: entry };
  await writeManifest(artifact, manifest);

  return { captured: true, entry };
}
