#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if ! "$SCRIPT_DIR/install-fdb-client.sh" --check; then
  echo "dfs-api requires the matching FoundationDB client library."
  echo "Install it with: tools/install-fdb-client.sh"
  exit 1
fi

if [ -f /.dockerenv ] || [ "${DUST_IN_CONTAINER:-}" = 1 ]; then
  bash "$SCRIPT_DIR/../dev/scripts/ensure-fdb.sh"
fi

exec "$@"
