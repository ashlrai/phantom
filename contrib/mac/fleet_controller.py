#!/usr/bin/python3
"""Unified fleet controller for dispatchd (RQ-FLEET-LOADBALANCER-1).

One coordinator for the adaptive mechanisms that used to act on their own (autopilot disk gate, loadgate, memory
pressure, usage autobackoff, route hysteresis, the +2 ramp). They are signal providers now; this module owns the
decisions and dispatchd.py is the only caller. Pure functions plus a few small JSON files; no network, no
subprocesses, no side effects at import, so every rule is testable without a dispatcher tick.

Phases (each one is independently switchable and independently tested):
  A  signal bus + single writer + ledger. build_readings() is the one readings struct per tick; SlotWriter is the one
     path through which a lane target or hold changes; ledger_record() is the observability line. No decision changes.
  B  graduated shed. Pressure maps to a level 0..3 (targets x1, x0.5, x0.25, floors only). Levels step up at once and
     step down one at a time after a dwell, against thresholds 10% inside the entry band (hysteresis).
  C  cross-pool rebalance (a pool held by usage backoff hands its queued lines to pools with idle slots, through the
     existing route hysteresis), an output-aware lane quality weight, and producer backpressure.

Safety rules the code enforces and tests/run-sec.sh proves:
  * the controller only ever TIGHTENS. effective_target <= min(stored target, hard_cap, pin); no API raises a cap;
    verify_tighten_only() checks the whole slots table against the snapshot taken at the start of the tick;
  * fail closed. A missing critical signal (load, ncpu, memory, procs), an unreadable state file or any exception in
    planning freezes every lane to its floor, never to its ceiling;
  * the controller never creates, clears or edits a HOLD-list entry and never un-holds a lane it did not hold;
  * the existing admission gate stays in dispatchd as the last-resort backstop above the shed bands.
"""
import fcntl
import json
import math
import os
import re
import time
from datetime import datetime, timezone

SCHEMA = "dispatchd.fleet-controller.v1"
LEDGER_SCHEMA = "fleet-controller.ledger.v1"
BACKPRESSURE_SCHEMA = "fleet-controller.backpressure.v1"

# ---- phase B: graduated shed -------------------------------------------------------------------------------------
LEVEL_NAMES = ("normal", "shed50", "shed25", "freeze")
FACTORS = (1.0, 0.5, 0.25, 0.0)
# Entry bands per signal for levels 1, 2, 3. Load is a multiple of ncpu; every band sits BELOW the admission gate's
# own trip (2 x ncpu load, pressure >= 2, swap growth > GATE_SWAP_GROWTH_GB), which stays in place as the backstop.
LOAD_BANDS = (1.25, 1.5, 1.8)
MEM_FREE_BANDS = (25.0, 15.0, 8.0)          # free memory percent; lower is worse
SWAP_GROWTH_BANDS = (0.25, 0.5, 0.75)       # fraction of the gate's swap-growth limit
PROCS_BANDS = (0.7, 0.85, 1.0)              # fraction of the gate's process limit
WORKTREE_BANDS = (1.5, 2.0, 3.0)            # fraction of the gate's worktree limit (live worktrees only)
RESTORE_SCALE = 0.9                         # a signal must fall to 90% of its entry band before it counts as cleared
MEM_RESTORE_MARGIN = 5.0                    # free-memory points above the entry band
RESTORE_DWELL_S = 120                       # minimum time at a level before stepping down, one level per step
CRITICAL = ("load1", "ncpu", "memory", "procs")   # unreadable -> freeze

# ---- phase C ------------------------------------------------------------------------------------------------------
QUALITY_MIN_SAMPLES = 5
QUALITY_FLOOR = 0.75                        # weight range [0.75, 1.0]; 1.0 when there is too little data
QUALITY_WINDOW_S = 6 * 3600
MERGE_WINDOW_S = 3600
REROUTE_DEST = ("codex-cmp", "codex-personal", "claude")   # metered claude-api, devin (repo setup) and local are never targets
LANE_FAMILY = {"codex-cmp": "codex", "codex-personal": "codex", "claude": "anthropic", "claude-api": "anthropic"}
BACKPRESSURE_QUEUE_X = 3.0                  # queued lines per free slot above which a producer slows (restock's own trigger)
BACKPRESSURE_TTL_S = 600
LEDGER_MAX_BYTES = 8 * 1024 * 1024


