#!/usr/bin/env python3
"""Bounded foreground wait for one queued job; reads coordinator status only, never mutates it."""

import argparse
import json
import math
import os
import signal
import sqlite3
import sys
import time
from types import SimpleNamespace

import host_queue

MIN_DEADLINE = 0.001
MAX_DEADLINE = 86400
MIN_INTERVAL = 0.1
MAX_INTERVAL = 3600
STATES = frozenset(('queued', 'claimed', 'completed', 'uncertain'))

# One distinct nonzero code per terminal outcome; cancellation follows the shell convention 128+signal.
COMPLETED, DEADLINE, UNCERTAIN, MISSING, INACCESSIBLE, MALFORMED = 0, 3, 4, 5, 6, 7
REASONS = {
    COMPLETED: 'completed',
    DEADLINE: 'deadline exceeded before completion',
    UNCERTAIN: 'job uncertain; recovery needs explicit operator action',
    MISSING: 'job not found',
    INACCESSIBLE: 'coordinator inaccessible',
    MALFORMED: 'malformed coordinator response',
}


class Stop(Exception):
    """A terminal observation; carries its exit code and static reason only."""

    def __init__(self, code, reason=None):
        super().__init__(code)
        self.code = code
        self.reason = reason or REASONS[code]


class Cancelled(Exception):
    def __init__(self, signum):
        super().__init__(signum)
        self.signum = signum


def bounded_seconds(low, high):
    def parse(value):
        try:
            number = float(value)
        except ValueError:
            number = math.nan
        if not math.isfinite(number) or not low <= number <= high:
            raise argparse.ArgumentTypeError(f'must be a finite number from {low:g} to {high:g}')
        return number
    return parse


def job_id(value):
    try:
        return host_queue.identifier(value)
    except ValueError:
        raise argparse.ArgumentTypeError('invalid job identity')


def observe(db, job):
    """One status request through the existing coordinator operation; returns (state, generation)."""
    try:
        response = host_queue.run(SimpleNamespace(action='status', db=db, job=job))
    except (OSError, sqlite3.Error):
        raise Stop(INACCESSIBLE)
    except (ValueError, OverflowError):
        raise Stop(MALFORMED)
    if not isinstance(response, dict):
        raise Stop(MALFORMED)
    if response.get('ok') is False:
        if response.get('error') == 'job not found':
            raise Stop(MISSING)
        raise Stop(MALFORMED)
    state, generation = response.get('state'), response.get('generation')
    if response.get('ok') is not True or state not in STATES or type(generation) is not int or generation < 0:
        raise Stop(MALFORMED)
    return state, generation


def report(code, state, generation, polls, reason=None):
    result = {'state': state}
    if generation is not None:
        result['generation'] = generation
    result.update(polls=polls, reason=reason or REASONS[code])
    return code, result


def wait(db, job, deadline, interval, clock=time.monotonic, sleep=time.sleep, observe=observe):
    """Poll until completed, uncertain, terminal failure, deadline or cancellation.

    Returns (exit_code, result); the result never carries payload, token, command or raw error text.
    """
    limit = clock() + deadline
    polls = 0
    state = generation = None
    try:
        while True:
            polls += 1
            state, generation = observe(db, job)
            if state in ('completed', 'uncertain'):
                return report(COMPLETED if state == 'completed' else UNCERTAIN, state, generation, polls)
            remaining = limit - clock()
            if remaining <= 0:
                return report(DEADLINE, state, generation, polls)
            sleep(min(interval, remaining))
    except Stop as stop:
        if stop.code == MISSING:
            state = generation = None
        return report(stop.code, state, generation, polls, stop.reason)
    except Cancelled as cancelled:
        return report(128 + cancelled.signum, state, generation, polls, 'cancelled by signal')


def cancel(signum, frame):
    raise Cancelled(signum)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, epilog=(
        'Fake-coordinator example, run over existing trusted SSH with no transport setup: '
        'ssh fake-coordinator python3 /opt/phantom/scripts/mac-bridge/host_queue_wait.py '
        '--db /var/local/phantom/queue.sqlite --job example-job --deadline 600 --interval 2. '
        'Local check: python3 scripts/mac-bridge/host_queue_wait.py --db /tmp/fake/queue.sqlite '
        '--job example-job --deadline 30 --interval 1. Exit: 0 completed, 3 deadline exceeded, '
        '4 uncertain, 5 job not found, 6 coordinator inaccessible, 7 malformed response, '
        '130/143 SIGINT/SIGTERM. Never recovers, releases or requeues.'))
    parser.add_argument('--db', required=True, help='coordinator local SQLite database path')
    parser.add_argument('--job', required=True, type=job_id, help='job identity to wait for')
    parser.add_argument('--deadline', required=True, type=bounded_seconds(MIN_DEADLINE, MAX_DEADLINE),
                        help='total wait seconds, finite, 0.001 to 86400')
    parser.add_argument('--interval', required=True, type=bounded_seconds(MIN_INTERVAL, MAX_INTERVAL),
                        help='seconds between status polls, finite, 0.1 to 3600')
    args = parser.parse_args(argv)
    if not os.path.isfile(args.db):
        # Status would create an empty database; a missing coordinator store is inaccessible, not an empty queue.
        code, result = INACCESSIBLE, {'state': None, 'polls': 0, 'reason': REASONS[INACCESSIBLE]}
    else:
        previous = {s: signal.signal(s, cancel) for s in (signal.SIGINT, signal.SIGTERM)}
        try:
            code, result = wait(args.db, args.job, args.deadline, args.interval)
        finally:
            for s, handler in previous.items():
                signal.signal(s, handler)
    print(json.dumps(result, separators=(',', ':')), flush=True)
    return code


if __name__ == '__main__':
    sys.exit(main())
