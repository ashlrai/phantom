#!/usr/bin/python3
"""Adaptive fleet concurrency for dispatchd (RQ-QUEUE-BATCH-1, Mason A1 Nov 4).

Replaces the fixed global cap of 18 (and the ncpu bound beside it). Agent sessions mostly wait on model
APIs, so core count is a poor proxy for capacity; the host's own signals are measured instead.

Additive increase, multiplicative decrease, one decision per tick:
  * every signal zone "ok" and the cap is the binding limit (running >= cap with work queued):
    +RAISE_STEP, at most once per RAISE_GAP_S;
  * any signal "danger": cap * BACKOFF (at least -1), at most once per BACKOFF_GAP_S. A fork failure
    backs off at once;
  * otherwise ("warn", unknown signals, or no demand): hold.
Danger thresholds sit below the dispatchd starvation gate's trip points, so the fleet sheds sessions
before swap growth, pressure level 4, fork failures or provider 429s stop it outright. The cap a
backoff started from is remembered (trouble_cap); probing to or past it again needs SETTLE_GAP_S
of clean ticks, so the cap settles just under the host's real limit instead of oscillating.
The operator's slots.json top-level hard_cap stays an absolute ceiling and is never exceeded.

Pure functions plus a small JSON state file; no network, no subprocesses.
"""
import json
import math
import os
import time

SCHEMA = "dispatchd.concurrency.v1"
LEGACY_CAP = 18          # the retired fixed cap; only seeds the first tick (as min(LEGACY_CAP, ncpu))
FLOOR = 4
CEILING = 64
RAISE_STEP = 2
RAISE_GAP_S = 120
BACKOFF = 0.75
BACKOFF_GAP_S = 60
SETTLE_GAP_S = 900
WINDOW_S = 900           # look-back for fork failures and provider rate-limit hits
HISTORY = 50
ZONES = ("ok", "warn", "danger")


def _env_int(name, default, env=None):
    env = os.environ if env is None else env
    try:
        value = int(env.get(name, default))
        return value if value >= 1 else default
    except (TypeError, ValueError):
        return default


def bounds(operator_cap=None, env=None):
    """(floor, ceiling). ASHLR_CONCURRENCY_MIN/MAX tune them; an operator hard_cap always wins."""
    ceiling = _env_int("ASHLR_CONCURRENCY_MAX", CEILING, env)
    if isinstance(operator_cap, int) and not isinstance(operator_cap, bool) and operator_cap >= 0:
        ceiling = min(ceiling, operator_cap)
    return min(_env_int("ASHLR_CONCURRENCY_MIN", FLOOR, env), ceiling), ceiling


def _ratio_zone(value, warn, danger):
    if value is None or not isinstance(value, (int, float)) or math.isnan(value):
        return "warn", "unknown"
    return ("danger" if value >= danger else "warn" if value >= warn else "ok"), round(value, 2)


def zones(sig):
    """Classify each headroom signal: name -> (zone, observed value). Unknown is never headroom."""
    z = {}
    ncpu, per_cpu = sig.get("ncpu") or 1, sig.get("load_per_cpu_max") or 3.0
    load1 = sig.get("load1")   # dispatchd reports an unreadable load as inf: danger, like its claim halving
    z["load"] = _ratio_zone(None if load1 is None else load1 / (ncpu * per_cpu), 0.5, 0.8)
    pressure = sig.get("memory_pressure")   # kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical
    z["memory_pressure"] = (("warn", "unknown") if pressure is None else
                            ("ok", pressure) if pressure <= 1 else ("danger", pressure))
    free = sig.get("mem_free_pct")
    if free is None:
        z["mem_free"] = ("ok" if pressure is not None and pressure <= 1 else "warn", "unknown")
    else:
        z["mem_free"] = ("danger" if free < 15 else "warn" if free < 25 else "ok", free)
    growth, growth_max = sig.get("swap_growth_gb"), sig.get("swap_growth_max_gb") or 2.0
    if sig.get("swap_gb") is None:
        z["swap"] = ("warn", "unknown")
    else:
        z["swap"] = _ratio_zone((growth or 0) / growth_max, 0.25, 0.5)
    disk, stop = sig.get("disk_free_gb"), sig.get("disk_hard_stop_gb") or 30.0
    z["disk"] = _ratio_zone(None if disk is None else stop / max(disk, 1e-9), 0.4, 2 / 3)   # warn < 2.5x stop, danger < 1.5x
    procs, procs_max = sig.get("procs"), sig.get("procs_max") or 2500
    z["procs"] = _ratio_zone(None if procs is None else procs / procs_max, 0.7, 0.85)
    forks = sig.get("fork_failures") or 0
    z["fork"] = ("danger", forks) if forks else ("ok", 0)
    hits = sig.get("rate_limits") or 0
    z["rate_limit"] = ("danger" if hits >= 3 else "warn" if hits else "ok", hits)
    return z


def recent(stamps, now, window=WINDOW_S):
    return [t for t in stamps if isinstance(t, (int, float)) and now - window <= t <= now]


