#!/usr/bin/env python3
"""Per-file blob comparison between a PR head and the pinned master snapshot.
Columns (tab-separated):
  status      SAME | DIFFERS | PR_ONLY (path on PR head, absent on master)
              | MASTER_ONLY (path on master, absent on PR head = PR deleted it)
              | NEITHER (deleted by PR and absent on master)
  path        file path
  pr_blob     12-char blob sha on the PR head, or '-'
  master_blob 12-char blob sha on pinned master, or '-'
Diff base for the PR's own change: prhead^ (single-commit bridge branches)."""
import subprocess
import sys


def run(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True)


def blob(ref, path):
    r = run("rev-parse", "-q", "--verify", f"{ref}:{path}")
    return r.stdout.strip()[:12] if r.returncode == 0 else None


def main(head, snap):
    files = run("diff", "--name-only", f"{head}^", head).stdout.splitlines()
    for f in files:
        pb, mb = blob(head, f), blob(snap, f)
        if pb and mb:
            status = "SAME" if pb == mb else "DIFFERS"
        elif pb:
            status = "PR_ONLY"
        elif mb:
            status = "MASTER_ONLY"
        else:
            status = "NEITHER"
        print(f"{status}\t{f}\t{pb or '-'}\t{mb or '-'}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
