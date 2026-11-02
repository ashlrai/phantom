#!/bin/bash
# Invoke the existing bridge launcher through this adapter. The launcher and
# publisher remain separately owned; this script neither installs nor publishes.
#
# Usage (legacy, unchanged):
#   with-memory.sh --job JOB -- /path/to/launch.sh JOB repo pool tier
#
# Usage (opt-in supervision: the launcher's own process group is paused and
# resumed under host memory pressure, while the admission shims still apply
# inside that same group):
#   with-memory.sh --supervise --job JOB \
#     --metrics /path/to/memguard.json --max-age-seconds 30 \
#     [--receipt-dir DIR] [--poll-seconds S] [--healthy-samples N] \
#     [--launch-wait-seconds S] [--deadline-seconds S] [--term-grace-seconds S] \
#     [--state-dir DIR] [--pause-file FILE] \
#     -- /path/to/launch.sh JOB repo pool tier
#
# --supervise is honoured only before the -- divider; after it the token is a
# literal child argument.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
supervised=0
for arg in "$@"; do
    [[ "$arg" == "--" ]] && break
    if [[ "$arg" == "--supervise" ]]; then
        supervised=1
        break
    fi
done
if [[ "$supervised" == "1" ]]; then
    exec python3 "$script_dir/memory_supervised.py" "$@"
fi
exec python3 "$script_dir/memory_admission.py" wrap "$@"
