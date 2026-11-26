#!/bin/bash
# reap-one.sh <job>: publish a finished job via publish.sh, then remove its worktree.
# Plain `git worktree remove` (never --force); fallback = quarantine diff/status/untracked, rm dir.
# 10c (RQ-GIT-SAFE G1): every git call goes through the pinned git-safe-env.sh helper after gs_check of the worktree;
# if the helper is missing, tampered or refuses, nothing is published, classified or removed (worktree kept).
# 10c drops 10b's `git worktree prune` (EO ban on ad hoc removal incl. implicit prune): only the verified worktree is removed.
unset LOCUS_CONTROL_CAPABILITY
J=$1; R="$HOME/.ashlr-runs"; Q="$R/queue"; EV="$R/dispatch-events.log"; M="$Q/run/$J.reaping"
GS="$R/bin/git-safe-env.sh"; GS_SHA=01e1e5ab72016a5b6fbd96c76cb903eb7c61849084b20ae04374219dcd077331
ev(){ echo "$(date '+%F %T') $*" >> "$EV"; }
case "$J" in ""|*[!A-Za-z0-9._-]*) exit 2;; esac
read BASE BR WT POOL < "$R/$J.base" || exit 2
trap 'rmdir "$M" 2>/dev/null' EXIT
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
gs_ready(){ # load + verify the helper once, then check this worktree; fails closed
  [ -n "${GS_LOADED:-}" ] || {
    [ -f "$GS" ] && [ ! -L "$GS" ] || return 1
    [ "$( { /usr/bin/shasum -a 256 "$GS" 2>/dev/null || sha256sum "$GS" 2>/dev/null; } | awk 'NR==1{print $1}')" = "$GS_SHA" ] || return 1
    . "$GS" && gs_init || return 1; GS_LOADED=1; }
  local root n; root=$(gs_rp "$HOME/Projects/ashlrai/wt"); [ -n "$root" ] || return 1
  case "$WT" in "$root"/*) n=${WT#"$root"/}; case "$n" in ""|*/*|.*|*[!A-Za-z0-9._-]*) return 1;; esac;; *) return 1;; esac
  GSWHY=$(gs_check "$WT") || return 1
  return 0
}
g(){ gs_git "$WT" "$@"; }
remove_wt(){
  [ -d "$WT" ] || return 0
  gs_ready || { ev "WT_KEPT_GIT_UNSAFE $J ${GSWHY:-helper_unavailable}"; return 1; }
  RP=$(g rev-parse --path-format=absolute --git-common-dir 2>/dev/null); RP=${RP%/.git}
  [ -n "$RP" ] && [ -d "$RP/.git" ] || { ev "WT_KEPT_GIT_UNSAFE $J no_common_dir"; return 1; }
  if gs_git "$RP" worktree remove "$WT" 2>/dev/null; then ev "WT_REMOVED $J"; return 0; fi
  QD="$R/quarantine/$J"; (umask 077; mkdir -p "$QD"); chmod 700 "$R/quarantine" "$QD"
  g rev-parse HEAD > "$QD/head.txt" 2>/dev/null
  g status --porcelain -uall > "$QD/status.txt" 2>/dev/null
  if [ "${ARCH:-}" = 1 ]; then   # rev1.2: ARCHIVED only. Tracked secret-shaped names left out of diff.patch, logged by name only
    g diff --name-only -z HEAD -- ':(glob)**/.env*' ':(glob)**/*.pem' ':(glob)**/*.key' ':(glob)**/id_*' ':(glob)**/.npmrc' ':(glob)**/.netrc' 2>/dev/null | while IFS= read -r -d '' f; do
      ev "QUARANTINE_EXCLUDED_TRACKED $J $(printf '%s' "$f" | tr -cd 'A-Za-z0-9._/@+=,:-' | cut -c1-200)"; done
    g diff --no-ext-diff --no-textconv HEAD -- . ':(exclude,glob)**/.env*' ':(exclude,glob)**/*.pem' ':(exclude,glob)**/*.key' ':(exclude,glob)**/id_*' ':(exclude,glob)**/.npmrc' ':(exclude,glob)**/.netrc' > "$QD/diff.patch" 2>/dev/null
  else g diff --no-ext-diff --no-textconv HEAD > "$QD/diff.patch" 2>/dev/null; fi
  if [ "${ARCH:-}" = 1 ]; then   # rev1.1: ARCHIVED only. Same name list as archive-reap.sh excluded(); paths logged, never content
    (cd "$WT" && g ls-files --others --exclude-standard -z | while IFS= read -r -d '' f; do
      case "${f##*/}" in .env*|*.pem|*.key|id_*|.npmrc|.netrc) ev "QUARANTINE_EXCLUDED $J $(printf '%s' "$f" | tr -cd 'A-Za-z0-9._/@+=,:-' | cut -c1-200)";;
        *) printf '%s\0' "$f";; esac; done | xargs -0 tar -cf "$QD/untracked.tar" 2>/dev/null)
  else (cd "$WT" && g ls-files --others --exclude-standard -z | xargs -0 tar -cf "$QD/untracked.tar" 2>/dev/null); fi
  rm -rf "$WT"; ev "WT_QUARANTINED $J -> quarantine/$J (admin entry left, see 10c NOTES)"
}
if [ ! -e "$R/$J.publish" ]; then
  # 10b: a reaper call (REAP_NO_PUBLISH=1) must never publish; if .publish vanished, stop with the worktree kept
  [ "${REAP_NO_PUBLISH:-}" = 1 ] && { ev "REAP_NO_PUBLISH_REFUSED $J"; exit 3; }
  gs_ready || { ev "PUBLISH_KEPT_GIT_UNSAFE $J ${GSWHY:-helper_unavailable}"; exit 4; }   # 10c: no classify, no publish
  ST=$(g status --porcelain -uall 2>/dev/null) || { ev "PUBLISH_KEPT_GIT_ERROR $J"; exit 4; }
  HD=$(g rev-parse HEAD 2>/dev/null) || { ev "PUBLISH_KEPT_GIT_ERROR $J"; exit 4; }
  if [ -z "$ST" ] && [ "$HD" = "$BASE" ]; then
    echo "RESULT EMPTY (dispatchd: no changes, publish skipped)" > "$R/$J.publish"; ev "EMPTY $J"
  else
    ev "PUBLISH_START $J $POOL"; /bin/bash "$R/bin/publish.sh" "$J"
  fi
