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
env | awk -F= '$1 ~ /^(GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|XAI_API_KEY|DEVIN_API_KEY|DEVIN_ORG_ID)$/ { print $1 }' | sort >> "$HOME/ashlr-env.names"
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
export DEVIN_API_KEY=devin-secret
export GH_TOKEN=gh-secret
export OPENAI_API_KEY=openai-secret
export XAI_API_KEY=xai-secret
: > "$HOME/ashlr-env.names"
: > "$ASHLR_ROUTER_HOME/logs/router.log"
router_probe_devin
if grep -q 'cog_secret_key' "$ASHLR_ROUTER_HOME/logs/router.log"; then
  fail 'devin probe logged secret text'
fi
if ! grep -q 'devin ready' "$ASHLR_ROUTER_HOME/logs/router.log"; then
  fail 'devin probe did not record ready'
fi
if grep -q 'devin-secret\|gh-secret\|openai-secret\|xai-secret' "$ASHLR_ROUTER_HOME/logs/router.log"; then
  fail 'devin probe log contains a secret value'
fi
if ! grep -qx 'DEVIN_API_KEY' "$HOME/ashlr-env.names" || ! grep -qx 'DEVIN_ORG_ID' "$HOME/ashlr-env.names"; then
  fail 'devin status did not receive DEVIN_API_KEY and DEVIN_ORG_ID'
fi
if grep -Eq '^(GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|XAI_API_KEY)$' "$HOME/ashlr-env.names"; then
  fail 'devin status received a non-Devin token'
fi
: > "$HOME/ashlr-env.names"
router_run_devin_job "ashlrai/phantom" 11 codex workhorse "" "devin fixture" "$body" ""
if grep -Eq '^(GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|XAI_API_KEY)$' "$HOME/ashlr-env.names"; then
  fail 'devin launch received a non-Devin token'
fi
if ! grep -qx 'DEVIN_API_KEY' "$HOME/ashlr-env.names"; then
  fail 'devin launch did not receive DEVIN_API_KEY'
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
  node -e 'const fs=require("fs"); const m=fs.statSync(process.argv[1]).mode & 0o777; if (m!==0o600) process.exit(1)' \
    "$HOME/ashlr-router/config.json"
)

if [[ "$(umask)" != "0077" ]]; then
  fail "runner umask is $(umask)"
