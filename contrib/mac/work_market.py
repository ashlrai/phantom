"""Offline shared work market. Metadata only; no auth, subprocesses or execution."""
import json
import math
import re

TIERS = {"fast": 0, "mid": 1, "work": 2, "frontier": 3}
COSTS = {"local": 0, "included": 1, "metered": 2}
CAP = re.compile(r"^(?:[a-z][a-z0-9-]*|secrets:[A-Za-z0-9_.-]+)$")
BUILTIN = {"codex-cmp", "codex-personal", "claude", "devin", "claude-api", "codex-local", "omlx"}
# Data handling clearance, lowest to highest. A job without data_class is unclassified (legacy rows).
DATA_CLASSES = {"public": 0, "internal": 1, "confidential": 2, "restricted": 3}
WORK_CLASSES = ("bulk", "standard", "judgment")
# Resource posture is a ranking input only: it never grants capability, cost class, quota or capacity.
# burn = spend the window on volume; preserve = keep the window for judgment work. Host slots.json overrides.
POSTURES = ("burn", "balanced", "preserve")
SPEND_DOWN_BURN_PCT = 10
SPEND_DOWN_PRESERVE_MARGIN_PCT = 10
POSTURE = {"codex-cmp": "burn", "codex-personal": "preserve", "claude": "preserve"}
FIT = {"burn": {"bulk": 0, "standard": 0, "judgment": 1},
       "balanced": {"bulk": 1, "standard": 1, "judgment": 1},
       "preserve": {"bulk": 2, "standard": 1, "judgment": 0}}
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")


def number(value):
    return value if type(value) in (int, float) and math.isfinite(value) else None


def requirements(fields):
    """The optional sixth TSV column is JSON. A legacy lane is only a hint."""
    if len(fields) > 5 and len(fields[5]) > 8192: raise ValueError("requirements too large")
    spec = json.loads(fields[5]) if len(fields) > 5 else {}
    if not isinstance(spec, dict): raise ValueError("invalid requirements")
    allowed = {"preferred_lane", "needs", "min_tier", "max_tier", "max_cost_class", "data_class", "work_class",
               "repo", "exclusive", "priority", "impact"}
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
    if "max_tier" in spec and spec["max_tier"] not in TIERS: raise ValueError("invalid max_tier")
    if "min_tier" in spec and "max_tier" in spec and TIERS[spec["min_tier"]] > TIERS[spec["max_tier"]]:
        raise ValueError("min_tier above max_tier")
    if "data_class" in spec and spec["data_class"] not in DATA_CLASSES: raise ValueError("invalid data_class")
    if "work_class" in spec and spec["work_class"] not in WORK_CLASSES: raise ValueError("invalid work_class")
    # The row's repo column is authoritative; a declared repo may only restate it.
    row_repo = fields[1] if len(fields) > 1 and fields[1] else None
    if spec.get("repo") is None: spec.pop("repo", None)
    elif not isinstance(spec["repo"], str) or not NAME.fullmatch(spec["repo"]): raise ValueError("invalid repo")
    elif row_repo and spec["repo"] != row_repo: raise ValueError("repo disagrees with the row")
    if row_repo and NAME.fullmatch(row_repo): spec["repo"] = row_repo
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
    for key in ("min_tier", "max_tier", "max_cost_class", "data_class", "work_class"):
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


def work_class(spec, tier):
    """Declared class, else derived: frontier or P0 work needs judgment; fast and mid work is bulk."""
    if spec.get("work_class"): return spec["work_class"]
    if tier == "frontier" or spec.get("priority") == "P0": return "judgment"
    return "bulk" if tier in ("fast", "mid") else "standard"


def _epoch(value):
    """A host-advertised instant: finite epoch seconds or an ISO-8601 date or timestamp. Else None."""
    if number(value) is not None: return value
    if not isinstance(value, str) or len(value) > 40: return None
    import datetime
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None: parsed = parsed.replace(tzinfo=datetime.timezone.utc)
        return parsed.timestamp()
    except (ValueError, OverflowError): return None


