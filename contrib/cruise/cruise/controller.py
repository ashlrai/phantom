"""OS-neutral closed-loop AIMD concurrency controller (CRUISE-1).

One decision per tick from raw OS-sensor samples:
  * indicators: memory-pressure score, compressed-memory growth, swap growth, swap-out rate,
    load per core, thermal ordinal. Rates come from consecutive samples.
  * each continuous indicator has a learned "healthy" baseline (EW mean/MAD, updated only on
    healthy ticks); stress = max weighted one-sided robust z.
  * zone ok / warn / danger / unknown from stress against learned thresholds, plus the OS's own
    categorical levels (pressure critical, thermal serious/critical).
  * ok and the target is binding with work queued: additive increase by a learned step, up to
    a ceiling just below the learned knee; after a learned dwell at the ceiling, probe +1 so the
    knee keeps being re-measured upward.
  * warn: stop admitting (target = running) and record the knee.
  * danger: multiplicative decrease by a learned beta, and shed ONE session (lowest value,
    newest) per tick, never all at once.
  * unknown (missing signals): hold. Never raise on missing data.
Outcome feedback (a later bad event, or a false alarm) retunes thresholds, beta, step, margin,
dwell and indicator weights. Only the safety rails on those parameters are fixed; see README.
"""
from __future__ import annotations

import math
import time

from .learn import EW, Param
from .shed import pick_victim
from .sensors import Sample, THERMAL_STATES

SCHEMA = "ashlr.cruise.decision.v1"
INDICATORS = ("pressure_score", "compressed_growth", "swap_growth", "swapout_rate", "load_per_core")
# Level indicators rise with every session by design (we WANT RAM and CPU used), so they are judged
# against a learned saturation limit, not against their idle baseline. Rate indicators (growth of
# compressed memory and swap) are the leading signs of the knee and are judged against their
# learned healthy baseline.
LEVELS = ("pressure_score", "load_per_core")
RATES = ("compressed_growth", "swap_growth", "swapout_rate")
ZONES = ("ok", "warn", "danger")

# Priors used only when neither the node profile nor learned state supplies one.
DEFAULT_PRIORS = {
    "knee": 8.0, "step": 1.0, "beta": 0.8, "margin": 0.1, "dwell": 10.0,
    "z_warn": 3.0, "z_danger": 6.0, "floor_frac": 0.05, "baseline_horizon": 240.0,
    "baselines": {}, "limits": {"pressure_score": 75.0, "load_per_core": 2.0}, "fleet_share_min": 0.5,
}

# Safety rails: bounds the learners may not cross (documented as fixed in README).
RAILS = {
    "knee": (1.0, None), "step": (1.0, None), "beta": (0.5, 0.95), "margin": (0.02, 0.5),
    "dwell": (2.0, 1440.0), "z_warn": (0.5, 50.0), "z_danger": (0.75, 100.0), "weight": (0.25, 4.0),
}


def _num(x):
    return x if isinstance(x, (int, float)) and not (isinstance(x, float) and math.isnan(x)) else None


def indicators(cur: Sample, prev: Sample = None):
    """Raw indicator values (no thresholds). Rates are per second; memory rates are fractions of RAM."""
    out = {k: None for k in INDICATORS}
    out["pressure_score"] = _num(cur.pressure_score)
    out["load_per_core"] = _num(cur.load_per_core)
    if prev is not None and cur.ts and prev.ts and cur.ts > prev.ts:
        dt = cur.ts - prev.ts
        mt = cur.mem_total_bytes or prev.mem_total_bytes
        if mt:
            if _num(cur.compressed_bytes) is not None and _num(prev.compressed_bytes) is not None:
                out["compressed_growth"] = (cur.compressed_bytes - prev.compressed_bytes) / mt / dt
            if _num(cur.swap_used_bytes) is not None and _num(prev.swap_used_bytes) is not None:
                out["swap_growth"] = (cur.swap_used_bytes - prev.swap_used_bytes) / mt / dt
        if _num(cur.swapouts_total) is not None and _num(prev.swapouts_total) is not None and cur.swapouts_total >= prev.swapouts_total:
            out["swapout_rate"] = (cur.swapouts_total - prev.swapouts_total) / dt
    return out


