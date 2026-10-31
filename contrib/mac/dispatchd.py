#!/usr/bin/python3
# dispatchd core (one tick). Run only via dispatchd.sh (lockf). No LLM calls, no network of its own.
# Repo copy of ~/.ashlr-runs/bin/dispatchd.py (installed via swap.sh, sha-pinned by selfrun.sh under
# G1-CODE-PIN; this revision is not installed on the Mac). RQ-DEVINROUTEDEFAULTQ7 +
# DEVIN-LEVERAGE-20261026 rev: devin sits in the restock trigger loop and the failure-spike step-down
# is computed in dispatchd itself (Masbot 21:19 Oct 26); devin leverage defaults target 10, ceiling 16.
import os, re, json, time, fcntl, subprocess, glob
H = os.path.expanduser("~"); R = H + "/.ashlr-runs"; Q = R + "/queue"; RUN = Q + "/run"
WTROOT = H + "/Projects/ashlrai/wt"; EV = R + "/dispatch-events.log"
NOW = time.time(); TS = time.strftime("%F %T")
MAX_LAUNCH_PER_TICK = 4; MAX_REAPS = 6; GRACE = 120; RAISE_GAP = 120
LANES = ["codex-cmp", "codex-personal", "claude", "devin", "claude-api", "codex-local"]   # tie-break order: cmp first
DEFAULT = {"codex-cmp": {"target": 10, "floor": 10, "ceiling": 32},
           "codex-personal": {"target": 10, "floor": 10, "ceiling": 32},
           "claude": {"target": 0, "floor": 0, "ceiling": 8},
           "devin": {"target": 10, "floor": 3, "ceiling": 16},   # DEVIN-LEVERAGE-20261026
           "claude-api": {"target": 4, "floor": 0, "ceiling": 8},   # target is re-paced every tick by claude-api.py
           "codex-local": {"target": 6, "floor": 0, "ceiling": 6}}   # RQ-LOCAL-LANE: oMLX on this Mac, 6 total
LOCAL_MID_CAP = 2   # RQ-LOCAL-LANE: at most 2 concurrent tier=mid ('strong', 27B) codex-local jobs; fast uses the rest
LOCAL_HEALTH = "http://127.0.0.1:8123/v1/models"   # loopback only, no auth header, 2 s timeout, checked at most once per tick
TIERS = {"frontier", "work", "mid", "fast"}
# DEVIN-LEVERAGE-20261026 step-down (Masbot 21:19 Oct 26): more than 3 non-PR outcomes (abort or
# empty) in the last 10 devin completions steps the target down 2, never below 6; the approved
# spike bar sits well over the 5% baseline (2 of 40).
DEVIN_STEP = {"window": 10, "max_non_pr": 3, "step": 2, "floor": 6}
JID = re.compile(r"^[A-Za-z0-9._-]+$")
RL = re.compile(r"(?i)(429 too many requests|status(code)?[\s:=\"]+429\b|rate[ _-]?limit (reached|exceeded|hit)|exceeded (your|the) .{0,20}rate limit|usage limit|you've hit your|quota exceeded)")

MD = R + "/metrics"; os.makedirs(MD, exist_ok=True)
def metric(d):
    d.setdefault("ts", time.strftime("%Y-%m-%dT%H:%M:%S%z"))
    if d.get("job") and "ab" not in d:   # Masbot 16:35: tag A/B arm from the router line (TERRA-AB-1)
        try:
            m = re.search(r"^- \S+ (?:\S+ )*?%s \(([^)]*)\)" % re.escape(d["job"]), rd(Q + "/router-queue.md"), re.M)
            a = m and re.search(r"\bab=(\S+?)[,)\s]", m.group(1) + ")"); b = m and re.search(r"\barm=(\S+?)[,)\s]", m.group(1) + ")")
            if a: d["ab"] = a.group(1)
            if b: d["arm"] = b.group(1)
        except Exception: pass
    with open(MD + "/jobs.jsonl", "a") as f: f.write(json.dumps(d, sort_keys=True) + "\n")
CLS = [("credits_exhausted", re.compile(r"(?i)(credits? (are |have been )?(exhausted|depleted)|out of credits|insufficient credits|no credits remaining)")),
       ("usage_limit", re.compile(r"(?i)(usage limit|you've hit your|weekly limit)")),
       ("model_capacity", re.compile(r"(?i)(at capacity|over capacity|overloaded|\b529\b)")),
       ("rate_limit", RL)]
ERRLINE = re.compile(r"^\s*(ERROR|Error|API Error|stream error|\[[0-9T:.\-]+Z?\]\s*ERROR)\b[: ]")
def errlines(lines): return [t for t in lines if ERRLINE.match(t) and not t.lstrip().lower().startswith("error: usage:")]
def logtail(lp, n=6000):
    try:
        with open(lp, "rb") as f:
            f.seek(0, 2); z = f.tell(); f.seek(max(0, z - n)); return f.read().decode("utf-8", "replace")
    except Exception: return ""
def tokens(txt):
    m = re.findall(r"(?im)^tokens used\s*\n\s*([\d,]+)", txt)
    return int(m[-1].replace(",", "")) if m else None
def ev(msg):
    with open(EV, "a") as f: f.write("%s %s\n" % (TS, msg))
def log(msg): print("%s %s" % (TS, msg), flush=True)
def rd(p, d=""):
    try:
        with open(p) as f: return f.read()
    except Exception: return d
def jload(p, d):
    try: return json.loads(rd(p)) or d
    except Exception: return d
def jsave(p, obj):
    t = p + ".tmp"
    with open(t, "w") as f: json.dump(obj, f, indent=1)
    os.replace(t, p)

os.makedirs(RUN, exist_ok=True); os.makedirs(Q + "/prompts", exist_ok=True)
slots = jload(Q + "/slots.json", {})
for k, v in DEFAULT.items():
    s = slots.setdefault(k, dict(v)); [s.setdefault(a, b) for a, b in v.items()]; s.setdefault("last_change", 0)