def spend_down(lane, cost_class, reading, now):
    """Project only fresh, measured included-subscription allowance."""
    result = dict(posture=None, reason="spend_down_unknown", projected_unused_pct=None, hours_to_reset=None)
    if cost_class != "included":
        return dict(result, reason="spend_down_not_subscription")
    if not isinstance(reading, dict) or number(now) is None: return result
    used, burn = number(reading.get("weekly_used_pct")), number(reading.get("burn_pct_per_hour"))
    reset, observed = _epoch(reading.get("reset_at")), _epoch(reading.get("as_of"))
    if (used is None or not 0 <= used <= 100 or burn is None or burn < 0
            or reset is None or observed is None or not -60 <= now - observed <= 1800 or reset <= now):
        return result
    hours = (reset - now) / 3600
    projected = used + burn * hours
    unused = max(0, 100 - projected)
    state, reason = ("burn", "spend_down_projected_unused") if unused >= SPEND_DOWN_BURN_PCT else (
        ("preserve", "spend_down_projected_exhaustion") if projected > 100 + SPEND_DOWN_PRESERVE_MARGIN_PCT
        else ("balanced", "spend_down_on_pace"))
    return dict(posture=state, reason=reason, projected_unused_pct=unused, hours_to_reset=hours)


def posture(lane, slot, now=None):
    """burn | balanced | preserve. An unexpired host free_until window reads as burn; garbage is ignored."""
    until = _epoch(slot.get("free_until"))
    if until is not None and number(now) is not None and now < until: return "burn"
    declared = slot.get("posture")
    return declared if declared in POSTURES else POSTURE.get(lane, "balanced")


def serves_repo(lane_view_entry, repo):
    repos = lane_view_entry.get("repos")
    return repos is None or (repo is not None and repo in repos)


def hard_down(slot):
    return (slot.get("auth_failed") is True or number(slot.get("quota")) == 0
            or (slot.get("held") and slot.get("held_reason") == "auth_failure"))


