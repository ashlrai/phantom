#!/usr/bin/env python3
"""Run at most one shared-queue job through an explicitly supplied transport.

Each coordinator call runs the --coordinator-argv array once (shell=False):
one host_queue_stdio request on stdin, one bounded JSON response on stdout,
under a per-call deadline. The argv comes from a bounded JSON file, so
transport trust (e.g. an existing ssh alias) is provisioned outside: no host
discovery, no config mutation, and the SQLite DB is never opened here. A
lease grant covers only request_start + --lease seconds; returned expiry is
never trusted to extend that budget. Failed or ambiguous calls and lease
loss stop the worker subtree; uncertain work is never auto-released or
recovered. Tokens and payload bytes stay out of argv and output. Outcomes:
empty, success, worker failed, timeout, lease lost, launch failed,
claim failed, claim uncertain, claim unusable, release uncertain,
completion uncertain, interrupted.
"""

import argparse
import base64
import binascii
import json
import math
import os
import select
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time

import host_queue
import host_queue_stdio
import host_queue_worker

MAX_ARGV_FILE = 8192
MAX_ARGV_ITEMS = 64
MAX_ARGV_ITEM = 4096
CLAIM_KEYS = frozenset(('job', 'host', 'token', 'generation', 'expires', 'payload_base64'))


class Failed(Exception):
    """The coordinator proved the request was not applied."""


class Ambiguous(Exception):
    """The request may have been applied; the result cannot be proven."""


def load_argv(path):
    """Read a bounded JSON file holding a nonempty literal argv array."""
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_ARGV_FILE:
            raise ValueError('invalid coordinator argv file')
        argv = json.loads(handle.read(MAX_ARGV_FILE + 1))
    ok = (isinstance(argv, list) and 1 <= len(argv) <= MAX_ARGV_ITEMS
          and all(isinstance(i, str) and 0 < len(i) <= MAX_ARGV_ITEM for i in argv))
    if not ok:
        raise ValueError('invalid coordinator argv')
    return argv


def transport_call(argv, request, timeout, live, lock):
    """Send one stdio request; return a proven-ok envelope.

    Failed means the request provably was not applied; Ambiguous means it
    may have been. The transport process group is always reaped.
    """
    encoded = json.dumps(request, separators=(',', ':')).encode()
    if len(encoded) > host_queue_stdio.MAX_REQUEST:
        raise Failed('request exceeds transport limit')
    try:
        proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError:
        raise Failed('transport failed to launch')
    with lock:
        live.add(proc)
    try:
        deadline = time.monotonic() + timeout
        try:
            proc.stdin.write(encoded)
            proc.stdin.close()
        except OSError:
            pass
        buf = bytearray()
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise Ambiguous('transport exceeded deadline')
                if select.select([proc.stdout], [], [], min(0.05, remaining))[0]:
                    chunk = os.read(proc.stdout.fileno(),
                                    host_queue_stdio.MAX_RESPONSE + 1 - len(buf))
                    if not chunk:
                        break
                    buf += chunk
                    if len(buf) > host_queue_stdio.MAX_RESPONSE:
                        raise Ambiguous('response exceeds limit')
            proc.wait(timeout=max(0.0, deadline - time.monotonic()))
            result = json.loads(bytes(buf))
        except subprocess.TimeoutExpired:
            raise Ambiguous('transport did not exit')
        except (OSError, ValueError, RecursionError):
            raise Ambiguous('transport io failure')
        if not isinstance(result, dict) or type(result.get('ok')) is not bool:
            raise Ambiguous('response is not an envelope')
        if not result['ok']:
            raise Failed('request rejected')
        if proc.returncode != 0:
            raise Ambiguous('transport failed after reporting ok')
        return result
    finally:
        try:
            proc.stdout.close()
        except OSError:
            pass
        if proc.poll() is None:
            host_queue_worker.stop_group(proc)
        with lock:
            live.discard(proc)


def claim_fields(result, host):
    """Validate a claim envelope into (receipt, payload); None means empty.

    A payload of None means the receipt is provably ours but unusable:
    nothing may launch, so assert-stopped release is honest.
    """
    claim = result.get('claim')
    if claim is None:
        if 'claim' not in result:
            raise Ambiguous('missing claim field')
        return None
    if not isinstance(claim, dict) or set(claim) != CLAIM_KEYS:
        raise Ambiguous('claim shape mismatch')
    try:
        receipt = host_queue_stdio.receipt(
            {k: claim[k] for k in ('job', 'host', 'token', 'generation')})
    except (host_queue_stdio.Reject, KeyError):
        raise Ambiguous('claim receipt invalid')
    expires = claim.get('expires')
    if (receipt['host'] != host
            or type(expires) not in (int, float) or not math.isfinite(expires)):
        raise Ambiguous('claim fields invalid')
    payload = None
    if isinstance(claim.get('payload_base64'), str):
        try:
            data = base64.b64decode(claim['payload_base64'], validate=True)
            if 0 < len(data) <= host_queue.MAX_PAYLOAD:
                payload = data
        except (binascii.Error, ValueError):
            pass
    return receipt, payload


def release(call, receipt, timeout, released):
    """Requeue a claim we provably hold and provably never executed."""
    try:
        call({'action': 'release', 'receipt': receipt, 'assert-stopped': True}, timeout)
        return released
    except Failed:
        return 'lease lost'
    except Ambiguous:
        return 'release uncertain'