# ---- usage backoff (RQ-USAGE-BACKOFF-11 rev2): auto-hold a pool on a provider CLI usage/quota error line.
# Only exact CLI error lines (anchored, CLI prefix) count, and only on a failed or EMPTY run (codex-cmp: only a run
# with no work). Only held_by == "autobackoff" entries are ever auto-unheld or extended; manual holds are never touched.
# Nothing from the log is stored or logged: only a fixed pattern id, lane, job, until and src.
AB_BY = "autobackoff"; AB_TAIL = 16384; AB_CAP = 86400   # rev5: 7d max removed (Security: log merges model stdout, any line is forgeable)
AB_MAX = AB_CAP; AB_DEF = 6 * 3600
_Q = r"(?:'|\u2019)"; _CX = r"^(?:\[[0-9T:.\-]+Z?\]\s*)?ERROR: "
AB_RX = {"codex": [("codex_usage_limit", re.compile(r"(?im)" + _CX + r"you" + _Q + r"ve hit your usage limit\b.*$")),
                   ("codex_credits_exhausted", re.compile(r"(?im)" + _CX + r"(?:credits? (?:are |have been )?(?:exhausted|depleted)|out of credits|insufficient credits)\b.*$")),
                   ("codex_rate_limit_429", re.compile(r"(?im)" + _CX + r"(?:unexpected status |stream error: )?429\b.{0,200}\brate_limit.*$"))],
         "anthropic": [("claude_usage_limit", re.compile(r"(?im)^Claude AI usage limit reached(?:\|\d{10})?\s*$")),
                       ("claude_rate_limit_error", re.compile(r"(?im)^API Error: 429\b.{0,200}\"type\":\s*\"rate_limit_error\".*$")),
                       ("claude_credit_balance", re.compile(r"(?im)^(?:API Error: \d{3} .{0,200})?Credit balance is too low\b.*$"))],
         "devin": [("devin_acu_exhausted", re.compile(r"(?im)^(?:ERROR|Error): (?:ACU (?:limit|quota) (?:reached|exceeded)|ACUs? (?:are |have been )?(?:exhausted|depleted)|out of ACUs)\b.*$"))]}
AB_PROV = {"codex-cmp": "codex", "codex-personal": "codex", "claude": "anthropic", "claude-api": "anthropic", "devin": "devin"}
_MON = {m: i + 1 for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}
def _et():
    try:
        from zoneinfo import ZoneInfo; return ZoneInfo("America/New_York")
    except Exception: return None
def ab_reset(txt, now):   # txt = the matched CLI line only. -> epoch or None. Regex only, no eval.
    import datetime as dt
    tz = _et()
    try:
        m = re.search(r"usage limit reached\|(\d{10})\s*$", txt)
        if m: return float(m.group(1))
        m = re.search(r"\b(20\d\d-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d))", txt)
        if m: return dt.datetime.fromisoformat(m.group(1).replace("Z", "+00:00")).timestamp()
        m = re.search(r"(?i)\b(?:try again|resets?|available again)\s+in\s+(?:(\d{1,3})\s*d(?:ays?)?\s*)?(?:(\d{1,3})\s*h(?:ours?|rs?)?\s*)?(?:(\d{1,4})\s*m(?:in(?:ute)?s?)?)?", txt)
        if m and any(m.groups()): return now + int(m.group(1) or 0) * 86400 + int(m.group(2) or 0) * 3600 + int(m.group(3) or 0) * 60
        m = re.search(r"(?i)\b(?:try again|resets?|available again)\s+(?:at|on)\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(20\d\d),?\s+)?(?:at\s+)?)?(\d{1,2})(?::(\d\d))?\s*([AaPp]\.?[Mm]\.?)?", txt)
        if m and tz is not None:
            hh = int(m.group(4)); mm = int(m.group(5) or 0); ap = (m.group(6) or "").lower().replace(".", "")
            if ap == "pm" and hh < 12: hh += 12
            if ap == "am" and hh == 12: hh = 0
            if hh > 23 or mm > 59: return None
            n = dt.datetime.fromtimestamp(now, tz)
            if m.group(1):
                mon = _MON.get(m.group(1).lower()[:3])
                if not mon: return None
                t = dt.datetime(int(m.group(3) or n.year), mon, int(m.group(2)), hh, mm, tzinfo=tz)
                if not m.group(3) and t.timestamp() <= now: t = t.replace(year=n.year + 1)   # no year, already passed: next year
            else:
                t = n.replace(hour=hh, minute=mm, second=0, microsecond=0)
                if t.timestamp() <= now: t += dt.timedelta(days=1)
            return t.timestamp()
    except Exception: return None
    return None
def ab_iso(t):
    import datetime as dt
    return dt.datetime.fromtimestamp(t, _et() or dt.timezone.utc).isoformat(timespec="seconds")
def ab_epoch(s_):
    import datetime as dt
    try: return dt.datetime.fromisoformat(str(s_)).timestamp()
    except Exception: return None
GITSAFE = R + "/bin/git-safe-env.sh"; GITSAFE_SHA = "7ecf153b007bf8254bb31ac51be9c1d4774178540d5cb1e93b1afc925453b544"   # RQ-GIT-SAFE rev4.1, dispatchd rev6.1
def ab_contained(w):   # REAPER-10 K2 containment of the .base worktree path, before any git call
    try:
        if not w.startswith("/") or any(c in (".", "..") for c in w.split("/")): return False
        if os.path.islink(w) or not os.path.isdir(w) or os.path.realpath(w) != w.rstrip("/"): return False
        root = os.path.realpath(WTROOT); par, name = os.path.split(w.rstrip("/"))
        if par != root or not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9._-]*", name): return False
        deny = [os.path.realpath(x) for x in (R, H + "/.codex", H + "/.codex-2", H + "/.phantom", H + "/Library/Keychains")]
        if any(w == d or w.startswith(d + "/") for d in deny): return False
        return not re.search(r"(?i)vault|/\.ashlr-runs/|/g1-pass/|/quarantine/", w + "/")
    except Exception: return False
def ab_gs_ok():   # rev4 B1: helper must be a regular non-symlink file with the pinned sha, else the outcome is unknown
    import hashlib, stat
    try:
        st = os.lstat(GITSAFE)
        if not stat.S_ISREG(st.st_mode): return False
        with open(GITSAFE, "rb") as f: return hashlib.sha256(f.read()).hexdigest() == GITSAFE_SHA
    except Exception: return False