def _num(v, allow_inf=False):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or math.isnan(v):
        return None
    if math.isinf(v) and not allow_inf:
        return None
    return float(v)


def _int(v):
    return v if isinstance(v, int) and not isinstance(v, bool) else None


# ====================================================================================================================
# Phase A: the signal bus
# ====================================================================================================================
def parse_ts(value):
    """Epoch seconds from a metrics timestamp (ISO with offset, or naive local like dispatchd's epoch()); else None."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if not isinstance(value, str) or len(value) < 19:
        return None
    try:
        t = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return t.timestamp() if t.tzinfo else time.mktime(t.timetuple())
    except ValueError:
        return None


def merge_stats(rows, now, window_s=MERGE_WINDOW_S, quality_window_s=QUALITY_WINDOW_S):
    """Merge and PR-outcome counts from the metrics rows dispatchd already holds (jobs.jsonl): no new probe.

    merged_1h: PRs merged in the last hour. closed_unmerged_rate: closed-without-merge share of resolved PRs in the
    quality window. ci_fail_rate: only from rows that carry an explicit ci verdict, else None. by_lane joins an
    outcome to a lane through its PR url -> publishing job -> launch row."""
    lane_of, url_job, first = {}, {}, {}
    for r in rows:
        if not isinstance(r, dict):
            continue
        kind, job = r.get("event"), r.get("job")
        if kind == "launch" and isinstance(job, str):
            lane_of[job] = r.get("lane")
        elif kind == "publish" and isinstance(job, str) and isinstance(r.get("url"), str):
            url_job[r["url"]] = job
        elif kind == "outcome" and isinstance(r.get("url"), str):
            state = str(r.get("state") or r.get("outcome") or r.get("status") or "").upper()
            ts = parse_ts(r.get("ts"))
            if state in ("MERGED", "CLOSED") and ts is not None and r["url"] not in first:
                first[r["url"]] = (state, ts, r)   # first terminal row wins: a re-emitted row never double counts
    merged_1h = 0
    lanes, ci = {}, {"fail": 0, "pass": 0}
    resolved = closed = 0
    for url, (state, ts, r) in first.items():
        if not (now - quality_window_s <= ts <= now + 60):
            continue
        lane = lane_of.get(url_job.get(url)) or r.get("lane")
        row = lanes.setdefault(lane if isinstance(lane, str) else "unknown", {"merged": 0, "closed": 0})
        resolved += 1
        if state == "MERGED":
            row["merged"] += 1
            if ts >= now - window_s:
                merged_1h += 1
        else:
            row["closed"] += 1
            closed += 1
        verdict = str(r.get("ci") or r.get("ci_state") or "").lower()
        if verdict in ("failure", "failed", "fail"):
            ci["fail"] += 1
        elif verdict in ("success", "passed", "pass"):
            ci["pass"] += 1
    return {"merged_1h": merged_1h, "resolved": resolved,
            "closed_unmerged_rate": round(closed / resolved, 3) if resolved else None,
            "ci_fail_rate": round(ci["fail"] / (ci["fail"] + ci["pass"]), 3) if ci["fail"] + ci["pass"] else None,
            "by_lane": lanes}


def lane_quality(stats):
    """lane -> weight in [QUALITY_FLOOR, 1]. Merged share of resolved PRs; neutral (1.0) below QUALITY_MIN_SAMPLES."""
    out = {}
    for lane, c in (stats or {}).get("by_lane", {}).items():
        n = c["merged"] + c["closed"]
        out[lane] = 1.0 if n < QUALITY_MIN_SAMPLES else round(QUALITY_FLOOR + (1 - QUALITY_FLOOR) * c["merged"] / n, 3)
    return out


def tier_depth(lines, valid_tiers):
    """queue depth by tier from raw ready.tsv lines (parked rows skipped by the caller)."""
    d = {t: 0 for t in sorted(valid_tiers)}
    for l in lines:
        f = l.split("\t")
        if len(f) >= 4 and f[3] in d:
            d[f[3]] += 1
    return d


def build_readings(now, *, load=(None, None, None), ncpu=None, mem_free_pct=None, memory_pressure=None, swap_gb=None,
                   swap_growth_gb=None, swap_window_s=300, procs=None, worktrees=None, disk_free_gb=None, disk_gate=None,
                   limits=None, queue_by_lane=None, queue_by_tier=None, quota=None, merge=None, holds=None):
    """The one readings struct per tick. Every field is a finite number or None; None is 'unreadable', never zero.

    `missing` lists unreadable CRITICAL signals (the planner freezes on any); `degraded` lists unreadable others."""
    l1, l5, l15 = (list(load) + [None] * 3)[:3]
    limits = limits or {}
    r = {"schema": SCHEMA, "ts": now,
         "load1": _num(l1), "load5": _num(l5), "load15": _num(l15),
         "ncpu": _int(ncpu) if _int(ncpu) and ncpu >= 1 else None,
         "mem_free_pct": _num(mem_free_pct), "memory_pressure": _int(memory_pressure),
         "swap_gb": _num(swap_gb), "swap_growth_gb": _num(swap_growth_gb), "swap_window_s": swap_window_s,
         "procs": _int(procs), "worktrees": _int(worktrees),
         "disk_free_gb": _num(disk_free_gb), "disk_gate": disk_gate if isinstance(disk_gate, str) else None,
         "limits": {"swap_growth_gb": _num(limits.get("swap_growth_gb")) or 2.0, "procs": _num(limits.get("procs")) or 2500.0,
                    "worktrees": _num(limits.get("worktrees")) or 40.0},
         "queue_by_lane": dict(queue_by_lane or {}), "queue_by_tier": dict(queue_by_tier or {}),
         "quota": dict(quota or {}), "merge": merge if isinstance(merge, dict) else None,
         "holds": sorted(holds or ())}
    window_h = max(swap_window_s, 1) / 3600.0
    r["swap_rate_gb_h"] = None if r["swap_growth_gb"] is None else round(r["swap_growth_gb"] / window_h, 3)
    missing = [k for k in ("load1", "ncpu", "procs") if r[k] is None]
    if r["mem_free_pct"] is None and r["memory_pressure"] is None:
        missing.append("memory")
    r["missing"] = missing
    r["degraded"] = [k for k in ("load5", "swap_gb", "swap_growth_gb", "worktrees", "disk_free_gb", "mem_free_pct",
                                 "memory_pressure") if r[k] is None] + ([] if r["merge"] else ["merge"])
    return r


def lane_quota(overrides, lanes):
    """per-lane quota remaining / burn from the budget-overrides readings dispatchd already loads."""
    out = {}
    for lane in lanes:
        o = (overrides or {}).get(lane)
        o = o if isinstance(o, dict) else {}
        used = _num(o.get("weekly_used_pct"))
        out[lane] = {"remaining_pct": None if used is None else round(max(0.0, 100.0 - used), 1),
                     "burn_pct_per_hour": _num(o.get("burn_pct_per_hour")),
                     "credits_remaining": _num(o.get("credits_remaining"))}
    return out


def concurrency_signals(r, load_per_cpu_max, disk_hard_stop_gb, swap_growth_max_gb, procs_max):
    """concurrency.decide() input, read from the bus instead of from separate probes (same keys, same meaning).
    An unreadable load is inf, exactly as dispatchd already reported it: the AIMD cap reads it as danger."""
    return {"load1": r["load1"] if r["load1"] is not None else float("inf"), "ncpu": r["ncpu"] or 1,
            "load_per_cpu_max": load_per_cpu_max, "memory_pressure": r["memory_pressure"], "mem_free_pct": r["mem_free_pct"],
            "swap_gb": r["swap_gb"], "swap_growth_gb": r["swap_growth_gb"] or 0, "swap_growth_max_gb": swap_growth_max_gb,
            "disk_free_gb": r["disk_free_gb"], "disk_hard_stop_gb": disk_hard_stop_gb, "procs": r["procs"], "procs_max": procs_max}


# ====================================================================================================================
# Phase A: single writer
# ====================================================================================================================
class WriterNotOwner(RuntimeError):
    """A lane mutation was attempted without holding the controller lock."""


class SlotWriter:
    """The only path through which a lane target or hold changes. Owns an exclusive, non-blocking flock for its
    lifetime: a second controller (another tick, a tool) cannot mutate lanes while one is alive.

    `pins` are the per-lane absolute bounds (hard_cap as clamped at tick start). Nothing here can raise a cap; a
    target is clamped to min(hard_cap, pin) and a hold is only ever attributed, never silently dropped."""

    def __init__(self, fd, slots, pins, now, on_event=None):
        self._fd, self.slots, self.pins, self.now, self._on_event = fd, slots, dict(pins), now, on_event
        self.mutations = []

    @classmethod
    def acquire(cls, path, slots, pins, now, on_event=None):
        fd = open(path, "a")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            fd.close()
            return None
        return cls(fd, slots, pins, now, on_event)

    def release(self):
        if self._fd is not None:
            self._fd.close()
            self._fd = None

    def _own(self):
        if self._fd is None:
            raise WriterNotOwner("lane mutation without the fleet-controller lock")

    def _note(self, lane, field, old, new, source, reason):
        m = {"lane": lane, "field": field, "from": old, "to": new, "source": source, "reason": reason}
        self.mutations.append(m)
        if self._on_event:
            self._on_event(m)

    def _bound(self, lane):
        s = self.slots[lane]
        hc = s.get("hard_cap")
        bound = self.pins.get(lane)
        caps = [c for c in (hc if _int(hc) is not None else None, bound) if c is not None]
        return min(caps) if caps else 0

    def set_target(self, lane, value, source, reason="", touch=True):
        """Set the lane's desired target, clamped to [0, min(hard_cap, pin)]. True when the stored value changed."""
        self._own()
        s = self.slots[lane]
        new = max(0, min(int(value), self._bound(lane)))
        old = s.get("target")
        if touch:
            s["last_change"] = self.now
        if new == old:
            return False
        s["target"] = new
        self._note(lane, "target", old, new, source, reason)
        return True

    def touch(self, lane, source=""):
        self._own()
        self.slots[lane]["last_change"] = self.now

    def hold(self, lane, source, reason, held_by=None, until=None, **extra):
        """Hold a lane. Never overwrites a manual hold (held with a different attribution than `held_by`)."""
        self._own()
        s = self.slots[lane]
        if s.get("held") and held_by is not None and s.get("held_by") != held_by:
            return False
        old = bool(s.get("held"))
        s["held"] = True
        if held_by is not None:
            s["held_by"] = held_by
        if until is not None:
            s["held_until"] = until
        s["held_reason"] = reason
        s.update(extra)
        s["last_change"] = self.now
        self._note(lane, "held", old, True, source, reason)
        return True

    def unhold(self, lane, source, reason, keys=("held", "held_reason", "held_by", "held_until", "auth_failed")):
        self._own()
        s = self.slots[lane]
        for k in keys:
            s.pop(k, None)
        s["last_change"] = self.now
        self._note(lane, "held", True, False, source, reason)

    def annotate(self, lane, **kv):
        """Non-decision metadata (pace pool, step marker). Never a target, cap or hold key."""
        self._own()
        bad = {"target", "floor", "ceiling", "hard_cap", "held", "held_by", "effective_target"} & set(kv)
        if bad:
            raise ValueError("annotate cannot write %s" % sorted(bad))
        self.slots[lane].update(kv)

    def apply_plan(self, plan):
        """Persist the plan's effective targets. effective_target is tighten-only by construction."""
        self._own()
        for lane, p in plan["lanes"].items():
            s = self.slots[lane]
            eff = min(p["target"], s.get("target", 0), self._bound(lane))
            if s.get("effective_target") != eff:
                self._note(lane, "effective_target", s.get("effective_target"), eff, "fleet-controller", p["reason"])
            s["effective_target"] = eff
            s["shed_level"] = plan["level"]
            s["quality"] = p["quality"]


