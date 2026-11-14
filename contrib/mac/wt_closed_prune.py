#!/usr/bin/python3
"""Prune run worktrees whose job is closed (RQ-BATCH-SESSIONS-2, Mac side).

A worktree under ~/Projects/ashlrai/wt/<job> is removable only when every check passes:
  * the ledger (metrics/jobs.jsonl) ends that job's history with a MERGED or CLOSED outcome, with no later
    enqueue/claim/launch row (a relaunch reopens it);
  * nothing claims it: no queue/run/<job>.batched lease, .dispatched or .reaping marker, not in queue/keep.txt,
    and no running process names the job;
  * it is a registered git worktree with no uncommitted or untracked changes (ignored build output is fine; its PR
    already carries the work).
Removal is `git worktree remove` without --force, so git itself refuses anything dirty, then one `git worktree
prune` per repository. Dry run by default; --apply removes at most --max worktrees per run. Never deletes a branch.
Shared objects make this cheap to undo: the branch and its commits stay in the main clone.

    python3 contrib/mac/wt_closed_prune.py [--apply] [--max 200] [--json]
"""
import argparse
from collections import Counter
import json
import os
import re
import subprocess
import sys

JID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
REOPEN = {"enqueue", "claim", "batch_claim", "queued", "launch"}


def closed_jobs(rows):
    """job -> MERGED|CLOSED for jobs whose last lifecycle row is a terminal outcome."""
    state = {}
    for r in rows:
        if not isinstance(r, dict) or not isinstance(r.get("job"), str):
            continue
        ev = r.get("event")
        if ev == "outcome" and r.get("state") in ("MERGED", "CLOSED"):
            state[r["job"]] = r["state"]
        elif ev in REOPEN:
            state[r["job"]] = None
    return {j: s for j, s in state.items() if s}


def git(args, timeout=60):
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(GIT_TERMINAL_PROMPT="0", GIT_OPTIONAL_LOCKS="0")
    try:
        return subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"] + args,
                              capture_output=True, text=True, timeout=timeout, env=env, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError) as e:
        return subprocess.CompletedProcess(args, 1, "", type(e).__name__)


def live_commands():
    r = subprocess.run(["ps", "-axww", "-o", "command="], capture_output=True, text=True, timeout=20)
    if r.returncode:
        raise RuntimeError("process list unavailable")
    return r.stdout


def plan(wtroot, runs, rows, commands):
    closed = closed_jobs(rows)
    run_dir = os.path.join(runs, "queue", "run")
    try:
        with open(os.path.join(runs, "queue", "keep.txt")) as f:
            keep = set(f.read().split())
    except OSError:
        keep = set()
    out, held = [], Counter()
    for name in sorted(os.listdir(wtroot)):
        path = os.path.join(wtroot, name)
        if not JID.match(name) or os.path.islink(path) or not os.path.isdir(path):
            continue
        why = None
        if name not in closed:
            why = "not-closed"
        elif name in keep:
            why = "keep-list"
        elif any(os.path.exists(os.path.join(run_dir, name + x)) for x in (".batched", ".dispatched", ".reaping")):
            why = "claimed"
        elif re.search(r"(?<![A-Za-z0-9._-])" + re.escape(name) + r"(?![A-Za-z0-9._-])", commands):
            why = "live-process"
        elif not os.path.isfile(os.path.join(path, ".git")):
            why = "not-a-linked-worktree"
        else:
            st = git(["-C", path, "status", "--porcelain", "--untracked-files=normal"])
            if st.returncode:
                why = "status-failed"
            elif st.stdout.strip():
                why = "dirty"
        if why:
            held[why] += 1
            continue
        out.append({"job": name, "path": path, "outcome": closed[name]})
    return out, held


def apply(items, limit):
    removed, failed, repos = [], [], set()
    for it in items[:limit]:
        common = git(["-C", it["path"], "rev-parse", "--path-format=absolute", "--git-common-dir"])
        repo = os.path.dirname(common.stdout.strip()) if common.returncode == 0 else None
        if not repo or not os.path.isdir(repo):
            failed.append({"job": it["job"], "why": "repo not found"})
            continue
        r = git(["-C", repo, "worktree", "remove", it["path"]])
        if r.returncode:
            failed.append({"job": it["job"], "why": (r.stderr or "remove failed").strip()[:200]})
            continue
        removed.append(it["job"])
        repos.add(repo)
    for repo in sorted(repos):
        git(["-C", repo, "worktree", "prune"])
    return removed, failed


def main(argv=None):
    p = argparse.ArgumentParser(description="Prune worktrees of closed jobs (dry run unless --apply).")
    p.add_argument("--wtroot", default=os.path.expanduser("~/Projects/ashlrai/wt"))
    p.add_argument("--runs", default=os.path.expanduser("~/.ashlr-runs"))
    p.add_argument("--apply", action="store_true")
    p.add_argument("--max", type=int, default=200, help="most worktrees removed per run (default 200)")
    p.add_argument("--json", action="store_true")
    a = p.parse_args(argv)
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import batcher   # same directory: reads jobs.jsonl and projects reconciler outcome rows
    rows = batcher.read_rows(os.path.join(a.runs, "metrics", "jobs.jsonl"))
    try:
        commands = live_commands()
    except (RuntimeError, OSError, subprocess.SubprocessError):
        print(json.dumps({"error": "process list unavailable; nothing pruned"}))
        return 1
    items, held = plan(a.wtroot, a.runs, rows, commands)
    removed, failed = apply(items, max(0, a.max)) if a.apply else ([], [])
    rep = {"schema": "ashlr.wt-closed-prune.v1", "dry_run": not a.apply, "removable": len(items), "held": dict(held),
           "removed": len(removed), "failed": failed}
    if a.json:
        rep["removable_jobs"] = [i["job"] for i in items]
        print(json.dumps(rep, indent=1, sort_keys=True))
    else:
        print("removable=%d removed=%d failed=%d held=%s%s" % (len(items), len(removed), len(failed),
              json.dumps(dict(held), sort_keys=True), " (dry run)" if not a.apply else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
