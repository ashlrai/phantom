#!/usr/bin/env python3
"""Serially drain a coordinator-local queue with the existing one-job worker.

Each round runs host_queue_worker.py (at most one claim); the drain stops on the
first nonzero worker outcome, --max-jobs, or the overall --deadline. Only
aggregate counts and a stop reason are reported; payloads and receipts stay
inside the worker.
"""

import argparse
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from types import SimpleNamespace

import host_queue
import host_queue_worker

WORKER = str(Path(__file__).with_name('host_queue_worker.py'))
FAILURES = ('timeout', 'lease lost', 'worker failed', 'launch failed',
            'worker interrupted or coordinator failure')


def paused(path):
    # Stat errors (including sandbox denial) must NOT look unpaused.
    try:
        os.lstat(path)
        return True
    except FileNotFoundError:
        return False
    except OSError:
        return True


def spawn(argv):
    return subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            start_new_session=True, text=True)


def child_groups(pid):
    # Payload children are session leaders, so each child pid is also a group id.
    try:
        out = subprocess.run(['pgrep', '-P', str(pid)], capture_output=True,
                             text=True, timeout=5)
    except (OSError, subprocess.SubprocessError, ValueError):
        return []
    return [int(p) for p in out.stdout.split()]


def stop_worker(proc, clock, sleep):
    """Stop the worker's whole subtree: its own cleanup first, then SIGKILL sweeps."""
    if proc.poll() is not None:
        return
    groups = child_groups(proc.pid)
    try:
        proc.terminate()  # SIGTERM lets the worker run stop_group on its payload group.
    except ProcessLookupError:
        return
    end = clock() + 3
    while proc.poll() is None and clock() < end:
        sleep(min(0.02, max(0.0, end - clock())))
    if proc.poll() is None:
        # Still parented to a stuck worker that cannot run its own cleanup.
        groups += child_groups(proc.pid)
        host_queue_worker.stop_group(proc)  # SIGKILL the worker's group and verify
    for leader in groups:
        try:
            os.killpg(leader, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    end, pending = clock() + 2, set(groups)
    while pending and clock() < end:
        sleep(min(0.02, max(0.0, end - clock())))
        for leader in list(pending):
            try:
                os.killpg(leader, 0)
            except (ProcessLookupError, PermissionError):
                pending.discard(leader)


def run(args, clock=time.monotonic, sleep=time.sleep, spawn=spawn):
    stats = SimpleNamespace(attempted=0, completed=0, failed=0, killed=0,
                            idle=0, paused=0, reason='deadline', status=0)
    end = clock() + args.deadline
    try:
        while True:
            remaining = end - clock()
            if remaining <= 0:
                break
            if stats.attempted >= args.max_jobs:
                stats.reason = 'max-jobs'
                break
            if args.pause_file and paused(args.pause_file):
                stats.paused += 1
                sleep(min(args.idle, remaining))
                continue
            grant = min(args.runtime, int(remaining))
            if grant < 1:
                break  # too little time left to own a job
            argv = [sys.executable, WORKER, '--db', args.db, '--host', args.host,
                    '--lease', str(args.lease), '--runtime', str(grant), '--', *args.command]
            proc = None
            try:
                proc = spawn(argv)
                while proc.poll() is None:
                    remaining = end - clock()
                    if remaining <= 0:
                        stats.attempted += 1
                        stats.killed += 1
                        stats.status = 1
                        stop_worker(proc, clock, sleep)
                        break
                    sleep(min(0.05, remaining))
            finally:
                if proc is not None and proc.poll() is None and stats.status == 0:
                    stats.attempted += 1
                    stats.killed += 1
                    stop_worker(proc, clock, sleep)
            if stats.status:
                break  # 'deadline' (or an exception is propagating)
            try:
                line = proc.stdout.readline().strip() if proc.stdout else ''
            except (OSError, ValueError):
                line = ''
            if proc.returncode == 0 and line == 'empty':
                stats.idle += 1
                sleep(min(args.idle, max(0.0, end - clock())))
                continue
            stats.attempted += 1
            if proc.returncode == 0 and line == 'success':
                stats.completed += 1
                continue
            stats.failed += 1
            stats.status = 1
            stats.reason = ('worker protocol error' if proc.returncode == 0
                            else line if line in FAILURES else 'worker failed')
            break
    except KeyboardInterrupt:
        stats.reason = 'interrupted'
        stats.status = 1
    return stats


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--db', required=True, help='coordinator-local SQLite database')
    p.add_argument('--host', required=True, type=host_queue.identifier)
    p.add_argument('--lease', type=host_queue.positive, default=30, help='claim lease seconds (1-86400)')
    p.add_argument('--runtime', type=host_queue.positive, default=300, help='per-job runtime seconds (1-86400)')
    p.add_argument('--max-jobs', type=host_queue.positive, default=64, help='stop after this many attempted jobs')
    p.add_argument('--deadline', type=host_queue.positive, default=3600, help='overall seconds including idle')
    p.add_argument('--idle', type=host_queue.positive, default=5, help='seconds between empty or paused polls')
    p.add_argument('--pause-file', help='sentinel path: present means do not claim')
    p.add_argument('command', nargs=argparse.REMAINDER, help='literal worker argv after --')
    args = p.parse_args()
    if not args.command or args.command[0] != '--' or len(args.command) < 2:
        p.error('provide a literal worker argv after --')
    args.command = args.command[1:]

    def interrupted(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    try:
        stats = run(args)
    except (OSError, ValueError, OverflowError, KeyboardInterrupt):
        print('drain reason=interrupted')
        return 1
    print('drain attempted=%d completed=%d failed=%d killed=%d idle=%d paused=%d reason=%s'
          % (stats.attempted, stats.completed, stats.failed, stats.killed,
             stats.idle, stats.paused, stats.reason.replace(' ', '-')))
    return stats.status


if __name__ == '__main__':
    sys.exit(main())
