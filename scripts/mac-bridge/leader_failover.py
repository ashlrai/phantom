#!/usr/bin/env python3
"""Foreground, local-coordinator leader supervisor; preview unless --apply is set."""
import argparse
import fcntl
import multiprocessing
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import time

import host_lease
import state_snapshot


class Stopped(Exception):
    pass


class Failure(Exception):
    pass


cancelled = False


def cancel(_signum, _frame):
    global cancelled
    cancelled = True


def worker(conn, operation, args):
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    try:
        if operation == 'restore':
            result = state_snapshot.restore(args[0], args[1], True)
        else:
            result = host_lease.run(args)
        conn.send(result)
    except Exception:
        conn.send(None)
    finally:
        conn.close()


def call(operation, args, timeout, interruptible=True):
    """Bound even a blocked SQLite transaction or snapshot operation."""
    ctx = multiprocessing.get_context('fork')
    receive, send = ctx.Pipe(duplex=False)
    process = ctx.Process(target=worker, args=(send, operation, args), daemon=True)
    process.start()
    send.close()
    end = time.monotonic() + max(0, timeout)
    try:
        while time.monotonic() < end:
            if interruptible and cancelled:
                raise Stopped()
            if receive.poll(min(0.05, max(0, end - time.monotonic()))):
                try:
                    result = receive.recv()
                except EOFError:
                    break
                if result is not None:
                    return result
                break
            if not process.is_alive():
                break
        raise Failure()
    finally:
        if process.is_alive():
            process.terminate()
        process.join(timeout=0.2)
        if process.is_alive():
            process.kill()
            process.join()
        receive.close()


def lease(args, action, fencing=None, timeout=1, interruptible=True):
    request = argparse.Namespace(db=args.db, action=action, role=args.role,
                                 host=args.host, primary=args.primary, ttl=args.ttl,
                                 grace=args.grace, fencing=fencing)
    return call('lease', request, timeout, interruptible)


def stop_group(child, grace):
    # The unreaped group leader reserves its PID until after all group signals.
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    end = time.monotonic() + grace
    while time.monotonic() < end:
        time.sleep(min(0.02, end - time.monotonic()))
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait()


def exited(child):
    # Do not reap here: the PID must remain reserved until group cleanup.
    return os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None


def supervise(args):
    deadline = time.monotonic() + args.duration
    fence, child, root_fd = None, None, None
    budget = min(1.0, args.ttl / 4)
    stop_grace = min(0.25, args.ttl / 8)
    try:
        for attempt in range(args.attempts):
            if cancelled:
                raise Stopped()
            start = time.monotonic()
            # Finish the bounded acquire to retain its fence even if cancelled.
            result = lease(args, 'acquire', timeout=min(budget, deadline - start),
                           interruptible=False)
            if result['ok']:
                fence = result['fencing']
                if cancelled:
                    raise Stopped()
                break
            if result.get('error') not in ('lease held', 'within primary grace'):
                raise Failure()
            if attempt + 1 == args.attempts or time.monotonic() >= deadline:
                print('standby')
                return 0
            while time.monotonic() < min(deadline, start + args.retry_interval):
                if cancelled:
                    raise Stopped()
                time.sleep(0.05)
        if fence is None:
            raise Failure()
        # Directory lock is held through restore and child cleanup. All supervisors
        # sharing a root must use this protocol; acquire it before any restore.
        root_fd = os.open(args.restore_root, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        fcntl.flock(root_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        restore_limit = min(deadline, start + args.ttl - stop_grace) - time.monotonic()
        if not call('restore', (args.snapshot, args.restore_root), restore_limit)['ok']:
            raise Failure()
        # A restore can consume the lease. Renew before launching and calculate
        # a conservative local expiry from the start of the coordinator call.
        start = time.monotonic()
        if not lease(args, 'renew', fence, min(budget, deadline - start))['ok']:
            raise Failure()
        expires = start + args.ttl
        if cancelled or time.monotonic() >= min(deadline, expires - stop_grace - budget):
            raise Stopped()
        child = subprocess.Popen(args.command, start_new_session=True, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print('leader', flush=True)
        renew_at = start + args.ttl / 4
        while True:
            now = time.monotonic()
            if cancelled:
                raise Stopped()
            if exited(child):
                return 0
            if now >= deadline:
                return 0
            if now >= expires - stop_grace - budget:
                raise Failure()
            if now >= renew_at:
                start = now
                result = lease(args, 'renew', fence,
                               min(budget, deadline - now, expires - stop_grace - now))
                if not result['ok']:
                    raise Failure()
                expires = start + args.ttl
                renew_at = start + args.ttl / 4
            else:
                time.sleep(min(0.05, renew_at - now, deadline - now))
    except Stopped:
        print('stopped')
        return 1
    except (Failure, OSError, ValueError, KeyError):
        print('supervisor failed', file=sys.stderr)
        return 1
    finally:
        if child is not None:
            stop_group(child, stop_grace)
        released = fence is None
        if fence is not None:
            for _ in range(2):
                try:
                    result = lease(args, 'release', fence, budget, interruptible=False)
                    released = result['ok'] or result.get('error') == 'not the lease holder'
                    if released:
                        break
                except (Failure, OSError):
                    pass
        if root_fd is not None:
            os.close(root_fd)
        if not released:
            print('lease release failed; expiry is the fallback', file=sys.stderr)
            return 1


def bounded(low, high):
    def parse(value):
        try:
            number = int(value)
            if low <= number <= high:
                return number
        except ValueError:
            pass
        raise argparse.ArgumentTypeError(f'must be an integer from {low} to {high}')
    return parse


def main():
    p = argparse.ArgumentParser(description=__doc__, epilog='The SQLite DB must be on local disk.')
    p.add_argument('--db', required=True)
    p.add_argument('--host', required=True, type=host_lease.identifier)
    p.add_argument('--primary', required=True, type=host_lease.identifier)
    p.add_argument('--role', required=True, type=host_lease.identifier)
    p.add_argument('--ttl', type=bounded(2, 300), default=30)
    p.add_argument('--grace', type=bounded(0, 300), default=30)
    p.add_argument('--duration', type=bounded(1, 3600), default=60)
    p.add_argument('--attempts', type=bounded(1, 100), default=1)
    p.add_argument('--retry-interval', type=bounded(1, 60), default=1)
    p.add_argument('--snapshot', required=True)
    p.add_argument('--restore-root', required=True)
    p.add_argument('--apply', action='store_true')
    p.add_argument('command', nargs=argparse.REMAINDER)
    args = p.parse_args()
    if not args.command or args.command[0] != '--' or len(args.command) < 2:
        p.error('child command must follow --')
    args.command = args.command[1:]
    root = Path(args.restore_root)
    try:
        if (root.is_symlink() or not root.is_dir() or not shutil.which(args.command[0])
                or not Path(args.db).parent.is_dir() or Path(args.db).is_dir()):
            raise ValueError()
        args.restore_root = str(root.resolve(strict=True))
        check = state_snapshot.restore(args.snapshot, args.restore_root, False)
        if not check['ok']:
            raise ValueError()
    except (OSError, ValueError, state_snapshot.SnapshotError):
        print('invalid snapshot or restore root', file=sys.stderr)
        return 1
    if not args.apply:
        print('preview')
        return 0
    signal.signal(signal.SIGINT, cancel)
    signal.signal(signal.SIGTERM, cancel)
    return supervise(args)


if __name__ == '__main__':
    sys.exit(main())
