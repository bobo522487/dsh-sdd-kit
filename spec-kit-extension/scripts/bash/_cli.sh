#!/bin/sh
# Shared CLI locator for extension scripts. Prints the absolute path of
# bin/sdd-kit.mjs, or exits 1 when the package is not installed.
#
# Resolution order: explicit override, node resolution, global npm root.

resolve_sdd_kit_cli() {
  # An explicit override wins outright: if it does not exist, report failure
  # instead of silently falling back to some other installation.
  if [ -n "${DSH_SDD_KIT_CLI:-}" ]; then
    if [ -f "$DSH_SDD_KIT_CLI" ]; then
      printf '%s' "$DSH_SDD_KIT_CLI"
      return 0
    fi
    return 1
  fi
  CLI=$(node -e '
    try {
      const path = require("path");
      const pkg = require.resolve("dsh-sdd-kit/package.json");
      process.stdout.write(path.join(path.dirname(pkg), "bin", "sdd-kit.mjs"));
    } catch (_) { process.exit(1); }
  ' 2>/dev/null) && [ -n "$CLI" ] && { printf '%s' "$CLI"; return 0; }
  GLOBAL_ROOT=$(npm root -g 2>/dev/null || true)
  if [ -n "$GLOBAL_ROOT" ] && [ -f "$GLOBAL_ROOT/dsh-sdd-kit/bin/sdd-kit.mjs" ]; then
    printf '%s' "$GLOBAL_ROOT/dsh-sdd-kit/bin/sdd-kit.mjs"
    return 0
  fi
  return 1
}