def caps_snapshot(slots, lanes):
    return {l: {"hard_cap": slots[l].get("hard_cap"), "ceiling": slots[l].get("ceiling")} for l in lanes}


def verify_tighten_only(before, slots, lanes):
    """Violations (list of strings) where a cap rose, a target or effective target exceeds its cap, or the effective
    target exceeds the stored target. Empty list = the controller only tightened."""
    bad = []
    for l in lanes:
        s, b = slots[l], before[l]
        hc = s.get("hard_cap")
        if _int(b["hard_cap"]) is not None and (_int(hc) is None or hc > b["hard_cap"]):
            bad.append("%s hard_cap %r > %r" % (l, hc, b["hard_cap"]))
        if _int(hc) is not None:
            for k in ("target", "effective_target", "ceiling"):
                if _int(s.get(k)) is not None and s[k] > hc:
                    bad.append("%s %s %r > hard_cap %r" % (l, k, s[k], hc))
        if _int(s.get("effective_target")) is not None and _int(s.get("target")) is not None and s["effective_target"] > s["target"]:
            bad.append("%s effective_target %r > target %r" % (l, s["effective_target"], s["target"]))
    return bad


def ambiguous_holds(slots, lanes):
    """Lanes whose hold attribution disagrees with the flag (held false but held_by/held_until set by someone). The
    dispatcher treats them as unheld while `phm` reports them held; surfaced, never rewritten here."""
    return sorted(l for l in lanes if not slots[l].get("held") and (slots[l].get("held_by") or slots[l].get("held_until")))


