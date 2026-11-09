#!/usr/bin/python3
# dispatchd core (one tick). Run only via dispatchd.sh (lockf). No LLM calls, no network of its own.
# Single source for ~/.ashlr-runs/bin/dispatchd.py (RQ-MACDISPATCH-RECONCILE): contrib/mac/install.sh diffs and
# installs this file; selfrun.sh sha-pins the installed copy under G1-CODE-PIN, so Security re-pins on every change.
# RQ-DEVINROUTEDEFAULTQ7 + DEVIN-LEVERAGE-20261026 rev: devin sits in the restock trigger loop and the failure-spike
# step-down is computed in dispatchd itself (Masbot 21:19 Oct 26); devin defaults stay target 6, floor 3, ceiling 10,
# hard_cap 10 (the live values; a slots.json or budget-overrides.json entry raises them per host).
# RQ-LANERECOVERNOV1Q8 rev: repeated authentication failures (>=2 distinct failed/EMPTY finishes with a
# provider auth-error line) hold the lane autobackoff-style; no credential store is ever written.
import os, re, json, time, fcntl, subprocess, glob, math, datetime
from concurrent.futures import ThreadPoolExecutor
H = os.path.expanduser("~"); R = H + "/.ashlr-runs"; Q = R + "/queue"; RUN = Q + "/run"
WTROOT = H + "/Projects/ashlrai/wt"; EV = R + "/dispatch-events.log"
# A kernel-held claim serializes the complete tick, including liveness sampling and
# queue reconciliation. It is released automatically if the dispatcher crashes.
_tick_claim = open(Q + "/dispatchd.tick.lock", "a")
try: fcntl.flock(_tick_claim, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError: raise SystemExit(0)
NOW = time.time(); TS = time.strftime("%F %T")
MAX_LAUNCH_PER_TICK = 4; GRACE = 120; RAISE_GAP = 120
LANES = ["codex-cmp", "codex-personal", "claude", "devin", "claude-api", "codex-local"]   # tie-break order: cmp first
# hard_cap (RQ-LOADGATE-1): per-pool absolute bound, seeded to the ceiling so nothing changes until an operator lowers it in
# slots.json. Neither the floor, the autopilot overrides, the +2 ramp nor a stored target may exceed it.
# RQ-QUEUE-BATCH-1: the fleet-wide cap adapts every tick (concurrency.py); a top-level slots.json "hard_cap" is an
# optional operator ceiling over it. Related ready tasks launch together as one RQ-BATCH-* session (batcher.py).
DEFAULT = {"codex-cmp": {"target": 10, "floor": 10, "ceiling": 32, "hard_cap": 32},
           "codex-personal": {"target": 10, "floor": 10, "ceiling": 32, "hard_cap": 32},
           "claude": {"target": 0, "floor": 0, "ceiling": 8, "hard_cap": 8},
           "devin": {"target": 6, "floor": 3, "ceiling": 10, "hard_cap": 10},   # DEVIN-LEVERAGE-20261026
           "claude-api": {"target": 4, "floor": 0, "ceiling": 8, "hard_cap": 8},   # target is re-paced every tick by claude-api.py
           "codex-local": {"target": 6, "floor": 0, "ceiling": 6, "hard_cap": 6}}   # RQ-LOCAL-LANE: oMLX on this Mac, 6 total
import concurrency, batcher
# Starvation thresholds; load, process count and live worktree count only warn.
def gate_limit(name, default):
    try:
        value = float(os.environ.get(name, default))
        return value if math.isfinite(value) and value > 0 else default
    except ValueError: return default
GATE_LOAD_PER_CPU = gate_limit("GATE_LOAD_PER_CPU", 3.0)
GATE_PROCS_MAX = gate_limit("GATE_PROCS_MAX", 2500); GATE_WORKTREES_MAX = gate_limit("GATE_WORKTREES_MAX", 40)
GATE_PRESSURE_MIN = gate_limit("GATE_PRESSURE_MIN", 4); GATE_SWAP_GROWTH_GB = gate_limit("GATE_SWAP_GROWTH_GB", 2)
GATE_SWAP_WINDOW_S = gate_limit("GATE_SWAP_WINDOW_S", 300); GATE_TICK_MAX_S = gate_limit("GATE_TICK_MAX_S", 900)
GATE_STATUS_TIMEOUT = gate_limit("GATE_STATUS_TIMEOUT", 30)
LOCAL_HEALTH = "http://127.0.0.1:8123/v1/models"   # loopback only, no auth header, 2 s timeout, checked at most once per tick
TIERS = {"frontier", "work", "mid", "fast"}
# DEVIN-LEVERAGE-20261026 step-down (Masbot 21:19 Oct 26): more than 3 non-PR outcomes (abort or
# empty) in the last 10 devin completions steps the target down 2, never below 6; the approved
# spike bar sits well over the 5% baseline (2 of 40).
DEVIN_STEP = {"window": 10, "max_non_pr": 3, "step": 2, "floor": 6}
# ---- RQ-TICK-BUDGET (Masbot 18:10 Oct 27): ticks grew to ~10 min. subprocess.run(timeout=) kills only the direct
# child and leaves grandchildren (git fetch under precheck.sh, git under git-safe) running and piling up. _run kills
# the whole process group and logs any call over 5 s as SLOW. TICK_BUDGET_S caps the optional per-tick work.
try: TICK_BUDGET_S = float(os.environ.get("TICK_BUDGET_S", "90"))
except ValueError: TICK_BUDGET_S = 90.0
def over_budget(): return time.time() - NOW > TICK_BUDGET_S
def _run(cmd, timeout, **kw):
    import signal
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True,
                         stdin=kw.pop("stdin", subprocess.DEVNULL), **kw)
    name = os.path.basename(cmd[1] if cmd[0].endswith("bash") and len(cmd) > 1 else cmd[0]); t0 = time.time()
    try: out, err = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try: os.killpg(p.pid, signal.SIGKILL)
        except OSError: pass
        try: p.communicate(timeout=0.1)
        except subprocess.TimeoutExpired:
            for pipe in (p.stdout, p.stderr):
                if pipe: pipe.close()
        log("SLOW %s timeout %ds, group killed" % (name, timeout)); raise
    if time.time() - t0 > 5: log("SLOW %s %.0fs" % (name, time.time() - t0))
    return subprocess.CompletedProcess(cmd, p.returncode, out, err)
def job_diff_metrics(wt, job_base):
    # Compare the final tracked tree to the launch base, including commits and
    # staged edits. Untracked files count as files, but their line totals are
    # unavailable; do not silently report a partial total as a measurement.
    unknown = (None, None, None)
    try:
        pathspec = ["--", ".", ":(exclude,top)BRIDGE_NOTES.md"]
        diff = _run(["git", "-C", wt, "-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", "-z", job_base] + pathspec, 30)
        untracked = _run(["git", "-C", wt, "ls-files", "--others", "--exclude-standard", "-z"] + pathspec, 30)
        if diff.returncode or untracked.returncode: return unknown
        entries = diff.stdout.split("\0")
        if entries.pop() != "": return unknown
        extra = untracked.stdout.split("\0")
        if extra.pop() != "": return unknown
        lines = 0; paths = set()
        for entry in entries:
            fields = entry.split("\t", 2)
            if len(fields) != 3 or not fields[2]: return unknown
            paths.add(fields[2])
            if fields[:2] == ["-", "-"]: lines = None
            elif not all(x.isascii() and x.isdigit() for x in fields[:2]): return unknown
            elif lines is not None: lines += int(fields[0]) + int(fields[1])
        count = len(paths.union(extra))
        return count, None if extra else lines, count == 0
    except (OSError, subprocess.SubprocessError, ValueError, UnicodeError): return unknown
JID = re.compile(r"^[A-Za-z0-9._-]+$")
# A launcher that could not fork (EAGAIN/ENOMEM, the per-user process limit) is the concurrency controller's
# strongest backoff signal: it means the host is already past its limit.
FORK_RX = re.compile(r"(?i)(fork: (retry: )?resource temporarily unavailable|cannot fork|cannot allocate memory|"
                     r"BlockingIOError|\[Errno (11|12|35)\]|too many processes)")
RL = re.compile(r"(?i)(429 too many requests|status(code)?[\s:=\"]+429\b|rate[ _-]?limit (reached|exceeded|hit)|exceeded (your|the) .{0,20}rate limit|usage limit|you've hit your|quota exceeded)")

MD = R + "/metrics"; os.makedirs(MD, exist_ok=True)
# RQ-SWE5-LOOP-BENCH: the ledger was read three times per tick (attempts scan, devin
# spike, status rollup) plus once more for batch throughput. Parse once into
# JOBS_RAW; JOBS holds the projected view (reconciler rows). Once _JOBS_LIVE is set
# at the parse point, metric() also mirrors this tick's own rows in memory exactly
# as a file re-read would see them.
JOBS_RAW, JOBS = [], []
_JOBS_LIVE = False
def metric(d):
    d.setdefault("ts", time.strftime("%Y-%m-%dT%H:%M:%S%z"))
    if d.get("job") and "ab" not in d:   # Masbot 16:35: tag A/B arm from the router line (TERRA-AB-1)
        try:
            m = re.search(r"^- \S+ (?:\S+ )*?%s \(([^)]*)\)" % re.escape(d["job"]), rd(Q + "/router-queue.md"), re.M)
            a = m and re.search(r"\bab=(\S+?)[,)\s]", m.group(1) + ")"); b = m and re.search(r"\barm=(\S+?)[,)\s]", m.group(1) + ")")
            if a: d["ab"] = a.group(1)
            if b: d["arm"] = b.group(1)
        except Exception: pass
    if _JOBS_LIVE: JOBS_RAW.append(d); JOBS.append(d)
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
# RQ-SWE5-LOOP-BENCH: queue metadata (.line/.base/.publish/prompts) is re-read
# many times per job per tick. Cache reads keyed on (mtime_ns, size): a mid-tick
# rewrite by launch.sh or a publisher invalidates exactly as a fresh read would.
# Misses are never cached, so a file created mid-tick is still seen.
_RD = {}
def rd(p, d=""):
    try:
        st = os.stat(p)
        hit = _RD.get(p)
        if hit is not None and hit[0] == (st.st_mtime_ns, st.st_size): return hit[1]
        with open(p) as f: text = f.read()
        _RD[p] = ((st.st_mtime_ns, st.st_size), text)
        return text
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
def _cap(v, d):   # a hard_cap is a non-negative int; anything else (missing, bool, garbage) falls back to the default
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else d
# The retired fixed cap was seeded into slots.json as hard_cap 18; drop that seed once, when the controller first
# starts. Any other value is the operator's ceiling. A malformed value fails closed to the legacy 18.
CONC_PATH = Q + "/concurrency.json"
if not os.path.exists(CONC_PATH) and slots.get("hard_cap") == concurrency.LEGACY_CAP:
    slots.pop("hard_cap"); ev("CONCURRENCY legacy hard_cap %d seed retired; the adaptive controller owns the fleet cap" % concurrency.LEGACY_CAP)
elif "hard_cap" in slots: slots["hard_cap"] = _cap(slots["hard_cap"], concurrency.LEGACY_CAP)
def clamp_lane(lane):   # hard_cap wins over floor, ceiling and target, whoever last wrote them (overrides reload included)
    s_ = slots[lane]; hc = s_["hard_cap"] = _cap(s_.get("hard_cap"), DEFAULT[lane]["hard_cap"])
    s_["ceiling"] = min(s_["ceiling"], hc); s_["floor"] = min(s_["floor"], s_["ceiling"]); s_["target"] = min(s_["target"], hc)
