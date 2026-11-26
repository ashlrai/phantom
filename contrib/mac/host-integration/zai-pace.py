#!/usr/bin/env python3
"""Z.ai lane pacer (Security rev1, 2026-11-03). Local file I/O only: no network, no secrets, no subprocess.
gate <job> <tier>               reserve credits under BOTH a rolling 5h window and a rolling 7d window; exit 3 = HELD
record <job> <rc> <json> <log>  charge the job from Claude Code's JSON usage with Z.ai's published credit formula
                                (docs.z.ai/devpack/overview: credits = (in*mi + cached_in*mc + out*mo) / 10000, peak rate 1x)
                                times a 1.25 safety margin; else the full reservation. Release the reservation. On a Z.ai
                                quota/plan error (business codes 1113, 1308-1321) or auth error (401, 1000-1005) print one
                                fixed classifier line for dispatchd AB_RX.
Rolling windows are at least as strict as Z.ai's fixed weekly cycle. Caps are constants; env may only lower them.
USE-IT-ALL rev1: caps sit at 97% of the Lite plan (2,000 / 5h, 10,000 / week). Overage cannot bill (balance $0, auto-recharge off,
Z.ai FAQ: quota exhaustion never draws balance), so the only cost of hitting the cap is a held lane. The weekly cap is charged
against Z.ai's FIXED weekly cycle once ANCHOR (order time) is confirmed and pinned; until then it stays a rolling 7d window."""
import fcntl, json, os, re, sys, time
R = os.path.expanduser("~/.ashlr-runs"); ST = R + "/queue/zai.usage.json"; LK = ST + ".lock"
CAP5H = 1940; CAPWK = 9700; W5 = 5 * 3600; WK = 7 * 86400; MARGIN = 1.10   # USE-IT-ALL: 97%; margin 1.25->1.10 after first 10 jobs calibrate
# Z.ai docs: weekly quota "starts counting from the time you place your order ... reset on a 7-day cycle" (fixed cycle, anchored at
# order time, not midnight). Until the exact order time is read from the console and pinned here, ANCHOR stays None = rolling 7d.
ANCHOR = None
def cycle_start(now): return now - WK if ANCHOR is None else ANCHOR + max(0, int((now - ANCHOR) // WK)) * WK
RESERVE = {"fast": 250, "work": 700}   # per job, sized for --max-turns in launch.sh (fast 40, work 60)
MULT = {"glm-5.3-flash": (2.3, 0.56, 8.0), "glm-5.3": (6.9, 1.7, 24.0)}   # (input, cached input, output), peak
for n in ("CAP5H", "CAPWK"):
    try: globals()[n] = max(0, min(globals()[n], int(os.environ.get("ZAI_" + n, globals()[n]))))
    except ValueError: pass
JID = re.compile(r"^[A-Za-z0-9._-]{1,120}$")
QUOTA = {"1113": "balance", "1308": "5h", "1309": "expired", "1310": "weekly", "1311": "model", "1313": "fair_use",
         "1316": "5h", "1317": "weekly", "1318": "5h", "1319": "weekly", "1320": "5h", "1321": "weekly"}
AUTH = {"1000", "1001", "1003", "1005"}
def load():
    try:
        with open(ST) as f: s = json.load(f)
    except (OSError, ValueError): s = {}
    if not isinstance(s, dict): s = {}
    s.setdefault("events", []); s.setdefault("reserved", {})
    now = time.time(); s["events"] = [e for e in s["events"] if now - e[0] < WK]; return s
def used(s, win):
    now = time.time(); lo = cycle_start(now) if win == WK else now - win
    return sum(e[1] for e in s["events"] if e[0] >= lo) + sum(s["reserved"].values())
def save(s):
    t = "%s.tmp.%d" % (ST, os.getpid())
    fd = os.open(t, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f: json.dump(s, f); f.flush(); os.fsync(f.fileno())
    os.replace(t, ST)
def read_small(p, n=4 << 20):
    if not p or os.path.islink(p) or not os.path.isfile(p): return ""
    with open(p, "rb") as f: return f.read(n).decode("utf-8", "replace")
def credits(d):
    mu = d.get("modelUsage")
    if not isinstance(mu, dict) or not mu: return None
    c = 0.0
    for name, u in mu.items():
        mi, mc, mo = MULT["glm-5.3-flash"] if "flash" in str(name).lower() else MULT["glm-5.3"]
        tin = int(u.get("inputTokens", 0)) + int(u.get("cacheCreationInputTokens", 0))
        c += (tin * mi + int(u.get("cacheReadInputTokens", 0)) * mc + int(u.get("outputTokens", 0)) * mo) / 10000.0
    return int(c * MARGIN) + 1
def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ("gate", "record") or not JID.match(sys.argv[2]):
        print("usage: zai-pace.py gate JOB TIER | record JOB RC JSON LOG"); sys.exit(2)
    cmd, job = sys.argv[1], sys.argv[2]
    os.makedirs(os.path.dirname(ST), exist_ok=True)
    lk = os.open(LK, os.O_RDWR | os.O_CREAT, 0o600); fcntl.flock(lk, fcntl.LOCK_EX)
    s = load()
    if cmd == "gate":
        tier = sys.argv[3] if len(sys.argv) > 3 else ""
        if tier not in RESERVE: print("HELD: zai tier must be fast or work"); sys.exit(3)
        rv = RESERVE[tier]; u5, uw = used(s, W5), used(s, WK)
        if u5 + rv > CAP5H: print("HELD: zai 5h window (%d of %d)" % (u5, CAP5H)); sys.exit(3)
        if uw + rv > CAPWK: print("HELD: zai weekly window (%d of %d)" % (uw, CAPWK)); sys.exit(3)
        s["reserved"][job] = rv; save(s); print("ok"); return
    d = None
    try: d = json.loads(read_small(sys.argv[4] if len(sys.argv) > 4 else ""))
    except ValueError: pass
    rv = s["reserved"].pop(job, max(RESERVE.values()))
    n = None
    if isinstance(d, dict):
        try: n = credits(d)
        except (AttributeError, TypeError, ValueError): n = None
    s["events"].append([time.time(), rv if n is None else n]); save(s)
    # classify only from Claude Code's own error result (is_error true), never from model text or the log
    if not (isinstance(d, dict) and d.get("is_error") is True): return
    res = str(d.get("result", ""))[:4000]; st = d.get("api_error_status")
    m = re.match(r'^API Error: (\d{3})\b.{0,40}?"code":\s*"?(\d{4})"?', res, re.S)
    http = int(m.group(1)) if m else (st if isinstance(st, int) else None); biz = m.group(2) if m else None
    if biz in QUOTA: print("zai-pace: quota_exhausted " + QUOTA[biz])
    elif http == 401 or biz in AUTH: print("zai-pace: auth_failed")
    elif http == 429: print("zai-pace: rate_limited")
if __name__ == "__main__": main()
