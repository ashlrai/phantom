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

# Plain git worktree remove. Never --force. Failure leaves the directory.
router_remove_worktree() {
  local clone=$1
  local wt=$2
  if git -C "$clone" worktree remove "$wt"; then
    printf 'removed worktree %s\n' "$wt"
    return 0
  fi
  printf 'worktree remove failed; left in place: %s\n' "$wt"
  return 0
}
