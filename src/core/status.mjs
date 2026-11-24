import fs from 'node:fs/promises';

import { readLedger, sha256File } from './artifacts.mjs';

export const VERDICT = Object.freeze({
  NOT_INSTALLED: 'not_installed',
  INSTALLED_CONSISTENT: 'installed_consistent',
  USER_MODIFIED: 'user_modified',
  STALE_UPSTREAM: 'stale_upstream',
  UNKNOWN: 'unknown',
});

function result(bundledSha256, bundledVersion, verdict, extra = {}) {
  return {
    verdict,
    reason: extra.reason ?? null,
    localSha256: extra.localSha256 ?? null,
    localVersion: extra.localVersion ?? null,
    bundledSha256,
    bundledVersion,
    action: extra.action ?? 'refuse',
  };
}

/**
 * Classify one artifact by content fingerprint. The order is fixed and short-circuits:
 * missing -> unreadable -> current -> historical -> everything else. Anything we
 * cannot read is `unknown`; it is never downgraded to `not_installed`, because that
 * would mean overwriting something we failed to look at.
 */
export async function classifyArtifact(artifact) {
  const bundledSha256 = artifact.bundledSha256;
  const ledger = await readLedger(artifact.ledgerPath).catch(() => null);
  const bundledVersion = ledger?.versions.at(-1)?.sinceVersion ?? null;

  let stat;
  try {
    stat = await fs.lstat(artifact.path);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return result(bundledSha256, bundledVersion, VERDICT.NOT_INSTALLED, { action: 'write' });
    }
    return result(bundledSha256, bundledVersion, VERDICT.UNKNOWN, {
      reason: error.code ?? 'E_LSTAT',
    });
  }

  if (stat.isSymbolicLink()) {
    return result(bundledSha256, bundledVersion, VERDICT.UNKNOWN, {
      reason: `E_SYMLINK: ${artifact.path}`,
    });
  }

  let localSha256;
  try {
    localSha256 = await sha256File(artifact.path);
  } catch (error) {
    return result(bundledSha256, bundledVersion, VERDICT.UNKNOWN, {
      reason: error.code ?? 'E_READ',
    });
  }

  if (localSha256 === bundledSha256) {
    return result(bundledSha256, bundledVersion, VERDICT.INSTALLED_CONSISTENT, {
      localSha256,
      localVersion: bundledVersion,
      action: 'skip',
    });
  }

  const historical = ledger?.versions.find((entry) => entry.sha256 === localSha256);
  if (historical) {
    return result(bundledSha256, bundledVersion, VERDICT.STALE_UPSTREAM, {
      localSha256,
      localVersion: historical.sinceVersion,
      action: 'refresh_available',
    });
  }

  return result(bundledSha256, bundledVersion, VERDICT.USER_MODIFIED, {
    localSha256,
    action: 'refuse',
  });
}
