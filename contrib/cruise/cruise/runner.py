"""ashlr-runs host integration for CRUISE-1 (one tick per call; launchd runs it every interval).

Shadow mode (default): sample, decide, and log the decision NEXT TO dispatchd's actual one in
metrics/cruise-shadow.jsonl, write queue/cruise-decision.json (read by the CRUISE-1 dispatchd
gate only when ~/.ashlr-runs/CRUISE_ENFORCE exists), raise runaway-daemon bus alerts, and write
the dry-run RSS-cap and zombie plans. It never launches, kills or pauses anything unless an
APPLY marker exists, and never when the fleet KILL (~/.ashlr/KILL) is present. It never touches
PAUSE, memguard, or any system process.
"""
from __future__ import annotations

import json
import os
import pwd
import re
import signal
import time

from . import sensors as _sensors
from .controller import Controller
from .watchdog import Watchdog
from .profiles import priors_for
from . import markers as _markers
from . import capacity as _capacity
from . import heartbeat as _heartbeat

JID = re.compile(r"^[A-Za-z0-9._-]{1,120}$")
DYNAMIC_PAUSE = re.compile(r"\b(swap_growth|mem_free|mem_level)=")


def real_home():
    return pwd.getpwuid(os.getuid()).pw_dir


def _jload(p, default=None):
    try:
        with open(p) as f: return json.load(f)
    except (OSError, ValueError):
        return default


def _jsave(p, obj):
    t = p + ".tmp"
    with open(t, "w") as f: json.dump(obj, f, separators=(",", ":"), default=str)
    os.replace(t, p)


def _read(p):
    try:
        with open(p) as f: return f.read()
    except OSError:
        return ""


class Paths:
    def __init__(self, home=None):
        self.H = home or real_home()
        self.R = os.path.join(self.H, ".ashlr-runs")
        self.Q = os.path.join(self.R, "queue")
        self.RUN = os.path.join(self.Q, "run")
        self.state_dir = os.path.join(self.R, "cruise")
        self.KILL = os.path.join(self.H, ".ashlr", "KILL")         # fleet KILL (dispatchd RQ-SEC-REALHOME-1)
        self.KILL_RUNS = os.path.join(self.R, "KILL")              # ashlr-runs KILL (pin-apply manifest)


def registry(P):
    """{job: {"pgid", "lane", "started_ts"}} from dispatchd's queue/run/<job>.pgid and .line records."""
    out = {}
    try: names = os.listdir(P.RUN)
    except OSError: return out
    for n in names:
        if not n.endswith(".pgid"): continue
        job = n[:-5]
        if not JID.match(job): continue
        p = os.path.join(P.RUN, n)
        try:
            pg = int(_read(p).split()[0]); st = os.path.getmtime(p)
        except (ValueError, IndexError, OSError):
            continue
        line = _read(os.path.join(P.RUN, job + ".line")).split("\t")
        out[job] = {"pgid": pg, "lane": line[2].strip() if len(line) > 2 else None, "started_ts": st}
    return out


def lane_yield(P, st):
    """Incrementally read metrics/jobs.jsonl from the stored offset: launches and merges per lane."""
    path = os.path.join(P.R, "metrics", "jobs.jsonl")
    y = st.setdefault("yield", {"offset": 0, "lanes": {}, "job_lane": {}})
    try: size = os.path.getsize(path)
    except OSError: return y
    if size < y["offset"]: y["offset"] = 0
    with open(path, "rb") as f:
        f.seek(y["offset"])
        chunk = f.read(8 << 20)      # bounded read per tick; the rest is read on later ticks
    last_nl = chunk.rfind(b"\n")
    if last_nl < 0: return y
    y["offset"] += last_nl + 1
    for raw in chunk[:last_nl].splitlines():
        try: d = json.loads(raw)
        except ValueError: continue
        e, job, lane = d.get("event"), d.get("job"), d.get("lane")
        if e == "launch" and lane and job:
            y["job_lane"][job] = lane
            y["lanes"].setdefault(lane, [0, 0])[0] += 1
        elif e == "outcome" and d.get("state") == "MERGED" and job:
            ln = y["job_lane"].get(job)
            if ln: y["lanes"].setdefault(ln, [0, 0])[1] += 1
    if len(y["job_lane"]) > 20000:
        y["job_lane"] = dict(list(y["job_lane"].items())[-10000:])
    return y


def lane_value(y, lane):
    l, m = (y.get("lanes") or {}).get(lane or "", [0, 0])
    return (m + 1.0) / (l + 2.0)   # Laplace-smoothed merges per launch


