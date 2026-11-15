#!/usr/bin/python3
"""Batch sessions with per-line leases and PRs (RQ-BATCH-SESSIONS-2, CONCURRENCY-MAX-1, Mason Nov 10).

One launch.sh session takes a bundle of up to `max_lines` (10) related ready.tsv lines, from the same repo and
code area, and fans out to its own subagents. Unlike the RQ-QUEUE-BATCH-1 single-PR batch, every line keeps:

  * its own single-claim lease (queue/run/<job>.batched, created O_EXCL, released only by its owner),
  * its own worktree (~/Projects/ashlrai/wt/<job>, prepared by batch-launch.sh before launch.sh runs),
  * its own PR: a line the session reports done is handed back to the normal per-job reap, so publish.sh
    ships it exactly as a solo job,
  * its own failure path: a failed line releases only its lease and goes back to ready.tsv alone.

This module is the config plus pure planning half. dispatchd.py calls it; batch-launch.sh is the wrapper that
prepares the member worktrees and then execs the unchanged launch.sh. Both changes reach the host only through
the Security pin package in staging/RQ-BATCH-SESSIONS-2.

Model mix (subscriptions only, no API-credit lanes): Sonnet is Claude's workhorse, Opus takes hard or
architectural lines, Fable stays under the broker's own `fable-share` control (never assigned here). Codex lanes
run Terra. Devin runs the free flash model first; lines from repos Devin is not set up for, or without a declared
small size, are routed to other lanes.

Also: northstar metrics (tasks finished per session, iterations per hour, merged PRs per iteration) computed from
metrics/jobs.jsonl. Pure functions plus small file writes; no network, no model calls, no credentials.
"""
import argparse
import json
import os
import re
import time

SCHEMA = "ashlr.batch-sessions.v1"
NORTHSTAR_SCHEMA = "ashlr.northstar.v1"
JID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SIZE = re.compile(r"(?:^|[,;\s(])size<=([0-9]+)(?=[,;\s)]|$)")

# Defaults mirror batch-sessions.json. The file next to dispatchd.py is the operator-editable copy; when it is absent
# the bundler still runs with these values but Devin routing stays off, so adopting the file is the explicit switch.
DEFAULTS = {
    "schema": SCHEMA,
    "max_lines": 10,
    "min_lines": 2,
    # Hosted subscription lanes only. claude-api spends API credits and codex-local is a 6-slot local model.
    "lanes": ["claude", "codex-personal", "codex-cmp", "devin"],
    "models": {
        "claude": {"workhorse": "sonnet", "hard": "opus"},
        "codex": {"default": "gpt-6.1-terra"},
        "devin": {"default": "swe-2-flash"},
    },
    # A line is "hard" for the Opus pick when its tier is frontier or its prompt names one of these.
    "hard_markers": ["architecture", "architectural", "redesign", "migration", "concurrency", "race condition",
                     "security", "threat model", "protocol", "cross-cutting", "invariant"],
    "devin": {"route": False, "eligible_repos": ["phantom"], "sm_max_lines": 100,
              "fallback_lanes": ["claude", "codex-personal", "codex-cmp"]},
}
CLAUDE_MODEL_IDS = {"sonnet": "claude-sonnet-5-5", "opus": "claude-opus-5-5"}