fi
RES=$(grep '^RESULT' "$R/$J.publish" 2>/dev/null | tail -1)
URL=$(echo "$RES" | grep -oE 'https://github.com/[A-Za-z0-9._/-]+/pull/[0-9]+' | head -1)
case "$RES" in "RESULT PR "*) CL=pr;; "RESULT ARCHIVED "*) CL=archived;; "RESULT EMPTY"*) CL=empty;; *secret-shape*) CL=abort_secret_shape;; "RESULT DENIED"*) CL=denied;; "RESULT ABORT "*) CL="abort_$(echo "$RES" | awk '{print $3}' | tr -cd 'a-z-')";; *) CL=unknown;; esac
# 10c M1: reaper-written EMPTY lines (12 "(reap-empty:", 12.1 "inferred=12.1") are tagged so reports can split them
INF=""; [ "$CL" = empty ] && case "$RES" in *"inferred=12.1"*|*"(reap-empty:"*) INF=',"inferred":true';; esac
mkdir -p "$R/metrics"; printf '{"event":"publish","job":"%s","lane":"%s","url":%s,"class":"%s"%s,"ts":"%s"}\n' "$J" "$POOL" "$([ -n "$URL" ] && echo "\"$URL\"" || echo null)" "$CL" "$INF" "$(date +%Y-%m-%dT%H:%M:%S%z)" >> "$R/metrics/jobs.jsonl"
case "$RES" in
  "RESULT PR "*) ev "PUBLISHED $J $(echo "$RES" | grep -oE 'https://github.com/[^ ]+/pull/[0-9]+')"; remove_wt;;
  "RESULT EMPTY"*) ev "EMPTY_DONE $J"; remove_wt;;
  "RESULT ARCHIVED "*) # RQ-ARCHIVE-REAP: counts as CLOSED only under REAP_APPLY=1 and only if the salvage patch still has the recorded sha
    AS=$(echo "$RES" | awk '{print $3}'); AP="$R/salvage/$J.patch"
    # rev1.4: ARCHIVED idle = ARCHIVE_IDLE_H via idle_h (12 unless dispatchd shows it finished); REAP_IDLE_H never read
    [ -n "$AIH_LOG" ] && ev "$AIH_LOG $J"; AH=$(idle_h "$J" "$WT")
    AIDLE=$(find "$WT" "$R/$J.base" "$R/$J.log" -xdev -mmin -$((AH * 60)) ! -path "*/.git/*" ! -path "*/node_modules/*" -print -quit 2>/dev/null)
    if [ -n "$AIDLE" ]; then ev "ARCHIVE_NOT_IDLE $J ${AH}h worktree kept"
    elif [ "${REAP_APPLY:-}" = 1 ] && [ -f "$AP" ] && [ ! -L "$AP" ] && [ "$( { /usr/bin/shasum -a 256 "$AP" 2>/dev/null || sha256sum "$AP" 2>/dev/null; } | awk 'NR==1{print $1}')" = "$AS" ]; then
      ev "ARCHIVED_DONE $J"; ARCH=1 remove_wt
    else ev "ARCHIVE_NOT_VERIFIED $J worktree kept"; fi;;
  *PUBLISH-ABORT*) ev "PUBLISH_ABORT_SECRET_SHAPE $J worktree kept for supervisor";;
  *) ev "PUBLISH_NOT_DONE $J [$(echo "$RES" | cut -c1-40)] worktree kept for supervisor";;
esac
