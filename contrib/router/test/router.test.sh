#!/usr/bin/env bash
# Hermetic checks for the Mac runner. Codex auth files are planted and must stay byte-for-byte.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
fail() {
  printf 'FAIL %s\n' "$*" >&2
  exit 1
}

tmp=$(mktemp -d)
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

export HOME="$tmp/home"
mkdir -p "$HOME"
export ASHLR_ROUTER_HOME="$HOME/ashlr-router"
export ASHLR_ROUTER_CONFIG="$ASHLR_ROUTER_HOME/config.json"
export ASHLR_TEST_GH_LOG="$tmp/gh.log"
export ASHLR_TEST_CODEX_LOG="$HOME/codex-invocations.log"
export ASHLR_TEST_REMOTE="$tmp/remote.git"
export GIT_AUTHOR_NAME=router
export GIT_AUTHOR_EMAIL=router@example.com
export GIT_COMMITTER_NAME=router
export GIT_COMMITTER_EMAIL=router@example.com

mkdir -p "$ASHLR_ROUTER_HOME" "$tmp/bin" "$tmp/src"
cp "$ROOT/config.example.json" "$ASHLR_ROUTER_CONFIG"
node -e '
  const fs = require("fs");
  const file = process.argv[1];
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  cfg.job_timeout_s = 30;
  cfg.phantom_route = false;
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
' "$ASHLR_ROUTER_CONFIG"

plant_auth() {
  local home_name=$1
  local dir="$HOME/$home_name"
  mkdir -p "$dir"
  printf 'secret-%s\n' "$home_name" > "$dir/auth.json"
  printf 'backup-%s\n' "$home_name" > "$dir/auth.json.bak"
  cp "$dir/auth.json" "$dir/auth.json.backup"
}
plant_auth .codex
plant_auth .codex-2
auth_digest() {
  find "$HOME/.codex" "$HOME/.codex-2" -type f -print0 | sort -z | xargs -0 sha256sum
}
before_auth=$(auth_digest)

git init -q -b master "$tmp/src"
printf 'seed\n' > "$tmp/src/README.md"
git -C "$tmp/src" add README.md
git -C "$tmp/src" commit -q -m 'seed'
git init -q -b master --bare "$ASHLR_TEST_REMOTE"
git -C "$tmp/src" remote add origin "$ASHLR_TEST_REMOTE"
git -C "$tmp/src" push -q origin master

cat > "$tmp/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${ASHLR_TEST_GH_LOG:?}"
cmd=$1
shift || true
case "$cmd" in
  auth)
    cat >/dev/null
    exit 0
    ;;
  label)
    exit 0
    ;;
  issue)
    sub=${1:-}
    shift || true
    case "$sub" in
      edit|comment) exit 0 ;;
      list) printf '[]\n'; exit 0 ;;
      create) printf 'https://example.test/issues/1\n'; exit 0 ;;
      *) printf 'unexpected issue %s\n' "$sub" >&2; exit 1 ;;
    esac
    ;;
  repo)
    sub=${1:-}
    shift || true
    case "$sub" in
      clone)
        dest=$2
        git clone "$ASHLR_TEST_REMOTE" "$dest"
        exit $?
        ;;
      view)
        printf '{"defaultBranchRef":{"name":"master"}}\n'
        exit 0
        ;;
      *) printf 'unexpected repo %s\n' "$sub" >&2; exit 1 ;;
    esac
    ;;
  pr)
    sub=${1:-}
    shift || true
    case "$sub" in
      list) printf '[]\n'; exit 0 ;;
      create) printf 'https://example.test/pull/9\n'; exit 0 ;;
      *) printf 'unexpected pr %s\n' "$sub" >&2; exit 1 ;;
    esac
    ;;
  *)
    printf 'unexpected gh %s\n' "$cmd" >&2
    exit 1
    ;;
esac
EOF