for _l in LANES: clamp_lane(_l)
# ---- usage backoff (RQ-USAGE-BACKOFF-11 rev2): auto-hold a pool on a provider CLI usage/quota error line.
# Only exact provider error lines (anchored) count, and only on a failed or EMPTY run (codex-cmp: only a run
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
         "devin": [("devin_acu_exhausted", re.compile(r"(?im)^(?:ERROR|Error): (?:ACU (?:limit|quota) (?:reached|exceeded)|ACUs? (?:are |have been )?(?:exhausted|depleted)|out of ACUs)\b.*$")),
                   ("devin_usage_limit", re.compile(r"(?im)^weekly usage quota has been exhausted\s*$"))]}
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
    r = _run(["/bin/bash", GITSAFE, "run", wt] + list(a), 30, env=env)
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
        for k in ("held", "held_reason", "held_by", "held_until", "auth_failed"): s_.pop(k, None)
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
# ---- auth backoff (RQ-LANERECOVERNOV1Q8): hold a lane on REPEATED authentication failures. Usage/quota
# lines hold on one match because the provider names the reset; a dead credential names none, so the bar
# is higher: at least AB_AUTH_MIN distinct failed or EMPTY finishes on the lane whose log tails carry a
# provider auth-error line inside the 30-minute window. One transient or forged line never holds; a run
# that produced work never counts (codex-cmp: any work; others: clean work only; ab_run's own rule).
# Per-job verdicts persist in <job>.authfail.seen ("<verdict> <pattern>"), so the streak accumulates
# across ticks while git re-evaluation stays once per job. The hold is autobackoff-attributed and
# bounded by AB_DEF like every software hold: it never touches credential storage, and ab_unhold's
# expiry is the recovery probe; a rotated credential resumes on the next launch, a still-dead one
# re-arms after two more failures. Eligible work on healthy lanes keeps dispatching the whole time.
AB_AUTH_MIN = 2
_A_TOK = (r"401\b|unauthorized|authentication(?:_error| failed)?|invalid_grant|refresh token|"
          r"re-?authenticate|session expired|token (?:has )?expired|"
          r"credentials? (?:are )?(?:expired|invalid|revoked)|not logged in|"
          r"please (?:re-?)?(?:log ?in|authenticate)|invalid (?:x-)?api[-_ ]?key")
AB_AUTH_RX = {
    "codex": [("codex_auth_failure", re.compile(r"(?im)" + _CX + r"[^\n]*(?:" + _A_TOK + r")[^\n]*$"))],
    "devin": [("devin_auth_failure", re.compile(r"(?im)^(?:\[[0-9T:.\-]+Z?\]\s*)?(?:ERROR|Error): [^\n]*(?:" + _A_TOK + r")[^\n]*$"))],
    "anthropic": [("claude_auth_401", re.compile(r"(?im)^API Error: 401\b[^\n]*$")),
                  ("claude_auth_error", re.compile(r"(?im)^[^\n]*(?:authentication_error|invalid (?:x-)?api[-_ ]?key|"
                                                  r"oauth token (?:has )?expired|not logged in|please (?:re-?)?log ?in)[^\n]*$"))],
}
def ab_auth_scan(lane, alive_):
    s_ = slots[lane]; pats = AB_AUTH_RX.get(AB_PROV.get(lane, ""))
    if not pats or (s_.get("held") and s_.get("held_by") != AB_BY): return   # manual hold: never touch
    newest, count = None, 0
    for bp in glob.glob(R + "/*.base"):
        j = os.path.basename(bp)[:-5]
        if not JID.match(j) or j in alive_: continue
        b = rd(bp).split()
        if len(b) < 4 or b[3] != lane: continue
        lp = "%s/%s.log" % (R, j); mk = "%s/%s.authfail.seen" % (RUN, j)
        try:
            if os.path.getmtime(lp) < NOW - 1800: continue
        except Exception: continue
        mark = rd(mk).strip().split(" ", 1)
        verdict, pid = mark[0], (mark[1] if len(mark) > 1 else None)
        if verdict not in ("fail", "work", "skip"):
            tail = "\n".join(logtail(lp, AB_TAIL).splitlines()[-60:])
            hit = next(((p, m) for p, rx in pats for m in [rx.search(tail)] if m), None)
            if not hit: continue
            pid, m = hit
            failed, work, osrc = ab_run(j, b)
            if osrc == "helper_unavailable":
                ev("AUTH_FAILURE_SEEN %s %s %s: helper_unavailable, no hold" % (lane, j, pid))
                metric({"event": "authbackoff_skip", "lane": lane, "job": j, "pattern": pid, "src": "helper_unavailable"}); continue
            if osrc == "unknown":
                ev("AUTH_FAILURE_SEEN %s %s %s: worktree path refused (containment), no hold" % (lane, j, pid))
            produced = work if lane == "codex-cmp" else (work and not failed)
            verdict = "skip" if osrc == "unknown" else "work" if produced else "fail"
            if produced: ev("AUTH_FAILURE_SEEN %s %s %s: run produced work, no hold" % (lane, j, pid))
            try: open(mk, "w").write("%s %s\n" % (verdict, pid))
            except Exception: pass
        if verdict != "fail": continue
        count += 1
        if newest is None or os.path.getmtime(lp) > newest[0]: newest = (os.path.getmtime(lp), j, pid)
    if count < AB_AUTH_MIN or newest is None: return
    pid, j = newest[2] or "auth_failures", newest[1]
    rs = min(NOW + AB_DEF, NOW + AB_CAP)   # no provider reset to parse: a bounded probe window only
    if s_.get("held"):
        cur = ab_epoch(s_.get("held_until"))
        if cur is not None and cur >= rs: return
    until = ab_iso(rs)
    s_["held"] = True; s_["held_by"] = AB_BY; s_["held_until"] = until; s_["last_change"] = NOW
    s_["auth_failed"] = True
    s_["held_reason"] = "autobackoff %s job=%s until=%s src=default (%d auth-failed runs)" % (pid, j, until, count)
    ev("LANE_HOLD %s autobackoff pattern=%s job=%s until=%s src=default (%d auth-failed runs)" % (lane, pid, j, until, count))
    metric({"event": "autobackoff_hold", "lane": lane, "job": j, "pattern": pid, "until": until, "src": "default", "auth_failures": count})
ab_unhold()
# ---- resource autopilot (RQ-RESOURCE-AUTOPILOT): read-only disk, inode, swap-growth and devin readings
def _autopilot():
    try:
        return json.loads(subprocess.run(["/usr/bin/python3", R + "/bin/autopilot.py"], capture_output=True, text=True, timeout=20).stdout)
    except Exception: return None
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
def _daemon_tick_age():   # -> (seconds since lastTickAt | None, why)
    import datetime as dt
    try:
        r = subprocess.run(["ashlr", "daemon", "status", "--json"], capture_output=True, text=True, timeout=GATE_STATUS_TIMEOUT, stdin=subprocess.DEVNULL)
        v = json.loads(r.stdout).get("lastTickAt")
        if not isinstance(v, str): return (None, "no lastTickAt")
        return (max(0.0, NOW - dt.datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()), None)
    except Exception as e: return (None, type(e).__name__)
def api_pace():   # claude-api: slot target comes from the credit burn plan, not memory pressure
    try:
        return json.loads(subprocess.run(["/usr/bin/python3", R + "/bin/claude-api.py", "pace", "--json"], capture_output=True,
                                         text=True, timeout=20).stdout)
    except Exception: return {"target": 0, "held": True, "reason": "claude-api.py pace failed"}
def _claude_report():
    try:
        return json.loads(subprocess.run(["/usr/bin/python3", R + "/bin/claude-api.py", "report", "--json"],
                                         capture_output=True, text=True, timeout=20).stdout)
    except Exception: return {}
from process_snapshot import capture as capture_process_snapshot
# RQ-SWE5-LOOP-BENCH: these are independent read-only subprocesses; run in
# sequence they cost ~0.5-1.5 s of every tick. Start all of them now and collect
# each result at its original decision point. Probe behavior is unchanged.
_PROBES = ThreadPoolExecutor(max_workers=6)
AP_F = _PROBES.submit(_autopilot)
MEM_F = _PROBES.submit(mem)
PS_F = _PROBES.submit(capture_process_snapshot, timeout=5)
TICK_AGE_F = _PROBES.submit(_daemon_tick_age)
PACE_F = _PROBES.submit(api_pace)
REPORT_F = _PROBES.submit(_claude_report)
AP = AP_F.result()
# The separately scheduled disk sampler never blocks a dispatcher tick.
_disk_growth = jload(Q + "/disk-growth.json", {})
if isinstance(_disk_growth, dict) and _disk_growth:
    if not isinstance(AP, dict): AP = {}
    _existing_disk = AP.get("disk")
    AP["disk"] = {**(_existing_disk if isinstance(_existing_disk, dict) else {}), **_disk_growth}
# Lane disk gate (green|freeze|halve|yellow), NOT the cleanup level: compact_level only drives compact.sh.
# Missing or unknown (older autopilot, failed read) is yellow: raises frozen, no halving.
DISK_GATE = (AP or {}).get("lane_disk_gate") or "yellow"
if DISK_GATE not in ("green", "freeze", "halve"): DISK_GATE = "yellow"
PREV_DISK_GATE = rd(R + "/.autopilot-disk-gate").strip() if os.path.exists(R + "/.autopilot-disk-gate") else ""
if AP:   # devin limits: 10/3/16 by default (DEVIN-LEVERAGE-20261026); a devin block in budget-overrides.json overrides floor and ceiling
    lim = AP.get("devin", {}).get("limits") or {}
    for a in ("floor", "ceiling"):
        if isinstance(lim.get(a), int): slots["devin"][a] = lim[a]
    clamp_lane("devin")   # RQ-LOADGATE-1: the overrides floor/ceiling are reapplied every tick, so hard_cap is reapplied right after
hold = set(rd(R + "/HOLD").split())
def _ph_check():   # auto-release PUBLISH_HOLD once org Actions backlog < 50 queued runs; checks at most every 10 min
    ph, st = R + "/PUBLISH_HOLD", R + "/PUBLISH_HOLD.checked"
    if not os.path.exists(ph): return
    try:
        if time.time() - os.path.getmtime(st) < 600: return
    except FileNotFoundError: pass
    open(st, "w").close()
    # RQ-SWE5-LOOP-BENCH: the seven queued-run counts are independent; fetch them
    # concurrently. Any failure still abandons the check (nothing is written).
    repos = ("phantom", "phantom-secrets", "locus", "lexicon", "ashlr-md", "ashlr-stack", "ashlr-plugin")
    def queued(rp):
        try: return int(_run(["gh", "api", "repos/ashlrai/%s/actions/runs?status=queued&per_page=1" % rp, "--jq", ".total_count"], 20).stdout.strip())
        except Exception: return None
    with ThreadPoolExecutor(max_workers=len(repos)) as ex:
        counts = list(ex.map(queued, repos))
    if any(c is None for c in counts): return
    n = sum(counts)
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
def devin_failure(exit_code, empty, tail):
    """Fixed labels only; a silent failure cannot prove that no remote work started."""
    if exit_code is None or exit_code == 0: return None
    if empty is not True: return "failed_with_work" if empty is False else "failed_diff_unknown"
    if any(rx.search(tail) for _, rx in AB_AUTH_RX["devin"]): return "authentication"
    if any(rx.search(tail) for _, rx in AB_RX["devin"]): return "quota"
    return "failed_empty_unknown"
