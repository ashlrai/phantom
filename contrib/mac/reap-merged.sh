#!/bin/bash
# reap-merged.sh [--empty] [--apply] : RQ-REAPER-10 rev2 + RQ-REAPER-12-EMPTY.
# Default mode: reap kept worktrees whose RESULT PR is MERGED or CLOSED; --apply acts only when $R/REAP_APPLY exists.
# --empty mode (12 + 12.1 inferred DONE-EMPTY when no strict status: finished log, no ignored files but build artifacts):
#   reap kept worktrees of DONE-EMPTY / DONE-NOOP jobs that are clean at their recorded base (no diff,
#   no untracked files, 0 commits ahead), >6h old, not live, not queued for publish, not held. --apply acts only
#   when $R/REAP_EMPTY_APPLY exists. Unpublished work (any diff or commit) is never reaped. It runs only read-only
#   git (diff, status, rev-list, rev-parse) with a fixed git binary, fsmonitor off and hooks disabled.
# Dry run by default.
# Removal goes ONLY through $R/bin/reap-one.sh <job> (its sanctioned remove path), invoked with
# REAP_NO_PUBLISH=1 (reap-one patch 10b). This script runs no git commands at all, never deletes
# branches and never deletes a .base (it renames it to .base.reaped after a successful reap).
set -u
umask 077
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
R="$HOME/.ashlr-runs"; Q="$R/queue"; RUN="$Q/run"; MET="$R/metrics"; LOG="$MET/reap.jsonl"
EVL="$MET/reap-events.log"
GH=/opt/homebrew/bin/gh; [ -x "$GH" ] || GH=/usr/local/bin/gh
LSOF=/usr/sbin/lsof; REAPONE="$R/bin/reap-one.sh"
GIT=/opt/homebrew/bin/git; [ -x "$GIT" ] || GIT=/usr/bin/git
REAPONE_SHA=e45b88f98144e87693b27ca8b0b4d72a071e886e407cfda9541a810384087c0c   # classifier-only removal mode
GITSAFE="$R/bin/git-safe-env.sh"; GITSAFE_SHA=01e1e5ab72016a5b6fbd96c76cb903eb7c61849084b20ae04374219dcd077331   # RQ-GIT-SAFE rev4.1 (B1 B2 A-1 A-2; was rev4 50f38b25)
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_EXTERNAL_DIFF GIT_OBJECT_DIRECTORY   # rev4.1: GIT_CONFIG_* are unset on the line after next (no env_injection refusal any more)
export GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1
unset GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS GIT_CONFIG GIT_CONFIG_SYSTEM; for __v in $(compgen -e | grep -E "^GIT_CONFIG_(KEY|VALUE)_"); do unset "$__v"; done; export GIT_CONFIG_GLOBAL=/dev/null   # rev4.1 (Security): direct $GIT calls inherit none
RULES="$R/ENGINEER-RULES.md"          # pinned, env-free; Masbot syncs it from the EO copy
WT_ROOT="$HOME/Projects/ashlrai/wt"   # launch.sh: WT=~/Projects/ashlrai/wt/$J
REPOS="phantom phantom-secrets ashlr-plugin locus lexicon ashlr-md ashlr-stack"
# Test-only overrides: honored only when the marker $R/REAP_TEST exists (must never exist on the Mac).
if [ -e "$R/REAP_TEST" ]; then GH=${REAP_GH:-$GH}; LSOF=${REAP_LSOF:-$LSOF}; GIT=${REAP_GIT:-$GIT}; REAPONE_SHA=${REAP_ONE_SHA:-$REAPONE_SHA}; GITSAFE=${REAP_GITSAFE:-$GITSAFE}; fi
MAX_GH=${REAP_MAX_GH:-40}; case "$MAX_GH" in ""|*[!0-9]*) MAX_GH=40;; esac; [ "$MAX_GH" -gt 200 ] && MAX_GH=200
GH_SLEEP=${REAP_GH_SLEEP:-1}; case "$GH_SLEEP" in ""|*[!0-9]*) GH_SLEEP=1;; esac
WALL_CAP=1800; WALL=${REAP_WALL_S:-600}; case "$WALL" in ""|*[!0-9]*) WALL=600;; esac; [ "$WALL" -gt $WALL_CAP ] && WALL=$WALL_CAP
LIVE_S=900; CLAUDE_PUSH_S=1800; EMPTY_AGE_S=21600
# rev1.3 REAP_IDLE_H: merged mode (MERGED/CLOSED PRs only) idle threshold, default 2h (was 15 min before rev1.3);
# a whole number 2..8760 overrides it. Non-numeric or below 2 => 2, logged. --empty mode (no-PR jobs) never reads it.
IDLE_H=2; IDLE_BAD=""
if [ -n "${REAP_IDLE_H+x}" ]; then
  if [[ "$REAP_IDLE_H" =~ ^[0-9]+$ ]] && [ "$REAP_IDLE_H" -ge 2 ] && [ "$REAP_IDLE_H" -le 8760 ]; then IDLE_H=$REAP_IDLE_H; else IDLE_BAD=1; fi
fi
IDLE_S=$((IDLE_H * 3600))
DU_MAX=${REAP_DU_MAX:-300}; case "$DU_MAX" in ""|*[!0-9]*) DU_MAX=300;; esac; [ "$DU_MAX" -gt 400 ] && DU_MAX=400

