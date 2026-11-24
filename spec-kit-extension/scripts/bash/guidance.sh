#!/bin/sh
# Session-start guidance emitter. Delegates to the host-neutral CLI so the
# text has exactly one editable source (src/core/guidance.mjs).
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/_cli.sh"

if CLI_PATH=$(resolve_sdd_kit_cli) && [ -f "$CLI_PATH" ]; then
  exec node "$CLI_PATH" guidance --text "$@"
fi
# A missing installation degrades silently: never break a host session.
exit 0