def _kind(j, kinds): return re.match(r"(?:RQ-)?(?:%s)(?:[-_]|$)" % "|".join(kinds), j) is not None
REUSE_KINDS = ("FIXUP", "LAND", "SALVAGE")
try: DISK_REUSE_ONLY_GB = float(os.environ.get("DISK_REUSE_ONLY_GB", "100"))
except ValueError: DISK_REUSE_ONLY_GB = 100.0
try:
    _sv = os.statvfs(R); disk_free_gb = _sv.f_bavail * _sv.f_frsize / 1e9
    if os.path.exists(R + "/DISKGUARD_TEST") and os.environ.get("DISKGUARD_FREE_GB"): disk_free_gb = float(os.environ["DISKGUARD_FREE_GB"])
except Exception: disk_free_gb = 0.0   # unreadable: fail closed to reuse-only
disk_reuse_only = disk_free_gb < DISK_REUSE_ONLY_GB
# RQ-TERA-LANE: hard stop, below DISK_HARD_STOP_GB free no launches at all (reaps still run, they free disk)
try: DISK_HARD_STOP_GB = float(os.environ.get("DISK_HARD_STOP_GB", "30"))
except ValueError: DISK_HARD_STOP_GB = 30.0
disk_hard_stop = disk_free_gb < DISK_HARD_STOP_GB
# ---- RQ-DISKGUARD-DRIP (b): phantom publish drip. While ashlrai/phantom has >= 150 open PRs, publish (reap) only
# LAND, FIXUP, CONSOLIDATE and CLOSE-* jobs there; others stay finished and local. Count cached 10 min in
# $R/phantom-open-prs ("<epoch> <n>"), fetched with the same gh CLI as _ph_check; unavailable -> filter on.
PH_DRIP_KINDS = ("LAND", "FIXUP", "CONSOLIDATE", "CLOSE-[A-Z0-9-]+"); PH_DRIP_MAX = 150; _ph_open = []
def _ph_open_prs():
    if _ph_open: return _ph_open[0]
    cp = R + "/phantom-open-prs"; n = None
    try:
        t, v = rd(cp).split()[:2]
        age = time.time() - float(t); count = int(v)
        if 0 <= age < 600 and count >= 0: n = count
    except Exception: n = None
    if n is None:
        try:
            n = int(_run(["gh", "api", "search/issues?q=repo:ashlrai/phantom+is:pr+is:open&per_page=1", "--jq", ".total_count"], 20).stdout.strip())
            if n < 0: raise ValueError("invalid PR count")
            open(cp + ".tmp", "w").write("%d %d\n" % (int(time.time()), n)); os.replace(cp + ".tmp", cp)
        except Exception: n = None
    _ph_open.append(n); return n
def _ph_drip_hold(j):   # True = hold this finished job in place (not dropped)
    repo = (rd(RUN + "/" + j + ".line").split("\t") + ["", ""])[1].strip()
    if repo and repo != "phantom": return False   # RQ-FINISH-SIGNAL C: missing/empty .line repo fails closed (filtered)
    if _kind(j, PH_DRIP_KINDS): return False
    n = _ph_open_prs(); return n is None or n >= PH_DRIP_MAX

free, swap = MEM_F.result()

# ---- liveness: map processes to jobs by cmdline and cwd
alive, publishing, cwdjobs = set(), set(), set()
pat_wt = re.compile(re.escape(WTROOT) + r"/([A-Za-z0-9._-]+)")
pat_pr = re.compile(re.escape(R) + r"/([A-Za-z0-9._-]+?)\.prompt\b")
pat_ln = re.compile(r"launch\.sh ([A-Za-z0-9._-]+) ")
pat_pb = re.compile(r"(?:publish|reap-one)\.sh ([A-Za-z0-9._-]+)")
ps_result = PS_F.result()
jsave(Q + "/process-snapshot.json", {"observed_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                                    "known": ps_result.returncode == 0,
                                    "reason": ps_result.stderr if ps_result.returncode else None})
if ps_result.returncode:
    log("PROCESS_SNAPSHOT unknown; preserving every worker and queue claim")
    raise SystemExit(0)  # Unknown ownership is never permission to reap or launch.
ps = ps_result.stdout
for line in ps.splitlines():
    if "dispatchd.py" in line: continue
    m = pat_pb.search(line)
    if m: publishing.add(m.group(1)); continue
    for p in (pat_wt, pat_pr, pat_ln):
        m = p.search(line)
        if m: alive.add(m.group(1))
worker_worktrees = any(len(rd(x).split()) >= 4 and os.path.isdir(rd(x).split()[2]) for x in glob.glob(R + "/*.base"))
if worker_worktrees:
    lo_result = _run(["lsof", "-nP", "-w", "-d", "cwd", "-Fn"], 20)
    if lo_result.returncode or not lo_result.stdout.strip():
        jsave(Q + "/process-snapshot.json", {"observed_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                                            "known": False, "reason": "worker cwd inspection unavailable"})
        log("PROCESS_SNAPSHOT unknown cwd; preserving every worker and queue claim")
        raise SystemExit(0)
    for line in lo_result.stdout.splitlines():
        if line.startswith("n"):
            m = pat_wt.match(line[1:])
            if m: cwdjobs.add(m.group(1))
for j in cwdjobs:
    b = rd("%s/%s.base" % (R, j)).split()
    if len(b) >= 4: alive.add(j)
reaping = {os.path.basename(p)[:-8] for p in glob.glob(RUN + "/*.reaping")}
publish_processes = set(publishing)   # a publisher may remove .base before its final auto-merge call
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

# ---- batching (RQ-QUEUE-BATCH-1): related ready tasks share one session; queue/BATCH_OFF is the off switch
BATCHING = not os.path.exists(Q + "/BATCH_OFF")
os.makedirs(Q + "/batches", exist_ok=True)
BATCH_TUNING_PATH = Q + "/batch-tuning.json"; batch_tuning = batcher.load_tuning(BATCH_TUNING_PATH)
_bstats = None
def batch_stats():   # throughput per lane and mode from jobs.jsonl, read once per tick and only when needed
    global _bstats
    if _bstats is None: _bstats = batcher.throughput(JOBS, NOW)
    return _bstats
def batch_attempts(j):
    try: return int(rd(RUN + "/" + j + ".batch-attempts", "0").strip() or 0)
    except ValueError: return batcher.MAX_ATTEMPTS
def batch_manifest(j):
    if not j.startswith(batcher.BATCH_PREFIX) or not JID.fullmatch(j): return None
    m = jload(Q + "/batches/" + j + ".json", None)
    return m if isinstance(m, dict) and m.get("schema") == batcher.SCHEMA and isinstance(m.get("members"), list) else None

def requeue_member(x):   # the member's original ready line; its prompt may have been cleaned up since the claim
    try: os.remove(RUN + "/" + x["job"] + ".batched")
    except FileNotFoundError: pass
    if not isinstance(x.get("line"), str): return False
    pf = x["line"].split("\t")[4:5]
    if pf and not os.path.isfile(pf[0]) and os.path.realpath(pf[0]).startswith(Q + "/prompts/") and isinstance(x.get("prompt"), str):
        open(pf[0], "w").write(x["prompt"])
    requeue.append(x["line"]); return True
def release_batch(j, why):   # a batch that never started: every member goes back as it was, attempt refunded
    m = batch_manifest(j)
    if not m or m.get("reaped"): return
    for x in m["members"]:
        if not (isinstance(x, dict) and JID.fullmatch(str(x.get("job", "")))): continue
        open(RUN + "/" + x["job"] + ".batch-attempts", "w").write(str(max(0, batch_attempts(x["job"]) - 1)))
        requeue_member(x)
    m.update(reaped=NOW, released=why); jsave(Q + "/batches/" + j + ".json", m)
    ev("BATCH_RELEASED %s %d tasks requeued (%s)" % (j, len(m["members"]), why))
def reap_batch(j, wt, lane, wall_s):
    """Per-task outcomes from the session's BRIDGE_NOTES.md checklist; tasks not done go back to ready.tsv."""
    m = batch_manifest(j)
    if not m or m.get("reaped"): return None
    members = [x for x in m["members"] if isinstance(x, dict) and JID.fullmatch(str(x.get("job", "")))]
    notes = rd(wt + "/BRIDGE_NOTES.md")
    outcomes = batcher.parse_outcomes(notes, [x["job"] for x in members])
    retry = 0
    for x in members:
        o = outcomes[x["job"]]
        metric({"event": "task_outcome", "job": x["job"], "batch": j, "lane": lane, "repo": m.get("repo"), "outcome": o})
        if o in batcher.RETRY: retry += requeue_member(x)
        else:
            try: os.remove(RUN + "/" + x["job"] + ".batched")
            except FileNotFoundError: pass
    old, new, why = batcher.tune(batch_tuning, lane, outcomes, wall_s, os.path.exists(RUN + "/" + j + ".timeout"), batch_stats(), NOW)
    batcher.save_json(BATCH_TUNING_PATH, batch_tuning)
    m.update(reaped=NOW, outcomes=outcomes); jsave(Q + "/batches/" + j + ".json", m)
    n = {o: sum(1 for v in outcomes.values() if v == o) for o in batcher.OUTCOMES}
    ev("BATCH_REAPED %s done=%d skipped=%d failed=%d deferred=%d unreported=%d requeued=%d size[%s] %d->%d (%s)" % (
        j, n["done"], n["skipped"], n["failed"], n["deferred"], n["unreported"], retry, lane, old, new, why))
    return len(members)


# ---- per-job launch outcome (requeue PAUSED/HELD launches)
requeue = []; fork_seen = []; rl_seen = []
for p in glob.glob(RUN + "/*.dispatched"):
    j = os.path.basename(p)[:-11]
    if j in alive: continue
    out = rd("%s/%s.launch" % (R, j))
    if (ps_result.returncode and j.startswith("RQ-FIX-MAIN-") and _rc(j) is None and not result(j)
            and not re.search(r"^(PAUSED|HELD|SKIPPED):", out, re.M)):
        alive.add(j); continue   # unknown liveness during a long fetch, even before .base exists
    if "launched " in out: os.remove(p); continue
    if re.search(r"^(PAUSED|HELD)", out, re.M):
        ln = rd(RUN + "/" + j + ".line").strip()
        if ln: requeue.append(ln)
        ev("LAUNCH_DEFERRED %s %s (requeued)" % (j, out.split(":")[0].strip()))
    elif re.search(r"^SKIPPED: BRANCH_IN_WORKTREE", out, re.M):
        ev("LAUNCH_SKIPPED %s BRANCH_IN_WORKTREE (not a failure, not requeued; see %s.launch)" % (j, j))
        release_batch(j, "launch skipped")
    elif not out.strip() and not base(j):
        ln = rd(RUN + "/" + j + ".line").strip()
        if ln: requeue.append(ln)
        ev("LAUNCH_INTERRUPTED %s (requeued)" % j)
    else:
        ev("LAUNCH_FAILED %s (see %s.launch)" % (j, j))
        if FORK_RX.search(out): fork_seen.append(NOW); ev("FORK_FAILED %s (concurrency backoff)" % j)
        release_batch(j, "launch failed")
    os.remove(p)

# ---- (a) reap
running = {l: 0 for l in LANES}; kept = []; nreap = len(reaping); local_mid = 0
# A leftover .base is not evidence that an already merged attempt needs another
# publisher. A later launch starts a new attempt with the same job id.
_attempts = {}; _merged_urls = set()
_raw_rows = batcher.parse_rows(MD + "/jobs.jsonl")
JOBS_RAW.extend(_raw_rows); JOBS.extend(batcher.project_rows(_raw_rows))
_JOBS_LIVE = True
for row in JOBS:
    if not isinstance(row, dict): continue
    event, job = row.get("event"), row.get("job")
    if row.get("outcome", row.get("status")) == "PUBLISHED":
        job = row.get("jobId", row.get("job", row.get("id")))
    if event == "outcome" and str(row.get("state", row.get("outcome", ""))).upper() == "MERGED":
        if isinstance(row.get("url"), str) and row["url"]: _merged_urls.add(row["url"].rstrip("/"))
    if not isinstance(job, str): continue
    if event == "launch": _attempts[job] = {"finished": False, "merged": False, "urls": set()}
    attempt = _attempts.setdefault(job, {"finished": False, "merged": False, "urls": set()})
    if event == "finish": attempt["finished"] = True
    url = row.get("url") if event == "publish" else None
    if row.get("outcome", row.get("status")) == "PUBLISHED": url = row.get("prUrl", row.get("pr"))
    if isinstance(url, str) and url: attempt["urls"].add(url.rstrip("/"))
    # URL-bearing outcomes may arrive after a later launch; match the PR, not
    # the job id, so reconciliation cannot complete the wrong attempt.
    if event == "outcome" and str(row.get("state", row.get("outcome", ""))).upper() == "MERGED" and not row.get("url"):
        attempt["merged"] = True
# A new marker covers the spawn-to-ps race. Old orphan markers still protect
# their own job, but must not stop every other publisher forever.
def _reap_starting(j):
    try: return NOW - os.path.getmtime(RUN + "/" + j + ".reaping") < GRACE
    except FileNotFoundError: return False   # the publisher completed after the process snapshot
publish_busy = bool(publish_processes) or any(_reap_starting(j) for j in reaping) or bool(reaping and ps_result.returncode)
def _is_local_mid(j): return (rd(RUN + "/" + j + ".line").split("\t") + ["", "", "", ""])[3].strip() == "mid"
# PUBLISH_DRIP (Masbot 22:30 Oct 26): pace pushes after the Actions stall; LAND/FIXUP first, <=10 per 5 min, none while queued runs >= 150
DRIP = os.path.exists(R + "/PUBLISH_DRIP"); DRIPLOG = RUN + "/publish-drip.tsv"; drip_budget = 10**6
if DRIP:
    try: dq = int((rd(R + "/PUBLISH_DRIP").split() or ["0"])[0])
    except Exception: dq = 0
    try: drecent = [float(x) for x in rd(DRIPLOG).split() if NOW - float(x) < 300]
    except Exception: drecent = []
    drip_budget = 0 if dq >= 150 else max(0, 10 - len(drecent))
REPO_RANK = {r: i for i, r in enumerate(("phantom", "phantom-secrets", "locus", "lexicon", "ashlr-md", "ashlr-stack", "ashlr-plugin"))}
def _ready_repo_ranks():
    """Read a complete rank snapshot; invalid snapshots leave legacy ordering intact."""
    try:
        with open(H + "/.ashlr/repo-rank.json") as f: state = json.load(f)
        enrolled, rows = state["enrolled"], state["rankings"]
        weights = [state["weights"][k] for k in ("prior", "recency", "leverage")]
        number = lambda x: isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)
        datetime.datetime.fromisoformat(state["generatedAt"].replace("Z", "+00:00"))
        if (type(state["schemaVersion"]) is not int or state["schemaVersion"] != 1 or not isinstance(enrolled, list) or not enrolled
                or any(not isinstance(r, str) or not re.fullmatch(r"[a-z0-9-]+", r) for r in enrolled)
                or len(set(enrolled)) != len(enrolled) or not isinstance(rows, list) or len(rows) != len(enrolled)
                or any(not number(w) or w < 0 for w in weights) or not math.isfinite(sum(weights)) or sum(weights) <= 0
                or not isinstance(state["proposals"], list) or not isinstance(state["history"], list)
                or any(not isinstance(r, dict) or r.get("repo") not in enrolled
                       or not number(r.get("weight")) or r["weight"] <= 0 or not number(r.get("score")) for r in rows)
                or len({r["repo"] for r in rows}) != len(enrolled)):
            return {}
        return {r["repo"]: i for i, r in enumerate(rows)}
    except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError): return {}