# ====================================================================================================================
# Phase B: graduated shed
# ====================================================================================================================
def _band(value, bands, scale=1.0):
    lvl = 0
    for i, b in enumerate(bands):
        if value + 1e-9 >= b * scale:   # tolerance: 32.4 / 18 must land on the 1.8 band, not just under it
            lvl = i + 1
    return lvl


def _band_low(value, bands, margin=0.0):
    lvl = 0
    for i, b in enumerate(bands):
        if value < b + margin:
            lvl = i + 1
    return lvl


def pressure_levels(r, restore=False):
    """signal -> level 0..3. restore=True evaluates against the tighter 'cleared' thresholds (hysteresis).
    Level 3 also needs no extra rule for the gate: the admission gate is above all bands."""
    s = RESTORE_SCALE if restore else 1.0
    out = {}
    if r["load1"] is not None and r["ncpu"]:
        # entering a band uses load1; leaving it also needs load5 down (a spike that fell is not yet a recovery)
        load = max(r["load1"], r["load5"] or 0.0) if restore else r["load1"]
        out["load"] = _band(load / r["ncpu"], LOAD_BANDS, s)
    if r["mem_free_pct"] is not None:
        out["mem_free"] = _band_low(r["mem_free_pct"], MEM_FREE_BANDS, MEM_RESTORE_MARGIN if restore else 0.0)
    if r["memory_pressure"] is not None:
        out["memory_pressure"] = 3 if r["memory_pressure"] >= 4 else 2 if r["memory_pressure"] >= 2 else 0
    if r["swap_growth_gb"] is not None:
        out["swap_growth"] = _band(r["swap_growth_gb"] / r["limits"]["swap_growth_gb"], SWAP_GROWTH_BANDS, s)
    if r["procs"] is not None:
        out["procs"] = _band(r["procs"] / r["limits"]["procs"], PROCS_BANDS, s)
    if r["worktrees"] is not None:
        out["worktrees"] = _band(r["worktrees"] / r["limits"]["worktrees"], WORKTREE_BANDS, s)
    return out


