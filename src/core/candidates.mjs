import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { HOST_CAPABILITIES, HOST_KEYS } from './host-capabilities.mjs';

const DEFAULT_CAP = HOST_CAPABILITIES[HOST_KEYS[0]];
const HOST_PREFIX = DEFAULT_CAP.key.toUpperCase();
function defaultSuperpowersDir() {
  return path.join(os.homedir(), path.dirname(DEFAULT_CAP.skillsDir), 'upstream', 'superpowers');
}

/**
 * Pick one Superpowers mirror from a fixed, declared set of sources.
 *
 * Host-specific names and the fallback mirror are read from HOST_CAPABILITIES;
 * a caller may override all of them through `args`. No env name is hard-coded.
 * The DSH adapter injects DSH_SDD_KIT_SUPERPOWERS_DIR and DSH_HOME; this module
 * derives their equivalents from the capability key and never parses them here.
 *
 * @param {{superpowersDir?: string, candidateDirs?: string[], envKeys?: {mirror?: string, home?: string}, defaultDir?: string}} args
 * @param {NodeJS.ProcessEnv} env injectable for tests; defaults to process.env
 */
export async function selectSuperpowersDir(args = {}, env = process.env) {
  const envKeys = {
    mirror: args.envKeys?.mirror ?? `${HOST_PREFIX}_SDD_KIT_SUPERPOWERS_DIR`,
    home: args.envKeys?.home ?? `${HOST_PREFIX}_HOME`,
  };
  const declarations = [];
  const push = (declaredIndex, reason, input) => {
    if (typeof input !== 'string' || input.length === 0) return;
    declarations.push({ declaredIndex, reason, input: path.resolve(input) });
  };

  push(0, 'explicit', args.superpowersDir);
  for (const dir of args.candidateDirs ?? []) push(1, 'candidateDirs', dir);
  push(2, 'env', env?.[envKeys.mirror]);
  const injectedHome = env?.[envKeys.home];
  if (injectedHome) push(3, `${DEFAULT_CAP.key}_home`, path.join(injectedHome, 'upstream', 'superpowers'));
  // os.homedir() follows HOME on POSIX / USERPROFILE on Windows; no third env var is read here.
  push(4, 'default', args.defaultDir ?? defaultSuperpowersDir());

  const seenRealPaths = new Set();
  const candidates = [];
  for (const declaration of declarations) {
    let realPath = null;
    let mtimeNs = null;
    try {
      realPath = await fs.realpath(declaration.input);
    } catch {
      // An unresolvable declaration stays in the report for diagnosis.
    }
    if (realPath !== null) {
      try {
        mtimeNs = (await fs.stat(realPath, { bigint: true })).mtimeNs;
      } catch {
        // Keep the realPath with a null mtimeNs; declaration order breaks the tie.
      }
    }
    let eligible = realPath !== null;
    if (eligible && seenRealPaths.has(realPath)) {
      eligible = false;
    } else if (eligible) {
      seenRealPaths.add(realPath);
    }
    candidates.push({ ...declaration, realPath, mtimeNs, eligible, selected: false });
  }

  const eligible = candidates.filter((candidate) => candidate.eligible);
  let selected;
  let fallback = false;
  const explicit = candidates.find((candidate) => candidate.reason === 'explicit');
  if (explicit) {
    // An explicit request wins even when the directory does not exist yet: it is
    // the clone target. Silently redirecting it to another existing mirror would
    // ignore the caller's instruction.
    selected = explicit;
  } else if (eligible.length === 0) {
    selected = candidates.find((candidate) => candidate.reason === 'default');
    fallback = true;
  } else {
    selected = [...eligible].sort((left, right) => {
      if (left.mtimeNs === null && right.mtimeNs === null) return left.declaredIndex - right.declaredIndex;
      if (left.mtimeNs === null) return 1;
      if (right.mtimeNs === null) return -1;
      if (left.mtimeNs < right.mtimeNs) return 1;
      if (left.mtimeNs > right.mtimeNs) return -1;
      return left.declaredIndex - right.declaredIndex;
    })[0];
  }
  selected.selected = true;

  return {
    dir: selected.input,
    realPath: selected.realPath ?? null,
    reason: selected.reason,
    mtimeNs: selected.mtimeNs ?? null,
    fallback,
    candidates,
  };
}
