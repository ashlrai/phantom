#!/bin/bash
# Hermetic integration coverage: real Git and OS locks, fake provider/GitHub CLIs.
set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/mac-bridge-test.XXXXXX")
REAL_GIT=$(command -v git)
export REAL_GIT PYTHONDONTWRITEBYTECODE=1
export HOME="$ROOT/home" BRIDGE_RUNS_DIR="$ROOT/runs" BRIDGE_PROJECTS_DIR="$ROOT/projects"
export BRIDGE_RUN_ID=integration-run BRIDGE_TEST_STATE="$ROOT/state"
mkdir -p "$HOME" "$BRIDGE_RUNS_DIR/bin" "$BRIDGE_PROJECTS_DIR/wt" "$BRIDGE_TEST_STATE" "$ROOT/bin"
cleanup() {
  touch "$BRIDGE_TEST_STATE/release" 2>/dev/null || :
  # Only processes created by this fixture are addressed; never inspect host claims.
  for pidfile in "$BRIDGE_TEST_STATE"/*.pid; do
    [ -f "$pidfile" ] || continue
    pid=$(cat "$pidfile")
    kill "$pid" 2>/dev/null || :
  done
  if [ "${KEEP_BRIDGE_TEST_TMP:-0}" = 1 ]; then
    echo "Fixture retained: $ROOT"
  else
    rm -rf "$ROOT"
  fi
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
PASS=0
pass() { PASS=$((PASS + 1)); echo "ok $PASS - $*"; }
now_ms() { python3 -c 'import time; print(time.time_ns() // 1000000)'; }
wait_for() {
  file=$1
  for ((attempt=0; attempt<200; attempt++)); do
    [ -f "$file" ] && return 0
    sleep .05
  done
  fail "timed out waiting for $file"
}
cat > "$ROOT/bin/git" <<'MOCK'
#!/bin/bash
set -eu
args=("$@")
if [ "${1:-}" = -C ]; then shift 2; fi
case "${1:-} ${2:-} ${3:-}" in
  'fetch '*) printf 'fetch\n' >> "$BRIDGE_TEST_STATE/fetches"; [ ! -f "$BRIDGE_TEST_STATE/fail-fetch" ] || exit 1;;
  'remote get-url origin') echo https://github.com/ashlrai/phantom.git; exit 0;;
esac
for arg in "${args[@]}"; do
  if [ "$arg" = push ]; then
    printf 'push\n' >> "$BRIDGE_TEST_STATE/pushes"
    exit 0
  fi
done
exec "$REAL_GIT" "${args[@]}"
MOCK
cat > "$ROOT/bin/sandbox-exec" <<'MOCK'
#!/bin/bash
set -eu
[ "${1:-}" = -f ] && shift 2
exec "$@"
MOCK
cat > "$ROOT/bin/codex" <<'MOCK'
#!/bin/bash
set -eu
job=$(basename "$PWD")
if ! mkdir "$BRIDGE_TEST_STATE/session-$job" 2>/dev/null; then
  touch "$BRIDGE_TEST_STATE/duplicate"
  exit 1
fi
printf '%s\n' "$$" > "$BRIDGE_TEST_STATE/$job.pid"
printf 'ready\n'
while [ ! -f "$BRIDGE_TEST_STATE/release" ] && [ ! -f "$BRIDGE_TEST_STATE/release-$job" ]; do sleep .05; done
MOCK
cat > "$ROOT/bin/gh" <<'MOCK'
#!/bin/bash
set -eu
printf '%s\n' "$1 $2" >> "$BRIDGE_TEST_STATE/gh-calls"
case "$1 $2" in
 'repo view') case " $* " in *defaultBranchRef*) echo main;; esac;;
 'pr create') echo https://github.com/ashlrai/phantom/pull/999;;
 'pr merge'|'pr list'|'repo fork') :;;
 *) exit 1;;
esac
MOCK
chmod +x "$ROOT/bin/"*
export PATH="$ROOT/bin:$PATH"
"$REAL_GIT" init -q --bare "$ROOT/origin.git"
"$REAL_GIT" init -q -b main "$BRIDGE_PROJECTS_DIR/phantom"
"$REAL_GIT" -C "$BRIDGE_PROJECTS_DIR/phantom" config user.name 'Bridge Test'
"$REAL_GIT" -C "$BRIDGE_PROJECTS_DIR/phantom" config user.email 'bridge-test@example.invalid'
printf 'initial\n' > "$BRIDGE_PROJECTS_DIR/phantom/file.txt"
printf '**/guarded.txt @owner\n' > "$BRIDGE_PROJECTS_DIR/phantom/CODEOWNERS"
printf 'protected initial\n' > "$BRIDGE_PROJECTS_DIR/phantom/guarded.txt"
seq 1 600 > "$BRIDGE_PROJECTS_DIR/phantom/large.txt"
"$REAL_GIT" -C "$BRIDGE_PROJECTS_DIR/phantom" add .
"$REAL_GIT" -C "$BRIDGE_PROJECTS_DIR/phantom" commit -qm fixture
"$REAL_GIT" -C "$BRIDGE_PROJECTS_DIR/phantom" remote add origin "$ROOT/origin.git"
"$REAL_GIT" -C "$BRIDGE_PROJECTS_DIR/phantom" push -q origin main
"$REAL_GIT" --git-dir="$ROOT/origin.git" symbolic-ref HEAD refs/heads/main
"$REAL_GIT" -C "$BRIDGE_PROJECTS_DIR/phantom" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
launch() { printf 'Local fixture job\n' | bash "$SCRIPT_DIR/launch.sh" "$1" phantom codex-cmp frontier; }
release_job() {
  local job=$1
  touch "$BRIDGE_TEST_STATE/release-$job"
  for ((attempt=0; attempt<200; attempt++)); do
    if python3 "$SCRIPT_DIR/bridge.py" lock "$BRIDGE_PROJECTS_DIR/wt/$job" -- true >/dev/null 2>&1; then return 0; fi
    sleep .05
  done
  fail "agent claim did not release: $job"
}
publish() { bash "$SCRIPT_DIR/publish.sh" "$1"; }
assert_result() { grep -q "$2" "$BRIDGE_RUNS_DIR/$1.publish" || fail "$1 lacks $2"; }

start=$(now_ms)
pids=()
for ((i=1; i<=20; i++)); do launch "parallel-$i" > "$ROOT/launch-$i.out" 2>&1 & pids+=("$!"); done
for pid in "${pids[@]}"; do wait "$pid" || fail "parallel launch failed (see $ROOT)"; done
for ((i=1; i<=20; i++)); do wait_for "$BRIDGE_TEST_STATE/parallel-$i.pid"; done
elapsed=$(( $(now_ms) - start ))
[ "$elapsed" -lt 30000 ] || fail "20 launches took ${elapsed}ms (limit 30000)"
[ "$(wc -l < "$BRIDGE_TEST_STATE/fetches" | tr -d ' ')" = 1 ] || fail 'fetch was not shared per run'
[ ! -e "$BRIDGE_TEST_STATE/duplicate" ] || fail 'duplicate session'
pass "20 parallel launches ready in ${elapsed}ms; one shared fetch"

# Relaunch contention is simultaneous and must not overwrite the original claim/prompt.
cp "$BRIDGE_RUNS_DIR/parallel-1.prompt" "$ROOT/original.prompt"
pids=()
for ((i=1; i<=14; i++)); do
  (if launch parallel-1 > "$ROOT/duplicate-$i.out" 2>&1; then touch "$ROOT/unexpected-relaunch"; fi) & pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done
[ ! -e "$ROOT/unexpected-relaunch" ] || fail 'running claim accepted a relaunch'
[ ! -e "$BRIDGE_TEST_STATE/duplicate" ] || fail 'second provider session started'
cmp "$ROOT/original.prompt" "$BRIDGE_RUNS_DIR/parallel-1.prompt" || fail 'duplicate overwrote prompt'
pass '14 concurrent relaunches refuse a live PID/worktree claim'

# The empty fast path must bypass even a currently held worktree lock.
printf '# Notes only\n' > "$BRIDGE_PROJECTS_DIR/wt/parallel-1/BRIDGE_NOTES.md"
start=$(now_ms)
publish parallel-1 || fail 'empty publish failed while agent lock was held'
assert_result parallel-1 'RESULT EMPTY'
[ $(( $(now_ms) - start )) -lt 3000 ] || fail 'empty publish waited on a lock'
[ ! -e "$BRIDGE_TEST_STATE/gh-calls" ] || fail 'empty publish contacted GitHub'
pass 'notes-only empty publish bypasses a live worktree lock and GitHub'

printf 'agent change\n' >> "$BRIDGE_PROJECTS_DIR/wt/parallel-1/file.txt"
if publish parallel-1; then fail 'nonempty publish entered active claim'; fi
[ ! -e "$BRIDGE_TEST_STATE/gh-calls" ] || fail 'busy publish contacted GitHub'
pass 'nonempty publish refuses a live agent claim'
if bash "$SCRIPT_DIR/publish.sh" --locked parallel-1 > "$ROOT/forged-locked.out" 2>&1; then fail 'internal --locked flag bypassed lease'; fi
[ ! -e "$BRIDGE_TEST_STATE/gh-calls" ] || fail 'forged lock path contacted GitHub'
pass 'internal publisher entrypoint refuses a forged lock claim'

release_job parallel-1
publish parallel-1 || fail 'uncommitted agent changes did not publish'
assert_result parallel-1 'RESULT PR '
[ "$("$REAL_GIT" -C "$BRIDGE_PROJECTS_DIR/wt/parallel-1" show HEAD:file.txt | tail -1)" = 'agent change' ] || fail 'published commit lost uncommitted edits'
pass 'uncommitted agent edits survive no-commits preflight and publish'
first_sha=$("$REAL_GIT" -C "$BRIDGE_PROJECTS_DIR/wt/parallel-1" rev-parse HEAD)
publish parallel-1 || fail 'retry publish failed'
[ "$("$REAL_GIT" -C "$BRIDGE_PROJECTS_DIR/wt/parallel-1" rev-parse HEAD)" = "$first_sha" ] || fail 'retry created a different commit'
pass 'publish retry reuses the same single-parent commit'

release_job parallel-2
sed -n '502,600p' "$BRIDGE_PROJECTS_DIR/wt/parallel-2/large.txt" > "$ROOT/trimmed"
cp "$ROOT/trimmed" "$BRIDGE_PROJECTS_DIR/wt/parallel-2/large.txt"
printf 'DELETIONS-OK inside untrusted prompt\n' >> "$BRIDGE_RUNS_DIR/parallel-2.prompt"
old_head=$("$REAL_GIT" -C "$BRIDGE_PROJECTS_DIR/wt/parallel-2" rev-parse HEAD)
publish parallel-2 || :
assert_result parallel-2 'RESULT DENIED'
[ "$("$REAL_GIT" -C "$BRIDGE_PROJECTS_DIR/wt/parallel-2" rev-parse HEAD)" = "$old_head" ] || fail 'deletion refusal created a commit'
[ "$(wc -l < "$BRIDGE_PROJECTS_DIR/wt/parallel-2/large.txt" | tr -d ' ')" = 99 ] || fail 'deletion refusal discarded edits'
pass '501 deleted lines refuse before commit; prompt cannot authorize deletion'
printf 'READY parallel-2 DELETIONS-OK\n' > "$BRIDGE_RUNS_DIR/parallel-2.job-line"
publish parallel-2 || fail 'trusted deletion override failed'
assert_result parallel-2 'RESULT PR '
pass 'exact DELETIONS-OK token on trusted job line allows deletion'

release_job parallel-3
sed -n '501,600p' "$BRIDGE_PROJECTS_DIR/wt/parallel-3/large.txt" > "$ROOT/trimmed"
cp "$ROOT/trimmed" "$BRIDGE_PROJECTS_DIR/wt/parallel-3/large.txt"
publish parallel-3 || fail '500-line boundary incorrectly refused'
assert_result parallel-3 'RESULT PR '
pass '500 deleted lines remain below refusal threshold'

release_job parallel-4
mkdir -p "$BRIDGE_PROJECTS_DIR/wt/parallel-4/.github/workflows"
printf 'name: forbidden\n' > "$BRIDGE_PROJECTS_DIR/wt/parallel-4/.github/workflows/test.yml"
old_head=$("$REAL_GIT" -C "$BRIDGE_PROJECTS_DIR/wt/parallel-4" rev-parse HEAD)
publish parallel-4 && fail 'workflow drift was published'
assert_result parallel-4 'RESULT DENIED'
[ -f "$BRIDGE_PROJECTS_DIR/wt/parallel-4/.github/workflows/test.yml" ] || fail 'refusal removed user files'
[ "$("$REAL_GIT" -C "$BRIDGE_PROJECTS_DIR/wt/parallel-4" rev-parse HEAD)" = "$old_head" ] || fail 'protected refusal changed HEAD'
pass 'protected workflow refusal preserves edits and HEAD'
release_job parallel-6
printf 'protected edit\n' >> "$BRIDGE_PROJECTS_DIR/wt/parallel-6/guarded.txt"
old_head=$("$REAL_GIT" -C "$BRIDGE_PROJECTS_DIR/wt/parallel-6" rev-parse HEAD)
publish parallel-6 && fail 'CODEOWNERS glob bypassed at repository root'
assert_result parallel-6 'RESULT DENIED'
[ "$("$REAL_GIT" -C "$BRIDGE_PROJECTS_DIR/wt/parallel-6" rev-parse HEAD)" = "$old_head" ] || fail 'CODEOWNERS refusal changed HEAD'
pass 'CODEOWNERS double-star pattern protects root paths'

if launch ../escape > "$ROOT/invalid.out" 2>&1; then fail 'path traversal job was accepted'; fi
[ ! -e "$BRIDGE_PROJECTS_DIR/escape" ] || fail 'invalid job escaped worktree root'
pass 'job identifiers cannot traverse outside worktree root'

# OS advisory locks release on holder exit, without deleting or replacing lock files.
python3 "$SCRIPT_DIR/bridge.py" lock "$ROOT/stale-worktree" -- bash -c 'echo $$ > "$BRIDGE_TEST_STATE/lock-holder.pid"; touch "$BRIDGE_TEST_STATE/lock-held"; exec sleep 60' > "$ROOT/lock.out" 2>&1 &
lock_supervisor=$!
wait_for "$BRIDGE_TEST_STATE/lock-held"
lock_inode=$(python3 - "$BRIDGE_RUNS_DIR" "$ROOT/stale-worktree" <<'PYLOCK'
import hashlib, json, os, pathlib, sys
key = os.path.realpath(sys.argv[2])
path = pathlib.Path(sys.argv[1]) / 'locks' / (hashlib.sha256(key.encode()).hexdigest() + '.lock')
data = json.loads(path.read_text())
data['created_at'] = 1
path.write_text(json.dumps(data))
print(path.stat().st_ino)
PYLOCK
)
if python3 "$SCRIPT_DIR/bridge.py" lock "$ROOT/stale-worktree" -- true; then fail 'live lock was broken'; fi
kill "$(cat "$BRIDGE_TEST_STATE/lock-holder.pid")"
wait "$lock_supervisor" || :
python3 "$SCRIPT_DIR/bridge.py" lock "$ROOT/stale-worktree" -- true || fail 'dead holder lock did not recover'
new_inode=$(python3 - "$BRIDGE_RUNS_DIR" "$ROOT/stale-worktree" <<'PYLOCK'
import hashlib, os, pathlib, sys
path = pathlib.Path(sys.argv[1]) / 'locks' / (hashlib.sha256(os.path.realpath(sys.argv[2]).encode()).hexdigest() + '.lock')
print(path.stat().st_ino)
PYLOCK
)
[ "$lock_inode" = "$new_inode" ] || fail 'lock recovery replaced or deleted inode'
pass 'aged live lock never breaks; dead holder releases without replacing inode'

# A fresh run fetches once again, while a failed run caches its failure.
BRIDGE_RUN_ID=second-run launch second-1 > "$ROOT/second-1.out" 2>&1 & second_pid=$!
BRIDGE_RUN_ID=second-run launch second-2 > "$ROOT/second-2.out" 2>&1 & second_pid2=$!
wait "$second_pid" || fail 'second run launch failed'
wait "$second_pid2" || fail 'second run launch failed'
wait_for "$BRIDGE_TEST_STATE/second-1.pid"
wait_for "$BRIDGE_TEST_STATE/second-2.pid"
[ "$(wc -l < "$BRIDGE_TEST_STATE/fetches" | tr -d ' ')" = 2 ] || fail 'new run did not fetch exactly once'
pass 'new queue run refreshes the shared fetch once'
touch "$BRIDGE_TEST_STATE/fail-fetch"
if BRIDGE_RUN_ID=failed-run launch failure-1 > "$ROOT/failure-1.out" 2>&1; then fail 'failed fetch launched agent'; fi
if BRIDGE_RUN_ID=failed-run launch failure-2 > "$ROOT/failure-2.out" 2>&1; then fail 'cached fetch failure launched agent'; fi
[ "$(wc -l < "$BRIDGE_TEST_STATE/fetches" | tr -d ' ')" = 3 ] || fail 'failed run repeated fetch'
[ ! -e "$BRIDGE_TEST_STATE/failure-1.pid" ] && [ ! -e "$BRIDGE_TEST_STATE/failure-2.pid" ] || fail 'failed fetch started provider'
rm "$BRIDGE_TEST_STATE/fail-fetch"
pass 'failed fetch is cached for the run and starts no sessions'

python3 - "$BRIDGE_RUNS_DIR/parallel-20.claim" "$BRIDGE_PROJECTS_DIR/wt/parallel-20" <<'PYCLAIM'
import json, os, sys
claim = json.load(open(sys.argv[1]))
assert claim['worktree'] == os.path.realpath(sys.argv[2])
os.kill(claim['pid'], 0)
os.kill(claim['supervisor_pid'], 0)
PYCLAIM
supervisor=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["supervisor_pid"])' "$BRIDGE_RUNS_DIR/parallel-20.claim")
kill -9 "$supervisor"
# The agent wrapper inherited the open lock descriptor. Age can never evict it.
sleep 1.1
if launch parallel-20 > "$ROOT/killed-supervisor.out" 2>&1; then fail 'supervisor death admitted duplicate agent'; fi
[ ! -e "$BRIDGE_TEST_STATE/duplicate" ] || fail 'supervisor death created duplicate'
release_job parallel-20
pass 'PID/worktree claim and inherited lease survive supervisor SIGKILL'

