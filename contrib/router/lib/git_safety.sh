#!/usr/bin/env bash
# The runner commits. It does not keep obvious secret files in that commit.

router_secret_basename() {
  case "$1" in
    .env|.env.local|.env.production|.env.development) return 0 ;;
    *.pem|*.p12|id_rsa|id_dsa|id_ecdsa|id_ed25519) return 0 ;;
    *) return 1 ;;
  esac
}

router_unstage_secrets() {
  local wt=$1
  local file base
  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    base=${file##*/}
    if router_secret_basename "$base"; then
      git -C "$wt" reset -q HEAD -- "$file" 2>/dev/null || true
      git -C "$wt" rm --cached -q -- "$file" 2>/dev/null || true
      printf 'unstaged possible secret %s\n' "$file"
    fi
  done < <(git -C "$wt" diff --cached --name-only)
}

router_worktree_dirty() {
  local wt=$1
  local porcelain
  [[ -d "$wt" ]] || return 1
  porcelain=$(git -C "$wt" status --porcelain)
  [[ -n "$porcelain" ]]
}

# Uncommitted tracked and untracked changes, written beside the ledger.
router_write_patch() {
  local wt=$1
  local dest=$2
  local file
  : > "$dest"
  git -C "$wt" diff >> "$dest" || true
  git -C "$wt" diff --cached >> "$dest" || true
  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    git -C "$wt" diff --no-index -- /dev/null "$file" >> "$dest" || true
  done < <(git -C "$wt" ls-files --others --exclude-standard)
}

router_git_observed() {
  local operation=$1 captured stderr status=0 locked=false TIMEFORMAT=$'\n%R'
  shift
  { captured=$({ time git "$@" 2>&1 1>&3 3>&-; } 2>&1); } 3>&1 || status=$?
  stderr=${captured%$'\n'*}
  printf '%s' "$stderr" >&2 || true
  if [[ $status -ne 0 && $stderr == *index.lock* ]]; then locked=true; fi
  node -e '
    const [operation, seconds, locked] = process.argv.slice(1);
    const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
    const dir = path.join(os.homedir(), ".ashlr-runs", "metrics");
    const base = { event: "git_operation", machine: os.hostname(), lane: "router", ts: new Date().toISOString() };
    const rows = [{ ...base, operation, elapsed_ms: Math.round(Number(seconds.replace(",", ".")) * 1000),
      ...(operation === "fetch" || operation === "push" ? { retries: 0 } : {}) }];
    if (locked === "true") rows.push({ ...base, operation: "index.lock", failed: true });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(dir, "jobs.jsonl"), rows.map(row => JSON.stringify(row) + "\n").join(""), { mode: 0o600 });
  ' "$operation" "${captured##*$'\n'}" "$locked" >/dev/null 2>&1 || true
  return "$status"
}

# Plain git worktree remove. Never --force. Failure leaves the directory.
router_remove_worktree() {
  local clone=$1
  local wt=$2
  if router_git_observed worktree_remove -C "$clone" worktree remove "$wt"; then
    printf 'removed worktree %s\n' "$wt"
    return 0
  fi
  printf 'worktree remove failed; left in place: %s\n' "$wt"
  return 0
}
