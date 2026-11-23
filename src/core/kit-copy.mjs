import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const KIT_ALLOWLIST = [
  'src',
  'skills',
  'overrides',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
  'package.json',
];

const KIT_PACKAGE_NAME = 'dsh-sdd-kit';

async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function collectFiles(root, label) {
  const files = new Map();

  async function walk(dir, relativeBase) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      const relative = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error(`${label} contains a symlink at ${relative}; symlinks are not allowed`);
      }
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else if (entry.isFile()) {
        files.set(relative, hashBuffer(await fs.readFile(absolute)));
      }
    }
  }

  for (const entry of KIT_ALLOWLIST) {
    const absolute = path.join(root, entry);
    if (!(await pathExists(absolute))) continue;
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} contains a symlink at ${entry}; symlinks are not allowed`);
    }
    if (stat.isDirectory()) {
      await walk(absolute, entry);
    } else if (stat.isFile()) {
      files.set(entry, hashBuffer(await fs.readFile(absolute)));
    }
  }

  return files;
}

function treeHash(files) {
  const digest = crypto.createHash('sha256');
  for (const relative of [...files.keys()].sort()) {
    digest.update(relative);
    digest.update('\0');
    digest.update(files.get(relative));
    digest.update('\n');
  }
  return `sha256:${digest.digest('hex')}`;
}

function diffFiles(before, after) {
  const changed = [];
  const names = new Set([...(before ? before.keys() : []), ...after.keys()]);
  for (const relative of [...names].sort()) {
    const beforeHash = before ? (before.get(relative) ?? null) : null;
    const afterHash = after.get(relative) ?? null;
    if (beforeHash !== afterHash) changed.push(relative);
  }
  return changed;
}

function resolveProfileDir(args, env, homedir) {
  if (args.dshProfileDir) return path.resolve(args.dshProfileDir);
  if (env.DSH_PROFILE_DIR) return path.resolve(env.DSH_PROFILE_DIR);
  const profile = env.DSH_PROFILE || 'web';
  return path.join(homedir(), '.dsh', 'profiles', profile);
}

async function validateSource(sourceDir, destDir) {
  const fail = (reason) => {
    throw new Error(`Invalid dsh-sdd-kit source: ${reason}`);
  };

  if (isInside(sourceDir, destDir) || isInside(destDir, sourceDir)) {
    fail(`source ${sourceDir} and destination ${destDir} must not contain each other`);
  }

  let stat;
  try {
    stat = await fs.stat(sourceDir);
  } catch {
    fail(`directory ${sourceDir} does not exist`);
  }
  if (!stat.isDirectory()) fail(`${sourceDir} is not a directory`);

  const manifestPath = path.join(sourceDir, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (error) {
    fail(`cannot read ${manifestPath}: ${error.message}`);
  }
  if (manifest.name !== KIT_PACKAGE_NAME) {
    fail(`${manifestPath} must declare name "${KIT_PACKAGE_NAME}"`);
  }
  if (!(await pathExists(path.join(sourceDir, 'src', 'index.mjs')))) {
    fail(`${sourceDir} is missing src/index.mjs`);
  }
}

async function stageEntries(sourceDir, stageDir) {
  for (const entry of KIT_ALLOWLIST) {
    const from = path.join(sourceDir, entry);
    if (!(await pathExists(from))) continue;
    await fs.cp(from, path.join(stageDir, entry), { recursive: true, dereference: false });
  }
}

async function swapEntries(stageDir, destDir, backupDir) {
  const applied = [];
  try {
    for (const entry of KIT_ALLOWLIST) {
      const destEntry = path.join(destDir, entry);
      const stageEntry = path.join(stageDir, entry);
      if (await pathExists(destEntry)) {
        await fs.rename(destEntry, path.join(backupDir, entry));
      }
      if (await pathExists(stageEntry)) {
        await fs.rename(stageEntry, destEntry);
      }
      applied.push(entry);
    }
  } catch (error) {
    for (const entry of applied.reverse()) {
      const destEntry = path.join(destDir, entry);
      const backupEntry = path.join(backupDir, entry);
      try {
        if (await pathExists(destEntry)) await fs.rm(destEntry, { recursive: true, force: true });
        if (await pathExists(backupEntry)) await fs.rename(backupEntry, destEntry);
      } catch {
        // Best-effort rollback; the original error is more useful to the caller.
      }
    }
    throw new Error(`dsh-sdd-kit profile copy failed: ${error.message}`);
  }
}

export async function refreshInstalledKit(args = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const homedir = deps.homedir ?? os.homedir;

  if (!args.dshKitSourceDir) {
    throw new Error(
      'No dsh-sdd-kit source configured: pass dshKitSourceDir pointing at a local dsh-sdd-kit checkout'
    );
  }

  const sourceDir = path.resolve(args.dshKitSourceDir);
  const profileDir = resolveProfileDir(args, env, homedir);
  const destDir = path.join(profileDir, 'node_modules', KIT_PACKAGE_NAME);

  await validateSource(sourceDir, destDir);

  let sourceFiles;
  try {
    sourceFiles = await collectFiles(sourceDir, 'source');
  } catch (error) {
    throw new Error(`Invalid dsh-sdd-kit source: ${error.message}`);
  }

  const destExists = await pathExists(destDir);
  const beforeFiles = destExists
    ? await collectFiles(destDir, 'installed copy').catch((error) => {
        throw new Error(`Invalid installed dsh-sdd-kit copy: ${error.message}`);
      })
    : null;
  const beforeHash = beforeFiles ? treeHash(beforeFiles) : null;
  const sourceHash = treeHash(sourceFiles);

  if (beforeHash === sourceHash) {
    return {
      changed: false,
      beforeHash,
      afterHash: beforeHash,
      changedFiles: [],
      destDir,
      mode: 'unchanged',
    };
  }

  const parentDir = path.dirname(destDir);
  await fs.mkdir(parentDir, { recursive: true });
  await fs.mkdir(destDir, { recursive: true });

  const stageDir = await fs.mkdtemp(path.join(parentDir, '.dsh-sdd-kit-stage-'));
  const backupDir = await fs.mkdtemp(path.join(parentDir, '.dsh-sdd-kit-backup-'));

  try {
    await stageEntries(sourceDir, stageDir);
    const stagedHash = treeHash(await collectFiles(stageDir, 'staged copy'));
    if (stagedHash !== sourceHash) {
      throw new Error(
        `dsh-sdd-kit profile copy failed: staged tree ${stagedHash} does not match source ${sourceHash}`
      );
    }
    await swapEntries(stageDir, destDir, backupDir);
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true });
    await fs.rm(backupDir, { recursive: true, force: true });
  }

  return {
    changed: true,
    beforeHash,
    afterHash: sourceHash,
    changedFiles: diffFiles(beforeFiles, sourceFiles),
    destDir,
    mode: 'updated',
  };
}