def load_config(path):
    """Merged config: DEFAULTS overlaid with the JSON file. A present file turns Devin routing on unless it says not."""
    cfg = json.loads(json.dumps(DEFAULTS))
    try:
        with open(path) as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return cfg
    if not isinstance(raw, dict) or raw.get("schema") != SCHEMA:
        return cfg
    for key in ("max_lines", "min_lines"):
        if isinstance(raw.get(key), int) and 1 <= raw[key] <= 10:
            cfg[key] = raw[key]
    cfg["min_lines"] = min(cfg["min_lines"], cfg["max_lines"])
    if isinstance(raw.get("lanes"), list):
        cfg["lanes"] = [l for l in raw["lanes"] if isinstance(l, str) and l not in ("claude-api", "codex-local")]
    if isinstance(raw.get("hard_markers"), list):
        cfg["hard_markers"] = [m for m in raw["hard_markers"] if isinstance(m, str) and m.strip()]
    for fam, picks in (raw.get("models") or {}).items():
        if fam in cfg["models"] and isinstance(picks, dict):
            cfg["models"][fam].update({k: v for k, v in picks.items() if isinstance(v, str) and JID.match(v)})
    dv = raw.get("devin")
    cfg["devin"]["route"] = True
    if isinstance(dv, dict):
        if isinstance(dv.get("route"), bool):
            cfg["devin"]["route"] = dv["route"]
        if isinstance(dv.get("eligible_repos"), list):
            cfg["devin"]["eligible_repos"] = [r for r in dv["eligible_repos"] if isinstance(r, str)]
        if isinstance(dv.get("sm_max_lines"), int) and dv["sm_max_lines"] > 0:
            cfg["devin"]["sm_max_lines"] = dv["sm_max_lines"]
        if isinstance(dv.get("fallback_lanes"), list):
            cfg["devin"]["fallback_lanes"] = [l for l in dv["fallback_lanes"]
                                              if isinstance(l, str) and l not in ("devin", "claude-api")]
    return cfg


def size_of(text):
    """The declared `size<=N` bound in a line's envelope or prompt, or None. Undeclared is not small."""
    m = SIZE.search(text or "")
    return int(m.group(1)) if m else None


def is_hard(tier, prompt, cfg):
    if tier == "frontier":
        return True
    low = (prompt or "")[:20000].lower()
    return any(m.lower() in low for m in cfg["hard_markers"])


def model_for(lane, tier, prompt, cfg):
    """(model, reason) for one line on its lane. Fable is never picked here: the broker's fable-share owns it."""
    if lane == "claude":
        pick = "hard" if is_hard(tier, prompt, cfg) else "workhorse"
        return cfg["models"]["claude"][pick], "claude %s" % pick
    if lane.startswith("codex") and lane != "codex-local":
        return cfg["models"]["codex"]["default"], "codex default"
    if lane == "devin":
        return cfg["models"]["devin"]["default"], "devin free flash"
    return None, "lane default"


def devin_route(repo, size, cfg):
    """None when Devin keeps the line, else the reason it moves: repo-not-eligible or size-not-sm."""
    dv = cfg["devin"]
    if not dv.get("route"):
        return None
    if repo not in dv["eligible_repos"]:
        return "repo-not-eligible"
    if size is None or size > dv["sm_max_lines"]:
        return "size-not-sm"
    return None


