#!/usr/bin/env bash
# Port a PR's residual changes into the worktree via per-file 3-way merges.
# ours = current worktree file, ancestor = PR merge-base vs HEAD, theirs = pr-N
# Skips .github/ (hard rule). Never commits.
set -u
N="$1"
BASE=$(git merge-base HEAD "pr-$N")
TMPD=$(mktemp -d)
files=$(git diff --name-only "$BASE" "pr-$N")
# residual = files where pr head still differs from current HEAD/tree state.
res=$(git diff --name-only HEAD "pr-$N" -- $files)
echo "PR $N base ${BASE:0:8}; residual files:"
echo "$res" | sed 's/^/  /'
echo "---"
for f in $res; do
  case "$f" in
    .github/*) echo "SKIP-gh    $f"; continue;;
  esac
  inbase=0; inpr=0
  git cat-file -e "$BASE:$f" 2>/dev/null && inbase=1
  git cat-file -e "pr-$N:$f" 2>/dev/null && inpr=1
  if [ "$inbase" = 0 ] && [ "$inpr" = 1 ]; then
    if [ ! -f "$f" ]; then
      mkdir -p "$(dirname "$f")"
      git show "pr-$N:$f" > "$f" && echo "ADD        $f" || echo "ADD-FAIL   $f"
    else
      git show "pr-$N:$f" > "$TMPD/t"; : > "$TMPD/b"
      if git merge-file -L worktree -L base -L "pr-$N" -p "$f" "$TMPD/b" "$TMPD/t" > "$TMPD/m" 2>/dev/null; then
        cp "$TMPD/m" "$f"; echo "ADD-MERGE  $f"
      else
        cp "$TMPD/m" "$f"; echo "CONFLICT   $f"
      fi
    fi
  elif [ "$inbase" = 1 ] && [ "$inpr" = 0 ]; then
    if [ -f "$f" ] && git diff --quiet "$BASE" HEAD -- "$f" && ! git status --porcelain -- "$f" | grep -q .; then
      rm "$f"; echo "DELETE     $f"
    else
      echo "DELETE-SKIP $f (changed since base — review)"
    fi
  else
    git show "$BASE:$f" > "$TMPD/b"; git show "pr-$N:$f" > "$TMPD/t"
    if git merge-file -L worktree -L base -L "pr-$N" -p "$f" "$TMPD/b" "$TMPD/t" > "$TMPD/m" 2>/dev/null; then
      cp "$TMPD/m" "$f"; echo "MERGED     $f"
    else
      cp "$TMPD/m" "$f"; echo "CONFLICT   $f"
    fi
  fi
done
rm -rf "$TMPD"