def ab_git(wt, *a):   # read-only git through the pinned helper (gitlink/commondir, config and attribute checks first)
    import hashlib
    with open(GITSAFE, "rb") as f:
        if os.path.islink(GITSAFE) or hashlib.sha256(f.read()).hexdigest() != GITSAFE_SHA: raise RuntimeError("git-safe sha")
    env = {"HOME": H, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C"}
    r = subprocess.run(["/bin/bash", GITSAFE, "run", wt] + list(a), capture_output=True, text=True, timeout=30, env=env, stdin=subprocess.DEVNULL)
    if r.returncode or r.stdout.startswith("UNSAFE"): raise RuntimeError("git-safe refused")
    return r.stdout
def ab_run(j, b):   # -> (failed, work, src). src: None | "outcome_unreadable" (counted failed, hold capped 6h) | "unknown" (no hold)
    res = (re.findall(r"(?m)^RESULT .*$", rd("%s/%s.publish" % (R, j))) or [""])[-1]
    failed = res.startswith(("RESULT ABORT", "RESULT DENIED"))
    if res.startswith("RESULT PR "): return (failed, True, None)
    if res.startswith("RESULT EMPTY"): return (failed, False, None)
    if not ab_contained(b[2]): return (False, False, "unknown")   # rev3: refuse, no hold decision
    if not ab_gs_ok(): return (False, False, "helper_unavailable")   # rev4 B1: unknown, no hold
    if not re.fullmatch(r"[0-9a-f]{7,40}", b[0]): return (True, False, "outcome_unreadable")
    try:
        n = ab_git(b[2], "rev-list", "--count", b[0] + "..HEAD")
        st_ = ab_git(b[2], "status", "--porcelain", "-uall")
        dirty = [x for x in st_.splitlines() if not x.endswith("BRIDGE_NOTES.md")]
        return (failed, int(n.strip() or 0) > 0 or bool(dirty), None)
    except Exception: return (True, False, "outcome_unreadable")
def ab_unhold():
    for lane, s_ in slots.items():
        if not isinstance(s_, dict) or not s_.get("held") or s_.get("held_by") != AB_BY: continue
        u = ab_epoch(s_.get("held_until"))
        if u is not None and u > NOW: continue
        for k in ("held", "held_reason", "held_by", "held_until"): s_.pop(k, None)
        s_["last_change"] = NOW; ev("LANE_UNHOLD %s autobackoff expired" % lane)
def ab_scan(lane, alive_):
    s_ = slots[lane]; pats = AB_RX.get(AB_PROV.get(lane, ""))
    if not pats or (s_.get("held") and s_.get("held_by") != AB_BY): return   # manual hold: never touch
    for bp in glob.glob(R + "/*.base"):
        j = os.path.basename(bp)[:-5]
        if not JID.match(j) or j in alive_: continue
        b = rd(bp).split()
        if len(b) < 4 or b[3] != lane: continue
        lp = "%s/%s.log" % (R, j); mk = "%s/%s.autobackoff.seen" % (RUN, j)
        try:
            if os.path.getmtime(lp) < NOW - 1800 or os.path.exists(mk): continue
        except Exception: continue
        tail = "\n".join(logtail(lp, AB_TAIL).splitlines()[-60:])
        hit = next(((pid, m) for pid, rx in pats for m in [rx.search(tail)] if m), None)
        if not hit: continue
        pid, m = hit
        open(mk, "w").close()
        failed, work, osrc = ab_run(j, b)
        if osrc == "unknown":
            ev("USAGE_LIMIT_SEEN %s %s %s: worktree path refused (containment), no hold" % (lane, j, pid)); continue
        if osrc == "helper_unavailable":
            ev("USAGE_LIMIT_SEEN %s %s %s: helper_unavailable, no hold" % (lane, j, pid)); metric({"event": "autobackoff_skip", "lane": lane, "job": j, "pattern": pid, "src": "helper_unavailable"}); continue
        if work if lane == "codex-cmp" else (work and not failed):   # cmp: work never holds; others: failed or EMPTY only
            ev("USAGE_LIMIT_SEEN %s %s %s: run produced work, no hold" % (lane, j, pid)); continue
        ln = re.sub(r"^\[[0-9T:.\-]+Z?\]\s*", "", m.group(0))[:600]   # log timestamp prefix dropped
        rs = ab_reset(ln, NOW); src = "cli_line"
        if rs is None or rs <= NOW: rs = NOW + AB_DEF; src = "default"
        rs = min(rs, NOW + AB_CAP)   # rev5: every pattern, Claude |<epoch> included, capped at 24h
        if osrc == "outcome_unreadable": rs = min(rs, NOW + AB_DEF); src = "outcome_unreadable"   # rev3: own tag, <= 6h
        if s_.get("held"):   # existing auto hold: only ever extend
            cur = ab_epoch(s_.get("held_until"))
            if cur is not None and cur >= rs: continue
        until = ab_iso(rs)
        s_["held"] = True; s_["held_by"] = AB_BY; s_["held_until"] = until; s_["last_change"] = NOW
        s_["held_reason"] = "autobackoff %s job=%s until=%s src=%s" % (pid, j, until, src)
        ev("LANE_HOLD %s autobackoff pattern=%s job=%s until=%s src=%s" % (lane, pid, j, until, src))
        metric({"event": "autobackoff_hold", "lane": lane, "job": j, "pattern": pid, "until": until, "src": src})
ab_unhold()
# ---- resource autopilot (RQ-RESOURCE-AUTOPILOT): read-only disk, inode, swap-growth and devin readings
def _autopilot():
    try:
        return json.loads(subprocess.run(["/usr/bin/python3", R + "/bin/autopilot.py"], capture_output=True, text=True, timeout=20).stdout)
    except Exception: return None
AP = _autopilot()
# Lane disk gate (green|freeze|halve|yellow), NOT the cleanup level: compact_level only drives compact.sh.
# Missing or unknown (older autopilot, failed read) is yellow: raises frozen, no halving.
DISK_GATE = (AP or {}).get("lane_disk_gate") or "yellow"
if DISK_GATE not in ("green", "freeze", "halve"): DISK_GATE = "yellow"
PREV_DISK_GATE = rd(R + "/.autopilot-disk-gate").strip() if os.path.exists(R + "/.autopilot-disk-gate") else ""
if AP:   # devin limits: 10/3/16 by default (DEVIN-LEVERAGE-20261026); a devin block in budget-overrides.json overrides floor and ceiling
    lim = AP.get("devin", {}).get("limits") or {}
    for a in ("floor", "ceiling"):
        if isinstance(lim.get(a), int): slots["devin"][a] = lim[a]
hold = set(rd(R + "/HOLD").split())
def _ph_check():   # auto-release PUBLISH_HOLD once org Actions backlog < 50 queued runs; checks at most every 10 min
    ph, st = R + "/PUBLISH_HOLD", R + "/PUBLISH_HOLD.checked"
    if not os.path.exists(ph): return
    try:
        if time.time() - os.path.getmtime(st) < 600: return
    except FileNotFoundError: pass
    open(st, "w").close(); n = 0
    for rp in ("phantom", "phantom-secrets", "locus", "lexicon", "ashlr-md", "ashlr-stack", "ashlr-plugin"):
        try: n += int(subprocess.run(["gh", "api", "repos/ashlrai/%s/actions/runs?status=queued&per_page=1" % rp, "--jq", ".total_count"], capture_output=True, text=True, timeout=20).stdout.strip())
        except Exception: return
    open(R + "/PUBLISH_HOLD.queued", "w").write("%d %d\n" % (int(time.time()), n))
    if n < 50: os.replace(ph, ph + ".released-%d" % int(time.time()))
try: _ph_check()
except Exception: pass
pause = rd(R + "/PAUSE").strip() if os.path.exists(R + "/PAUSE") else ""
# ---- RQ-DISKGUARD-DRIP (a): below DISK_REUSE_ONLY_GB free on the runs volume, launch only kinds that reuse a worktree.
# Kind = the job id prefix after an optional "RQ-" (same convention as _prio). The PAUSE hard gate above is unchanged.
def _rc(j):   # RQ-FINISH-SIGNAL A: agent exit status written by launch.sh; missing or garbage -> None
    try:
        v = rd(RUN + "/" + j + ".rc").strip()
        return int(v) if re.fullmatch(r"-?[0-9]{1,6}", v) else None
    except Exception: return None
def _kind(j, kinds): return re.match(r"(?:RQ-)?(?:%s)(?:[-_]|$)" % "|".join(kinds), j) is not None
REUSE_KINDS = ("FIXUP", "LAND", "SALVAGE")
try: DISK_REUSE_ONLY_GB = float(os.environ.get("DISK_REUSE_ONLY_GB", "100"))
except ValueError: DISK_REUSE_ONLY_GB = 100.0
try:
    _sv = os.statvfs(R); disk_free_gb = _sv.f_bavail * _sv.f_frsize / 1e9
    if os.path.exists(R + "/DISKGUARD_TEST") and os.environ.get("DISKGUARD_FREE_GB"): disk_free_gb = float(os.environ["DISKGUARD_FREE_GB"])
except Exception: disk_free_gb = 0.0   # unreadable: fail closed to reuse-only
disk_reuse_only = disk_free_gb < DISK_REUSE_ONLY_GB
# ---- RQ-DISKGUARD-DRIP (b): phantom publish drip. While ashlrai/phantom has >= 150 open PRs, publish (reap) only
# LAND, FIXUP, CONSOLIDATE and CLOSE-* jobs there; others stay finished and local. Count cached 10 min in
# $R/phantom-open-prs ("<epoch> <n>"), fetched with the same gh CLI as _ph_check; unavailable -> filter on.
PH_DRIP_KINDS = ("LAND", "FIXUP", "CONSOLIDATE", "CLOSE-[A-Z0-9-]+"); PH_DRIP_MAX = 150; _ph_open = []
def _ph_open_prs():
    if _ph_open: return _ph_open[0]
    cp = R + "/phantom-open-prs"; n = None
    try:
        t, v = rd(cp).split()[:2]
        if time.time() - float(t) < 600: n = int(v)
    except Exception: n = None
    if n is None:
        try:
            n = int(subprocess.run(["gh", "api", "search/issues?q=repo:ashlrai/phantom+is:pr+is:open&per_page=1", "--jq", ".total_count"],
                                   capture_output=True, text=True, timeout=20).stdout.strip())
            open(cp + ".tmp", "w").write("%d %d\n" % (int(time.time()), n)); os.replace(cp + ".tmp", cp)
        except Exception: n = None
    _ph_open.append(n); return n
def _ph_drip_hold(j):   # True = hold this finished job in place (not dropped)
    repo = (rd(RUN + "/" + j + ".line").split("\t") + ["", ""])[1].strip()
    if repo and repo != "phantom": return False   # RQ-FINISH-SIGNAL C: missing/empty .line repo fails closed (filtered)
    if _kind(j, PH_DRIP_KINDS): return False
    n = _ph_open_prs(); return n is None or n >= PH_DRIP_MAX

# ---- memory
def mem():
    free = swap = None
    try:
        out = subprocess.run(["memory_pressure"], capture_output=True, text=True, timeout=10).stdout
        m = re.search(r"free percentage:\s*(\d+)", out); free = int(m.group(1)) if m else None
        out = subprocess.run(["sysctl", "-n", "vm.swapusage"], capture_output=True, text=True, timeout=5).stdout
        m = re.search(r"used = ([\d.]+)M", out); swap = float(m.group(1)) / 1024 if m else None
    except Exception: pass
    return free, swap
free, swap = mem()

# ---- liveness: map processes to jobs by cmdline and cwd
alive, publishing, cwdjobs = set(), set(), set()
pat_wt = re.compile(re.escape(WTROOT) + r"/([A-Za-z0-9._-]+)")
pat_pr = re.compile(re.escape(R) + r"/([A-Za-z0-9._-]+?)\.prompt\b")
pat_ln = re.compile(r"launch\.sh ([A-Za-z0-9._-]+) ")
pat_pb = re.compile(r"(?:publish|reap-one)\.sh ([A-Za-z0-9._-]+)")
ps = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True).stdout
for line in ps.splitlines():
    if "dispatchd.py" in line: continue
    m = pat_pb.search(line)
    if m: publishing.add(m.group(1)); continue
    for p in (pat_wt, pat_pr, pat_ln):
        m = p.search(line)
        if m: alive.add(m.group(1))