def fresh_state(seed, now):
    return {"schema": SCHEMA, "cap": seed, "last_change": 0, "last_backoff": 0, "trouble_cap": None,
            "trouble_at": None, "fork_failures": [], "rate_limits": [], "history": [], "created_at": now}


def load(path, seed, now):
    """Read the persisted state; anything malformed restarts from the seed (the safe, legacy-equivalent cap)."""
    try:
        with open(path) as f:
            state = json.load(f)
        if state.get("schema") != SCHEMA or not isinstance(state.get("cap"), int) or isinstance(state["cap"], bool):
            raise ValueError
        for key in ("fork_failures", "rate_limits", "history"):
            if not isinstance(state.get(key), list):
                state[key] = []
        return state, False
    except (OSError, ValueError, AttributeError, TypeError):
        return fresh_state(seed, now), True


def save(path, state):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=1, sort_keys=True)
    os.replace(tmp, path)


def _record(state, now, old, new, reason, z):
    adj = {"ts": now, "from": old, "to": new, "reason": reason,
           "zones": {k: v[0] for k, v in z.items()}, "signals": {k: v[1] for k, v in z.items()}}
    state["cap"] = new
    state["last_change"] = now
    state["history"] = (state["history"] + [adj])[-HISTORY:]
    return adj


def backoff(state, now, reason, z, floor, ceiling):
    """Multiplicative decrease. Returns the adjustment, or None when already at the floor."""
    old = min(state["cap"], ceiling)
    new = max(floor, min(old - 1, int(old * BACKOFF)))
    state["last_backoff"] = now
    state["trouble_cap"], state["trouble_at"] = old, now
    if new == state["cap"]:
        return None
    return _record(state, now, state["cap"], new, reason, z)


def decide(state, sig, now, demand, floor, ceiling):
    """One tick. Mutates state; returns the adjustment dict (to be logged) or None for a hold."""
    state["fork_failures"] = recent(state["fork_failures"], now)
    state["rate_limits"] = recent(state["rate_limits"], now)
    sig = dict(sig, fork_failures=len(state["fork_failures"]), rate_limits=len(state["rate_limits"]))
    z = zones(sig)
    state["zones"] = {k: v[0] for k, v in z.items()}
    cap = state["cap"]
    if cap > ceiling or cap < floor:   # operator ceiling or env bounds moved under us
        return _record(state, now, cap, max(floor, min(cap, ceiling)), "bounds", z)
    danger = sorted(k for k, v in z.items() if v[0] == "danger")
    if danger:
        fresh_fork = "fork" in danger and any(t > state.get("last_backoff", 0) for t in state["fork_failures"])
        if fresh_fork or now - state.get("last_backoff", 0) >= BACKOFF_GAP_S:
            return backoff(state, now, "backoff " + ",".join(danger), z, floor, ceiling)
        return None
    if not demand or any(v[0] != "ok" for v in z.values()) or cap >= ceiling:
        return None
    if now - state.get("last_change", 0) < RAISE_GAP_S:
        return None
    trouble = state.get("trouble_cap")
    new = min(ceiling, cap + RAISE_STEP)
    if trouble is not None and new >= trouble:
        if now - (state.get("trouble_at") or 0) < SETTLE_GAP_S:
            new = min(new, trouble - 1)   # creep toward the last trouble point, never onto it, until settled
            if new <= cap:
                return None
        else:
            new = min(ceiling, cap + 1)   # settled: probe past the old limit one session at a time
            if new > trouble:
                state["trouble_cap"] = state["trouble_at"] = None
    return _record(state, now, cap, new, "raise headroom", z)


def describe(adj):
    """One event-log line; signal values only (no job ids, paths or log text)."""
    hot = ", ".join("%s=%s" % (k, adj["signals"][k]) for k in sorted(adj["zones"]) if adj["zones"][k] != "ok")
    return "CONCURRENCY %d->%d %s%s" % (adj["from"], adj["to"], adj["reason"], (" (" + hot + ")") if hot else "")


def settled(state, now, horizon_s=6 * 3600):
    """Time-weighted mean cap over the horizon, from the adjustment history; the number to report."""
    hist = [h for h in state.get("history", []) if isinstance(h, dict) and isinstance(h.get("ts"), (int, float))]
    start = now - horizon_s
    cap_at_start = state.get("cap")
    for h in reversed(hist):
        if h["ts"] <= start:
            break
        cap_at_start = h["from"]
    area, t, cap = 0.0, start, cap_at_start
    for h in hist:
        if h["ts"] <= start:
            continue
        area += cap * (h["ts"] - t)
        t, cap = h["ts"], h["to"]
    area += cap * (now - t)
    return round(area / horizon_s, 1)


if __name__ == "__main__":   # `concurrency.py [state.json]`: print the current controller state summary
    import sys
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.ashlr-runs/queue/concurrency.json")
    st, missing = load(path, LEGACY_CAP, time.time())
    if missing:
        print("no controller state at %s" % path)
        raise SystemExit(1)
    print(json.dumps({"cap": st["cap"], "settled_6h": settled(st, time.time()), "trouble_cap": st.get("trouble_cap"),
                      "zones": st.get("zones"), "recent": st["history"][-5:]}, indent=1, sort_keys=True))
