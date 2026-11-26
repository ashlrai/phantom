#!/bin/bash
# selfrun.sh (RQ-SELFRUN): one pinned tick script that replaces Masbot's recurring hand steps.
# rev5.3: run by LaunchAgent ai.ashlr.selfrun every 600s (no dispatchd hook). Steps: restock, landonly, hold, metrics, closegen, close, gitlink. Each step is sha-checked
# (fail closed for that step), interval-gated by a stamp in $R/selfrun/, logs exactly one line, and cannot stop the others.
# R and every script path are pinned here, never taken from env (Security W6). No git except via git-safe-env.sh.
set -u
umask 077
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
RH=$(/usr/bin/python3 -I -c 'import os,pwd;print(pwd.getpwuid(os.getuid()).pw_dir)' 2>/dev/null); case "$RH" in /*) ;; *) exit 1;; esac   # rev3: passwd home, never the HOME env var
R="$RH/.ashlr-runs"; B="$R/bin"; S="$R/selfrun"; LOG="$S/selfrun.log"
PIN_RESTOCK_SH=7665c59ed06f154e388c4ce91cad276ebcd9dcd18899554a1f0180261b4b9fe6
PIN_RESTOCK_PY=56ca079df87af6096dfa3a3e94a62e59fb63bb4726f20b3ddb6b963d480f9bc1
PIN_CLOSE_RUN=3e938be20f8093897e51568ee4bab45eb2d0fb6b9e0da2c9a4ee5809a6e303b2   # rev5.2: CLOSE-STALE-2
PIN_CLOSE_PRE=e56ebe0cd639159364d509b2ef1304acd4159dfd548e8d8daaa995083fb119b0   # rev5.2: CLOSE-STALE-2
PIN_CLOSEGEN=b469193e62fff67020cc1822df42d7c7faebea956362ae73bd9d5b1128d11119   # rev5.4: RQ-CLOSEGEN-2
PIN_GITSAFE=01e1e5ab72016a5b6fbd96c76cb903eb7c61849084b20ae04374219dcd077331   # rev4.1: GIT-SAFE rev4.1 (was rev4 50f38b25)
PIN_SCRUB=5aa902abedbb3bf7fa8d893b93969e247c82ff62ac26cd082215caabfb740265   # rev4: scrub.pl, Security pin (runlog-scrub)
mode(){ if [ "$(/usr/bin/uname)" = Darwin ]; then /usr/bin/stat -f %Lp "$1"; else /usr/bin/stat -c %a "$1"; fi; }
mtime(){ if [ "$(/usr/bin/uname)" = Darwin ]; then /usr/bin/stat -f %m "$1"; else /usr/bin/stat -c %Y "$1"; fi; }
JID='^RQ-[A-Za-z0-9._-]{1,80}$'

[ -L "$R" ] || [ -L "$S" ] && exit 1
/bin/mkdir -p "$S" && /bin/chmod 700 "$S" || exit 1
LK="$S/run.lock"
STALE_PY='
import ctypes, ctypes.util, os, secrets, stat, sys, time
def rename_excl(a, b):   # rev5: atomic rename that never overwrites (macOS renamex_np RENAME_EXCL, Linux renameat2 RENAME_NOREPLACE)
    c = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True); fa, fb = os.fsencode(a), os.fsencode(b)
    r = c.renamex_np(fa, fb, 4) if sys.platform == "darwin" else c.renameat2(-100, fa, -100, fb, 1)
    if r != 0: raise OSError(ctypes.get_errno(), "rename_excl")
lk = sys.argv[1]; st = os.lstat(lk)
if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or time.time() - st.st_mtime < 600 or os.path.lexists(lk + "/pid"): sys.exit(0)
seen = (st.st_dev, st.st_ino)
x = "%s.stale.%s" % (lk, secrets.token_hex(8))
if os.path.lexists(x): sys.exit(0)
os.rename(lk, x)
s2 = os.lstat(x)
if (s2.st_dev, s2.st_ino) != seen:   # rev5: not the dir we judged stale (same-user swap): put it back if the lock path is free
    if not os.path.lexists(lk): rename_excl(x, lk)
    sys.exit(0)
if stat.S_ISDIR(s2.st_mode) and not os.path.lexists(x + "/pid") and not os.listdir(x): os.rmdir(x)
'
# rev3: mkdir lock plus pid file. A held lock is taken over only when its pid file is ours (owned by this uid) and that pid
# is no longer running; no pid file, a foreign file or a live pid means exit 0. The trap removes the lock only if it is ours.
if /bin/mkdir "$LK" 2>/dev/null; then printf '%s\n' "$$" > "$LK/pid" || exit 1
else
  # rev4.1 A-3: a lock dir with no pid file, ours, not a symlink, 10 min or older is renamed with an atomic os.rename to a
  # fresh random 64-bit name (checked absent first), then rmdir'd only if still pidless and empty.
  # It is never moved back; a dir that gained a pid or files stays at the aside name. This tick then exits.
  [ -d "$LK" ] && [ ! -L "$LK" ] && [ -O "$LK" ] && [ ! -e "$LK/pid" ] && [ ! -L "$LK/pid" ] && [ $(( $(/bin/date +%s) - $(mtime "$LK") )) -ge 600 ] && {
    /usr/bin/python3 -I -c "$STALE_PY" "$LK" 2>/dev/null; exit 0; }
  p=$(/bin/cat "$LK/pid" 2>/dev/null); case "$p" in ""|*[!0-9]*) exit 0;; esac
  [ -f "$LK/pid" ] && [ ! -L "$LK/pid" ] && [ -O "$LK/pid" ] || exit 0
  /bin/ps -p "$p" >/dev/null 2>&1 && exit 0
  /bin/rm -f "$LK/pid" && /bin/rmdir "$LK" 2>/dev/null && /bin/mkdir "$LK" 2>/dev/null && printf '%s\n' "$$" > "$LK/pid" || exit 0
fi
trap '[ "$(/bin/cat "$LK/pid" 2>/dev/null)" = "$$" ] && /bin/rm -f "$LK/pid" && /bin/rmdir "$LK" 2>/dev/null' EXIT
/usr/bin/touch "$LOG" && /bin/chmod 600 "$LOG"
NOW=$(/bin/date +%s)

log(){ printf '%s %s %s %s\n' "$(/bin/date +%Y-%m-%dT%H:%M:%S%z)" "$1" "$2" "${3:--}" >> "$LOG"; }
shaok(){ [ -f "$1" ] && [ ! -L "$1" ] && [ "$(/usr/bin/shasum -a 256 "$1" 2>/dev/null | /usr/bin/cut -d' ' -f1)" = "$2" ]; }
due(){ local st="$S/$1.stamp" t; [ "$2" = 0 ] && return 0; t=$(/bin/cat "$st" 2>/dev/null); case "$t" in ""|*[!0-9]*) return 0;; esac; [ $((NOW - t)) -ge "$2" ]; }
stamp(){ printf '%s\n' "$NOW" > "$S/$1.stamp.tmp" && /bin/chmod 600 "$S/$1.stamp.tmp" && /bin/mv "$S/$1.stamp.tmp" "$S/$1.stamp"; }
# run STEP INTERVAL FUNC: one log line, errors isolated in a subshell.
run(){ local out rc
  due "$1" "$2" || { log "$1" skip interval; return; }
  out=$( ( "$3" ) 2>/dev/null ); rc=$?
  out=$(printf '%s' "$out" | /usr/bin/tr -cd 'A-Za-z0-9=_.,:-' | /usr/bin/cut -c1-120)
  case $rc in 0) stamp "$1"; log "$1" ok "$out";; 9) log "$1" fail "sha_mismatch${out:+,$out}";; *) log "$1" fail "rc=$rc${out:+,$out}";; esac; }

s_restock(){ shaok "$B/restock.sh" "$PIN_RESTOCK_SH" && shaok "$B/restock.py" "$PIN_RESTOCK_PY" || exit 9
  [ -e "$R/queue/RESTOCK_OFF" ] && { echo off; exit 0; }
  /bin/bash "$B/restock.sh" >> "$S/restock.out" 2>&1; rc=$?; /bin/chmod 600 "$S/restock.out"; echo "exit=$rc"; exit $rc; }
s_landonly(){ set -f; local f="$R/PUBLISH_LANDONLY" a="$R/queue/landonly.add" al="$R/queue/landonly.allow" n=0 bad=0 t j b toks="" allow=""
  # rev3 B2: every RQ-DESK-* id (derived or manual) must also be a full line of $R/queue/landonly.allow (Masbot-kept,
  # regular, not a symlink, owned by us, mode 0600, $R/queue not a symlink). Missing or bad file: no RQ-DESK-* id is added.
  if [ ! -L "$R/queue" ] && [ -f "$al" ] && [ ! -L "$al" ] && [ -O "$al" ] && [ "$(mode "$al")" = 600 ]; then allow=$(/usr/bin/grep -Ex 'RQ-DESK-[A-Za-z0-9._-]{1,72}' "$al"); fi
  [ -f "$f" ] && [ ! -L "$f" ] || { echo unset; exit 0; }
  [ -f "$a" ] && [ ! -L "$a" ] && toks=$(/bin/cat "$a")
  set +f   # rev2: derive RQ-DESK-* ids that have a real $R/J.base and no $R/J.superseded-core
  for b in "$R"/RQ-DESK-*.base; do [ -f "$b" ] && [ ! -L "$b" ] || continue
    j=${b##*/}; j=${j%.base}
    case "$j" in RQ-DESK-*) ;; *) continue;; esac
    case "$j" in *[!A-Za-z0-9._-]*|"") continue;; esac   # dispatchd JID ^[A-Za-z0-9._-]+$, fullmatch
    [ -e "$R/$j.superseded-core" ] || [ -L "$R/$j.superseded-core" ] && continue
    toks="$toks $j"
  done; set -f
  for t in $toks; do
    printf '%s' "$t" | /usr/bin/grep -Eq "$JID" || { bad=$((bad+1)); continue; }
    case "$t" in RQ-DESK-*) printf '%s\n' "$allow" | /usr/bin/grep -Fxq -- "$t" || continue;; esac
    /usr/bin/tr -s ' \t' '\n\n' < "$f" | /usr/bin/grep -Fxq -- "$t" && continue
    printf '%s\n' "$t" >> "$f" && n=$((n+1))
  done; echo "added=$n,bad=$bad"; }