cat > "$tmp/bin/codex" <<'EOF'
#!/usr/bin/env bash
{
  printf 'CMD'
  printf ' %q' "$@"
  printf '\nHOME=%s\nALT=%s\n' "${CODEX_HOME:-}" "${CODEX_HOME_ALT:-}"
} >> "$HOME/codex-invocations.log"
if [[ "${1:-}" == "logout" || "${2:-}" == "logout" ]]; then
  printf 'LOGOUT\n' >> "$HOME/codex-invocations.log"
  exit 99
fi
if [[ "${1:-}" == "login" && "${2:-}" == "status" ]]; then
  printf 'Logged in using ChatGPT\n'
  exit 0
fi
if [[ "${1:-}" == "--version" ]]; then
  printf 'codex 0.164.0\n'
  exit 0
fi
if [[ " $* " == *" read-only "* ]]; then
  printf 'sk-SECRET-TOKEN\n'
  exit 0
fi
cat >/dev/null || true
wt=""
prev=""
for arg in "$@"; do
  if [[ "$prev" == "--cd" ]]; then
    wt=$arg
  fi
  prev=$arg
done
case "${CODEX_HOME:-}" in
  */.codex-2)
    if [[ -n "$wt" ]]; then
      printf 'from personal\n' > "$wt/FROM_PERSONAL.txt"
    fi
    exit 0
    ;;
  *)
    printf 'Failed to refresh token. Please reauthenticate.\n' >&2
    exit 1
    ;;
esac
EOF
chmod +x "$tmp/bin/gh" "$tmp/bin/codex"

NODE_BIN=$(command -v node)
GIT_BIN=$(command -v git)
PATH="$tmp/bin:$(dirname "$NODE_BIN"):$(dirname "$GIT_BIN"):/usr/bin:/bin"
export PATH

if grep -n 'auth.json' "$ROOT/ashlr-router" "$ROOT"/lib/*.sh "$ROOT/lib/router_io.cjs" "$ROOT/omlx-mac.sh" "$ROOT/install.sh" >/dev/null; then
  fail 'runner names auth.json'
fi
if grep -n 'codex logout' "$ROOT/ashlr-router" "$ROOT"/lib/*.sh "$ROOT/lib/router_io.cjs" "$ROOT/omlx-mac.sh" "$ROOT/install.sh" >/dev/null; then
  fail 'runner invokes codex logout'
fi

printf 'not logged in\n' | node "$ROOT/lib/router_io.cjs" auth-failed && fail 'plain logged-out text marked an auth failure'
printf 'Failed to refresh token\n' | node "$ROOT/lib/router_io.cjs" auth-failed
printf 'Logged in using ChatGPT\n' | node "$ROOT/lib/router_io.cjs" codex-login --code 0 | grep -qx in

# shellcheck source=../ashlr-router
source "$ROOT/ashlr-router"
router_init
router_ensure_state
mkdir -p "$ASHLR_ROUTER_HOME/tmp"
body=$ASHLR_ROUTER_HOME/tmp/body.txt
printf 'Describe the change in the worktree.\n' > "$body"

node -e '
  const fs = require("fs");
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const lines = [
    { event: "job", cli: "codex", account: "personal", ts: now, remaining: 9000 },
    { event: "job", cli: "codex", account: "work", ts: now, remaining: 3 },
  ];
  fs.appendFileSync(process.argv[1], lines.map((row) => JSON.stringify(row)).join("\n") + "\n");
' "$ASHLR_ROUTER_HOME/ledger.jsonl"
picked=$(router_pick_codex_account dry | tail -n 1)
case "$picked" in
  work$'\t'*) ;;
  *) fail "work account was not spent first: $picked" ;;
esac

router_run_job "ashlrai/phantom" 7 codex workhorse "" "fixture" "$body" "" work

after_auth=$(auth_digest)
if [[ "$before_auth" != "$after_auth" ]]; then
  fail 'Codex auth files or backups changed'
fi
if grep -q 'LOGOUT' "$ASHLR_TEST_CODEX_LOG"; then
  fail 'codex logout was invoked'
fi
first_home=$(awk -F= '/^HOME=/ { print $2; exit }' "$ASHLR_TEST_CODEX_LOG")
case "$first_home" in
  */.codex) ;;
  *) fail "first Codex home was $first_home" ;;
