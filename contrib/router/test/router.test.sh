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
  printf '\nHOME=%s\n' "${CODEX_HOME:-}"
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
      printf 'from durable\n' > "$wt/FROM_DURABLE.txt"
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

if grep -n 'auth.json' "$ROOT/ashlr-router" "$ROOT"/lib/*.sh "$ROOT/lib/router_io.cjs" >/dev/null; then
  fail 'runner names auth.json'
fi
if grep -n 'codex logout' "$ROOT/ashlr-router" "$ROOT"/lib/*.sh "$ROOT/lib/router_io.cjs" >/dev/null; then
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

router_run_job "ashlrai/phantom" 7 codex workhorse "" "fixture" "$body" "" fragile

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

node -e '
  const fs = require("fs");
  const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const jobs = lines.filter((row) => row.event === "job");
  const fragile = jobs.find((row) => row.account === "fragile");
  const durable = jobs.find((row) => row.account === "durable");
  if (!fragile || fragile.exit === 0) process.exit(2);
  if (!String(fragile.warning || "").includes("marked dead")) process.exit(3);
  if (!durable || durable.exit !== 0) process.exit(4);
  const pools = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).pools || [];
  const fragilePool = pools.find((row) => row.poolId === "codex-fragile");
  const durablePool = pools.find((row) => row.poolId === "codex-durable");
  if (!fragilePool || fragilePool.dead !== true || fragilePool.durability !== "fragile") process.exit(5);
  if (!durablePool || durablePool.dead === true || durablePool.primary !== true) process.exit(6);
  if (durablePool.durability !== "durable") process.exit(7);
' "$ASHLR_ROUTER_HOME/ledger.jsonl" "$ASHLR_ROUTER_HOME/state.json"

picked=$(router_pick_codex_account dry | tail -n 1)
case "$picked" in
  durable$'\t'*) ;;
  *) fail "dead fragile pool was retried: $picked" ;;
esac

printf 'ok codex auth failover\n'