PRIORITY_QUEUE = rd(Q + "/router-queue.md"); _sizes = {}
def _bucket(j):
    return (0 if j.startswith("RQ-FIX-MAIN-") else 1 if j.startswith("RQ-REL-") else
            2 if j.startswith("RQ-DESK-") else 3 if _kind(j, ("LAND", "FIXUP", "RECUT")) else 4)
def _job_repo(j):
    f = rd(RUN + "/" + j + ".line").strip().split("\t")
    b = base(j)
    return f[1] if len(f) >= 2 and f[1] else b[1] if b else ""
def _size_hint(j, prompt=None):
    key = (j, prompt)
    if key not in _sizes:
        # Only the task envelope supplies size, never a number mentioned in task prose.
        envelope = re.escape(j) + r"(?: r\d+)? \(([^)\n]*)\):"
        m = re.search(r"(?m)^- [A-Z][A-Z-]* (?:[A-Za-z0-9._:@/-]+ )*?" + envelope, PRIORITY_QUEUE)
        if not m:
            # Saved .line paths are metadata, so keep reads inside the prompt directory.
            if not prompt or not os.path.realpath(prompt).startswith(Q + "/prompts/"):
                prompt = Q + "/prompts/" + j + ".md"
            m = re.search(r"(?m)^" + envelope, rd(prompt) or rd(R + "/" + j + ".prompt"))
        hint = re.search(r"(?:^|[,;\s])size<=([0-9]+)(?=[,;\s]|$)", m.group(1)) if m else None
        try: _sizes[key] = int(hint.group(1)) if hint else math.inf
        except ValueError: _sizes[key] = math.inf
    return _sizes[key]
def _job_priority(j, repo, path, prompt=None): return (_bucket(j), REPO_RANK.get(repo, 9), _size_hint(j, prompt), path)
def _prio(bp):
    j = os.path.basename(bp)[:-5]
    f = rd(RUN + "/" + j + ".line").strip().split("\t")
    return _job_priority(j, _job_repo(j), bp, f[4] if len(f) >= 5 else None)

# A launch can still be fetching before its .base exists. Include the grace set,
# but release the repo as soon as the worker has an explicit terminal outcome.
fix_main_repos = {_job_repo(j) for j in alive if j.startswith("RQ-FIX-MAIN-")
                  and _rc(j) is None and not result(j)}
def drain_target(j, repo):
    # Only the refix producer's exact ID identifies a PR; other DRAIN jobs
    # must remain independent, including repos whose names contain hyphens.
    m = re.fullmatch(r"RQ-DRAIN-" + re.escape(repo) + r"-([1-9][0-9]*)-[0-9a-fA-F]{7}", j) if repo else None
    return (repo, m.group(1)) if m else None
drain_targets = {drain_target(j, _job_repo(j)) for j in alive if _rc(j) is None and not result(j)} - {None}
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
    attempt = _attempts.get(j, {})
    if attempt.get("merged") or attempt.get("urls", set()) & _merged_urls: continue
    try: recent = max(os.path.getmtime(bp), os.path.getmtime("%s/%s.log" % (R, j)) if os.path.exists("%s/%s.log" % (R, j)) else 0)
    except Exception: recent = NOW
    if NOW - recent < 180 or not os.path.exists("%s/%s.log" % (R, j)):   # fresh launch by anyone (routine or us): not finished
        if j.startswith("RQ-FIX-MAIN-") and _rc(j) is None and not result(j): fix_main_repos.add(_job_repo(j))
        if _rc(j) is None and not result(j):
            target = drain_target(j, _job_repo(j))
            if target: drain_targets.add(target)
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
    if os.path.exists(R + "/PUBLISH_LANDONLY") and _bucket(j) > 3 and not _landonly_ok(j) and not os.path.exists(R + "/g1-pass/" + j + ".pass"): continue   # merge-rate first; only priority buckets, G1-passed and listed jobs publish
    # reap-one.sh owns publish.sh and must wait through auto-merge enablement.
    # Wait for its complete handoff before starting the next publisher;
    # concurrent children can reorder merge-queue entry regardless of spawn order.
    if publish_busy: continue
    if over_budget(): continue   # RQ-TICK-BUDGET: later reaps wait one tick
    if _ph_drip_hold(j):
        mk = RUN + "/" + j + ".phdrip"
        if not os.path.exists(mk): open(mk, "w").close(); ev("PHANTOM_DRIP hold %s open_prs=%s" % (j, _ph_open_prs()))
        continue
    if DRIP:
        if drip_budget <= 0: continue
        drip_budget -= 1; open(DRIPLOG, "a").write("%f\n" % NOW)
    os.mkdir(RUN + "/" + j + ".reaping"); nreap += 1; publish_busy = True
    try:
        lp = "%s/%s.log" % (R, j); tl = logtail(lp, 20000)
        nf, diff_lines, empty = job_diff_metrics(wt, b[0])
        wall_s = int(os.path.getmtime(lp) - os.path.getmtime(bp)) if os.path.exists(lp) else None
        try: bsize = reap_batch(j, wt, pool, wall_s)
        except Exception as e: bsize = None; log("batch reap err %s %s" % (j, type(e).__name__))
        if not attempt.get("finished") and not os.path.exists(RUN + "/" + j + ".timeout"):
            metric({"event": "finish", "job": j, "lane": pool, "wall_s": wall_s, "batch_size": bsize,
                "exit_code": _rc(j), "tokens_total": tokens(tl), "tokens_in": None, "tokens_out": None, "cost": None,
                "diff_files": nf, "diff_lines": diff_lines, "empty": empty,
                "failure_class": devin_failure(_rc(j), empty, tl) if pool == "devin" else None,
                "pool_error": next((c for c, rx in CLS if any(rx.search(t) for t in errlines(tl.splitlines()[-30:]))), None)})
    except Exception as e: log("metric finish err %s %s" % (j, type(e).__name__))
    subprocess.Popen(["/bin/bash", R + "/bin/reap-one.sh", j], stdin=subprocess.DEVNULL,
                     stdout=open(RUN + "/" + j + ".reap.log", "a"), stderr=subprocess.STDOUT, start_new_session=True)
    log("REAP %s (%s)" % (j, pool))

# ---- admission gate. Fixture signal overrides require the LOADGATE_TEST marker.
def _install_holder():   # the install-gate.py wrapper writes its holder JSON into queue/install.lock; a dead pid is no holder
    try:
        h = json.loads(rd(Q + "/install.lock") or "null")
        if isinstance(h, dict) and isinstance(h.get("pid"), int) and h["pid"] > 0: os.kill(h["pid"], 0); return h
    except PermissionError: return h   # exists, owned by another user
    except Exception: pass
    return None
