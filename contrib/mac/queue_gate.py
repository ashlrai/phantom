#!/usr/bin/python3
"""Read-only ready queue capacity calculation for producers."""
import argparse
import json
import os
import re
import sys

LANES = {"codex-cmp", "codex-personal", "claude", "devin", "claude-api", "codex-local"}
TIERS = {"frontier", "work", "mid", "fast"}
ID = re.compile(r"[A-Za-z0-9._-]+")


def allowance(cap, rows, retired):
    """Compute capacity from validated inputs, without side effects."""
    if type(cap) is not int or cap < 0:
        raise ValueError("invalid global cap")
    target = max(8, (5 * cap + 1) // 2)
    seen = set()
    for row in rows.splitlines():
        if not row.strip() or row.lstrip().startswith("#"):
            continue
        f = row.split("\t")
        if f[0].startswith("PARKED-") or (len(f) > 2 and f[2].startswith("PARKED-")):
            continue
        if len(f) < 5 or not ID.fullmatch(f[0]) or f[2] not in LANES or f[3] not in TIERS or not f[1] or not f[4]:
            continue
        if f[0] not in retired:
            seen.add(f[0])
    depth = len(seen)
    return {"depth": depth, "target": target, "allow": max(0, target - depth)}


def read_gate(q):
    try:
        with open(os.path.join(q, "admission.json")) as f: cap = json.load(f)["cap"]
        with open(os.path.join(q, "ready.tsv")) as f: rows = f.read()
        with open(os.path.join(q, "router-queue.md")) as f: router = f.read()
        retired = set(re.findall(r"^- RETIRED (?:\S+ )*?([A-Za-z0-9._-]+)[ \[(]", router, re.M))
        path = os.path.join(q, "RETIRED")
        if os.path.exists(path):
            with open(path) as f: retired.update(f.read().split())
        return allowance(cap, rows, retired)
    except (OSError, ValueError, KeyError, TypeError):
        return {"depth": None, "target": None, "allow": 0}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--queue", default=os.path.expanduser("~/.ashlr-runs/queue"))
    parser.add_argument("--want", type=int)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    if args.want is not None and args.want < 0: parser.error("--want must be nonnegative")
    result = read_gate(args.queue)
    if args.want is not None: result["allow"] = min(result["allow"], args.want)
    print(json.dumps(result) if args.json else result["allow"])
    return 0 if result["allow"] else 75


if __name__ == "__main__":
    sys.exit(main())