claude_live = any(rd(x).split()[3:4] in (["claude"], ["claude-api"]) and os.path.isdir(rd(x).split()[2]) for x in glob.glob(R + "/*.base"))
try:
    if not claude_live: raise RuntimeError("skip lsof")   # cwd scan only needed for claude (argv lacks the worktree)
    lo = subprocess.run(["lsof", "-nP", "-w", "-d", "cwd", "-Fn"], capture_output=True, text=True, timeout=20).stdout
    for line in lo.splitlines():
        if line.startswith("n"):
            m = pat_wt.match(line[1:])
            if m: cwdjobs.add(m.group(1))
except Exception: pass
for j in cwdjobs:
    b = rd("%s/%s.base" % (R, j)).split()
    if len(b) >= 4 and b[3] in ("claude", "claude-api"): alive.add(j)
reaping = {os.path.basename(p)[:-8] for p in glob.glob(RUN + "/*.reaping")}
publishing = {j for j in publishing if os.path.exists("%s/%s.base" % (R, j))}
alive -= (reaping | publishing)   # publish.sh children run inside the worktree
for p in glob.glob(RUN + "/*.dispatched"):   # launch grace (fetch/worktree add before agent starts)
    j = os.path.basename(p)[:-11]
    if NOW - os.path.getmtime(p) < GRACE: alive.add(j)

keep = set(rd(Q + "/keep.txt").split())
def result(j):
    r = [l for l in rd("%s/%s.publish" % (R, j)).splitlines() if l.startswith("RESULT")]
    return r[-1] if r else None
def base(j):
    b = rd("%s/%s.base" % (R, j)).split()
    return b if len(b) >= 4 else None

