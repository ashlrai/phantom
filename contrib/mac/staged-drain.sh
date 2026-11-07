#!/usr/bin/env bash
# Bash 3.2 compatible entrypoint for the staged-drain tick. No credentials, no token creation,
# no network beyond the read-only queued-runs poll inside staged_drain.py.
set -euo pipefail
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 -B "$HERE/staged_drain.py" "$@"
