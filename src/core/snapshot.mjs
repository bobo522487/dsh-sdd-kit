import fs from 'node:fs/promises';
import path from 'node:path';

import { sha256Bytes, sha256File, versionForSha } from './artifacts.mjs';
import { assertInside, assertNoSymlinkComponent, atomicWriteFile } from './fsutil.mjs';

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

function restoredEntry(id, status, extra = {}) {
  return { id, status, reason: null, path: null, sourceVersion: null, snapshotCapturedAt: null, ...extra };
}

/**
 * Restore every snapshot the manifest knows about (optionally a single artifact).
 * Nothing outside the manifest is ever touched, and an empty set is never a success.
 */
export async function restoreSnapshots(cwd, artifacts, options = {}) {
  const root = path.resolve(cwd || process.cwd());
  const wanted = options.artifact ?? null;
  const restored = [];

  const snapshotDir = artifacts[0]?.snapshotDir ?? null;
  const manifest = artifacts.length > 0 ? await readManifest(artifacts[0]) : null;
  const snapshots = manifest?.snapshots ?? {};

  for (const artifact of artifacts) {
    if (wanted && artifact.id !== wanted) continue;
    const entry = snapshots[artifact.id];
    if (!entry) continue;

    const backupPath = path.join(artifact.snapshotDir, `${artifact.id}.bak`);
    let bytes;
    try {
      bytes = await fs.readFile(backupPath);
    } catch {
      restored.push(restoredEntry(artifact.id, 'failed', { reason: 'E_SNAPSHOT_MISSING' }));
      continue;
    }
    if (sha256Bytes(bytes) !== entry.sha256) {
      restored.push(restoredEntry(artifact.id, 'failed', { reason: 'E_SNAPSHOT_CHECKSUM_MISMATCH' }));
      continue;
    }

    const target = path.resolve(root, entry.relativePath);
    try {
      assertInside(root, target);
      await assertNoSymlinkComponent(root, target);
    } catch (error) {
      restored.push(restoredEntry(artifact.id, 'failed', { reason: error.message }));
      continue;
    }

    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await atomicWriteFile(target, bytes);
      restored.push(restoredEntry(artifact.id, 'restored', {
        path: target,
        sourceVersion: entry.sourceVersion,
        snapshotCapturedAt: entry.capturedAt,
      }));
    } catch (error) {
      restored.push(restoredEntry(artifact.id, 'failed', { reason: error?.message ?? String(error) }));
    }
  }

  const ok = restored.length > 0 && restored.every((entry) => entry.status === 'restored');
  if (restored.length === 0) {
    return { ok: false, status: 'no_snapshot', restored: [], reason: 'E_NO_SNAPSHOT', snapshotDir };
  }
  return { ok, status: ok ? 'restored' : 'partial', restored, snapshotDir };
}
