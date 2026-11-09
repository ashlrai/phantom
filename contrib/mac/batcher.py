#!/usr/bin/python3
"""Task batching for dispatchd (RQ-QUEUE-BATCH-1, Mason A1 Nov 4).

One agent session handles many related ready tasks: dispatchd groups them by repo, tier and code area
(the source directories their prompts name) and launches one RQ-BATCH-* job. That session fans out its
own subagents and lands one reviewable PR. Logging stays per task: the batch prompt carries a checklist
the session keeps in BRIDGE_NOTES.md, and at reap time each member gets its own task_outcome metric.
Members not done (failed, deferred, never reported) go back to ready.tsv as individual lines. After
MAX_ATTEMPTS batch attempts a task only runs solo.

Self-improvement: tasks completed per session-hour and per million tokens, per lane and mode
(single vs batch), are computed from metrics/jobs.jsonl. They drive the batch lane choice (among the
lanes the router already proposed for the members) and per-lane batch size tuning (batch-tuning.json).
`batcher.py report` prints the same numbers.

Pure planning and parsing plus small JSON files; no network, no subprocesses, no model calls.
"""
import argparse
from collections import Counter
import hashlib
import json
import math
import os
import re
import time

SCHEMA = "dispatchd.batch.v1"
TUNING_SCHEMA = "dispatchd.batch-tuning.v1"
BATCH_PREFIX = "RQ-BATCH-"
# codex-local runs a small local model with a 6-session pool; batches go to the hosted agent lanes only.
BATCH_LANES = ("codex-cmp", "codex-personal", "claude", "devin", "claude-api")
# Release, desktop, main-repair and PR-maintenance work stays one job per session: each targets a
# specific branch or PR and their priority buckets must not wait for unrelated batch-mates.
SOLO_PREFIXES = ("RQ-FIX-MAIN-", "RQ-REL-", "RQ-DESK-", BATCH_PREFIX)
SOLO_KINDS = re.compile(r"(?:RQ-)?(?:LAND|FIXUP|RECUT|SALVAGE|CONSOLIDATE|CLOSE)(?:[-_]|$)")
MIN_BATCH = 3            # fewer related tasks than this launch individually
MIN_SIZE, DEFAULT_SIZE, MAX_SIZE = 4, 16, 64
MAX_PROMPT_CHARS = 200_000
MAX_ATTEMPTS = 2
MIN_SESSIONS = 3         # samples before a lane's throughput counts for lane choice or tuning
WALL_BUDGET_S = 4 * 3600
GROW, SHRINK = 1.25, 0.7
OUTCOMES = ("done", "skipped", "failed", "deferred", "unreported")
RETRY = ("failed", "deferred", "unreported")
JID = re.compile(r"^[A-Za-z0-9._-]+$")

PATH_RX = re.compile(r"(?<![\w./-])((?:src|test|tests|scripts|contrib|docs|desktop|packages|crates|apps|bin|site|ci|"
                     r"\.github)/[\w.@-]+(?:/[\w.@-]+)*)")
TEST_DIRS = {"test", "tests"}


def batchable_id(job):
    return bool(JID.match(job)) and not job.startswith(SOLO_PREFIXES) and not SOLO_KINDS.match(job)


def area_of(job, prompt):
    """The source directory a task's prompt names most often: src/<a>/<b> or <top>/<a>.

    Test directories only count when nothing else is named. Prompts without paths fall back to the
    job id family (RQ-PHX-... -> family:PHX), so unrelated families never share a batch.
    """
    counts, tests = Counter(), Counter()
    for m in PATH_RX.finditer(prompt[:20000]):
        parts = m.group(1).rstrip(".").split("/")
        dirs = parts[:-1] if "." in parts[-1] else parts
        if not dirs:
            continue
        depth = 3 if dirs[0] == "src" else 2
        (tests if dirs[0] in TEST_DIRS else counts)["/".join(dirs[:depth])] += 1
    best = counts or tests
    if best:
        return min(best, key=lambda k: (-best[k], k))
    m = re.match(r"(?:RQ-)?([A-Za-z]+)[-_]", job)
    return "family:" + (m.group(1).upper() if m else "misc")


