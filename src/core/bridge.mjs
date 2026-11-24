import fs from 'node:fs/promises';
import path from 'node:path';

import { listArtifacts } from './artifacts.mjs';
import { assertInside, assertNoSymlinkComponent, atomicWriteFile } from './fsutil.mjs';
import { captureSnapshot, restoreSnapshots } from './snapshot.mjs';
import { classifyArtifact, VERDICT } from './status.mjs';

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readIfExists(p) {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

export function parseTasks(text) {
  if (!text) {
    return { total: 0, done: 0, remaining: 0, parallelReady: [], nextTask: null, items: [] };
  }
  const lines = text.split(/\r?\n/);
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*-\s+\[([ xX])\]\s+(.+)$/);
    if (!m) continue;
    const done = m[1].toLowerCase() === 'x';
    const label = m[2].trim();
    const idMatch = label.match(/^([A-Za-z0-9._-]+)(?:[:\s]|$)/);
    const parallel = /\[P\]/i.test(label);
    items.push({ line: i + 1, id: idMatch ? idMatch[1] : null, done, parallel, text: label });
  }
  const doneCount = items.filter((t) => t.done).length;
  const remainingItems = items.filter((t) => !t.done);
  return {
    total: items.length,
    done: doneCount,
    remaining: remainingItems.length,
    nextTask: remainingItems[0] || null,
    parallelReady: remainingItems.filter((t) => t.parallel),
    items,
  };
}

async function inspectRepo(cwd, featureFilter, bugFilter) {
  const root = path.resolve(cwd || process.cwd());
  const specifyDir = path.join(root, '.specify');
  const specsDir = path.join(root, 'specs');

  const [hasSpecifyDir, hasConstitution, hasEarsOverride] = await Promise.all([
    exists(specifyDir),
    exists(path.join(specifyDir, 'memory', 'constitution.md')),
    exists(path.join(specifyDir, 'templates', 'overrides', 'spec-template.md')),
  ]);

  const features = [];
  if (await exists(specsDir)) {
    const entries = await fs.readdir(specsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = assertInside(specsDir, path.join(specsDir, entry.name));
      const [hasSpec, hasPlan, tasksText] = await Promise.all([
        exists(path.join(dir, 'spec.md')),
        exists(path.join(dir, 'plan.md')),
        readIfExists(path.join(dir, 'tasks.md')),
      ]);
      const tasks = parseTasks(tasksText);
      features.push({
        name: entry.name,
        path: `specs/${entry.name}`,
        hasSpec,
        hasPlan,
        hasTasks: tasksText !== null,
        tasks: {
          total: tasks.total,
          done: tasks.done,
          remaining: tasks.remaining,
          nextTask: tasks.nextTask,
          parallelCount: tasks.parallelReady.length,
        },
      });
    }
  }
  features.sort((a, b) => a.name.localeCompare(b.name));

  const bugsDir = path.join(specifyDir, 'bugs');
  const bugs = [];
  if (await exists(bugsDir)) {
    const entries = await fs.readdir(bugsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = assertInside(bugsDir, path.join(bugsDir, entry.name));
      const files = (await fs.readdir(dir)).sort();
      bugs.push({ slug: entry.name, path: `.specify/bugs/${entry.name}`, files });
    }
  }
  bugs.sort((a, b) => a.slug.localeCompare(b.slug));

  const selectedFeature = featureFilter
    ? features.find((f) => f.name === featureFilter) || null
    : features.filter((f) => f.tasks.remaining > 0).length === 1
      ? features.find((f) => f.tasks.remaining > 0)
      : features.length === 1
        ? features[0]
        : null;

  const selectedBug = bugFilter
    ? bugs.find((b) => b.slug === bugFilter) || null
    : bugs.length === 1
      ? bugs[0]
      : null;

  return {
    action: 'inspect',
    cwd: root,
    hasSpecifyDir,
    hasConstitution,
    hasEarsOverride,
    features,
    bugs,
    selectedFeature,
    selectedBug,
  };
}

function nextOverwriteAction() {
  return { tool: 'sdd_bridge', args: { action: 'install_overrides', overwrite: true } };
}

/**
 * Every write goes through the same three gates, in this order: containment,
 * symlink components, then the actual publish. Nothing is opened before them.
 */
async function writeArtifact(root, artifact) {
  const bytes = await fs.readFile(artifact.bundledPath);
  assertInside(root, artifact.path);
  await assertNoSymlinkComponent(root, artifact.path);
  await fs.mkdir(path.dirname(artifact.path), { recursive: true });
  await atomicWriteFile(artifact.path, bytes);
}