def fresh_state(now):
    return {"schema": SCHEMA, "level": 0, "since": now, "reasons": []}


def load_state(path, now):
    """(state, note). Absent file = first run (level from signals). Present but unreadable = fail closed (freeze)."""
    try:
        with open(path) as f:
            st = json.load(f)
        if st.get("schema") != SCHEMA or _int(st.get("level")) not in (0, 1, 2, 3) or _num(st.get("since")) is None:
            raise ValueError("shape")
        return st, None
    except FileNotFoundError:
        return fresh_state(now), "first_run"
    except (OSError, ValueError, TypeError, AttributeError):
        st = fresh_state(now)
        st["level"] = 3
        return st, "state_unreadable"


def save_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=1, sort_keys=True)
    os.replace(tmp, path)


def shed_level(r, state, now, enabled=True):
    """-> (level, new_state, reasons). Escalate at once to the worst band; de-escalate one level per RESTORE_DWELL_S
    and only while every signal's restore-level is below the current level. Missing critical signal = level 3."""
    state = dict(state)
    prev = state["level"]
    reasons = []
    if r["missing"]:
        raw, why = 3, ["fail_closed:missing=" + ",".join(r["missing"])]
    else:
        lv = pressure_levels(r)
        raw = max(lv.values(), default=0)
        why = ["%s=%d" % (k, v) for k, v in sorted(lv.items()) if v == raw and raw] or []
    if raw >= prev:
        level, reasons = raw, why
        if raw > 0:
            state["since"] = now   # dwell counts from the last tick the level was still warranted
    else:
        rl = pressure_levels(r, restore=True) if not r["missing"] else {}
        held_at = max(rl.values(), default=0)   # what the cleared thresholds still say
        if now - state["since"] >= RESTORE_DWELL_S and held_at < prev:
            level = max(prev - 1, raw, held_at)
            state["since"] = now
            reasons = ["restore %d->%d" % (prev, level)]
        else:
            level = prev
            reasons = ["hold %d (raw=%d, restore=%d, dwell=%ds)" % (prev, raw, held_at, int(now - state["since"]))]
    state.update(level=level, reasons=reasons, last_ts=now)
    return (level if enabled else 0), state, reasons