# A kernel-free lock still cannot admit a second agent recorded by PID+worktree.
python3 - "$BRIDGE_RUNS_DIR/free-claim.claim" "$ROOT/free-claim" "$$" <<'PYCLAIM'
import json, os, sys
json.dump({'pid': int(sys.argv[3]), 'created_at': 1, 'process_start': '', 'worktree': os.path.realpath(sys.argv[2])}, open(sys.argv[1], 'w'))
PYCLAIM
if python3 "$SCRIPT_DIR/bridge.py" lock "$ROOT/free-claim" -- true > "$ROOT/free-claim.out" 2>&1; then fail 'live PID claim ignored without kernel lock'; fi
grep -q live-claim "$ROOT/free-claim.out" || fail 'live claim not diagnosed'
python3 - "$BRIDGE_RUNS_DIR/free-claim.claim" <<'PYCLAIM'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
data['worktree'] += '-different'
json.dump(data, open(path, 'w'))
PYCLAIM
if python3 "$SCRIPT_DIR/bridge.py" lock "$ROOT/free-claim" -- true > "$ROOT/mismatch.out" 2>&1; then fail 'mismatched worktree claim accepted'; fi
grep -q claim-worktree-mismatch "$ROOT/mismatch.out" || fail 'mismatched claim not diagnosed'
printf '{}\n' > "$BRIDGE_RUNS_DIR/free-claim.claim"
if python3 "$SCRIPT_DIR/bridge.py" lock "$ROOT/free-claim" -- true > "$ROOT/malformed.out" 2>&1; then fail 'malformed claim accepted'; fi
grep -q invalid-claim-metadata "$ROOT/malformed.out" || fail 'malformed claim not diagnosed'
pass 'independent live, mismatched and malformed claims fail closed without kernel lock'

