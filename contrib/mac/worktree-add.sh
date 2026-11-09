#!/bin/bash
# Bash 3.2 compatible. Never prune, delete, or force past a registered worktree.
set -euo pipefail
export LC_ALL=C

fail() { printf 'worktree-add: %s\n' "$1" >&2; exit 1; }
[[ $# == 4 ]] || fail 'usage: worktree-add.sh <repo-dir> <job> <worktree-path> <start-ref>'
repo=$1 job=$2 destination=$3 start=$4
[[ $job =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail 'job must be a single branch-name component'
branch="codex-bridge/$job"
git check-ref-format "refs/heads/$branch" >/dev/null 2>&1 || fail 'invalid job branch'
[[ $start != -* ]] || fail 'start-ref cannot begin with -'
umask 077
scratch=$(mktemp -d "${TMPDIR:-/tmp}/bridge-worktree.XXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if git -C "$repo" worktree add -b "$branch" -- "$destination" "$start" >"$scratch/output" 2>"$scratch/error"; then
  exit 0
fi
# Do not interpret unrelated add failures as permission to reset a branch.
grep -Fq "a branch named '$branch' already exists" "$scratch/error" || fail 'worktree add failed for a reason other than an existing job branch; branch not reset'
git -C "$repo" show-ref --verify --quiet "refs/heads/$branch" || fail 'existing job branch could not be verified'
git -C "$repo" worktree list --porcelain -z >"$scratch/worktrees" 2>"$scratch/error" || fail 'cannot inspect worktrees; branch not reset'
[[ -s $scratch/worktrees ]] || fail 'empty worktree inventory; branch not reset'
# NUL records prevent paths containing newlines from impersonating branch fields.
# A missing or locked registered worktree is still owned, and requires operator review.
while IFS= read -r -d '' field; do
  if [[ $field == "branch refs/heads/$branch" ]]; then
    fail "branch $branch is attached to a registered worktree; refusing reuse (including locked or missing worktrees)"
  fi
done <"$scratch/worktrees"
# Older Git can reset -B before discovering that the destination is occupied.
# Refuse even an empty existing directory on the recovery path, preserving its tip.
target=$destination
[[ $target == /* ]] || target="$repo/$target"
while [[ $target != / && $target == */ ]]; do target=${target%/}; done
[[ ! -e $target && ! -L $target ]] || fail 'reuse destination already exists; branch not reset'
# Reserve an empty destination before -B so bad parents and permissions cannot
# cause a branch reset followed by a predictable directory-creation failure.
mkdir -- "$target" 2>"$scratch/error" || fail 'cannot reserve reuse destination; parent must exist and be writable; branch not reset'
# Git performs its own in-use check again, closing a race with another launcher.
if ! git -C "$repo" worktree add -B "$branch" -- "$destination" "$start" >"$scratch/output" 2>"$scratch/error"; then
  # Only remove the empty directory we reserved, never a partial checkout.
  rmdir -- "$target" 2>/dev/null || true
  fail 'safe branch reuse failed; inspect the branch tip and any partial worktree before retrying'
fi