esac
if ! awk -F= '/^HOME=/ && $2 ~ /\/\.codex-2$/ { found=1 } END { exit found ? 0 : 1 }' "$ASHLR_TEST_CODEX_LOG"; then
  fail 'job did not fail over to ~/.codex-2'
fi
if ! awk -F= '/^ALT=/ && $2 ~ /\/\.codex-2$/ { found=1 } END { exit found ? 0 : 1 }' "$ASHLR_TEST_CODEX_LOG"; then
  fail 'CODEX_HOME_ALT was not the personal home'
fi

node -e '
  const fs = require("fs");
  const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const jobs = lines.filter((row) => row.event === "job" && row.exit !== undefined && row.account);
  const work = jobs.find((row) => row.account === "work");
  const personal = jobs.find((row) => row.account === "personal");
  if (!work || work.exit === 0) process.exit(2);
  if (!String(work.warning || "").includes("marked dead")) process.exit(3);
  if (!personal || personal.exit !== 0) process.exit(4);
  const pools = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).pools || [];
  const workPool = pools.find((row) => row.poolId === "codex-work");
  const personalPool = pools.find((row) => row.poolId === "codex-personal");
  if (!workPool || workPool.dead !== true || workPool.role !== "work" || workPool.spend !== "hard" || workPool.order !== 1) process.exit(5);
  if (!personalPool || personalPool.dead === true || personalPool.role !== "personal" || personalPool.order !== 2) process.exit(6);
  if (workPool.primary !== true) process.exit(7);
' "$ASHLR_ROUTER_HOME/ledger.jsonl" "$ASHLR_ROUTER_HOME/state.json"

picked=$(router_pick_codex_account dry | tail -n 1)
case "$picked" in
  personal$'\t'*) ;;
  *) fail "dead work pool was retried: $picked" ;;
esac

: > "$ASHLR_ROUTER_HOME/logs/router.log"
"$ROOT/ashlr-router" keepalive
if grep -q 'sk-SECRET-TOKEN' "$ASHLR_ROUTER_HOME/logs/router.log"; then
  fail 'keepalive log contains token text'
fi
if ! grep -q 'keepalive success' "$ASHLR_ROUTER_HOME/logs/router.log"; then
  fail 'keepalive did not record success'
fi
after_keep=$(auth_digest)
if [[ "$before_auth" != "$after_keep" ]]; then
  fail 'keepalive changed Codex auth files or backups'
fi

mkdir -p "$ASHLR_ROUTER_HOME/locks/cli-codex"
printf '%s\n' "$$" > "$ASHLR_ROUTER_HOME/locks/cli-codex/pid"
if ! router_cli_busy codex; then
  fail 'one Codex CLI lock was not busy'
fi
rm -rf "$ASHLR_ROUTER_HOME/locks/cli-codex"
mkdir -p "$ASHLR_ROUTER_HOME/locks/cli-codex-personal"
printf '%s\n' "$$" > "$ASHLR_ROUTER_HOME/locks/cli-codex-personal/pid"
if router_cli_busy codex; then
  fail 'a Codex account lock counted as a second CLI slot'
fi
rm -rf "$ASHLR_ROUTER_HOME/locks/cli-codex-personal"

printf 'ok codex auth failover\n'

node -e '
  const fs = require("fs");
  const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  cfg.codex.accounts = [
    { id: "durable", home: "~/.codex-2", durability: "durable", primary: true },
    { id: "fragile", home: "~/.codex", durability: "fragile", primary: false },
  ];
  fs.writeFileSync(process.argv[2], JSON.stringify(cfg));