APPLY=0; MODE=merged
for a in "$@"; do case "$a" in --apply) APPLY=1;; --dry-run) APPLY=0;; --empty) MODE=empty;; *) echo "usage: reap-merged.sh [--empty] [--apply|--dry-run]" >&2; exit 2;; esac; done
AFLAG="$R/REAP_APPLY"; [ "$MODE" = empty ] && AFLAG="$R/REAP_EMPTY_APPLY"
if [ "$APPLY" = 1 ] && [ ! -e "$AFLAG" ]; then echo "NOTE --apply ignored: $AFLAG missing, running dry"; APPLY=0; fi

mkdir -p "$RUN" "$MET" || exit 1
mtime(){ stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }
ev(){ echo "$(date '+%F %T') $*" >> "$EVL"; }
rp(){ ( cd -P -- "$1" 2>/dev/null && pwd -P ); }
sha256(){ if [ -x /usr/bin/shasum ]; then /usr/bin/shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'; else sha256sum "$1" 2>/dev/null | awk '{print $1}'; fi; }
PLAN="$R/bin/reaper-plan.py"
[ -f "$PLAN" ] && [ ! -L "$PLAN" ] && [ "$(sha256 "$PLAN")" = "95c1c9111db21cf4ca13ba2e8eb6dd2a04a651017ca127505a0cdc91e1a687b0" ] ||
  { echo "REFUSE: reaper-plan.py missing or sha mismatch"; exit 3; }
REAPABLE=$(/usr/bin/python3 -I -B "$PLAN" plan "$HOME") || { echo "REFUSE: disk-maint plan unavailable"; exit 3; }
candidate(){ case $'\n'"$REAPABLE"$'\n' in *$'\n'"$1"$'\n'*) return 0;; *) return 1;; esac; }
recheck(){ [ "$(/usr/bin/python3 -I -B "$PLAN" plan "$HOME" "$1")" = "$1" ]; }
retire_base(){
  [ ! -L "$1" ] && [ "$(sha256 "$1")" = "$2" ] &&
    [ ! -e "$1.reaped" ] && [ ! -L "$1.reaped" ] && mv -n "$1" "$1.reaped"
}

# ---- lock: mkdir; reclaim only by atomic rename, then re-check (R5)
LK="$RUN/reap-merged.lock"
if ! mkdir "$LK" 2>/dev/null; then
  op=$(cat "$LK/pid" 2>/dev/null); case "$op" in *[!0-9]*) op="";; esac
  if [ -n "$op" ] && kill -0 "$op" 2>/dev/null; then echo "LOCKED another reap-merged (pid $op) is running; exiting"; exit 0; fi
  if [ -z "$op" ] && [ $(( $(date +%s) - $(mtime "$LK") )) -le $((WALL_CAP + 60)) ]; then echo "LOCKED (no pid, younger than budget cap); exiting"; exit 0; fi
  ST="$LK.stale.$$"
  mv "$LK" "$ST" 2>/dev/null || { echo "LOCKED reclaim lost the race; exiting"; exit 0; }
  op2=$(cat "$ST/pid" 2>/dev/null); case "$op2" in *[!0-9]*) op2="";; esac
  if [ "$op2" != "$op" ] || { [ -n "$op2" ] && kill -0 "$op2" 2>/dev/null; }; then
    mv "$ST" "$LK" 2>/dev/null; echo "LOCKED lock changed during reclaim; exiting"; exit 0
  fi
  rm -rf "$ST"
  echo "WARNING LOCK_RECLAIMED stale reap-merged lock (pid=${op:-none})" >&2; ev "LOCK_RECLAIMED pid=${op:-none}"
  mkdir "$LK" 2>/dev/null || { echo "LOCKED race after reclaim; exiting"; exit 0; }
fi
echo $$ > "$LK/pid"; trap 'rm -rf "$LK"' EXIT

T0=$(date +%s); NOW=$T0
[ -n "$IDLE_BAD" ] && { echo "WARNING REAP_IDLE_H rejected, using 2" >&2; ev "REAP_IDLE_H_REJECTED using=2"; }
SKF=$(mktemp); wm=0; wc=0; cand=0; reaped=0; est_kb=0; freed_kb=0; ghn=0   # bash 3.2: no assoc arrays
skip(){ echo "$1" >> "$SKF"; [ -n "${2:-}" ] && echo "SKIP $1 $2"; }
jstr(){ printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
inlist(){ case " $2 " in *" $1 "*) return 0;; esac; return 1; }