s_hold(){ local h="$R/PUBLISH_HOLD" q
  [ -e "$h" ] || { echo hold=0; exit 0; }
  q=$(/usr/bin/awk 'NR==1{print $2}' "$R/PUBLISH_HOLD.queued" 2>/dev/null); case "$q" in ""|*[!0-9]*) q=unknown;; esac
  echo "hold=1,age_min=$(( (NOW - $(mtime "$h")) / 60 )),queued=$q"; }
s_metrics(){ local fs="" p G="$S/msync-stage"
  # rev3: jobs.jsonl and claimed.tsv are rewritten into a 0700 staging dir with ids, states and timestamps only
  # rev4: status.json and fleet-snapshot.json are filtered too (allowlisted keys, id/state/count/timestamp values),
  # then the pinned scrub.pl --check runs over every staged file; any hit (or a bad pin) means no tarball.
  shaok "$B/scrub.pl" "$PIN_SCRUB" || exit 9
  /bin/rm -rf "$G" && /bin/mkdir -p "$G/metrics" "$G/queue" "$G/export" && /bin/chmod -R 700 "$G" || exit 1
  for p in metrics/jobs.jsonl queue/status.json queue/claimed.tsv export/fleet-snapshot.json; do [ -f "$R/$p" ] && [ ! -L "$R/$p" ] || continue
    /usr/bin/python3 -I -c "$MSYNC_PY" "$p" < "$R/$p" > "$G/$p" || exit 1
    fs="$fs $p"; done
  [ -n "$fs" ] || { echo files=0; exit 1; }
  for p in $fs; do /usr/bin/perl "$B/scrub.pl" --check < "$G/$p" >/dev/null 2>&1 || { /bin/rm -rf "$G" "$R/queue/msync.tgz.tmp"; echo "scrub_hit:${p##*/}"; exit 1; }; done
  /usr/bin/tar czf "$R/queue/msync.tgz.tmp" -C "$G" $fs && /bin/chmod 600 "$R/queue/msync.tgz.tmp" && /bin/mv "$R/queue/msync.tgz.tmp" "$R/queue/msync.tgz" || exit 1
  /bin/rm -rf "$G"
  echo "files=$(echo $fs | /usr/bin/wc -w | /usr/bin/tr -d ' ')"; }
