#!/usr/bin/env bash
# Exercise the runner with local Git fixtures and stubbed external operations.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export HOME="$tmp/home"
mkdir -p "$HOME" "$tmp/bin"
export GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=router GIT_AUTHOR_EMAIL=router@example.test
export GIT_COMMITTER_NAME=router GIT_COMMITTER_EMAIL=router@example.test
export ASHLR_ROUTER_HOME="$HOME/router"
source "$ROOT/ashlr-router"
router_init
router_ensure_state
checks=0
fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }
expect() {
  [[ "$1" == "$2" ]] || fail "$3"
  checks=$((checks + 1))
}
wait_file() {
  local i=0
  while [[ ! -f "$1" ]]; do
    [[ "$i" -lt 200 ]] || fail "barrier timed out: $1"
    sleep 0.02
    i=$((i + 1))
  done
}

# Verify both consumers preserve an empty requested model when only a tier is
# supplied. Tab-delimited read collapses that leading empty field in Bash.
node - "$tmp/issues" <<'NODE'
const fs = require('fs');
const title = Buffer.from('fixture').toString('base64');
const rows = [
  ['fixture/fixture', 21, 'route:codex', title, Buffer.from('tier:cheap\r\n').toString('base64')],
  ['fixture/fixture', 22, 'route:codex,tier:frontier', title, Buffer.from('model: named-model \r\ntier:cheap\r\n').toString('base64')],
];
fs.writeFileSync(process.argv[2], rows.map(row => row.join('\t')).join('\n') + '\n');
NODE
router_backed_off() { return 1; }
router_decide() {
  printf '%s|%s|%s\n' "$1" "$2" "$3" >> "$tmp/decisions"
  printf 'skip\tfixture\n'
}
router_print_plan() { :; }
router_collect_issues() { cat "$tmp/issues"; }
router_active_jobs() { printf '0\n'; }
router_each_issue dry < "$tmp/issues"
expect "$(cat "$tmp/decisions")" $'codex|cheap|\ncodex|frontier|named-model' 'dry issue flow preserves tier-only and mixed directives'
: > "$tmp/decisions"
router_queue_jobs live
expect "$(cat "$tmp/decisions")" $'codex|cheap|\ncodex|frontier|named-model' 'live queue flow preserves tier-only and mixed directives'

# The worktree setup must trust the fetched default branch, including retained
# branches whose last tree matches that branch after an intervening commit.
git init -q -b master "$tmp/seed"
printf 'seed\n' > "$tmp/seed/README.md"
git -C "$tmp/seed" add README.md
git -C "$tmp/seed" commit -qm seed
git clone -q --bare "$tmp/seed" "$tmp/remote.git"
git clone -q "$tmp/remote.git" "$ROUTER_HOME/repos/fixture"
gh() {
  case "$1 $2" in
    'repo view') printf '{"defaultBranchRef":{"name":"master"}}\n' ;;
    *) fail "unexpected external gh operation: $1 $2" ;;
  esac
}
router_prepare_worktree fixture/fixture codex 1
base=$(git -C "$tmp/seed" rev-parse HEAD)
expect "$ROUTER_BASE_SHA" "$base" 'fresh worktree uses origin master SHA'
git -C "$ROUTER_WT" commit -qm retained --allow-empty
retained=$ROUTER_WT
ROUTER_BASE_SHA=untrusted
if router_prepare_worktree fixture/fixture codex 1; then
  fail 'retained worktree HEAD became the trusted base'
fi
expect "$ROUTER_BASE_SHA" '' 'refused retained worktree clears range base'
git -C "$ROUTER_HOME/repos/fixture" worktree remove "$retained"
if router_prepare_worktree fixture/fixture codex 1; then
  fail 'retained branch HEAD became the trusted base'
fi
expect "$ROUTER_BASE_SHA" '' 'refused retained branch clears range base'
router_prepare_worktree fixture/fixture codex 2
expect "$ROUTER_BASE_SHA" "$base" 'fresh branch remains available after refusals'

# Concurrent invocations block just before reading their generated argv so both
# custody files must coexist. The actual timeout supervisor launches each stub.
cat > "$tmp/bin/codex" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
wt=""
prev=""
for arg in "$@"; do
  if [[ "$prev" == --cd ]]; then wt=$arg; fi
  prev=$arg