def admission_gate():
    g = {"tripped": False, "reasons": [], "warnings": [], "disabled": os.path.exists(Q + "/LOADGATE_OFF")}
    test = os.path.exists(R + "/LOADGATE_TEST")
    try: ncpu = int(os.environ["LOADGATE_NCPU"]) if test and os.environ.get("LOADGATE_NCPU") else (os.cpu_count() or 1)
    except ValueError: ncpu = os.cpu_count() or 1
    try: load1 = float(os.environ["LOADGATE_LOADAVG"]) if test and os.environ.get("LOADGATE_LOADAVG") else os.getloadavg()[0]
    except (ValueError, OSError): load1 = float("inf")   # unreadable load: reduce claims
    procs = sum(1 for l in ps.splitlines() if l.strip())
    wts = sum(1 for bp in glob.glob(R + "/*.base") if os.path.basename(bp)[:-5] in alive and (lambda b: bool(b) and os.path.isdir(b[2]))(base(os.path.basename(bp)[:-5])))
    age, why = TICK_AGE_F.result()
    pressure = None
    try:
        pressure = int(os.environ["LOADGATE_PRESSURE"]) if test and "LOADGATE_PRESSURE" in os.environ else int(
            _run(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"], 5).stdout.strip())
    except (ValueError, OSError, subprocess.SubprocessError): pass
    swap_gb = swap
    if test and "LOADGATE_SWAP_GB" in os.environ:
        try: swap_gb = float(os.environ["LOADGATE_SWAP_GB"])
        except ValueError: swap_gb = None
    samples = jload(Q + "/admission.json", {}).get("swap_samples", [])
    if not isinstance(samples, list): samples = []
    samples = [v for v in samples if isinstance(v, list) and len(v) == 2 and
               all(isinstance(x, (int, float)) for x in v) and NOW - GATE_SWAP_WINDOW_S <= v[0] <= NOW]
    growth = max(0, swap_gb - min(v[1] for v in samples)) if samples and swap_gb is not None else 0
    if swap_gb is not None: samples.append([NOW, swap_gb])
    load_max = GATE_LOAD_PER_CPU * ncpu
    soft_load = load1 > load_max and not g["disabled"]
    if load1 > load_max: g["warnings"].append("loadavg %.1f > %.1f" % (load1, load_max))
    if procs > GATE_PROCS_MAX: g["warnings"].append("procs %d > %d" % (procs, GATE_PROCS_MAX))
    if pressure is None: g["warnings"].append("memory_pressure_unavailable")
    elif pressure >= GATE_PRESSURE_MIN: g["reasons"].append("memory_pressure %d >= %g" % (pressure, GATE_PRESSURE_MIN))
    if swap_gb is None: g["warnings"].append("swap_unavailable")
    if growth > GATE_SWAP_GROWTH_GB: g["reasons"].append("swap_growth %gGB > %gGB" % (growth, GATE_SWAP_GROWTH_GB))
    if disk_hard_stop: g["reasons"].append("disk_free %gGB < %gGB" % (disk_free_gb, DISK_HARD_STOP_GB))
    g.update(memory_pressure=pressure, pressure_min=GATE_PRESSURE_MIN, swap_gb=swap_gb, swap_growth_gb=growth,
             swap_growth_max_gb=GATE_SWAP_GROWTH_GB, swap_window_s=GATE_SWAP_WINDOW_S, swap_samples=samples,
             disk_free_gb=disk_free_gb, disk_hard_stop_gb=DISK_HARD_STOP_GB, soft_load=soft_load,
             claim_limit=max(1, MAX_LAUNCH_PER_TICK // 2) if soft_load else MAX_LAUNCH_PER_TICK,
             procs_max=GATE_PROCS_MAX, worktrees_max=GATE_WORKTREES_MAX, tick_max_s=GATE_TICK_MAX_S)
    if wts > GATE_WORKTREES_MAX: g["warnings"].append("worktrees %d > %d" % (wts, GATE_WORKTREES_MAX))
    if age is None: g["warnings"].append("daemon_status_unavailable (%s)" % why)
    elif age > GATE_TICK_MAX_S: g["warnings"].append("daemon_tick_stale %ds > %ds" % (age, GATE_TICK_MAX_S))
    g.update(load1=load1, ncpu=ncpu, load_max=load_max, procs=procs, worktrees=wts, daemon_tick_age_s=None if age is None else int(age))
    g["tripped"] = bool(g["reasons"]) and not g["disabled"]
    return g
GATE = admission_gate()
# An explicit nonnegative override fixes the cap; malformed values fall back to the load-aware default.
try: LOCAL_MID_CAP = max(0, int(os.environ["LOCAL_MID_CAP"])) if "LOCAL_MID_CAP" in os.environ else None
except ValueError: LOCAL_MID_CAP = None
if LOCAL_MID_CAP is None: LOCAL_MID_CAP = 1 if GATE["tripped"] else (4 if GATE["load1"] < GATE["ncpu"] else 2)
def lane_target_sum():   # held lanes launch nothing so they add nothing
    return sum(slots[l]["target"] for l in LANES if not (slots[l].get("held") or l in hold))
def global_cap():   # min(sum of unheld lane targets, adaptive cap, operator hard_cap)
    return max(0, min([lane_target_sum(), CONC["cap"]] + ([slots["hard_cap"]] if "hard_cap" in slots else [])))

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
from launch_precheck import precheck as shared_precheck, park_key, parked, park
PARK_PATH = Q + "/precheck-parked.json"
park_state = jload(PARK_PATH, {})
if not isinstance(park_state, dict): park_state = {}

def precheck(j, repo, pf):
    return shared_precheck(j, repo, rd(pf), H, R, _run)

# Route proposals arrive as ready.tsv pool changes; receipts outlive queue removal.
def route_decision(record, proposed, now, hard_down=False, launched=False):
    if record is None:
        return {"pool": proposed, "decided_at": now, "moves": []}, None
    record = dict(record)
    record["launched"] = record.get("launched", False) or launched
    record["moves"] = [t for t in record["moves"] if t > now - 21600]
    if proposed == record["pool"]: return record, None
    reason = ("launched" if record["launched"] else "move_cap" if len(record["moves"]) >= 2
              else "minimum_residency" if now - record["decided_at"] < 3600 and not hard_down else None)
    if reason: return record, reason
    record.update(pool=proposed, decided_at=now, moves=record["moves"] + [now])
    return record, None

# ---- queue
# RQ-READYLOCK-SCOPE: queue/ready.lock guards only the ready.tsv read and the ready.tsv rewrite, never the
# tick body (a slow tick held it 4+ min and blocked restock.py / sync-router-queue.py appends). Every taker
# polls LOCK_NB up to a timeout (ASHLR_READY_LOCK_TIMEOUT, default 10 s) and logs waits over 1 s and timeouts.
def qlock(who="dispatchd", timeout=None):
    timeout = float(os.environ.get("ASHLR_READY_LOCK_TIMEOUT", 10)) if timeout is None else timeout
    fd = open(Q + "/ready.lock", "a"); t0 = time.monotonic()
    while True:
        try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); break
        except OSError:
            if time.monotonic() - t0 >= timeout:
                fd.close(); ev("READY_LOCK_TIMEOUT %s waited %.1fs" % (who, time.monotonic() - t0)); return None
            time.sleep(0.05)
    if time.monotonic() - t0 > 1: ev("READY_LOCK_WAIT %s %.1fs" % (who, time.monotonic() - t0))
    return fd
lk = qlock("dispatchd-read")
if lk is None: log("ready.lock busy; tick skipped"); raise SystemExit(0)
_raw = rd(Q + "/ready.tsv").splitlines()
def parked_row(line):
    fields = line.split("\t")
    return fields[0].startswith("PARKED-") or (len(fields) > 2 and fields[2].startswith("PARKED-"))
# Invalid persisted history must not silently reset the move budget.
try:
    route_state = json.loads(rd(Q + "/route-state.json")) if os.path.exists(Q + "/route-state.json") else {}
    assert isinstance(route_state, dict)
    for receipt in route_state.values():
        assert receipt["pool"] in LANES and type(receipt["decided_at"]) in (int, float) and math.isfinite(receipt["decided_at"])
        assert isinstance(receipt["moves"], list) and all(type(t) in (int, float) and math.isfinite(t) for t in receipt["moves"])
except (ValueError, TypeError, KeyError, AssertionError):
    lk.close(); ev("ROUTE_STATE_INVALID tick held"); raise SystemExit(1)
routed = []
for line in _raw + requeue:
    f = line.split("\t")
    if parked_row(line) or len(f) < 5 or not JID.fullmatch(f[0]) or f[2] not in LANES:
        routed.append(line); continue
    job, proposed = f[0], f[2]
    previous = route_state.get(job)
    launched_line = rd(RUN + "/" + job + ".line").strip().split("\t")
    launched = os.path.exists(RUN + "/" + job + ".dispatched") or len(launched_line) >= 5
    if previous is None and len(launched_line) >= 5 and launched_line[2] in LANES:
        previous = {"pool": launched_line[2], "decided_at": NOW, "moves": []}
    current = slots.get(previous["pool"], {}) if previous else {}
    hard_down = (current.get("auth_failed") is True or (type(current.get("quota")) in (int, float) and current["quota"] == 0)
                 or (current.get("held") and current.get("held_reason") == "auth_failure"))
    record, reason = route_decision(previous, proposed, NOW, hard_down, launched)
    route_state[job] = record
    if reason:
        ev("ROUTE_HOLD %s %s->%s reason=%s" % (job, record["pool"], proposed, reason))
    elif previous and previous["pool"] != record["pool"]:
        ev("ROUTE %s %s->%s" % (job, previous["pool"], record["pool"]))
    f[2] = record["pool"]; routed.append("\t".join(f))
jsave(Q + "/route-state.json", route_state)
lk.close()   # snapshot taken; writers may append from here on
lines = [l for l in routed if l.strip() and not l.startswith("#")]
# Record first observation even while admission is paused or a lane is held.
# Per-job receipts survive ticks and queue rewrites without rescanning the metrics log.
for l in lines:
    f = l.split("\t")
    if parked_row(l) or len(f) < 5 or not JID.fullmatch(f[0]) or f[2] not in LANES or f[3] not in TIERS: continue
    receipt = RUN + "/" + f[0] + ".enqueued"
    try:
        with open(receipt, "x") as out: out.write(str(time.time()))
    except FileExistsError: continue
    try: metric({"event": "enqueue", "job": f[0], "repo": f[1], "lane": f[2], "tier": f[3]})
    except Exception:
        os.remove(receipt)
        raise
qdepth = {l: 0 for l in LANES}
for l in lines:
    f = l.split("\t")
    if not parked_row(l) and len(f) >= 3 and f[2] in qdepth: qdepth[f[2]] += 1

_dv = None
def _devin_spike():   # DEVIN-LEVERAGE-20261026, computed in dispatchd itself (Masbot 21:19): the same
    global _dv          # last-10 devin finish scan bin/autopilot.py publishes, kept here so a down
    if _dv is None:     # autopilot never leaves the spike check unrun. Cached once per tick.
        rows = JOBS_RAW
        pub = {r.get("job") for r in rows if r.get("event") == "publish" and r.get("url")}
        fin = [r for r in rows if r.get("event") == "finish" and r.get("lane") == "devin"][-DEVIN_STEP["window"]:]
        _dv = {"last_n": len(fin), "last_job": fin[-1].get("job") if fin else None,
               "non_pr": sum(1 for r in fin if r.get("empty") or r.get("job") not in pub)}
        _dv["step_down"] = len(fin) >= DEVIN_STEP["window"] and _dv["non_pr"] > DEVIN_STEP["max_non_pr"]
    return _dv
for lane in LANES:
    try: ab_scan(lane, alive)
    except Exception as e: log("autobackoff err %s %s" % (lane, type(e).__name__))
    try: ab_auth_scan(lane, alive)
    except Exception as e: log("authbackoff err %s %s" % (lane, type(e).__name__))
for lane in LANES:
    s = slots[lane]
    if lane == "claude-api":
        ap = PACE_F.result(); nt = max(0, min(int(ap.get("target") or 0), s["ceiling"]))
        if nt != s["target"]: ev("SLOTS %s %d->%d paced (pool=%s need=$%s/h)" % (lane, s["target"], nt, ap.get("pool"), ap.get("need_usd_per_hour")))
        s["target"] = nt; s["api_pool"] = ap.get("pool"); s["api_reason"] = ap.get("reason")
        if s.get("held") or lane in hold: continue
        hit = ratelimited(lane, s["last_change"])
        if hit and hit[1] in ("rate_limit", "model_capacity"): rl_seen.append(NOW)
        if hit and hit[1] == "credits_exhausted":
            s["held"] = True; s["held_reason"] = "credits exhausted (%s %s)" % (hit[0], TS); s["last_change"] = NOW
            ev("LANE_HOLD %s credits exhausted (%s); supervisor clears held in slots.json" % (lane, hit[0]))
        continue
    if s.get("held") or lane in hold: continue
    hit = ratelimited(lane, s["last_change"])
    if hit and hit[1] in ("rate_limit", "model_capacity"): rl_seen.append(NOW)
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
          and DISK_GATE == "green" and not GATE["tripped"]   # LOADGATE: the ramp pauses while the gate is tripped
          and (AP["memory"]["raise_ok"] if AP and AP.get("memory", {}).get("known")
               else (free is not None and free > 30))   # fallback when autopilot is unavailable: free memory only, no absolute swap block
          and NOW - s["last_change"] >= RAISE_GAP):
        nt = min(s["ceiling"], s["hard_cap"], s["target"] + 2)
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

# ---- adaptive concurrency (RQ-QUEUE-BATCH-1): one AIMD decision per tick, logged on every change
CONC_FLOOR, CONC_CEILING = concurrency.bounds(slots.get("hard_cap"))
CONC, _ = concurrency.load(CONC_PATH, max(CONC_FLOOR, min(concurrency.LEGACY_CAP, GATE["ncpu"], CONC_CEILING)), NOW)
CONC["fork_failures"] += fork_seen; CONC["rate_limits"] += rl_seen
def conc_adjusted(adj):
    if not adj: return
    ev(concurrency.describe(adj))
    metric({"event": "concurrency", "from": adj["from"], "to": adj["to"], "reason": adj["reason"], "zones": adj["zones"]})
_demand = sum(running.values()) >= CONC["cap"] and bool(lines) and lane_target_sum() > CONC["cap"]
conc_adjusted(concurrency.decide(CONC, {
    "load1": GATE["load1"], "ncpu": GATE["ncpu"], "load_per_cpu_max": GATE_LOAD_PER_CPU, "memory_pressure": GATE["memory_pressure"],
    "mem_free_pct": free, "swap_gb": GATE["swap_gb"], "swap_growth_gb": GATE["swap_growth_gb"], "swap_growth_max_gb": GATE_SWAP_GROWTH_GB,
    "disk_free_gb": disk_free_gb, "disk_hard_stop_gb": DISK_HARD_STOP_GB, "procs": GATE["procs"], "procs_max": GATE_PROCS_MAX},
    NOW, _demand, CONC_FLOOR, CONC_CEILING))

# ---- (b) fill
launched = []; rest = []; bad = 0; batches = []
GCAP = global_cap()
_prev = jload(Q + "/admission.json", {}).get("gate_reason"); _now_reason = "; ".join(GATE["reasons"]) if GATE["tripped"] else None
if _now_reason and _prev != _now_reason: ev("LOADGATE tripped: " + _now_reason)
elif not _now_reason and _prev: ev("LOADGATE clear")
_pw = jload(Q + "/admission.json", {}).get("warnings") or []
if GATE["warnings"] and _pw != GATE["warnings"]: ev("LOADGATE warn (non-tripping): " + "; ".join(GATE["warnings"]))
if disk_hard_stop: ev("DISKGUARD hard_stop %.0fG < %.0fG, no launches" % (disk_free_gb, DISK_HARD_STOP_GB))
if not pause and not disk_hard_stop and not GATE["tripped"]:
    cand = []
    for l in lines:
        if parked_row(l):
            rest.append(l); continue
        f = l.split("\t")
        ok = (len(f) >= 5 and JID.match(f[0]) and f[2] in LANES and f[3] in TIERS
              and os.path.isdir(H + "/Projects/ashlrai/" + f[1]) and "/" not in f[1]
              and os.path.realpath(f[4]).startswith(Q + "/prompts/") and os.path.isfile(f[4]))
        if not ok:
            rest.append(l); bad += 1; continue
        cand.append(f)
    # The key is global across pools; blocked jobs are retained below while
    # scanning continues, so a capped FIX-MAIN sibling cannot consume a claim.
    ready_ranks = _ready_repo_ranks()
    cand.sort(key=lambda f: (_bucket(f[0]), ready_ranks.get(f[1], len(ready_ranks)),
                             *_job_priority(f[0], f[1], f[4], f[4])[1:]))
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
    def member_ok(f, lead=False):   # every check the loop below would apply to the job on its own, plus batch limits
        m = f[0]
        return (batcher.batchable_id(m) and not drain_target(m, f[1]) and f[2] in batcher.BATCH_LANES and (lead or m not in seen) and not retired(m)
                and not (result(m) or "").startswith("RESULT PR") and not disk_reuse_only
                and m not in alive and m not in reaping and m not in publishing and m not in keep and m not in park_state
                and not os.path.isdir(WTROOT + "/" + m) and not os.path.exists(RUN + "/" + m + ".batched")
                and batch_attempts(m) < batcher.MAX_ATTEMPTS)
    _tasks = {}
    def task_info(f):   # prompts are read only for same-repo, same-tier candidates of a lead that can launch now
        if f[0] not in _tasks:
            text = rd(f[4])
            _tasks[f[0]] = {"job": f[0], "repo": f[1], "lane": f[2], "tier": f[3], "area": batcher.area_of(f[0], text),
                            "chars": len(text), "f": f, "prompt": text}
        return _tasks[f[0]]
    def form_batch(f):   # -> (members, lane, size target) or None to launch f on its own
        if not (BATCHING and member_ok(f, lead=True)): return None
        pool = [task_info(c) for c in cand if c[1] == f[1] and c[3] == f[3] and c[0] != f[0] and member_ok(c)]
        size = batcher.size_for(batch_tuning, f[2])
        picked = batcher.pick_members(task_info(f), pool, size)
        if not picked: return None
        has_capacity = lambda l: not (slots[l].get("held") or l in hold) and running[l] < slots[l]["target"]
        lane_ = batcher.choose_lane({c["lane"] for c in picked}, batcher.lane_scores(batch_stats()), has_capacity, f[2])
        return (picked, lane_, size) if lane_ else None
    for f in cand:
        j, repo, lane, tier, pf = f[:5]; line = "\t".join(f)
        s = slots[lane]; res = result(j)
        if j in seen: continue  # duplicate line
        why = retired(j)
        if why:
            if rq is None: ev("SKIP_RETIRED_CHECK %s held (%s)" % (j, why)); rest.append(line); seen.add(j); continue
            ev("SKIP_RETIRED %s dropped from ready.tsv (%s)" % (j, why)); seen.add(j); continue
        if res and res.startswith("RESULT PR"):
            ev("SKIP_DONE %s already has a PR" % j); seen.add(j); continue
        target = drain_target(j, repo)
        if target and res and res.startswith("RESULT EMPTY"):
            ev("SKIP_DONE %s already finished empty" % j); seen.add(j); continue
        if os.path.exists(RUN + "/" + j + ".batched"):   # a running batch owns it and re-queues it unless done
            ev("SKIP_BATCHED %s owned by %s" % (j, rd(RUN + "/" + j + ".batched").strip())); seen.add(j); continue
        if disk_reuse_only and not _kind(j, REUSE_KINDS):
            mk = RUN + "/" + j + ".diskguard"
            if not os.path.exists(mk): open(mk, "w").close(); ev("DISKGUARD defer %s %dG" % (j, disk_free_gb))
            rest.append(line); seen.add(j); continue
        if j.startswith("RQ-FIX-MAIN-") and repo in fix_main_repos:
            rest.append(line); seen.add(j); continue
        if target and target in drain_targets:
            rest.append(line); seen.add(j); continue
        if (len(launched) >= GATE["claim_limit"] or s.get("held") or lane in hold
                or running[lane] >= s["target"] or sum(running.values()) >= GCAP or j in alive or j in reaping or j in publishing):
            rest.append(line); seen.add(j); continue
        if lane == "codex-local":
            if _size_hint(j, pf) > 60:
                rest.append(line); seen.add(j); continue
            if tier == "mid" and local_mid >= LOCAL_MID_CAP: rest.append(line); seen.add(j); continue
            if local_ok is None:
                local_ok = _local_healthy()
                if not local_ok: ev("codex-local unhealthy (%s); codex-local jobs requeued this tick" % LOCAL_HEALTH)
            if not local_ok: rest.append(line); seen.add(j); continue
        wt = WTROOT + "/" + j
        if os.path.isdir(wt) and not (j in keep or (res and not res.startswith(("RESULT PR", "RESULT EMPTY")))):
            rest.append(line); seen.add(j); continue   # finished worktree awaiting reap: never double up
        seen.add(j)
        key = park_key(line, rd(pf))
        if parked(park_state, j, key, NOW):
            rest.append(line); continue
        # A due parked job must be checked even when optional prechecks ran out.
        # Defer it instead of accidentally launching unverified work.
        if j in park_state and (pc_n >= PC_MAX or over_budget()):
            rest.append(line); continue
        batch = form_batch(f)
        if batch:   # the batch session runs each member's own checks, so the per-job precheck is skipped
            picked, lane, size = batch; area = picked[0]["area"]
            bid = batcher.batch_id(repo, area, [c["job"] for c in picked])
            pf = Q + "/prompts/" + bid + ".md"
            open(pf, "w").write(batcher.render(bid, repo, area, [(c["job"], c["prompt"]) for c in picked]))
            jsave(Q + "/batches/" + bid + ".json", {"schema": batcher.SCHEMA, "id": bid, "repo": repo, "tier": tier, "lane": lane,
                  "area": area, "created_at": NOW, "size_target": size,
                  "members": [{"job": c["job"], "lane": c["lane"], "line": "\t".join(c["f"]), "prompt": c["prompt"]} for c in picked]})
            for c in picked:
                seen.add(c["job"])
                open(RUN + "/" + c["job"] + ".batch-attempts", "w").write(str(batch_attempts(c["job"]) + 1))
                open(RUN + "/" + c["job"] + ".batched", "w").write(bid)
                metric({"event": "batch_claim", "job": c["job"], "batch": bid, "repo": repo, "lane": lane, "tier": tier, "area": area})
            ev("BATCH %s %d tasks repo=%s area=%s lane=%s size_target=%d" % (bid, len(picked), repo, area, lane, size))
            j = bid; s = slots[lane]; line = "\t".join([bid, repo, lane, tier, pf]); batches.append({"job": bid, "tasks": len(picked)})
        elif pc_n < PC_MAX and not over_budget():   # empty-run precheck (contrib/precheck.sh): no model call, fail open
            pc_n += 1; pc = precheck(j, repo, pf)
            if pc and pc[0] == 13:
                first = park(park_state, j, key, NOW)
                jsave(PARK_PATH, park_state)
                if first:
                    metric({"event": "precheck_parked", "job": j, "repo": repo,
                            "lane": lane, "code": 13, "retry_at": park_state[j]["retry_at"]})
                    ev("PARKED %s [precheck code=13 acceptance unproven]" % j)
                rest.append(line); continue
            if j in park_state:
                park_state.pop(j); jsave(PARK_PATH, park_state)
            if pc:
                open(Q + "/precheck-skips.tsv", "a").write("%s\t%s\t%d\t%s\n" % (TS, j, pc[0], pc[1]))
                metric({"event": "precheck_skip", "job": j, "repo": repo, "lane": lane, "code": pc[0]})
                ev("DONE-NOOP %s [precheck code=%d %s]" % (j, pc[0], pc[1])); continue
        if os.path.exists("%s/%s.publish" % (R, j)):   # relaunch on a kept worktree: archive old result
            os.replace("%s/%s.publish" % (R, j), "%s/%s.publish.prev-%d" % (R, j, NOW))
        if j in keep:
            keep.discard(j); open(Q + "/keep.txt", "w").write("\n".join(sorted(keep)) + "\n")
        for x in (".keptlogged", ".diskguard", ".phdrip", ".rc", ".timeout"):
            try: os.remove(RUN + "/" + j + x)
            except FileNotFoundError: pass
        open(RUN + "/" + j + ".line", "w").write(line + "\n")
        open("%s/%s.launch" % (R, j), "w").close()  # discard the previous attempt before claiming
        open(RUN + "/" + j + ".dispatched", "w").write(str(int(NOW)))
        metric({"event": "claim", "job": j, "repo": repo, "lane": lane, "tier": tier})
        env = {k: os.environ[k] for k in ("HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG") if k in os.environ}
        launch_cmd = (["/usr/bin/python3", "-I", R + "/bin/local_job.py"] if lane == "codex-local"
                      else ["/bin/bash", R + "/bin/launch.sh"])
        try:
            subprocess.Popen(launch_cmd + [j, repo, lane, tier], stdin=open(pf),
                             stdout=open("%s/%s.launch" % (R, j), "w"), stderr=subprocess.STDOUT,
                             env=env, start_new_session=True, cwd=H)
        except OSError as e:   # EAGAIN/ENOMEM: the host is past its process or memory limit. Back off now, retry later.
            os.remove(RUN + "/" + j + ".dispatched"); rest.append(line)
            CONC["fork_failures"].append(NOW); ev("FORK_FAILED %s %s (concurrency backoff)" % (j, type(e).__name__))
            conc_adjusted(concurrency.backoff(CONC, NOW, "backoff fork", {"fork": ("danger", len(CONC["fork_failures"]))}, CONC_FLOOR, CONC_CEILING))
            GCAP = min(GCAP, global_cap()); continue
        if j.startswith("RQ-FIX-MAIN-"): fix_main_repos.add(repo)
        if target: drain_targets.add(target)
        fam = "codex" if lane.startswith("codex") and lane != "codex-local" else lane
        mj = jload(R + "/models.json", {}); model = mj.get(fam + "." + tier) or mj.get(fam)
        metric({"event": "launch", "job": j, "repo": repo, "lane": lane, "tier": tier, "model": model, "mem_free_pct": free, "swap_gb": swap,
                "batch_size": len(batch[0]) if batch else None})
        running[lane] += 1; local_mid += lane == "codex-local" and tier == "mid"; launched.append(j); ev("LAUNCH %s %s %s %s" % (j, repo, lane, tier))
else:
    rest = lines
# Reconcile concurrent parked-row rewrites as well as appended rows.
lk = qlock("dispatchd-write", 30)
if lk is None: log("ready.lock busy; ready.tsv rewrite skipped (launched jobs stay guarded by alive/worktree checks)"); raise SystemExit(0)
from collections import Counter
current = rd(Q + "/ready.tsv").splitlines()
old_counts, current_counts = Counter(_raw), Counter(current)
removed = old_counts - current_counts
survivors = []
for l in rest:
    if parked_row(l) and removed[l]: removed[l] -= 1
    else: survivors.append(l)
rest = survivors
added = current_counts - old_counts
for l in current:
    if added[l] and l.strip() and not l.startswith("#"):
        rest.append(l); added[l] -= 1
t = Q + "/ready.tsv.tmp"; open(t, "w").write("".join(l + "\n" for l in rest)); os.replace(t, Q + "/ready.tsv")
lk.close()
jsave(Q + "/slots.json", slots)
concurrency.save(CONC_PATH, CONC)

# ---- restock trigger: a codex lane's queue below 3x its free slots -> Mac-side deterministic restocker (no LLM)
import queue_gate
_gate = queue_gate.read_gate(Q)
ev("QUEUE_GATE allow=%s depth=%s target=%s src=dispatchd" % (_gate["allow"], _gate["depth"], _gate["target"]))
rate_parked = any("PARKED-MERGERATE." in l for l in rest)
if rate_parked: _ph_open_prs()
for lane in ("codex-cmp", "codex-personal", "devin", "claude-api", "codex-local"):
    sl = slots[lane]
    if sl.get("held") or lane in hold: continue
    qn = sum(1 for l in rest if not parked_row(l) and l.split("\t")[2:3] == [lane])
    if _gate["allow"] and (rate_parked or qn < 3 * max(sl["target"] - running[lane], 4)) and os.path.exists(Q + "/router-queue.md") and not os.path.exists(Q + "/RESTOCK_OFF"):
        subprocess.Popen(["/bin/bash", R + "/bin/restock.sh"], stdin=subprocess.DEVNULL, stdout=open(Q + "/restock.log", "a"),
                         stderr=subprocess.STDOUT, start_new_session=True)
        break
# ---- verified completion (RQ-SWE5-VERIFY-METRIC; mirror of src/core/fleet/agent-activity.ts foldVerifiedCompletion — keep in sync)
# A task counts as verified complete only when an independent check confirms it: the reconciled
# GitHub state of the PR it published (MERGED/CLOSED via metrics-outcomes), never the worker's own
# "done" report, a non-empty finish, or a publish event alone. Claims: `published` (non-batch job
# published >=1 github PR url in-window), `batch-member` (task_outcome done; resolves through the
# batch session's published PRs), `outcome` (bare outcome row, no publish observed). Coordination
# failures: duplicates (one attempt >1 PR, or one PR claimed by >1 job), false completions (every
# published PR CLOSED), unauthorized actions (PR repo != the job's routed repo). RQ-BATCH-* session
# jobs are infrastructure: their publishes resolve member claims but never form claims themselves.
VC_WINDOW_S = 24 * 3600
VC_LIFECYCLE = {"enqueue", "claim", "batch_claim", "queued", "launch", "finish", "publish", "outcome", "task_outcome"}
VC_QUEUE = {"enqueue", "claim", "batch_claim", "queued", "launch"}
VC_RESOLVED = {"MERGED", "CLOSED", "OPEN"}
VC_PR = re.compile(r"^https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/pull/([1-9][0-9]*)/?$", re.I)
VC_JOB = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$")
VC_LANE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$")
VC_LABEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,79}$")
VC_BATCH_PREFIX = "RQ-BATCH-"
VC_MAX_DETAIL = 20