def batch_id(repo, area, members):
    slug = lambda s, n: re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-").upper()[:n] or "X"
    digest = hashlib.sha256("\n".join(sorted(members)).encode()).hexdigest()[:8]
    return "%s%s-%s-%s" % (BATCH_PREFIX, slug(repo, 24), slug(area.split(":")[-1].split("/")[-1], 24), digest)


def pick_members(lead, pool, size):
    """Choose the batch for `lead` from `pool` (priority order, lead excluded).

    Entries are dicts with job, repo, tier, area and chars (prompt length). Same repo, tier and area
    first; a lead whose area is too small for a batch absorbs other small-area orphans of its repo and
    tier, never members of an area big enough to batch on its own. Batches are evened out (n tasks over
    ceil(n / size) batches) and bounded by MAX_PROMPT_CHARS. Returns [] when fewer than MIN_BATCH fit.
    """
    peers = [c for c in pool if c["repo"] == lead["repo"] and c["tier"] == lead["tier"]]
    area_n = Counter(c["area"] for c in peers + [lead])
    group = [lead] + [c for c in peers if c["area"] == lead["area"]]
    if len(group) < MIN_BATCH:
        group += [c for c in peers if c["area"] != lead["area"] and area_n[c["area"]] < MIN_BATCH]
    if len(group) < MIN_BATCH:
        return []
    take = math.ceil(len(group) / math.ceil(len(group) / max(MIN_SIZE, size)))
    out, chars = [], 0
    for c in group:
        if len(out) >= take:
            break
        if out and chars + c["chars"] > MAX_PROMPT_CHARS:
            continue
        out.append(c)
        chars += c["chars"]
    return out if len(out) >= MIN_BATCH else []


def render(bid, repo, area, members):
    """members: [(job, prompt text)]. The checklist block is what parse_outcomes reads back."""
    n = len(members)
    head = ["# %s: batch of %d related tasks (%s, %s)" % (bid, n, repo, area), "",
            "One agent session owns all %d tasks below (RQ-QUEUE-BATCH-1). Work them in parallel: fan out" % n,
            "subagents or parallel tool calls for independent tasks, serialize edits to shared files, and land",
            "them together as one coherent, reviewable change. Each task keeps its own RULES; where they",
            "differ, the strictest rule wins. Run each task's checks before you mark it done.", "",
            "Per-task checklist (required). Copy this block into BRIDGE_NOTES.md at the worktree root and",
            "keep it current, one line per task. dispatchd parses it to log every task's outcome and",
            "re-queues each task that is not done:", "",
            "<!-- batch-checklist:%s -->" % bid]
    head += ["- [ ] %s — pending" % job for job, _ in members]
    head += ["<!-- /batch-checklist -->", "",
             "Finish each line as `- [x] <JOB> — done: <one-line summary>` or",
             "`- [ ] <JOB> — failed|skipped|deferred: <reason>`. Use skipped only when no change is needed",
             "(already satisfied, duplicate, obsolete); it is not retried. Failed, deferred and pending tasks",
             "are re-queued individually, so an honest status costs nothing. In BRIDGE_NOTES.md, also list",
             "the commands you ran and their results for each task.", ""]
    body = []
    for i, (job, prompt) in enumerate(members, 1):
        body += ["", "## Task %d of %d: %s" % (i, n, job), "", prompt.rstrip(), ""]
    return "\n".join(head + body) + "\n"


CHECK = re.compile(r"^\s*[-*]\s*\[(?P<box>[ xX])\]\s*(?P<job>[A-Za-z0-9._-]+)\s*(?:—|–|-|:)+\s*(?P<word>[A-Za-z]*)", re.M)