def _lane_target(desired, floor, bound, factor):
    """Effective target: ceil(desired x factor), at least the floor, never above desired or the bound."""
    t = max(floor, math.ceil(desired * factor - 1e-9)) if factor > 0 else floor
    return max(0, min(t, desired, bound))


def plan(r, lanes, level, quality=None, shed_reasons=()):
    """Per-lane effective targets for one tick.

    lanes: lane -> {"desired", "floor", "bound" (min(hard_cap, pin)), "held" (bool, hold list included), "held_by"}.
    Never above desired or bound; floors only at level 3 (and as the minimum at every level)."""
    quality = quality or {}
    out = {}
    for lane, s in sorted(lanes.items()):
        bound = max(0, _int(s["bound"]) or 0)
        desired = max(0, min(_int(s["desired"]) or 0, bound))
        floor = max(0, min(_int(s["floor"]) or 0, desired, bound))
        w = quality.get(lane, 1.0) if level else 1.0
        factor = FACTORS[level] * (w if 0 < level < 3 else 1.0)
        eff = _lane_target(desired, floor, bound, factor)
        if s["held"]:
            reason = "held:%s" % (s.get("held_by") or "operator")
        elif level == 0:
            reason = "normal"
        else:
            reason = "%s x%.2f%s" % (LEVEL_NAMES[level], factor, " q=%.2f" % w if w < 1 else "")
        out[lane] = {"target": eff, "desired": desired, "held": bool(s["held"]), "reason": reason, "quality": quality.get(lane, 1.0),
                     "factor": round(factor, 3)}
    return {"level": level, "level_name": LEVEL_NAMES[level], "reasons": list(shed_reasons), "lanes": out}