def _vc_pick(row, *keys):
    for k in keys:
        v = row.get(k)
        if isinstance(v, str) and v.strip(): return v.strip()
    return None

def _vc_num(row, *keys):
    for k in keys:
        v = row.get(k)
        if isinstance(v, bool): continue
        if isinstance(v, (int, float)) and math.isfinite(v): return v
        if isinstance(v, str) and v.strip():
            try: return float(v)
            except ValueError: pass
    return None

def _vc_ts(value):
    """ISO-8601 ts -> epoch seconds; None when absent/unparseable. Offset-aware; naive reads as local."""
    if not isinstance(value, str): return None
    s = value.strip()
    if not s: return None
    try:
        d = datetime.datetime.fromisoformat(s[:-1] + "+00:00" if s.endswith(("Z", "z")) else s)
    except ValueError:
        m = re.match(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})([+-]\d{2})(\d{2})$", s)   # -0500 without colon
        if not m: return None
        try: d = datetime.datetime.fromisoformat(m.group(1) + m.group(2) + ":" + m.group(3))
        except ValueError: return None
    try:
        return d.timestamp() if d.tzinfo is not None else time.mktime(d.timetuple()) + d.microsecond / 1e6
    except (OverflowError, OSError, ValueError): return None

def _vc_event(row):
    """Lifecycle event name, or None for operational rows. Eventless producer/reconciler rows
    infer from phase (eval-report/batcher convention): PUBLISHED -> publish, MERGED/CLOSED/OPEN -> outcome."""
    ev = _vc_pick(row, "event", "type", "kind")
    if ev is not None:
        if ev == "published": return "publish"
        return ev if ev in VC_LIFECYCLE else None
    ph = _vc_phase(row)
    if ph == "PUBLISHED": return "publish"
    if ph in ("MERGED", "CLOSED", "OPEN"): return "outcome"
    return None