async function installOne(root, artifact, overwrite, clock) {
  const classification = await classifyArtifact(artifact);
  const entry = {
    id: artifact.id,
    path: artifact.path,
    status: 'failed',
    verdict: classification.verdict,
    reason: classification.reason,
    localVersion: classification.localVersion,
    bundledVersion: classification.bundledVersion,
    nextAction: null,
    snapshot: null,
  };

  try {
    if (artifact.owner !== 'plugin') {
      entry.reason = 'E_OWNER';
      return entry;
    }
    if (artifact.bundledSha256 === null) {
      entry.reason = `E_BUNDLED_MISSING: ${artifact.bundledPath}`;
      return entry;
    }

    switch (classification.verdict) {
      case VERDICT.INSTALLED_CONSISTENT:
        entry.status = 'unchanged';
        return entry;
      case VERDICT.UNKNOWN:
        if (!overwrite) return entry;
        break;
      case VERDICT.NOT_INSTALLED:
        await writeArtifact(root, artifact);
        entry.status = 'written';
        return entry;
      case VERDICT.USER_MODIFIED:
        if (!overwrite) {
          entry.status = 'skipped_user_modified';
          entry.nextAction = nextOverwriteAction();
          return entry;
        }
        break;
      case VERDICT.STALE_UPSTREAM:
        if (!overwrite) {
          entry.status = 'skipped_stale';
          entry.nextAction = nextOverwriteAction();
          return entry;
        }
        break;
      default:
        entry.reason = `E_VERDICT: ${classification.verdict}`;
        return entry;
    }

    // Explicit overwrite of an existing file: guard BOTH the target and the
    // snapshot directory before touching anything. The snapshot lives under
    // the same parent, so a symlinked parent would otherwise write outside.
    assertInside(root, artifact.path);
    assertInside(root, artifact.snapshotDir);
    await assertNoSymlinkComponent(root, artifact.path);
    await assertNoSymlinkComponent(root, artifact.snapshotDir);

    const snapshot = await captureSnapshot(root, artifact, clock ? { clock } : {});
    if (snapshot.restorable === false && snapshot.reason !== 'target_missing') {
      // No restorable copy means no overwrite (REQ-09/REQ-11): reporting
      // `written` here would destroy content that can never be rolled back.
      entry.reason = snapshot.reason ?? 'E_SNAPSHOT_FAILED';
      return entry;
    }
    entry.snapshot = {
      captured: Boolean(snapshot.captured),
      refreshed: Boolean(snapshot.refreshed),
      path: snapshot.path ?? null,
    };
    await writeArtifact(root, artifact);
    entry.status = classification.verdict === VERDICT.STALE_UPSTREAM ? 'refreshed' : 'written';
    entry.reason = null;
    return entry;
  } catch (error) {
    entry.status = 'failed';
    entry.reason = error?.message ?? String(error);
    return entry;
  }
}

async function installOverrides(cwd, overwrite = false, deps = {}) {
  const root = path.resolve(cwd || process.cwd());
  const artifacts = deps.artifacts ?? (await listArtifacts(root));
  const results = [];
  for (const artifact of artifacts) {
    results.push(await installOne(root, artifact, overwrite, deps.clock));
  }
  return {
    action: 'install_overrides',
    ok: results.length > 0 && results.every((entry) => entry.status !== 'failed'),
    cwd: root,
    status: results[0]?.status ?? 'failed',
    path: results[0]?.path ?? null,
    artifacts: results,
  };
}

async function restoreOverrides(cwd, artifactId, deps = {}) {
  const root = path.resolve(cwd || process.cwd());
  const artifacts = deps.artifacts ?? (await listArtifacts(root));

  if (artifactId && !artifacts.some((artifact) => artifact.id === artifactId)) {
    return {
      action: 'restore_overrides',
      ok: false,
      error: {
        code: 'E_ARGS',
        message: `Unknown artifact "${artifactId}". Expected one of: ${artifacts.map((a) => a.id).join(', ')}.`,
      },
    };
  }

  const outcome = await restoreSnapshots(root, artifacts, { artifact: artifactId ?? null });
  return { action: 'restore_overrides', ...outcome };
}

async function syncIndex(cwd) {
  const root = path.resolve(cwd || process.cwd());
  const info = await inspectRepo(root);
  const specsDir = path.join(root, 'specs');
  await fs.mkdir(specsDir, { recursive: true });

  const rows = info.features.map((f) => {
    const status =
      f.tasks.total === 0
        ? 'Draft'
        : f.tasks.remaining === 0
          ? 'Done'
          : `In Progress (${f.tasks.done}/${f.tasks.total})`;
    const specLink = f.hasSpec ? `[spec.md](./${f.name}/spec.md)` : '—';
    const planLink = f.hasPlan ? `[plan.md](./${f.name}/plan.md)` : '—';
    return `| \`${f.name}\` | ${status} | ${specLink} | ${planLink} |`;
  });

  const md = [
    '# Living Specs Index',
    '',
    '> Auto-generated by `dsh-sdd-kit` (`sdd_bridge:sync_index`) for brownfield visibility across Spec Kit feature folders.',
    '',
    '| Feature | Status | Spec | Plan |',
    '| :--- | :--- | :--- | :--- |',
    ...(rows.length > 0 ? rows : ['| *(none)* | — | — | — |']),
    '',
  ].join('\n');

  const indexPath = path.join(specsDir, 'INDEX.md');
  await fs.writeFile(indexPath, md, 'utf8');
  return { action: 'sync_index', indexPath, featureCount: info.features.length };
}

export async function runBridge(args = {}, deps = {}) {
  const action = args.action || 'inspect';
  switch (action) {
    case 'inspect':
      return inspectRepo(args.cwd, args.featureName, args.bugSlug);
    case 'install_overrides':
      return installOverrides(args.cwd, Boolean(args.overwrite), deps);
    case 'restore_overrides':
      return restoreOverrides(args.cwd, args.artifact, deps);
    case 'sync_index':
      return syncIndex(args.cwd);
    default:
      return {
        ok: false,
        action,
        error: {
          code: 'E_ARGS',
          message: `Unknown sdd_bridge action "${action}". Expected one of: inspect, install_overrides, restore_overrides, sync_index.`,
          hint: 'Task checkbox updates belong to upstream /speckit.implement, not to this bridge.',
        },
      };
  }
}
