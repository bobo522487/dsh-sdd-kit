import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUNDLED_OVERRIDE_SPEC = path.join(PKG_ROOT, 'overrides', 'spec-template.md');

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

function assertInside(baseDir, targetPath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`Path escapes allowed root: ${targetPath}`);
  }
  return target;
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

async function installOverrides(cwd, overwrite = false) {
  const root = path.resolve(cwd || process.cwd());
  const destDir = path.join(root, '.specify', 'templates', 'overrides');
  const destFile = path.join(destDir, 'spec-template.md');
  if (!overwrite && (await exists(destFile))) {
    return { action: 'install_overrides', path: destFile, status: 'skipped_existing' };
  }
  await fs.mkdir(destDir, { recursive: true });
  const content = await fs.readFile(BUNDLED_OVERRIDE_SPEC, 'utf8');
  await fs.writeFile(destFile, content, 'utf8');
  return { action: 'install_overrides', path: destFile, status: 'written' };
}

async function checkTask(cwd, featureName, taskMatch) {
  if (!featureName || !taskMatch) {
    throw new Error('Both featureName and taskMatch are required for action="check_task".');
  }
  if (featureName.includes('..') || featureName.includes('/') || featureName.includes('\\')) {
    throw new Error(`Invalid featureName: "${featureName}".`);
  }
  const root = path.resolve(cwd || process.cwd());
  const tasksPath = assertInside(path.join(root, 'specs'), path.join(root, 'specs', featureName, 'tasks.md'));
  const raw = await fs.readFile(tasksPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const needle = taskMatch.trim().toLowerCase();

  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*-\s+\[)( )(\]\s+)(.+)$/);
    if (m && m[4].toLowerCase().includes(needle)) {
      matches.push(i);
    }
  }
  if (matches.length === 0) {
    throw new Error(`No unchecked task matching "${taskMatch}" in ${tasksPath}.`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple unchecked tasks match "${taskMatch}". Pass a more specific task ID.`);
  }

  const idx = matches[0];
  const completedTask = lines[idx].replace(/^\s*-\s+\[ \]\s+/, '').trim();
  lines[idx] = lines[idx].replace(/^(\s*-\s+\[) (\])/, '$1x$2');
  const updated = lines.join('\n');
  await fs.writeFile(tasksPath, updated, 'utf8');
  const after = parseTasks(updated);

  return {
    action: 'check_task',
    featureName,
    completedTask,
    progress: { done: after.done, total: after.total, remaining: after.remaining },
    nextTask: after.nextTask,
  };
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

export async function runBridge(args = {}) {
  const action = args.action || 'inspect';
  switch (action) {
    case 'inspect':
      return inspectRepo(args.cwd, args.featureName, args.bugSlug);
    case 'install_overrides':
      return installOverrides(args.cwd, Boolean(args.overwrite));
    case 'check_task':
      return checkTask(args.cwd, args.featureName, args.taskMatch);
    case 'sync_index':
      return syncIndex(args.cwd);
    default:
      throw new Error(
        `Unknown sdd_bridge action "${action}". Expected one of: inspect, install_overrides, check_task, sync_index.`
      );
  }
}
