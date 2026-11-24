"""Before/after numbers from ~/.ashlr-runs files only (verified sources, no estimates):
  sessions: metrics/load-curve.jsonl running_total (1/min samples of queue/status.json)
  merges:   metrics/jobs.jsonl outcome events with state MERGED, de-duplicated by PR url
  pauses:   memguard.log lines with a non-empty pause=[...]; consecutive lines <= 2.5 min apart are one episode
"""
from __future__ import annotations

import json
import os
import re
import statistics
import time
from datetime import datetime, timedelta


def _ts(s):
    s = s.strip()
    if re.search(r"[+-]\d{4}$", s): s = s[:-2] + ":" + s[-2:]
    return datetime.fromisoformat(s).timestamp()


def _lines(p):
    try:
        with open(p, errors="replace") as f:
            for l in f: yield l
    except OSError:
        return


def baseline(P, windows_h, now=None):
    now = now or time.time()
    lc = []
    for l in _lines(os.path.join(P.R, "metrics", "load-curve.jsonl")):
        try:
            d = json.loads(l)
            if d.get("running_total") is not None: lc.append((_ts(d["ts"]), d["running_total"]))
        except (ValueError, KeyError):
            continue
    merged = {}
    for l in _lines(os.path.join(P.R, "metrics", "jobs.jsonl")):
        if '"MERGED"' not in l: continue
        try:
            d = json.loads(l)
            if d.get("event") == "outcome" and d.get("state") == "MERGED":
                merged.setdefault(d.get("url") or d.get("job"), _ts(d["ts"]))
        except (ValueError, KeyError):
            continue
    eps, cur, prev = [], None, None
    for l in _lines(os.path.join(P.R, "memguard.log")):
        m = re.match(r"(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) .*?pause=\[([^\]]*)\]", l)
        if not m: continue
        t = time.mktime(time.strptime(m.group(1), "%Y-%m-%d %H:%M:%S"))
        r = m.group(2).strip()
        if r:
            if cur and prev and t - prev <= 150: cur[1] = t; cur[2].update(x.split("=")[0] for x in r.split())
            else: cur = [t, t, set(x.split("=")[0] for x in r.split())]; eps.append(cur)
            prev = t
        else:
            cur = prev = None
    out = {"now": datetime.fromtimestamp(now).astimezone().isoformat(timespec="seconds"), "windows": {}}
    for h in windows_h:
        a = now - h * 3600
        rs = sorted(r for t, r in lc if t >= a)
        m = [t for t in merged.values() if t >= a]
        E = [e for e in eps if e[1] >= a]
        pmin = sum((min(e[1], now) - max(e[0], a)) / 60 + 1 for e in E)
        reasons = {}
        for e in E:
            for k in e[2]: reasons[k] = reasons.get(k, 0) + 1
        pct = (lambda p: rs[int(p * (len(rs) - 1))]) if rs else (lambda p: None)
        out["windows"]["%gh" % h] = {
            "sessions": {"samples": len(rs), "coverage": round(len(rs) / (h * 60), 3), "mean": round(statistics.mean(rs), 2) if rs else None,
                         "median": pct(0.5), "p10": pct(0.1), "p90": pct(0.9), "max": rs[-1] if rs else None},
            "merges": len(m), "merges_per_hour": round(len(m) / h, 2),
            "pause_episodes": len(E), "pause_episodes_per_day": round(len(E) / (h / 24), 2),
            "paused_minutes": round(pmin), "paused_share": round(pmin / (h * 60), 3), "pause_reasons": reasons,
        }
    return out


def shadow_report(P, hours, now=None):
    now = now or time.time()
    a = now - hours * 3600
    n = 0; acts = {}; zones = {}; deltas = []; sheds = 0; alerts = 0
    for l in _lines(os.path.join(P.R, "metrics", "cruise-shadow.jsonl")):
        try: d = json.loads(l)
        except ValueError: continue
        try:
            if _ts(d["ts"]) < a: continue
        except (KeyError, ValueError):
            continue
        n += 1
        c = d.get("cruise") or {}
        acts[c.get("action")] = acts.get(c.get("action"), 0) + 1
        zones[c.get("zone")] = zones.get(c.get("zone"), 0) + 1
        if d.get("delta_target") is not None: deltas.append(d["delta_target"])
        sheds += 1 if c.get("shed") else 0
        alerts += len(d.get("alerts") or [])
    return {"ticks": n, "actions": acts, "zones": zones, "shed_decisions": sheds, "alerts": alerts,
            "cruise_target_minus_dispatchd_running": {"mean": round(statistics.mean(deltas), 2) if deltas else None,
                                                     "max": max(deltas) if deltas else None, "min": min(deltas) if deltas else None}}
