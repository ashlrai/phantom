#!/bin/bash
# batch-launch.sh <bundle-job> <repo> <pool> [tier] ; bundle prompt on stdin  (RQ-BATCH-SESSIONS-2)
# Wrapper that dispatchd runs instead of launch.sh for RQ-BATCH-* bundles. It gives every member line its own
# worktree, branch and .base record (the same shape launch.sh writes for a solo job), so each line later reaps and
# publishes as its own PR through the unchanged reap-one.sh / publish.sh path. Then it execs the unchanged launch.sh
# for the bundle session itself. Bash 3.2 compatible. No network beyond the `git fetch` launch.sh also runs, no
# credentials, never removes or resets an existing worktree or branch: a member that cannot get a fresh worktree is
# marked <member>.prep-failed and the session reports it deferred, so it is requeued alone.
# Git objects are shared: every member is a linked worktree of ~/Projects/ashlrai/<repo>. node_modules is an APFS
# clone (cp -c), the same copy-on-write install cache launch.sh uses, so ten members cost no extra install.
set -u
# stdin carries the bundle prompt through to launch.sh; every command before the exec reads /dev/null instead.
J=${1:-}; REPO=${2:-}; POOL=${3:-}; TIER=${4:-work}
R=$HOME/.ashlr-runs; Q=$R/queue; RUN=$Q/run
RP=$HOME/Projects/ashlrai/$REPO; WTROOT=$HOME/Projects/ashlrai/wt
JRX='^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
[[ $J =~ ^RQ-BATCH-[A-Za-z0-9._-]+$ && $REPO =~ $JRX && $POOL =~ $JRX && $TIER =~ ^[a-z]+$ ]] || { echo "REFUSED: batch-launch.sh bad arguments"; exit 5; }
M=$Q/batches/$J.json
[ -f "$M" ] && [ ! -L "$M" ] || { echo "REFUSED: no manifest for $J"; exit 5; }
members=$(/usr/bin/python3 -I -c '
import json, re, sys
m = json.load(open(sys.argv[1]))
ok = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
if m.get("id") != sys.argv[2] or m.get("repo") != sys.argv[3]: sys.exit(2)
for x in m.get("members", []):
    j = x.get("job", "") if isinstance(x, dict) else ""
    if ok.match(j): print(j)
' "$M" "$J" "$REPO" </dev/null) || { echo "REFUSED: manifest for $J does not match"; exit 5; }

# One repo lock for all members, the same mkdir lock launch.sh takes, so a solo launch never races a member add.
L=$R/.lock-$REPO; n=0
until mkdir "$L" 2>/dev/null; do sleep 1; n=$((n+1)); [ $n -gt 300 ] && { echo "HELD: repo lock $L busy"; exit 3; }; done
trap 'rmdir "$L" 2>/dev/null' EXIT
git -C "$RP" fetch -q origin </dev/null || { echo "HELD: fetch failed for $REPO"; exit 3; }
DEF=$(git -C "$RP" symbolic-ref -q --short refs/remotes/origin/HEAD | sed 's#origin/##'); DEF=${DEF:-main}
BASE=$(git -C "$RP" rev-parse "origin/$DEF") && [ -n "$BASE" ] || { echo "HELD: no origin/$DEF in $REPO"; exit 3; }
ready=0; failed=0
for m in $members; do
  WT=$WTROOT/$m; why=
  if [ "$(cat "$RUN/$m.batched" 2>/dev/null)" != "$J" ]; then why="lease not held by $J"
  elif [ -e "$WT" ] || [ -L "$WT" ]; then why="worktree path exists"
  elif git -C "$RP" show-ref --verify -q "refs/heads/codex-bridge/$m"; then why="branch codex-bridge/$m exists (solo launch handles reuse)"
  elif ! git -C "$RP" worktree add -q -b "codex-bridge/$m" "$WT" "$BASE" </dev/null 2>/dev/null; then why="worktree add failed"
  fi
  if [ -n "$why" ]; then
    printf '%s\n' "$why" > "$RUN/$m.prep-failed"; failed=$((failed+1)); echo "MEMBER_DEFERRED $m ($why)"; continue
  fi
  rm -f "$RUN/$m.prep-failed"; printf '%s\n' "$J" > "$RUN/$m.bundle-wt"   # dispatchd retires only worktrees it can prove we made
  [ -d "$RP/node_modules" ] && [ ! -e "$WT/node_modules" ] && cp -cR "$RP/node_modules" "$WT/node_modules" 2>/dev/null
  echo "$BASE codex-bridge/$m $WT $POOL" > "$R/$m.base"
  ready=$((ready+1))
done
rmdir "$L" 2>/dev/null; trap - EXIT
echo "BUNDLE_PREPARED $J members=$((ready+failed)) ready=$ready deferred=$failed base ${BASE:0:9}"
[ "$ready" -gt 0 ] || { echo "HELD: no member of $J got a worktree"; exit 3; }
exec /bin/bash "$R/bin/launch.sh" "$J" "$REPO" "$POOL" "$TIER"
