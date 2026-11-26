#!/bin/bash
# RQ-SEC-REALHOME-1 (e) FAIL-CLOSED: account home from dscl NFSHomeDirectory (space-safe), then dscl retry, then pwd.getpwuid; never keep a caller-moved $HOME.
_RH=$(/usr/bin/dscl . -read "/Users/$(/usr/bin/id -un)" NFSHomeDirectory 2>/dev/null | /usr/bin/sed -n 's/^NFSHomeDirectory: //p')
case "$_RH" in /*) [ -d "$_RH" ] || _RH=;; *) _RH=;; esac
if [ -z "$_RH" ]; then
  _RH=$(/usr/bin/dscl . -read "/Users/$(/usr/bin/id -un)" NFSHomeDirectory 2>/dev/null | /usr/bin/sed -n 's/^NFSHomeDirectory: //p')
  case "$_RH" in /*) [ -d "$_RH" ] || _RH=;; *) _RH=;; esac
fi
if [ -z "$_RH" ]; then
  _RH=$(/usr/bin/python3 -I -c 'import pwd,os;print(pwd.getpwuid(os.getuid()).pw_dir)' 2>/dev/null)
  case "$_RH" in /*) [ -d "$_RH" ] || _RH=;; *) _RH=;; esac
fi
if [ -z "$_RH" ]; then echo "HELD: realhome unresolved (KILL engaged)"; exit 3; fi
export HOME="$_RH"; unset _RH
# launch.sh <job> <repo> <pool> [tier: frontier|work|mid|fast] ; prompt body on stdin
# GATES v4: sandbox profile shas come from the pinned table bin/sandbox-pins.tsv (written only by bin/sb-autopin.py or a Security pin;
# write-denied to every lane and the leader). An absent entry yields an empty sha, so the check below refuses.
pinsha(){ /usr/bin/awk -F'\t' -v n="$1" '$1==n{print $2}' "$HOME/.ashlr-runs/bin/sandbox-pins.tsv" 2>/dev/null; }
# WEYV-LANE-BASE-1-BEGIN
# Per-repo default base. weyv uses the macos line: local refs/heads/macos, or
# refs/remotes/weyv-cloud/macos when that ref is a newer descendant. Missing
# local macos fails closed. Phantom and every other repo keep origin/HEAD
# (full remotes/origin/HEAD refname, same FETCHLOCK-1 rule as before).
# stdout: sha. stderr: reason on failure. return 0/1.
# Call: resolve_repo_base <repo> <repo-path>
# BASE_OVERRIDE is applied by the caller, not here.
resolve_repo_base() {
  local repo=$1 rp=$2 def sha local_macos cloud_macos
  case "$repo" in
    weyv)
      local_macos=$(git -C "$rp" rev-parse --verify -q refs/heads/macos) || {
        echo "REFUSED: weyv base refs/heads/macos missing" >&2
        return 1
      }
      [ -n "$local_macos" ] || { echo "REFUSED: weyv base refs/heads/macos missing" >&2; return 1; }
      cloud_macos=$(git -C "$rp" rev-parse --verify -q refs/remotes/weyv-cloud/macos 2>/dev/null || true)
      if [ -n "$cloud_macos" ] && git -C "$rp" merge-base --is-ancestor "$local_macos" "$cloud_macos" 2>/dev/null; then
        printf '%s\n' "$cloud_macos"
        return 0
      fi
      printf '%s\n' "$local_macos"
      return 0
      ;;
    *)
      def=$(git -C "$rp" symbolic-ref -q refs/remotes/origin/HEAD | sed 's#^refs/remotes/origin/##')
      def=${def:-main}
      sha=$(git -C "$rp" rev-parse --verify -q "refs/remotes/origin/$def") || return 1
      [ -n "$sha" ] || return 1
      printf '%s\n' "$sha"
      return 0
      ;;
  esac
}
# Per-job weyv sandbox params. Non-weyv jobs get a /private/var/empty sentinel
# that is not a prefix of any home path. weyv: this job's worktree git dir,
# this job's report/metrics subpaths, the common objects dir (see profile),
# and LITERAL paths for this job's branch ref/reflog and their .lock files.
# Never opens bin/, queue/, secrets, ~/.codex* or the keychain.
_sb_d_apply() {
  SB_D=(
    -D WEYV_GIT_WT="$WEYV_GIT_WT"
    -D WEYV_REPORT="$WEYV_REPORT"
    -D WEYV_METRICS="$WEYV_METRICS"
    -D WEYV_METRICS_RO="$WEYV_METRICS_RO"
    -D WEYV_COMMON="$WEYV_COMMON"
    -D WEYV_OBJECTS="$WEYV_OBJECTS"
    -D WEYV_REF="$WEYV_REF"
    -D WEYV_REF_LOCK="$WEYV_REF_LOCK"
    -D WEYV_REFLOG="$WEYV_REFLOG"
    -D WEYV_REFLOG_LOCK="$WEYV_REFLOG_LOCK"
  )
}
weyv_lane_sandbox_params() {
  local none=/private/var/empty/ashlr-weyv-lane-none
  WEYV_GIT_WT=$none/git
  WEYV_REPORT=$none/report
  WEYV_METRICS=$none/metrics
  WEYV_METRICS_RO=$none/metrics-ro
  WEYV_COMMON=$none/common
  WEYV_OBJECTS=$none/objects
  WEYV_REF=$none/ref
  WEYV_REF_LOCK=$none/ref.lock
  WEYV_REFLOG=$none/reflog
  WEYV_REFLOG_LOCK=$none/reflog.lock
  _sb_d_apply
  [ "$REPO" = weyv ] || return 0
  case "$J" in
    ""|.*|*/*|*\\*) echo "REFUSED: weyv job id unsafe for sandbox paths" >&2; return 1;;
  esac
  [[ "$J" =~ ^[A-Za-z0-9._+-]{1,80}$ ]] || { echo "REFUSED: weyv job id unsafe for sandbox paths" >&2; return 1; }
  # Canonicalize with python (macOS has /bin/realpath, not /usr/bin/realpath).
  _canon() { /usr/bin/python3 -I -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"; }
  local common gd expect report metrics metrics_ro
  common=$(_canon "$HOME/src/weyv/.git") || { echo "REFUSED: weyv common git dir unreadable" >&2; return 1; }
  [ -n "$common" ] && [ -d "$common" ] || { echo "REFUSED: weyv common git dir unreadable" >&2; return 1; }
  gd=$(git -C "$WT" rev-parse --absolute-git-dir 2>/dev/null) || { echo "REFUSED: weyv worktree git dir unreadable" >&2; return 1; }
  gd=$(_canon "$gd") || { echo "REFUSED: weyv worktree git dir unreadable" >&2; return 1; }
  expect="$common/worktrees/$J"
  if [ "$gd" != "$expect" ]; then echo "REFUSED: weyv worktree git dir is not $expect" >&2; return 1; fi
  report="$HOME/.ashlr-runs/reports/weyv-polish/$J"
  metrics="$HOME/.ashlr-runs/export/weyv/$J"
  metrics_ro="$HOME/.ashlr-runs/export/weyv"
  mkdir -p -m 700 "$HOME/.ashlr-runs/reports/weyv-polish" "$HOME/.ashlr-runs/export/weyv" "$report" "$metrics" || {
    echo "REFUSED: cannot create weyv report/metrics dirs" >&2; return 1
  }
  report=$(_canon "$report") || { echo "REFUSED: weyv report path unreadable" >&2; return 1; }
  metrics=$(_canon "$metrics") || { echo "REFUSED: weyv metrics path unreadable" >&2; return 1; }
  metrics_ro=$(_canon "$metrics_ro") || { echo "REFUSED: weyv metrics parent unreadable" >&2; return 1; }
  [ "$metrics" = "$metrics_ro/$J" ] || { echo "REFUSED: weyv metrics path escaped export/weyv" >&2; return 1; }
  case "$report" in
    */.ashlr-runs/reports/weyv-polish/"$J") ;;
    *) echo "REFUSED: weyv report path escaped reports/weyv-polish" >&2; return 1;;
  esac
  # Job branch is always codex-bridge/<job> (the branch launch.sh creates).
  # Literal paths only; no prefix of another job's branch. Git updates a ref
  # by creating <ref>.lock (and the same for the reflog), then renaming.
  WEYV_COMMON=$common
  WEYV_OBJECTS=$common/objects
  WEYV_REF=$common/refs/heads/codex-bridge/$J
  WEYV_REF_LOCK=$WEYV_REF.lock
  WEYV_REFLOG=$common/logs/refs/heads/codex-bridge/$J
  WEYV_REFLOG_LOCK=$WEYV_REFLOG.lock
  WEYV_OBJECTS=$(_canon "$WEYV_OBJECTS") || { echo "REFUSED: weyv objects dir unreadable" >&2; return 1; }
  [ "$WEYV_OBJECTS" = "$common/objects" ] || { echo "REFUSED: weyv objects path escaped the common dir" >&2; return 1; }
  WEYV_REF=$(_canon "$WEYV_REF") || { echo "REFUSED: weyv ref path unreadable" >&2; return 1; }
  WEYV_REFLOG=$(_canon "$WEYV_REFLOG") || { echo "REFUSED: weyv reflog path unreadable" >&2; return 1; }
  [ "$WEYV_REF" = "$common/refs/heads/codex-bridge/$J" ] || { echo "REFUSED: weyv ref path is not this job's branch" >&2; return 1; }
  [ "$WEYV_REFLOG" = "$common/logs/refs/heads/codex-bridge/$J" ] || { echo "REFUSED: weyv reflog path is not this job's branch" >&2; return 1; }
  WEYV_REF_LOCK=$WEYV_REF.lock
  WEYV_REFLOG_LOCK=$WEYV_REFLOG.lock
  WEYV_GIT_WT=$gd
  WEYV_REPORT=$report
  WEYV_METRICS=$metrics
  WEYV_METRICS_RO=$metrics_ro
  _sb_d_apply
}
# Append gc.auto=0 onto the launch env E for weyv lanes, using
# GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n. If a count
# is already present in E, increment it and use the next index. Non-weyv
# jobs leave E unchanged.
weyv_lane_git_config() {
  [ "$REPO" = weyv ] || return 0
  local i n=0 idx=-1
  for i in "${!E[@]}"; do
    case "${E[$i]}" in
      GIT_CONFIG_COUNT=*)
        n=${E[$i]#GIT_CONFIG_COUNT=}
        idx=$i
        ;;
    esac
  done
  case "$n" in
    ''|*[!0-9]*) n=0 ;;
  esac
  if [ "$idx" -ge 0 ]; then
    E[$idx]="GIT_CONFIG_COUNT=$((n + 1))"
  else
    E+=("GIT_CONFIG_COUNT=$((n + 1))")
  fi
  E+=("GIT_CONFIG_KEY_${n}=gc.auto" "GIT_CONFIG_VALUE_${n}=0")
}
# WEYV-LANE-BASE-1-END
# Masbot 03:25: agent stdio is piped through cat because the sandbox denies ~/.ashlr-runs and node aborts at init on a stdio fd there; git steps hold a per-repo lock; an existing worktree for the job is reused
unset NODE_OPTIONS NODE_PATH OPENSSL_CONF ELECTRON_RUN_AS_NODE; export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
set -o pipefail
J=$1; REPO=$2; POOL=$3; TIER=${4:-${TIER:-work}}; R=~/.ashlr-runs; RP=~/Projects/ashlrai/$REPO; WT=~/Projects/ashlrai/wt/$J
# DEVIN-ACP-SUBLANES-1: map known repo aliases (weyv -> ~/src/weyv; phantom unchanged).
# Unknown repos keep the ashlrai path above. Helper missing -> no change.
if [ -f "$R/bin/devin_acp_sublanes.py" ] && [ ! -L "$R/bin/devin_acp_sublanes.py" ]; then
  _RR=$(/usr/bin/python3 -I "$R/bin/devin_acp_sublanes.py" repo-root "$REPO" "$HOME" 2>/dev/null || true)
  case "$_RR" in /*) RP="$_RR";; esac
  unset _RR
fi
~/.ashlr-runs/bin-locus-new/locus status >/dev/null 2>&1 || true   # rev1.4: WARN dropped (the pin lives in the locus-ashlr tmux session, not visible from launch; it was always false here)
# RQ-CLOSE-NOWT (Masbot 18:55 Oct 27): CLOSE-* jobs only need gh, so their worktree is index-only: --no-checkout, then
# read-tree + skip-worktree so git status/diff stay clean with no files on disk. No node_modules copy. No repo config change.
NOWT=0; NA=; case "$J" in RQ-CLOSE-*|CLOSE-*) NOWT=1; NA=--no-checkout;; esac
# RQ-FINISH-SIGNAL: each lane's background group writes the AGENT's exit status (PIPESTATUS[0], not scrub's) to $Q/run/<J>.rc, tmp then mv
rm -f "$R/queue/run/$1.rc"; rcw(){ local t="$R/queue/run/$J.rc.tmp.$BASHPID"; printf '%d\n' "$1" > "$t" 2>/dev/null && mv -f "$t" "$R/queue/run/$J.rc"; }
[ -e $R/HOLD ] && grep -qx "$POOL" $R/HOLD && { echo "HELD: launches paused (security)"; exit 3; }
# DEVIN_STOP (sec): fail closed if stop file / fleet KILL / runs KILL (helper check).
case "$POOL" in
  devin|devin-flash)
    DOS=$(/usr/bin/python3 -I "$R/bin/devin-overage-stop.py" check); _ds=$?
    [ "$_ds" -eq 0 ] || { echo "${DOS:-HELD: DEVIN_STOP}"; exit 3; }
    unset DOS _ds
    ;;
esac
[ -e $R/PAUSE ] && { echo "PAUSED: Mac low on memory, swap or disk ($(cat $R/PAUSE)); memguard clears it"; exit 4; }
# >>> existing-branch handling (Masbot P0 10:19 PM): stale codex-bridge/<job> branches blocked relaunch
# prep_branch <repo-path> <branch> : prints NEW | REUSE | DELETED_STALE | BRANCH_IN_WORKTREE <path>
# Never removes or prunes worktrees; deletes only a branch with no worktree and no unpublished commits.
prep_branch() {
  local rp=$1 br=$2 wt n
  git -C "$rp" show-ref --verify -q "refs/heads/$br" || { echo NEW; return 0; }
  wt=$(git -C "$rp" worktree list --porcelain | awk -v b="branch refs/heads/$br" '/^worktree /{w=substr($0,10)} $0==b{print w; exit}')
  [ -n "$wt" ] && { echo "BRANCH_IN_WORKTREE $wt"; return 0; }
  n=$(git -C "$rp" rev-list --count "$br" --not --remotes) || return 1
  [ "$n" -gt 0 ] && { echo REUSE; return 0; }
  git -C "$rp" branch -D -q "$br" >/dev/null || return 1
  echo DELETED_STALE
}
# <<< existing-branch handling
L=$R/.lock-$REPO; n=0; until mkdir $L 2>/dev/null; do sleep 1; n=$((n+1)); [ $n -gt 300 ] && rm -rf $L; done; trap "rmdir $L 2>/dev/null" EXIT
if [ -e $WT/.git ]; then BASE=$(git -C $WT rev-parse HEAD); echo "$BASE codex-bridge/$J $WT $POOL" > $R/$J.base; rmdir $L; else
/usr/bin/lockf -k -t 180 "$RP/.git/ashlr-fetch.lock" git -C $RP fetch -q origin || exit 1   # FETCHLOCK-1: serialize shared-clone fetch (ref lock race 18:12 ET Nov 10)
if [ -n "${BASE_OVERRIDE:-}" ]; then BASE=$BASE_OVERRIDE; else BASE=$(resolve_repo_base "$REPO" "$RP") || exit 1; fi
[ -z "$BASE" ] && exit 1
echo "$BASE codex-bridge/$J $WT $POOL" > $R/$J.base
PB=$(prep_branch $RP codex-bridge/$J) || exit 1
case "$PB" in
  BRANCH_IN_WORKTREE*) echo "SKIPPED: BRANCH_IN_WORKTREE codex-bridge/$J is checked out at ${PB#BRANCH_IN_WORKTREE } (not relaunching)"; rm -f $R/$J.base; exit 5;;
  REUSE) echo "REUSE_BRANCH codex-bridge/$J has unpublished commits; continuing it"; git -C $RP worktree add -q $NA $WT codex-bridge/$J || exit 1
         BASE=$(git -C $WT rev-parse HEAD); echo "$BASE codex-bridge/$J $WT $POOL" > $R/$J.base;;
  *) [ "$PB" = DELETED_STALE ] && echo "DELETED_STALE_BRANCH codex-bridge/$J (no worktree, no unpublished commits)"
     git -C $RP worktree add -q $NA -b codex-bridge/$J $WT $BASE || exit 1;;
esac
rmdir $L; fi
if [ "$NOWT" = 1 ]; then [ -n "$(ls -A $WT | grep -vx .git)" ] || { git -C $WT read-tree HEAD && git -C $WT ls-files -z | xargs -0 git -C $WT update-index --skip-worktree; } || exit 1; else
[ -d $RP/node_modules ] && [ ! -e $WT/node_modules ] && cp -cR $RP/node_modules $WT/node_modules 2>/dev/null; git -C $WT ls-files -v | grep "^S" | cut -c3- | xargs -I{} git -C $WT update-index --no-skip-worktree {} 2>/dev/null
fi
{ cat; cat <<'F'

RULES: You are working in a fresh git worktree of ashlrai/REPO_ at its default branch. Work autonomously to a complete, tested, shippable change; be ambitious and high-leverage, and delete dead code you find in the area you touch. Add or update tests and run the repo's typecheck, lint and the touched tests (use a temporary HOME for any test run, e.g. HOME=$(mktemp -d); for cargo keep RUSTUP_HOME/CARGO_HOME pointing at the real toolchain). Never weaken, skip or delete tests to go green, and never weaken security controls. Without a security pass, do not add widened workflow permissions or id-token, new secrets.* refs, pull_request_target or workflow_run triggers, or third-party actions not pinned to a 40-hex commit SHA; other .github/**, CODEOWNERS and release config edits are allowed. Never print secrets or tokens. Do NOT commit, push, tag or publish: leave every change uncommitted in the worktree. When done, write BRIDGE_NOTES.md at the worktree root with a summary, commands run, pass/fail counts and net LOC. Mac release scripts (~/.ashlr-runs/bin/release-autorun.sh, bin/release-sign.sh, release-sign/standing-authority and their LaunchAgents ai.ashlr.release-autorun and similar) change only through a Security pin. No operator lane installs a repo copy (contrib/mac/*) over the live one.
F
[ "$NOWT" = 1 ] && echo "NOTE: this worktree is index-only (no files on disk, by design). Read files with git show HEAD:<path>. Do not change code; this job only decides and closes PRs."
[ "$REPO" = weyv ] && echo "NOTE: this weyv worktree is based on the macos line (local macos, or weyv-cloud/macos if that ref is a newer descendant), not origin/HEAD or main."
} | sed "s/REPO_/$REPO/" > $R/$J.prompt
cd $WT
weyv_lane_sandbox_params || exit 5   # WEYV-LANE-BASE-1: per-job sandbox params (sentinels for non-weyv)
case $POOL in codex-local) FAM=codex-local; DM=fast;; codex*) FAM=codex; DM=gpt-6.1-sol;; claude) FAM=claude; DM=opus;; claude-api) FAM=claude-api; DM=sonnet;; gemini) FAM=gemini; DM=gemini-2.5-pro;; zai) FAM=zai; DM=glm-5.3;; agy) FAM=agy; DM=gemini-3.8-flash-high;; grok) FAM=grok; DM=grok-4.7;; cursor) FAM=cursor; DM=auto;; devin-flash) FAM=devin-flash; DM=swe-2-flash-medium;; *) FAM=$POOL; DM=swe-2-max;; esac
M=$(python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));p,f,t=sys.argv[2:5];print(next((str(d[k]) for k in (p+"."+t,p,f+"."+t,f) if d.get(k)),""))' "$R/models.json" "$POOL" "$FAM" "$TIER" 2>/dev/null); [[ "$M" =~ ^[A-Za-z0-9._-]+$ ]] || M=$DM; EF=$(python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));p,f,t=sys.argv[2:5];print(d.get("effort."+p+"."+t) or d.get("effort."+f+"."+t) or "")' "$R/models.json" "$POOL" "$FAM" "$TIER" 2>/dev/null); [[ -z "$EF" || "$EF" =~ ^[a-z]+$ ]] || EF=   # RQ-TERA-LANE: lane key ($POOL.$TIER, $POOL) before family key; args via argv
# DEVIN-FLASH-LANE-1: never default to swe-2-max. Re-check official cost_tier
# immediately before launch (fail closed: not Free, unreadable, lightning,
# ended promo after 2026-12-01T05:00Z, or missing helper). Local only; no --cloud path exists here.
if [ "$POOL" = devin-flash ]; then
  if [ ! -f "$R/bin/devin_flash_lane.py" ] || [ -L "$R/bin/devin_flash_lane.py" ]; then
    echo "REFUSED: devin-flash helper missing"; exit 5
  fi
  _FG=$(/usr/bin/python3 -I "$R/bin/devin_flash_lane.py" check-launch "$M"); _fg=$?
  [ "$_fg" -eq 0 ] || { echo "${_FG:-REFUSED: devin-flash gate failed}"; exit 5; }
  unset _FG _fg
fi

# FABLE52-ORCH rev1 (over FABLE-STOP-BROKER ebc24737 / FABLE52-SHARE-sec):
# claude subscription pool only, never claude-api.
# Fable picks require ALL of: mode $R/fable-mode exact 'orchestrator' (absent/'off'/other = off);
# share clamp $R/fable-share exact decimal 0-50 (O_NOFOLLOW/fstat; else 0); pace $R/fable-pace
# exact 'allow' or decimal permits 1-9999 ('hold', 0, absent, parse error = hold); role
# eligibility (TIER=frontier, or job-id/class token leader|ceo|triage|intent|design|bottleneck|
# review|decompose|orch or security-design, or attempt>=3 / failed-twice from queue/run sidecars);
# and hard clamp POSIX cksum(jobid)%100 < share on every Fable pick.
# KILL and queue/FABLE_STOP override everything, fail closed (unreadable parent or any existing
# path, including a symlink, counts as stop). Picks log: O_APPEND|O_NOFOLLOW, job id allowlisted.
# No credential, broker, sandbox or network change. CB_SHA stays 31bf10dd until a broker-rev2 pin.
# This file never creates fable-share, fable-mode or fable-pace.
if [ "$POOL" = claude ]; then
  _fm=$(/usr/bin/python3 -I - "$HOME" "$R" "$J" "$M" "$TIER" <<'PY'
import os, re, stat, subprocess, sys, time
home, runs, job, model = sys.argv[1:5]
tier = sys.argv[5] if len(sys.argv) > 5 else ""
def emit(m):
  if isinstance(m, str) and re.fullmatch(r"[A-Za-z0-9._-]+", m):
    print(m)
  else:
    print(model if isinstance(model, str) and re.fullmatch(r"[A-Za-z0-9._-]+", model) else "opus")
  raise SystemExit(0)

def stopped(path):
  parent = os.path.dirname(path)
  try:
    os.lstat(parent)
  except FileNotFoundError:
    return False
  except OSError:
    return True
  if not os.access(parent, os.R_OK | os.X_OK):
    return True
  try:
    os.lstat(path)
    return True
  except FileNotFoundError:
    return False
  except OSError:
    return True

uid = os.getuid()
if stopped(os.path.join(home, ".ashlr", "KILL")) or stopped(os.path.join(runs, "queue", "FABLE_STOP")):
  emit(model)

def read_ctl(path, max_size=16):
  try:
    st = os.lstat(path)
    if not (stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_uid == uid and 0 < st.st_size <= max_size):
      return None
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
      fs = os.fstat(fd)
      if not (stat.S_ISREG(fs.st_mode) and fs.st_nlink == 1 and fs.st_uid == uid
              and 0 < fs.st_size <= max_size and (fs.st_dev, fs.st_ino) == (st.st_dev, st.st_ino)):
        return None
      return os.read(fd, max_size).decode("ascii", "replace").strip()
    finally:
      os.close(fd)
  except OSError:
    return None

mode = read_ctl(os.path.join(runs, "fable-mode"))
if mode != "orchestrator":
  emit(model)

share = 0
raw_share = read_ctl(os.path.join(runs, "fable-share"))
if raw_share is not None and re.fullmatch(r"0|[1-9][0-9]?", raw_share):
  n = int(raw_share, 10)
  if 0 <= n <= 50:
    share = n
if share <= 0:
  emit(model)

pace = read_ctl(os.path.join(runs, "fable-pace"))
pace_ok = False
if pace == "allow":
  pace_ok = True
elif pace is not None and re.fullmatch(r"[1-9][0-9]{0,3}", pace):
  pace_ok = True
if not pace_ok:
  emit(model)

role = None
if isinstance(tier, str) and tier == "frontier":
  role = "frontier"

ORCH_TOKS = {"LEADER", "CEO", "TRIAGE", "INTENT", "BOTTLENECK", "DECOMPOSE", "DECOMP", "ORCH", "DESIGN", "REVIEW"}
CLASS_EXACT = {"leader", "ceo", "triage", "intent", "design", "bottleneck", "review", "decompose", "orch", "security-design"}

def job_ok(j):
  return isinstance(j, str) and re.fullmatch(r"[A-Za-z0-9._+-]{1,80}", j)

def job_role(j):
  if not isinstance(j, str):
    return None
  parts = [p for p in re.split(r"[-_]", j.upper()) if p]
  if "SECDESIGN" in parts or "SECURITYDESIGN" in parts:
    return "security-design"
  for i in range(len(parts) - 1):
    if parts[i] in ("SEC", "SECURITY") and parts[i + 1] == "DESIGN":
      return "security-design"
  if any(p in ORCH_TOKS for p in parts):
    return "id"
  return None

if role is None:
  jr = job_role(job)
  if jr:
    role = jr

if role is None and job_ok(job):
  rundir = os.path.join(runs, "queue", "run")
  rawc = read_ctl(os.path.join(rundir, job + ".class"), 32)
  if rawc is not None and rawc in CLASS_EXACT:
    role = "security-design" if rawc == "security-design" else "class"
  if role is None:
    rawy = read_ctl(os.path.join(rundir, job + ".yield"), 4096)
    if rawy is not None:
      toks = [t for t in rawy.split() if t in ("0", "1")]
      if sum(1 for t in toks if t == "0") >= 2:
        role = "attempt"
  if role is None:
    rawl = read_ctl(os.path.join(rundir, job + ".launches"), 4096)
    if rawl is not None:
      n = 0
      for x in rawl.split():
        try:
          float(x)
          n += 1
        except ValueError:
          continue
      if n >= 2:
        role = "attempt"

if role is None:
  emit(model)

try:
  r = subprocess.run(["/usr/bin/cksum"], input=job.encode("utf-8", "surrogateescape"),
                     capture_output=True, timeout=5)
  bucket = int(r.stdout.split()[0], 10) % 100
except Exception:
  emit(model)
if bucket >= share:
  emit(model)

job_s = job if job_ok(job) else "invalid"
role_s = role if isinstance(role, str) and re.fullmatch(r"[a-z0-9-]{1,32}", role) else "id"
line = "%s FABLE52 pick job=%s bucket=%d share=%d mode=orchestrator role=%s\n" % (
    time.strftime("%Y-%m-%dT%H:%M:%S"), job_s, bucket, share, role_s)
logp = os.path.join(runs, "fable52-picks.log")
try:
  fd = os.open(logp, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
  try:
    fs = os.fstat(fd)
    if stat.S_ISREG(fs.st_mode) and fs.st_uid == uid:
      os.write(fd, line.encode("ascii"))
  finally:
    os.close(fd)
except OSError:
  pass
emit("claude-fable-5-2")
PY
  ) || _fm="$M"
  if [[ "$_fm" =~ ^[A-Za-z0-9._-]+$ ]]; then
    if [ "$_fm" = claude-fable-5-2 ]; then
      # EO: tag Fable picks so dispatchd can copy a sub-lane into jobs.jsonl / resource bar.
      # launch.sh does not write metrics/jobs.jsonl (dispatchd.metric owns that file).
      # Security FF: allowlist $J before any write to $R/$J.base.meta.
      if [[ "$J" =~ ^[A-Za-z0-9._+-]{1,80}$ ]]; then
        printf '%s\n' 'SUBLANE claude:fable' >> "$R/$J.base.meta"
      fi
    fi
    M="$_fm"
  fi
  unset _fm
fi
# MODEL line is after the Fable override so base.meta records the model actually used.
# Security FF: same job-id allowlist before the MODEL append.
if [[ "$J" =~ ^[A-Za-z0-9._+-]{1,80}$ ]]; then
  echo "MODEL $POOL $TIER $M ${EF:-default}" >> "$R/$J.base.meta"
fi
# RQ-SEC-RUNLOG-SCRUB: env allowlist (real HOME kept so codex/devin find auth; CODEX_HOME passed only as the lane uses it) + scrubbed log
E=(env -i HOME="$HOME" CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0 PATH="$PATH" TERM=xterm-256color LANG=en_US.UTF-8 USER="$USER" LOGNAME="$USER" TMPDIR="$TMPDIR" ${PHANTOM_SESSION_KEYS:+PHANTOM_SESSION_KEYS="$PHANTOM_SESSION_KEYS"}); SCRUB="perl $R/bin/scrub.pl"
weyv_lane_git_config   # WEYV-LANE-BASE-1: gc.auto=0 for weyv lanes
# >>> LANE-MCP rev1 (Security 2026-11-03): one shared credential-free MCP set for every lane (context7 remote HTTPS + safe-fetch stdio
# with an SSRF guard). No keys, headers or env in any of these files; ~/.lane-mcp is write-denied in every .sb; each file is sha-checked here.
LM=$HOME/.lane-mcp; LM_SF=a71d18094c6a4989f8d1f5df027567e90a1416d03ec409ef5d2ea5c002a6c2ecf; LM_MJ=ac8f015184e214e3831dfb7aef35a3f67d645b8147e1fb6015946d7eef850de2f
lm_ok(){ local f=$1 want=$2; [ -d "$LM" ] && [ ! -L "$LM" ] && [ -O "$LM" ] && [ ! -L "$LM/safe-fetch.py" ] && [ "$(shasum -a 256 "$LM/safe-fetch.py" | cut -d' ' -f1)" = "${LM_SF#a}" ] \
  && [ -f "$f" ] && [ ! -L "$f" ] && [ "$(stat -f %Lp "$f")" = 444 ] && [ "$(shasum -a 256 "$f" | cut -d' ' -f1)" = "${want#a}" ] || { echo "REFUSED: lane MCP file $f missing, not 444 or sha mismatch"; exit 5; }; }
LMC=(-c 'mcp_servers.context7.url="https://mcp.context7.com/mcp"' -c 'mcp_servers.fetch.command="/usr/bin/python3"' -c "mcp_servers.fetch.args=[\"-I\",\"$LM/safe-fetch.py\"]")
# <<< LANE-MCP rev1
# Native lanes have no API pacing reservation. A fresh kernel check follows
# their last existing preflight and runs synchronously before background spawn.
native_pressure_ok(){
  local f="$R/bin/host_pressure_admission.py" want=6b2e87df1253fbf501a31553562293e26862871b30d9823a5c87a4fe3ed15e80
  local o="$R/bin/host_session_observation.py" owant=dfee0279acfa7f20bc93ce743c4afcc6581fb3f42f0cf62675c41a9513ef40de
  [ -f "$o" ] && [ ! -L "$o" ] && [ -O "$o" ] && [ "$(shasum -a 256 "$o" | cut -d' ' -f1)" = "$owant" ] && [ -f "$f" ] && [ ! -L "$f" ] && [ -O "$f" ] && [ "$(shasum -a 256 "$f" | cut -d' ' -f1)" = "$want" ] && /usr/bin/python3 -I "$f" || { echo "HELD: fresh kernel pressure unavailable or unsafe"; return 3; }
}
# >>> LOCALBUILD rev1 (Security 2026-11-03; Mason 9:22 and 9:24 PM ET): RQ-APP-LOCALBUILD job ids run the repo's own unsigned nightly
# desktop build (scripts/build-desktop-nightly.mjs) deterministically, with no agent and whatever pool was picked, under localbuild.sb.
# Network ON (Mason 9:24 PM). Toolchain is the provisioned, sha-verified ~/.localbuild-lane/tool/v1 (provision-localbuild.sh, run by Masbot
# outside any sandbox); its MANIFEST sha is checked here. No signing: keychain, security, codesign, notarytool and productsign stay denied.
if [[ "$J" =~ ^RQ-APP-LOCALBUILD(-[A-Za-z0-9]+)?$ ]]; then
  LBD=$HOME/.localbuild-lane; LBT=$LBD/tool/v1; LSB=$R/bin/localbuild.sb; LSB_SHA=$(pinsha localbuild.sb)
  LBM_SHA=27c0f1e6b47c0dae53ec1a7f8c1f25d1d866fe7ad30f8225f344300466c34c55; ART=$R/artifacts/$J
  [ "$REPO" = phantom ] || { echo "HELD: localbuild only builds ashlrai/phantom"; exit 3; }
  { [ -f "$LSB" ] && [ ! -L "$LSB" ] && [ "$(shasum -a 256 "$LSB" | cut -d' ' -f1)" = "$LSB_SHA" ]; } || { echo "REFUSED: localbuild.sb missing or sha mismatch"; exit 5; }
  { [ -d "$LBD" ] && [ ! -L "$LBD" ] && [ -O "$LBD" ] && [ "$(stat -f %Lp "$LBD")" = 700 ] && [ -d "$LBT" ] && [ ! -L "$LBT" ] && [ -f "$LBT/MANIFEST" ] && [ ! -L "$LBT/MANIFEST" ] \
    && [ "$(shasum -a 256 "$LBT/MANIFEST" | cut -d' ' -f1)" = "$LBM_SHA" ]; } || { echo "HELD: localbuild toolchain v1 not provisioned or MANIFEST mismatch"; exit 3; }
  mkdir -p -m 700 "$R/artifacts" "$ART" "$LBD/home" "$LBD/cache/npm" "$LBD/cache/cargo" || exit 1
  [ ! -L "$ART" ] && [ ! -L "$WT" ] || { echo "REFUSED: localbuild symlinked path"; exit 5; }
  echo "LOCALBUILD $J toolchain=v1" >> "$R/$J.base.meta"
  { nohup env -i HOME="$LBD/home" PATH="$LBT/bin:/usr/bin:/bin:/usr/sbin:/sbin" TERM=xterm-256color LANG=en_US.UTF-8 USER="$USER" LOGNAME="$USER" TMPDIR="$TMPDIR" \
      CI=true CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0 CARGO_HOME="$LBD/cache/cargo" npm_config_cache="$LBD/cache/npm" npm_config_update_notifier=false \
      sandbox-exec "${SB_D[@]}" -D WT="$WT" -D ART="$ART" -f "$LSB" "$LBT/bin/node" scripts/build-desktop-nightly.mjs --out "$ART" </dev/null 2>&1 | $SCRUB > "$R/$J.log"; rcw "${PIPESTATUS[0]}"; } &
  echo "launched $J localbuild pid $! base ${BASE:0:9}"; exit 0
fi
# <<< LOCALBUILD rev1
# >>> DEVIN-UNIFY-1-SURFACE
# Per-job surface: cloud|local|auto. Phantom-side only. Official CLI --cloud
# has no env var (https://docs.devin.ai/cli/reference/commands).
devin_unify_norm() {
  printf '%s' "$1" | /usr/bin/tr '[:upper:]' '[:lower:]' | /usr/bin/tr -d ' \t\r\n'
}
devin_unify_read_regular() {
  local p="$1"
  [ -n "$p" ] && [ -f "$p" ] && [ ! -L "$p" ] || return 1
  /usr/bin/head -c 64 "$p" 2>/dev/null
}
devin_unify_requested_surface() {
  local s="" line sixth tok
  s=$(devin_unify_norm "${DEVIN_SURFACE:-}")
  if [ -z "$s" ]; then
    if s=$(devin_unify_read_regular "$R/queue/run/$J.surface"); then
      s=$(devin_unify_norm "$s")
    else
      s=""
    fi
  fi
  if [ -z "$s" ] && [ -f "$R/queue/run/$J.line" ] && [ ! -L "$R/queue/run/$J.line" ]; then
    line=$(/usr/bin/head -n 1 "$R/queue/run/$J.line" 2>/dev/null || true)
    sixth=$(printf '%s' "$line" | /usr/bin/awk -F'\t' 'NF>=6 {print $6}')
    s=$(devin_unify_norm "$sixth")
    if [ -z "$s" ]; then
      tok=$(printf '%s' "$line" | /usr/bin/tr '\t' ' ' | /usr/bin/sed -n 's/.*DEVIN_SURFACE=\([^[:space:]]*\).*/\1/p')
      s=$(devin_unify_norm "$tok")
    fi
  fi
  case "$s" in
    cloud|local|auto) printf '%s' "$s" ;;
    "") printf 'auto' ;;
    *) printf 'invalid' ;;
  esac
}
devin_unify_job_size() {
  local s="" line tok
  s=$(devin_unify_norm "${DEVIN_SIZE:-${JOB_SIZE:-}}")
  if [ -z "$s" ]; then
    if s=$(devin_unify_read_regular "$R/queue/run/$J.size"); then
      s=$(devin_unify_norm "$s")
    else
      s=""
    fi
  fi
  if [ -z "$s" ] && [ -f "$R/queue/run/$J.line" ] && [ ! -L "$R/queue/run/$J.line" ]; then
    line=$(/usr/bin/head -n 1 "$R/queue/run/$J.line" 2>/dev/null || true)
    tok=$(printf '%s' "$line" | /usr/bin/awk -F'\t' 'NF>=7 {print $7}')
    s=$(devin_unify_norm "$tok")
    if [ -z "$s" ]; then
      tok=$(printf '%s' "$line" | /usr/bin/tr '\t' ' ' | /usr/bin/sed -n 's/.*[Ss][Ii][Zz][Ee]=\([^[:space:]]*\).*/\1/p')
      s=$(devin_unify_norm "$tok")
    fi
  fi
  case "$s" in
    s|m|l|xl|xxl) printf '%s' "$s" ;;
  esac
}
devin_unify_decide_surface() {
  # v3: cloud stays off. Auto is local (no phone/web visibility routing).
  # Official CLI (3000.11.3 and docs through 3000.12.17) has no stop/end
  # subcommand for a running cloud VM, and `devin list` is current-directory
  # only, so a cap cannot count persisted org-wide cloud sessions.
  local req dec reason size
  req=$(devin_unify_requested_surface)
  size=$(devin_unify_job_size)
  dec=local
  reason=auto-cloud-off-default
  case "$req" in
    cloud) dec=local; reason=explicit-cloud-blocked-no-official-stop ;;
    local) dec=local; reason=explicit-local ;;
    invalid) dec=local; reason=invalid-requested-fail-local ;;
    auto) dec=local; reason=auto-cloud-off-default ;;
  esac
  printf 'DEVIN_REQ=%s DEVIN_DECIDED_SURFACE=%s DEVIN_SURF_REASON=%s DEVIN_JOB_SIZE=%s\n' "$req" "$dec" "$reason" "${size:-none}"
}
# <<< DEVIN-UNIFY-1-SURFACE
case $POOL in
 codex-cmp) lm_ok "$LM/mcp.json" "$LM_MJ"; native_pressure_ok || exit 3; { nohup "${E[@]}" ${CODEX_HOME:+CODEX_HOME="$CODEX_HOME"} sandbox-exec "${SB_D[@]}" -f $R/bin/codex-cmp.sb codex exec -m $M ${EF:+-c model_reasoning_effort=$EF} "${LMC[@]}" -c web_search=live --sandbox danger-full-access -C $WT - < $R/$J.prompt 2>&1 | $SCRUB > $R/$J.log; rcw "${PIPESTATUS[0]}"; } & ;;
 codex-personal) lm_ok "$LM/mcp.json" "$LM_MJ"; lm_ok "$HOME/.codex-2/lane.config.toml" adfc46b45a74f9589e1f9a0de0ea758c2906a54c8d1e8b1e8f04291bb85e45e96   # APPS-ALLOWLIST rev1g: deny-by-default codex_apps profile
  native_pressure_ok || exit 3; { nohup "${E[@]}" CODEX_HOME="$HOME/.codex-2" sandbox-exec "${SB_D[@]}" -f $R/bin/codex-personal.sb codex exec -p lane -m $M ${EF:+-c model_reasoning_effort=$EF} "${LMC[@]}" -c web_search=live --sandbox danger-full-access -C $WT - < $R/$J.prompt 2>&1 | $SCRUB > $R/$J.log; rcw "${PIPESTATUS[0]}"; } & ;;
 claude) lm_ok "$LM/mcp.json" "$LM_MJ"   # >>> CLAUDE-BROKER rev1 (Security 2026-11-04)
  # The lane never holds a Claude credential: claude talks to the loopback broker with a dummy bearer; the broker (outside every
  # sandbox) injects the one fleet setup-token. claude-cli.sb now denies the keychain, /usr/bin/security and ~/.claude-fleet-broker.
  CB=$R/bin/claude-broker.py; CB_SHA=8d6d7c1a378bdce7f00cfa7e48271de521f1a1a27a9443599e9af2cd67813268; CBP=8790; CBU=http://127.0.0.1:$CBP
  { [ -f "$CB" ] && [ ! -L "$CB" ] && [ "$(shasum -a 256 "$CB" | cut -d' ' -f1)" = "$CB_SHA" ]; } || { echo "REFUSED: claude-broker.py missing or sha mismatch"; exit 5; }
  if ! /usr/bin/curl -s -m 2 -o /dev/null -I "$CBU/api/hello"; then
    ( umask 077; nohup /usr/bin/lockf -s -t 0 "$R/queue/run/claude-broker.lock" env -i HOME="$HOME" PATH=/usr/bin:/bin LANG=en_US.UTF-8 /usr/bin/python3 -I "$CB" --port $CBP \
        >> "$R/queue/run/claude-broker.log" 2>&1 < /dev/null & ); sleep 1
    /usr/bin/curl -s -m 2 -o /dev/null -I "$CBU/api/hello" || { echo "HELD: claude-broker not running (token not provisioned? see queue/run/claude-broker.log)"; exit 3; }
  fi
  { nohup "${E[@]}" ANTHROPIC_BASE_URL="$CBU" CLAUDE_CODE_OAUTH_TOKEN=ashlr-lane-dummy-not-a-credential CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
      sandbox-exec "${SB_D[@]}" -f $R/bin/claude-cli.sb claude -p --dangerously-skip-permissions --strict-mcp-config --mcp-config "$LM/mcp.json" --model $M < $R/$J.prompt 2>&1 | $SCRUB > $R/$J.log; rcw "${PIPESTATUS[0]}"; } & ;;   # <<< CLAUDE-BROKER rev1
 claude-api) # >>> claude-api lane (Mason 10:28 PM Oct 26): gifted + monthly Anthropic API credits, paced by claude-api.py
  # key: Phantom Secrets first (phantom exec injects it; the value never reaches this script), else a mode-600 user-owned
  # non-symlink key file read on fd 3 by the child itself (never on argv, never echoed or logged); neither -> HOLD exit 3
  umask 077
  KF=$R/bin/anthropic.key; KM=
  if command -v phantom >/dev/null 2>&1 && phantom list --json 2>/dev/null | grep -q '"ANTHROPIC_API_KEY"'; then KM=phantom
  elif [ -L "$KF" ]; then echo "HELD: anthropic.key refused (is a symlink)"; exit 3
  elif [ -f "$KF" ]; then
    KP=$(stat -c %a "$KF" 2>/dev/null || stat -f %Lp "$KF" 2>/dev/null)
    if [ -O "$KF" ] && [ "$KP" = 600 ] && [ -s "$KF" ]; then KM=file; else echo "HELD: anthropic.key refused (needs mode 600 and owned by $USER; is $KP)"; exit 3; fi
  fi
  # claude-org (Mason Nov 2): Console org OAuth login in ~/.claude-org bills the AshlrAI org API credits; preferred over keys
  # Security 2026-11-02 option (c): key copied Keychain->lane.key outside the sandbox by claude-org-token.sh; fd 3 only, never on argv or disk logs
  CO=$HOME/.claude-org; OKF=$CO/lane.key; [ -s "$OKF" ] || "$R/bin/claude-org-token.sh" >/dev/null 2>&1
  if [ ! -L "$OKF" ] && [ -O "$OKF" ] && [ "$(stat -f %Lp "$OKF")" = 600 ] && [ -s "$OKF" ]; then KM=org; fi
  [ -n "$KM" ] || { echo "HELD: no Anthropic API key (Phantom Secrets ANTHROPIC_API_KEY or $R/bin/anthropic.key)"; exit 3; }
  CAQ=$(python3 "$R/bin/claude-api.py" gate "$J" "$TIER" "$M"); [ $? -eq 0 ] || { echo "${CAQ:-HELD: claude-api gate failed}"; exit 3; }
  CAPOOL=${CAQ%% *}; M=${CAQ#* }
  [[ "$M" =~ ^[A-Za-z0-9._-]+$ && "$CAPOOL" =~ ^(gift|monthly)$ ]] || { echo "HELD: claude-api bad model or pool from gate"; rm -f "$R/queue/run/$J.api.reserve"; exit 3; }
  echo "CLAUDE_API $J pool=$CAPOOL model=$M key=$KM" >> "$R/$J.base.meta"
  lm_ok "$LM/mcp.json" "$LM_MJ"
  CMD=(sandbox-exec "${SB_D[@]}" -f "$R/bin/claude.sb" claude -p --dangerously-skip-permissions --strict-mcp-config --mcp-config "$LM/mcp.json" --model "$M" --output-format json)
  # stdout (the JSON result) and stderr both pass through scrub.pl before touching disk; the scrubbed JSON is deleted once
  # record has taken the cost fields, so no raw or scrubbed agent stdout persists under .ashlr-runs
  ( umask 077; : > "$R/$J.log"
    { { if [ $KM = org ]; then "${E[@]}" CLAUDE_CONFIG_DIR="$CO" /bin/bash -c 'unset CLAUDE_CODE_OAUTH_TOKEN; IFS= read -r ANTHROPIC_API_KEY <&3; exec 3<&-; export ANTHROPIC_API_KEY; exec "$@"' claude-api "${CMD[@]}" 3< "$OKF"
        elif [ $KM = phantom ]; then "${E[@]}" phantom exec -- env -u CLAUDE_CODE_OAUTH_TOKEN "${CMD[@]}"
        else "${E[@]}" /bin/bash -c 'unset CLAUDE_CODE_OAUTH_TOKEN; IFS= read -r ANTHROPIC_API_KEY <&3; exec 3<&-; export ANTHROPIC_API_KEY; exec "$@"' claude-api "${CMD[@]}" 3< "$KF"; fi \
          < "$R/$J.prompt" 2>&1 1>&4 4>&- | $SCRUB >> "$R/$J.log"; rcw "${PIPESTATUS[0]}"; } 4>&1 | $SCRUB > "$R/$J.api.json"; }
    python3 "$R/bin/claude-api.py" record "$J" "$TIER" "$M" "$CAPOOL" "$R/$J.api.json" 2>&1 | $SCRUB >> "$R/$J.log"
    rm -f "$R/$J.api.json" ) </dev/null >/dev/null 2>&1 &
  ;; # <<< claude-api lane
 codex-local) # >>> RQ-LOCAL-LANE: Codex CLI -> oMLX loopback proxy (it injects the key; the job never sees one). No API key is passed:
  # the omlx provider has no env_key, so codex sends no Authorization header. Profile codex-local.sb is sha-pinned; mismatch refuses.
  # rev1.2: ~/.codex-local has no config.toml; the provider is defined and selected entirely by -c flags here (keys per codex
  # ModelProviderInfo: name, base_url, wire_api=responses; requires_openai_auth=false -> unauthenticated, no env_key).
  LSB=$R/bin/codex-local.sb; LSB_SHA=$(pinsha codex-local.sb)
  { [ -f "$LSB" ] && [ ! -L "$LSB" ] && [ "$(shasum -a 256 "$LSB" | cut -d' ' -f1)" = "$LSB_SHA" ]; } || { echo "REFUSED: codex-local.sb missing or sha mismatch"; exit 5; }
  case "$M" in fast|strong) ;; *) echo "HELD: bad codex-local model"; exit 3;; esac
  curl -sf -m 2 --noproxy '*' http://127.0.0.1:8123/v1/models >/dev/null || { echo "HELD: codex-local unhealthy"; exit 3; }
  { nohup "${E[@]}" CODEX_HOME="$HOME/.codex-local" HF_HUB_OFFLINE=1 env -u PHANTOM_SESSION_KEYS sandbox-exec "${SB_D[@]}" -f "$LSB" codex exec "${LMC[@]}" \
   -c model_provider=omlx -c 'model_providers.omlx.name="omlx"' -c 'model_providers.omlx.base_url="http://127.0.0.1:8123/v1"' \
   -c 'model_providers.omlx.wire_api="responses"' -c model_providers.omlx.requires_openai_auth=false -m "$M" --sandbox danger-full-access -C "$WT" - < $R/$J.prompt 2>&1 | $SCRUB > $R/$J.log; rcw "${PIPESTATUS[0]}"; } & ;;
  # <<< RQ-LOCAL-LANE
 gemini) # >>> GEMINI-LANE (Security rev1 2026-11-03): personal Google OAuth (Code Assist for individuals) only, paced by gemini-pace.py
  # E is env -i, so no GEMINI_API_KEY, GOOGLE_API_KEY, GOOGLE_GENAI_*, GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_CLOUD_PROJECT or Vertex var reaches
  # the CLI. The sha-pinned system settings (highest precedence in 0.66.0) enforce auth oauth-personal, usage stats and telemetry off, no local
  # .env, and no hooks, MCP, extensions or skills. SANDBOX=sandbox-exec stops the CLI relaunching its own sandbox and moves its runtime dir to
  # ~/.cache/.gemini; gemini.sb leaves only the oauth_creds.json refresh writable under ~/.gemini. Prompt goes on stdin, never argv.
  GSB=$R/bin/gemini.sb; GSB_SHA=$(pinsha gemini.sb)
  GSS=$HOME/.gemini-lane/system-settings.json; GSS_SHA=965931d4ed1eb078a5f3837440a9249044c44a375c57888f6a422075f7054803
  { [ -f "$GSB" ] && [ ! -L "$GSB" ] && [ "$(shasum -a 256 "$GSB" | cut -d' ' -f1)" = "$GSB_SHA" ]; } || { echo "REFUSED: gemini.sb missing or sha mismatch"; exit 5; }
  { [ -f "$GSS" ] && [ ! -L "$GSS" ] && [ "$(shasum -a 256 "$GSS" | cut -d' ' -f1)" = "$GSS_SHA" ]; } || { echo "REFUSED: gemini system settings missing or sha mismatch"; exit 5; }
  lm_ok "$GSS" "a$GSS_SHA"   # LANE-MCP rev1: gemini MCP servers live in the pinned system settings
  [ -f "$HOME/.gemini/oauth_creds.json" ] || { echo "HELD: gemini not signed in (personal OAuth)"; exit 3; }
  GQ=$(python3 "$R/bin/gemini-pace.py" gate "$J" "$TIER"); [ $? -eq 0 ] || { echo "${GQ:-HELD: gemini gate failed}"; exit 3; }
  # stdout (the JSON result) and stderr both pass through scrub.pl; record reads the stats, prints at most one fixed classifier line
  # (gemini-pace: quota_exhausted terminal|retryable, gemini-pace: auth_failed) for dispatchd AB_RX, then the JSON is deleted
  ( umask 077; : > "$R/$J.log"
    { { "${E[@]}" SANDBOX=sandbox-exec GEMINI_CLI_SYSTEM_SETTINGS_PATH="$GSS" GEMINI_CLI_TRUST_WORKSPACE=true GOOGLE_GENAI_USE_GCA=true \
          GEMINI_TELEMETRY_ENABLED=false GEMINI_FORCE_FILE_STORAGE=true sandbox-exec "${SB_D[@]}" -f "$GSB" gemini -p "" --approval-mode yolo --output-format json -m "$M" \
          < "$R/$J.prompt" 2>&1 1>&4 4>&- | $SCRUB >> "$R/$J.log"; rcw "${PIPESTATUS[0]}"; } 4>&1 | $SCRUB > "$R/$J.gemini.json"; }
    python3 "$R/bin/gemini-pace.py" record "$J" 0 "$R/$J.gemini.json" "$R/$J.log" 2>&1 | $SCRUB >> "$R/$J.log"
    /usr/bin/python3 -I "$R/bin/job_usage.py" extract "$R/$J.gemini.json" "$R/$J.usage.json" 2>/dev/null || true
    rm -f "$R/$J.gemini.json" ) </dev/null >/dev/null 2>&1 &
  ;; # <<< gemini lane
 zai) # >>> ZAI-LANE rev1 (Security 2026-11-03): Z.ai GLM Coding Plan Lite via Claude Code, paced by zai-pace.py
  # E is env -i: no ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, other provider key or base URL is inherited. The base URL and model ids
  # are literals here; nothing from the queue, models.json or env can change them. The key is read on fd 3 by the child bash right
  # before exec (never argv, never a shell var in this script, never logged). Only --setting-sources user is loaded, from the
  # sha-pinned settings.json in the lane's own CLAUDE_CONFIG_DIR, so a repo's .claude/settings.json cannot set env or hooks.
  ZD=$HOME/.zai-lane; KF=$ZD/api_key; ZC=$ZD/claude; ZSB=$R/bin/zai.sb; ZSB_SHA=$(pinsha zai.sb); ZST=$ZC/settings.json; ZST_SHA=3a85cc369f6cd3b30a20b7ec596117c92866d6782233369d5fe7a66bf8554bfb
  { [ -f "$ZSB" ] && [ ! -L "$ZSB" ] && [ "$(shasum -a 256 "$ZSB" | cut -d' ' -f1)" = "$ZSB_SHA" ]; } || { echo "REFUSED: zai.sb missing or sha mismatch"; exit 5; }
  { [ -f "$ZST" ] && [ ! -L "$ZST" ] && [ "$(shasum -a 256 "$ZST" | cut -d' ' -f1)" = "$ZST_SHA" ]; } || { echo "REFUSED: zai settings.json missing or sha mismatch"; exit 5; }
  { [ -d "$ZD" ] && [ ! -L "$ZD" ] && [ -O "$ZD" ] && [ "$(stat -f %Lp "$ZD")" = 700 ] && [ -f "$KF" ] && [ ! -L "$KF" ] && [ -O "$KF" ] && [ "$(stat -f %Lp "$KF")" = 600 ] && [ -s "$KF" ]; } || { echo "HELD: zai api_key refused (needs dir 700, file 600, owned by $USER)"; exit 3; }
  case "$TIER" in fast) M=glm-5.3-flash; ZT=40;; work) M=glm-5.3; ZT=60;; *) echo "HELD: zai tier must be fast or work"; exit 3;; esac
  ZQ=$(python3 "$R/bin/zai-pace.py" gate "$J" "$TIER"); [ $? -eq 0 ] || { echo "${ZQ:-HELD: zai gate failed}"; exit 3; }
  echo "ZAI $J model=$M max_turns=$ZT" >> "$R/$J.base.meta"
  lm_ok "$LM/mcp.json" "$LM_MJ"
  CMD=(sandbox-exec "${SB_D[@]}" -f "$ZSB" claude -p --dangerously-skip-permissions --setting-sources user --strict-mcp-config --mcp-config "$LM/mcp.json" --max-turns "$ZT" --model "$M" --output-format json)
  # stdout (the JSON result) and stderr both pass through scrub.pl; record charges credits from usage, prints at most one fixed
  # classifier line (zai-pace: quota_exhausted <kind> | auth_failed | rate_limited) for dispatchd AB_RX, then the JSON is deleted
  ( umask 077; : > "$R/$J.log"
    { { "${E[@]}" CLAUDE_CONFIG_DIR="$ZC" ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic \
          ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.3 ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.3 ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-5.3-flash \
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 DISABLE_AUTOUPDATER=1 API_TIMEOUT_MS=3000000 \
          /bin/bash -c 'unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN; IFS= read -r ANTHROPIC_AUTH_TOKEN <&3; exec 3<&-; export ANTHROPIC_AUTH_TOKEN; exec "$@"' zai "${CMD[@]}" 3< "$KF" \
          < "$R/$J.prompt" 2>&1 1>&4 4>&- | $SCRUB >> "$R/$J.log"; rcw "${PIPESTATUS[0]}"; } 4>&1 | $SCRUB > "$R/$J.zai.json"; }
    python3 "$R/bin/zai-pace.py" record "$J" 0 "$R/$J.zai.json" "$R/$J.log" 2>&1 | $SCRUB >> "$R/$J.log"
    python3 -I -c 'import json,sys;s=str(json.load(open(sys.argv[1])).get("result",""));print(s[-20000:] if len(s)>20000 else s)' "$R/$J.zai.json" 2>/dev/null | $SCRUB >> "$R/$J.log"   # drain-apply-sec-prereq: keep TAIL so DRAIN-OUTBOX-SHA256 lines survive when result >20k
    /usr/bin/python3 -I "$R/bin/job_usage.py" extract "$R/$J.zai.json" "$R/$J.usage.json" 2>/dev/null || true
    rm -f "$R/$J.zai.json" ) </dev/null >/dev/null 2>&1 &
  ;; # <<< zai lane
 agy) # >>> AGY-LANE rev1c+rev1e (rev1e: tier mid maps to the work model, defense in depth; dispatchd never routes mid here) (Security 2026-11-03; rev1c: probe fixes on 1.4.12, -p last, event stdin shape, pinned 444 settings.json): Antigravity CLI, Google OAuth file token in a lane-only HOME, paced by agy-pace.py
  # E is env -i: no GEMINI_API_KEY, GOOGLE_API_KEY, GOOGLE_CLOUD_PROJECT, GOOGLE_APPLICATION_CREDENTIALS or ANTIGRAVITY_* var reaches agy.
  # HOME=~/.agy-lane/home isolates agy's config, state and file token (keychain exec is denied in agy.sb) from ~/.gemini and the
  # Antigravity app; ADC lookups resolve inside it (none there). Per-run --settings forces useG1Credits off (no paid AI-credit
  # overage; 1.4.12 accepts no telemetry key); persistent settings, plugins, MCP auth, hooks and the updater are write-denied in agy.sb.
  # Prompt goes on stdin as one stream-json user message (never argv). Model ids are literals by tier.
  AD=$HOME/.agy-lane; AH=$AD/home; ASB=$R/bin/agy.sb; ASB_SHA=$(pinsha agy.sb)
  { [ -f "$ASB" ] && [ ! -L "$ASB" ] && [ "$(shasum -a 256 "$ASB" | cut -d' ' -f1)" = "$ASB_SHA" ]; } || { echo "REFUSED: agy.sb missing or sha mismatch"; exit 5; }
  { [ -d "$AD" ] && [ ! -L "$AD" ] && [ -O "$AD" ] && [ "$(stat -f %Lp "$AD")" = 700 ] && [ -d "$AH" ] && [ ! -L "$AH" ] && [ -O "$AH" ]; } || { echo "HELD: agy lane home missing or not 700 (one-time in-sandbox sign-in needed)"; exit 3; }
  # rev1c: agy 1.4.12 reads only useG1Credits from settings (telemetry keys are rejected; no data-sharing key exists in the CLI), so the
  # lane settings.json pins useG1Credits false against an inherited true; it must match its sha, be 444 and not a symlink (write-denied in agy.sb).
  AST=$AH/.gemini/antigravity-cli/settings.json; AST_SHA=565e3cb29356f2a2216f840b0cc1931a14977dbc38b3298e8f961a767c8b0ac5
  lm_ok "$AH/.gemini/config/mcp_config.json" a03ca83e924b412844963deac581e0c5b8432f4bfac48b9a62e3fb00d7f5951c9   # LANE-MCP rev1
  { [ -f "$AST" ] && [ ! -L "$AST" ] && [ "$(stat -f %Lp "$AST")" = 444 ] && [ "$(shasum -a 256 "$AST" | cut -d' ' -f1)" = "$AST_SHA" ]; } || { echo "REFUSED: agy settings.json missing, not 444 or sha mismatch"; exit 5; }
  case "$TIER" in fast) M=gemini-3.8-flash-medium; AT=900s;; work|mid) M=gemini-3.8-flash-high; AT=2400s;; frontier) M=claude-opus-4-6-thinking; AT=2400s;; *) echo "HELD: agy tier must be fast, work or frontier"; exit 3;; esac
  [ "$TIER" = mid ] && TIER=work   # rev1e: mid runs and is paced as work
  AQ=$(python3 "$R/bin/agy-pace.py" gate "$J" "$TIER"); [ $? -eq 0 ] || { echo "${AQ:-HELD: agy gate failed}"; exit 3; }
  echo "AGY $J model=$M timeout=$AT" >> "$R/$J.base.meta"
  ( umask 077; : > "$R/$J.log"
    { { python3 -I -c 'import json,sys;print(json.dumps({"event":"user","message":{"role":"user","content":sys.stdin.read()}}))' < "$R/$J.prompt" | \
        "${E[@]}" HOME="$AH" GIT_CONFIG_GLOBAL="$HOME/.gitconfig" sandbox-exec "${SB_D[@]}" -f "$ASB" /opt/homebrew/bin/agy --input-format stream-json --output-format stream-json \
          --print-timeout "$AT" --model "$M" --dangerously-skip-permissions --disable-slash-commands --settings '{"useG1Credits":false}' -p '' \
          2>&1 1>&4 4>&- | $SCRUB >> "$R/$J.log"; rcw "${PIPESTATUS[1]}"; } 4>&1 | $SCRUB > "$R/$J.agy.ndjson"; }
    python3 "$R/bin/agy-pace.py" record "$J" 0 "$R/$J.agy.ndjson" "$R/$J.log" 2>&1 | $SCRUB >> "$R/$J.log"
    tail -c 20000 "$R/$J.agy.ndjson" | $SCRUB >> "$R/$J.log"
    /usr/bin/python3 -I "$R/bin/job_usage.py" extract "$R/$J.agy.ndjson" "$R/$J.usage.json" 2>/dev/null || true
    rm -f "$R/$J.agy.ndjson" ) </dev/null >/dev/null 2>&1 &
  ;; # <<< agy lane
 grok) # >>> GROK-LANE rev1d (Security 2026-11-03; rev1d: vendored sha-pinned binary, parent XAI_API_KEY only warns): grok CLI on Mason's SuperGrok OAuth (grok login), paced by grok-pace.py
  # Metered-key paths: E (env -i) is a fixed allowlist, so XAI_API_KEY / GROK_CODE_XAI_API_KEY in the parent never reach grok
  # (rev1d: the parent having them is only a name-only warning; the launch is refused only if the constructed child env would carry one). HOME=~/.grok-lane/home relocates ~/.grok (verified on 1.0.46), so grok uses only the lane auth.json; no GROK_HOME,
  # GROK_CONFIG or endpoint override can reach it. Telemetry, trace upload, feedback, memory, the auto-updater and the ~/.claude and
  # ~/.cursor compat scans are off by env. The prompt is read by grok from the prompt file (headless grok does not read stdin); argv
  # carries only fixed flags. stdout (one JSON object) and stderr both pass through scrub.pl.
  [ -z "${XAI_API_KEY:-}${GROK_CODE_XAI_API_KEY:-}" ] || echo "WARN: XAI_API_KEY or GROK_CODE_XAI_API_KEY is set in the launcher env (name only); env -i keeps it out of the grok child" >> "$R/$J.base.meta"
  case " ${E[*]} " in *" XAI_API_KEY="*|*" GROK_CODE_XAI_API_KEY="*) echo "REFUSED: grok child env would carry an xAI API key (metered billing)"; exit 5;; esac
  GD=$HOME/.grok-lane; GH=$GD/home; GB=/Users/masonwyatt/.grok-lane/bin/grok; GB_SHA=e8daa302364c9c3b6a5546d511cfbd1ab5e5d407a9b04282f660665ea405f9f3; GV="grok 1.0.46 "; KSB=$R/bin/grok.sb; KSB_SHA=$(pinsha grok.sb)
  { [ -f "$KSB" ] && [ ! -L "$KSB" ] && [ "$(shasum -a 256 "$KSB" | cut -d' ' -f1)" = "$KSB_SHA" ]; } || { echo "REFUSED: grok.sb missing or sha mismatch"; exit 5; }
  lm_ok "$GH/.grok/config.toml" ad4add1ab2131d356727ab3263e5ed58259150867d394e7c742877816a37118b9   # LANE-MCP rev1
  { [ -d "$GD" ] && [ ! -L "$GD" ] && [ -O "$GD" ] && [ "$(stat -f %Lp "$GD")" = 700 ] && [ -d "$GH" ] && [ ! -L "$GH" ] && [ -O "$GH" ] && [ "$(stat -f %Lp "$GH")" = 700 ] \
    && [ -f "$GH/.grok/auth.json" ] && [ ! -L "$GH/.grok/auth.json" ] && [ "$(stat -f %Lp "$GH/.grok/auth.json")" = 600 ] && [ ! -L "$GH/.grok" ]; } || { echo "HELD: grok lane home or auth.json missing or wrong mode (dirs 700, auth.json 600)"; exit 3; }
  { [ -f "$GB" ] && [ ! -L "$GB" ] && [ ! -L "${GB%/grok}" ] && [ "$(stat -f %Lp "${GB%/grok}")" = 700 ] && [ "$(stat -f %Lp "$GB")" = 555 ] \
    && [ "$(shasum -a 256 "$GB" | cut -d' ' -f1)" = "$GB_SHA" ]; } || { echo "REFUSED: vendored grok binary missing, symlinked, wrong mode or sha mismatch"; exit 5; }
  { [ -x "$GB" ] && [ ! -L "$GB" ] && [[ "$(env -i HOME="$GH" PATH=/usr/bin:/bin sandbox-exec "${SB_D[@]}" -f "$KSB" "$GB" --version 2>/dev/null </dev/null)" == "$GV"* ]]; } || { echo "HELD: grok binary is not the pinned version ($GV)"; exit 3; }
  case "$TIER" in fast) M=grok-4.7-build-fast; GE=; GT=40;; work|mid) M=grok-4.7; GE=; GT=60;; frontier) M=grok-4.7; GE=high; GT=80;; *) echo "HELD: grok tier must be fast, work or frontier"; exit 3;; esac
  [ "$TIER" = mid ] && TIER=work   # rev1e: mid runs and is paced as work
  KQ=$(python3 "$R/bin/grok-pace.py" gate "$J" "$TIER"); [ $? -eq 0 ] || { echo "${KQ:-HELD: grok gate failed}"; exit 3; }
  echo "GROK $J model=$M effort=${GE:-default} max_turns=$GT" >> "$R/$J.base.meta"
  ( umask 077; : > "$R/$J.log"
    { { "${E[@]}" HOME="$GH" GIT_CONFIG_GLOBAL="$HOME/.gitconfig" GROK_TELEMETRY_ENABLED=0 GROK_TELEMETRY_TRACE_UPLOAD=0 GROK_FEEDBACK_ENABLED=0 \
          GROK_DISABLE_AUTOUPDATER=1 GROK_CLAUDE_SKILLS_ENABLED=0 GROK_CURSOR_MCPS_ENABLED=0 GROK_MEMORY=0 GROK_MARKETPLACE_REQUIRE_SHA=1 \
          sandbox-exec "${SB_D[@]}" -f "$KSB" "$GB" --prompt-file "$R/$J.prompt" --output-format json --no-auto-update --always-approve \
          --max-turns "$GT" -m "$M" ${GE:+--reasoning-effort "$GE"} --cwd "$WT" \
          </dev/null 2>&1 1>&4 4>&- | $SCRUB >> "$R/$J.log"; rcw "${PIPESTATUS[0]}"; } 4>&1 | $SCRUB > "$R/$J.grok.json"; }
    python3 "$R/bin/grok-pace.py" record "$J" "$(cat "$R/queue/run/$J.rc" 2>/dev/null || echo 1)" "$R/$J.grok.json" "$R/$J.log" 2>&1 | $SCRUB >> "$R/$J.log"
    python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));print(str(d.get("text","") if isinstance(d,dict) else "")[:20000])' "$R/$J.grok.json" 2>/dev/null | $SCRUB >> "$R/$J.log"
    /usr/bin/python3 -I "$R/bin/job_usage.py" extract "$R/$J.grok.json" "$R/$J.usage.json" 2>/dev/null || true
    rm -f "$R/$J.grok.json" ) </dev/null >/dev/null 2>&1 &
  ;; # <<< grok lane
 cursor) # >>> CURSOR-LANE rev1 (Security 2026-11-03): Cursor CLI on Mason's plan via a user API key, paced by cursor-pace.py
  # E is env -i: no CURSOR_AUTH_TOKEN, CURSOR_API_ENDPOINT, CURSOR_API_BASE_URL or other CURSOR_* override reaches the CLI. The key is read
  # on fd 3 by the child bash right before exec (never argv, never a shell var here, never logged); api_key is unreadable inside cursor.sb.
  # The binary is the pinned cask path (a brew upgrade changes the path and holds the lane; /opt/homebrew is write-denied, so no self-update).
  # rev1f: AGENT_CLI_CREDENTIAL_STORE=memory (read by cursor-agent's credential-store.ts) keeps the API-key login in memory, so it never
  # spawns /usr/bin/security to save to the keychain (that spawn was the probe's 'spawn EPERM'). The keychain stays denied.
  # cursor-agent takes the prompt only on argv, so argv carries a fixed pointer to the prompt file, never the prompt. --approve-mcps loads only the pinned 444 lane mcp.json (LANE-MCP rev1).
  CD=$HOME/.cursor-lane; CH=$CD/home; KF=$CD/api_key; CB=/opt/homebrew/Caskroom/cursor-cli/2026.10.22-27dcf5f/dist-package/cursor-agent; CSB=$R/bin/cursor.sb; CSB_SHA=$(pinsha cursor.sb)
  { [ -f "$CSB" ] && [ ! -L "$CSB" ] && [ "$(shasum -a 256 "$CSB" | cut -d' ' -f1)" = "$CSB_SHA" ]; } || { echo "REFUSED: cursor.sb missing or sha mismatch"; exit 5; }
  { [ -d "$CD" ] && [ ! -L "$CD" ] && [ -O "$CD" ] && [ "$(stat -f %Lp "$CD")" = 700 ] && [ -d "$CH" ] && [ ! -L "$CH" ] && [ -O "$CH" ] && [ "$(stat -f %Lp "$CH")" = 700 ] \
    && [ -f "$KF" ] && [ ! -L "$KF" ] && [ -O "$KF" ] && [ "$(stat -f %Lp "$KF")" = 600 ] && [ -s "$KF" ]; } || { echo "HELD: cursor api_key refused (needs dirs 700, file 600, owned by $USER)"; exit 3; }
  [ -x "$CB" ] && [ ! -L "$CB" ] || { echo "HELD: pinned cursor-cli 2026.10.22-27dcf5f not installed"; exit 3; }
  case "$TIER" in fast|work|mid) M=auto;; *) echo "HELD: cursor tier must be fast or work"; exit 3;; esac
  [ "$TIER" = mid ] && TIER=work   # rev1e: mid runs and is paced as work
  CQ=$(python3 "$R/bin/cursor-pace.py" gate "$J" "$TIER"); [ $? -eq 0 ] || { echo "${CQ:-HELD: cursor gate failed}"; exit 3; }
  echo "CURSOR $J model=$M" >> "$R/$J.base.meta"
  lm_ok "$CH/.cursor/mcp.json" a800de242bea0e4b894a344d99547e81c12c8e9e53d803ed88d154a1d5185c4f0
  CMD=(sandbox-exec "${SB_D[@]}" -f "$CSB" "$CB" -p --output-format json --force --approve-mcps --trust --workspace "$WT" --model "$M" \
       "Your full task is in the file $R/$J.prompt. Read that file first and carry out exactly what it says.")
  ( umask 077; : > "$R/$J.log"
    { { "${E[@]}" HOME="$CH" NO_OPEN_BROWSER=1 AGENT_CLI_CREDENTIAL_STORE=memory GIT_CONFIG_GLOBAL="$HOME/.gitconfig" \
          /bin/bash -c 'unset CURSOR_AUTH_TOKEN CURSOR_API_ENDPOINT CURSOR_API_BASE_URL CURSOR_API_URL; IFS= read -r CURSOR_API_KEY <&3; exec 3<&-; export CURSOR_API_KEY; exec "$@"' cursor "${CMD[@]}" 3< "$KF" \
          </dev/null 2>&1 1>&4 4>&- | $SCRUB >> "$R/$J.log"; rcw "${PIPESTATUS[0]}"; } 4>&1 | $SCRUB > "$R/$J.cursor.json"; }
    python3 "$R/bin/cursor-pace.py" record "$J" "$(cat "$R/queue/run/$J.rc" 2>/dev/null || echo 1)" "$R/$J.cursor.json" "$R/$J.log" 2>&1 | $SCRUB >> "$R/$J.log"
    python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));print(str(d.get("result","") if isinstance(d,dict) else "")[:20000])' "$R/$J.cursor.json" 2>/dev/null | $SCRUB >> "$R/$J.log"
    /usr/bin/python3 -I "$R/bin/job_usage.py" extract "$R/$J.cursor.json" "$R/$J.usage.json" 2>/dev/null || true
    rm -f "$R/$J.cursor.json" ) </dev/null >/dev/null 2>&1 &
  ;; # <<< cursor lane
 devin-flash) # >>> DEVIN-FLASH-LANE-1: local SWE-2 Flash only, own cap, never cloud, never ACP, never lightning.
  # Model already passed check-launch (cost_tier Free, window open until 2026-12-01T05:00Z).
  native_pressure_ok || exit 3
  if [ ! -f "$R/bin/devin_flash_lane.py" ] || [ -L "$R/bin/devin_flash_lane.py" ]; then
    echo "REFUSED: devin-flash helper missing"; exit 5
  fi
  if /usr/bin/python3 -I "$R/bin/devin_flash_lane.py" check-launch "$M" >/dev/null; then :; else
    echo "REFUSED: devin-flash gate failed ($M)"; exit 5
  fi
  { nohup "${E[@]}" sandbox-exec "${SB_D[@]}" -f $R/bin/agent.sb devin --permission-mode dangerous --respect-workspace-trust false --model $M -p --prompt-file $R/$J.prompt 2>&1 | $SCRUB > $R/$J.log; rcw "${PIPESTATUS[0]}"; /usr/bin/python3 -I "$R/bin/devin-overage-stop.py" scan "$J" "$(cat "$R/queue/run/$J.rc" 2>/dev/null || echo 1)" "$R/$J.log" >/dev/null; } &
  ;;
 devin) # >>> DEVIN-ACP-SUBLANES-1 (staged 2026-11-09): optional trusted sub-lanes share the Devin cap.
  # Default path (no queue/run/$J.sublane) is the live swe-2-* devin CLI.
  # DEVIN-UNIFY-1 v3: surface is still parsed, but cloud launches stay off.
  # Auto resolves to local. Visibility (phone/web, RQ-WEYV-*, RQ-*RELEASE*)
  # is not a routing reason. Official CLI has no documented stop/end command
  # for a persisted cloud VM, and list is cwd-only, so the cap cannot count
  # those VMs. DEVIN_STOP / overage-stop / hard_cap 6 are unchanged.
  # Sub-lane is read only from dispatchd's trusted file, never from .base.meta.
  # lightning / agoragentic are refused. Caps stay lane=devin. DEVIN_STOP already applied.
  native_pressure_ok || exit 3
  if /usr/bin/python3 -I "$R/bin/devin_acp_sublanes.py" paid-blocked "$M" "$POOL" 2>/dev/null; then
    echo "REFUSED: paid model or agent blocked ($M)"; exit 5
  fi
  SL=
  if [ -f "$R/bin/devin_acp_sublanes.py" ] && [ ! -L "$R/bin/devin_acp_sublanes.py" ]; then
    SL=$(/usr/bin/python3 -I "$R/bin/devin_acp_sublanes.py" read-trusted "$R/queue/run" "$J" 2>/dev/null || true)
  fi
  if [ -n "$SL" ]; then
    case "$SL" in
      devin:claude-agent|devin:codex|devin:antigravity) ;;
      *) echo "REFUSED: untrusted or unknown Devin sub-lane"; exit 5;;
    esac
    if /usr/bin/python3 -I "$R/bin/devin_acp_sublanes.py" paid-blocked "$SL" "$M" 2>/dev/null; then
      echo "REFUSED: paid model or agent blocked"; exit 5
    fi
    if [[ "$J" =~ ^[A-Za-z0-9._+-]{1,80}$ ]]; then
      printf '%s\n' "SUBLANE $SL" >> "$R/$J.base.meta"
      echo "ACP_START $(date +%s) $SL" >> "$R/$J.base.meta"
    fi
  fi
  if [ -z "$SL" ]; then
    # DEVIN-UNIFY-1: decide --cloud per job and log the decision. Never invent ACU.
    eval "$(devin_unify_decide_surface)"
    echo "DEVIN_SURFACE job=$J requested=$DEVIN_REQ decided=$DEVIN_DECIDED_SURFACE reason=$DEVIN_SURF_REASON size=$DEVIN_JOB_SIZE"
    if [[ "$J" =~ ^[A-Za-z0-9._+-]{1,80}$ ]]; then
      echo "DEVIN_SURFACE $J requested=$DEVIN_REQ decided=$DEVIN_DECIDED_SURFACE reason=$DEVIN_SURF_REASON size=$DEVIN_JOB_SIZE" >> "$R/$J.base.meta"
    fi
    # Cloud branch omitted: a --cloud -p process exits while the VM keeps
    # running (https://docs.devin.ai/cli/cloud). Until an official CLI stop
    # and a non-cwd-only session list exist and are tested, only local.
    { nohup "${E[@]}" sandbox-exec "${SB_D[@]}" -f $R/bin/agent.sb devin --permission-mode dangerous --respect-workspace-trust false --model $M -p --prompt-file $R/$J.prompt 2>&1 | $SCRUB > $R/$J.log; rcw "${PIPESTATUS[0]}"; /usr/bin/python3 -I "$R/bin/devin-overage-stop.py" scan "$J" "$(cat "$R/queue/run/$J.rc" 2>/dev/null || echo 1)" "$R/$J.log" >/dev/null; } &
  elif [ "$SL" = devin:codex ]; then
    # Personal ChatGPT only: CODEX_HOME=~/.codex-2. env -i (E) already drops OPENAI_API_KEY / CODEX_API_KEY.
    # Never default ~/.codex (CMP). Never read auth files here.
    lm_ok "$LM/mcp.json" "$LM_MJ"
    lm_ok "$HOME/.codex-2/lane.config.toml" adfc46b45a74f9589e1f9a0de0ea758c2906a54c8d1e8b1e8f04291bb85e45e96
    # Model from the personal Codex family, never the Devin swe-2-* id.
    CM=$(python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));p,f,t=sys.argv[2:5];print(next((str(d[k]) for k in (p+"."+t,p,f+"."+t,f) if d.get(k)),""))' "$R/models.json" "codex-personal" "codex" "$TIER" 2>/dev/null)
    [[ "$CM" =~ ^[A-Za-z0-9._-]+$ ]] || CM=
    if /usr/bin/python3 -I "$R/bin/devin_acp_sublanes.py" paid-blocked "$CM" 2>/dev/null; then
      echo "REFUSED: paid model or agent blocked ($CM)"; exit 5
    fi
    CSB=$R/bin/codex-personal.sb; CSB_SHA=$(pinsha codex-personal.sb)
    { [ -f "$CSB" ] && [ ! -L "$CSB" ] && [ "$(shasum -a 256 "$CSB" | cut -d' ' -f1)" = "$CSB_SHA" ]; } || { echo "REFUSED: codex-personal.sb missing or sha mismatch"; exit 5; }
    ( umask 077; : > "$R/$J.log"
      { { "${E[@]}" CODEX_HOME="$HOME/.codex-2" sandbox-exec "${SB_D[@]}" -f "$CSB" /opt/homebrew/bin/codex exec ${CM:+-m "$CM"} "${LMC[@]}" -c web_search=live --sandbox danger-full-access --skip-git-repo-check --json --color never -C "$WT" - < "$R/$J.prompt" \
          2>&1 1>&4 4>&- | $SCRUB >> "$R/$J.log"; rcw "${PIPESTATUS[0]}"; } 4>&1 | $SCRUB > "$R/$J.codex.ndjson"; }
      /usr/bin/python3 -I "$R/bin/job_usage.py" extract "$R/$J.codex.ndjson" "$R/$J.usage.json" 2>/dev/null || true
      if [[ "$J" =~ ^[A-Za-z0-9._+-]{1,80}$ ]]; then echo "ACP_END $(date +%s) $SL" >> "$R/$J.base.meta"; fi
      rm -f "$R/$J.codex.ndjson" ) </dev/null >/dev/null 2>&1 &
  elif [ "$SL" = devin:antigravity ]; then
    # Lane-only Google OAuth HOME, useG1Credits false, API/cloud env already absent from E.
    # Absolute /opt/homebrew/bin/agy. Do not modify Masbot's agy_acp_server.par shim.
    AD=$HOME/.agy-lane; AH=$AD/home; ASB=$R/bin/agy.sb; ASB_SHA=$(pinsha agy.sb)
    { [ -f "$ASB" ] && [ ! -L "$ASB" ] && [ "$(shasum -a 256 "$ASB" | cut -d' ' -f1)" = "$ASB_SHA" ]; } || { echo "REFUSED: agy.sb missing or sha mismatch"; exit 5; }
    { [ -d "$AD" ] && [ ! -L "$AD" ] && [ -O "$AD" ] && [ "$(stat -f %Lp "$AD")" = 700 ] && [ -d "$AH" ] && [ ! -L "$AH" ] && [ -O "$AH" ]; } || { echo "HELD: agy lane home missing or not 700 (one-time in-sandbox sign-in needed)"; exit 3; }
    AST=$AH/.gemini/antigravity-cli/settings.json; AST_SHA=565e3cb29356f2a2216f840b0cc1931a14977dbc38b3298e8f961a767c8b0ac5
    { [ -f "$AST" ] && [ ! -L "$AST" ] && [ "$(stat -f %Lp "$AST")" = 444 ] && [ "$(shasum -a 256 "$AST" | cut -d' ' -f1)" = "$AST_SHA" ]; } || { echo "REFUSED: agy settings.json missing, not 444 or sha mismatch"; exit 5; }
    case "$TIER" in fast) AM=gemini-3.8-flash-medium; AT=900s;; work|mid) AM=gemini-3.8-flash-high; AT=2400s;; frontier) AM=claude-opus-4-6-thinking; AT=2400s;; *) echo "HELD: antigravity tier must be fast, work or frontier"; exit 3;; esac
    if /usr/bin/python3 -I "$R/bin/devin_acp_sublanes.py" paid-blocked "$AM" 2>/dev/null; then
      echo "REFUSED: paid model or agent blocked ($AM)"; exit 5
    fi
    AQ=$(python3 "$R/bin/agy-pace.py" gate "$J" "$TIER"); [ $? -eq 0 ] || { echo "${AQ:-HELD: agy gate failed}"; exit 3; }
    ( umask 077; : > "$R/$J.log"
      { { python3 -I -c 'import json,sys;print(json.dumps({"event":"user","message":{"role":"user","content":sys.stdin.read()}}))' < "$R/$J.prompt" | \
          "${E[@]}" HOME="$AH" GIT_CONFIG_GLOBAL="$HOME/.gitconfig" sandbox-exec "${SB_D[@]}" -f "$ASB" /opt/homebrew/bin/agy --input-format stream-json --output-format stream-json \
            --print-timeout "$AT" --model "$AM" --dangerously-skip-permissions --disable-slash-commands --settings '{"useG1Credits":false}' -p '' \
            2>&1 1>&4 4>&- | $SCRUB >> "$R/$J.log"; rcw "${PIPESTATUS[1]}"; } 4>&1 | $SCRUB > "$R/$J.agy.ndjson"; }
      python3 "$R/bin/agy-pace.py" record "$J" 0 "$R/$J.agy.ndjson" "$R/$J.log" 2>&1 | $SCRUB >> "$R/$J.log"
      /usr/bin/python3 -I "$R/bin/job_usage.py" extract "$R/$J.agy.ndjson" "$R/$J.usage.json" 2>/dev/null || true
      if [[ "$J" =~ ^[A-Za-z0-9._+-]{1,80}$ ]]; then echo "ACP_END $(date +%s) $SL" >> "$R/$J.base.meta"; fi
      rm -f "$R/$J.agy.ndjson" ) </dev/null >/dev/null 2>&1 &
  elif [ "$SL" = devin:claude-agent ]; then
    # Fail closed unless claude auth status shows a subscription login. Never pass an API key.
    # Do not use the fleet claude-broker (that is the claude lane, not this sub-lane).
    CAUTH=$(mktemp "${TMPDIR:-/tmp}/claude-auth.XXXXXX")
    ~/.local/bin/claude auth status --json >"$CAUTH" 2>/dev/null || /usr/bin/env claude auth status --json >"$CAUTH" 2>/dev/null || true
    if ! /usr/bin/python3 -I "$R/bin/devin_acp_sublanes.py" check-claude-auth <"$CAUTH"; then
      rm -f "$CAUTH"
      echo "HELD: devin:claude-agent has no Claude subscription login (API keys are not used)"; exit 3
    fi
    rm -f "$CAUTH"
    lm_ok "$LM/mcp.json" "$LM_MJ"
    # Prefer claude-family models, never Devin swe-2-* or lightning.
    CM=$(python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));p,f,t=sys.argv[2:5];print(next((str(d[k]) for k in (p+"."+t,p,f+"."+t,f) if d.get(k)),""))' "$R/models.json" "claude" "claude" "$TIER" 2>/dev/null)
    [[ "$CM" =~ ^[A-Za-z0-9._-]+$ ]] || CM=
    if /usr/bin/python3 -I "$R/bin/devin_acp_sublanes.py" paid-blocked "$CM" 2>/dev/null; then
      echo "REFUSED: paid model or agent blocked ($CM)"; exit 5
    fi
    CSB=$R/bin/claude.sb; CSB_SHA=$(pinsha claude.sb)
    { [ -f "$CSB" ] && [ ! -L "$CSB" ] && [ "$(shasum -a 256 "$CSB" | cut -d' ' -f1)" = "$CSB_SHA" ]; } || { echo "REFUSED: claude.sb missing or sha mismatch"; exit 5; }
    ( umask 077; : > "$R/$J.log"
      { { "${E[@]}" sandbox-exec "${SB_D[@]}" -f "$CSB" /usr/bin/env claude -p --output-format json --strict-mcp-config --mcp-config "$LM/mcp.json" ${CM:+--model "$CM"} \
          < "$R/$J.prompt" 2>&1 1>&4 4>&- | $SCRUB >> "$R/$J.log"; rcw "${PIPESTATUS[0]}"; } 4>&1 | $SCRUB > "$R/$J.claude.json"; }
      /usr/bin/python3 -I "$R/bin/job_usage.py" extract "$R/$J.claude.json" "$R/$J.usage.json" 2>/dev/null || true
      if [[ "$J" =~ ^[A-Za-z0-9._+-]{1,80}$ ]]; then echo "ACP_END $(date +%s) $SL" >> "$R/$J.base.meta"; fi
      rm -f "$R/$J.claude.json" ) </dev/null >/dev/null 2>&1 &
  else
    echo "REFUSED: untrusted or unknown Devin sub-lane"; exit 5
  fi
  ;;
esac
child_pid=$!
# Observation only: registration cannot alter the launch outcome or signal the child.
case "$POOL" in
  codex-cmp|codex-personal|devin|devin-flash) /usr/bin/python3 -I "$R/bin/host_session_tick.py" register "$J" "$child_pid" >/dev/null 2>&1 || : ;;
esac
# DEVIN-UNIFY-1: record official `devin list --format json` into a Phantom-owned sidecar + roster.
# Missing helper is ignored. Never reads credentials or the Keychain.
if [ "$POOL" = devin ] && [ -z "${SL:-}" ] && [ -f "$R/bin/devin-session-roster.py" ] && [ ! -L "$R/bin/devin-session-roster.py" ]; then
  /usr/bin/python3 -I "$R/bin/devin-session-roster.py" record "$J" >/dev/null 2>&1 || :
fi
echo "launched $J $POOL pid $child_pid base ${BASE:0:9}"