def parse_outcomes(notes, members):
    """job -> outcome for every member. The last checklist line per job wins; missing is unreported."""
    seen = {}
    for m in CHECK.finditer(notes[:262144]):
        word = m.group("word").lower()
        word = "deferred" if word == "blocked" else word
        if word not in OUTCOMES or word == "unreported":
            word = "done" if m.group("box") in "xX" else "unreported"
        elif word == "done" and m.group("box") == " ":
            word = "unreported"   # a "done" line left unchecked is not evidence of completion
        seen[m.group("job")] = word
    return {j: seen.get(j, "unreported") for j in members}


# ---- self-improvement metrics -------------------------------------------------------------------
def _epoch(ts):
    try:
        return time.mktime(time.strptime(str(ts)[:19], "%Y-%m-%dT%H:%M:%S"))
    except (ValueError, TypeError):
        return None


def throughput(rows, now, window_s=7 * 86400):
    """Per lane and mode: sessions, session hours, tokens, tasks completed and the two rates.

    A task counts as completed when its session published a PR: a single job that finished non-empty,
    or a batch member the session reported done.
    """
    pub = {r.get("job") for r in rows if r.get("event") == "publish" and r.get("url")}
    done = Counter(r.get("batch") for r in rows if r.get("event") == "task_outcome" and r.get("outcome") == "done")
    out = {}
    for r in rows:
        if r.get("event") != "finish" or not isinstance(r.get("lane"), str):
            continue
        t = _epoch(r.get("ts"))
        if t is None or now - t > window_s:
            continue
        mode = "batch" if r.get("batch_size") else "single"
        s = out.setdefault(r["lane"], {}).setdefault(mode, {"sessions": 0, "session_s": 0, "tokens": 0, "tasks": 0, "tasks_offered": 0})
        s["sessions"] += 1
        s["session_s"] += r.get("wall_s") or 0
        s["tokens"] += r.get("tokens_total") or 0
        s["tasks_offered"] += r.get("batch_size") or 1
        if r.get("job") in pub:
            s["tasks"] += done[r["job"]] if mode == "batch" else (0 if r.get("empty") else 1)
    for modes in out.values():
        for s in modes.values():
            s["tasks_per_session_hour"] = round(s["tasks"] / (s["session_s"] / 3600), 3) if s["session_s"] else None
            s["tasks_per_mtok"] = round(s["tasks"] / (s["tokens"] / 1e6), 3) if s["tokens"] else None
    return out


def lane_scores(stats):
    """lane -> (tasks/session-hour, tasks/Mtok) over all modes, for lanes with MIN_SESSIONS samples."""
    scores = {}
    for lane, modes in stats.items():
        sessions = sum(s["sessions"] for s in modes.values())
        hours = sum(s["session_s"] for s in modes.values()) / 3600
        tokens = sum(s["tokens"] for s in modes.values())
        tasks = sum(s["tasks"] for s in modes.values())
        if sessions >= MIN_SESSIONS and hours > 0:
            scores[lane] = (tasks / hours, tasks / (tokens / 1e6) if tokens else 0.0)
    return scores


def choose_lane(proposed, scores, has_capacity, default):
    """Best measured lane among those the router proposed for the members and that has a free slot."""
    open_ = [l for l in BATCH_LANES if l in proposed and has_capacity(l)]
    scored = [l for l in open_ if l in scores]
    if scored:
        return max(scored, key=lambda l: (scores[l], -BATCH_LANES.index(l)))
    if default in open_:
        return default
    return open_[0] if open_ else None


def load_tuning(path):
    try:
        with open(path) as f:
            t = json.load(f)
        if t.get("schema") == TUNING_SCHEMA and isinstance(t.get("lanes"), dict):
            return t
    except (OSError, ValueError, AttributeError):
        pass
    return {"schema": TUNING_SCHEMA, "lanes": {}}


def size_for(tuning, lane):
    v = tuning["lanes"].get(lane, {}).get("size")
    return v if isinstance(v, int) and MIN_SIZE <= v <= MAX_SIZE else DEFAULT_SIZE


