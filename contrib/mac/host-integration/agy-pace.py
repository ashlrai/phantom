#!/usr/bin/env python3
"""AGY lane pacer (Security rev1c, 2026-11-03; rev1c: result line is event=="result", fields nested under "result"). Local file I/O only: no network, no secrets, no subprocess.
gate <job> <tier>               reserve tokens under a rolling 7d window; exit 3 = HELD; held 1h after a quota error.
record <job> <rc> <ndjson> <log> charge from the LAST result object in agy --output-format stream-json (usage token counts x MARGIN),
                                else the reservation. At most one fixed classifier line for dispatchd AB_RX, taken only from the
                                CLI's own status/error/finished_reason fields of that result object (never the response text or the log):
                                  agy-pace: quota_exhausted | agy-pace: auth_failed | agy-pace: rate_limited
Google publishes no Starter token numbers, so CAPWK is a calibration constant. Env may only lower caps. The result schema is
verified at the sandboxed probe; until then unknown shapes simply charge the full reservation and classify nothing."""
import fcntl, json, os, re, sys, time
R = os.path.expanduser("~/.ashlr-runs"); ST = R + "/queue/agy.usage.json"; LK = ST + ".lock"
WK = 7 * 86400; CAPWK = 6_000_000; MARGIN = 1.10; COOL = 3600
RESERVE = {"fast": 150_000, "work": 600_000, "frontier": 600_000}
try: CAPWK = max(0, min(CAPWK, int(os.environ.get("AGY_CAPWK", CAPWK))))
except ValueError: pass
JID = re.compile(r"^[A-Za-z0-9._-]{1,120}$")
QUOTA = ("RESOURCE_EXHAUSTED", "individual quota reached", "INSUFFICIENT_G1_CREDITS_BALANCE")
AUTH = ("UNAUTHENTICATED", "not logged into Antigravity", "stored credentials are invalid or expired")
RATE = ("MODEL_CAPACITY_EXHAUSTED",)
def load():
    try:
        with open(ST) as f: s = json.load(f)
    except (OSError, ValueError): s = {}
    if not isinstance(s, dict): s = {}
    s.setdefault("events", []); s.setdefault("reserved", {}); s.setdefault("hold_until", 0)
    now = time.time(); s["events"] = [e for e in s["events"] if isinstance(e, list) and len(e) == 2 and now - e[0] < WK]; return s
def used(s): return sum(e[1] for e in s["events"]) + sum(s["reserved"].values())
def save(s):
    t = "%s.tmp.%d" % (ST, os.getpid())
    fd = os.open(t, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f: json.dump(s, f); f.flush(); os.fsync(f.fileno())
    os.replace(t, ST)
def last_result(p):
    # rev1c: agy 1.4.12 stream-json ends with {"event":"result","result":{conversation_id,status,response,duration_seconds,
    # num_turns,usage,error,finished_reason}}. Only a top-level line whose event is "result" counts; the model's response text
    # is a string inside it and is never parsed, so a forged result inside response cannot classify or change the charge.
    if not p or os.path.islink(p) or not os.path.isfile(p) or os.path.getsize(p) > (16 << 20): return None
    r = None
    with open(p, "rb") as f:
        for ln in f:
            try: o = json.loads(ln)
            except ValueError: continue
            if isinstance(o, dict) and o.get("event") == "result" and isinstance(o.get("result"), dict): r = o["result"]
    return r
def main(a):
    if len(a) < 2 or a[0] not in ("gate", "record") or not JID.match(a[1]): print("HELD: agy-pace bad args"); return 3
    os.makedirs(os.path.dirname(ST), exist_ok=True)
    lk = os.open(LK, os.O_RDWR | os.O_CREAT, 0o600); fcntl.flock(lk, fcntl.LOCK_EX)
    s = load(); now = time.time()
    if a[0] == "gate":
        tier = a[2] if len(a) > 2 else ""
        if tier not in RESERVE: print("HELD: agy tier must be fast, work or frontier"); return 3
        if now < s["hold_until"]: print("HELD: agy quota cooldown"); return 3
        if used(s) + RESERVE[tier] > CAPWK: print("HELD: agy weekly cap (%d of %d)" % (used(s), CAPWK)); return 3
        s["reserved"][a[1]] = RESERVE[tier]; save(s); print("ok"); return 0
    res = s["reserved"].pop(a[1], RESERVE["work"])
    d = last_result(a[3] if len(a) > 3 else ""); tok = None
    u = d.get("usage") if isinstance(d, dict) else None
    if isinstance(u, dict):
        v = [u.get(k, 0) for k in ("total_tokens", "thinking_tokens")]
        if all(isinstance(x, int) and not isinstance(x, bool) and 0 <= x < 10**9 for x in v) and v[0] > 0: tok = int((v[0] + v[1]) * MARGIN)
    s["events"].append([now, tok if tok is not None else res])
    line = None
    if isinstance(d, dict) and d.get("status") not in (None, "SUCCESS"):
        err = d.get("error"); err = json.dumps(err)[:4000] if isinstance(err, (dict, list)) else str(err or "")[:4000]
        err += " " + str(d.get("status"))[:200] + " " + str(d.get("finished_reason") or "")[:200]
        if any(k in err for k in QUOTA): line = "agy-pace: quota_exhausted"; s["hold_until"] = now + COOL
        elif any(k in err for k in AUTH): line = "agy-pace: auth_failed"
        elif any(k in err for k in RATE): line = "agy-pace: rate_limited"
    save(s)
    if line: print(line)
    return 0
if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
