"""Offline shared work market. Metadata only; no auth, subprocesses or execution."""
import json
import math
import re

TIERS = {"fast": 0, "mid": 1, "work": 2, "frontier": 3}
COSTS = {"local": 0, "included": 1, "metered": 2}
CAP = re.compile(r"^(?:[a-z][a-z0-9-]*|secrets:[A-Za-z0-9_.-]+)$")
BUILTIN = {"codex-cmp", "codex-personal", "claude", "devin", "claude-api", "codex-local", "omlx"}


def number(value):
    return value if type(value) in (int, float) and math.isfinite(value) else None


def requirements(fields):
    """The optional sixth TSV column is JSON. A legacy lane is only a hint."""
    if len(fields) > 5 and len(fields[5]) > 8192: raise ValueError("requirements too large")
    spec = json.loads(fields[5]) if len(fields) > 5 else {}
    if not isinstance(spec, dict): raise ValueError("invalid requirements")
    allowed = {"preferred_lane", "needs", "min_tier", "max_cost_class", "exclusive", "priority", "impact"}
    if set(spec) - allowed: raise ValueError("unknown requirements")
    spec = dict(spec)
    spec.setdefault("preferred_lane", fields[2] or None)
    pref = spec["preferred_lane"]
    if pref is not None and (not isinstance(pref, str) or not re.fullmatch(r"[a-z][a-z0-9-]*", pref)):
        raise ValueError("invalid preferred lane")
    needs = spec.setdefault("needs", [])
    if not isinstance(needs, list) or len(needs) > 64 or any(not isinstance(n, str) or len(n) > 128 or not CAP.fullmatch(n) for n in needs):
        raise ValueError("invalid capability names")
    if "min_tier" in spec and spec["min_tier"] not in TIERS: raise ValueError("invalid min_tier")
    if "max_cost_class" in spec and spec["max_cost_class"] not in COSTS: raise ValueError("invalid max_cost_class")
    if "exclusive" in spec and type(spec["exclusive"]) is not bool: raise ValueError("invalid exclusive")
    if "priority" in spec and not re.fullmatch(r"P[0-9]{1,6}", str(spec["priority"])): raise ValueError("invalid priority")
    if "impact" in spec and number(spec["impact"]) is None: raise ValueError("invalid impact")
    return spec


def from_envelope(attrs):
    """Router Markdown uses needs=git|gh|secrets:NAME, never secret values."""
    def field(name):
        match = re.search(r"(?:^|[,;\s])" + name + r"=([^,;\s]+)", attrs)
        return match.group(1) if match else None
    spec = {"preferred_lane": field("preferred_lane") or field("lane") or field("pool")}
    if field("needs") is not None: spec["needs"] = field("needs").strip("[]").split("|")
    for key in ("min_tier", "max_cost_class"):
        if field(key) is not None: spec[key] = field(key)
    if field("exclusive") is not None:
        if field("exclusive") not in ("true", "false"): raise ValueError("invalid exclusive")
        spec["exclusive"] = field("exclusive") == "true"
    match = re.search(r"\bP[0-9]+\b", attrs)
    if match: spec["priority"] = match.group()
    if field("impact") is not None: spec["impact"] = float(field("impact"))
    return requirements(["", "", "", "", "", json.dumps(spec)])


def priority(spec):
    return (int(spec.get("priority", "P2")[1:]), -spec.get("impact", 0))


def hard_down(slot):
    return (slot.get("auth_failed") is True or number(slot.get("quota")) == 0
            or (slot.get("held") and slot.get("held_reason") == "auth_failure"))