# ---- single-claim leases -----------------------------------------------------------------------------------------
def acquire_lease(run_dir, job, owner):
    """Create run_dir/<job>.batched exclusively. False when another bundle (or a stale lease) holds it."""
    if not (JID.match(job) and JID.match(owner)):
        return False
    try:
        fd = os.open(os.path.join(run_dir, job + ".batched"), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        return False
    with os.fdopen(fd, "w") as f:
        f.write(owner)
    return True


def lease_owner(run_dir, job):
    try:
        with open(os.path.join(run_dir, job + ".batched")) as f:
            return f.read().strip() or None
    except OSError:
        return None


def rekey_lease(run_dir, job, old, new):
    """Move a lease from bundle `old` to bundle `new` without a window where it is free: write the new owner to a
    private temp file and rename it over the lease. False (lease untouched) unless `old` holds it."""
    if not (JID.match(job) and JID.match(new)) or lease_owner(run_dir, job) != old:
        return False
    if old == new:
        return True
    tmp = os.path.join(run_dir, ".%s.batched.%d" % (job, os.getpid()))
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(new)
        os.replace(tmp, os.path.join(run_dir, job + ".batched"))
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return False
    return True


def release_lease(run_dir, job, owner):
    """Remove the lease only when `owner` holds it; another bundle's lease is never touched."""
    if lease_owner(run_dir, job) != owner:
        return False
    try:
        os.remove(os.path.join(run_dir, job + ".batched"))
    except FileNotFoundError:
        return False
    return True


# ---- bundle prompt -----------------------------------------------------------------------------------------------
def render(bid, repo, area, members, wtroot):
    """members: [{job, prompt, model, tier}]. The checklist block is what batcher.parse_outcomes reads back."""
    n = len(members)
    head = ["# %s: %d related lines, one PR per line (%s, %s)" % (bid, n, repo, area), "",
            "This session owns %d independent ready lines (RQ-BATCH-SESSIONS-2). Each line already has its own git" % n,
            "worktree, branch and lease, and ships its own PR. Do not combine lines into one change.", "",
            "How to work:",
            "- Fan out: give each line its own subagent (Claude Code Task subagents, Codex sub-agents) and run them in",
            "  parallel. Pass the subagent the model named for its line where your tool supports it.",
            "- A line's edits, tests and notes stay inside that line's worktree. Never edit another line's worktree.",
            "  Your own worktree holds only this session's BRIDGE_NOTES.md checklist.",
            "- Each line writes BRIDGE_NOTES.md at the root of its own worktree (summary, commands run, pass/fail",
            "  counts, net LOC), exactly as a solo job would. Each line keeps its own RULES; where they differ, the",
            "  strictest rule wins.",
            "- If a line's worktree is missing, mark that line deferred; it is requeued on its own.",
            "- Do NOT commit, push, tag or publish in any worktree; each done line is published on its own after reap.", "",
            "Per-line checklist (required). Copy this block into BRIDGE_NOTES.md at the root of YOUR worktree and keep",
            "it current, one line per task. dispatchd parses it: done and skipped lines go to the normal per-job",
            "publish, every other line releases only its own lease and is requeued alone:", "",
            "<!-- batch-checklist:%s -->" % bid]
    head += ["- [ ] %s: pending" % x["job"] for x in members]
    head += ["<!-- /batch-checklist -->", "",
             "Finish each line as `- [x] <JOB>: done: <one-line summary>` or",
             "`- [ ] <JOB>: failed|skipped|deferred: <reason>`. Use skipped only when no change is needed (already",
             "satisfied, duplicate, obsolete). An honest status costs nothing: a failed line is simply retried.", ""]
    body = []
    for i, x in enumerate(members, 1):
        model = x.get("model")
        label = "%s (%s)" % (model, CLAUDE_MODEL_IDS[model]) if model in CLAUDE_MODEL_IDS else (model or "session default")
        body += ["", "## Line %d of %d: %s" % (i, n, x["job"]), "",
                 "Worktree: %s/%s (branch codex-bridge/%s)" % (wtroot, x["job"], x["job"]),
                 "Subagent model: %s" % label, "", x["prompt"].rstrip(), ""]
    return "\n".join(head + body) + "\n"


# ---- northstar metrics -------------------------------------------------------------------------------------------
def _epoch(ts):
    try:
        return time.mktime(time.strptime(str(ts)[:19], "%Y-%m-%dT%H:%M:%S"))
    except (ValueError, TypeError):
        return None


def northstar(rows, start, end):
    """Throughput over [start, end) from jobs.jsonl rows (dispatcher vocabulary, see batcher.read_rows).

    session      one finished agent run (event=finish), solo or bundle. A bundle member's own per-job reap
                 row carries `bundle` and is part of its bundle's session, not a session of its own.
    task         a finished line: a solo finish that was not empty, or a bundle member reported done.
    iteration    one finished session; iterations_per_hour divides by the window's wall-clock hours.
    merged PR    an outcome row with state MERGED for a job that finished in the window, or for a bundle
                 member of a bundle that finished in the window.
    Every value is a count of rows actually present; nothing is estimated.
    """
    finishes, members_done, member_of, merged = {}, {}, {}, set()
    for r in rows:
        if not isinstance(r, dict):
            continue
        ev = r.get("event")
        if ev == "finish" and isinstance(r.get("job"), str) and not r.get("bundle"):   # a member's own reap row
            t = _epoch(r.get("ts"))
            if t is not None and start <= t < end:
                finishes[r["job"]] = r
        elif ev == "task_outcome" and isinstance(r.get("batch"), str) and isinstance(r.get("job"), str):
            member_of[r["job"]] = r["batch"]
            if r.get("outcome") == "done":
                members_done.setdefault(r["batch"], set()).add(r["job"])
        elif ev == "outcome" and r.get("state") == "MERGED" and isinstance(r.get("job"), str):
            merged.add(r["job"])
    sessions = len(finishes)
    bundles = [j for j, r in finishes.items() if r.get("batch_size")]
    tasks = sum(len(members_done.get(j, ())) if finishes[j].get("batch_size") else (0 if finishes[j].get("empty") else 1)
                for j in finishes)
    merged_n = sum(1 for j in merged if j in finishes and not finishes[j].get("batch_size")
                   or member_of.get(j) in finishes)
    hours = (end - start) / 3600.0
    return {"schema": NORTHSTAR_SCHEMA, "window_start": int(start), "window_end": int(end), "hours": round(hours, 3),
            "sessions": sessions, "bundle_sessions": len(bundles), "tasks_finished": tasks, "merged_prs": merged_n,
            "tasks_per_session": round(tasks / sessions, 3) if sessions else None,
            "iterations_per_hour": round(sessions / hours, 3) if hours > 0 else None,
            "merged_prs_per_iteration": round(merged_n / sessions, 3) if sessions else None}


def append_jsonl(path, row):
    with open(path, "a") as f:
        f.write(json.dumps(row, sort_keys=True) + "\n")


def first_numbers_md(before, after, cutover):
    """The bus note for Mason: before and after rows side by side, verified counts only."""
    def cell(row, k):
        v = row.get(k)
        return "n/a" if v is None else str(v)
    keys = ("sessions", "bundle_sessions", "tasks_finished", "merged_prs", "tasks_per_session", "iterations_per_hour",
            "merged_prs_per_iteration")
    out = ["# Batch sessions: first numbers", "",
           "Cutover (batch sessions enabled): %s" % time.strftime("%Y-%m-%d %H:%M", time.localtime(cutover)),
           "Source: metrics/jobs.jsonl via `batch_sessions.py northstar`. Counts are rows present in the ledger;",
           "n/a means the window had no finished sessions.", "",
           "| metric | before | after |", "|---|---|---|"]
    out += ["| %s | %s | %s |" % (k, cell(before, k), cell(after, k)) for k in keys]
    out += ["", "Windows: before %.1f h, after %.1f h." % (before["hours"], after["hours"]), ""]
    return "\n".join(out)


def main(argv=None):
    p = argparse.ArgumentParser(description="Batch-session northstar metrics (tasks/session, iterations/hour, "
                                            "merged PRs/iteration) from metrics/jobs.jsonl.")
    sub = p.add_subparsers(dest="action", required=True)
    ns = sub.add_parser("northstar", help="compute before/after rows around a cutover and optionally record them")
    ns.add_argument("--runs", default=os.path.expanduser("~/.ashlr-runs"))
    ns.add_argument("--cutover", type=float, help="epoch seconds when batch sessions went live (default: now)")
    ns.add_argument("--window-h", type=float, default=24.0, help="hours on each side of the cutover")
    ns.add_argument("--record", action="store_true",
                    help="append both rows to metrics/northstar.jsonl and write bus/batch-sessions-first-numbers.md")
    a = p.parse_args(argv)
    import batcher   # same directory; read_rows projects reconciler outcomes into dispatcher vocabulary
    now = time.time()
    cut = a.cutover if a.cutover is not None else now
    w = a.window_h * 3600
    rows = batcher.read_rows(os.path.join(a.runs, "metrics", "jobs.jsonl"))
    before = dict(northstar(rows, cut - w, cut), phase="before")
    after = dict(northstar(rows, cut, min(now, cut + w)), phase="after") if now > cut else None
    if a.record:
        os.makedirs(os.path.join(a.runs, "metrics"), exist_ok=True)
        for row in (before, after):
            if row:
                append_jsonl(os.path.join(a.runs, "metrics", "northstar.jsonl"), dict(row, recorded_at=int(now)))
        if after:
            os.makedirs(os.path.join(a.runs, "bus"), exist_ok=True)
            with open(os.path.join(a.runs, "bus", "batch-sessions-first-numbers.md"), "w") as f:
                f.write(first_numbers_md(before, after, cut))
    print(json.dumps({"before": before, "after": after}, indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
