#!/usr/bin/env python3
"""Bounded foreground wait for one remote queued job via a trusted transport.

--coordinator-argv names the bounded JSON argv file remote_queue_submit uses;
this host never opens coordinator SQLite and writes no SSH config. Each poll
sends {"action":"status","job":...} on the transport's stdin — never argv —
through submit's bounded exchange, capped by the time left on one monotonic
--deadline. Never enqueues, claims, renews, completes, releases, withdraws,
recovers or retries. Output: one JSON line with state, generation, polls and a
static reason — never reply text, argv, payload or receipts."""

import argparse
import json
import signal
import sys
import threading
import time

import host_queue_wait
import remote_queue_submit as submit

STATES = host_queue_wait.STATES  # queued, claimed, completed, uncertain
# Same terminal codes as host_queue_wait; code 6 is transport unreachable here.
COMPLETED, DEADLINE, UNCERTAIN, MISSING, TRANSPORT, MALFORMED = 0, 3, 4, 5, 6, 7
REASONS = {
    COMPLETED: 'completed',
    DEADLINE: 'deadline exceeded before completion',
    UNCERTAIN: 'job uncertain; recovery needs explicit operator action',
    MISSING: 'job not found',
    TRANSPORT: 'transport or coordinator unreachable',
    MALFORMED: 'malformed coordinator response',
}


class Stop(Exception):
    """Terminal observation; carries its exit code and static reason only."""

    def __init__(self, code, reason=None):
        super().__init__(code)
        self.code, self.reason = code, reason or REASONS[code]


class Cancelled(KeyboardInterrupt):
    """Signal mid-wait; a KeyboardInterrupt so an in-flight submit.exchange
    still runs its transport process-group cleanup before re-raising."""

    def __init__(self, signum):
        super().__init__()
        self.signum = signum


def cancel(signum, _frame):
    raise Cancelled(signum)


def report(code, state, generation, polls, reason=None):
    result = {'state': state, 'polls': polls,
              'reason': reason or REASONS.get(code, 'wait failed')}
    if generation is not None:
        result['generation'] = generation
    return code, result


def observe(program, request, budget, exchange):
    """One status round-trip capped to budget; returns (state, generation)."""
    try:
        reply = exchange(program, request, budget)
    except submit.SubmitError as failure:
        text = str(failure)
        if text == 'request timed out':
            raise Stop(DEADLINE)
        raise Stop(MALFORMED if text in ('response exceeds limit', 'invalid response')
                   else TRANSPORT)
    if reply['ok'] is False:
        # 'job not found' is the only absence signal; other rejections are anomalous.
        raise Stop(MISSING if reply.get('error') == 'job not found' else MALFORMED)
    state, generation = reply.get('state'), reply.get('generation')
    if state not in STATES or type(generation) is not int or generation < 0:
        raise Stop(MALFORMED)
    return state, generation


def wait(program, job, deadline, interval, clock=None, sleep=None, exchange=None):
    """Poll until a terminal outcome; returns (exit_code, bounded result)."""
    clock, sleep = clock or time.monotonic, sleep or time.sleep
    exchange = exchange or submit.exchange
    request = json.dumps({'action': 'status', 'job': job},
                         separators=(',', ':')).encode()
    limit, polls = clock() + deadline, 0
    state = generation = None
    try:
        while True:
            remaining = limit - clock()
            if remaining <= 0:
                return report(DEADLINE, state, generation, polls)
            polls += 1
            state, generation = observe(program, request, remaining, exchange)
            if state in ('completed', 'uncertain'):
                code = COMPLETED if state == 'completed' else UNCERTAIN
                return report(code, state, generation, polls)
            if limit - clock() <= 0:
                return report(DEADLINE, state, generation, polls)
            sleep(min(interval, limit - clock()))
    except Stop as stop:
        if stop.code == MISSING:
            state = generation = None
        return report(stop.code, state, generation, polls, stop.reason)
    except Cancelled as cancelled:
        return report(128 + cancelled.signum, state, generation, polls,
                      'cancelled by signal')
    except KeyboardInterrupt:
        return report(128 + signal.SIGINT, state, generation, polls,
                      'cancelled by signal')


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__, epilog=(
        'Exit: 0 completed, 3 deadline, 4 uncertain, 5 job not found, 6 '
        'transport/coordinator unreachable, 7 malformed response, 1 invalid '
        'argv or input failure, 130/143 SIGINT/SIGTERM. Example argv file: '
        '["ssh","fake-coordinator","python3","/opt/phantom/scripts/mac-bridge/'
        'host_queue_stdio.py","--db","/var/local/phantom/queue.sqlite"]. Status '
        'requests travel on stdin only; no mutation is ever sent.'))
    bounded = host_queue_wait.bounded_seconds
    parser.add_argument('--coordinator-argv', required=True,
                        help='bounded JSON file: one nonempty literal argv array')
    parser.add_argument('--job', required=True, type=host_queue_wait.job_id,
                        help='job identity to wait for')
    parser.add_argument('--deadline', required=True, type=bounded(
        host_queue_wait.MIN_DEADLINE, host_queue_wait.MAX_DEADLINE),
        help='total seconds covering all transports and delays (0.001-86400)')
    parser.add_argument('--interval', required=True, type=bounded(
        host_queue_wait.MIN_INTERVAL, host_queue_wait.MAX_INTERVAL),
        help='seconds between status polls (0.1-3600)')
    return parser.parse_args(argv)


def main(argv=None, out=None):
    args = parse_args(argv)
    out = out or sys.stdout
    previous = {}
    if threading.current_thread() is threading.main_thread():  # signals: main only
        for sig in (signal.SIGINT, signal.SIGTERM):
            previous[sig] = signal.signal(sig, cancel)
    try:
        try:
            try:
                program = submit.load_argv(args.coordinator_argv)
            except submit.SubmitError:
                code, result = 1, {'state': None, 'polls': 0,
                                   'reason': 'invalid coordinator argv'}
            else:
                code, result = wait(program, args.job, args.deadline, args.interval)
        except Cancelled as cancelled:
            code, result = report(128 + cancelled.signum, None, None, 0,
                                  'cancelled by signal')
        except KeyboardInterrupt:
            code, result = report(128 + signal.SIGINT, None, None, 0,
                                  'cancelled by signal')
        except (OSError, ValueError, OverflowError):
            code, result = 1, {'state': None, 'polls': 0, 'reason': 'wait failed'}
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    print(json.dumps(result, separators=(',', ':')), file=out, flush=True)
    return code


if __name__ == '__main__':
    sys.exit(main())
