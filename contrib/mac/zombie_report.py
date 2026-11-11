#!/usr/bin/python3
"""Which parent is not reaping its children? (RQ-BATCH-SESSIONS-2, Mac side)

A <defunct> (zombie) process holds a pid slot until its parent calls wait(). Killing the zombie does nothing; the
fix is in the parent. This lists every zombie grouped by parent pid with the parent's command line, largest
group first, so the parent that does not wait is named, not guessed. Read-only: it signals nothing.

    python3 contrib/mac/zombie_report.py [--json]

Repo-side parents already fixed in this change: dispatchd.py polls its detached launch/reap/metrics children at
every phase, and dispatchd._run / process_snapshot._bounded now wait for a child they killed on timeout.
"""
import argparse
from collections import Counter
import json
import sys

from process_snapshot import _bounded


def parse(table):
    """`ps -axo pid=,ppid=,stat=,comm=` text -> Counter(ppid -> zombie count) and their sample names."""
    counts, names = Counter(), {}
    for line in table.splitlines():
        parts = line.split(None, 3)
        if len(parts) < 3 or not parts[0].isdigit() or not parts[1].isdigit():
            continue
        if "Z" in parts[2]:
            ppid = int(parts[1])
            counts[ppid] += 1
            names.setdefault(ppid, Counter())[parts[3].strip() if len(parts) > 3 else "?"] += 1
    return counts, names


def parent_commands(ppids, run=_bounded):
    if not ppids:
        return {}
    r = run(["ps", "-ww", "-p", ",".join(str(p) for p in ppids), "-o", "pid=,command="], 5)
    out = {}
    for line in (r.stdout or "").splitlines():
        pid, _, cmd = line.strip().partition(" ")
        if pid.isdigit():
            out[int(pid)] = cmd.strip()[:300]
    return out


def report(run=_bounded):
    r = run(["ps", "-axo", "pid=,ppid=,stat=,comm="], 10)
    if r.returncode:
        return {"schema": "ashlr.zombie-report.v1", "known": False, "error": (r.stderr or "ps failed").strip()[:200]}
    counts, names = parse(r.stdout)
    cmds = parent_commands(sorted(counts), run)
    parents = [{"ppid": p, "zombies": n, "parent_command": cmds.get(p, "(parent gone; launchd will reap)"),
                "zombie_names": dict(names[p].most_common(5))} for p, n in counts.most_common()]
    return {"schema": "ashlr.zombie-report.v1", "known": True, "zombies": sum(counts.values()), "parents": parents}


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--json", action="store_true")
    a = p.parse_args(argv)
    rep = report()
    if a.json or not rep.get("known"):
        print(json.dumps(rep, indent=1, sort_keys=True))
        return 0 if rep.get("known") else 1
    print("zombies: %d" % rep["zombies"])
    for x in rep["parents"]:
        print("%6d defunct under ppid %-7d %s" % (x["zombies"], x["ppid"], x["parent_command"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
