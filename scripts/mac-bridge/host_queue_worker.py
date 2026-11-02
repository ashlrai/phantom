#!/usr/bin/env python3
"""Run at most one coordinator-local queue job with an explicitly supplied program."""

import argparse
import base64
import json
import os
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace

import host_queue


def queue(db, action, **kwargs):
    return host_queue.run(SimpleNamespace(db=db, action=action, **kwargs))


def stop_group(process):
    # The leader may have exited while descendants are still running.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()
    end = time.monotonic() + 2
    while True:
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            return True
        if time.monotonic() >= end:
            return False
        time.sleep(0.02)


def run(args):
    started = time.monotonic()
    cwd = getattr(args, 'cwd', None)
    if cwd is not None:
        if not cwd:
            return 'invalid cwd', 1
        cwd = os.path.realpath(cwd)
        if not os.path.isdir(cwd):
            return 'invalid cwd', 1
    claim = queue(args.db, 'claim', host=args.host, ttl=args.lease)['claim']
    if claim is None:
        return 'empty', 0
    deadline = started + args.lease
    # Queue receipts are private, short-lived files; never put them in argv or output.
    with tempfile.TemporaryDirectory(prefix='host-queue-worker-') as private:
        receipt = os.path.join(private, 'receipt')
        fd = os.open(receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as handle:
            json.dump({k: claim[k] for k in ('job', 'host', 'token', 'generation')}, handle)
        with tempfile.TemporaryFile() as payload:
            payload.write(base64.b64decode(claim['payload_base64'], validate=True))
            payload.seek(0)
            if time.monotonic() >= deadline:
                return 'lease lost', 1
            try:
                child = subprocess.Popen(args.command, stdin=payload, stdout=subprocess.DEVNULL,
                                         stderr=subprocess.DEVNULL, start_new_session=True, cwd=cwd)
            except OSError:
                result = queue(args.db, 'release', receipt=receipt)
                return ('launch failed', 1) if result['ok'] else ('lease lost', 1)
            outcome = 'worker failed'
            try:
                runtime_end = time.monotonic() + args.runtime
                next_renew = started + args.lease / 3
                pending = None
                while True:
                    now = time.monotonic()
                    if now >= deadline:
                        outcome = 'lease lost'
                        break
                    if now >= runtime_end:
                        outcome = 'timeout'
                        break
                    if pending is not None and not pending[0].is_alive():
                        thread, result, renewal_start = pending
                        thread.join()
                        pending = None
                        if not result or not result[0].get('ok'):
                            outcome = 'lease lost'
                            break
                        deadline = renewal_start + args.lease
                        next_renew = renewal_start + args.lease / 3
                        continue
                    if child.poll() is not None and pending is None:
                        if child.returncode == 0:
                            outcome = 'success'
                        break
                    if pending is None and now >= next_renew:
                        result = []
                        def renew():
                            try:
                                result.append(queue(args.db, 'renew', receipt=receipt, ttl=args.lease))
                            except (OSError, ValueError, sqlite3.Error):
                                pass
                        thread = threading.Thread(target=renew, daemon=True)
                        pending = (thread, result, now)
                        thread.start()
                    time.sleep(min(0.05, max(0, deadline - now), max(0, runtime_end - now)))
            finally:
                stopped = stop_group(child)
            if not stopped and outcome == 'success':
                outcome = 'worker failed'
            if outcome == 'success':
                if time.monotonic() >= deadline or not queue(args.db, 'complete', receipt=receipt)['ok']:
                    outcome = 'lease lost'
            return outcome, 0 if outcome == 'success' else 1


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--db', required=True, help='coordinator-local SQLite database')
    p.add_argument('--host', required=True, type=host_queue.identifier)
    p.add_argument('--lease', type=host_queue.positive, default=30, help='lease seconds (1-86400)')
    p.add_argument('--runtime', type=host_queue.positive, default=300, help='maximum runtime seconds (1-86400)')
    p.add_argument('--cwd', help='operator-selected checkout directory for the worker process')
    p.add_argument('command', nargs=argparse.REMAINDER, help='literal worker argv after --')
    args = p.parse_args()
    if not args.command or args.command[0] != '--' or len(args.command) < 2:
        p.error('provide a literal worker argv after --')
    args.command = args.command[1:]
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    try:
        outcome, status = run(args)
    except (OSError, ValueError, sqlite3.Error, OverflowError, KeyboardInterrupt):
        outcome, status = 'worker interrupted or coordinator failure', 1
    print(outcome)
    return status


if __name__ == '__main__':
    sys.exit(main())
