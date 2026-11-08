#!/usr/bin/env bash
set -u
N="$1"
BASE=$(git merge-base HEAD "pr-$N")
TMPD=$(mktemp -d)
files=$(git diff --name-only "$BASE" "pr-$N")
for f in $files; do
  case "$f" in
    .github/*) echo "SKIP-gh    $f"; continue;;
  esac
  pr_has=0; wt_has=0; base_has=0
  git cat-file -e "pr-$N:$f" 2>/dev/null && pr_has=1
  git cat-file -e "$BASE:$f" 2>/dev/null && base_has=1
  [ -f "$f" ] && wt_has=1
  if [ "$pr_has" = 0 ]; then
    if [ "$wt_has" = 1 ] && [ "$base_has" = 1 ] && git diff --quiet "$BASE" HEAD -- "$f" 2>/dev/null; then
      rm "$f"; echo "DELETE     $f"
    else
      echo "DEL-SKIP   $f"
    fi
    continue
  fi
  if git diff --numstat "$BASE" "pr-$N" -- "$f" 2>/dev/null | grep -q '^-'; then
    wt_sha=""; [ "$wt_has" = 1 ] && wt_sha=$(git hash-object "$f")
    pr_sha=$(git rev-parse "pr-$N:$f")
    if [ "$wt_sha" = "$pr_sha" ]; then echo "SATISFIED  $f";
    else mkdir -p "$(dirname "$f")"; git show "pr-$N:$f" > "$f"; echo "BIN-ADD    $f"; fi
    continue
  fi
  if [ "$wt_has" = 0 ]; then
    mkdir -p "$(dirname "$f")"
    git show "pr-$N:$f" > "$f" && echo "ADD        $f" || echo "ADD-FAIL   $f"
    continue
  fi
  wt_sha=$(git hash-object "$f"); pr_sha=$(git rev-parse "pr-$N:$f")
  [ "$wt_sha" = "$pr_sha" ] && { echo "SATISFIED  $f"; continue; }
  git show "pr-$N:$f" > "$TMPD/t"
  if [ "$base_has" = 1 ]; then git show "$BASE:$f" > "$TMPD/b"; else : > "$TMPD/b"; fi
  if git merge-file -L worktree -L base -L "pr-$N" -p "$f" "$TMPD/b" "$TMPD/t" > "$TMPD/m" 2>/dev/null; then
    cp "$TMPD/m" "$f"; echo "MERGED     $f"
  else
    cp "$TMPD/m" "$f"; echo "CONFLICT   $f"
  fi
done
rm -rf "$TMPD"
