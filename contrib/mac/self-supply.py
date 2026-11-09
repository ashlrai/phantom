#!/usr/bin/env python3
"""Top up idle lanes between leader passes; --apply appends under ready.lock.

Reads queue/status.json: for every unheld lane whose (target - running - queued)
count is positive, each feed script beside this one (recut-feed.py, and
salvage-feed.py when present) is asked for up to that many READY lines with
--pool=<lane>. Lines whose job id is already in the router queue or the claimed
rows are dropped, every kept line carries pool=<lane>, the run is capped at
--cap lines total, and --apply appends them to the router queue under
queue/ready.lock while logging SELF_SUPPLY <lane> free=<n> added=<m> to
dispatch-events.log. --dry-run is the default and prints the plan as JSON.
"""
import argparse
import contextlib
import fcntl
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import time

RUNS = Path.home() / '.ashlr-runs'
HERE = Path(__file__).resolve().parent
FEEDS = ('recut-feed.py', 'salvage-feed.py')    # salvage is optional
CAP = 12                                       # most lines one run may append fleet-wide
LANE = re.compile(r'[a-z0-9-]{1,63}')
READY_ID = re.compile(r'^- READY ([A-Za-z0-9][A-Za-z0-9._-]*)')
ATTRS = re.compile(r'^(- READY \S+ \()([^)]*)\)(.*)$')
POOL = re.compile(r'\bpool=[a-z0-9-]+\b')


def read_text(path):
    try:
        return path.read_text()
    except OSError:
        return ''


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def lane_gaps(status, hold):
    """status.json lanes -> {lane: {'free': n}}; held lanes report {'held': True}."""
    lanes = status.get('lanes') if isinstance(status, dict) else None
    gaps = {}
    for lane, info in (lanes.items() if isinstance(lanes, dict) else ()):
        if not isinstance(info, dict) or not LANE.fullmatch(str(lane)):
            continue
        if info.get('held') or lane in hold:
            gaps[lane] = {'held': True}
            continue
        try:
            free = int(info.get('target') or 0) - int(info.get('running') or 0) - int(info.get('queued') or 0)
        except (TypeError, ValueError):
            continue
        gaps[lane] = {'free': max(free, 0)}
    return gaps


def feed_lines(script, lane, free, queue, timeout, pool=True):
    """One feed call: --dry-run --queue Q --max <free> [--pool <lane>] -> (lines, error)."""
    cmd = [sys.executable, '-B', str(script), '--dry-run', '--queue', str(queue), '--max', str(free)]
    if pool:
        cmd += ['--pool', lane]
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return [], 'timeout'
    except OSError as error:
        return [], type(error).__name__
    if pool and done.returncode == 2:    # a feed that does not know --pool still supplies; pool is stamped below
        return feed_lines(script, lane, free, queue, timeout, pool=False)
    if done.returncode != 0:
        detail = (done.stderr or '').strip().splitlines()
        return [], 'exit %d%s' % (done.returncode, ': ' + detail[-1][:80] if detail else '')
    try:
        report = json.loads(done.stdout or '{}')
    except ValueError:
        return [], 'bad json'
    lines = report.get('lines')
    if not isinstance(lines, list):
        return [], report.get('error') or 'no lines'
    return [line for line in lines if isinstance(line, str)], None


def job_id(line):
    match = READY_ID.match(line)
    return match.group(1) if match else None


def stamp_pool(line, lane):
    """Force the line's pool= attr to the lane; feeds may leave it open or stale."""
    match = ATTRS.match(line)
    if not match:
        return line
    attrs = match.group(2)
    attrs = (POOL.sub('pool=' + lane, attrs, count=1) if POOL.search(attrs)
             else attrs.rstrip() + (', ' if attrs.strip() else '') + 'pool=' + lane)
    return match.group(1) + attrs + ')' + match.group(3)


def supply(gaps, feeds_dir, queue, queue_text, cap, timeout):
    """Plan READY lines per lane: feed output deduped against the queue and this run."""
    feeds = {name: feeds_dir / name for name in FEEDS if (feeds_dir / name).is_file()}
    feed_status = {name: ('idle' if name in feeds else 'absent') for name in FEEDS}
    planned = {}
    skipped = {'duplicate': 0, 'malformed': 0, 'cap': 0}
    seen = set()
    remaining = cap
    for lane, info in gaps.items():
        free = info.get('free', 0)
        picked = planned.setdefault(lane, [])
        if info.get('held') or free <= 0:
            continue
        for name, script in feeds.items():
            if len(picked) >= free or remaining <= 0:
                break
            lines, error = feed_lines(script, lane, free, queue, timeout)
            feed_status[name] = 'ok' if error is None else 'error: ' + error
            for line in lines:
                jid = job_id(line)
                if jid is None:
                    skipped['malformed'] += 1
                    continue
                if jid in seen or re.search(r'\b' + re.escape(jid) + r'\b', queue_text):
                    skipped['duplicate'] += 1
                    continue
                if len(picked) >= free or remaining <= 0:
                    skipped['cap'] += 1
                    break
                seen.add(jid)
                picked.append(stamp_pool(line, lane))
                remaining -= 1
    return planned, feed_status, skipped


