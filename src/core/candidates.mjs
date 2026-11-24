import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Pick one Superpowers mirror from a fixed, declared set of sources.
 *
 * This is the only place in src/ that reads process.env: a named pair of
 * variables is the only cross-process / cross-profile channel available to a
 * lightweight host tool. We deliberately do NOT scan any directory, and we
 * read no other variable (no prefix scan, no writes).
 *
 * @param {{superpowersDir?: string, candidateDirs?: string[]}} args
 * @param {NodeJS.ProcessEnv} env injectable for tests; defaults to process.env
 */
export async function selectSuperpowersDir(args = {}, env = process.env) {
  const declarations = [];
  const push = (declaredIndex, reason, input) => {
    if (typeof input !== 'string' || input.length === 0) return;
    declarations.push({ declaredIndex, reason, input: path.resolve(input) });
  };

  push(0, 'explicit', args.superpowersDir);
  for (const dir of args.candidateDirs ?? []) push(1, 'candidateDirs', dir);
  push(2, 'env', env.DSH_SDD_KIT_SUPERPOWERS_DIR);
  if (env.DSH_HOME) push(3, 'dsh_home', path.join(env.DSH_HOME, 'upstream', 'superpowers'));
  push(4, 'default', path.join(env.HOME ?? os.homedir(), '.dsh', 'upstream', 'superpowers'));

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
  if (eligible.length === 0) {
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