def dispatchd_view(P):
    s = _jload(os.path.join(P.Q, "status.json"), {}) or {}
    adm = _jload(os.path.join(P.Q, "admission-ctl.json"), {}) or {}
    lanes = s.get("lanes") or {}
    run = {k: v.get("running") for k, v in lanes.items() if isinstance(v, dict)}
    tgt = {k: (0 if v.get("held") else v.get("target")) for k, v in lanes.items() if isinstance(v, dict)}
    q = {k: v.get("queued") for k, v in lanes.items() if isinstance(v, dict)}
    num = lambda d: sum(x for x in d.values() if isinstance(x, (int, float)))
    return {"last_tick": s.get("last_tick"), "paused": s.get("paused"), "running_total": num(run), "target_total": num(tgt),
            "queued_total": num(q), "running": run, "target": tgt, "admit_why": adm.get("why"),
            "max_total_running": adm.get("max_total_running")}


def alert(P, a, now):
    d = os.path.join(P.R, "bus", "core"); os.makedirs(d, exist_ok=True)
    name = re.sub(r"[^A-Za-z0-9_.-]", "_", a["name"])[:60]
    ts = time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(now))
    gb = lambda b: "%.1f GB" % (b / (1 << 30)) if b is not None else "?"
    body = ("# CRUISE ALERT runaway daemon: %s\n\n- owner: Core (Phantom Core Engineer)\n- detector: CRUISE-1 watchdog (alert only; system daemons are never signalled)\n"
            "- detected: %s\n- summary: %s pid %d RSS %s (%.0f%% of RAM, learned baseline %s, z %.1f), CPU %.0f%%, RSS slope %+.1f MB/min\n"
            "- suggested human step: %s\n\n```json\n%s\n```\n") % (
        a["name"], ts, a["name"], a["pid"], gb(a["rss_bytes"]), 100 * (a.get("rss_share") or 0), gb(a["baseline_bytes"]), a["z"], a["cpu_pct"],
        a["slope_bps"] * 60 / (1 << 20),
        "`sudo killall %s` (launchd restarts it) or a reboot, by Mason only" % a["name"] if a.get("system") else "check the owning job",
        json.dumps(a, indent=1))
    p = os.path.join(d, "CRUISE-ALERT-%s.md" % name)
    t = p + ".tmp"
    with open(t, "w") as f: f.write(body)
    os.replace(t, p)


def kill_group(pgid, job, P, log, grace_s):
    """SIGTERM the registered group, then SIGKILL after grace if still alive. Our groups only."""
    try:
        os.killpg(pgid, signal.SIGTERM); log({"event": "rss_kill_term", "job": job, "pgid": pgid})
    except ProcessLookupError:
        return
    except PermissionError:
        log({"event": "rss_kill_eperm", "job": job, "pgid": pgid}); return
    end = time.time() + grace_s
    while time.time() < end:
        try: os.killpg(pgid, 0)
        except ProcessLookupError: return
        time.sleep(0.5)
    try: os.killpg(pgid, signal.SIGKILL); log({"event": "rss_kill_kill", "job": job, "pgid": pgid})
    except ProcessLookupError: pass