def frozen_plan(lanes, why):
    """Fail-closed plan: every lane at its floor (bounded), level 3."""
    out = {}
    for lane, s in sorted(lanes.items()):
        bound = max(0, _int(s["bound"]) or 0)
        desired = max(0, min(_int(s["desired"]) or 0, bound))
        floor = max(0, min(_int(s["floor"]) or 0, desired, bound))
        out[lane] = {"target": floor, "desired": desired, "held": bool(s["held"]), "reason": "fail_closed:" + why, "quality": 1.0, "factor": 0.0}
    return {"level": 3, "level_name": LEVEL_NAMES[3], "reasons": ["fail_closed:" + why], "lanes": out}


# ====================================================================================================================
# Phase C: cross-pool rebalance, backpressure
# ====================================================================================================================
def reroute_sources(slots, lanes, hold_list, backoff_by="autobackoff"):
    """Pools whose queued work may move: held by usage/auth backoff or credit exhaustion. A manual or HOLD-list hold is
    an operator decision about that pool's work and is never routed around."""
    src = set()
    for l in lanes:
        s = slots[l]
        if l in hold_list or not s.get("held"):
            continue
        if s.get("held_by") == backoff_by or str(s.get("held_reason", "")).startswith("credits exhausted"):
            src.add(l)
    return src


def rebalance(cands, sources, plan_lanes, running, quality, tier_ok, route_ok, limit, hold_list=()):
    """Move lines queued on a backed-off pool to pools with idle slots.

    cands: [(job, lane, tier)] in dispatch order. A destination must be unheld, off the HOLD list, a REROUTE_DEST,
    fit the tier, and have headroom = effective target - running - its own queued lines (so native work always goes
    first and nothing is ever launched past a target). Same provider family is preferred, then higher quality.
    route_ok(job, dest) is the route hysteresis: it must accept the move or the job stays. -> [(job, from, to)]"""
    if not sources or limit <= 0:
        return []
    own = {}
    for _, lane, _ in cands:
        own[lane] = own.get(lane, 0) + 1
    room = {}
    for lane in REROUTE_DEST:
        p = plan_lanes.get(lane)
        if p and not p["held"] and lane not in hold_list and lane not in sources:
            room[lane] = p["target"] - running.get(lane, 0) - own.get(lane, 0)
    moves = []
    for job, lane, tier in cands:
        if len(moves) >= limit:
            break
        if lane not in sources:
            continue
        fam = LANE_FAMILY.get(lane)
        dests = [d for d in sorted(room, key=lambda d: (LANE_FAMILY.get(d) != fam, -quality.get(d, 1.0), d))
                 if room[d] > 0 and tier_ok(d, tier)]
        for dest in dests:
            if route_ok(job, dest):
                room[dest] -= 1
                moves.append((job, lane, dest))
                break
    return moves


def backpressure(pl, tier_queue, tier_capacity, now, enforced=True):
    """Producer advice, written for queuegen/restock. factor 1 = produce normally, 0 = pause. It is advice with a TTL:
    a missing or stale file means 'no backpressure' (a dead controller must not stall production). The admission side
    is the one that fails closed."""
    shed = 1.0 if pl["level"] == 0 else FACTORS[pl["level"]]
    tiers = {}
    for tier, depth in sorted(tier_queue.items()):
        cap = max(tier_capacity.get(tier, 0), 1)
        sat = depth / cap
        f = 1.0 if sat <= BACKPRESSURE_QUEUE_X else max(0.0, min(1.0, BACKPRESSURE_QUEUE_X / sat))
        tiers[tier] = {"factor": round(min(f, shed), 3), "queued": depth, "capacity": tier_capacity.get(tier, 0)}
    lanes = {l: {"factor": FACTORS[pl["level"]] if not p["held"] else 0.0} for l, p in pl["lanes"].items()}
    return {"schema": BACKPRESSURE_SCHEMA, "ts": now, "expires": now + BACKPRESSURE_TTL_S, "enforced": bool(enforced), "shed_level": pl["level"],
            "shed": pl["level_name"], "tiers": tiers, "lanes": lanes}