# Stale metadata is recovered only after both holder death and minimum age.
python3 - "$SCRIPT_DIR/bridge.py" "$ROOT/stale-metadata" <<'PYSTALE'
import importlib.util, json, os, subprocess, sys, time
spec = importlib.util.spec_from_file_location('bridge_test', sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
child = subprocess.Popen(['true'])
child.wait()
path = bridge.lock_path(os.path.realpath(sys.argv[2]))
path.write_text(json.dumps({'pid': child.pid, 'process_start': '', 'created_at': time.time(), 'active': True, 'worktree': os.path.realpath(sys.argv[2])}))
PYSTALE
if python3 "$SCRIPT_DIR/bridge.py" lock "$ROOT/stale-metadata" -- true > "$ROOT/recent-stale.out" 2>&1; then fail 'recent stale claim ignored age'; fi
sleep 1.1
python3 "$SCRIPT_DIR/bridge.py" lock "$ROOT/stale-metadata" -- true || fail 'old dead claim did not recover'
pass 'stale claim recovery requires dead PID and minimum age'

# Completed jobs may be resumed without rebasing their original publish base.
cp "$BRIDGE_RUNS_DIR/parallel-3.base" "$ROOT/reuse.base"
printf 'follow-up commit\n' >> "$BRIDGE_PROJECTS_DIR/wt/parallel-3/file.txt"
"$REAL_GIT" -C "$BRIDGE_PROJECTS_DIR/wt/parallel-3" add file.txt
"$REAL_GIT" -C "$BRIDGE_PROJECTS_DIR/wt/parallel-3" commit -qm 'local completed-job follow-up'
reuse_head=$("$REAL_GIT" -C "$BRIDGE_PROJECTS_DIR/wt/parallel-3" rev-parse HEAD)
"$REAL_GIT" -C "$BRIDGE_PROJECTS_DIR/wt/parallel-3" update-index --skip-worktree file.txt
"$REAL_GIT" -C "$BRIDGE_PROJECTS_DIR/wt/parallel-3" update-index --assume-unchanged file.txt
[ "$("$REAL_GIT" -C "$BRIDGE_PROJECTS_DIR/wt/parallel-3" ls-files -v -- file.txt)" = 's file.txt' ] || fail 'fixture lacks lowercase skip-worktree flag'
fetch_count=$(wc -l < "$BRIDGE_TEST_STATE/fetches" | tr -d ' ')
# Removing only the completed mock-session sentinels allows a legitimate new agent.
rmdir "$BRIDGE_TEST_STATE/session-parallel-3"
rm "$BRIDGE_TEST_STATE/parallel-3.pid" "$BRIDGE_TEST_STATE/release-parallel-3"
launch parallel-3 > "$ROOT/reuse.out" 2>&1 || fail 'completed worktree reuse refused'
wait_for "$BRIDGE_TEST_STATE/parallel-3.pid"
cmp "$ROOT/reuse.base" "$BRIDGE_RUNS_DIR/parallel-3.base" || fail 'worktree reuse changed original base'
[ "$("$REAL_GIT" -C "$BRIDGE_PROJECTS_DIR/wt/parallel-3" rev-parse HEAD)" = "$reuse_head" ] || fail 'worktree reuse discarded local commit'
[ "$(wc -l < "$BRIDGE_TEST_STATE/fetches" | tr -d ' ')" = "$fetch_count" ] || fail 'worktree reuse performed another fetch'
[ "$("$REAL_GIT" -C "$BRIDGE_PROJECTS_DIR/wt/parallel-3" ls-files -v -- file.txt)" = 'H file.txt' ] || fail 'worktree reuse left hidden index flags'
pass 'completed worktree reuse preserves base, avoids fetch and clears lowercase skip flags'
release_job parallel-3
"$REAL_GIT" init -q "$BRIDGE_PROJECTS_DIR/other"
if printf 'wrong repository\n' | bash "$SCRIPT_DIR/launch.sh" parallel-3 other codex-cmp frontier > "$ROOT/wrong-repo.out" 2>&1; then fail 'completed job reused a different requested repository'; fi
grep -q worktree-repository-mismatch "$ROOT/wrong-repo.out" || fail 'wrong-repository reuse not diagnosed'
cmp "$ROOT/reuse.base" "$BRIDGE_RUNS_DIR/parallel-3.base" || fail 'wrong-repository refusal changed base'
pass 'completed worktree reuse refuses a different source repository'

python3 - "$BRIDGE_RUNS_DIR/queue.v1.jsonl" <<'PY'
import json, sys
rows = [json.loads(line) for line in open(sys.argv[1])]
assert rows, 'no stations'
assert all(row['schema'] == 'queue.v1' for row in rows)
assert all(isinstance(row['duration_ms'], (int, float)) and row['duration_ms'] >= 0 for row in rows)
launches = [row for row in rows if row['station'] == 'launch' and row['outcome'] == 'ready' and row['run_id'] == 'integration-run']
assert len({row['job'] for row in launches}) == 20, launches
assert all(row['duration_ms'] < 30000 for row in launches), launches
assert any(row['station'] == 'publish' for row in rows), 'missing publish station'
assert not any(row.get('outcome') == 'lock-broken' for row in rows), 'lock break recorded'
PY
pass 'queue.v1 JSONL records bounded launch and publish durations, zero lock breaks'
printf 'PASS: %s integration assertions; 20 launch wall time %sms\n' "$PASS" "$elapsed"