# ---- per-job launch outcome (requeue PAUSED/HELD launches)
requeue = []
for p in glob.glob(RUN + "/*.dispatched"):
    j = os.path.basename(p)[:-11]
    if j in alive: continue
    out = rd("%s/%s.launch" % (R, j))
    if "launched " in out: os.remove(p); continue
    if re.search(r"^(PAUSED|HELD)", out, re.M):
        ln = rd(RUN + "/" + j + ".line").strip()
        if ln: requeue.append(ln)
        ev("LAUNCH_DEFERRED %s %s (requeued)" % (j, out.split(":")[0].strip()))
    elif re.search(r"^SKIPPED: BRANCH_IN_WORKTREE", out, re.M):
        ev("LAUNCH_SKIPPED %s BRANCH_IN_WORKTREE (not a failure, not requeued; see %s.launch)" % (j, j))
    else:
        ev("LAUNCH_FAILED %s (see %s.launch)" % (j, j))
    os.remove(p)

# ---- (a) reap
running = {l: 0 for l in LANES}; kept = []; nreap = len(reaping); local_mid = 0
def _is_local_mid(j): return (rd(RUN + "/" + j + ".line").split("\t") + ["", "", "", ""])[3].strip() == "mid"
# PUBLISH_DRIP (Masbot 22:30 Oct 26): pace pushes after the Actions stall; LAND/FIXUP first, <=10 per 5 min, none while queued runs >= 150
DRIP = os.path.exists(R + "/PUBLISH_DRIP"); DRIPLOG = RUN + "/publish-drip.tsv"; drip_budget = 10**6
if DRIP:
    try: dq = int((rd(R + "/PUBLISH_DRIP").split() or ["0"])[0])
    except Exception: dq = 0
    try: drecent = [float(x) for x in rd(DRIPLOG).split() if NOW - float(x) < 300]
    except Exception: drecent = []
    drip_budget = 0 if dq >= 150 else max(0, 10 - len(drecent))
def _prio(bp):   # 11.1-DESK: REL 0, DESK 1, LAND/FIXUP/RECUT 2, rest 3
    j = os.path.basename(bp)[:-5]
    return (0 if j.startswith("RQ-REL-") else 1 if j.startswith("RQ-DESK-") else 2 if re.match(r"(LAND|FIXUP|RECUT|RQ-FIXUP|RQ-LAND)", j) else 3, bp)
LANDONLY_PREFIXES = ("RQ-DESK-",)   # fixed strings in code; never read from the file
def _landonly_ids():   # exact tokens only (whitespace-split, as before); tokens that are not valid job ids are ignored
    return {t for t in rd(R + "/PUBLISH_LANDONLY").split() if JID.match(t)}
def _landonly_ok(j): return j in _landonly_ids() or j.startswith(LANDONLY_PREFIXES)
for bp in sorted(glob.glob(R + "/*.base"), key=_prio):
    j = os.path.basename(bp)[:-5]; b = base(j)
    if not b or not JID.match(j): continue
    wt, pool = b[2], b[3]
    if j in alive:
        if pool in running: running[pool] += 1
        if pool == "codex-local" and _is_local_mid(j): local_mid += 1
        continue
    if not os.path.isdir(wt) or j in reaping or j in publishing: continue
    try: recent = max(os.path.getmtime(bp), os.path.getmtime("%s/%s.log" % (R, j)) if os.path.exists("%s/%s.log" % (R, j)) else 0)
    except Exception: recent = NOW
    if NOW - recent < 180 or not os.path.exists("%s/%s.log" % (R, j)):   # fresh launch by anyone (routine or us): not finished
        if pool in running: running[pool] += 1
        if pool == "codex-local" and _is_local_mid(j): local_mid += 1
        continue
    res = result(j)
    if j in keep or (res and not res.startswith(("RESULT PR", "RESULT EMPTY"))):
        kept.append(j)
        mk = RUN + "/" + j + ".keptlogged"
        if not os.path.exists(mk):
            open(mk, "w").close()
            ev(("PUBLISH_ABORT_SECRET_SHAPE %s worktree kept for supervisor" if res and "PUBLISH-ABORT" in res
                else "KEPT %s worktree kept for supervisor") % j)
        continue
    if os.path.exists(R + "/PUBLISH_HOLD"): continue   # Actions backlog: keep finished worktrees local, publish later
    if os.path.exists(R + "/PUBLISH_LANDONLY") and _prio(bp)[0] > 2 and not _landonly_ok(j) and not os.path.exists(R + "/g1-pass/" + j + ".pass"): continue   # Masbot 23:45 Oct 26: merge-rate first; only REL/LAND/FIXUP/RECUT, G1-passed and listed jobs publish
    if nreap >= MAX_REAPS: continue
    if _ph_drip_hold(j):
        mk = RUN + "/" + j + ".phdrip"
        if not os.path.exists(mk): open(mk, "w").close(); ev("PHANTOM_DRIP hold %s open_prs=%s" % (j, _ph_open_prs()))
        continue
    if DRIP:
        if drip_budget <= 0: continue
        drip_budget -= 1; open(DRIPLOG, "a").write("%f\n" % NOW)
    os.mkdir(RUN + "/" + j + ".reaping"); nreap += 1
    try:
        lp = "%s/%s.log" % (R, j); tl = logtail(lp, 20000)
        st_ = subprocess.run(["git", "-C", wt, "diff", "--shortstat", b[0]], capture_output=True, text=True, timeout=30).stdout
        nf = len([x for x in subprocess.run(["git", "-C", wt, "status", "--porcelain", "-uall"], capture_output=True, text=True, timeout=30).stdout.splitlines() if not x.endswith("BRIDGE_NOTES.md")])
        ins = re.search(r"(\d+) insertion", st_); dele = re.search(r"(\d+) deletion", st_)
        metric({"event": "finish", "job": j, "lane": pool, "wall_s": int(os.path.getmtime(lp) - os.path.getmtime(bp)) if os.path.exists(lp) else None,
                "exit_code": _rc(j), "tokens_total": tokens(tl), "tokens_in": None, "tokens_out": None, "cost": None,
                "diff_files": nf, "diff_lines": (int(ins.group(1)) if ins else 0) + (int(dele.group(1)) if dele else 0), "empty": nf == 0,
                "pool_error": next((c for c, rx in CLS if any(rx.search(t) for t in errlines(tl.splitlines()[-30:]))), None)})
    except Exception as e: log("metric finish err %s %s" % (j, type(e).__name__))
    subprocess.Popen(["/bin/bash", R + "/bin/reap-one.sh", j], stdin=subprocess.DEVNULL,
                     stdout=open(RUN + "/" + j + ".reap.log", "a"), stderr=subprocess.STDOUT, start_new_session=True)
    log("REAP %s (%s)" % (j, pool))