def lane_view(lanes, slots, running, targets, holds, models, quota, outcomes, adaptive=None, now=None):
    """Use configured executor capabilities; sensitive capabilities require explicit advertisement.

    Existing executor contracts supply git/gh/node and their own CLI. Host-owned
    slots capabilities replace those defaults. A name never resolves a secret.
    """
    view = {}
    # Host-owned optional observations expire. Unknown telemetry never becomes
    # invented latency, cost or success evidence, and cannot grant capabilities.
    signals = {}
    if isinstance(adaptive, dict) and number(adaptive.get("ts")) is not None and number(now) is not None and 0 <= now - adaptive["ts"] <= 300:
        signals = adaptive.get("lanes", {})
        if not isinstance(signals, dict): signals = {}
    recent = {lane: [] for lane in lanes}
    for outcome in outcomes:
        if outcome.get("event") == "finish" and outcome.get("lane") in recent:
            recent[outcome["lane"]].append(outcome)
    for lane in lanes:
        slot = slots[lane]
        family = "codex" if lane.startswith("codex") and lane != "codex-local" else lane
        local = lane in ("codex-local", "omlx")
        defaults = ["git", "gh", "node"] + (["codex-cli"] if lane.startswith("codex") else ["claude-cli"] if lane == "claude" else [])
        caps = slot.get("capabilities", defaults)
        tiers = slot.get("tiers", ["fast", "mid"] if local else list(TIERS) if lane in BUILTIN else [])
        if not isinstance(tiers, list) or any(not isinstance(t, str) or t not in TIERS for t in tiers): tiers = []
        valid_caps = isinstance(caps, list) and all(isinstance(c, str) and CAP.fullmatch(c) for c in caps)
        if models and any(k == family or k.startswith(family + ".") for k in models):
            tiers = [t for t in tiers if family in models or family + "." + t in models]
        q = quota.get(lane, {})
        known_quota = [n for n in (number(slot.get("quota")), number(q.get("remaining_pct")), number(q.get("credits_remaining"))) if n is not None]
        finished = recent[lane][-20:]
        empty = [o["empty"] for o in finished if type(o.get("empty")) is bool]
        latency = [o["model_s"] for o in finished if number(o.get("model_s")) is not None and o["model_s"] >= 0]
        wall = [o["wall_s"] for o in finished if number(o.get("wall_s")) is not None and o["wall_s"] >= 0]
        observed_latency = latency or wall
        signal = signals.get(lane, {})
        if not isinstance(signal, dict): signal = {}
        observed_empty = number(signal.get("empty_rate"))
        yield_rate = number(signal.get("yield_rate"))
        latency_s = number(signal.get("model_latency_s"))
        view[lane] = {
            "capabilities": set(caps) if valid_caps else set(),
            "tiers": tiers if isinstance(tiers, list) else [],
            "cost_class": slot.get("cost_class", "local" if local else "metered" if lane in ("claude-api", "devin") else "included" if lane in BUILTIN else None),
            "target": targets[lane], "running": running[lane],
            "held": bool(slot.get("held") or lane in holds),
            "auth_failed": hard_down(slot),
            "quota": min(known_quota) if known_quota else None,
            "backoff": slot.get("backoff", False) or signal.get("backoff") is True,
            "local": local,
            "empty_rate": observed_empty if observed_empty is not None and 0 <= observed_empty <= 1 else sum(empty) / len(empty) if empty else None,
            "yield_rate": yield_rate if yield_rate is not None and 0 <= yield_rate <= 1 else None,
            "latency_s": latency_s if latency_s is not None and latency_s >= 0 else sorted(observed_latency)[len(observed_latency) // 2] if observed_latency else None,
            "latency_source": "adaptive_model" if latency_s is not None and latency_s >= 0 else "model_phase" if latency else "session_wall" if wall else None,
        }
        if not isinstance(view[lane]["cost_class"], str): view[lane]["cost_class"] = None
        if not valid_caps: view[lane]["unavailable"] = "invalid_capability_advertisement"
    return view


def choose(job, spec, tier, view, record, now, decide):
    """Every return is an auditable decision; capacity is re-read for each job.

    A receipt binds an actual assignment, never an enqueue-time preference.
    Residency and move caps are evaluated even when the old lane is unavailable.
    """
    rejected = []
    eligible = []
    minimum = max(TIERS[tier], TIERS.get(spec.get("min_tier"), 0))
    pref = spec.get("preferred_lane")
    for lane, v in view.items():
        reasons = []
        if not set(spec["needs"]).issubset(v["capabilities"]): reasons.append("missing_capability")
        if tier not in v["tiers"] or max((TIERS.get(t, -1) for t in v["tiers"]), default=-1) < minimum or TIERS[tier] < TIERS.get(spec.get("min_tier"), 0):
            reasons.append("tier_unavailable")
        if v["local"] and pref != lane: reasons.append("local_opt_in_required")
        if pref in ("codex-local", "omlx") and lane != pref: reasons.append("local_execution_required")
        cost = COSTS.get(v["cost_class"])
        if cost is None: reasons.append("cost_class_unknown")
        elif cost > COSTS.get(spec.get("max_cost_class"), 2): reasons.append("cost_class_exceeded")
        if v["held"]: reasons.append("held")
        if v["auth_failed"]: reasons.append("auth_failed_or_zero_quota")
        if v["quota"] is not None and v["quota"] <= 0: reasons.append("quota_exhausted")
        if v["backoff"]: reasons.append("provider_backoff")
        if v["running"] >= v["target"]: reasons.append("saturated")
        if v.get("unavailable"): reasons.append(v["unavailable"])
        if reasons: rejected.append({"lane": lane, "reason_codes": reasons})
        else: eligible.append(lane)
    eligible.sort(key=lambda lane: (
        lane != pref,
        view[lane]["running"] / max(1, view[lane]["target"]),
        view[lane]["empty_rate"] if view[lane]["empty_rate"] is not None else 0.5,
        -(view[lane]["yield_rate"] if view[lane]["yield_rate"] is not None else 0.5),
        COSTS[view[lane]["cost_class"]],
        -(view[lane]["quota"] if view[lane]["quota"] is not None else 0),
        view[lane]["latency_s"] if view[lane]["latency_s"] is not None else math.inf,
        list(view).index(lane)))
    result = {"schema": "work-market.v1", "event": "route_decision", "job": job,
              "chosen_lane": None, "rejected_lanes": rejected, "reason_codes": [],
              "ranking_inputs": {lane: {key: v[key] for key in ("running", "target", "quota", "empty_rate", "yield_rate", "cost_class", "latency_s", "latency_source")} for lane, v in view.items()}}
    # Hint-only records preserve old external-proposal diagnostics without making
    # the preference a routing commitment before the first runnable assignment.
    prior = record if record and record.get("assigned", True) else None
    if not eligible:
        result["reason_codes"] = ["no_runnable_lane"]
        return result, record
    proposed = eligible[0]
    old = view.get(prior["pool"], {}) if prior else {}
    hard = old.get("auth_failed", False)
    updated, held = decide(prior, proposed, now, hard, bool(prior and prior.get("launched")))
    if held:
        result["reason_codes"].append("hysteresis_" + held)
        rejected.append({"lane": proposed, "reason_codes": ["hysteresis_" + held]})
        if prior["pool"] not in eligible: return result, prior
        proposed = prior["pool"]
        rejected.pop()  # the proposed candidate is recorded below if different
        if eligible[0] != proposed: rejected.append({"lane": eligible[0], "reason_codes": ["hysteresis_" + held]})
    updated["assigned"] = True
    result["chosen_lane"] = proposed
    result["reason_codes"] += ["preferred_lane" if proposed == pref else "healthy_capacity"]
    if pref and proposed != pref: result["reason_codes"].append("preferred_lane_fallback" if pref in view else "unknown_preference")
    if prior and prior["pool"] != proposed: result["reason_codes"].append("hard_down" if hard else "residency_elapsed")
    for lane in eligible:
        if lane != proposed and not any(r["lane"] == lane for r in rejected):
            rejected.append({"lane": lane, "reason_codes": ["lower_rank"]})
    return result, updated
