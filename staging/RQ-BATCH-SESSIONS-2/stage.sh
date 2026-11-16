#!/bin/bash
# stage.sh: copy the RQ-BATCH-SESSIONS-2 Security pin package into ~/.ashlr-runs/staged/RQ-BATCH-SESSIONS-2/.
# Staging only. It never writes ~/.ashlr-runs/bin, never runs install.sh, and never touches a LaunchAgent.
# Security reviews the staged copy, pins the sha256 values in SHA256SUMS, and installs through the normal pin path.
set -euo pipefail
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mac=$here/../../contrib/mac
dest=${1:-$HOME/.ashlr-runs/staged/RQ-BATCH-SESSIONS-2}
case $dest in */bin|*/bin/*) echo "stage.sh: refusing a bin directory: $dest" >&2; exit 2;; esac
mkdir -p "$dest"
for f in dispatchd.py batcher.py batch_sessions.py batch-launch.sh batch-sessions.json process_snapshot.py \
         zombie_report.py wt_closed_prune.py install.sh; do
  cp "$mac/$f" "$dest/$f"
done
cp "$here/README.md" "$here/SHA256SUMS" "$here/models.fragment.json" "$dest/"
(cd "$dest" && shasum -a 256 -c SHA256SUMS)
echo "staged in $dest (not installed)"