def tier_capacity(pl, tier_ok, tiers, lanes=REROUTE_DEST + ("devin", "codex-local", "claude-api")):
    """Free slots by tier: unheld lanes' effective targets (fit-checked), what a producer can expect to be consumed."""
    cap = {t: 0 for t in tiers}
    for lane in lanes:
        p = pl["lanes"].get(lane)
        if not p or p["held"]:
            continue
        for t in tiers:
            if tier_ok(lane, t):
                cap[t] += p["target"]
    return cap


# ====================================================================================================================
# Observability
# ====================================================================================================================
def objective(r):
    """merged PRs in the last hour x (1 - failure share). None when the merge signal is unreadable (never invented).
    The failure share is the explicit CI failure rate when rows carry it, else the closed-unmerged share, else 0."""
    m = r.get("merge")
    if not m:
        return {"score": None, "merged_1h": None, "fail_rate": None, "fail_source": None}
    if m.get("ci_fail_rate") is not None:
        rate, src = m["ci_fail_rate"], "ci"
    elif m.get("closed_unmerged_rate") is not None:
        rate, src = m["closed_unmerged_rate"], "closed_unmerged"
    else:
        rate, src = 0.0, "none"
    return {"score": round(m["merged_1h"] * (1.0 - rate), 3), "merged_1h": m["merged_1h"], "fail_rate": rate, "fail_source": src}


def signals_view(r):
    """The ledger copy of the bus: drop the bulky merge by_lane map, keep every scalar."""
    v = {k: r[k] for k in ("load1", "load5", "load15", "ncpu", "mem_free_pct", "memory_pressure", "swap_gb", "swap_growth_gb",
                           "swap_rate_gb_h", "procs", "worktrees", "disk_free_gb", "disk_gate", "queue_by_lane", "queue_by_tier",
                           "quota", "missing", "degraded", "holds")}
    m = r.get("merge") or {}
    v["merge_rate_1h"] = m.get("merged_1h")
    v["ci_fail_rate"] = m.get("ci_fail_rate")
    v["closed_unmerged_rate"] = m.get("closed_unmerged_rate")
    return v


def ledger_record(now, r, pl, mode, mutations=(), reroutes=(), ambiguous=(), shadow=None):
    """One JSONL line per tick: {ts, signals, lanes{target, held, reason}, objective_score, ...}.
    In shadow mode `pl` is what was applied (no shed) and `shadow` is the plan that enforce mode would have applied."""
    rec = {"schema": LEDGER_SCHEMA, "ts": round(now, 3), "mode": mode, "shed_level": pl["level"], "shed": pl["level_name"],
            "shed_reasons": pl["reasons"], "signals": signals_view(r),
            "lanes": {l: {"target": p["target"], "desired": p["desired"], "held": p["held"], "reason": p["reason"],
                          "quality": p["quality"]} for l, p in pl["lanes"].items()},
            "objective_score": objective(r)["score"], "objective": objective(r),
            "mutations": list(mutations)[:50],
            "reroutes": [{"job": j, "from": a, "to": b} for j, a, b in reroutes],
            "ambiguous_holds": list(ambiguous)}
    if shadow is not None:
        rec["shadow"] = {"shed_level": shadow["level"], "shed": shadow["level_name"], "reasons": shadow["reasons"],
                         "targets": {l: p["target"] for l, p in shadow["lanes"].items()}}
    return rec


def append_ledger(path, rec, max_bytes=LEDGER_MAX_BYTES):
    """Append one line. At max_bytes the file rotates once to <path>.1 (one generation kept). Never raises."""
    try:
        line = json.dumps(rec, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n"
        if os.path.exists(path) and os.path.getsize(path) >= max_bytes:
            os.replace(path, path + ".1")
        with open(path, "a") as f:
            f.write(line)
        return True
    except (OSError, ValueError, TypeError):
        return False


def tail_ledger(path, n=1):
    """Last n ledger records, for `phm fleet status` style readers. Unparseable lines are skipped."""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 262144))
            rows = f.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return []
    out = []
    for l in rows:
        try:
            d = json.loads(l)
            if isinstance(d, dict) and d.get("schema") == LEDGER_SCHEMA:
                out.append(d)
        except ValueError:
            pass
    return out[-n:] if n > 0 else []