# ---- (c) adapt
def ratelimited(lane, since):
    for bp in glob.glob(R + "/*.base"):
        j = os.path.basename(bp)[:-5]; b = base(j)
        if not b or b[3] != lane: continue
        lp = "%s/%s.log" % (R, j)
        try:
            if os.path.getmtime(lp) <= max(since, NOW - 1800): continue
            with open(lp, "rb") as f:
                f.seek(0, 2); n = f.tell(); f.seek(max(0, n - 6000))
                tail = errlines(f.read().decode("utf-8", "replace").splitlines()[-30:])
            for c, rx in CLS:
                if any(rx.search(t) for t in tail):
                    mk = RUN + "/" + j + "." + c + ".seen"
                    if os.path.exists(mk): continue
                    open(mk, "w").close(); return (j, c)
        except Exception: pass
    return None

# ---- precheck: returns (code, reason) to skip, None to launch. Timeout/error/usage -> launch.
PC_MAX = 8
def precheck(j, repo, pf):
    try:
        task = next((t for t in rd(pf).splitlines() if t.startswith(j + " (")), "")
        if not task: return None
        env = {k: os.environ[k] for k in ("HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG") if k in os.environ}
        env["GIT_TERMINAL_PROMPT"] = "0"
        r = subprocess.run(["/bin/bash", R + "/bin/precheck.sh", task, H + "/Projects/ashlrai/" + repo],
                           stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=20, env=env, cwd=H)
        if r.returncode in (10, 11, 12, 13):
            m = re.search(r"reason=(\S+)", r.stdout); return (r.returncode, m.group(1) if m else "?")
    except Exception:
        pass
    return None

# ---- queue
def qlock():
    fd = open(Q + "/ready.lock", "a"); fcntl.flock(fd, fcntl.LOCK_EX); return fd
lk = qlock()
lines = [l for l in rd(Q + "/ready.tsv").splitlines() if l.strip() and not l.startswith("#")] + requeue
qdepth = {l: 0 for l in LANES}
for l in lines:
    f = l.split("\t")
    if len(f) >= 3 and f[2] in qdepth: qdepth[f[2]] += 1

def api_pace():   # claude-api: slot target comes from the credit burn plan, not memory pressure
    try:
        return json.loads(subprocess.run(["/usr/bin/python3", R + "/bin/claude-api.py", "pace", "--json"], capture_output=True,
                                         text=True, timeout=20).stdout)
    except Exception: return {"target": 0, "held": True, "reason": "claude-api.py pace failed"}
_dv = None
def _devin_spike():   # DEVIN-LEVERAGE-20261026, computed in dispatchd itself (Masbot 21:19): the same
    global _dv          # last-10 devin finish scan bin/autopilot.py publishes, kept here so a down
    if _dv is None:     # autopilot never leaves the spike check unrun. Cached once per tick.
        rows = []
        for l in rd(MD + "/jobs.jsonl").splitlines():
            try: rows.append(json.loads(l))
            except Exception: pass
        pub = {r.get("job") for r in rows if r.get("event") == "publish" and r.get("url")}
        fin = [r for r in rows if r.get("event") == "finish" and r.get("lane") == "devin"][-DEVIN_STEP["window"]:]
        _dv = {"last_n": len(fin), "last_job": fin[-1].get("job") if fin else None,
               "non_pr": sum(1 for r in fin if r.get("empty") or r.get("job") not in pub)}
        _dv["step_down"] = len(fin) >= DEVIN_STEP["window"] and _dv["non_pr"] > DEVIN_STEP["max_non_pr"]
    return _dv
for lane in LANES:
    try: ab_scan(lane, alive)
    except Exception as e: log("autobackoff err %s %s" % (lane, type(e).__name__))