@contextlib.contextmanager
def queue_lock(path, timeout):
    with path.open('a') as lock:
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError('ready.lock busy; queue unchanged') from None
                time.sleep(min(0.05, max(0, deadline - time.monotonic())))
        yield


def append_locked(queue, planned, timeout):
    """Under ready.lock, drop ids a racing writer added, then append the survivors."""
    with queue_lock(queue.with_name('ready.lock'), timeout):
        text = read_text(queue)
        kept = {}
        for lane, lines in planned.items():
            alive = [line for line in lines
                     if not re.search(r'\b' + re.escape(job_id(line) or '') + r'\b', text)]
            kept[lane] = alive
            text += '\n' + '\n'.join(alive)
        flat = [line for lines in kept.values() for line in lines]
        if flat:
            base = read_text(queue)
            with queue.open('a') as stream:
                stream.write(('' if not base or base.endswith('\n') else '\n')
                             + '\n'.join(flat) + '\n')
        return kept


def log_events(events, gaps, kept):
    lines = ['%s SELF_SUPPLY %s free=%d added=%d\n'
             % (time.strftime('%F %T'), lane, info['free'], len(kept.get(lane, [])))
             for lane, info in gaps.items() if info.get('free', 0) > 0]
    if lines:
        with events.open('a') as stream:
            stream.writelines(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--dry-run', action='store_true', help='print JSON without writing (default)')
    mode.add_argument('--apply', action='store_true', help='append planned lines under ready.lock')
    parser.add_argument('--cap', type=int, default=CAP, help='maximum lines per run (default: 12)')
    parser.add_argument('--queue', type=Path, default=RUNS / 'queue/router-queue.md')
    parser.add_argument('--ready', type=Path, default=RUNS / 'queue/ready.tsv',
                        help='claimed rows; ids here also count as present')
    parser.add_argument('--status', type=Path, default=RUNS / 'queue/status.json')
    parser.add_argument('--hold', type=Path, default=RUNS / 'HOLD')
    parser.add_argument('--events', type=Path, default=RUNS / 'dispatch-events.log')
    parser.add_argument('--feeds-dir', type=Path, default=HERE,
                        help='directory holding the feed scripts (default: beside this script)')
    parser.add_argument('--feed-timeout', type=float, default=120, help='seconds per feed call (default: 120)')
    parser.add_argument('--lock-timeout', type=float, default=10, help='seconds to wait on ready.lock (default: 10)')
    args = parser.parse_args()
    if (args.cap < 0 or not math.isfinite(args.feed_timeout) or args.feed_timeout < 0
            or not math.isfinite(args.lock_timeout) or args.lock_timeout < 0):
        parser.error('--cap, --feed-timeout and --lock-timeout must be nonnegative and finite')
    try:
        gaps = lane_gaps(read_json(args.status), set(read_text(args.hold).split()))
        queue_text = read_text(args.queue) + '\n' + read_text(args.ready)
        planned, feed_status, skipped = supply(gaps, args.feeds_dir, args.queue,
                                               queue_text, args.cap, args.feed_timeout)
        kept = planned
        if args.apply:
            if any(planned.values()):
                before = sum(len(v) for v in planned.values())
                kept = append_locked(args.queue, planned, args.lock_timeout)
                skipped['duplicate'] += before - sum(len(v) for v in kept.values())
            try:
                log_events(args.events, gaps, kept)
            except OSError:
                pass     # the append already landed; a missing log dir never fails the run
        print(json.dumps({
            'schemaVersion': 1, 'dryRun': not args.apply, 'cap': args.cap,
            'lanes': {lane: dict(info, added=len(kept.get(lane, []))) for lane, info in gaps.items()},
            'feeds': feed_status, 'skipped': skipped,
            'added': sum(len(v) for v in kept.values()),
            'lines': [line for lines in kept.values() for line in lines]}))
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({'schemaVersion': 1, 'error': type(error).__name__,
                          'message': 'Self-supply failed; no plan applied.'}))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