def lane_view(lanes, slots, running, targets, holds, models, quota, outcomes, adaptive=None, now=None, allowance=None):
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
        # Optional host allowlist of repos this executor serves; absent means every repo, garbage means none.
        repos = slot.get("repos")
        if repos is not None:
            repos = set(repos) if isinstance(repos, list) and all(isinstance(r, str) and NAME.fullmatch(r) for r in repos) else set()
        # Clearance fails closed: an executor that does not advertise one handles public data only,
        # except the existing contracts (remote built-ins: internal; on-host models: restricted).
        clearance = slot.get("data_class", "restricted" if local else "internal" if lane in BUILTIN else "public")
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
            "repos": repos,
            "data_class": clearance if isinstance(clearance, str) and clearance in DATA_CLASSES else "public",
            "posture": posture(lane, slot, now),
            "empty_rate": observed_empty if observed_empty is not None and 0 <= observed_empty <= 1 else sum(empty) / len(empty) if empty else None,
            "yield_rate": yield_rate if yield_rate is not None and 0 <= yield_rate <= 1 else None,
            "latency_s": latency_s if latency_s is not None and latency_s >= 0 else sorted(observed_latency)[len(observed_latency) // 2] if observed_latency else None,
            "latency_source": "adaptive_model" if latency_s is not None and latency_s >= 0 else "model_phase" if latency else "session_wall" if wall else None,
        }
        if not isinstance(view[lane]["cost_class"], str): view[lane]["cost_class"] = None
        projection = spend_down(lane, view[lane]["cost_class"], allowance.get(lane) if isinstance(allowance, dict) else None, now)
        until = _epoch(slot.get("free_until"))
        reason = projection["reason"]
        if until is not None and number(now) is not None and now < until:
            reason = "free_until"
        elif slot.get("posture") in POSTURES:
            reason = "host_declared"
        elif projection["posture"] is not None:
            view[lane]["posture"] = projection["posture"]
        view[lane].update(posture_reason=reason, spend_down=projection)
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
    kind = work_class(spec, tier)
    fit = {lane: FIT[v.get("posture", "balanced")][kind] for lane, v in view.items()}
    for lane, v in view.items():
        reasons = []
        if not set(spec["needs"]).issubset(v["capabilities"]): reasons.append("missing_capability")
        if tier not in v["tiers"] or max((TIERS.get(t, -1) for t in v["tiers"]), default=-1) < minimum or TIERS[tier] < TIERS.get(spec.get("min_tier"), 0):
            reasons.append("tier_unavailable")
        if "max_tier" in spec and TIERS[tier] > TIERS[spec["max_tier"]]: reasons.append("tier_ceiling_exceeded")
        if not serves_repo(v, spec.get("repo")): reasons.append("repo_unserved")
        if "data_class" in spec and DATA_CLASSES[spec["data_class"]] > DATA_CLASSES.get(v.get("data_class", "public"), 0):
            reasons.append("data_class_exceeded")
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
    # Resource fit precedes the hint: a preserved window is not spent on bulk work while a
    # burnable one has room. Within one fit class the declared lane still wins.
    eligible.sort(key=lambda lane: (
        fit[lane],
        lane != pref,
        view[lane]["running"] / max(1, view[lane]["target"]),
        view[lane]["empty_rate"] if view[lane]["empty_rate"] is not None else 0.5,
        -(view[lane]["yield_rate"] if view[lane]["yield_rate"] is not None else 0.5),
        COSTS[view[lane]["cost_class"]],
        -(view[lane]["quota"] if view[lane]["quota"] is not None else 0),
        view[lane]["latency_s"] if view[lane]["latency_s"] is not None else math.inf,
        list(view).index(lane)))
    result = {"schema": "work-market.v1", "event": "route_decision", "job": job,
              "chosen_lane": None, "preferred_lane": pref, "work_class": kind, "override": None,
              "rejected_lanes": rejected, "reason_codes": [],
              "ranking_inputs": {lane: dict({key: v[key] for key in ("running", "target", "quota", "empty_rate", "yield_rate", "cost_class", "latency_s", "latency_source")},
                                            posture=v.get("posture", "balanced"), posture_reason=v.get("posture_reason"),
                                            spend_down=v.get("spend_down"), fit=fit[lane]) for lane, v in view.items()}}
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
    if pref and proposed != pref:
        # resource_fit: the hinted lane could run it, but another resource suits the work better.
        code = "unknown_preference" if pref not in view else "resource_fit" if not held and pref in eligible else "preferred_lane_fallback"
        result["reason_codes"].append(code)
        result["override"] = {"from": pref, "to": proposed, "reason": code,
                              "preferred_lane_blocked_by": next((r["reason_codes"] for r in rejected if r["lane"] == pref), [])}
    if prior and prior["pool"] != proposed: result["reason_codes"].append("hard_down" if hard else "residency_elapsed")
    for lane in eligible:
        if lane != proposed and not any(r["lane"] == lane for r in rejected):
            rejected.append({"lane": lane, "reason_codes": ["lower_rank"]})
    return result, updated


def unfed_capacity(lanes, waiting, stopped=None):
    """Which executors had free slots while runnable rows waited under another lane's hint.

    lanes: {lane: {"running", "target", "held"}} after this tick's launches.
    waiting: [(hint_lane_or_None, {lane: [reason codes]} or None)] for rows left unlaunched.
    stopped: a reason that kept the whole market from evaluating (admission stop), else None.
    Counts only; no job ids, task text or credentials.
    """
    report = {}
    for lane, v in lanes.items():
        headroom = max(0, v["target"] - v["running"])
        entry = {"running": v["running"], "target": v["target"], "held": bool(v.get("held")), "headroom": headroom,
                 "utilization": round(min(1.0, v["running"] / v["target"]), 3) if v["target"] > 0 else None,
                 "waiting_elsewhere": 0, "blocked": {}}
        if headroom and not entry["held"]:
            for hint, rejected in waiting:
                if hint == lane: continue
                entry["waiting_elsewhere"] += 1
                codes = [stopped] if stopped else ["not_evaluated"] if rejected is None else rejected.get(lane) or ["deferred_after_selection"]
                for code in codes: entry["blocked"][code] = entry["blocked"].get(code, 0) + 1
        entry["unfed"] = bool(entry["waiting_elsewhere"])
        report[lane] = entry
    return {"schema": "work-market.v1", "event": "unfed_capacity", "waiting": len(waiting),
            "unfed_lanes": sorted(lane for lane, entry in report.items() if entry["unfed"]),
            "unfed_slots": sum(min(entry["headroom"], entry["waiting_elsewhere"]) for entry in report.values() if entry["unfed"]),
            "lanes": report}
