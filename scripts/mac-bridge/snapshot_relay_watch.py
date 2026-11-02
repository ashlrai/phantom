#!/usr/bin/env python3
"""Bounded foreground watcher that keeps a standby snapshot publication current.

snapshot_relay performs one verified transfer and exits; this watcher calls
snapshot_relay.relay serially -- one transfer at a time, never overlapping --
every --interval seconds until --max-cycles, --deadline, or SIGINT/SIGTERM ends
the run. Idle time is an interruptible wait, so a signal stops the watcher
promptly between transfers; a signal that lands during a transfer lets that
transfer finish under the relay's atomic staging/pointer contract, then stops
the loop. Preview stays the default: without --apply every cycle is a dry run
that writes nothing; --apply performs the transfers. A failed cycle
(verification, lock or copy) leaves the prior destination pointer untouched
through the relay's own cleanup path, and a later cycle can still succeed.
Each cycle emits one bounded metadata line -- cycle number, outcome, and the
relayed generation's name and file count; never file contents or receipt
material -- followed by a single aggregate line with completed/noop/failed
counts and the stop reason. Exit status is nonzero if any cycle failed.
Filesystem directories only; no installation, SSH, network setup or machine
changes.
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

import snapshot_relay

TOOL = 'snapshot_relay_watch'
SCHEMA = 'ashlr.snapshot-relay-watch.v1'
MIN_INTERVAL, MAX_INTERVAL = 0.1, 3600.0
MIN_DEADLINE, MAX_DEADLINE = 0.1, 86400.0
MAX_CYCLES = 10000

EXAMPLE = """\
example with fake directories:
    mkdir -p /tmp/fake-fleet/queue /tmp/fake-fleet/leader /tmp/fake-fleet/metrics \\
        /tmp/fake-snaps /tmp/fake-standby
    python3 snapshot_publish.py --root /tmp/fake-fleet --destination /tmp/fake-snaps --once
    python3 snapshot_relay_watch.py --source /tmp/fake-snaps \\
        --destination /tmp/fake-standby --interval 5 --deadline 60
    python3 snapshot_relay_watch.py --source /tmp/fake-snaps \\
        --destination /tmp/fake-standby --interval 5 --deadline 60 --max-cycles 4 --apply
"""


def build_parser():
    parser = argparse.ArgumentParser(
        description=__doc__, epilog=EXAMPLE,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--source', required=True, type=Path,
                        help='existing snapshot_publish destination to read')
    parser.add_argument('--destination', required=True, type=Path,
                        help='existing standby publication directory; must not nest --source')
    parser.add_argument('--apply', action='store_true',
                        help='perform each transfer; default is a preview that writes nothing')
    parser.add_argument('--interval', type=float, default=60.0,
                        help=f'seconds between transfers, {MIN_INTERVAL:g}..{MAX_INTERVAL:g} (default 60)')
    parser.add_argument('--deadline', type=float, default=3600.0,
                        help='seconds of total foreground lifetime, '
                             f'{MIN_DEADLINE:g}..{MAX_DEADLINE:g} (default 3600)')
    parser.add_argument('--max-cycles', type=int, default=None, metavar='N',
                        help=f'run at most N transfers, 1..{MAX_CYCLES} (default unbounded)')
    return parser


def cycle_record(index, at, apply, call, source, destination):
    """One bounded metadata line for a single serial relay invocation."""
    record = {'schema': SCHEMA, 'cycle': index, 'at': int(at),
              'apply': apply, 'outcome': 'failed'}
    try:
        result = call(source, destination, apply)
    except KeyboardInterrupt:
        return record, 'failed', True
    except Exception:
        return record, 'failed', False
    if isinstance(result, dict) and result.get('ok') is True:
        record['outcome'] = 'noop' if result.get('noop') else 'completed'
        generation, files = result.get('generation'), result.get('files')
        if isinstance(generation, str):
            record['generation'] = generation
        if type(files) is int and files >= 0:
            record['files'] = files
        if apply and result.get('copied') is True:
            record['copied'] = True
    return record, record['outcome'], False


def main(argv=None, deps=None, out=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if not math.isfinite(args.interval) \
            or not MIN_INTERVAL <= args.interval <= MAX_INTERVAL:
        parser.error(f'--interval must be between {MIN_INTERVAL:g} and {MAX_INTERVAL:g} seconds')
    if not math.isfinite(args.deadline) \
            or not MIN_DEADLINE <= args.deadline <= MAX_DEADLINE:
        parser.error(f'--deadline must be between {MIN_DEADLINE:g} and {MAX_DEADLINE:g} seconds')
    if args.max_cycles is not None and not 1 <= args.max_cycles <= MAX_CYCLES:
        parser.error(f'--max-cycles must be between 1 and {MAX_CYCLES}')
    deps = deps or {}
    out = out or sys.stdout
    stop = deps.get('stop') or threading.Event()
    wait = deps.get('wait') or stop.wait
    now = deps.get('now') or time.time
    call = deps.get('relay') or snapshot_relay.relay
    os.umask(0o077)

    previous = {}

    def cancel(_signum, _frame):
        stop.set()

    # Python only permits signal handlers on the main thread.
    if threading.current_thread() is threading.main_thread():
        for sig in (signal.SIGINT, signal.SIGTERM):
            previous[sig] = signal.signal(sig, cancel)

    counts = {'completed': 0, 'noop': 0, 'failed': 0}
    cycles, reason = 0, 'stopped'
    end = now() + args.deadline
    try:
        while not stop.is_set():
            if now() >= end:
                reason = 'deadline'
                break
            cycles += 1
            record, outcome, halt = cycle_record(
                cycles, now(), args.apply, call, args.source, args.destination)
            counts[outcome] += 1
            print(json.dumps(record, separators=(',', ':')), file=out, flush=True)
            if halt or stop.is_set():
                reason = 'stopped'
                break
            if args.max_cycles is not None and cycles >= args.max_cycles:
                reason = 'max-cycles'
                break
            remaining = end - now()
            if remaining <= 0:
                reason = 'deadline'
                break
            try:
                signaled = wait(min(args.interval, remaining))
            except KeyboardInterrupt:
                signaled = True
            if signaled:
                reason = 'stopped'
                break
    except Exception as exc:
        reason = 'error'
        print(f'{TOOL}: internal error ({type(exc).__name__})', file=sys.stderr)
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    aggregate = {'tool': TOOL,
                 'ok': counts['failed'] == 0 and reason != 'error',
                 'apply': args.apply, 'cycles': cycles, **counts,
                 'stopReason': reason}
    print(json.dumps(aggregate, separators=(',', ':')), file=out, flush=True)
    return 0 if aggregate['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