def _vc_phase(row):
    v = _vc_pick(row, "outcome", "state", "status")
    return v.upper() if v else None

def _vc_pr(row):
    """Canonical PR identity (lowercase owner/repo key + repoLc) or None."""
    for k in ("url", "pr_url", "prUrl", "pr", "html_url"):
        v = row.get(k)
        if isinstance(v, str) and len(v) <= 512:
            m = VC_PR.match(v.strip())
            if m:
                o, r, n = m.group(1).lower(), m.group(2).lower(), m.group(3)
                return "https://github.com/%s/%s/pull/%s" % (o, r, n), "%s/%s" % (o, r)
    return None

def _vc_bounded(value, rx):
    return value if value is not None and rx.match(value) else None

def _vc_fresh():
    return {"boundary": float("-inf"), "finish": None, "publish_ts": None, "publish_lane": None,
            "urls": [], "url_set": set(), "task_outcome": None, "batch_id": None,
            "job_outcome": None, "outcome_ts": None, "lane": None, "repo": None}

def _vc_terminal(a):
    return a["finish"] is not None or a["publish_ts"] is not None or a["outcome_ts"] is not None or a["task_outcome"] is not None

def _vc_last_boundary(a):
    return max((a["finish"] or {}).get("ts", 0), a["publish_ts"] or 0, a["outcome_ts"] or 0, (a["task_outcome"] or {}).get("ts", 0))

def _vc_merge_meta(a, row):
    lane = _vc_bounded(_vc_pick(row, "lane", "pool"), VC_LANE)
    repo = _vc_bounded(_vc_pick(row, "repo"), VC_LABEL)
    if a["lane"] is None and lane: a["lane"] = lane
    if a["repo"] is None and repo: a["repo"] = repo

def _vc_url_edge(url_jobs, url, job, ts):
    by_job = url_jobs.setdefault(url, {})
    if job not in by_job or ts < by_job[job]: by_job[job] = ts

def _vc_verdict(urls, url_states):
    """MERGED wins; all-CLOSED fails; anything unresolved stays pending."""
    merged = closed = unresolved = False
    for u in urls:
        s = url_states.get(u)
        if s == "MERGED": merged = True
        elif s == "CLOSED": closed = True
        else: unresolved = True
    if merged: return "verified"
    if closed and not unresolved: return "failed"
    return "pending"

def _vc_repo_match(routed, url_repo_lc):
    """routed 'owner/name' matches exactly; basename routes match the repo name only."""
    r = routed.strip().lower()
    return r == url_repo_lc if "/" in r else r == url_repo_lc.rsplit("/", 1)[-1]

