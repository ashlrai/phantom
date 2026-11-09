#!/bin/bash
# report-export.sh — scheduled entrypoint for `phm fleet report-export`
# (RQ-REPORTS-NO-GROK-1). Builds ~/.ashlr-runs/export/report-0730.md and
# report-2000.md from the world model, the recorded jobs ledger and leader
# intents; deterministic, no LLM. dispatchd.py fires this at 07:25 and 19:55
# America/New_York once per day per slot; running it by hand is safe — the
# command's per-day marker skips reports already built.
#
# Installed to ~/.ashlr-runs/bin via fleet/sync.py (manifest class: managed).
set -u
RUNS="${ASHLR_RUNS_DIR:-$HOME/.ashlr-runs}"
EXPORT_DIR="$RUNS/export"
mkdir -p "$EXPORT_DIR"
LOG="$EXPORT_DIR/report-export.log"
CLI=""
for candidate in phm ashlr; do
  if command -v "$candidate" >/dev/null 2>&1; then
    CLI="$candidate"
    break
  fi
done
if [ -z "$CLI" ]; then
  printf '%s report-export: no phm/ashlr binary on PATH\n' "$(date '+%F %T')" >>"$LOG" 2>/dev/null || true
  exit 0
fi
"$CLI" fleet report-export --slot "${1:-auto}" --runs-dir "$RUNS" --json >>"$LOG" 2>&1
status=$?
if [ "$status" -ne 0 ]; then
  printf '%s report-export: %s fleet report-export exited %s\n' "$(date '+%F %T')" "$CLI" "$status" >>"$LOG" 2>/dev/null || true
fi
exit "$status"