' "$ASHLR_ROUTER_CONFIG" "$tmp/old-config.json"
old_first=$(node "$ROOT/lib/router_io.cjs" codex-accounts --config "$tmp/old-config.json" --home "$HOME" | head -n 1)
case "$old_first" in
  work$'\t'"$HOME/.codex") ;;
  *) fail "old Codex config did not put the work home first: $old_first" ;;
esac

got=$(printf 'You are using XAI_API_KEY sk-live-secret\n' | node "$ROOT/lib/router_io.cjs" grok-auth)
printf '%s\n' "$got" | grep -qx 'metered'
case "$got" in
  *sk-live-secret*) fail 'grok classifier printed a key' ;;
esac
printf 'subscription_tier SuperGrok\n' | node "$ROOT/lib/router_io.cjs" grok-auth | grep -qx 'subscription'
printf 'Not signed in\n' | node "$ROOT/lib/router_io.cjs" grok-auth | grep -qx 'out'

cat > "$tmp/bin/ashlr" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$HOME/ashlr-invocations.log"
if [[ "$*" == *status* ]]; then
  printf '%s\n' '{"status":{"state":"ready","connected":true,"orgId":"org-test"},"budget":{"acuRemaining":12,"canLaunch":{"ok":true}}}'
  exit 0
fi
if [[ "$*" == *launch* ]]; then
  printf '%s\n' '{"ok":true,"task":{"sessionUrl":"https://app.devin.ai/sessions/abc","pr":null}}'
  exit 0
fi
printf 'cog_secret_key\n' >&2
exit 1
EOF
chmod +x "$tmp/bin/ashlr"
export DEVIN_ORG_ID=org-test
: > "$ASHLR_ROUTER_HOME/logs/router.log"
router_probe_devin
if grep -q 'cog_secret_key' "$ASHLR_ROUTER_HOME/logs/router.log"; then
  fail 'devin probe logged secret text'
fi
if ! grep -q 'devin ready' "$ASHLR_ROUTER_HOME/logs/router.log"; then
  fail 'devin probe did not record ready'
fi
node "$ROOT/lib/router_io.cjs" record-grok-auth --state "$ASHLR_ROUTER_HOME/state.json" --class subscription >/dev/null
scores=$(printf 'codex\t10\nclaude\t10\ndevin\t10\ngrok\t10\nomlx\t10\n' | node "$ROOT/lib/router_io.cjs" budget-scores --state "$ASHLR_ROUTER_HOME/state.json" --now "$(date +%s)")
node -e '
  const rows = Object.fromEntries(process.argv[1].trim().split("\n").map((line) => {
    const [cli, score] = line.split("\t");
    return [cli, Number(score)];
  }));
  if (!(rows.codex > rows.devin && rows.devin > rows.grok && rows.grok > rows.claude)) process.exit(1);
' "$scores"

if node "$ROOT/lib/router_io.cjs" disk-allows --free-kb $((25 * 1024 * 1024)) --size-bytes $((10 * 1024 * 1024 * 1024)) --floor-gb 20; then
  fail 'a download that leaves under 20 GB was allowed'
fi
if ! node "$ROOT/lib/router_io.cjs" disk-allows --free-kb $((40 * 1024 * 1024)) --size-bytes $((10 * 1024 * 1024 * 1024)) --floor-gb 20; then
  fail 'a download that leaves at least 20 GB was refused'
fi

cat > "$tmp/bin/curlmock" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${OMLX_CURL_LOG:?}"
if [[ "$*" == *model-info* ]]; then
  if [[ "${OMLX_UNKNOWN_SIZE:-0}" == 1 ]]; then
    printf '{}\n'
  else
    printf '{"size":10737418240}\n'
  fi
  exit 0
fi
if [[ "$*" == *hf/download* ]]; then
  printf 'DOWNLOADED\n' >> "${OMLX_CURL_LOG:?}"
  exit 0
fi
if [[ "$*" == *chat/completions* ]]; then
  if [[ "${OMLX_HEALTH_OK:-0}" == 1 ]]; then
    printf '{"choices":[{"message":{"content":"ok"}}]}\n'
    exit 0
  fi
  exit 1
