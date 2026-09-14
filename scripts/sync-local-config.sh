#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if command -v python3 >/dev/null 2>&1; then
  exec python3 "$ROOT/scripts/sync-local-config.py" "$@"
fi
exec python "$ROOT/scripts/sync-local-config.py" "$@"
