"""Offline shared work market. Metadata only; no auth, subprocesses or execution."""
import datetime
import json
import math
import os
import re
import stat
from collections import defaultdict
from pathlib import Path

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
# Same expiry as resource-live/types.ts; only these selected CLI models have a free preview.
DEVIN_PREVIEW_UNTIL = "2026-12-01T05:00:00.000Z"
DEVIN_PREVIEW = re.compile(r"^swe-2[\w.-]*(?:lightning|flash)(?:[.-][\w.-]+)?$", re.I)


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


def needs_gh(prompt):
    """Task reads/writes, not roster facts or prohibitions (lane-capabilities.ts)."""
    prompt = re.sub(r"^## CONTEXT\b[\s\S]*?^## END CONTEXT\b[^\n]*", " ", prompt, flags=re.M)
    fetch = r"check|fetch|find|read(?!-only)|inspect|pull|download|get"
    patterns = (
        r"\bgh\s+(?:pr\s+(?:list|view|diff|checks|status|checkout|create|merge|close|comment|edit|ready|review|reopen)\b"
        r"|run\s+(?:list|view|watch|download|rerun|cancel)\b|issue\s+(?:list|view|create|close|comment|edit)\b"
        r"|search\s+\w+|workflow\s+run\b|release\s+\w+|api\s+(?:/|repos\b|graphql\b|search\b|orgs\b|user\b|-X|--method|-f\b|-F\b))",
        rf"\b(?:list|review|triage|scan|query|pick|take|recut|rebase|{fetch})\b[^.\n]{{0,80}}\bopen (?:PRs?|pull requests?)\b",
        rf"\b(?:{fetch})\b[^.\n]{{0,60}}(?<![\w/.-])(?:failed[- ](?:runs?|jobs?)|(?:run|CI|job) logs?)(?![\w.-])",
    )
    forbids = r"\b(?:do not|don't|never|must not|may not|cannot|can't|instead of|rather than|not to|without (?:calling|running|using))\b"
    for sentence in re.split(r"[.;!?]\s|\n", prompt):
        for pattern in patterns:
            for match in re.finditer(pattern, sentence, re.I):
                if not re.search(forbids, sentence[:match.start()], re.I): return True
    return False


def from_envelope(attrs, prompt=""):
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
    if needs_gh(prompt) and "gh" not in spec.get("needs", []): spec.setdefault("needs", []).append("gh")
    return requirements(["", "", "", "", "", json.dumps(spec)])


def priority(spec):
    return (int(spec.get("priority", "P2")[1:]), -spec.get("impact", 0))


def repo_key(label):
    label = label.lower()
    if "/" not in label: label = "ashlrai/" + label
    return label if re.fullmatch(r"[a-z0-9][a-z0-9-]{0,38}/[a-z0-9][a-z0-9._-]{0,99}", label) else None


def repo_priority(home, repo):
    if not repo: return "normal"
    try:
        with open(Path(home) / ".ashlr" / "repo-priority" / repo.replace("/", "@"), encoding="utf-8") as source:
            value = source.read(16).strip()
        return value if value in ("boost", "pause") else "normal"
    except (OSError, UnicodeError): return "normal"


FRESHNESS_WEEK = 7 * 86400
FRESHNESS_JOB = re.compile(r"RQ-(DOCS|SITE)-FRESHNESS-([a-z0-9][a-z0-9._-]{0,99})-([0-9]{1,8})")
FRESHNESS_VERDICTS = {"docs": {"clean", "drift", "unknown"},
                      "site": {"healthy", "stale", "unhealthy", "unknown", "not-configured"}}


def read_repo_freshness(queue):
    try:
        with open(Path(queue) / "repo-freshness.json", encoding="utf-8") as source:
            text = source.read(262145)
        if len(text) > 262144: return {}
        data = json.loads(text)
        if data.get("schema") == "repo-freshness.v1" and isinstance(data.get("repos"), dict):
            return data["repos"]
    except (OSError, ValueError, AttributeError): pass
    return {}


