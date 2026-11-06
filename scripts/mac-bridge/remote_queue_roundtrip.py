#!/usr/bin/env python3
"""Submit one Phantom drop and wait for its completion in one bounded command.

Usage:
  remote_queue_roundtrip.py --drop-dir DIR --job RQ-PHX-XXX \\
      --coordinator-argv FILE --deadline SECONDS --interval SECONDS [--apply]

Preview (the default) validates the drop, job name and argv file, then exits
without spawning a transport. --apply submits exactly once through
remote_queue_submit, and polls through remote_queue_wait only after submission
reports submitted. One monotonic --deadline (0.001-86400 s) covers submission
transport time and waiting alike. --interval (0.1-3600 s) sets the gap between
status polls. existing-unverified (a job name already exists, exit 2) and every
other unconfirmed submission exit without polling, retrying or claiming. SIGINT
and SIGTERM stop the in-flight transport group and produce one terminal result.
Output: one JSON line of fixed metadata (phase, state, exit, reason, polls).
Payloads, argv, server text and receipts are never printed. Exit: 0 preview or
completed, 1 invalid input or rejected, 2 existing-unverified, 3 deadline,
4 uncertain, 5 job not found, 6 transport, 7 malformed, 128+signal cancelled.
"""

import argparse
import json
import signal
import sys
import threading
import time
from types import SimpleNamespace

import host_queue_wait
import remote_queue_submit as submit
import remote_queue_wait as watch

TOOL = 'remote_queue_roundtrip'
INVALID = 1
DEADLINE, TRANSPORT, MALFORMED = watch.DEADLINE, watch.TRANSPORT, watch.MALFORMED
# Checked before any exchange, so nothing was sent and no transport ran.
VALIDATION = frozenset(('invalid job name', 'invalid coordinator argv',
                        'invalid drop directory', 'invalid or unstable drop',
                        'request exceeds limit'))
# Submit failure text → (exit, state). An unread reply leaves the enqueue unknown.
SUBMIT_FAILURES = {
    'request rejected': (INVALID, 'rejected'),
    'request timed out': (DEADLINE, 'unconfirmed'),
    'response exceeds limit': (MALFORMED, 'unconfirmed'),
    'invalid response': (MALFORMED, 'unconfirmed'),
    'transport failed to start': (TRANSPORT, 'unconfirmed'),
    'transport failed': (TRANSPORT, 'unconfirmed'),
    'transport or coordinator failed': (TRANSPORT, 'unconfirmed'),
}


def submit_args(args, apply, timeout=None):
    """Namespace in the shape remote_queue_submit.run consumes."""
    return SimpleNamespace(drop_dir=args.drop_dir, job=args.job,
                           coordinator_argv=args.coordinator_argv,
                           request_timeout=timeout, apply=apply)


def roundtrip(args, progress, clock=time.monotonic, sleep=time.sleep, status=None):
    """(exit_code, body); progress records the phase a cancellation lands in."""
    limit = clock() + args.deadline  # one total budget: submit transport and waits
    try:
        program = submit.load_argv(args.coordinator_argv)
        submit.run(submit_args(args, apply=False))  # drop, job and argv; no spawn
    except submit.SubmitError as exc:
        return INVALID, {'phase': 'validate', 'state': 'invalid', 'reason': str(exc)}
    if not args.apply:
        return 0, {'phase': 'validate', 'state': 'preview'}
    remaining = limit - clock()
    if remaining <= 0:  # deadline spent before any enqueue: nothing was sent
        return DEADLINE, {'phase': 'submit', 'state': 'not-submitted',
                          'reason': 'deadline exceeded before submission'}
    progress.update(phase='submit', state='unconfirmed')
    try:
        result, code = submit.run(submit_args(args, apply=True, timeout=remaining))
    except submit.SubmitError as exc:
        text = str(exc)
        if text in VALIDATION:  # drop changed since preview; still nothing sent
            return INVALID, {'phase': 'validate', 'state': 'invalid', 'reason': text}
        code, state = SUBMIT_FAILURES.get(text, (TRANSPORT, 'unconfirmed'))
        return code, {'phase': 'submit', 'state': state, 'reason': text}
    if result['result'] != 'submitted':  # existing-unverified: never poll it
        return code, {'phase': 'submit', 'state': result['result']}
    progress['state'] = 'submitted'
    code, waited = watch.wait(program, args.job, limit - clock(), args.interval,
                              clock=clock, sleep=sleep, exchange=status)
    return code, {'phase': 'wait', **waited}


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    bounded = host_queue_wait.bounded_seconds
    parser.add_argument('--drop-dir', required=True, help='directory holding the drop file')
    parser.add_argument('--job', required=True, type=host_queue_wait.job_id,
                        help='RQ-PHX job name, no .md extension')
    parser.add_argument('--coordinator-argv', required=True,
                        help='bounded JSON file: one nonempty literal argv array')
    parser.add_argument('--deadline', required=True, type=bounded(
        host_queue_wait.MIN_DEADLINE, host_queue_wait.MAX_DEADLINE),
        help='total seconds covering submission transport and waiting (0.001-86400)')
    parser.add_argument('--interval', required=True, type=bounded(
        host_queue_wait.MIN_INTERVAL, host_queue_wait.MAX_INTERVAL),
        help='seconds between status polls (0.1-3600)')
    parser.add_argument('--apply', action='store_true',
                        help='submit once, then wait; default preview spawns nothing')
    return parser.parse_args(argv)


def main(argv=None, out=None):
    args = parse_args(argv)
    out = out or sys.stdout
    progress = {'phase': 'validate', 'state': 'invalid'}
    previous = {}
    if threading.current_thread() is threading.main_thread():  # signals: main only
        for sig in (signal.SIGINT, signal.SIGTERM):
            previous[sig] = signal.signal(sig, watch.cancel)
    try:
        try:
            code, body = roundtrip(args, progress)
        except watch.Cancelled as cancelled:  # raised outside wait's own handler
            code, body = 128 + cancelled.signum, {**progress, 'reason': 'cancelled by signal'}
        except (OSError, ValueError, OverflowError):
            code, body = INVALID, {**progress, 'reason': 'roundtrip failed'}
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    result = {'tool': TOOL, 'ok': code == 0, 'apply': args.apply, 'job': args.job,
              'exit': code, **body}
    print(json.dumps(result, separators=(',', ':')), file=out, flush=True)
    return code


if __name__ == '__main__':
    sys.exit(main())