def verified_completion(mets, now, missing=False):
    cutoff = now - VC_WINDOW_S
    url_states, url_jobs, claim_urls = {}, {}, {}
    jobs, dropped = {}, 0
    for row in mets:
        if not isinstance(row, dict): dropped += 1; continue
        ev = _vc_event(row)
        if ev is None: continue
        job = _vc_pick(row, "job", "job_id", "jobId", "id")
        ts = _vc_ts(_vc_pick(row, "ts", "at", "time", "timestamp", "mergedAt", "closedAt", "recordedAt", "updatedAt"))
        if job is None or not VC_JOB.match(job) or ts is None: dropped += 1; continue
        j = jobs.setdefault(job, {"attempts": [], "current": _vc_fresh(), "repo": None})
        a = j["current"]
        if ev in VC_QUEUE:
            if _vc_terminal(a) and ts >= _vc_last_boundary(a):
                j["attempts"].append(a); a = j["current"] = _vc_fresh()
            if ts > a["boundary"]: a["boundary"] = ts
            _vc_merge_meta(a, row)
            if ev == "batch_claim":
                b = _vc_bounded(_vc_pick(row, "batch", "batch_id", "batchId"), VC_JOB)
                if b and a["batch_id"] is None: a["batch_id"] = b
            repo = _vc_bounded(_vc_pick(row, "repo"), VC_LABEL)
            if repo: j["repo"] = repo
            continue
        if ev == "publish":
            pr = _vc_pr(row); phase = _vc_phase(row)
            if phase in VC_RESOLVED:
                # Reconciler resolution row: PR state + claim evidence, never a new claim or attempt state.
                if pr: url_states[pr[0]] = phase; _vc_url_edge(url_jobs, pr[0], job, ts)
                continue
            if ts < a["boundary"]: continue
            if pr:
                if pr[0] not in a["url_set"]:
                    a["url_set"].add(pr[0]); a["urls"].append(pr[0])
                    claim_urls.setdefault(job, set()).add(pr[0])
                _vc_url_edge(url_jobs, pr[0], job, ts)
                if a["publish_ts"] is None:
                    a["publish_ts"] = ts
                    a["publish_lane"] = _vc_bounded(_vc_pick(row, "lane", "pool"), VC_LANE)
            _vc_merge_meta(a, row)
            continue
        if ev == "outcome":
            pr = _vc_pr(row); phase = _vc_phase(row) or "RECORDED"
            # A url's reconciled state is a fact about the PR, not the attempt: github timestamps can
            # predate a requeue boundary, so url_states/claim evidence update before the attempt guard.
            if pr: url_states[pr[0]] = phase; _vc_url_edge(url_jobs, pr[0], job, ts)
            if ts >= a["boundary"]:
                if not pr and (a["job_outcome"] is None or ts >= a["job_outcome"]["ts"]):
                    a["job_outcome"] = {"state": phase, "ts": ts}
                if a["outcome_ts"] is None or ts >= a["outcome_ts"]: a["outcome_ts"] = ts
                _vc_merge_meta(a, row)
            continue
        if ts < a["boundary"]: continue
        if ev == "finish":
            if a["finish"] is None:
                code = _vc_num(row, "exit_code", "exitCode")
                a["finish"] = {"ts": ts, "ok_nonempty": code == 0 and row.get("empty") is not True}
            _vc_merge_meta(a, row)
            continue
        # task_outcome — batch member result from the session's BRIDGE_NOTES.
        o = _vc_pick(row, "outcome")
        if o is not None and (a["task_outcome"] is None or ts >= a["task_outcome"]["ts"]):
            b = _vc_bounded(_vc_pick(row, "batch", "batch_id", "batchId"), VC_JOB) or a["batch_id"]
            a["task_outcome"] = {"outcome": o.lower(), "batch": b, "ts": ts}
        if a["outcome_ts"] is None or ts >= a["outcome_ts"]: a["outcome_ts"] = ts
        _vc_merge_meta(a, row)

    claims, multi_pr = [], set()
    completed_unpublished = 0
    for job, j in jobs.items():
        is_batch = job.startswith(VC_BATCH_PREFIX)
        wurls = set(); has_done = has_resolved = ok_finish = False
        for att in j["attempts"] + [j["current"]]:
            if att["publish_ts"] is not None and att["publish_ts"] >= cutoff: wurls.update(att["urls"])
            if att["finish"] and att["finish"]["ok_nonempty"] and att["finish"]["ts"] >= cutoff: ok_finish = True
            if att["task_outcome"] and att["task_outcome"]["outcome"] == "done": has_done = True
            if att["job_outcome"] and att["job_outcome"]["state"] in ("MERGED", "CLOSED"): has_resolved = True
            if is_batch: continue   # batch sessions are infrastructure, not tasks
            if att["publish_ts"] is not None and att["publish_ts"] >= cutoff and att["urls"]:
                claims.append({"job": job, "kind": "published", "lane": att["publish_lane"] or att["lane"],
                               "ts": att["publish_ts"], "verdict": _vc_verdict(att["urls"], url_states)})
            to = att["task_outcome"]
            if to and to["outcome"] == "done" and to["ts"] >= cutoff:
                bus = claim_urls.get(to["batch"]) if to["batch"] else None
                claims.append({"job": job, "kind": "batch-member", "lane": att["lane"], "ts": to["ts"],
                               "verdict": _vc_verdict(bus, url_states) if bus else "pending"})
            jo = att["job_outcome"]
            if (not att["urls"] and (not to or to["outcome"] != "done") and jo
                    and jo["state"] in ("MERGED", "CLOSED") and jo["ts"] >= cutoff):
                claims.append({"job": job, "kind": "outcome", "lane": att["lane"], "ts": jo["ts"],
                               "verdict": "verified" if jo["state"] == "MERGED" else "failed"})
        if len(wurls) > 1: multi_pr.add(job)
        if not is_batch and ok_finish and not claim_urls.get(job) and not has_done and not has_resolved:
            completed_unpublished += 1

    by_lane, false_jobs = {}, set()
    kind_count = {"published": 0, "batch_members": 0, "outcomes": 0}
    eligible = verified = failed = pending = 0
    for c in claims:
        eligible += 1
        kind_count[{"published": "published", "batch-member": "batch_members", "outcome": "outcomes"}[c["kind"]]] += 1
        if c["verdict"] == "verified": verified += 1
        elif c["verdict"] == "failed": failed += 1; false_jobs.add(c["job"])
        else: pending += 1
        lane = _vc_bounded(c["lane"], VC_LANE) or "unknown"
        r = by_lane.setdefault(lane, {"eligible": 0, "verified": 0, "failed": 0, "pending": 0})
        r["eligible"] += 1
        if c["verdict"] == "verified": r["verified"] += 1
        elif c["verdict"] == "failed": r["failed"] += 1
        else: r["pending"] += 1

    # Duplicate + unauthorized evidence: in-window url->job edges.
    shared, unauthorized_jobs = {}, set()
    shared_pr_urls = unauthorized_actions = 0
    for url, by_job in url_jobs.items():
        jobs_in_window = {job for job, ts in by_job.items() if ts >= cutoff}
        if len(jobs_in_window) > 1: shared_pr_urls += 1; shared[url] = jobs_in_window
        repo_lc = url[len("https://github.com/"):url.rindex("/pull/")]
        for job in jobs_in_window:
            routed = jobs.get(job, {}).get("repo")
            if routed and not _vc_repo_match(routed, repo_lc):
                unauthorized_actions += 1; unauthorized_jobs.add(job)

    return {"schema": "dispatchd.verified-completion.v1", "window_hours": VC_WINDOW_S // 3600,
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "source_state": "missing" if missing else ("degraded" if dropped else "healthy"),
            "scanned": len(mets), "dropped": dropped, "truncated": False,
            "eligible": eligible, "verified": verified, "failed": failed, "pending": pending,
            "rate": round(verified / (verified + failed), 3) if verified + failed else None,
            "claims": kind_count, "completed_unpublished": completed_unpublished,
            "duplicates": {"multi_pr_jobs": len(multi_pr), "shared_pr_urls": shared_pr_urls},
            "false_completions": failed, "unauthorized_actions": unauthorized_actions,
            "by_lane": by_lane,
            "detail": {"false_completion_jobs": sorted(false_jobs)[:VC_MAX_DETAIL],
                       "multi_pr_jobs": sorted(multi_pr)[:VC_MAX_DETAIL],
                       "shared_pr_urls": sorted(shared)[:VC_MAX_DETAIL],
                       "unauthorized_jobs": sorted(unauthorized_jobs)[:VC_MAX_DETAIL]}}

# ---- (d) status
qdepth = {l: 0 for l in LANES}
for l in rest:
    f = l.split("\t")
    if not parked_row(l) and len(f) >= 3 and f[2] in qdepth: qdepth[f[2]] += 1
pubs = []
for p in glob.glob(R + "/*.publish"):
    if NOW - os.path.getmtime(p) > 86400: continue
    m = re.search(r"RESULT PR (https://github.com/\S+/pull/\d+)", rd(p))
    if m: pubs.append((os.path.getmtime(p), os.path.basename(p)[:-8], m.group(1)))
pubs.sort(reverse=True)
evs = logtail(EV, 65536).splitlines()[-25:]   # tail read: the events log grows unbounded
st = {"schema": "dispatchd.status.v1", "last_tick": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "paused": pause or None,
      "mem_free_pct": free, "swap_gb": round(swap, 2) if swap is not None else None,
      "autopilot": AP,
      "lanes": {l: {"running": running[l], "target": slots[l]["target"], "floor": slots[l]["floor"],
                    "ceiling": slots[l]["ceiling"], "hard_cap": slots[l]["hard_cap"], "held": bool(slots[l].get("held") or l in hold),
                    "queued": qdepth[l]} for l in LANES},
      "queue_depth": len(rest), "invalid_queue_lines": bad, "launched_this_tick": launched,
      "reaping": sorted(set(reaping) | publishing), "kept_worktrees": sorted(kept),
      "publishes_24h": len(pubs), "recent_publishes": [{"job": j, "url": u} for _, j, u in pubs[:20]],
      "recent_events": evs,
      "concurrency": {"cap": CONC["cap"], "floor": CONC_FLOOR, "ceiling": CONC_CEILING, "zones": CONC.get("zones"),
                      "trouble_cap": CONC.get("trouble_cap"), "settled_6h": concurrency.settled(CONC, NOW),
                      "last_adjustment": (CONC["history"] or [None])[-1]},
      "batching": {"enabled": BATCHING, "launched_this_tick": batches,
                   "size_target": {l: batcher.size_for(batch_tuning, l) for l in batcher.BATCH_LANES}}}
# budget per lane: overrides file (Grok Bot writes Mason's readings) + log-derived token burn
ov = jload(Q + "/budget-overrides.json", {}); budget = {}
mets = JOBS_RAW
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
    budget["claude-api"].update(REPORT_F.result() or {})
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
st["verified_completion"] = verified_completion(mets, NOW, missing=not os.path.exists(MD + "/jobs.jsonl"))
stamp = MD + "/.outcomes.stamp"
if not os.path.exists(stamp) or NOW - os.path.getmtime(stamp) > 600:
    open(stamp, "w").close()
    subprocess.Popen(["/bin/bash", R + "/bin/metrics-outcomes.sh"], stdin=subprocess.DEVNULL, stdout=open(MD + "/outcomes.log", "a"),
                     stderr=subprocess.STDOUT, start_new_session=True)
_at_cap = "at_cap running %d >= cap %d" % (sum(running.values()), GCAP) if sum(running.values()) >= GCAP else None
_block = [x for x in (_now_reason, "paused" if pause else None, _at_cap) if x]   # same verdict `phm pool admission` computes
adm = {"schema": "dispatchd.admission.v2", "ts": st["last_tick"], "admit": not _block, "gate_reason": _now_reason, "warnings": GATE["warnings"], "reason": "; ".join(_block) or None,
       "disabled": GATE["disabled"], "load1": GATE["load1"], "ncpu": GATE["ncpu"], "load_max": GATE["load_max"], "procs": GATE["procs"], "worktrees": GATE["worktrees"],
       "daemon_tick_age_s": GATE["daemon_tick_age_s"], "local_mid_cap": LOCAL_MID_CAP, "cap": GCAP, "running": sum(running.values()), "hard_cap": slots.get("hard_cap"), "install_lock_holder": _install_holder(),
       "concurrency_cap": CONC["cap"], "concurrency_floor": CONC_FLOOR, "concurrency_ceiling": CONC_CEILING, "concurrency_zones": CONC.get("zones")}
adm.update({k: v for k, v in GATE.items() if k != "tripped"})
adm["decision"] = "stop" if _block else ("halve_claims" if GATE["soft_load"] else "admit")
jsave(Q + "/admission.json", adm); st["admission"] = adm
jsave(Q + "/status.json", st)
log("tick run=%s q=%d launched=%d reap=%d pause=%s wall=%.0fs" % (json.dumps(running), len(rest), len(launched), nreap, bool(pause), time.time() - NOW))