# ---- K1: hold list from ENGINEER-RULES.md line 7, fail closed
HOLD=""; HOLD_ERR=""
if [ -L "$RULES" ] || [ ! -f "$RULES" ] || [ ! -r "$RULES" ]; then HOLD_ERR="unreadable $RULES"
elif [ -L "$RULES.sha256" ] || [ ! -f "$RULES.sha256" ]; then HOLD_ERR="missing $RULES.sha256"   # H1: pinned copy only
elif want=$(awk 'NR==1{print $1}' "$RULES.sha256" 2>/dev/null); ! printf '%s' "$want" | grep -qE '^[0-9a-f]{64}$'; then HOLD_ERR="bad $RULES.sha256"
elif [ "$(sha256 "$RULES")" != "$want" ]; then HOLD_ERR="sha256 mismatch for $RULES"
else
  # HARD LIMIT item 7 (file line 11 today); exactly one such line or fail closed
  nh=$(grep -c '^7\. Hold list' "$RULES"); L7=$(grep '^7\. Hold list' "$RULES" | head -1)
  HNONE=0; [ "$nh" = 0 ] && HNONE=1   # HOLDS-AUDIT-1 (Mason 02:26 Nov 9, ENGINEER-RULES v3.6): missing or 'none' hold list = empty list, not an error
  [ "$HNONE" = 1 ] || [ "$nh" = 1 ] || HOLD_ERR="expected one '7. Hold list' line, found $nh"
  case "$L7" in "7. Hold list"*:*) ;; *) [ -z "$HOLD_ERR" ] && [ "$HNONE" = 0 ] && HOLD_ERR="hold list line has no ':'";; esac
  if [ -z "$HOLD_ERR" ]; then
    body=${L7#*:}; body=${body%.}
    case "$(printf '%s' "$body" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//')" in none|none[.,:\;\ ]*) HNONE=1;; esac
    [ "$HNONE" = 1 ] && body=""
    OLDIFS=$IFS; IFS=';'
    for seg in $body; do
      IFS=$OLDIFS; set -- $seg; repo=${1:-}; [ $# -ge 2 ] || { HOLD_ERR="bad segment '$seg'"; break; }
      inlist "$repo" "$REPOS" || { HOLD_ERR="unknown repo '$repo'"; break; }
      shift; for n in "$@"; do
        case "$n" in "#"[0-9]*) n=${n#\#}; n=${n%.}; case "$n" in *[!0-9]*) HOLD_ERR="bad pr '$n'"; break 2;; esac;; *) HOLD_ERR="bad token '$n'"; break 2;; esac
        HOLD="$HOLD ashlrai/$repo#$n"
      done
      IFS=';'
    done
    IFS=$OLDIFS
    [ -z "$HOLD_ERR" ] && [ -z "$HOLD" ] && [ "$HNONE" = 0 ] && HOLD_ERR="empty hold list"
  fi
fi
[ -n "$HOLD_ERR" ] && echo "HOLD_LIST_INVALID $HOLD_ERR: skipping ALL candidates"
# T2: reap-one must be exactly patch 10b (honors REAP_NO_PUBLISH), verified by sha256; otherwise fail closed under --apply
[ ! -L "$REAPONE" ] && [ "$(sha256 "$REAPONE")" = "$REAPONE_SHA" ] && R1OK=1 || R1OK=0

# ---- K2: containment
RROOT=$(rp "$WT_ROOT"); RR=$(rp "$R")
DENY=""; for d in "$R" "$HOME/.codex" "$HOME/.codex-2" "$R/g1-pass" "$R/quarantine" "$HOME/Library/Keychains" "$HOME/.phantom"; do x=$(rp "$d"); [ -n "$x" ] && DENY="$DENY $x"; done
contained(){ # $1 = WT from .base, $2 = job. Prints reason on failure.
  local w=$1 r n d
  case "$w" in /*) ;; *) echo relative; return 1;; esac
  case "/$w/" in */../*|*/./*) echo dotdot; return 1;; esac
  [ -L "$w" ] && { echo symlink; return 1; }
  [ -n "$RROOT" ] || { echo no_wt_root; return 1; }
  r=$(rp "$w"); [ -n "$r" ] || { echo unresolvable; return 1; }
  [ "$r" = "${w%/}" ] || { echo symlinked_path; return 1; }   # T1: no symlink in any component
  case "$r" in "$RROOT"/*) ;; *) echo outside_wt_root; return 1;; esac
  n=${r#"$RROOT"/}; case "$n" in ""|*/*) echo not_direct_child; return 1;; esac
  case "$n" in *[!A-Za-z0-9._-]*|.*) echo bad_name; return 1;; esac
  for d in $DENY; do case "$r/" in "$d"/*) echo denied_path; return 1;; esac; done
  case "/$r/" in */.ashlr-runs/*|*/.codex/*|*/.codex-2/*|*/g1-pass/*|*/quarantine/*|*[Vv]ault*|*/Keychains/*) echo denied_name; return 1;; esac
  return 0
}
result_ok(){ # $1 job -> sets URL REPO PR from the last RESULT line; fails if it is not a valid RESULT PR
  RES=$(grep '^RESULT' "$R/$1.publish" 2>/dev/null | tail -1)
  printf '%s\n' "$RES" | grep -qE '^RESULT PR https://github\.com/ashlrai/[A-Za-z0-9._-]+/pull/[0-9]{1,7}( |$)' || return 1
  URL=$(printf '%s' "$RES" | grep -oE 'https://github\.com/ashlrai/[A-Za-z0-9._-]+/pull/[0-9]+' | head -1)
  REPO=$(printf '%s' "$URL" | sed -E 's#https://github\.com/(ashlrai/[^/]+)/pull/.*#\1#'); PR=${URL##*/}
  inlist "${REPO#ashlrai/}" "$REPOS" || return 2
  return 0
}

