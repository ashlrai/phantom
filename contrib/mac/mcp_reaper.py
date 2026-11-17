"""Count and reap orphaned npm-exec MCP server trees.

Jobs run in worktrees whose `.mcp.json` declares npx-launched MCP servers.
When a job's engine exits, the npm/sh/node trees it spawned can be re-parented
to launchd (ppid 1) and keep running. This module measures them (census) and
kills the ones that outlived their job (reap).

Safety rules, in order:
  * Only processes whose executable is npm/npx/node/sh and whose arguments name
    one of the known MCP servers are ever considered.
  * Only trees whose root has ppid 1 and age above the grace window die. A
    live job's MCP servers keep their engine as ancestor, so they never match.
  * A process group is signalled only when every member in the snapshot is in
    the kill set; otherwise each pid is signalled alone.
  * An incomplete or failed process inventory kills nothing.

Usage: mcp_reaper.py census [--json] | reap [--grace SECONDS] [--dry-run] [--json]
"""
import argparse
import json
import os
import re
import signal
import sys
import time

import process_snapshot

GRACE_SECONDS = 60
TERM_WAIT_SECONDS = 2.0
LAUNCHERS = {'npm', 'npx', 'node', 'sh', 'bash', 'zsh'}
# Lookarounds keep `ashlr-mcp` from matching inside `ashlr-stack-mcp` or a
# scoped path segment of an unrelated package.
MCP_NAME = re.compile(
    r'(?<![\w-])(phantom-secrets-mcp|locus-mcp|lexicon-mcp|ashlr-stack-mcp|ashlr-mcp)(?![\w-])')
_ETIME = re.compile(r'^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$')


def parse_etime(text):
    """Convert ps etime ([[dd-]hh:]mm:ss) to seconds, or None if malformed."""
    m = _ETIME.match(text.strip())
    if not m:
        return None
    days, hours, minutes, seconds = (int(g or 0) for g in m.groups())
    return ((days * 24 + hours) * 60 + minutes) * 60 + seconds


def parse_rows(text):
    """Parse `ps -axo pid=,ppid=,pgid=,etime=,rss=,command=` into dict rows."""
    rows = {}
    for line in text.splitlines():
        parts = line.strip().split(None, 5)
        if len(parts) < 6 or not all(p.isdigit() for p in (parts[0], parts[1], parts[2], parts[4])):
            continue
        age = parse_etime(parts[3])
        if age is None:
            continue
        rows[int(parts[0])] = {'pid': int(parts[0]), 'ppid': int(parts[1]), 'pgid': int(parts[2]),
                               'age': age, 'rss_kb': int(parts[4]), 'command': parts[5]}
    return rows


def is_mcp(row):
    first = row['command'].split(None, 1)[0]
    return os.path.basename(first) in LAUNCHERS and bool(MCP_NAME.search(row['command']))


def is_npm_exec(row):
    parts = row['command'].split()
    return bool(parts) and os.path.basename(parts[0]) in ('npm', 'npx') and is_mcp(row)


def analyse(rows, grace=GRACE_SECONDS):
    """Return census numbers plus the pids of orphaned MCP trees to reap."""
    mcp = {pid for pid, row in rows.items() if is_mcp(row)}
    roots = {pid for pid in mcp if rows[pid]['ppid'] not in mcp}
    children = {}
    for pid, row in rows.items():
        children.setdefault(row['ppid'], []).append(pid)

    def tree(root):
        seen, stack = set(), [root]
        while stack:
            pid = stack.pop()
            if pid not in seen:
                seen.add(pid)
                stack.extend(children.get(pid, []))
        return seen

    orphan_roots = sorted(pid for pid in roots if rows[pid]['ppid'] == 1)
    stale_roots = [pid for pid in orphan_roots if rows[pid]['age'] > grace]
    kill = set()
    for root in stale_roots:
        kill |= tree(root)
    return {
        'mcp_processes': len(mcp),
        'npm_exec_processes': sum(1 for pid in mcp if is_npm_exec(rows[pid])),
        'rss_kb': sum(rows[pid]['rss_kb'] for pid in mcp),
        'roots': len(roots),
        'orphan_roots': len(orphan_roots),
        'orphan_roots_over_grace': len(stale_roots),
        'oldest_orphan_age': max((rows[pid]['age'] for pid in orphan_roots), default=0),
        'kill': sorted(kill),
    }


def plan_signals(rows, kill):
    """Split the kill set into whole process groups and loose pids."""
    members = {}
    for pid, row in rows.items():
        members.setdefault(row['pgid'], set()).add(pid)
    own = os.getpgrp()
    groups, loose = [], []
    for pgid in sorted({rows[pid]['pgid'] for pid in kill}):
        if pgid > 1 and pgid != own and members[pgid] <= set(kill):
            groups.append(pgid)
    covered = set().union(*(members[g] for g in groups)) if groups else set()
    loose = sorted(set(kill) - covered)
    return groups, loose


def snapshot(timeout=5):
    """Return parsed rows, or None when the inventory is unknown."""
    try:
        done = process_snapshot._bounded(
            ['ps', '-axo', 'pid=,ppid=,pgid=,etime=,rss=,command='], timeout)
    except OSError:  # ps blocked or missing: unknown, never "no orphans"
        return None
    if done.returncode:
        return None
    rows = parse_rows(done.stdout)
    return rows or None


def _signal(groups, loose, sig):
    for pgid in groups:
        try:
            os.killpg(pgid, sig)
        except OSError:
            pass
    for pid in loose:
        try:
            os.kill(pid, sig)
        except OSError:
            pass


def reap(grace=GRACE_SECONDS, dry_run=False, read=snapshot, sleep=time.sleep):
    rows = read()
    if rows is None:
        return {'known': False, 'killed': 0}
    report = analyse(rows, grace)
    kill = report.pop('kill')
    groups, loose = plan_signals(rows, kill)
    report.update(known=True, killed=0 if dry_run else len(kill), would_kill=len(kill),
                  groups=groups, loose=loose)
    if kill and not dry_run:
        _signal(groups, loose, signal.SIGTERM)
        sleep(TERM_WAIT_SECONDS)
        _signal(groups, loose, signal.SIGKILL)
    return report


def census(read=snapshot):
    rows = read()
    if rows is None:
        return {'known': False}
    report = analyse(rows)
    report.pop('kill')
    report['known'] = True
    return report


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('action', choices=('census', 'reap'))
    ap.add_argument('--grace', type=int, default=GRACE_SECONDS)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args(argv)
    report = census() if args.action == 'census' else reap(args.grace, args.dry_run)
    if args.json:
        print(json.dumps(report, sort_keys=True))
    else:
        print(' '.join(f'{k}={v}' for k, v in sorted(report.items())))
    return 0 if report.get('known') else 3


if __name__ == '__main__':
    sys.exit(main())
