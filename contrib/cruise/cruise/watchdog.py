"""Watchdogs (OS-neutral, operate on sensor Proc rows).

1. Runaway-daemon detector: per process name, a learned RSS baseline and RSS/CPU growth.
   Alert-only for anything we do not own (system daemons such as fseventsd are never signalled).
2. Per-job RSS cap for OUR jobs only (dispatchd's registered process groups): the cap is learned
   per lane (a high streaming quantile of observed job RSS, times a learned headroom) and bounded
   by the node's RAM share per target session. Over-cap for a learned number of consecutive
   ticks -> clean kill plan (SIGTERM the group, grace, SIGKILL), pid-reuse guarded.
3. Zombie report: zombies whose parent is in one of our groups; the fix is SIGCHLD to the parent.
Plans are returned, not executed; runner.py executes only with an APPLY marker and no KILL.
"""
from __future__ import annotations

import math
from .learn import EW, Quantile, Param

# Cold-start RSS priors (bytes) for well-known daemons, so tonight's 22 GB fseventsd is flagged on
# the first tick instead of being learned as "normal". Learned baselines replace them.
DAEMON_PRIORS = {
    "fseventsd": (150 << 20, 100 << 20), "mds": (200 << 20, 100 << 20), "mds_stores": (600 << 20, 300 << 20),
    "mdworker_shared": (60 << 20, 40 << 20), "WindowServer": (900 << 20, 400 << 20), "corespotlightd": (80 << 20, 50 << 20),
}