done
cat >/dev/null
case "$(basename "$wt")" in
  concurrent-a) sleep 0.3 ;;
  concurrent-b) sleep 0.9 ;;
esac
printf '%s\n' "$wt"
EOF
chmod +x "$tmp/bin/codex"
export PATH="$tmp/bin:$PATH"
eval "$(declare -f router_read_nul | sed '1s/router_read_nul/original_read_nul/')"
eval "$(declare -f router_reap_model_group | sed '1s/router_reap_model_group/original_reap_model_group/')"
router_read_nul() {
  local label
  label=$(basename "$wt")
  touch "$tmp/ready-$label"
  wait_file "$tmp/ready-concurrent-a"
  wait_file "$tmp/ready-concurrent-b"
  find "$ROUTER_HOME/tmp" -name 'argv.*' -type f > "$tmp/argv-$label"
  original_read_nul
}
router_reap_model_group() {
  printf '%s\n' "$1" >> "$tmp/pgid-paths"
  if [[ -f "$1" ]]; then
    cat "$1" >> "$tmp/pgids"
    printf '\n' >> "$tmp/pgids"
  fi
  original_reap_model_group "$1"
}
ROUTER_TIMEOUT_S=10
printf 'fixture prompt\n' > "$tmp/prompt"
mkdir -p "$tmp/concurrent-a" "$tmp/concurrent-b"
router_invoke_cli codex - "$tmp/concurrent-a" "$tmp/prompt" "$tmp/a.out" "$tmp/a.err" &
pid_a=$!
router_invoke_cli codex - "$tmp/concurrent-b" "$tmp/prompt" "$tmp/b.out" "$tmp/b.err" &
pid_b=$!
wait "$pid_a" || fail 'first concurrent invocation failed'
wait "$pid_b" || fail 'second concurrent invocation failed'
expect "$(cat "$tmp/a.out")" "$tmp/concurrent-a" 'first invocation received its own argv'
expect "$(cat "$tmp/b.out")" "$tmp/concurrent-b" 'second invocation received its own argv'
expect "$(sort -u "$tmp/argv-concurrent-a" "$tmp/argv-concurrent-b" | wc -l | tr -d ' ')" 2 'two argv custody paths coexist'
expect "$(sort -u "$tmp/pgid-paths" | wc -l | tr -d ' ')" 2 'model process groups use distinct custody paths'
expect "$(sort -u "$tmp/pgids" | wc -l | tr -d ' ')" 2 'two model process groups were supervised'
expect "$(find "$ROUTER_HOME/tmp" -name 'argv.*' -o -name 'model-pgid.*')" '' 'argv and process-group custody files are removed'
eval "$(declare -f original_read_nul | sed '1s/original_read_nul/router_read_nul/')"
eval "$(declare -f original_reap_model_group | sed '1s/original_reap_model_group/router_reap_model_group/')"

# Run the complete job attempt classifier with real state/ledger writes and
# local worktree preparation. Stub only model execution and external delivery.
router_start_heartbeat() { router_write_heartbeat "$1"; }
router_open_pr_url() { printf '\n'; }
router_release_reserve() { :; }
router_model_for() { printf '%s\t\n' -; }
router_comment_file() { :; }
router_drop_claim() { printf '%s\n' "$2" >> "$tmp/dropped"; }
router_commit_and_push() { return 2; }
router_verify() { return 0; }
router_failover_codex() { printf 'failover\n' >> "$tmp/failovers"; return 1; }
router_invoke_cli() {
  printf 'invoked\n' >> "$tmp/attempts"
  printf '%s\n' "$scenario_text" > "$5"
  : > "$6"
  return "$scenario_rc"
}
if router_run_job fixture/fixture 1 codex workhorse '' subject "$tmp/prompt" '' work; then
  fail 'job accepted a retained worktree ahead of origin'
