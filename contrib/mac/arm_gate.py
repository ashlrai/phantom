#!/usr/bin/env python3
"""RQ-ARM-CI-GATE-1: decide whether a published bridge PR is safe to arm for auto-merge.

Verdicts for a head sha (from its check-runs):
  SAFE     every hard-required check completed with success and nothing relevant is red or running
  RED      a relevant check completed failure / timed_out / cancelled / action_required / stale
  PENDING  nothing red yet, but a hard-required check is missing or a relevant check is still running
  UNKNOWN  the check-runs could not be read
Only SAFE arms. PENDING and UNKNOWN are deferred (bounded) and re-evaluated by `sweep`; RED is dropped for leader review.
Nothing here weakens or bypasses a check: it only withholds arming that cannot succeed yet.

Classification (grounded in .github/workflows/ci.yml merge-gate on master):
  HARD      Merge Gate, Secret-shape scan, Secret scan (diff), Classify PR site lane, Check generated files,
            Fast gate (typecheck + affected tests): Merge Gate requires these on pull_request.
  RELEVANT  Quick typecheck and Check authority drift (hermetic): Merge Gate treats both as advisory (the in-repo "Mason
            directive 2026-11-13" for Quick is repo text and unverified), but they are quality checks that run on every PR.
            Live data: neither failed on the last 15 master commits or the last 25 merged PR heads, so blocking ARMING on
            them costs nothing in practice and only delays. They must also be PRESENT (a missing row is PENDING, not safe); skipped counts as present. Any other non-ignored check is also relevant.
  IGNORED   Perf budget (advisory), CodeRabbit, Vercel Preview Comments: advisory or third party.
"""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HARD = ("Merge Gate", "Secret-shape scan", "Secret scan (diff)", "Classify PR site lane",
        "Check generated files", "Fast gate (typecheck + affected tests)")
EXPECTED = ("Quick typecheck", "Check authority drift (hermetic)")  # must be present and completed; skipped is a legitimate conclusion
IGNORED = ("perf budget", "coderabbit", "vercel")
RED = {"failure", "timed_out", "cancelled", "action_required", "stale", "startup_failure"}
OK = {"success", "neutral", "skipped"}


def gh(*args, timeout=30):
    return subprocess.run(["gh", *args], capture_output=True, text=True, timeout=timeout)


def read_rows(repo, sha):
    r = gh("api", f"repos/{repo}/commits/{sha}/check-runs?per_page=100", "--jq",
           '.check_runs[] | [.id, .name, .status, (.conclusion // "")] | @tsv')
    if r.returncode != 0:
        return None
    latest = {}
    for line in r.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) != 4:
            continue
        cid, name, status, conclusion = int(parts[0]), parts[1], parts[2], parts[3]
        if name not in latest or cid > latest[name][0]:
            latest[name] = (cid, status, conclusion)  # reruns: newest run per name wins
    return {n: (s, c) for n, (_, s, c) in latest.items()}


def classify(rows):
    if rows is None:
        return "UNKNOWN", []
    red, pending = [], []
    for name, (status, conclusion) in sorted(rows.items()):
        if any(name.lower().startswith(i) for i in IGNORED):
            continue
        if status == "completed":
            if conclusion in RED:
                red.append(name)
            elif conclusion not in OK:
                red.append(f"{name}({conclusion})")
        else:
            pending.append(name)
    if red:
        return "RED", red
    for name in HARD:
        got = rows.get(name)
        if got is None or got[0] != "completed" or got[1] != "success":
            pending.append(name)
    for name in EXPECTED:
        got = rows.get(name)
        if got is None or got[0] != "completed":
            pending.append(name)
    if pending:
        return "PENDING", sorted(set(pending))
    return "SAFE", []


def evaluate(repo, sha, wait=0, poll=10):
    waited = 0
    while True:
        verdict, names = classify(read_rows(repo, sha))
        if verdict in ("SAFE", "RED") or waited >= wait:
            return verdict, names
        time.sleep(poll)
        waited += poll


def say(verdict, names):
    print(verdict + (": " + ", ".join(names) if names else ""))
    return {"SAFE": 0, "RED": 1}.get(verdict, 2)


def cmd_check(a):
    return say(*evaluate(a.repo, a.sha, a.wait, a.poll))


def cmd_defer(a):
    d = Path(a.dir)
    d.mkdir(parents=True, exist_ok=True)
    rec = {"repo": a.repo, "pr": a.pr, "sha": a.sha, "job": a.job, "deadline": int(time.time()) + a.deadline_s}
    tmp = d / f".{a.job}.tmp"
    tmp.write_text(json.dumps(rec))
    os.replace(tmp, d / f"{a.job}.json")
    print(f"DEFERRED {a.job} until {rec['deadline']}")
    return 0


def cmd_sweep(a):
    armed = 0
    for f in sorted(Path(a.dir).glob("*.json")):
        try:
            rec = json.loads(f.read_text())
            repo, pr, sha = rec["repo"], rec["pr"], rec["sha"]
            deadline = int(rec["deadline"])
        except (ValueError, KeyError, OSError):
            print(f"DROP {f.name} malformed")
            f.unlink(missing_ok=True)
            continue
        if time.time() > deadline:
            print(f"DROP {f.name} expired (leader review)")
            f.unlink(missing_ok=True)
            continue
        v = gh("pr", "view", pr, "--repo", repo, "--json", "state,headRefOid,autoMergeRequest")
        try:
            live = json.loads(v.stdout)
        except ValueError:
            print(f"KEEP {f.name} unreadable")
            continue
        if live.get("state") != "OPEN" or live.get("headRefOid") != sha or live.get("autoMergeRequest"):
            print(f"DROP {f.name} state/head changed or already armed")
            f.unlink(missing_ok=True)
            continue
        verdict, names = evaluate(repo, sha, 0)
        if verdict == "RED":
            print(f"DROP {f.name} red: {', '.join(names)} (leader review)")
            f.unlink(missing_ok=True)
        elif verdict != "SAFE":
            print(f"KEEP {f.name} {verdict}")
        elif armed >= a.max_arms:
            print(f"KEEP {f.name} capped")
        elif not a.apply:
            print(f"WOULD_ARM {f.name}")
        else:
            m = gh("pr", "merge", pr, "--repo", repo, "--auto", "--match-head-commit", sha)
            if m.returncode == 0:
                print(f"ARMED {f.name}")
                armed += 1
                f.unlink(missing_ok=True)
            else:
                print(f"KEEP {f.name} arm-failed")
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    s = p.add_subparsers(dest="cmd", required=True)
    c = s.add_parser("check"); c.add_argument("--repo", required=True); c.add_argument("--sha", required=True)
    c.add_argument("--wait", type=int, default=0); c.add_argument("--poll", type=int, default=10); c.set_defaults(fn=cmd_check)
    d = s.add_parser("defer"); d.add_argument("--dir", required=True); d.add_argument("--repo", required=True)
    d.add_argument("--pr", required=True); d.add_argument("--sha", required=True); d.add_argument("--job", required=True)
    d.add_argument("--deadline-s", type=int, default=3600); d.set_defaults(fn=cmd_defer)
    w = s.add_parser("sweep"); w.add_argument("--dir", required=True); w.add_argument("--apply", action="store_true")
    w.add_argument("--max-arms", type=int, default=3); w.set_defaults(fn=cmd_sweep)
    a = p.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
