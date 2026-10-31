#!/bin/bash
# Invoke the existing bridge launcher through this adapter. The launcher and
# publisher remain separately owned; this script neither installs nor publishes.
# Usage: with-memory.sh --job JOB -- /path/to/launch.sh JOB repo pool tier
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$script_dir/memory_admission.py" wrap "$@"
