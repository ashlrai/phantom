#!/bin/sh
# Retry an eligible published worktree, or deferred cache cleanup on an idle cycle.
set -eu
bridge_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
python=/usr/bin/python3
if [ -x /opt/homebrew/bin/python3 ]; then python=/opt/homebrew/bin/python3
elif [ -x /usr/local/bin/python3 ]; then python=/usr/local/bin/python3; fi
exec "$python" -I -B "$bridge_dir/disk.py" reap "$@"