fi
[[ ! -e "$tmp/attempts" ]] || fail 'model started before retained worktree refusal'
checks=$((checks + 1))
issue=10
for scenario in success auth quota timeout; do
  issue=$((issue + 1))
  printf '{}\n' > "$ROUTER_STATE"
  rm -f "$tmp/failovers" "$tmp/dropped" "$ROUTER_HOME/ledger.jsonl"
  case "$scenario" in
    success) scenario_rc=0; scenario_text='Tests cover refresh token, session expired, rate limit and 429. 0 remaining; reset 2020-01-01T00:00:00Z' ;;
    auth) scenario_rc=1; scenario_text='Authentication failed: refresh token session expired' ;;
    quota) scenario_rc=1; scenario_text='rate limit 429 reset 2099-01-01T00:00:00Z' ;;
    timeout) scenario_rc=124; scenario_text='Timed out while testing refresh token and session expired' ;;
  esac
  router_run_job fixture/fixture "$issue" codex workhorse '' subject "$tmp/prompt" '' work
  node - "$ROUTER_STATE" "$ROUTER_HOME/ledger.jsonl" "$scenario" <<'NODE'
const fs = require('fs');
const assert = require('assert/strict');
const [stateFile, ledgerFile, scenario] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const rows = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').map(JSON.parse);
assert.equal(rows.length, 1, `${scenario}: one model attempt`);
const dead = (state.pools || []).some(pool => pool.accountId === 'work' && pool.dead);
assert.equal(dead, scenario === 'auth', `${scenario}: account auth status`);
assert.equal(Boolean(state.cooldowns && state.cooldowns['codex:work']), scenario === 'quota', `${scenario}: cooldown`);
assert.equal(Boolean(rows[0].rate_limit), scenario === 'quota', `${scenario}: ledger rate limit`);
if (scenario === 'success') {
  assert.notEqual(rows[0].outcome, 'limited');
  const pool = state.pools.find(pool => pool.accountId === 'work');
  assert(pool, 'work account remains present');
  assert(!pool.expiresAt, 'quoted past reset must not expire the pool');
  assert.notEqual(pool.quotaRemaining, 0, 'quoted exhausted quota must not disable the pool');
}
if (scenario === 'timeout') assert.equal(Object.keys(state.timeouts || {}).length, 1);
NODE
  checks=$((checks + 1))
  if [[ "$scenario" == auth || "$scenario" == quota ]]; then
    expect "$(cat "$tmp/failovers")" failover "$scenario failure retains failover"
  else
    [[ ! -e "$tmp/failovers" ]] || fail "$scenario caused auth or quota failover"
    checks=$((checks + 1))
  fi
done
trap - RETURN

# Distinct mirror and diff artifacts must survive overlapping readers/writers.
ROUTER_LEDGER_MIRROR=1
gh() {
  case "$1 $2" in
    'issue list') printf '[{"number":1,"title":"router-ledger"}]\n' ;;
    'issue comment')
      local file="" previous="" arg
      for arg in "$@"; do
        [[ "$previous" != --body-file ]] || file=$arg
        previous=$arg
      done
      printf '%s\n' "$file" >> "$tmp/mirror-paths"
      touch "$tmp/mirror-$(basename "$file")"
      local i=0
      while [[ "$(find "$tmp" -maxdepth 1 -name 'mirror-mirror.*' | wc -l | tr -d ' ')" -lt 2 ]]; do
        [[ "$i" -lt 200 ]] || fail 'mirror overlap barrier timed out'
        sleep 0.02
        i=$((i + 1))
      done
      cat "$file" >> "$tmp/mirror-bodies"
      ;;
    *) fail 'unexpected mirror external operation' ;;
  esac
}
router_mirror_line '{"event":"job","repo":"fixture/a","issue":1}' &
mirror_a=$!
router_mirror_line '{"event":"job","repo":"fixture/b","issue":2}' &
mirror_b=$!
wait "$mirror_a" || fail 'first mirror failed'
wait "$mirror_b" || fail 'second mirror failed'
expect "$(sort -u "$tmp/mirror-paths" | wc -l | tr -d ' ')" 2 'mirror comments have independent body files'
node - "$tmp/mirror-bodies" <<'NODE'
const fs = require('fs');
const assert = require('assert/strict');
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
assert.deepEqual(rows.map(row => row.repo).sort(), ['fixture/a', 'fixture/b']);
NODE
checks=$((checks + 1))
expect "$(find "$ROUTER_HOME/tmp" -name 'mirror.*')" '' 'mirror custody files are removed'