fi
if [[ "$*" == */v1/models* ]]; then
  if [[ "${OMLX_HEALTH_OK:-0}" == 1 ]]; then
    printf '{"data":[{"id":"mlx-community/Qwen3-8B-4bit"}]}\n'
    exit 0
  fi
  exit 1
fi
exit 1
EOF
cat > "$tmp/bin/ollama-mock" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$HOME/ollama.log"
exit 0
EOF
chmod +x "$tmp/bin/curlmock" "$tmp/bin/ollama-mock"
export OMLX_CURL="$tmp/bin/curlmock"
export OMLX_CURL_LOG="$tmp/curl.log"
export OMLX_OLLAMA="$tmp/bin/ollama-mock"
export OMLX_FREE_KB=$((25 * 1024 * 1024))
export OMLX_HEALTH_OK=0
: > "$OMLX_CURL_LOG"
if bash "$ROOT/omlx-mac.sh" download --check-only mlx-community/Qwen3-8B-4bit; then
  fail 'oMLX download check allowed a low-disk download'
fi
if grep -q DOWNLOADED "$OMLX_CURL_LOG"; then
  fail 'a refused download was posted'
fi
export OMLX_UNKNOWN_SIZE=1
: > "$OMLX_CURL_LOG"
if bash "$ROOT/omlx-mac.sh" download --check-only mlx-community/Qwen3-8B-4bit; then
  fail 'unknown model size was downloaded'
fi
unset OMLX_UNKNOWN_SIZE
export OMLX_FREE_KB=$((40 * 1024 * 1024))
bash "$ROOT/omlx-mac.sh" download --check-only mlx-community/Qwen3-8B-4bit >/dev/null
if grep -q DOWNLOADED "$OMLX_CURL_LOG"; then
  fail 'check-only posted a download'
fi
if bash "$ROOT/omlx-mac.sh" --prune-ollama qwen3.8:27b-ctx64k --omlx-model mlx-community/Qwen3-8B-4bit; then
  fail 'Ollama model was removed before oMLX was healthy'
fi
if [[ -f "$HOME/ollama.log" ]]; then
  fail 'ollama rm ran before the health check passed'
fi
export OMLX_HEALTH_OK=1
bash "$ROOT/omlx-mac.sh" --prune-ollama qwen3.8:27b-ctx64k --omlx-model mlx-community/Qwen3-8B-4bit >/dev/null
if ! grep -q 'rm qwen3.8:27b-ctx64k' "$HOME/ollama.log"; then
  fail 'healthy oMLX model was not pruned'
fi
if bash "$ROOT/omlx-mac.sh" prune qwen3.8:27b-ctx64k; then
  fail 'prune without --prune-ollama was accepted'
fi

(
  export HOME="$tmp/install-home"
  unset DEVIN_ORG_ID
  mkdir -p "$HOME/bin"
  cat > "$HOME/bin/launchctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$HOME/launchctl.log"
exit 0
EOF
  chmod +x "$HOME/bin/launchctl"
  PATH="$HOME/bin:$PATH" ASHLR_ROUTER_SKIP_PROBE=1 bash "$ROOT/install.sh" >/dev/null
  [[ -f "$HOME/Library/LaunchAgents/com.ashlr.router.plist" ]]
  [[ -f "$HOME/Library/LaunchAgents/com.ashlr.router.keepalive.plist" ]]
  grep -q 'keepalive' "$HOME/Library/LaunchAgents/com.ashlr.router.keepalive.plist"
  if grep -q 'DEVIN_ORG_ID' "$HOME/Library/LaunchAgents/com.ashlr.router.plist"; then
    printf 'FAIL unset DEVIN_ORG_ID was written\n' >&2
    exit 1
  fi
  [[ -x "$HOME/ashlr-router/bin/omlx-mac.sh" ]]
)

printf 'ok pools keepalive devin grok omlx\n'