for lane in LANES:
    s = slots[lane]
    if lane == "claude-api":
        ap = api_pace(); nt = max(0, min(int(ap.get("target") or 0), s["ceiling"]))
        if nt != s["target"]: ev("SLOTS %s %d->%d paced (pool=%s need=$%s/h)" % (lane, s["target"], nt, ap.get("pool"), ap.get("need_usd_per_hour")))
        s["target"] = nt; s["api_pool"] = ap.get("pool"); s["api_reason"] = ap.get("reason")
        if s.get("held") or lane in hold: continue
        hit = ratelimited(lane, s["last_change"])
        if hit and hit[1] == "credits_exhausted":
            s["held"] = True; s["held_reason"] = "credits exhausted (%s %s)" % (hit[0], TS); s["last_change"] = NOW
            ev("LANE_HOLD %s credits exhausted (%s); supervisor clears held in slots.json" % (lane, hit[0]))
        continue
    if s.get("held") or lane in hold: continue
    hit = ratelimited(lane, s["last_change"])
    if hit:
        metric({"event": "pool", "lane": lane, "job": hit[0], "kind": hit[1], "mem_free_pct": free, "swap_gb": swap})
    if hit and hit[1] == "credits_exhausted":
        s["held"] = True; s["held_reason"] = "credits exhausted (%s %s)" % (hit[0], TS); s["last_change"] = NOW
        ev("LANE_HOLD %s credits exhausted (%s); supervisor clears held in slots.json" % (lane, hit[0])); continue
    if hit and hit[1] == "model_capacity":
        ev("MODEL_CAPACITY_SEEN %s %s (no slot change)" % (lane, hit[0])); hit = None
    if hit and hit[1] in ("usage_limit",) and lane == "codex-cmp":
        s["last_change"] = NOW; ev("USAGE_LIMIT_SEEN %s %s: continuing on credits" % (lane, hit[0])); hit = None
    if hit:
        nt = max(s["floor"], s["target"] // 2)
        s["last_change"] = NOW
        if nt != s["target"]:
            ev("SLOTS %s %d->%d %s seen (%s)" % (lane, s["target"], nt, hit[1], hit[0])); s["target"] = nt
    elif (running[lane] >= s["target"] and qdepth[lane] > 0 and s["target"] < s["ceiling"]
          and DISK_GATE == "green"
          and (AP["memory"]["raise_ok"] if AP and AP.get("memory", {}).get("known")
               else (free is not None and free > 30))   # fallback when autopilot is unavailable: free memory only, no absolute swap block
          and NOW - s["last_change"] >= RAISE_GAP):
        nt = min(s["ceiling"], s["target"] + 2)
        ev("SLOTS %s %d->%d (free=%s%% swap=%.1fG)" % (lane, s["target"], nt, free, swap or 0))
        s["target"] = nt; s["last_change"] = NOW
    if lane == "devin":   # more than 3 of the last 10 devin runs without a PR: -2, floor 6, once per new finish
        dv = _devin_spike()
        if dv["step_down"] and dv["last_job"] and dv["last_job"] != s.get("step_seen"):
            nt = min(s["target"], max(DEVIN_STEP["floor"], s["target"] - DEVIN_STEP["step"]))
            s["step_seen"] = dv["last_job"]
            if nt != s["target"]:
                ev("SLOTS devin %d->%d step-down (%d of last %d without PR)" % (s["target"], nt, dv["non_pr"], dv["last_n"]))
                s["target"] = nt; s["last_change"] = NOW
    if lane != "claude-api" and DISK_GATE == "halve" and PREV_DISK_GATE != "halve":
        nt = max(s["floor"], s["target"] // 2)
        if nt != s["target"]: ev("SLOTS %s %d->%d disk gate halve" % (lane, s["target"], nt)); s["target"] = nt; s["last_change"] = NOW
    if s["target"] < s["floor"]: s["target"] = s["floor"]
try:   # atomic; a failed write never breaks the tick (rev2 A4)
    _dl = R + "/.autopilot-disk-gate.tmp"; open(_dl, "w").write(DISK_GATE + "\n"); os.replace(_dl, R + "/.autopilot-disk-gate")
except Exception as e: log("autopilot disk-level write failed %s" % type(e).__name__)

# ---- (b) fill
launched = []; rest = []; bad = 0
if not pause:
    # interleave lanes so neither starves: take candidates round-robin, cmp first
    cand = {l: [] for l in LANES}
    for l in lines:
        f = l.split("\t")
        ok = (len(f) >= 5 and JID.match(f[0]) and f[2] in LANES and f[3] in TIERS
              and os.path.isdir(H + "/Projects/ashlrai/" + f[1]) and "/" not in f[1]
              and os.path.realpath(f[4]).startswith(Q + "/prompts/") and os.path.isfile(f[4]))
        if not ok:
            rest.append(l); bad += 1; continue
        cand[f[2]].append(f)
    order = []
    while any(cand.values()):
        for ln in LANES:
            if cand[ln]: order.append(cand[ln].pop(0))
    seen = set(); pc_n = 0; local_ok = None
    def _local_healthy():   # one GET per tick; any error, timeout or non-200 -> unhealthy. Env proxies ignored.
        import urllib.request
        try:
            op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with op.open(urllib.request.Request(LOCAL_HEALTH, method="GET"), timeout=2) as r: return r.status == 200
        except Exception: return False
    # Launch-time re-check: a ready.tsv line can outlive its router line (claimed, then RETIRED by the EO).
    # Skip a job whose router line is RETIRED (exact id) or that is listed in queue/RETIRED (one id per line).
    # Fail closed for this check only: if router-queue.md is unreadable, skip launches this tick.
    rq = rd(Q + "/router-queue.md", None)
    retired_ids = set(rd(Q + "/RETIRED").split())
    def retired(j):
        if rq is None: return "router-queue.md unreadable"
        if j in retired_ids: return "listed in queue/RETIRED"
        if re.search(r"^- RETIRED (?:\S+ )*?%s[ \[(]" % re.escape(j), rq, re.M): return "RETIRED in router-queue.md"
        return None
    for f in order:
        j, repo, lane, tier, pf = f[:5]; line = "\t".join(f)
        s = slots[lane]; res = result(j)
        if j in seen: continue  # duplicate line
        why = retired(j)
        if why:
            if rq is None: ev("SKIP_RETIRED_CHECK %s held (%s)" % (j, why)); rest.append(line); seen.add(j); continue
            ev("SKIP_RETIRED %s dropped from ready.tsv (%s)" % (j, why)); seen.add(j); continue
        if res and res.startswith("RESULT PR"):
            ev("SKIP_DONE %s already has a PR" % j); seen.add(j); continue
        if disk_reuse_only and not _kind(j, REUSE_KINDS):
            mk = RUN + "/" + j + ".diskguard"
            if not os.path.exists(mk): open(mk, "w").close(); ev("DISKGUARD defer %s %dG" % (j, disk_free_gb))
            rest.append(line); seen.add(j); continue
        if (len(launched) >= MAX_LAUNCH_PER_TICK or s.get("held") or lane in hold
                or running[lane] >= s["target"] or j in alive or j in reaping or j in publishing):
            rest.append(line); seen.add(j); continue
        if lane == "codex-local":
            if tier == "mid" and local_mid >= LOCAL_MID_CAP: rest.append(line); seen.add(j); continue
            if local_ok is None:
                local_ok = _local_healthy()
                if not local_ok: ev("codex-local unhealthy (%s); codex-local jobs requeued this tick" % LOCAL_HEALTH)
            if not local_ok: rest.append(line); seen.add(j); continue
        wt = WTROOT + "/" + j
        if os.path.isdir(wt) and not (j in keep or (res and not res.startswith(("RESULT PR", "RESULT EMPTY")))):
            rest.append(line); seen.add(j); continue   # finished worktree awaiting reap: never double up
        seen.add(j)
        if pc_n < PC_MAX:   # empty-run precheck (contrib/precheck.sh): no model call, fail open
            pc_n += 1; pc = precheck(j, repo, pf)
            if pc:
                open(Q + "/precheck-skips.tsv", "a").write("%s\t%s\t%d\t%s\n" % (TS, j, pc[0], pc[1]))
                metric({"event": "precheck_skip", "job": j, "repo": repo, "lane": lane, "code": pc[0]})
                ev("DONE-NOOP %s [precheck code=%d %s]" % (j, pc[0], pc[1])); continue
        if os.path.exists("%s/%s.publish" % (R, j)):   # relaunch on a kept worktree: archive old result
            os.replace("%s/%s.publish" % (R, j), "%s/%s.publish.prev-%d" % (R, j, NOW))
        if j in keep:
            keep.discard(j); open(Q + "/keep.txt", "w").write("\n".join(sorted(keep)) + "\n")
        for x in (".keptlogged", ".diskguard", ".phdrip", ".rc"):
            try: os.remove(RUN + "/" + j + x)
            except FileNotFoundError: pass
        open(RUN + "/" + j + ".line", "w").write(line + "\n")
        open(RUN + "/" + j + ".dispatched", "w").write(str(int(NOW)))
        env = {k: os.environ[k] for k in ("HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG") if k in os.environ}
        subprocess.Popen(["/bin/bash", R + "/bin/launch.sh", j, repo, lane, tier], stdin=open(pf),
                         stdout=open("%s/%s.launch" % (R, j), "w"), stderr=subprocess.STDOUT,
                         env=env, start_new_session=True, cwd=H)
        fam = "codex" if lane.startswith("codex") and lane != "codex-local" else lane
        mj = jload(R + "/models.json", {}); model = mj.get(fam + "." + tier) or mj.get(fam)
        metric({"event": "launch", "job": j, "repo": repo, "lane": lane, "tier": tier, "model": model, "mem_free_pct": free, "swap_gb": swap})
        running[lane] += 1; local_mid += lane == "codex-local" and tier == "mid"; launched.append(j); ev("LAUNCH %s %s %s %s" % (j, repo, lane, tier))
else:
    rest = lines
t = Q + "/ready.tsv.tmp"; open(t, "w").write("".join(l + "\n" for l in rest)); os.replace(t, Q + "/ready.tsv")
lk.close()
jsave(Q + "/slots.json", slots)

# ---- restock trigger: a codex lane's queue below 3x its free slots -> Mac-side deterministic restocker (no LLM)
for lane in ("codex-cmp", "codex-personal", "devin", "claude-api", "codex-local"):
    sl = slots[lane]
    if sl.get("held") or lane in hold: continue
    qn = sum(1 for l in rest if l.split("\t")[2:3] == [lane])
    if qn < 3 * max(sl["target"] - running[lane], 4) and os.path.exists(Q + "/router-queue.md") and not os.path.exists(Q + "/RESTOCK_OFF"):
        subprocess.Popen(["/bin/bash", R + "/bin/restock.sh"], stdin=subprocess.DEVNULL, stdout=open(Q + "/restock.log", "a"),
                         stderr=subprocess.STDOUT, start_new_session=True)
        break
# ---- (d) status
qdepth = {l: 0 for l in LANES}
for l in rest:
    f = l.split("\t")
    if len(f) >= 3 and f[2] in qdepth: qdepth[f[2]] += 1
pubs = []
for p in glob.glob(R + "/*.publish"):
    if NOW - os.path.getmtime(p) > 86400: continue
    m = re.search(r"RESULT PR (https://github.com/\S+/pull/\d+)", rd(p))
    if m: pubs.append((os.path.getmtime(p), os.path.basename(p)[:-8], m.group(1)))
pubs.sort(reverse=True)
evs = rd(EV).splitlines()[-25:]
st = {"schema": "dispatchd.status.v1", "last_tick": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "paused": pause or None,
      "mem_free_pct": free, "swap_gb": round(swap, 2) if swap is not None else None,
      "autopilot": AP,
      "lanes": {l: {"running": running[l], "target": slots[l]["target"], "floor": slots[l]["floor"],
                    "ceiling": slots[l]["ceiling"], "held": bool(slots[l].get("held") or l in hold),
                    "queued": qdepth[l]} for l in LANES},
      "queue_depth": len(rest), "invalid_queue_lines": bad, "launched_this_tick": launched,
      "reaping": sorted(set(reaping) | publishing), "kept_worktrees": sorted(kept),
      "publishes_24h": len(pubs), "recent_publishes": [{"job": j, "url": u} for _, j, u in pubs[:20]],
      "recent_events": evs}
# budget per lane: overrides file (Grok Bot writes Mason's readings) + log-derived token burn
ov = jload(Q + "/budget-overrides.json", {}); budget = {}
mets = []
for l in rd(MD + "/jobs.jsonl").splitlines():
    try: mets.append(json.loads(l))
    except Exception: pass
def epoch(t):
    try: return time.mktime(time.strptime(t[:19], "%Y-%m-%dT%H:%M:%S"))
    except Exception: return 0
for l in LANES:
    o = dict(ov.get(l, {}))
    tok6 = sum((m.get("tokens_total") or 0) for m in mets if m.get("event") == "finish" and m.get("lane") == l and NOW - epoch(m.get("ts", "")) < 6 * 3600)
    o["tokens_per_hour_6h"] = int(tok6 / 6)
    bph = o.get("burn_pct_per_hour")
    if o.get("weekly_used_pct") is not None and bph:
        o["projected_exhaustion"] = time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(NOW + (100 - o["weekly_used_pct"]) / bph * 3600))
    o.setdefault("projected_exhaustion", None); o["burn_per_hour"] = bph
    for k in ("weekly_used_pct", "credits_remaining", "reset_at", "source"): o.setdefault(k, None)
    budget[l] = o
try:
    budget["claude-api"].update(json.loads(subprocess.run(["/usr/bin/python3", R + "/bin/claude-api.py", "report", "--json"],
                                                          capture_output=True, text=True, timeout=20).stdout))
except Exception: pass
st["budget"] = budget
# 24h rollup by lane and tier
out = {}
for m in mets:
    if m.get("event") == "outcome": out[m.get("url")] = m
pubj = {m["job"]: m.get("url") for m in mets if m.get("event") == "publish" and m.get("url")}
L24 = [m for m in mets if m.get("event") == "launch" and NOW - epoch(m.get("ts", "")) < 86400]
fin = {m["job"]: m for m in mets if m.get("event") == "finish"}
def roll(key):
    g = {}
    for m in L24:
        k = m.get(key); r = g.setdefault(k, {"jobs": 0, "finished": 0, "empty": 0, "merged": 0, "tokens_merged": 0, "ttm": []})
        r["jobs"] += 1; f = fin.get(m["job"])
        if f: r["finished"] += 1; r["empty"] += 1 if f.get("empty") else 0
        o = out.get(pubj.get(m["job"]))
        if o and o.get("state") == "MERGED":
            r["merged"] += 1; r["tokens_merged"] += (f or {}).get("tokens_total") or 0
            if o.get("ttm_s") is not None: r["ttm"].append(o["ttm_s"])
    for k, r in g.items():
        t = sorted(r.pop("ttm")); r["median_ttm_s"] = t[len(t) // 2] if t else None
        r["merge_rate"] = round(r["merged"] / r["finished"], 3) if r["finished"] else None
        tm = r.pop("tokens_merged"); r["tokens_per_merged_pr"] = int(tm / r["merged"]) if r["merged"] else None
        r["empty_rate"] = round(r["empty"] / r["finished"], 3) if r["finished"] else None
    return g
st["rollup_24h"] = {"by_lane": roll("lane"), "by_tier": roll("tier")}
stamp = MD + "/.outcomes.stamp"
if not os.path.exists(stamp) or NOW - os.path.getmtime(stamp) > 600:
    open(stamp, "w").close()
    subprocess.Popen(["/bin/bash", R + "/bin/metrics-outcomes.sh"], stdin=subprocess.DEVNULL, stdout=open(MD + "/outcomes.log", "a"),
                     stderr=subprocess.STDOUT, start_new_session=True)
jsave(Q + "/status.json", st)
log("tick run=%s q=%d launched=%d reap=%d pause=%s" % (json.dumps(running), len(rest), len(launched), nreap, bool(pause)))
