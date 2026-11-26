#!/bin/bash
# archive-reap.sh [--apply] (RQ-ARCHIVE-REAP rev1): archive idle PR-less worktrees to $R/salvage/<job>.patch, then reap.
# --archive-only (also needs REAP_APPLY=1) writes the salvage and RESULT line but never calls reap-one.
# Default is a dry run: prints candidates, skips by reason and total GiB, touches nothing.
# --apply needs REAP_APPLY=1: salvage (git diff <base> + untracked, secret-shaped/binary/>1 MiB files excluded, paths logged
# only), scrub.pl --check (hit: patch deleted, worktree kept), RESULT ARCHIVED <sha> <size> <base> <ts> appended to
# $R/<job>.publish, then reap-one.sh (which re-verifies the patch sha before its sanctioned remove).
# All git via the pinned git-safe-env.sh. No commit, push or stash; the index is never written (GIT_OPTIONAL_LOCKS=0).
set -u; umask 077
R="$HOME/.ashlr-runs"; Q="$R/queue"; WTR="$HOME/Projects/ashlrai/wt"; SV="$R/salvage"; EV="$R/dispatch-events.log"; RULES="$R/ENGINEER-RULES.md"
GS="$R/bin/git-safe-env.sh"; GS_SHA=01e1e5ab72016a5b6fbd96c76cb903eb7c61849084b20ae04374219dcd077331
SCRUB="$R/bin/scrub.pl"; SCRUB_SHA=5aa902abedbb3bf7fa8d893b93969e247c82ff62ac26cd082215caabfb740265
REAPONE="$R/bin/reap-one.sh"; REAPONE_SHA=e45b88f98144e87693b27ca8b0b4d72a071e886e407cfda9541a810384087c0c
SKIPLIST="RQ-DISC-SITE-ASHLR RQ-FRESH-SITE-ASHLR RQ-MEASURABLY-OSS-AUDIT-LOCAL RQ-SEO-ASHLR"
MAXF=1048576; NOW=$(date +%s)
# rev1.4 ARCHIVE_IDLE_H: no-PR / ARCHIVED idle threshold, default 12 (whole hours, at most 4 digits). Below 2 clamps up to 2
# (ARCHIVE_IDLE_H_CLAMPED); non-numeric falls back to 12 (ARCHIVE_IDLE_H_REJECTED). A value under 12 applies only when
# dispatchd's record shows the job finished: the last "launch"/"finish" event for it in $R/metrics/jobs.jsonl is "finish"
# and $Q/run/<job>.dispatched is absent. Unknown or missing => 12. rev1.4.1: exact id via grep -F on the literal
# '"job": "<id>"' (json.dumps default separators), so dots in an id are not wildcards.
AIH=12; AIH_LOG=""
if [ -n "${ARCHIVE_IDLE_H+x}" ]; then
  if [[ "$ARCHIVE_IDLE_H" =~ ^[0-9]{1,4}$ ]]; then AIH=$((10#$ARCHIVE_IDLE_H)); [ "$AIH" -lt 2 ] && { AIH=2; AIH_LOG="ARCHIVE_IDLE_H_CLAMPED using=2"; }
  else AIH_LOG="ARCHIVE_IDLE_H_REJECTED using=12"; fi
fi
# RQ-FINISH-SIGNAL B: finished = no .dispatched AND (last jsonl launch/finish event is finish, OR launch.sh's .rc exists,
# OR quiet_2h: no lsof hold under the worktree (cwd included), no pid file, not named in status.json, readable status.json,
# and both the .log and the newest regular file in the worktree (outside .git) at least 2h old). Lowered path only.
FS_LSOF=$(PATH="$PATH:/usr/sbin" command -v lsof) || FS_LSOF=/nonexistent/lsof; FS_DONE=""; FS_LO=""; FS_OK=1   # PATH lookup (tests stub via a PATH dir); missing lsof fails closed
quiet_2h(){ # $1 job $2 worktree
  local j=$1 w=$2 rw f
  for f in "$R/queue/run/$j.pid" "$R/$j.pid"; do { [ -e "$f" ] || [ -L "$f" ]; } && return 1; done
  [ -r "$R/queue/status.json" ] || return 1; grep -qF "\"$j\"" "$R/queue/status.json" && return 1
  [ -n "$FS_DONE" ] || { FS_LO=$("$FS_LSOF" -nP -w -Fn 2>/dev/null); FS_OK=$?; [ -n "$FS_LO" ] && FS_OK=0; FS_DONE=1; }
  [ "$FS_OK" = 0 ] || return 1
  rw=$(cd "$w" 2>/dev/null && pwd -P) || return 1
  printf '%s\n' "$FS_LO" | grep -qF -e "n$w/" -e "n$rw/" && return 1
  printf '%s\n' "$FS_LO" | grep -qxF -e "n$w" -e "n$rw" && return 1
  [ -f "$R/$j.log" ] && [ -z "$(find "$R/$j.log" -mmin -120 -print 2>/dev/null)" ] || return 1
  [ -z "$(find "$w" -xdev -type f -mmin -120 ! -path "*/.git/*" ! -path "$w/.git" -print -quit 2>/dev/null)" ]
}
job_finished(){ # $1 job $2 worktree
  [ -e "$R/queue/run/$1.dispatched" ] && return 1
  [ -f "$R/queue/run/$1.rc" ] && [ ! -L "$R/queue/run/$1.rc" ] && return 0
  grep -E '"event": *"(launch|finish)"' "$R/metrics/jobs.jsonl" 2>/dev/null | grep -F "\"job\": \"$1\"" | tail -1 | grep -qE '"event": *"finish"' && return 0
  [ -n "${2:-}" ] && quiet_2h "$1" "$2"
}
idle_h(){ # $1 job $2 worktree -> hours to use
  if [ "$AIH" -lt 12 ]; then job_finished "$1" "${2:-}" && echo "$AIH" || echo 12; else echo "$AIH"; fi; }
APPLY=0; NOREAP=0; case "${1:-}" in --apply) APPLY=1;; --archive-only) APPLY=1; NOREAP=1;; esac   # --archive-only: salvage + record, no reap
[ "$APPLY" = 1 ] && [ "${REAP_APPLY:-}" != 1 ] && { echo "REFUSE: --apply needs REAP_APPLY=1"; exit 2; }
[ "$APPLY" = 1 ] && { [[ "${REAP_MAX:-}" =~ ^[0-9]{1,4}$ ]] || { echo "REFUSE: --apply needs REAP_MAX=<dry-run candidates>"; exit 2; }; RMAX=$((10#$REAP_MAX)); }   # rev1.7
sha(){ { /usr/bin/shasum -a 256 "$1" 2>/dev/null || sha256sum "$1" 2>/dev/null; } | awk 'NR==1{print $1}'; }
pinned(){ [ -f "$1" ] && [ ! -L "$1" ] && [ "$(sha "$1")" = "$2" ]; }
PLAN="$R/bin/reaper-plan.py"
if [ "$NOREAP" = 0 ]; then
  pinned "$PLAN" "95c1c9111db21cf4ca13ba2e8eb6dd2a04a651017ca127505a0cdc91e1a687b0" || { echo "REFUSE: reaper-plan.py missing or sha mismatch"; exit 3; }
  REAPABLE=$(/usr/bin/python3 -I -B "$PLAN" plan "$HOME") || { echo "REFUSE: disk-maint plan unavailable"; exit 3; }
fi
candidate(){ case $'\n'"${REAPABLE:-}"$'\n' in *$'\n'"$1"$'\n'*) return 0;; *) return 1;; esac; }
ev(){ echo "$(date '+%F %T') $*" >> "$EV"; }
clean(){ printf '%s' "$1" | tr -cd 'A-Za-z0-9._/@+=,:-' | cut -c1-200; }
inlist(){ local x; for x in $2; do [ "$x" = "$1" ] && return 0; done; return 1; }
[ -n "$AIH_LOG" ] && { echo "WARNING $AIH_LOG" >&2; ev "$AIH_LOG"; }
pinned "$GS" "$GS_SHA" && . "$GS" && gs_init || { echo "REFUSE: git-safe-env.sh missing or sha mismatch"; exit 3; }
pinned "$SCRUB" "$SCRUB_SHA" || { echo "REFUSE: scrub.pl missing or sha mismatch"; exit 3; }
[ "$APPLY" = 1 ] && [ "$NOREAP" = 0 ] && { pinned "$REAPONE" "$REAPONE_SHA" || { echo "REFUSE: reap-one.sh missing or sha mismatch"; exit 3; }; }   # rev1.2: --archive-only never calls reap-one
# hold list: ENGINEER-RULES.md must match its .sha256 and have exactly one "7. Hold list" line, else every worktree is skipped
HOLD_OK=0; L7=""
if [ -f "$RULES" ] && [ ! -L "$RULES" ] && [ -f "$RULES.sha256" ] && [ ! -L "$RULES.sha256" ] && [ "$(sha "$RULES")" = "$(awk 'NR==1{print $1}' "$RULES.sha256")" ] \
   && [ "$(grep -c '^7\. Hold list' "$RULES")" = 1 ]; then L7=$(grep '^7\. Hold list' "$RULES"); HOLD_OK=1; fi
# liveness (rev1.2, args-free): one full lsof scan (every fd including cwd/txt, so a process whose cwd is inside the worktree
# is caught; lsof missing or failed with no output => every job live-unknown, skipped), a pid file ($Q/run/<job>.pid or
# $R/<job>.pid) checked with kill -0 (stale or unreadable => live-unknown, skipped), plus the job id in queue/status.json
LSOF=$FS_LSOF   # same PATH-resolved lsof as the cwd check
LSO=$("$LSOF" -nP -w -Fn 2>/dev/null); LSOF_OK=$?; [ -n "$LSO" ] && LSOF_OK=0
pidlive(){ # $1 job -> prints live_pid | live_unknown_pidfile | nothing (no pid file)
  local f p; for f in "$Q/run/$1.pid" "$R/$1.pid"; do [ -e "$f" ] || [ -L "$f" ] || continue
    p=$(head -c 32 "$f" 2>/dev/null | tr -d ' \n'); case "$p" in ""|*[!0-9]*) echo live_unknown_pidfile; return;; esac
    kill -0 "$p" 2>/dev/null && echo live_pid || echo live_unknown_pidfile; return; done; }
STJ=$(python3 -I -c 'import json,sys;print(" ".join(j for j in (json.load(open(sys.argv[1])).get("reaping") or []) if isinstance(j, str)))' "$Q/status.json" 2>/dev/null) || STJ_BAD=1; KEEP=$(cat "$Q/keep.txt" 2>/dev/null); LANDONLY=$(cat "$R/PUBLISH_LANDONLY" 2>/dev/null)
why(){ # $1 job $2 wt -> prints a skip reason, or nothing when eligible
  local j=$1 w=$2 b
  inlist "$j" "$SKIPLIST" && { echo skip_list; return; }
  case "$j" in *[!A-Za-z0-9._-]*|.*) echo bad_name; return;; esac
  [ -d "$w" ] && [ ! -L "$w" ] || { echo not_dir; return; }
  [ -f "$R/$j.base" ] && [ ! -L "$R/$j.base" ] || { echo no_base; return; }
  b=$(awk 'NR==1{print $3}' "$R/$j.base"); [ "$b" = "$w" ] || { echo base_mismatch; return; }
  grep -q '^RESULT PR ' "$R/$j.publish" 2>/dev/null && { echo has_pr; return; }
  # rev1.5 (EO 19:01 Oct 27): only wt-classify 5cdf30c2 classes no_publish and abort_* (no .base is already no_base above:
  # reap-one needs .base). Same last-RESULT rule as wt-classify.
  b=$(grep '^RESULT' "$R/$j.publish" 2>/dev/null | tail -1); case "$b" in ""|"RESULT ABORT "*) ;; *) echo "class_$(printf %s "$b" | awk '{print tolower($2)}' | tr -cd a-z_)"; return;; esac
  [ "$HOLD_OK" = 1 ] || { echo hold_list_invalid; return; }
  case "$L7" in *"$j"*) echo hold; return;; esac
  [ "$LSOF_OK" = 0 ] || { echo lsof_failed; return; }
  b=$(pidlive "$j"); [ -n "$b" ] && { echo "$b"; return; }
  b=$(cd "$w" 2>/dev/null && pwd -P); { printf '%s\n' "$LSO" | grep -qF -e "n$w/" -e "n${b:-$w}/" || printf '%s\n' "$LSO" | grep -qxF -e "n$w" -e "n${b:-$w}"; } && { echo live_open_file; return; }
  [ -n "${STJ_BAD:-}" ] && { echo status_unreadable; return; }   # rev1.6 (Security): fail closed
  inlist "$j" "$STJ" && { echo live_status; return; }   # rev1.5: status.json "reaping" only (kept_worktrees listed every abort_* job)
  { inlist "$j" "$KEEP" || inlist "$j" "$LANDONLY" || [ -e "$R/g1-pass/$j.pass" ] || [ -e "$Q/run/$j.reaping" ] || [ -e "$Q/run/$j.dispatched" ]; } && { echo publish_queue; return; }
  b=$(idle_h "$j" "$w"); [ -n "$(find "$w" "$R/$j.base" "$R/$j.log" -xdev \( -name .git -o -name node_modules \) -prune -o -mmin -$((b * 60)) -print -quit 2>/dev/null)" ] && { echo "not_idle_${b}h"; return; }
  gs_check "$w" >/dev/null || { echo git_unsafe; return; }
}
excluded(){ # $1 wt-relative path, $2 binary flag from numstat (1 = binary) -> 0 if it must not go in the patch
  case "${1##*/}" in .env*|*.pem|*.key|id_*|.npmrc|.netrc) return 0;; esac
  [ "${2:-0}" = 1 ] && return 0
  [ -f "$W/$1" ] || return 1
  [ "$(wc -c < "$W/$1")" -gt "$MAXF" ] && return 0
  [ -s "$W/$1" ] && ! grep -Iq . "$W/$1" && return 0
  return 1
}
archive(){ # $1 job; 0 = archived and ready to reap
  local j=$1 BASE BR P T rec f a d inc=() psha sz base_w
  [ ! -L "$R/$j.base" ] && read -r BASE BR base_w _ < "$R/$j.base" && [ "$base_w" = "$W" ] || return 1
  [[ "$BASE" =~ ^[0-9a-f]{40}$ ]] || { ev "ARCHIVE_SKIP $j bad_base"; return 1; }
  (umask 077; mkdir -p "$SV") && chmod 700 "$SV" && [ ! -L "$SV" ] || return 1
  P="$SV/$j.patch"; [ -e "$P" ] || [ -L "$P" ] && { ev "ARCHIVE_SKIP $j salvage_exists"; return 1; }
  T=$(mktemp "$SV/.$j.XXXXXX") || return 1
  rec=$(gs_git "$W" diff --no-renames --numstat -z "$BASE" | tr '\0' '\n') || { rm -f "$T"; ev "ARCHIVE_SKIP $j git_error"; return 1; }
  while IFS=$'\t' read -r a d f; do [ -n "$f" ] || continue
    if excluded "$f" "$([ "$a" = - ] && echo 1)"; then ev "ARCHIVE_EXCLUDED $j $(clean "$f")"; else inc+=(":(literal)$f"); fi
  done <<< "$rec"
  if [ ${#inc[@]} -gt 0 ]; then gs_git "$W" diff --no-renames --no-ext-diff --no-textconv "$BASE" -- "${inc[@]}" >> "$T" || { rm -f "$T"; ev "ARCHIVE_SKIP $j git_error"; return 1; }; fi
  UL=$(mktemp "$SV/.$j.ul.XXXXXX") || { rm -f "$T"; return 1; }
  gs_git "$W" ls-files --others --exclude-standard -z > "$UL" || { rm -f "$T" "$UL"; ev "ARCHIVE_SKIP $j git_error"; return 1; }
  while IFS= read -r -d '' f; do
    if excluded "$f"; then ev "ARCHIVE_EXCLUDED $j $(clean "$f")"; continue; fi
    gs_git "$W" diff --no-index --no-ext-diff --no-textconv -- /dev/null "$f" >> "$T"; [ $? -le 1 ] || { rm -f "$T" "$UL"; ev "ARCHIVE_SKIP $j git_error"; return 1; }
  done < "$UL"; rm -f "$UL"
  perl "$SCRUB" --check < "$T" >/dev/null 2>&1 || { rm -f "$T"; ev "ARCHIVE_SCRUB_HIT $j"; echo "scrub_hit $j"; return 1; }
  chmod 600 "$T"; psha=$(sha "$T"); sz=$(wc -c < "$T" | tr -d ' ')
  ln "$T" "$P" 2>/dev/null || { rm -f "$T"; ev "ARCHIVE_SKIP $j salvage_exists"; return 1; }   # atomic, never overwrites
  rm -f "$T"; [ "$(sha "$P")" = "$psha" ] || { ev "ARCHIVE_SKIP $j sha_verify_failed"; return 1; }
  printf 'RESULT ARCHIVED %s %s %s %s\n' "$psha" "$sz" "$BASE" "$(date +%Y-%m-%dT%H:%M:%S%z)" >> "$R/$j.publish"
  ev "ARCHIVED $j sha=$psha size=$sz"; return 0
}
n=0; kb=0; skips=""; C=""
for W0 in "$WTR"/*; do [ -e "$W0" ] || continue
  J=${W0##*/}
  [ "$NOREAP" = 1 ] || candidate "$J" || continue
  r=$(why "$J" "$W0")
  if [ -n "$r" ]; then skips="$skips $r"; continue; fi
  n=$((n+1)); C="$C $J"; k=$(du -sk "$W0" 2>/dev/null | awk '{print $1}'); kb=$((kb + ${k:-0})); echo "CANDIDATE $J ${k:-0}KB"
done
# rev1.7 (Security 19:28): count first; over REAP_MAX aborts before any worktree is touched. Each job re-checked right before apply.
[ "$APPLY" = 1 ] && [ "$n" -gt "$RMAX" ] && { echo "REFUSE: candidates=$n > REAP_MAX=$RMAX, nothing touched"; ev "ARCHIVE_REAP_MAX_EXCEEDED $n>$RMAX"; exit 4; }
[ "$APPLY" = 1 ] && for J in $C; do W0="$WTR/$J"; r=$(why "$J" "$W0"); [ -z "$r" ] || { ev "ARCHIVE_SKIP $J changed_$r"; continue; }
  W=$W0
  if [ "$NOREAP" = 1 ]; then archive "$J"; continue; fi
  [ "$(/usr/bin/python3 -I -B "$PLAN" plan "$HOME" "$J")" = "$J" ] || { ev "ARCHIVE_SKIP $J classifier_changed"; continue; }
  bp="$R/$J.base"; base_sha=$(sha "$bp")
  [ -n "$base_sha" ] || continue
  archive "$J" || continue
  [ "$(/usr/bin/python3 -I -B "$PLAN" plan "$HOME" "$J")" = "$J" ] || { ev "ARCHIVE_SKIP $J classifier_changed"; continue; }
  mkdir "$Q/run/$J.reaping" 2>/dev/null || { ev "ARCHIVE_REAP_SKIP $J reaping_claimed"; continue; }
  if [ ! -L "$bp" ] && [ "$(sha "$bp")" = "$base_sha" ] &&
    REAP_CLASSIFIED_ONLY=1 REAP_APPLY=1 REAP_NO_PUBLISH=1 /bin/bash "$REAPONE" "$J" && [ ! -e "$W0" ] && [ ! -L "$W0" ]; then
    [ ! -L "$bp" ] && [ "$(sha "$bp")" = "$base_sha" ] &&
      [ ! -e "$bp.reaped" ] && [ ! -L "$bp.reaped" ] && mv -n "$bp" "$bp.reaped"
  fi
  rmdir "$Q/run/$J.reaping" 2>/dev/null
done
echo "candidates=$n gib=$(awk -v k=$kb 'BEGIN{printf "%.2f", k/1048576}') mode=$([ "$NOREAP" = 1 ] && echo archive-only || { [ "$APPLY" = 1 ] && echo apply || echo dry-run; })"
printf '%s\n' $skips | grep . | sort | uniq -c | awk '{print "skip " $2 "=" $1}'
exit 0