fi
if grep -n 'git add -A\|git add --all\|git add \.' "$ROOT/ashlr-router" "$ROOT"/lib/*.sh "$ROOT/lib/router_io.cjs"; then
  fail 'runner stages with git add -A'
fi
if grep -n '@latest' "$ROOT/ashlr-router" "$ROOT"/lib/*.sh "$ROOT/lib/router_io.cjs" "$ROOT/config.example.json"; then
  fail 'runner still installs @latest'
fi
if ! node "$ROOT/lib/router_io.cjs" branch-ok 'router/codex/9'; then
  fail 'router/codex/9 was rejected'
fi
if ! node "$ROOT/lib/router_io.cjs" branch-ok 'cursor/router-security'; then
  fail 'cursor/router-security was rejected'
fi
if node "$ROOT/lib/router_io.cjs" branch-ok 'feature/router'; then
  fail 'a non-router branch was accepted'
fi
node "$ROOT/lib/router_io.cjs" emit-config "$ROOT/config.example.json" | grep -q "ROUTER_FRESHNESS_ENABLED='0'" \
  || fail 'freshness is on by default'
node "$ROOT/lib/router_io.cjs" emit-config "$ROOT/config.example.json" | grep -q "ROUTER_HOST_VERIFY='0'" \
  || fail 'host verify is on by default'
node "$ROOT/lib/router_io.cjs" emit-config "$ROOT/config.example.json" | grep -q "ROUTER_LEDGER_MIRROR='0'" \
  || fail 'ledger mirror is on by default'
aged=$(printf '%s\n' '{"1.0.0":"2020-01-01T00:00:00.000Z","2.0.0":"2026-10-25T00:00:00.000Z","modified":"2026-10-25T00:00:00.000Z"}' \
  | node "$ROOT/lib/router_io.cjs" aged-release --days 3 --now 1761436800)
printf '%s\n' "$aged" | grep -qx '1.0.0' || fail "aged release was $aged"
usage=$(printf 'SECRET TOKEN line\nrate limit\n3 remaining\nreset 2026-01-02T03:04:05Z\n' \
  | node "$ROOT/lib/router_io.cjs" parse-usage --now 1761436800)
node -e '
  const o = JSON.parse(process.argv[1]);
  if (Object.prototype.hasOwnProperty.call(o, "raw") || Object.prototype.hasOwnProperty.call(o, "usage")) process.exit(2);
  if (JSON.stringify(o).includes("SECRET")) process.exit(3);
  if (String(o.remaining) !== "3" || o.outcome !== "limited" || o.reset !== "2026-01-02T03:04:05Z") process.exit(4);
' "$usage" || fail 'parseUsage kept transcript text'
printf 'SECRET\n' > "$tmp/raw-secret.txt"
node "$ROOT/lib/router_io.cjs" append-job "$tmp/ledger-privacy.jsonl" \
  --ts 2026-01-02T03:04:05Z --event job --repo ashlrai/phantom --issue 1 --cli codex \
  --exit 0 --remaining 4 --reset 2026-01-02T03:04:05Z --raw-file "$tmp/raw-secret.txt" --usage 'SECRET TOKEN'
if grep -q 'SECRET\|"raw"\|"usage"' "$tmp/ledger-privacy.jsonl"; then
  fail 'ledger stored transcript text'
fi
mirror_before=$(wc -l < "$ASHLR_TEST_GH_LOG")
router_mirror_line '{"raw":"SECRET-MIRROR","outcome":"ok"}'
mirror_after=$(wc -l < "$ASHLR_TEST_GH_LOG")
if [[ "$mirror_before" != "$mirror_after" ]]; then
  fail 'ledger mirror posted by default'
fi

vdir=$tmp/verify-repo
mkdir -p "$vdir/node_modules"
printf '%s\n' '{"scripts":{"test":"true","lint":"true"}}' > "$vdir/package.json"
cat > "$tmp/bin/npm" <<'EOF'
#!/usr/bin/env bash
printf 'HOME=%s\n' "$HOME" >> "${TMPDIR:-/tmp}/npm-verify.txt"
if [[ -f "$HOME/.codex/auth.json" || -d "$HOME/.config/gh" ]]; then
  printf 'SAW_CREDENTIAL_DIR\n' >> "${TMPDIR:-/tmp}/npm-verify.txt"
fi
env | awk -F= '/TOKEN|KEY/ { print $1 }' >> "${TMPDIR:-/tmp}/npm-verify.txt"
exit 0
EOF
chmod +x "$tmp/bin/npm"
rm -f "${TMPDIR:-/tmp}/npm-verify.txt"
router_verify "$vdir"
if [[ -f "${TMPDIR:-/tmp}/npm-verify.txt" ]]; then
  fail 'default host verify ran npm'
fi
export ROUTER_HOST_VERIFY=1
router_verify "$vdir"
unset ROUTER_HOST_VERIFY
if ! grep -q '^HOME=' "${TMPDIR:-/tmp}/npm-verify.txt"; then
  fail 'optional verify did not run'
fi
verify_home=$(awk -F= '/^HOME=/ { print $2; exit }' "${TMPDIR:-/tmp}/npm-verify.txt")
if [[ "$verify_home" == "$HOME" || "$verify_home" == *"/.codex"* || "$verify_home" == *"/.config/gh"* ]]; then
  fail "optional verify HOME was $verify_home"
fi
if grep -q 'SAW_CREDENTIAL_DIR\|GH_TOKEN\|OPENAI_API_KEY\|XAI_API_KEY' "${TMPDIR:-/tmp}/npm-verify.txt"; then
  fail 'optional verify could see credential material'
fi
if [[ -d "$verify_home" ]]; then
  fail 'verify temp HOME was left behind'
fi
if ! trap -p EXIT | grep -q cleanup; then
  fail 'verify replaced the EXIT trap'
fi

cat > "$tmp/bin/omlx" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${OMLX_SERVE_LOG:?}"
exit 0
EOF
chmod +x "$tmp/bin/omlx"
export OMLX_SERVE_FOREGROUND=1
export OMLX_SERVE_LOG=$tmp/omlx-args.txt
# shellcheck source=../omlx-mac.sh
source "$ROOT/omlx-mac.sh"
omlx_start_loopback >/dev/null
if ! grep -q -- '--host 127.0.0.1' "$OMLX_SERVE_LOG" || ! grep -q -- '--port 8000' "$OMLX_SERVE_LOG"; then
  fail "omlx was not bound to loopback: $(cat "$OMLX_SERVE_LOG")"
fi
if grep -q '0.0.0.0' "$OMLX_SERVE_LOG"; then
  fail 'omlx bind included 0.0.0.0'
fi

ROUTER_PICKED_CLIS=""
if router_cli_at_capacity codex; then
  fail 'an idle CLI was at capacity'
fi
router_note_cli_pick codex
if ! router_cli_at_capacity codex; then
  fail 'max_per_cli did not count a selected CLI'
fi
why=$(router_cli_block_reason codex workhorse dry | tr -d '\n')
if [[ "$why" != "busy" ]]; then
  fail "selected codex was not busy: $why"
fi
ROUTER_PICKED_CLIS=""

lock=$ASHLR_ROUTER_HOME/locks/jobs/pidcheck
rm -rf "$lock"
(
  router_acquire_lock "$lock"
  sleep 30
) &
child=$!
ready=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if [[ -f "$lock/pid" ]]; then
    ready=1
    break
  fi
  sleep 0.1
done
if [[ "$ready" -ne 1 ]]; then
  fail 'child lock was not created'
fi
got=$(cat "$lock/pid")
if [[ "$got" == "$$" ]]; then
  fail "lock pid is the parent $$"
fi
router_release_lock "$lock"
if [[ ! -d "$lock" ]]; then
  fail 'parent released a child lock'
fi
kill "$child" 2>/dev/null || true
wait "$child" 2>/dev/null || true
rm -rf "$lock"
lock2=$ASHLR_ROUTER_HOME/locks/jobs/pidcheck-owner
(
  router_acquire_lock "$lock2"
  router_release_lock "$lock2"
)
if [[ -d "$lock2" ]]; then
  fail 'lock owner did not release it'
fi

empty=$ASHLR_ROUTER_HOME/locks/jobs/empty-pid
rm -rf "$empty"
mkdir -p "$empty"
if ! router_lock_alive "$empty"; then
  fail 'a fresh empty lock was treated as dead'
fi
if router_acquire_lock "$empty"; then
  fail 'a fresh empty lock was stolen'
fi
if [[ -f "$empty/pid" ]]; then
  fail 'a fresh empty lock gained a pid'
fi
touch -d '10 seconds ago' "$empty"
if router_lock_alive "$empty"; then
  fail 'a stale empty lock stayed alive'
fi
if ! router_acquire_lock "$empty"; then
  fail 'a stale empty lock could not be replaced'
fi
if [[ ! -s "$empty/pid" ]]; then
  fail 'replaced lock had no pid'
fi
router_release_lock "$empty"
if [[ -d "$empty" ]]; then
  fail 'replaced lock was not released'
fi

: > "$ASHLR_TEST_CODEX_LOG"
touch "$ASHLR_ROUTER_HOME/PAUSE"
gh_before=$(wc -l < "$ASHLR_TEST_GH_LOG")
router_queue_jobs live
gh_after=$(wc -l < "$ASHLR_TEST_GH_LOG")
if [[ "$gh_before" != "$gh_after" ]]; then
  fail 'PAUSE did not stop selection'
fi
printf 'ashlrai/phantom\t8\tuse\tcodex\tworkhorse\t-\t\twork\t\ttitle\t%s\n' "$body" > "$ASHLR_ROUTER_HOME/tmp/paused-queue"
router_launch_from_file "$ASHLR_ROUTER_HOME/tmp/paused-queue"
if [[ -s "$ASHLR_TEST_CODEX_LOG" ]]; then
  fail 'PAUSE did not stop launch'
fi
rm -f "$ASHLR_ROUTER_HOME/PAUSE"

real_git=$GIT_BIN
cat > "$tmp/bin/git" <<EOF
#!/usr/bin/env bash
if [[ "\$*" == *push* ]]; then
  printf '%s\\n' "\$*" >> "$tmp/push.log"
  exit 0
fi
exec "$real_git" "\$@"
EOF
chmod +x "$tmp/bin/git"
hash -r
: > "$tmp/push.log"
unset ROUTER_BASE_SHA

deny=$tmp/deny-repo
git init -q -b master "$deny"
mkdir -p "$deny/.github"
printf '%s\n' '/.github/** @owner' '/CODEOWNERS @owner' 'src/core/authority/** @owner' > "$deny/.github/CODEOWNERS"
printf 'seed\n' > "$deny/README.md"
git -C "$deny" add README.md .github/CODEOWNERS
git -C "$deny" commit -q -m seed
mkdir -p "$deny/.github/workflows" "$deny/src/core/authority"
printf 'name: ci\n' > "$deny/.github/workflows/ci.yml"
printf 'tier1\n' > "$deny/src/core/authority/protected-paths.ts"
printf 'safe\n' > "$deny/src/ok.txt"
deny_before=$(git -C "$deny" rev-parse HEAD)
if router_commit_and_push "$deny" ashlrai/phantom router/codex/99 master codex subject 99 workhorse 0 ""; then
  fail 'a protected path was published'
fi
deny_after=$(git -C "$deny" rev-parse HEAD)
if [[ "$deny_before" != "$deny_after" ]]; then
  fail 'a protected path was committed'
fi
if [[ -s "$tmp/push.log" ]]; then
  fail "a protected path was pushed: $(cat "$tmp/push.log")"
fi

pkg=$tmp/pkg-repo
git init -q -b master "$pkg"
printf '%s\n' '{ "name": "demo", "version": "1.0.0", "description": "old" }' > "$pkg/package.json"
git -C "$pkg" add package.json
git -C "$pkg" commit -q -m seed
printf '%s\n' '{ "name": "demo", "version": "1.0.0", "description": "new" }' > "$pkg/package.json"
if ! node "$ROOT/lib/router_io.cjs" publish-check --worktree "$pkg"; then
  fail 'a package.json description change was denied'
fi
printf '%s\n' '{ "name": "demo", "version": "1.0.0", "scripts": { "publish": "npm publish" } }' > "$pkg/package.json"
if node "$ROOT/lib/router_io.cjs" publish-check --worktree "$pkg" >/dev/null; then
  fail 'a package.json publish script change was allowed'
fi
git -C "$pkg" checkout -q -- package.json
printf 'release: true\n' > "$pkg/release.yml"
if node "$ROOT/lib/router_io.cjs" publish-check --worktree "$pkg" >/dev/null; then
  fail 'release.yml was allowed'
fi

ok=$tmp/ok-repo
git init -q -b master "$ok"
printf 'seed\n' > "$ok/README.md"
git -C "$ok" add README.md
git -C "$ok" commit -q -m seed
printf 'change\n' > "$ok/NOTES.txt"
cat > "$tmp/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${ASHLR_TEST_GH_LOG:?}"
cmd=$1
shift || true
case "$cmd" in
  api)
    printf 'tester\n'
    exit 0
    ;;
  repo)
    sub=${1:-}
    if [[ "$sub" == "fork" ]]; then
      exit 0
    fi
    printf 'unexpected repo %s\n' "$sub" >&2
    exit 1
    ;;
  pr)
    sub=${1:-}
    shift || true
    if [[ "$sub" == "create" ]]; then
      printf 'https://example.test/pull/9\n'
      exit 0
    fi
    printf 'unexpected pr %s\n' "$sub" >&2
    exit 1
    ;;
  issue)
    sub=${1:-}
    if [[ "$sub" == "comment" ]]; then
      exit 0
    fi
    printf 'unexpected issue %s\n' "$sub" >&2
    exit 1
    ;;
  *)
    printf 'unexpected gh %s\n' "$cmd" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$tmp/bin/gh"
: > "$tmp/push.log"
if ! router_commit_and_push "$ok" ashlrai/phantom router/codex/100 master codex subject 100 workhorse 0 ""; then
  fail 'an allowed path did not publish to the fork'
fi
if ! grep -q 'https://github.com/tester/phantom.git' "$tmp/push.log"; then
  fail "fork push URL missing: $(cat "$tmp/push.log")"
fi
if grep -q 'origin' "$tmp/push.log"; then
  fail "push targeted origin: $(cat "$tmp/push.log")"
fi

model=$tmp/model-github
git init -q -b master "$model"
printf 'seed\n' > "$model/README.md"
git -C "$model" add README.md
git -C "$model" commit -q -m seed
ROUTER_BASE_SHA=$(git -C "$model" rev-parse HEAD)
mkdir -p "$model/.github/workflows"
printf 'name: bad\n' > "$model/.github/workflows/ci.yml"
git -C "$model" add .github/workflows/ci.yml
git -C "$model" commit -q -m 'model adds workflow'
model_head=$(git -C "$model" rev-parse HEAD)
: > "$tmp/push.log"
rm -f "$ASHLR_ROUTER_HOME/tmp/refused-101.txt"
if router_commit_and_push "$model" ashlrai/phantom router/codex/101 master codex subject 101 workhorse 0 ""; then
  fail 'a model commit of .github was published'
fi
if [[ "$(git -C "$model" rev-parse HEAD)" != "$model_head" ]]; then
  fail 'a model .github commit was rewritten'
fi
if [[ -s "$tmp/push.log" ]]; then
  fail "a model .github commit was pushed: $(cat "$tmp/push.log")"
fi
if ! grep -q 'Denied paths: 1' "$ASHLR_ROUTER_HOME/tmp/refused-101.txt"; then
  fail "refusal count was $(cat "$ASHLR_ROUTER_HOME/tmp/refused-101.txt" 2>/dev/null)"
fi
if grep -q '\.github\|ci\.yml' "$ASHLR_ROUTER_HOME/tmp/refused-101.txt"; then
  fail 'refusal comment named a path'
fi

owners=$tmp/owners-repo
git init -q -b master "$owners"
mkdir -p "$owners/src/kept"
printf 'kept\n' > "$owners/src/kept/old.txt"
printf '%s\n' '/src/kept/** @owner' > "$owners/CODEOWNERS"
git -C "$owners" add CODEOWNERS src/kept/old.txt
git -C "$owners" commit -q -m seed
ROUTER_BASE_SHA=$(git -C "$owners" rev-parse HEAD)
printf '\n' > "$owners/CODEOWNERS"
printf 'x\n' > "$owners/src/kept/x.txt"
git -C "$owners" add CODEOWNERS src/kept/x.txt
git -C "$owners" commit -q -m 'model rewrites owners'
owners_head=$(git -C "$owners" rev-parse HEAD)
: > "$tmp/push.log"
rm -f "$ASHLR_ROUTER_HOME/tmp/refused-102.txt"
if router_commit_and_push "$owners" ashlrai/phantom router/codex/102 master codex subject 102 workhorse 0 ""; then
  fail 'a model CODEOWNERS commit was published'
fi
if [[ "$(git -C "$owners" rev-parse HEAD)" != "$owners_head" ]]; then
  fail 'a model CODEOWNERS commit was rewritten'
fi
if [[ -s "$tmp/push.log" ]]; then
  fail "a model CODEOWNERS commit was pushed: $(cat "$tmp/push.log")"
fi
if ! grep -q 'Denied paths: 2' "$ASHLR_ROUTER_HOME/tmp/refused-102.txt"; then
  fail "CODEOWNERS refusal count was $(cat "$ASHLR_ROUTER_HOME/tmp/refused-102.txt" 2>/dev/null)"
fi
if grep -q 'CODEOWNERS\|src/kept\|x\.txt' "$ASHLR_ROUTER_HOME/tmp/refused-102.txt"; then
  fail 'refusal comment named a CODEOWNERS path'
fi
unset ROUTER_BASE_SHA

cat > "$tmp/bin/claude" <<EOF
#!/usr/bin/env bash
printf '%s\\n' "\$*" >> "$tmp/claude-update.log"
printf '1.0.0\\n'
exit 0
EOF
chmod +x "$tmp/bin/claude"
: > "$tmp/claude-update.log"
saved_fresh=${ROUTER_FRESHNESS_ENABLED:-0}
ROUTER_FRESHNESS_ENABLED=1
router_update_cli claude
ROUTER_FRESHNESS_ENABLED=$saved_fresh
if grep -q 'update' "$tmp/claude-update.log"; then
  fail "claude update ran: $(cat "$tmp/claude-update.log")"
fi
if ! grep -q -- '--version' "$tmp/claude-update.log"; then
  fail "claude version was not recorded: $(cat "$tmp/claude-update.log")"
fi

printf 'ok pools keepalive devin grok omlx\n'
