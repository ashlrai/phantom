#!/usr/bin/env python3
"""Hunk-level supersession check: per PR file, are the PR's added lines
present in the current master snapshot, and its deleted lines gone?
(Copied from RQ-DRAIN-PHX-REB-33 fleet precedent, same semantics.)"""
import subprocess
import sys


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True).stdout


def changed_files(mb, head, path_filter=None):
    out = git("diff", "--name-only", mb, head)
    return [f for f in out.splitlines() if f]


def diff_lines(mb, head, path):
    out = git("diff", mb, head, "--", path)
    added, deleted = [], []
    for line in out.splitlines():
        if line.startswith("+++") or line.startswith("---"):
            continue
        if line.startswith("+"):
            added.append(line[1:].rstrip())
        elif line.startswith("-"):
            deleted.append(line[1:].rstrip())
    return added, deleted


def meaningful(lines):
    return [l for l in lines if len(l.strip()) >= 8]


def master_content(snap, path):
    r = subprocess.run(["git", "show", f"{snap}:{path}"], capture_output=True, text=True)
    return set(l.rstrip() for l in r.stdout.splitlines()) if r.returncode == 0 else None


def main(pr, mb, head, snap):
    files = changed_files(mb, head)
    total_added = total_added_present = total_deleted = total_deleted_remaining = 0
    rows = []
    for f in files:
        added, deleted = diff_lines(mb, head, f)
        madd, mdel = meaningful(added), meaningful(deleted)
        mc = master_content(snap, f)
        add_present = sum(1 for l in madd if mc is not None and l in mc)
        del_remaining = sum(1 for l in mdel if mc is not None and l in mc)
        total_added += len(madd)
        total_added_present += add_present
        total_deleted += len(mdel)
        total_deleted_remaining += del_remaining
        rows.append((f, len(madd), add_present, len(mdel), del_remaining, mc is None))
    print(f"PR #{pr}: files={len(files)} added(m>=8c)={total_added} present_on_master={total_added_present} "
          f"deleted(m>=8c)={total_deleted} still_on_master={total_deleted_remaining}")
    for f, na, ap, nd, dr, absent in rows:
        flag = ""
        if absent:
            flag = " [path absent on master]"
        landed_add = "all" if na and ap == na else ("none" if ap == 0 else f"{ap}/{na}")
        landed_del = "all" if nd and dr == 0 else ("n/a" if nd == 0 else f"{dr} remain")
        print(f"  {f}: add {landed_add}, del {landed_del}{flag}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4])