def tune(tuning, lane, outcomes, wall_s, timed_out, stats, now):
    """Feed one reaped batch back into its lane's size. Returns (old, new, reason)."""
    old = size_for(tuning, lane)
    n = max(1, len(outcomes))
    ratio = sum(1 for o in outcomes.values() if o in ("done", "skipped")) / n
    modes = stats.get(lane, {})
    b, s = modes.get("batch", {}), modes.get("single", {})
    slower = (b.get("sessions", 0) >= MIN_SESSIONS and s.get("sessions", 0) >= MIN_SESSIONS
              and b.get("tasks_per_session_hour") is not None and s.get("tasks_per_session_hour") is not None
              and b["tasks_per_session_hour"] < s["tasks_per_session_hour"])
    if timed_out or ratio < 0.6 or slower:
        new, why = max(MIN_SIZE, int(old * SHRINK)), ("timeout" if timed_out else "batch slower than single" if slower
                                                      else "completion %.2f" % ratio)
    elif ratio >= 0.85 and (wall_s or 0) <= WALL_BUDGET_S:
        new, why = min(MAX_SIZE, math.ceil(old * GROW)), "completion %.2f" % ratio
    else:
        new, why = old, "hold completion %.2f" % ratio
    row = tuning["lanes"].setdefault(lane, {})
    row["size"], row["updated_at"] = new, now
    row["history"] = (row.get("history", []) + [{"ts": now, "from": old, "to": new, "reason": why, "members": n}])[-20:]
    return old, new, why


def save_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=1, sort_keys=True)
    os.replace(tmp, path)


def read_rows(path):
    """Read ledger rows, projecting reconciled outcomes into dispatcher vocabulary."""
    rows = []
    try:
        with open(path) as f:
            for line in f:
                try:
                    row = json.loads(line)
                    if (isinstance(row, dict) and row.get("source") == "metrics-outcomes-reconciler"
                            and row.get("outcome", row.get("status")) in ("MERGED", "CLOSED")):
                        job = row.get("jobId", row.get("job", row.get("id")))
                        url = row.get("prUrl", row.get("pr"))
                        if isinstance(job, str) and job and isinstance(url, str) and url:
                            row = dict(row, event="outcome", job=job, url=url.rstrip("/"),
                                       state=row.get("outcome", row.get("status")))
                    rows.append(row)
                except ValueError:
                    pass
    except OSError:
        pass
    return rows


def main(argv=None):
    p = argparse.ArgumentParser(description="Batch throughput report: tasks per session-hour and per Mtok, by lane and mode.")
    p.add_argument("action", choices=("report",))
    p.add_argument("--runs", default=os.path.expanduser("~/.ashlr-runs"), help="runs directory (default ~/.ashlr-runs)")
    p.add_argument("--window-h", type=float, default=168.0)
    p.add_argument("--json", action="store_true")
    a = p.parse_args(argv)
    now = time.time()
    stats = throughput(read_rows(os.path.join(a.runs, "metrics", "jobs.jsonl")), now, a.window_h * 3600)
    tuning = load_tuning(os.path.join(a.runs, "queue", "batch-tuning.json"))
    sizes = {l: size_for(tuning, l) for l in BATCH_LANES}
    if a.json:
        print(json.dumps({"schema": "dispatchd.batch-report.v1", "window_h": a.window_h, "lanes": stats,
                          "batch_sizes": sizes}, indent=1, sort_keys=True))
        return 0
    print("lane            mode    sessions  hours   tasks  tasks/session-h  tasks/Mtok")
    for lane in sorted(stats):
        for mode, s in sorted(stats[lane].items()):
            print("%-15s %-7s %8d %6.1f %7d %16s %11s" % (lane, mode, s["sessions"], s["session_s"] / 3600, s["tasks"],
                                                        s["tasks_per_session_hour"], s["tasks_per_mtok"]))
    print("batch sizes: " + ", ".join("%s=%d" % kv for kv in sizes.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
