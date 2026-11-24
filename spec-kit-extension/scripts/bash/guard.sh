#!/bin/sh
# Planning-phase guard. Read-only: delegates to `sdd-kit guard` and mirrors its
# exit code so a host hook can stop the command.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/_cli.sh"

if ! CLI_PATH=$(resolve_sdd_kit_cli) || [ ! -f "$CLI_PATH" ]; then
  # Cannot judge without the CLI: allow the command rather than block blindly.
  echo "dsh-sdd-kit 未安装，跳过规划期护栏。" >&2
  exit 0
fi

exec node "$CLI_PATH" guard "$@"