s_closegen(){ shaok "$B/closegen.sh" "$PIN_CLOSEGEN" || exit 9; /bin/bash "$B/closegen.sh"; }
s_close(){ local c="$R/queue/run/close-dup.candidates" o
  shaok "$B/close-dup-run.sh" "$PIN_CLOSE_RUN" && shaok "$B/close-precheck.sh" "$PIN_CLOSE_PRE" || exit 9
  [ -f "$c" ] && [ ! -L "$c" ] || { echo candidates=0; exit 0; }
  if [ -e "$R/CLOSE_DUP_APPLY" ]; then o=$(/bin/bash "$B/close-dup-run.sh" --apply < "$c" 2>&1); m=apply; else o=$(/bin/bash "$B/close-dup-run.sh" < "$c" 2>&1); m=dry; fi
  rc=$?; printf '%s\n' "$o" >> "$S/close.out"; /bin/chmod 600 "$S/close.out"
  echo "mode=$m,eligible=$(printf '%s\n' "$o" | /usr/bin/grep -c '^ELIGIBLE'),ineligible=$(printf '%s\n' "$o" | /usr/bin/grep -c '^INELIGIBLE'),closed=$(printf '%s\n' "$o" | /usr/bin/grep -c '^CLOSED')"; exit $rc; }
