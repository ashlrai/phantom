#!/usr/bin/env python3
"""Pressure-guarded foreground publisher of verified fleet-state snapshots.

Opt-in wrapper around snapshot_publish.Publisher that yields to the
memory-pressure sentinel owned by pressure_watch.py. Before each cycle the
sentinel at --pause-file is lstat'd once: present (including a symlink) or
unreadable fails closed -- no staging, no latest.json write, no pruning;
absent runs exactly one existing Publisher.cycle, so verification,
free-space admission and pruning rules stay identical to the unguarded
publisher. The sentinel is never read, created, unlinked or altered.

Pause polls are interruptible (SIGINT/SIGTERM wake the wait; the publisher
lock closes on exit), consume the monotonic --deadline budget like every
other wait, and never consume --max-cycles, which bounds publication
attempts only. Publication resumes automatically when the sentinel clears,
so the last verified standby snapshot survives a pause. Output is metadata
only: per-cycle reports identical to snapshot_publish, one line per
pause/resume episode, and a bounded final summary. No child processes, no
shell, no GUI.
"""

import argparse
import json
import math
import os
from pathlib import Path
import signal
import sys
import threading
import time

import snapshot_publish

TOOL = 'snapshot_publish_guarded'
MIN_DEADLINE, MAX_DEADLINE = 0.1, 86400.0
MAX_CYCLES = 10000

EXAMPLE = """\
example with a fake fleet-state tree:
    python3 snapshot_publish_guarded.py --root /tmp/fake-fleet \\
        --destination /tmp/snaps --pause-file /tmp/pressure.pause \\
        --interval 30 --retain 3 --deadline 600 --max-cycles 10
"""


class Guarded:
    """Drives publisher.cycle() only while the pressure sentinel is absent.

    clock and wait are test seams: clock must be monotonic, wait(seconds)
    must return early once publisher.stop is set (the default waits on an
    event the signal handler sets).
    """

    def __init__(self, publisher, pause_file, deadline, *,
                 clock=time.monotonic, wait=None):
        if not math.isfinite(deadline) or deadline <= 0:
            raise ValueError('deadline must be a finite positive seconds value')
        self.publisher = publisher
        self.pause = Path(pause_file)
        self.deadline = deadline
        self.clock = clock
        self.wake = threading.Event()
        self.wait = wait if wait is not None else self.wake.wait
        self.paused = 0        # sentinel polls that skipped a cycle
        self.pausing = False   # inside a pause episode
        self.signal = None     # signum that stopped us, if any
        self.reason = None     # stop reason reported in the summary

    def blocked(self):
        """Fail-closed probe: present (even a symlink) or unreadable pauses."""
        try:
            os.lstat(self.pause)
            return True
        except FileNotFoundError:
            return False
        except OSError:
            return True

    def emit(self, payload):
        print(json.dumps({'tool': TOOL, **payload}, separators=(',', ':')),
              flush=True)

    def run(self, max_cycles=None):
        end = self.clock() + self.deadline
        interval = self.publisher.interval
        while not self.publisher.stop:
            now = self.clock()
            if now >= end:
                self.reason = 'deadline'
                break
            if self.blocked():
                self.paused += 1
                if not self.pausing:
                    self.pausing = True
                    self.emit({'state': 'paused'})
                self.wait(min(interval, end - now))
                continue
            if self.pausing:
                self.pausing = False
                self.emit({'state': 'resumed', 'paused': self.paused})
            self.emit(self.publisher.cycle())
            if max_cycles is not None and self.publisher.count >= max_cycles:
                self.reason = 'max-cycles'
                break
            self.wait(min(interval, end - self.clock()))
        if self.reason is None:
            if self.signal is not None:
                self.reason = f'signal-{self.signal}'
            elif self.publisher.stop:
                self.reason = 'stopped'
            else:
                self.reason = 'deadline'
        return self.publisher.published

    def summary(self):
        return {'tool': TOOL, 'attempted': self.publisher.count,
                'published': self.publisher.published, 'paused': self.paused,
                'endedPaused': self.pausing, 'stop': self.reason}


def build_parser():
    parser = argparse.ArgumentParser(
        description=__doc__, epilog=EXAMPLE,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--root', required=True, type=Path,
                        help='existing fleet-state directory to snapshot')
    parser.add_argument('--destination', required=True, type=Path,
                        help='existing trusted snapshot directory; must be outside --root')
    parser.add_argument('--pause-file', required=True, type=Path,
                        help='pressure_watch sentinel; presence pauses '
                             'publication (never read, never altered)')
    parser.add_argument('--interval', type=float, required=True,
                        help='seconds between sentinel polls and cycles, '
                             f'{snapshot_publish.MIN_INTERVAL:g}..'
                             f'{snapshot_publish.MAX_INTERVAL:g}')
    parser.add_argument('--retain', type=int, required=True,
                        help='prior generations kept per publication, '
                             f'{snapshot_publish.MIN_RETAIN}..'
                             f'{snapshot_publish.MAX_RETAIN}')
    parser.add_argument('--deadline', type=float, required=True,
                        help='overall monotonic budget in seconds covering '
                             f'publishing plus paused waiting, '
                             f'{MIN_DEADLINE:g}..{MAX_DEADLINE:g}')
    parser.add_argument('--max-cycles', type=int, default=None,
                        help=f'bound on publication attempts, 1..{MAX_CYCLES}; '
                             'paused polls never count (default unbounded)')
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if not math.isfinite(args.interval) \
            or not snapshot_publish.MIN_INTERVAL <= args.interval \
            <= snapshot_publish.MAX_INTERVAL:
        parser.error('--interval must be between '
                     f'{snapshot_publish.MIN_INTERVAL:g} and '
                     f'{snapshot_publish.MAX_INTERVAL:g} seconds')
    if not snapshot_publish.MIN_RETAIN <= args.retain \
            <= snapshot_publish.MAX_RETAIN:
        parser.error('--retain must be between '
                     f'{snapshot_publish.MIN_RETAIN} and '
                     f'{snapshot_publish.MAX_RETAIN}')
    if not math.isfinite(args.deadline) \
            or not MIN_DEADLINE <= args.deadline <= MAX_DEADLINE:
        parser.error(f'--deadline must be between {MIN_DEADLINE:g} and '
                     f'{MAX_DEADLINE:g} seconds')
    if args.max_cycles is not None \
            and not 1 <= args.max_cycles <= MAX_CYCLES:
        parser.error(f'--max-cycles must be between 1 and {MAX_CYCLES}')
    os.umask(0o077)
    try:
        publisher = snapshot_publish.Publisher(
            args.root, args.destination, args.interval, args.retain)
        lock = snapshot_publish.acquire_lock(publisher.dest)
        guarded = Guarded(publisher, args.pause_file, args.deadline)
    except (snapshot_publish.PublishError, OSError, ValueError) as exc:
        print(f'{TOOL}: {exc}', file=sys.stderr)
        return 1

    def halt(signum, _frame):
        publisher.stop = True
        guarded.signal = signum
        guarded.wake.set()

    signal.signal(signal.SIGINT, halt)
    signal.signal(signal.SIGTERM, halt)
    try:
        published = guarded.run(args.max_cycles)
    finally:
        os.close(lock)
    print(json.dumps(guarded.summary(), separators=(',', ':')), flush=True)
    return 0 if published else 1


if __name__ == '__main__':
    sys.exit(main())
