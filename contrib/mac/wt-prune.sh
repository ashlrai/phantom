#!/usr/bin/env bash
# Bash 3.2 compatible entrypoint. No credentials or account access required.
set -euo pipefail
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 -B "$HERE/wt-prune.py" "$@"