s_gitlink(){
  shaok "$B/git-safe-env.sh" "$PIN_GITSAFE" || exit 9
  shaok "$B/reaper-plan.py" "95c1c9111db21cf4ca13ba2e8eb6dd2a04a651017ca127505a0cdc91e1a687b0" || exit 9
  HOME="$RH" /usr/bin/python3 -I -B "$B/reaper-plan.py" audit "$RH" "$S" "$B/git-safe-env.sh"; }

MSYNC_PY='
import json, re, sys
OK = re.compile(r"[A-Za-z0-9._:+-]{1,80}")
KEEP = ("ts", "event", "job", "lane", "tier", "repo", "state", "status", "empty", "inferred", "pr", "exit_code", "code")
def v(x):
    if isinstance(x, bool) or x is None or (isinstance(x, int) and abs(x) < 2**53): return x
    return x if isinstance(x, str) and OK.fullmatch(x) else "-"
ID = re.compile(r"[A-Za-z0-9._-]{1,80}")
SKEEP = set(KEEP) | {"id", "jobs", "lanes", "slots", "counts", "count", "total", "queued", "running", "done", "failed", "held",
    "claimed", "ready", "free", "used", "max", "updated", "updated_at", "generated_at", "started_at", "finished_at", "since"}
def f(x, depth=0):   # rev4: status.json / fleet-snapshot.json, allowlisted keys only; id-shaped keys of maps kept
    if depth > 8: return "-"
    if isinstance(x, dict): return {k: f(w, depth + 1) for k, w in x.items() if k in SKEEP or (k.startswith("RQ-") and ID.fullmatch(k))}
    if isinstance(x, list): return [f(w, depth + 1) for w in x[:2000]]
    return v(x)
if sys.argv[1].endswith("status.json") or sys.argv[1].endswith("fleet-snapshot.json"):
    try: print(json.dumps(f(json.load(sys.stdin)), sort_keys=True))
    except ValueError: print("{}")
    sys.exit(0)
for line in sys.stdin:
    if sys.argv[1].endswith(".tsv"):
        f = line.rstrip("\n").split("\t")[:5]; print("\t".join(x if OK.fullmatch(x) else "-" for x in f)); continue
    try: d = json.loads(line)
    except ValueError: continue
    if isinstance(d, dict): print(json.dumps({k: v(d[k]) for k in KEEP if k in d}, sort_keys=True))
'
run restock 0 s_restock
run landonly 0 s_landonly
run hold 0 s_hold
run metrics 3600 s_metrics
run closegen 3600 s_closegen
run close 3600 s_close
run gitlink 0 s_gitlink
exit 0