def freshness_finding(job, repo, worktree, now):
    match = FRESHNESS_JOB.fullmatch(job)
    if not match or repo != "ashlrai/" + match[2]: return None
    kind, period = match[1].lower(), int(match[3])
    if not 0 <= int(now // FRESHNESS_WEEK) - period <= 1: return None
    try:
        fd = os.open(Path(worktree) / "BRIDGE_NOTES.md", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as source:
            if not stat.S_ISREG(os.fstat(fd).st_mode): return None
            notes = source.read(65537)
        if len(notes) > 65536: return None
        lines = [line for line in notes.decode("utf-8").splitlines() if line.startswith("FRESHNESS:")]
        if len(lines) != 1: return None
        verdict = lines[0][len("FRESHNESS:"):].strip()
        return (kind, {"period": period, "verdict": verdict}) if verdict in FRESHNESS_VERDICTS[kind] else None
    except (OSError, UnicodeError): return None


def freshness_signals(kinds, now):
    if not isinstance(kinds, dict): return []
    def verdict_of(kind):
        record = kinds.get(kind)
        if (isinstance(record, dict) and type(record.get("period")) is int
                and 0 <= int(now // FRESHNESS_WEEK) - record["period"] <= 1):
            return record.get("verdict")
        return None
    docs, site = verdict_of("docs"), verdict_of("site")
    return ([("docs_freshness_drift", .35)] if docs == "drift" else []) + (
        [("site_freshness_unhealthy", .65)] if site == "unhealthy" else
        [("site_freshness_stale", .45)] if site == "stale" else [])


def repo_shares(rows, home, freshness=None, now=0):
    """Rows are (canonical repo, job ID, work spec, observed merge rate)."""
    evidence = defaultdict(list)
    for repo, job, spec, rate in rows:
        if repo: evidence[repo].append((job, spec, rate))
    result = {}
    for repo, jobs in sorted(evidence.items()):
        nudge = repo_priority(home, repo)
        reasons = ["flat_baseline", "ready_work"]
        score = 1 + min(.5, math.log2(1 + len(jobs)) / 5)
        impact = max((max(0, job[1].get("impact", 0)) for job in jobs), default=0)
        for present, code, bonus in (
            (any(j.upper().startswith("RQ-FIX-MAIN-") for j, _, _ in jobs), "default_branch_ci_fix_ready", 1),
            (any(re.search(r"(?:^|[-_])(?:BUG|REGRESSION)(?:[-_]|$)", j, re.I) for j, _, _ in jobs), "bug_fix_ready", .6),
            (any(re.search(r"(?:^|[-_])(?:RESEARCH|EVAL)(?:[-_]|$)", j, re.I) for j, _, _ in jobs), "research_work_ready", .3),
            (impact > 0, "declared_mission_impact", min(.75, math.log2(1 + impact) / 5)),
        ):
            if present:
                score += bonus
                reasons.append(code)
        rates = [rate for _, _, rate in jobs if rate is not None]
        if rates and max(rates) > 0:
            score += .5 * max(rates)
            reasons.append("historical_solution_yield")
        for reason, bonus in freshness_signals((freshness or {}).get(repo), now):
            score += bonus
            reasons.append(reason)
        if nudge != "normal": reasons.append("owner_" + nudge)
        score *= {"normal": 1, "boost": 1.25, "pause": 0}[nudge]
        result[repo] = dict(schema="work-market.v1", event="repo_share", repo=repo, priority=nudge,
                            score=score, share=0, reason_codes=reasons)
    total = sum(row["score"] for row in result.values())
    if total > 0:
        for row in result.values(): row["share"] = row["score"] / total
    return result


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


def _scope_names(reading):
    return {k: reading[k] for k in ("account_id", "model")
            if isinstance(reading.get(k), str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", reading[k])}


def advisory_targets(document, now):
    if not isinstance(document, dict) or document.get("schema") != "phantom.fleet-resource-plan.v1":
        return {}
    stamp, targets = document.get("generated_at"), document.get("targets")
    if not isinstance(stamp, str) or not stamp.endswith("Z") or not isinstance(targets, dict):
        return {}
    try:
        age = now - datetime.datetime.fromisoformat(stamp[:-1] + "+00:00").timestamp()
    except (ValueError, OverflowError, OSError):
        return {}
    if not 0 <= age < 300:
        return {}
    return {lane: target for lane, target in targets.items() if type(target) is int and target > 0}


def deadline_priority(projection, now, short_window=False, promotional=False):
    if not isinstance(projection, dict) or projection.get("known") is not True or projection.get("stale") is not False:
        return None
    reset = _epoch(projection.get("reset_at"))
    expiry = _epoch(projection.get("expires_at")) if promotional else None
    ends = [end for end in (reset, expiry) if end is not None]
    used = number(projection.get("used_pct"))
    unused = number(projection.get("projected_unused_pct"))
    if not ends or min(ends) <= now or used is None or not 0 <= used < 100:
        return None
    if unused is not None and not 0 <= unused <= 100 - used + 0.1:
        return None
    if (unused or 0) > 0 or unused is None and (short_window or promotional and expiry is not None):
        return min(ends)
    return None


def _iso_instant(value):
    import datetime
    epoch = _epoch(value)
    if epoch is None: return None
    try:
        return datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except (ValueError, OverflowError, OSError): return None


def read_devin_allowance(home, ashlr_home=None):
    """Read existing local metadata only. Missing/corrupt accounting never proves zero exposure."""
    from pathlib import Path
    def read(path, cap=1024 * 1024):
        if path.is_symlink() or not path.is_file(): raise ValueError("invalid metadata file")
        with path.open() as stream:
            raw = stream.read(cap + 1)
        if len(raw) > cap: raise ValueError("oversize metadata")
        value = json.loads(raw)
        if not isinstance(value, dict): raise ValueError("invalid metadata")
        return value
    root = Path(ashlr_home) if ashlr_home and Path(ashlr_home).is_absolute() else Path(home) / ".ashlr"
    def optional(path):
        try: return read(path)
        except (OSError, ValueError): return {}
    section = optional(Path(home) / ".ashlr/config.json").get("devin", {})
    if not isinstance(section, dict): section = {}
    budget = optional(root / "devin/budget.json")
    weekly = optional(root / "devin/weekly-capacity.json")
    limit = number(section.get("weeklyAcuAllowance"))
    if limit is None or limit <= 0: limit = number(budget.get("acuBudgetTotal"))
    reset = _epoch(section.get("weeklyResetAt"))
    measured_reset = _epoch(weekly.get("reset_at"))
    observed = _epoch(weekly.get("observed_at"))
    # The configured instant is a recurring anchor, but the measured window must still match it.
    if reset is None or measured_reset is None or observed is None:
        measured_reset = None
    elif abs(reset + (math.floor((observed - reset) / 604800) + 1) * 604800 - measured_reset) > 1:
        measured_reset = None
    reserved = None
    def version(path):
        stat = path.stat()
        # Reading a task can update atime; only identity/content changes invalidate the inventory.
        return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns
    try:
        tasks = root / "devin/tasks"
        names = sorted(tasks.iterdir())
        if len(names) > 10000 or tasks.is_symlink(): raise ValueError("invalid inventory")
        total = 0
        observed_tasks = {}
        for path in names:
            if path.suffix != ".json": continue
            if path.is_symlink(): raise ValueError("invalid task")
            observed_tasks[path] = version(path)
            task = read(path)
            cap = number(task.get("maxAcu"))
            if cap is None or cap <= 0 or "sessionId" not in task or task.get("state") not in (
                    "queued", "launching", "running", "blocked", "pr-open", "merged", "closed", "failed", "expired"):
                raise ValueError("unknown task exposure")
            session = task.get("session")
            if isinstance(session, dict) and session.get("status") in ("exit", "error"):
                settled = _epoch(session.get("readAt"))
                # A session can finish between publications; keep its cap until a newer usage reading.
                if observed is None or settled is None or settled > observed: total += cap
                continue
            if (task["sessionId"] is not None or task.get("failure") in ("network", "unparsed")
                    or task["state"] in ("queued", "launching", "running", "blocked")):
                # Full cap, not a spend reading: it also covers usage since the weekly observation.
                total += cap
        if names != sorted(tasks.iterdir()) or any(version(path) != before for path, before in observed_tasks.items()):
            raise ValueError("inventory changed")
        reserved = total
    except (OSError, ValueError): pass
    provenance = {}
    if weekly.get("source") == "devin-api-v3-sessions":
        provenance = _scope_names(weekly)
        start = weekly.get("window_start")
        if isinstance(start, str) and _epoch(start) is not None and observed is not None and _epoch(start) <= observed:
            provenance["window_start"] = start
        if measured_reset is not None and isinstance(weekly.get("reset_at"), str):
            provenance["reset_at"] = weekly["reset_at"]
    return dict(used=number(weekly.get("used")), limit=limit, in_flight=reserved, provenance=provenance,
                reserve=number(budget.get("reserveAcu")), session_cap=number(budget.get("maxAcuPerSession")),
                reset_at=measured_reset, as_of=observed,
                state=weekly.get("state") if weekly.get("source") == "devin-api-v3-sessions" else None,
                burn_rate_per_hour=number(weekly.get("burn_rate_per_hour")))


def devin_cost(reading, model, running, now):
    """Included only while a whole session fits. Free CLI previews do not reserve ACUs, but still need fresh live account- and model-bound evidence."""
    r = reading if isinstance(reading, dict) else {}
    evidence = {key: number(r.get(key)) for key in ("used", "limit", "in_flight", "reserve", "session_cap")}
    evidence["headroom"] = None
    result = dict(cost_class="metered", zero_cost=False, allowance=evidence)
    preview = isinstance(model, str) and DEVIN_PREVIEW.fullmatch(model)
    if preview:
        if number(now) is None or now >= _epoch(DEVIN_PREVIEW_UNTIL):
            return dict(result, cost_class_reason="devin_preview_expired")
        observed = _epoch(r.get("as_of"))
        provenance = r.get("provenance") if isinstance(r.get("provenance"), dict) else {}
        account, scope_model = provenance.get("account_id"), provenance.get("model")
        bound = (isinstance(account, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", account) is not None
                 and isinstance(scope_model, str) and DEVIN_PREVIEW.fullmatch(scope_model))
        if r.get("state") != "live" or observed is None or not 0 <= now - observed <= 900 or not bound:
            return dict(result, cost_class_reason="devin_preview_unverified")
        return dict(result, cost_class="included", zero_cost=True, cost_class_reason="devin_free_preview")
    limit, used, reserve, cap, flight = (evidence[k] for k in ("limit", "used", "reserve", "session_cap", "in_flight"))
    reset, observed = _epoch(r.get("reset_at")), _epoch(r.get("as_of"))
    if reset is None: reason = "devin_reset_unknown"
    elif number(now) is None or reset <= now: reason = "devin_reset_expired"
    elif limit is None or limit <= 0: reason = "devin_allowance_unknown"
    elif used is None or used < 0: reason = "devin_usage_unknown"
    elif r.get("state") != "live" or observed is None or not 0 <= now - observed <= 900: reason = "devin_usage_stale"
    elif flight is None or flight < 0 or reserve is None or reserve < 0 or cap is None or cap <= 0:
        reason = "devin_reservations_unknown"
    else:
        # Include all live dispatcher workers, and re-evaluate after every claim in this tick.
        evidence["in_flight"] = flight + running * cap
        evidence["headroom"] = limit - used - evidence["in_flight"] - reserve
        reason = "devin_within_allowance" if evidence["headroom"] >= cap else "devin_allowance_headroom"
    return dict(result, cost_class="included" if reason == "devin_within_allowance" else "metered", cost_class_reason=reason)


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


def hard_down(slot, operator_hold=False):
    """Evidence that a lane cannot run work now, so unlaunched jobs may leave it before minimum residency.

    RQ-CONSTRAINT-AUDIT-1: a provider backoff hold (autobackoff usage/quota/auth, or credit exhaustion) counts,
    matching fleet_controller.reroute_sources. A manual hold, or a lane on the operator HOLD list
    (`operator_hold`), is an operator decision about that lane's work and never counts. The move cap and the
    launched fence in route_decision still apply, so a job never moves after launch or more than twice in 6 h.
    """
    if slot.get("auth_failed") is True or number(slot.get("quota")) == 0: return True
    if not slot.get("held"): return False
    if slot.get("held_reason") == "auth_failure": return True
    return not operator_hold and (slot.get("held_by") == "autobackoff"
                                  or str(slot.get("held_reason", "")).startswith("credits exhausted"))


def executor_capabilities(lane, slot):
    """Claude's sandbox lacks gh; only host-owned advertisement can replace defaults."""
    defaults = ["git", "node"] + ([] if lane == "claude" else ["gh"])
    defaults += ["codex-cli"] if lane.startswith("codex") else ["claude-cli"] if lane == "claude" else []
    caps = slot.get("capabilities", defaults)
    return set(caps) if isinstance(caps, list) and all(isinstance(c, str) and CAP.fullmatch(c) for c in caps) else None


def lane_view(lanes, slots, running, targets, holds, models, quota, outcomes, adaptive=None, now=None, allowance=None, tier=None):
    """Use configured executor capabilities; sensitive capabilities require explicit advertisement.

    Existing executor contracts supply git/node, gh except on Claude, and their own CLI. Host-owned
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
        caps = executor_capabilities(lane, slot)
        tiers = slot.get("tiers", ["fast", "mid"] if local else list(TIERS) if lane in BUILTIN else [])
        if not isinstance(tiers, list) or any(not isinstance(t, str) or t not in TIERS for t in tiers): tiers = []
        valid_caps = caps is not None
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
            "auth_failed": hard_down(slot, lane in holds),
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
        reading = allowance.get(lane) if isinstance(allowance, dict) else None
        if lane == "devin":
            weekly = reading.get("weekly_acu") if isinstance(reading, dict) else None
            model = models.get("devin." + tier) if tier else None
            view[lane].update(devin_cost(weekly, model or models.get("devin"), running[lane], now))
            if isinstance(weekly, dict):
                limit, used, burn = (number(weekly.get(k)) for k in ("limit", "used", "burn_rate_per_hour"))
                reading = dict(weekly_used_pct=used / limit * 100 if used is not None and limit is not None and limit > 0 else None,
                               burn_pct_per_hour=burn / limit * 100 if burn is not None and limit is not None and limit > 0 else None,
                               reset_at=weekly.get("reset_at"), as_of=weekly.get("as_of"))
        projection = spend_down(lane, view[lane]["cost_class"], reading, now)
        provenance = {}
        if lane == "devin" and isinstance(weekly, dict):
            provenance = dict(weekly.get("provenance") or {})
            selected = model or models.get("devin")
            if isinstance(selected, str) and selected != provenance.get("model"):
                provenance.pop("model", None)
        elif isinstance(reading, dict):
            provenance = _scope_names(reading)
            for key in ("window_start", "reset_at"):
                instant = _iso_instant(reading.get(key))
                if instant is not None: provenance[key] = instant
        until = _epoch(slot.get("free_until"))
        reason = projection["reason"]
        if lane == "devin" and view[lane]["zero_cost"]:
            view[lane]["posture"], reason = "burn", "devin_free_preview"
        elif lane == "devin" and view[lane]["cost_class"] == "metered":
            view[lane]["posture"], reason = "balanced", view[lane]["cost_class_reason"]
            if reason == "devin_allowance_headroom": view[lane]["provenance"] = provenance
        elif until is not None and number(now) is not None and now < until:
            reason = "free_until"
        elif slot.get("posture") in POSTURES:
            reason = "host_declared"
        elif projection["posture"] is not None:
            view[lane]["posture"] = projection["posture"]
            view[lane]["provenance"] = provenance
        if view[lane]["cost_class"] == "metered" and view[lane]["posture"] == "burn":
            view[lane]["posture"], reason = "balanced", "spend_down_not_subscription"
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
        view[lane]["deadline_priority"] if view[lane].get("deadline_priority") is not None else math.inf,
        bool(view[lane].get("is_metered_api")),
        fit[lane],
        not view[lane].get("below_advisory_target", False),
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
                                            **{k: v[k] for k in ("cost_class_reason", "zero_cost", "allowance") if k in v},
                                            spend_down=v.get("spend_down"), fit=fit[lane],
                                            deadline_priority=v.get("deadline_priority"),
                                            advisory_target=v.get("advisory_target")) for lane, v in view.items()}}
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