for label in a b; do
  git clone -q "$tmp/remote.git" "$tmp/diff-$label"
  cat > "$tmp/diff-$label.txt" <<EOF
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-seed
+result-$label
EOF
done
git_bin=$(type -P git)
git() {
  if [[ "${3:-}" == apply && "${4:-}" == --check ]]; then
    local label
    label=$(basename "$2")
    printf '%s\n' "$5" >> "$tmp/diff-paths"
    touch "$tmp/ready-$label"
    wait_file "$tmp/ready-diff-a"
    wait_file "$tmp/ready-diff-b"
  fi
  "$git_bin" "$@"
}
router_apply_local_diff "$tmp/diff-a" "$tmp/diff-a.txt" &
diff_a=$!
router_apply_local_diff "$tmp/diff-b" "$tmp/diff-b.txt" &
diff_b=$!
wait "$diff_a" || fail 'first overlapping local diff failed'
wait "$diff_b" || fail 'second overlapping local diff failed'
unset -f git
expect "$(sort -u "$tmp/diff-paths" | wc -l | tr -d ' ')" 2 'local diffs have independent artifact paths'
expect "$(cat "$tmp/diff-a/README.md")" result-a 'first local diff stayed in its worktree'
expect "$(cat "$tmp/diff-b/README.md")" result-b 'second local diff stayed in its worktree'
expect "$(find "$ROUTER_HOME/tmp" -name 'omlx.*')" '' 'local diff custody files are removed'

printf 'No diff was produced.\n' > "$tmp/no-diff"
if router_apply_local_diff "$tmp/diff-a" "$tmp/no-diff"; then
  fail 'missing unified diff was accepted'
fi
expect "$(find "$ROUTER_HOME/tmp" -name 'omlx.*')" '' 'missing diff leaves no custody file'
git() {
  printf '%s\n' "$*" >> "$tmp/apply-calls"
  "$git_bin" "$@"
}
# This patch expects the seed content, which has already changed to result-a.
if router_apply_local_diff "$tmp/diff-a" "$tmp/diff-a.txt" 2> "$tmp/apply.err"; then
  fail 'a patch that fails its check was accepted'
fi
unset -f git
expect "$(wc -l < "$tmp/apply-calls" | tr -d ' ')" 1 'failed check never invokes git apply'
expect "$(cat "$tmp/diff-a/README.md")" result-a 'failed check preserves the worktree'
expect "$(find "$ROUTER_HOME/tmp" -name 'omlx.*')" '' 'failed check removes its custody file'

# Exercise both consumers of the directive pair, preserving a missing model
# field and label precedence through to the route decision and queued job.
router_backed_off() { return 1; }
router_active_jobs() { printf '0\n'; }
router_cli_at_capacity() { return 1; }
router_collect_issues() { cat "$tmp/directive-issues"; }
router_launch_from_file() { cp "$1" "$tmp/launched"; }
router_decide() {
  printf '%s\t%s\n' "$2" "$3" >> "$tmp/decisions"
  printf 'use\tcodex\t%s\t-\t\twork\n' "$2"
}
for directive_case in body-tier label-tier label-model; do
  case "$directive_case" in
    body-tier) labels=route:codex; wanted=$'cheap\t' ;;
    label-tier) labels=route:codex,tier:frontier; wanted=$'frontier\t' ;;
    label-model) labels=route:codex,tier:frontier,model:label-model; wanted=$'frontier\tlabel-model' ;;
  esac
  issue_body=$'tier:cheap\r\n'
  if [[ "$directive_case" == label-model ]]; then
    issue_body=$'model: body-model \r\ntier:cheap\r\n'
  fi
  node - "$labels" "$issue_body" > "$tmp/directive-issues" <<'NODE'
const [labels, body] = process.argv.slice(2);
process.stdout.write(['fixture/fixture', '101', labels,
  Buffer.from('directive fixture').toString('base64'),
  Buffer.from(body).toString('base64')].join('\t') + '\n');
NODE
  : > "$tmp/decisions"
  router_each_issue live < "$tmp/directive-issues" > "$tmp/each-result"
  expect "$(cat "$tmp/decisions")" "$wanted" "$directive_case reaches direct issue decision"
  : > "$tmp/decisions"
  rm -f "$tmp/launched"
  router_queue_jobs live
  expect "$(cat "$tmp/decisions")" "$wanted" "$directive_case reaches queued issue decision"
  [[ -s "$tmp/launched" ]] || fail "$directive_case was not queued"
  checks=$((checks + 1))
done
printf 'PASS %s runner regression checks\n' "$checks"
