#!/usr/bin/env bash
# Tests for queue-gate.sh and queue-reaper.sh with a stubbed gh.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"
cat > "$T/bin/gh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
case "$1 $2" in
  "api repos/"*) [ "${GH_FAIL:-0}" = 1 ] && exit 1; echo "${GH_PER_REPO:-0}" ;;
  "pr list") case "$*" in *ashlrai/phantom\ *) printf '%b' "${GH_PRS_PHANTOM:-}";; *ashlrai/locus\ *) printf '%b' "${GH_PRS_LOCUS:-}";; esac ;;
  "pr view") echo OPEN ;;
  "pr checks") echo "${GH_P0_PENDING:-0}" ;;
  *) : ;;
esac
STUB
chmod +x "$T/bin/gh"
export PATH="$T/bin:$PATH" GH_LOG="$T/gh.log" QUEUE_REAPER_STATE="$T/state"
pass=0 fail=0
ok() { if eval "$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $1"; fi; }
reset() { : > "$GH_LOG"; rm -rf "$T/state"; unset GH_FAIL GH_PRS_PHANTOM GH_PRS_LOCUS GH_P0_PENDING; }

# Gate
reset; . "$HERE/queue-gate.sh"
export GH_PER_REPO=3; queue_gate_check 2>/dev/null; f=$QUEUE_GATE_FLAGS
ok "above threshold drafts (21>15)" '[ "$f" = "--draft" ] && [ "$QUEUE_GATE_HELD" = 1 ]'
queue_gate_label https://x/pr/1 ashlrai/phantom
ok "held PR gets label" 'grep -q "add-label queue-held" "$GH_LOG"'
reset; export GH_PER_REPO=2; queue_gate_check 2>/dev/null; f=$QUEUE_GATE_FLAGS
ok "below threshold (14) opens normally" '[ -z "$f" ]'
reset; export GH_FAIL=1; queue_gate_check 2>"$T/err"; rc=$?; f=$QUEUE_GATE_FLAGS
ok "gh failure fails open" '[ -z "$f" ] && [ $rc = 0 ] && grep -q WARN "$T/err"'
reset; export GH_PER_REPO=10; QUEUE_GATE_THRESHOLD=100; queue_gate_check 2>/dev/null; f=$QUEUE_GATE_FLAGS; QUEUE_GATE_THRESHOLD=15
ok "threshold env respected" '[ -z "$f" ]'

# Reaper
R="$HERE/queue-reaper.sh"
reset; export GH_PER_REPO=1
export GH_PRS_PHANTOM='10\t2026-10-26T01:00:00Z\ttrue\tdocs tweak\tqueue-held\n11\t2026-10-26T02:00:00Z\ttrue\tbridge: RQ-MAC-MEMORY\tqueue-held\n12\t2026-10-26T00:30:00Z\ttrue\tother\tqueue-held,ALIVE\n13\t2026-10-26T00:10:00Z\ttrue\tolder\tqueue-held\n'
export GH_PRS_LOCUS='217\t2026-10-26T05:00:00Z\ttrue\tspawn leak\tqueue-held\n'
out=$(bash "$R" --dry-run)
ok "dry-run makes no writes" '! grep -qE "pr ready|pr edit" "$GH_LOG"'
first3=$(echo "$out" | grep -o "ashlrai/[a-z-]*#[0-9]*" | head -3 | tr "\n" " ")
ok "P0 first oldest-first, batch 3" '[ "$first3" = "ashlrai/phantom#12 ashlrai/phantom#11 ashlrai/locus#217 " ]'
reset; export GH_PRS_PHANTOM GH_PRS_LOCUS GH_PER_REPO=1
export GH_PRS_PHANTOM='10\t2026-10-26T01:00:00Z\ttrue\tdocs tweak\tqueue-held\n11\t2026-10-26T02:00:00Z\ttrue\tMEMORY fix\tqueue-held\n'
bash "$R" >/dev/null
ok "real run readies and unlabels" 'grep -q "pr ready 11" "$GH_LOG" && grep -q "pr ready 10" "$GH_LOG" && grep -q "remove-label queue-held" "$GH_LOG"'
: > "$GH_LOG"; export GH_P0_PENDING=2 GH_PRS_PHANTOM='14\t2026-10-26T03:00:00Z\ttrue\tplain\tqueue-held\n'
out=$(bash "$R")
ok "non-P0 held while reaper P0 pending" 'echo "$out" | grep -q "hold ashlrai/phantom#14" && ! grep -q "pr ready 14" "$GH_LOG"'
export GH_P0_PENDING=0; : > "$GH_LOG"; bash "$R" >/dev/null
ok "non-P0 released once P0 green" 'grep -q "pr ready 14" "$GH_LOG"'
reset; export GH_PER_REPO=5 GH_PRS_PHANTOM='10\t2026-10-26T01:00:00Z\ttrue\tx\tqueue-held\n'
bash "$R" >/dev/null
ok "reaper holds above threshold" '! grep -q "pr ready" "$GH_LOG"'
reset; export GH_FAIL=1 GH_PRS_PHANTOM='10\t2026-10-26T01:00:00Z\ttrue\tx\tqueue-held\n'
bash "$R" >/dev/null; rc=$?
ok "reaper gh failure is a safe no-op" '[ $rc = 0 ] && ! grep -q "pr ready" "$GH_LOG"'
echo "queue-gate tests: $pass passed, $fail failed"
[ "$fail" = 0 ]