def tick(P=None, sensor=None, now=None, write=True):
    P = P or Paths()
    os.makedirs(P.state_dir, exist_ok=True)
    now = now or time.time()
    sensor = sensor or _sensors.detect()
    st = _jload(os.path.join(P.state_dir, "state.json"), {}) or {}
    s = sensor.sample()
    pri = priors_for(s.mem_total_bytes, s.model, s.os)
    ctl = Controller(st.get("controller"), pri)
    wd = Watchdog(st.get("watchdog"))
    kill_on = os.path.exists(P.KILL) or os.path.exists(P.KILL_RUNS)
    pause = _read(os.path.join(P.R, "PAUSE")).strip()
    prev_pause = st.get("pause") or ""
    bad = bool(pause and DYNAMIC_PAUSE.search(pause) and not DYNAMIC_PAUSE.search(prev_pause))
    # MEMGUARD-MEASURED-1 feed: memguard_measured.py's per-minute record (state/pressure.json). A new global reason
    # there (sustained critical or thrash) is a bad event for threshold learning, so cruise learns to shed before it.
    pz = (_jload(os.path.join(P.R, "state", "pressure.json"), {}) or {}).get("last") or {}
    pz_fresh = isinstance(pz.get("ts"), (int, float)) and now - pz["ts"] <= 300
    if pz_fresh and pz.get("global") and pz.get("global") != st.get("pz_global"): bad = True
    st["pz_global"] = pz.get("global") if pz_fresh else None
    dv = dispatchd_view(P)
    reg = registry(P)
    procs = sensor.processes() or []
    alive_pg = {p.pgid for p in procs}
    live = {j: v for j, v in reg.items() if v["pgid"] in alive_pg}
    y = lane_yield(P, st)
    sessions = [{"job": j, "lane": v["lane"], "started_ts": v["started_ts"], "value": lane_value(y, v["lane"])} for j, v in live.items()]
    running = dv["running_total"] if dv["last_tick"] else len(live)
    demand = dv["queued_total"] or 0
    own = {v["pgid"] for v in live.values()}
    sp = _capacity.split(procs, own) if procs else {}
    dec = ctl.step(s, int(running), int(demand), sessions, bad_event=bad, now=now,
                   fleet={"cpu_share": sp.get("cpu_share"), "mem_share": sp.get("mem_share")} if procs else None)
    hr = _capacity.headroom_slots(sp, len(live), s.mem_total_bytes, s.free_pct, s.ncpu,
                                  ctl.lim["pressure_score"].value, ctl.lim["load_per_core"].value) if procs else None
    alerts = wd.scan_daemons(procs, now, own_pgids=own, mem_total=s.mem_total_bytes, uid_self=os.getuid())
    caps, rss_plan = wd.job_caps(live, procs, now, s.mem_total_bytes, dec["target"])
    zombies = wd.zombies(procs, own)
    mode = "enforce" if os.path.exists(os.path.join(P.R, "CRUISE_ENFORCE")) else "shadow"
    rss_apply = os.path.exists(os.path.join(P.R, "CRUISE_RSS_APPLY")) and not kill_on
    rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(now)), "schema": "ashlr.cruise.shadow.v1", "mode": mode,
           "kill": kill_on, "pause": pause or None, "bad_event": bad, "profile": pri.get("profile"),
           "sample": {k: getattr(s, k) for k in ("pressure_level", "pressure_score", "free_pct", "swap_used_bytes", "compressed_bytes", "load1", "load_per_core", "thermal")},
           "cruise": {k: dec[k] for k in ("zone", "stress", "top", "reasons", "action", "target", "prev_target", "ceiling", "knee", "shed", "warmup", "params")},
           "memguard_measured": {k: pz.get(k) for k in ("level", "swapouts_per_min", "thrash_bar_per_min", "compressor_share", "free_trend_pct_per_min", "sustain_min", "global", "local")} if pz_fresh else None,
           "dispatchd": dv, "registry_live": len(live), "fleet_split": sp or None, "headroom_split": hr,
           "delta_target": (dec["target"] - dv["running_total"]) if dv["last_tick"] else None,
           "alerts": [{k: a[k] for k in ("name", "pid", "rss_bytes", "cpu_pct", "z")} for a in alerts],
           "rss_plan": [{"job": j, "rss": r, "cap": c} for j, _pg, r, c in rss_plan], "rss_apply": rss_apply,
           "zombies": len(zombies), "zombies_ours": sum(1 for z in zombies if z["ours"]), "errors": s.errors}
    if write:
        md = os.path.join(P.R, "metrics"); os.makedirs(md, exist_ok=True)
        with open(os.path.join(md, "cruise-shadow.jsonl"), "a") as f: f.write(json.dumps(rec, separators=(",", ":"), default=str) + "\n")
        _jsave(os.path.join(P.Q, "cruise-decision.json"), dict(dec, mode=mode, kill=kill_on, written=now))
        for a in alerts:
            alert(P, a, now)
            with open(os.path.join(md, "cruise-alerts.jsonl"), "a") as f: f.write(json.dumps(dict(a, ts=now)) + "\n")
        for name in wd.cleared:
            ap = os.path.join(P.R, "bus", "core", "CRUISE-ALERT-%s.md" % re.sub(r"[^A-Za-z0-9_.-]", "_", name)[:60])
            if os.path.exists(ap):
                with open(ap, "a") as f: f.write("\n- resolved: %s (back under the learned bar)\n" % rec["ts"])
        if rss_apply:
            logf = lambda d: open(os.path.join(md, "cruise-actions.jsonl"), "a").write(json.dumps(dict(d, ts=now)) + "\n")
            for job, pg, _r, _c in rss_plan[:1]:      # one kill per tick, like shedding
                kill_group(pg, job, P, logf, grace_s=max(5.0, (ctl.interval.mean or 60.0) / 6))
            for z in zombies:
                if z["ours"]:
                    try: os.kill(z["ppid"], signal.SIGCHLD); logf({"event": "zombie_sigchld", "ppid": z["ppid"], "pid": z["pid"]})
                    except OSError: pass
        last_m = st.get("markers_ts", 0)
        if now - last_m >= 3600:
            items = _markers.plan(os.path.join(P.H, "Projects", "ashlrai", "wt"))
            n = _markers.apply(items) if os.path.exists(os.path.join(P.R, "CRUISE_MARKERS_APPLY")) and not kill_on else 0
            st["markers_ts"] = now; st["markers_last"] = {"planned": len(items), "created": n}
        if now - st.get("heartbeat_ts", 0) >= 300:
            try:
                hb = _heartbeat.build(sensor, st.setdefault("hb_cache", {}), now,
                                      cruise={"profile": pri.get("profile"), "knee": dec["knee"], "target": dec["target"], "zone": dec["zone"],
                                              "limits": dec.get("limits"), "mode": mode})
                _heartbeat.write(hb, P.H); st["heartbeat_ts"] = now
            except Exception as e:
                rec["errors"].append("heartbeat:%s" % type(e).__name__)
        st.update(controller=ctl.state(), watchdog=wd.state(), pause=pause)
        _jsave(os.path.join(P.state_dir, "state.json"), st)
    return rec