class Controller:
    def __init__(self, state=None, priors=None):
        st = state or {}
        pr = dict(DEFAULT_PRIORS); pr.update(priors or {})
        self.priors = pr
        ps = st.get("params", {})
        self.p = {k: Param(k, ps.get(k), prior=float(pr[k]), lo=RAILS.get(k, (None, None))[0], hi=RAILS.get(k, (None, None))[1])
                  for k in ("knee", "step", "beta", "margin", "dwell", "z_warn", "z_danger")}
        self.floor_frac = float(pr["floor_frac"])
        bl = st.get("baselines", {})
        hz = float(pr["baseline_horizon"])
        self.base = {}
        for k in INDICATORS:
            if k in bl: self.base[k] = EW(bl[k], horizon=hz)
            else:
                b = EW(None, horizon=hz)
                seed = (pr.get("baselines") or {}).get(k)
                if seed: b.mean, b.mad, b.n = float(seed[0]), float(seed[1]), 1   # profile prior seeds the baseline
                self.base[k] = b
        lim = st.get("limits", {})
        self.lim = {k: Param("lim_" + k, lim.get(k), prior=float((pr.get("limits") or {}).get(k, DEFAULT_PRIORS["limits"][k])), lo=1e-6) for k in LEVELS}
        self.fleet_share_min = Param("fleet_share_min", st.get("fleet_share_min"), prior=float(pr.get("fleet_share_min", 0.5)), lo=0.05, hi=0.95)
        self.w = {k: Param("w_" + k, (st.get("weights") or {}).get(k), prior=1.0, lo=RAILS["weight"][0], hi=RAILS["weight"][1]) for k in INDICATORS}
        self.target = st.get("target")
        self.prev = Sample.from_dict(st["prev_sample"]) if st.get("prev_sample") else None
        self.hist = list(st.get("hist", []))       # recent [ts, zone, action, running, top]
        self.clean = int(st.get("clean", 0))       # consecutive ok ticks at or above the ceiling
        self.pending = st.get("pending")           # last action awaiting its outcome
        self.interval = EW(st.get("interval"), horizon=60.0)
        self.events = list(st.get("events", []))[-50:]

    # ------------------------------------------------------------------ helpers
    def ceiling(self):
        return max(1, int(math.floor(self.p["knee"].value * (1.0 - self.p["margin"].value))))

    def _zone(self, s: Sample, ind):
        zs, reasons = {}, []
        zw = self.p["z_warn"].value
        for k in INDICATORS:
            if k in LEVELS:
                # at the learned limit the contribution equals z_warn (stop admitting); danger scales with it
                zs[k] = None if ind[k] is None else max(0.0, ind[k] / self.lim[k].value * zw) * self.w[k].value
                continue
            b = self.base[k]
            z = b.z(ind[k], self.floor_frac) if b.n > 0 else None
            zs[k] = None if z is None else max(0.0, z) * self.w[k].value
        known = [v for v in zs.values() if v is not None]
        stress = max(known) if known else None
        top = max(zs, key=lambda k: zs[k] if zs[k] is not None else -1) if known else None
        zone = None
        if stress is not None:
            zone = "danger" if stress >= self.p["z_danger"].value else "warn" if stress >= self.p["z_warn"].value else "ok"
        cat = None
        if s.pressure_level == "critical": cat = "danger"; reasons.append("os_pressure_critical")
        elif s.pressure_level == "warn": cat = "warn"; reasons.append("os_pressure_warn")
        if s.thermal in THERMAL_STATES:
            t = THERMAL_STATES.index(s.thermal)
            if t >= 3: cat = "danger"; reasons.append("thermal_critical")
            elif t >= 2 and cat != "danger": cat = "warn"; reasons.append("thermal_serious")
        if cat is not None:
            zone = cat if zone is None or ZONES.index(cat) > ZONES.index(zone) else zone
        if zone is None:
            # cold start: no learned baseline yet but the OS reports live signals -> its own categorical
            # reading decides (normal -> ok) so baselines can start learning; no signals at all -> unknown.
            cold = any(ind[k] is not None for k in INDICATORS) and all(self.base[k].n == 0 for k in RATES if ind[k] is not None)
            zone = "ok" if cold and s.pressure_level in (None, "normal") and ind.get("pressure_score") is not None else "unknown"
            if zone == "ok": reasons.append("cold_start")
        if stress is not None and zone in ("warn", "danger") and top: reasons.append("%s z=%.1f" % (top, stress))
        return zone, stress, top, zs, reasons

    def _feedback(self, zone, bad_event, now, fleet_share=None):
        """Retune from the outcome of the previous action and from bad events."""
        pend = self.pending or {}
        a = pend.get("action")
        if a == "raise":
            if zone == "ok": self.p["step"].nudge(1.25, "raise held ok")
            elif zone in ("warn", "danger"): self.p["step"].set(max(1.0, self.p["step"].value * 0.5), "raise hit %s" % zone)
        if a in ("decrease", "shed"):
            if zone == "danger":
                self.p["beta"].nudge(0.95, "still danger after decrease")
                self.fleet_share_min.nudge(1.05, "shedding fleet did not relieve pressure")
            else: self.p["beta"].nudge(1.02, "recovered after decrease")
        if a == "hold_foreign" and bad_event:
            self.fleet_share_min.nudge(0.9, "bad event while blaming foreign load")
        if a == "probe":
            if zone in ("warn", "danger"): self.p["dwell"].nudge(1.5, "probe failed")
            elif zone == "ok": self.p["dwell"].nudge(0.9, "probe held")
        if bad_event:
            window = self.hist[-int(max(2, self.p["dwell"].value)):]
            missed = all(h[1] == "ok" for h in window) if window else True
            if missed:
                self.p["z_warn"].nudge(0.85, "bad event with no warning")
                self.p["z_danger"].nudge(0.85, "bad event with no warning")
                tops = [h[4] for h in window if len(h) > 4 and h[4]]
                for k in set(tops): self.w[k].nudge(1.1, "led a missed bad event")
            self.p["margin"].nudge(1.25, "bad event")
            self.events.append({"ts": now, "kind": "bad_event", "missed": missed})
        elif a in ("decrease", "shed") and zone == "ok" and pend.get("stress_after") is None:
            # transient: danger flagged, one tick later fully ok and no bad event -> slightly less sensitive
            self.p["z_danger"].nudge(1.03, "transient danger, no bad event")
        if self.p["z_danger"].value < self.p["z_warn"].value * 1.2:
            self.p["z_danger"].set(self.p["z_warn"].value * 1.2, "keep danger above warn")

    # ------------------------------------------------------------------ main step
    def _learn_limits(self, zone, top, ind, zs, s, bad_event, fleet_share):
        rates_hot = any((zs[k] or 0) >= self.p["z_warn"].value for k in RATES)
        if (zone == "danger" and rates_hot) or bad_event:
            if fleet_share is None or fleet_share >= self.fleet_share_min.value:
                for k in LEVELS:
                    v = ind[k]
                    if v is not None and v < self.lim[k].value:
                        self.lim[k].set(self.lim[k].value + 0.5 * (v - self.lim[k].value), "rates/bad event at %s=%.3g" % (k, v))
        elif zone == "warn" and top in LEVELS and not rates_hot and s.pressure_level in (None, "normal"):
            self.level_clean = getattr(self, "level_clean", 0) + 1
            if self.level_clean >= self.p["dwell"].value:
                self.lim[top].nudge(1.05, "level warn with quiet rates for dwell"); self.level_clean = 0
            return
        self.level_clean = 0

    def step(self, s: Sample, running: int, demand: int, sessions=None, bad_event=False, now=None, fleet=None):
        """fleet: {"cpu_share", "mem_share"}: fraction of host CPU and resident memory held by OUR job
        groups (None = unknown). Foreign pressure (system daemons, apps) reduces capacity and blocks
        admission but is never blamed on fleet sessions: shedding is proportional to fleet share."""
        now = now if now is not None else (s.ts or time.time())
        if self.prev is not None and s.ts and self.prev.ts: self.interval.update(s.ts - self.prev.ts)
        stale = (self.prev is not None and self.interval.mean and s.ts - self.prev.ts > 4 * self.interval.mean)
        ind = indicators(s, None if stale else self.prev)
        zone, stress, top, zs, reasons = self._zone(s, ind)
        for k in RATES: self.base[k].observe(ind[k])
        fleet = fleet or {}
        res = "cpu_share" if top == "load_per_core" else "mem_share"
        fleet_share = fleet.get(res)
        self._feedback(zone, bad_event, now, fleet_share)
        self._learn_limits(zone, top, ind, zs, s, bad_event, fleet_share)
        knee, ceil = self.p["knee"], self.ceiling()
        tgt = int(self.target if self.target is not None else max(1, min(running, ceil) if running else 1))
        prev_tgt = tgt
        action, shed = "hold", None
        binding = running >= tgt - max(1, int(round(self.p["step"].value))) + 1 and demand > 0
        warm = min(self.base[k].n for k in ("pressure_score", "load_per_core")) < max(3, self.base["load_per_core"].horizon / 40)
        if zone == "unknown":
            action = "hold_unknown"; tgt = min(tgt, max(running, 1))
        elif zone == "danger":
            cut = running - max(1, int(math.floor(running * self.p["beta"].value)))
            share = 1.0 if fleet_share is None else max(0.0, min(1.0, fleet_share))
            want = cut * share                       # shed only the fleet-owned part of the pressure
            n_cut = int(math.ceil(want)) if share >= self.fleet_share_min.value else int(math.floor(want))
            if running <= 1 or n_cut <= 0:
                tgt = min(tgt, max(1, running)); action = "hold_foreign"
                reasons.append("foreign_pressure fleet_%s=%.2f" % (res, share))
            else:
                tgt = min(tgt, running - n_cut)
                knee.set(knee.value + 0.3 * (running - knee.value) if knee.n else float(running), "danger at %d" % running)
                action = "decrease"
                v = pick_victim(sessions)
                if v: shed = {"job": v.get("job"), "lane": v.get("lane"), "value": v.get("value"), "why": "; ".join(reasons) or "danger",
                              "fleet_share": round(share, 3)}; action = "shed"
            self.clean = 0
        elif zone == "warn":
            tgt = min(tgt, max(1, running)); action = "hold_warn"; self.clean = 0
            fleet_led = fleet_share is None or fleet_share >= self.fleet_share_min.value
            if not fleet_led: reasons.append("foreign_pressure fleet_%s=%.2f (knee kept)" % (res, fleet_share))
            if fleet_led and running > 1 and running <= tgt + 1:
                knee.set(knee.value + 0.2 * (running - knee.value) if knee.n else float(running), "warn at %d" % running)
        else:  # ok
            for k in INDICATORS: self.base[k].update(ind[k])      # baselines learn only from healthy ticks
            if running >= ceil: self.clean += 1
            if running > knee.value and self.clean >= self.p["dwell"].value:
                knee.set(float(running) / (1.0 - self.p["margin"].value), "clean dwell at %d" % running)
                self.p["margin"].nudge(0.9, "clean dwell")
            if not binding:
                action = "hold_no_demand" if demand <= 0 else "hold_not_binding"
            elif warm:
                tgt = tgt + 1; action = "raise_warmup"
            elif tgt < ceil:
                tgt = min(ceil, tgt + max(1, int(round(self.p["step"].value)))); action = "raise"
            elif self.clean >= self.p["dwell"].value:
                tgt = tgt + 1; action = "probe"; self.clean = 0
            else:
                action = "hold_at_ceiling"
        self.target = tgt
        self.prev = s
        self.hist = (self.hist + [[now, zone, action, running, top]])[-200:]
        self.pending = {"action": "raise" if action.startswith("raise") else action, "ts": now}
        if action == "hold_foreign": self.pending["action"] = "hold_foreign"
        return {
            "schema": SCHEMA, "ts": now, "zone": zone, "stress": stress, "top": top, "reasons": reasons,
            "z": zs, "indicators": ind, "running": running, "demand": demand,
            "prev_target": prev_tgt, "target": tgt, "action": action, "shed": shed,
            "ceiling": self.ceiling(), "knee": round(knee.value, 2), "warmup": bool(warm),
            "interval_s": self.interval.mean, "fleet_share": fleet_share, "fleet": fleet,
            "limits": {k: round(v.value, 4) for k, v in self.lim.items()}, "fleet_share_min": round(self.fleet_share_min.value, 3),
            "params": {k: round(v.value, 4) for k, v in self.p.items()},
        }

    def state(self):
        return {
            "params": {k: v.to_dict() for k, v in self.p.items()},
            "baselines": {k: v.to_dict() for k, v in self.base.items()},
            "weights": {k: v.to_dict() for k, v in self.w.items()},
            "limits": {k: v.to_dict() for k, v in self.lim.items()}, "fleet_share_min": self.fleet_share_min.to_dict(),
            "target": self.target, "prev_sample": self.prev.to_dict() if self.prev else None,
            "hist": self.hist[-200:], "clean": self.clean, "pending": self.pending,
            "interval": self.interval.to_dict(), "events": self.events[-50:],
        }