class Watchdog:
    def __init__(self, state=None):
        st = state or {}
        self.names = {k: EW(v.get("rss"), horizon=1440.0) for k, v in (st.get("names") or {}).items()}
        self.cpu = {k: EW(v.get("cpu"), horizon=1440.0) for k, v in (st.get("names") or {}).items() if v.get("cpu")}
        self.track = st.get("track") or {}          # pid -> {"name", "rss", "ts", "slope", "hits"}
        self.z_alert = Param("z_alert", st.get("z_alert"), prior=6.0, lo=2.0, hi=100.0)
        self.sustain = Param("sustain", st.get("sustain"), prior=3.0, lo=2.0, hi=60.0)
        self.lane_q = {k: Quantile(0.99, v) for k, v in (st.get("lane_q") or {}).items()}
        self.headroom = Param("headroom", st.get("headroom"), prior=1.5, lo=1.1, hi=4.0)
        self.over = st.get("over") or {}            # job -> consecutive over-cap ticks
        self.host_rss = Quantile(0.995, st.get("host_rss"))   # learned "big process" bar for this host
        self.host_cpu = Quantile(0.995, st.get("host_cpu"))
        self.warm = Param("warm", st.get("warm"), prior=30.0, lo=3.0, hi=1440.0)   # samples before an unseeded name may alert
        self.min_share = Param("min_share", st.get("min_share"), prior=0.01, lo=0.001, hi=0.2)   # RSS share of RAM worth an alert
        self.cleared = []
        self.alerted = st.get("alerted") or {}      # name -> {"ts", "cooldown"}

    def _base(self, name):
        b = self.names.get(name)
        if b is None:
            b = EW(None, horizon=1440.0)
            if name in DAEMON_PRIORS: b.mean, b.mad, b.n = float(DAEMON_PRIORS[name][0]), float(DAEMON_PRIORS[name][1]), 1
            self.names[name] = b
        return b

    def scan_daemons(self, procs, now, own_pgids=(), mem_total=None, uid_self=None):
        """Returns alert dicts. Only processes outside our job groups are considered daemons."""
        alerts, seen = [], set()
        bar_rss, bar_cpu = self.host_rss.value, self.host_cpu.value
        for p in procs or []:
            self.host_rss.update(float(p.rss_bytes)); self.host_cpu.update(float(p.cpu_pct))
        for p in procs or []:
            if p.pgid in own_pgids: continue
            seen.add(str(p.pid))
            b = self._base(p.name)
            zr = b.z(float(p.rss_bytes), 0.25) or 0.0
            cb = self.cpu.setdefault(p.name, EW(None, horizon=1440.0))
            zc = (cb.z(p.cpu_pct, 0.25) or 0.0) if p.cpu_pct >= 100.0 * 0.5 else 0.0   # only a process using at least half a core
            z = max(zr, zc)
            t = self.track.get(str(p.pid))
            slope = 0.0
            if t and t.get("name") == p.name and now > t["ts"]:
                slope = (p.rss_bytes - t["rss"]) / (now - t["ts"])
            hits = (t.get("hits", 0) + 1) if (t and z >= self.z_alert.value) else (1 if z >= self.z_alert.value else 0)
            self.track[str(p.pid)] = {"name": p.name, "rss": p.rss_bytes, "ts": now, "slope": slope, "hits": hits}
            if zr < self.z_alert.value: b.update(float(p.rss_bytes))   # learn only from normal-looking samples
            if zc < self.z_alert.value: cb.update(p.cpu_pct)
            share_ok = (not mem_total) or p.rss_bytes >= mem_total * self.min_share.value
            big = (bar_rss is not None and p.rss_bytes > bar_rss and share_ok and zr >= self.z_alert.value) or (bar_cpu is not None and p.cpu_pct > bar_cpu and zc >= self.z_alert.value)
            known = p.name in DAEMON_PRIORS or b.n >= self.warm.value
            if big and known and hits >= self.sustain.value and (slope >= 0 or z >= self.z_alert.value * 2):
                a = self.alerted.get(p.name) or {}
                cd = a.get("cooldown", 900.0)
                if not a or now - a["ts"] >= cd:
                    share = (p.rss_bytes / mem_total) if mem_total else None
                    alerts.append({"kind": "runaway_daemon", "name": p.name, "pid": p.pid, "uid": p.uid, "rss_bytes": p.rss_bytes,
                                   "rss_share": share, "cpu_pct": p.cpu_pct, "z": round(z, 1), "z_rss": round(zr, 1), "z_cpu": round(zc, 1), "slope_bps": round(slope),
                                   "baseline_bytes": round(b.mean or 0), "system": p.uid != uid_self, "action": "alert_only"})
                    # repeat alerts back off while the condition persists (doubling), reset when it clears
                    self.alerted[p.name] = {"ts": now, "cooldown": min(cd * 2, 86400.0) if a else cd}
            elif p.name in self.alerted and z < self.z_alert.value:
                self.alerted.pop(p.name, None); self.cleared.append(p.name)
        self.track = {k: v for k, v in self.track.items() if k in seen}
        return alerts

    def job_caps(self, jobs, procs, now, mem_total=None, target_sessions=None):
        """jobs: {job: {"lane", "pgid"}}. Returns (caps_by_lane, kill_plan[(job, pgid, rss, cap)])."""
        by_pg = {}
        for p in procs or []: by_pg.setdefault(p.pgid, []).append(p)
        budget = (mem_total * 0.9 / max(1, target_sessions)) if (mem_total and target_sessions) else None
        plan, caps = [], {}
        for job, j in jobs.items():
            members = by_pg.get(j.get("pgid"), [])
            if not members: self.over.pop(job, None); continue
            rss = sum(m.rss_bytes for m in members)
            lane = j.get("lane") or "unknown"
            q = self.lane_q.setdefault(lane, Quantile(0.99))
            cap = None
            if q.value is not None and q.n >= 20:
                cap = q.value * self.headroom.value
                if budget: cap = max(cap, budget)     # never cap a job below its fair share of RAM
            caps[lane] = cap
            if cap is not None and rss > cap:
                self.over[job] = self.over.get(job, 0) + 1
                if self.over[job] >= self.sustain.value: plan.append((job, j.get("pgid"), rss, cap))
            else:
                self.over.pop(job, None); q.update(float(rss))
        return caps, plan

    @staticmethod
    def zombies(procs, own_pgids):
        by_pid = {p.pid: p for p in procs or []}
        out = []
        for p in procs or []:
            if p.state.startswith("Z"):
                par = by_pid.get(p.ppid)
                out.append({"pid": p.pid, "ppid": p.ppid, "ours": bool(par and par.pgid in own_pgids), "name": p.name})
        return out

    def state(self):
        return {"names": {k: {"rss": v.to_dict(), "cpu": self.cpu[k].to_dict() if k in self.cpu else None} for k, v in self.names.items()}, "track": self.track,
                "z_alert": self.z_alert.to_dict(), "sustain": self.sustain.to_dict(),
                "lane_q": {k: v.to_dict() for k, v in self.lane_q.items()}, "headroom": self.headroom.to_dict(),
                "over": self.over, "alerted": self.alerted,
                "host_rss": self.host_rss.to_dict(), "host_cpu": self.host_cpu.to_dict(), "warm": self.warm.to_dict(), "min_share": self.min_share.to_dict()}
