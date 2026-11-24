import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function codedError(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  return error;
}

/**
 * Resolve `targetPath` and refuse anything that is not strictly below `baseDir`.
 * Pure string/path comparison — it never touches the filesystem.
 */
export function assertInside(baseDir, targetPath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw codedError('E_ESCAPE', targetPath);
  }
  return target;
}

/**
 * Return the first path component between `baseDir` and `targetPath` that is a
 * symbolic link, or `null` when every existing component is a real directory.
 */
export async function findSymlinkComponent(baseDir, targetPath) {
  const base = path.resolve(baseDir);
  const target = assertInside(base, targetPath);
  const relative = path.relative(base, target);
  if (!relative) return null;

  let cursor = base;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    let stat;
    try {
      stat = await fs.lstat(cursor);
    } catch {
      // The remaining components do not exist yet; nothing further can be a link.
      return null;
    }
    if (stat.isSymbolicLink()) return cursor;
  }
  return null;
}

export async function assertNoSymlinkComponent(baseDir, targetPath) {
  const link = await findSymlinkComponent(baseDir, targetPath);
  if (link) throw codedError('E_SYMLINK', link);
  return null;
}

async function syncDirectory(dir) {
  let handle = null;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is not supported everywhere (Windows rejects it).
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * Write `bytes` to `targetPath` through a same-directory temp file:
 * create (O_EXCL) -> write -> fsync -> rename. Never leaves a partial target
 * and never leaves a temp file behind.
 */
export async function atomicWriteFile(targetPath, bytes) {
  const target = path.resolve(targetPath);
  const dir = path.dirname(target);
  const temp = path.join(
    dir,
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );

  let handle = null;
  try {
    handle = await fs.open(temp, 'wx');
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, target);
    await syncDirectory(dir);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}