OPEN=$(mktemp); LSOF_OK=1
"$LSOF" -nP -w -Fn > "$OPEN" 2>/dev/null || { [ -s "$OPEN" ] || LSOF_OK=0; }
# ======== RQ-REAPER-12-EMPTY: --empty mode (exits at the end; merged mode below is untouched) ========
if [ "$MODE" = empty ]; then
  CATF=$(mktemp); dun=0
  PSKIP="$Q/precheck-skips.tsv"; LANDONLY=""; [ -f "$R/PUBLISH_LANDONLY" ] && LANDONLY=" $(tr -s ' \t\n' '   ' < "$R/PUBLISH_LANDONLY") "
  KEEP=""; [ -f "$Q/keep.txt" ] && KEEP=" $(tr -s ' \t\n' '   ' < "$Q/keep.txt") "
  # G1: every git call on a worktree goes through the pinned RQ-GIT-SAFE helper, after gs_check passed for it
  GSOK=0
  if [ -f "$GITSAFE" ] && [ ! -L "$GITSAFE" ] && [ "$(sha256 "$GITSAFE")" = "$GITSAFE_SHA" ]; then
    . "$GITSAFE" && gs_init "$GIT" && GSOK=1
  fi
  [ "$GSOK" = 1 ] || echo "GIT_SAFE_UNAVAILABLE $GITSAFE missing or sha mismatch: skipping ALL candidates"
  g(){ gs_git "$WT" "$@"; }
  sizek(){ # sets KB: du -sk, budgeted to DU_MAX calls per run and the wall budget; unmeasured => -1
    KB=-1; if [ "$dun" -ge "$DU_MAX" ] || [ $(( $(date +%s) - T0 )) -ge "$WALL" ]; then return; fi
    dun=$((dun+1)); KB=$(du -sk "$1" 2>/dev/null | awk '{print $1+0}'); KB=${KB:--1}; }
  cat_(){ # $1 category, $2 job, $3 kb
    echo "$1 $3" >> "$CATF"; echo "CAT $1 $2 ${3}K"; }
  # DONE status (strict). Prints done_empty | done_noop:<code> ; fails if unknown.
  done_status(){
    local res; res=$(grep '^RESULT' "$R/$1.publish" 2>/dev/null | tail -1)
    if [ -n "$res" ]; then case "$res" in "RESULT EMPTY"|"RESULT EMPTY "*) echo done_empty; return 0;; *) return 1;; esac; fi
    [ -f "$PSKIP" ] || return 1
    # dispatchd: "<TS>\t<job>\t<code>\t<reason>" appended on precheck exit 10..13 (DONE-NOOP)
    awk -F '\t' -v j="$1" 'NF==4 && $2==j && $3 ~ /^1[0-3]$/ {c=$3} END{if (c=="") exit 1; print "done_noop:" c}' "$PSKIP"
  }
  held_job(){ # $1 job; repo from the dispatched queue line, else the worktree's main repo dir name; unknown => held
    local repo="" n e t
    [ -f "$RUN/$1.line" ] && repo=$(awk -F '\t' 'NR==1{print $2}' "$RUN/$1.line")
    if [ -z "$repo" ]; then repo=$(g rev-parse --path-format=absolute --git-common-dir 2>/dev/null); repo=${repo%/.git}; repo=${repo##*/}; fi
    inlist "$repo" "$REPOS" || return 0
    t=$(printf '%s %s' "$1" "$(cat "$RUN/$1.line" 2>/dev/null)" | tr -c '0-9' ' ')
    for e in $HOLD; do case "$e" in "ashlrai/$repo#"*) n=${e#*#}; inlist "$n" "$t" && return 0;; esac; done
    return 1
  }
  live_job(){ # $1 job, $2 WT. Prints reason.
    if [ -e "$RUN/$1.reaping" ] || [ -e "$RUN/$1.lock" ] || [ -e "$R/$1.lock" ] || [ -e "$RUN/$1.dispatched" ]; then echo live_lock; return 0; fi
    [ $((NOW - $(mtime "$R/$1.log"))) -lt $LIVE_S ] || [ $((NOW - $(mtime "$R/$1.base"))) -lt $LIVE_S ] && { echo live_recent; return 0; }
    [ "$LSOF_OK" = 1 ] || { echo lsof_failed; return 0; }
    local rw; rw=$(rp "$2")
    if grep -qF -e "n$2/" -e "n$rw/" "$OPEN" || grep -qxF -e "n$2" -e "n$rw" "$OPEN"; then echo live_process; return 0; fi
    # rev1.2 args-free: the lsof scan above covers cwd fds; a pid file is checked with kill -0, stale or unreadable => live_unknown
    local f p; for f in "$RUN/$1.pid" "$R/$1.pid"; do [ -e "$f" ] || [ -L "$f" ] || continue
      p=$(head -c 32 "$f" 2>/dev/null | tr -d ' \n'); case "$p" in ""|*[!0-9]*) echo live_unknown; return 0;; esac
      kill -0 "$p" 2>/dev/null && { echo live_process; return 0; }; echo live_unknown; return 0; done
    return 1
  }
  # ---- 12.1 inferred DONE-EMPTY helpers
  REAPONE_EMPTY_LINE="RESULT EMPTY (dispatchd: no changes, publish skipped)"   # reap-one.sh 10b, verbatim
  LOG_TAIL=8192
  # Build-artifact top-level dirs (regenerated by install/build; never hand-written work). See NOTES.
  BUILD_ALLOW="node_modules dist build target .next .turbo coverage __pycache__ .pytest_cache .vite out .cache"
  fsize(){ stat -c %s "$1" 2>/dev/null || stat -f %z "$1" 2>/dev/null || echo -1; }
  log_finished(){ # $1 job. Prints "<size> <mtime>" if finished, else a reason; fails if not finished.
    local lf="$R/$1.log" s1 s2 m1 tl
    [ -f "$lf" ] && [ ! -L "$lf" ] || { echo log_missing; return 1; }
    s1=$(fsize "$lf"); m1=$(mtime "$lf")
    [ "$s1" -gt 0 ] 2>/dev/null || { echo log_empty; return 1; }
    [ $((NOW - m1)) -ge $LIVE_S ] || { echo log_recent; return 1; }
    [ "$(tail -c 1 "$lf" | od -An -c | tr -d ' ')" = '\n' ] || { echo log_truncated; return 1; }
    tl=$(tail -c $LOG_TAIL "$lf" | tr -d '\r')
    # end markers, line start only, in the last LOG_TAIL bytes (see NOTES for where each is written):
    #  codex exec: "tokens used" then a digits line (what dispatchd tokens() parses)
    #  claude-api lane: "API_SPEND <job> pool=" appended by claude-api.py record after the agent exits
    #  any lane: a dispatchd ERRLINE that is a terminal usage_limit / credits_exhausted error
    if printf '%s\n' "$tl" | awk 'p && /^[ \t]*[0-9][0-9,]*[ \t]*$/ {f=1} {p = ($0 ~ /^tokens used[ \t]*$/)} END{exit !f}'; then :
    elif printf '%s\n' "$tl" | grep -qE "^API_SPEND $1 pool=(gift|monthly) "; then :
    elif printf '%s\n' "$tl" | grep -E '^[[:space:]]*(ERROR|Error|API Error|stream error)[: ]' | grep -qiE "usage limit|you've hit your|weekly limit|credits? (are |have been )?(exhausted|depleted)|out of credits|insufficient credits|no credits remaining"; then :
    else echo log_no_end_marker; return 1; fi
    s2=$(fsize "$lf"); [ "$s2" = "$s1" ] && [ "$(mtime "$lf")" = "$m1" ] || { echo log_growing; return 1; }
    echo "$s1 $m1"
  }
  ignored_ok(){ # every ignored path's top component must be a build artifact; prints a reason on failure
    local out p top
    out=$(g status --porcelain --ignored --untracked-files=normal --ignore-submodules=all 2>/dev/null) || { echo git_error; return 1; }
    while IFS= read -r p; do
      [ -z "$p" ] && continue
      case "$p" in "!! "*) ;; *) echo not_clean; return 1;; esac
      p=${p#!! }; case "$p" in \"*) echo ignored_quoted_path; return 1;; esac
      top=${p%%/*}; inlist "$top" "$BUILD_ALLOW" || { echo ignored_not_build_artifact; return 1; }
      [ "$p" = "$top" ] && { echo ignored_not_build_artifact; return 1; }   # a plain file named like a build dir
    done <<IGN
$out
IGN
    return 0
  }
  for bp in "$R"/*.base; do
    [ -f "$bp" ] && [ ! -L "$bp" ] || continue
    base_sha=$(sha256 "$bp"); [ -n "$base_sha" ] || continue
    J=$(basename "$bp" .base)
    case "$J" in ""|*[!A-Za-z0-9._-]*) cat_ other:bad_job "?" 0; continue;; esac
    candidate "$J" || continue
    BASE=""; BR=""; WT=""; POOL=""
    read -r BASE BR WT POOL < "$bp" || { cat_ other:bad_base "$J" 0; continue; }
    [ "$WT" = "$WT_ROOT/$J" ] || { cat_ other:base_mismatch "$J" 0; continue; }
    [ -n "${WT:-}" ] && [ -d "$WT" ] || continue          # not a kept worktree
    cand=$((cand+1))
    why=$(contained "$WT" "$J") || { cat_ "other:containment_$why" "$J" 0; continue; }   # no du outside the wt root
    sizek "$WT"
    printf '%s' "$BASE" | grep -qE '^[0-9a-f]{40}$' || { cat_ other:bad_base_sha "$J" "$KB"; continue; }
    [ "$GSOK" = 1 ] || { cat_ other:git_safe_unavailable "$J" "$KB"; continue; }
    gsw=$(gs_check "$WT") || { cat_ "other:git_unsafe_$gsw" "$J" "$KB"; continue; }   # G1: before ANY git call
    # ---- (2) git state, read-only. diff rc 0 clean / 1 diff / else error; any error => other:git_error
    g diff --quiet --no-ext-diff --no-textconv --ignore-submodules=all "$BASE" -- >/dev/null 2>&1; drc=$?
    st=$(g status --porcelain --untracked-files=normal --ignore-submodules=all 2>/dev/null) || drc=99
    ah=$(g rev-list --count "$BASE..HEAD" 2>/dev/null) || drc=99
    case "$ah" in ""|*[!0-9]*) drc=99;; esac
    case "$drc" in 0|1) ;; *) cat_ other:git_error "$J" "$KB"; continue;; esac
    if [ "$drc" = 1 ] || [ -n "$st" ] || [ "$ah" != 0 ]; then cat_ unpublished_with_diff_or_commits "$J" "$KB"; continue; fi
    # clean at base from here on
    if grep -q '^RESULT PR ' "$R/$J.publish" 2>/dev/null; then cat_ merged_closed_or_open_pr "$J" "$KB"; continue; fi
    [ $(( $(date +%s) - T0 )) -ge "$WALL" ] && { cat_ empty_skipped:wall_budget "$J" "$KB"; continue; }
    [ -n "$HOLD_ERR" ] && { cat_ empty_skipped:hold_list_invalid "$J" "$KB"; continue; }
    OK=empty_reapable; INF=0
    SK=empty_skipped
    if ! DS=$(done_status "$J"); then                                                                   # (1)
      # 12.1 inferred DONE-EMPTY: only with no .publish at all (any RESULT line that is not EMPTY stays a skip)
      [ -e "$R/$J.publish" ] && { cat_ empty_skipped:no_done_status "$J" "$KB"; continue; }
      INF=1; DS=inferred; SK=empty_inferred_skipped; OK=empty_inferred_reapable
      lfin=$(log_finished "$J") || { cat_ "$SK:$lfin" "$J" "$KB"; continue; }
      LSZ=${lfin%% *}; LMT=${lfin##* }
      igw=$(ignored_ok) || { cat_ "$SK:$igw" "$J" "$KB"; continue; }
    fi
    newest=$(mtime "$bp"); for x in "$R/$J.log" "$WT"; do m=$(mtime "$x"); [ "$m" -gt "$newest" ] && newest=$m; done
    [ $((NOW - newest)) -gt $EMPTY_AGE_S ] || { cat_ "$SK":under_6h "$J" "$KB"; continue; }   # (3)
    lw=$(live_job "$J" "$WT") && { cat_ "$SK:$lw" "$J" "$KB"; continue; }                 # (4)
    # (5) publish queue: keep.txt, PUBLISH_LANDONLY list, a G1 pass, or a publish/reap claim
    if inlist "$J" "$KEEP" || inlist "$J" "$LANDONLY" || [ -e "$R/g1-pass/$J.pass" ]; then cat_ "$SK":publish_queue "$J" "$KB"; continue; fi
    case "$BR" in codex/*|claude/*) cat_ "$SK":protected_branch "$J" "$KB"; continue;; esac
    held_job "$J" && { cat_ "$SK":hold_list "$J" "$KB"; continue; }                          # (6)
    wm=$((wm+1)); est_kb=$((est_kb + (KB > 0 ? KB : 0)))
    if [ "$APPLY" != 1 ]; then cat_ "$OK" "$J" "$KB"; echo "WOULD_REAP_EMPTY $J $DS ${KB}K $WT"; continue; fi
    [ "$R1OK" = 1 ] || { cat_ "$SK":reap_one_sha_mismatch "$J" "$KB"; continue; }
    recheck "$J" || { cat_ "$SK":classifier_changed "$J" "$KB"; continue; }
    mkdir "$RUN/$J.reaping" 2>/dev/null || { cat_ "$SK":live_lock "$J" "$KB"; continue; }
    # re-validate right before the call: containment, clean at base, DONE status, not live
    ok=1; contained "$WT" "$J" >/dev/null || ok=0
    [ $ok = 1 ] && { gs_check "$WT" >/dev/null || ok=0; }
    [ $ok = 1 ] && { g diff --quiet --no-ext-diff --no-textconv "$BASE" -- >/dev/null 2>&1 || ok=0; }
    [ $ok = 1 ] && { [ -z "$(g status --porcelain --untracked-files=normal 2>/dev/null || echo ERR)" ] || ok=0; }
    [ $ok = 1 ] && { [ "$(g rev-list --count "$BASE..HEAD" 2>/dev/null)" = 0 ] || ok=0; }
    if [ "$INF" = 1 ]; then   # inferred: still no .publish, log unchanged since the scan, still finished, ignored set still allowlisted
      [ -e "$R/$J.publish" ] && ok=0
      [ $ok = 1 ] && { [ "$(log_finished "$J")" = "$LSZ $LMT" ] || ok=0; }
      [ $ok = 1 ] && { ignored_ok >/dev/null || ok=0; }
    else
      [ $ok = 1 ] && { done_status "$J" >/dev/null || ok=0; }
    fi
    [ $ok = 1 ] && { [ -e "$RUN/$J.dispatched" ] || [ -e "$RUN/$J.lock" ] || [ -e "$R/$J.lock" ]; } && ok=0
    [ $ok = 1 ] && { [ ! -L "$bp" ] && [ "$(sha256 "$bp")" = "$base_sha" ] || ok=0; }
    if [ $ok = 0 ]; then rmdir "$RUN/$J.reaping" 2>/dev/null; cat_ "$SK":revalidate_failed "$J" "$KB"; continue; fi
    # DONE-NOOP jobs have no .publish; reap-one (10b, REAP_NO_PUBLISH=1) removes only on RESULT EMPTY/PR, so record
    # the same RESULT EMPTY line reap-one itself writes for a clean run at base. noclobber; undone if the reap fails.
    WROTE=0; PLINE="RESULT EMPTY (reap-empty: ${DS}, clean at base)"
    [ "$INF" = 1 ] && PLINE="$REAPONE_EMPTY_LINE inferred=12.1"   # 12.1: reap-one's exact line plus the tag
    if [ ! -e "$R/$J.publish" ]; then
      ( set -C; echo "$PLINE" > "$R/$J.publish" ) 2>/dev/null && WROTE=1 \
        || { rmdir "$RUN/$J.reaping" 2>/dev/null; cat_ "$SK":publish_race "$J" "$KB"; continue; }
    fi
    [ -d "$R/quarantine" ] && chmod 700 "$R/quarantine" 2>/dev/null
    REAP_CLASSIFIED_ONLY=1 REAP_NO_PUBLISH=1 /bin/bash "$REAPONE" "$J" >> "$RUN/$J.reap.log" 2>&1; rc=$?
    [ -d "$R/quarantine" ] && chmod 700 "$R/quarantine" 2>/dev/null
    if [ "$rc" = 0 ] && [ ! -e "$WT" ] && [ ! -L "$WT" ]; then
      retire_base "$bp" "$base_sha" || cat_ "$SK":base_retained "$J" "$KB"
      reaped=$((reaped+1)); freed_kb=$((freed_kb + (KB > 0 ? KB : 0)))
      printf '{"event":"reap_empty","job":"%s","status":"%s","path":"%s","bytes_freed":%s,"ts":"%s","ts_epoch":%s}\n' \
        "$(jstr "$J")" "$DS$([ "$INF" = 1 ] && echo ' inferred=12.1')" "$(jstr "$WT")" $(( (KB > 0 ? KB : 0) * 1024)) "$(date +%Y-%m-%dT%H:%M:%S%z)" "$(date +%s)" >> "$LOG"
      [ "$INF" = 1 ] && cat_ empty_inferred_reaped "$J" "$KB" || cat_ empty_reaped "$J" "$KB"
    else
      [ "$WROTE" = 1 ] && grep -qxF "$PLINE" "$R/$J.publish" 2>/dev/null && rm -f "$R/$J.publish"
      cat_ "$SK":reap_one_failed "$J" "$KB"
    fi
    rmdir "$RUN/$J.reaping" 2>/dev/null
  done
  rm -f "$OPEN"
  echo "SUMMARY mode=empty-$([ "$APPLY" = 1 ] && echo apply || echo dry) candidates=$cand du_measured=$dun du_max=$DU_MAX hold_entries=$(echo $HOLD | wc -w | tr -d ' ') reap_one_sha_ok=$R1OK"
  echo "WOULD_REAP_EMPTY count=$wm est_bytes=$((est_kb*1024))"
  [ "$APPLY" = 1 ] && echo "REAPED_EMPTY count=$reaped bytes_freed=$((freed_kb*1024))"
  # CATEGORY <name> count=<n> bytes=<measured bytes> unmeasured=<n>; top-level groups first, then reasons
  awk '{c=$1; k=$2+0; split(c, a, ":"); for (i = 1; i <= 2; i++) { n = (i == 1) ? a[1] : c; if (i == 2 && n == a[1]) continue;
         cnt[n]++; if (k >= 0) b[n] += k; else u[n]++ } }
       END { for (n in cnt) printf "CATEGORY %s count=%d bytes=%d unmeasured=%d\n", n, cnt[n], b[n]*1024, u[n] }' "$CATF" | sort
  rm -f "$CATF"
  exit 0
fi

for bp in "$R"/*.base; do
  [ -f "$bp" ] && [ ! -L "$bp" ] || continue
  base_sha=$(sha256 "$bp"); [ -n "$base_sha" ] || continue
  J=$(basename "$bp" .base)
  case "$J" in ""|*[!A-Za-z0-9._-]*) skip bad_job "$J"; continue;; esac
  candidate "$J" || continue
  read -r BASE BR WT POOL < "$bp" || { skip bad_base "$J"; continue; }
  [ "$WT" = "$WT_ROOT/$J" ] || { skip base_mismatch "$J"; continue; }
  [ -n "${WT:-}" ] && [ -d "$WT" ] || continue          # not a kept worktree
  cand=$((cand+1))
  if [ $(( $(date +%s) - T0 )) -ge "$WALL" ]; then skip wall_budget; continue; fi
  [ -n "$HOLD_ERR" ] && { skip hold_list_invalid; continue; }
  why=$(contained "$WT" "$J") || { skip "containment_$why" "$J"; continue; }
  result_ok "$J"; rc=$?
  [ $rc = 1 ] && { grep -q '^RESULT PR ' "$R/$J.publish" 2>/dev/null && skip bad_pr "$J" || skip no_result_pr "$J"; continue; }
  [ $rc = 2 ] && { skip bad_repo "$J $REPO"; continue; }
  inlist "$REPO#$PR" "$HOLD" && { skip hold_list "$J $REPO#$PR"; continue; }
  case "$BR" in codex/*) skip codex_branch "$J"; continue;; esac
  if [ -e "$RUN/$J.reaping" ] || [ -e "$RUN/$J.lock" ] || [ -e "$R/$J.lock" ]; then skip live_lock "$J"; continue; fi
  lm=$(mtime "$R/$J.log"); bm=$(mtime "$bp")
  if [ $((NOW - lm)) -lt $LIVE_S ] || [ $((NOW - bm)) -lt $LIVE_S ]; then skip live_recent "$J"; continue; fi
  { [ $((NOW - lm)) -ge $IDLE_S ] && [ $((NOW - bm)) -ge $IDLE_S ]; } || { skip "not_idle_${IDLE_H}h" "$J"; continue; }   # rev1.3
  case "$BR" in claude/*)   # last push = .publish write (publish.sh); unknown => skip
    pm=$(mtime "$R/$J.publish"); { [ "$pm" -gt 0 ] && [ $((NOW - pm)) -ge $CLAUDE_PUSH_S ]; } || { skip claude_recent_push "$J"; continue; };; esac
  [ "$LSOF_OK" = 1 ] || { skip lsof_failed "$J"; continue; }
  RW=$(rp "$WT")
  if grep -qF -e "n$WT/" -e "n$RW/" "$OPEN" || grep -qxF -e "n$WT" -e "n$RW" "$OPEN"; then skip live_process "$J"; continue; fi
  if [ "$ghn" -ge "$MAX_GH" ]; then skip gh_budget; continue; fi
  [ "$ghn" -gt 0 ] && sleep "$GH_SLEEP"; ghn=$((ghn+1))
  STATE=$("$GH" pr view "$PR" --repo "$REPO" --json state -q .state 2>/dev/null) || { skip gh_failed "$J"; continue; }
  case "$STATE" in MERGED|CLOSED) ;; OPEN) skip pr_open "$J"; continue;; *) skip pr_unknown "$J"; continue;; esac
  KB=$(du -sk "$WT" 2>/dev/null | awk '{print $1+0}'); KB=${KB:-0}
  if [ "$STATE" = MERGED ]; then wm=$((wm+1)); else wc=$((wc+1)); fi; est_kb=$((est_kb + KB))
  if [ "$APPLY" != 1 ]; then echo "WOULD_REAP $J $REPO#$PR $STATE ${KB}K $WT"; continue; fi
  [ "$R1OK" = 1 ] || { skip reap_one_unpatched "$J"; continue; }
  recheck "$J" || { skip classifier_changed "$J"; continue; }
  mkdir "$RUN/$J.reaping" 2>/dev/null || { skip live_lock "$J"; continue; }
  # (b) re-validate right before the call: .publish still a RESULT PR for the same PR, WT still contained
  P0="$REPO#$PR"
  if ! result_ok "$J" || [ "$REPO#$PR" != "$P0" ] || ! contained "$WT" "$J" >/dev/null ||
    [ -L "$bp" ] || [ "$(sha256 "$bp")" != "$base_sha" ]; then
    rmdir "$RUN/$J.reaping" 2>/dev/null; skip revalidate_failed "$J"; continue
  fi
  [ -d "$R/quarantine" ] && chmod 700 "$R/quarantine" 2>/dev/null
  REAP_CLASSIFIED_ONLY=1 REAP_NO_PUBLISH=1 /bin/bash "$REAPONE" "$J" >> "$RUN/$J.reap.log" 2>&1; rc=$?
  [ -d "$R/quarantine" ] && chmod 700 "$R/quarantine" 2>/dev/null
  if [ "$rc" = 0 ] && [ ! -e "$WT" ] && [ ! -L "$WT" ]; then
    retire_base "$bp" "$base_sha" || skip base_retained "$J"
    reaped=$((reaped+1)); freed_kb=$((freed_kb + KB))
    printf '{"event":"reap","job":"%s","repo":"%s","pr":%s,"state":"%s","path":"%s","bytes_freed":%s,"ts":"%s","ts_epoch":%s}\n' \
      "$(jstr "$J")" "$REPO" "$PR" "$STATE" "$(jstr "$WT")" $((KB*1024)) "$(date +%Y-%m-%dT%H:%M:%S%z)" "$(date +%s)" >> "$LOG"
    echo "REAPED $J $REPO#$PR $STATE ${KB}K"
  else
    skip reap_one_failed "$J rc=$rc"
  fi
  rmdir "$RUN/$J.reaping" 2>/dev/null
done
rm -f "$OPEN"

if [ -f "$LOG" ]; then
  cut=$(( $(date +%s) - 86400 )); tmp="$LOG.tmp.$$"
  awk -v c="$cut" '{ if (match($0, /"ts_epoch":[0-9]+/)) { e=substr($0, RSTART+11, RLENGTH-11)+0; if (e >= c) print } }' "$LOG" > "$tmp" && mv "$tmp" "$LOG"
fi

echo "SUMMARY mode=$([ "$APPLY" = 1 ] && echo apply || echo dry) candidates=$cand gh_calls=$ghn hold_entries=$(echo $HOLD | wc -w | tr -d ' ') reap_one_no_publish=$R1OK"
echo "WOULD_REAP merged=$wm closed=$wc est_bytes=$((est_kb*1024))"
[ "$APPLY" = 1 ] && echo "REAPED count=$reaped bytes_freed=$((freed_kb*1024))"
sort "$SKF" | uniq -c | awk '{print "SKIPPED " $2 "=" $1}'; rm -f "$SKF"
exit 0