def renew(call, receipt, lease, timeout, budget, out):
    try:
        answer = call({'action': 'renew', 'receipt': receipt, 'ttl': lease},
                      min(timeout, budget))
        expires = answer.get('expires')
        out.append(type(expires) in (int, float) and math.isfinite(expires))
    except Exception:
        out.append(False)


def run(args):
    live, lock = set(), threading.Lock()

    def call(request, timeout):
        return transport_call(args.coordinator, request, timeout, live, lock)

    started = time.monotonic()
    try:
        result = call({'action': 'claim', 'host': args.host, 'ttl': args.lease},
                      args.request_timeout)
        fields = claim_fields(result, args.host)
    except Failed:
        return 'claim failed', None, 1
    except Ambiguous:
        return 'claim uncertain', None, 1
    if fields is None:
        return 'empty', None, 0
    deadline = started + args.lease
    receipt, payload = fields
    job = receipt['job']
    try:
        if payload is None:
            return release(call, receipt, args.request_timeout, 'claim unusable'), job, 1
        with tempfile.TemporaryFile() as stdin_file:
            stdin_file.write(payload)
            stdin_file.seek(0)
            if time.monotonic() >= deadline:
                return 'lease lost', job, 1
            try:
                child = subprocess.Popen(args.command, stdin=stdin_file,
                                         stdout=subprocess.DEVNULL,
                                         stderr=subprocess.DEVNULL,
                                         start_new_session=True)
            except OSError:
                return release(call, receipt, args.request_timeout,
                               'launch failed'), job, 1
            outcome, pending = 'worker failed', None
            try:
                runtime_end = time.monotonic() + args.runtime
                next_renew = started + args.lease / 3
                while True:
                    now = time.monotonic()
                    if now >= deadline:
                        outcome = 'lease lost'
                        break
                    if now >= runtime_end:
                        outcome = 'timeout'
                        break
                    if pending is not None and not pending[0].is_alive():
                        thread, result_list, renew_start = pending
                        thread.join()
                        pending = None
                        if not result_list or not result_list[0]:
                            outcome = 'lease lost'
                            break
                        deadline = renew_start + args.lease
                        next_renew = renew_start + args.lease / 3
                    if child.poll() is not None and pending is None:
                        if child.returncode == 0:
                            outcome = 'success'
                        break
                    if pending is None and now >= next_renew:
                        result_list = []
                        thread = threading.Thread(
                            target=renew, daemon=True,
                            args=(call, receipt, args.lease, args.request_timeout,
                                  max(0.1, deadline - now), result_list))
                        pending = (thread, result_list, now)
                        thread.start()
                    time.sleep(min(0.05, max(0.0, deadline - now),
                                   max(0.0, runtime_end - now)))
            finally:
                stopped = host_queue_worker.stop_group(child)
                for proc in list(live):
                    if proc.poll() is None:
                        host_queue_worker.stop_group(proc)
                if pending is not None:
                    pending[0].join(timeout=5)
            if not stopped and outcome == 'success':
                outcome = 'worker failed'
            if outcome == 'success':
                if time.monotonic() >= deadline:
                    outcome = 'lease lost'
                else:
                    try:
                        call({'action': 'complete', 'receipt': receipt},
                             min(args.request_timeout,
                                 max(0.1, deadline - time.monotonic())))
                    except Failed:
                        outcome = 'lease lost'
                    except Ambiguous:
                        outcome = 'completion uncertain'
            return outcome, job, 0 if outcome == 'success' else 1
    except (OSError, ValueError, OverflowError, KeyboardInterrupt):
        return 'interrupted', job, 1


def main():
    p = argparse.ArgumentParser(description=__doc__, epilog=(
        'Coordinator argv JSON example: ["ssh","coord","python3",'
        '"host_queue_stdio.py","--db","/var/queue.sqlite"]. It runs once '
        'per request; no SSH or host configuration is discovered or changed.'))
    p.add_argument('--host', required=True, type=host_queue.identifier)
    p.add_argument('--lease', type=host_queue.positive, default=30, help='claim lease seconds (1-86400)')
    p.add_argument('--runtime', type=host_queue.positive, default=300, help='max worker seconds (1-86400)')
    p.add_argument('--request-timeout', type=host_queue.positive, default=60,
                   help='per-call transport deadline seconds (1-86400)')
    p.add_argument('--coordinator-argv', required=True, metavar='JSON',
                   help='bounded JSON file holding a nonempty literal argv array')
    p.add_argument('command', nargs=argparse.REMAINDER, help='literal worker argv after --')
    args = p.parse_args()
    if not args.command or args.command[0] != '--' or len(args.command) < 2:
        p.error('provide a literal worker argv after --')
    args.command = args.command[1:]
    try:
        args.coordinator = load_argv(args.coordinator_argv)
    except (OSError, ValueError, RecursionError):
        p.error('--coordinator-argv must name a JSON file holding a nonempty argv array')

    def interrupted(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    try:
        outcome, job, status = run(args)
    except (OSError, ValueError, OverflowError, KeyboardInterrupt):
        outcome, job, status = 'interrupted', None, 1
    print('remote outcome=%s host=%s%s' % (outcome, args.host, ' job=' + job if job else ''))
    return status


if __name__ == '__main__':
    sys.exit(main())
