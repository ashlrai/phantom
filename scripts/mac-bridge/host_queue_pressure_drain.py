#!/usr/bin/env python3
"""Serially drain a coordinator-local queue through the pressure-aware worker.

Each round spawns queue_pressure_worker.py with a fresh admission gate and a
deadline capped to the remaining overall budget: a job is claimed only while
telemetry is healthy and its claim owner stays supervised. Empty queue is a
bounded idle wait; blocked telemetry waits inside the outer budget; a failed
or uncertain outcome stops the drain without recovery or retry. Only
aggregate counts and a stop reason are reported — payloads, receipt tokens
and command contents never appear in drain output.
"""

import argparse
import io
import math
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time
from types import SimpleNamespace

import host_queue
import host_queue_worker
import memory_admission
import pressure_worker
import queue_pressure_worker

WRAPPER = str(Path(__file__).with_name('queue_pressure_worker.py'))
FAILURES = ('timeout', 'lease lost', 'worker failed', 'launch failed',
            'worker interrupted or coordinator failure')
OUTCOME_LIMIT = 4096   # bytes; the outcome protocol is one short line
OUTCOME_WAIT = 5.0     # seconds to collect an exited child's outcome
MIN_GRANT = 1.0        # never claim with under a second of budget left


def spawn(argv):
    return subprocess.Popen(argv, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, start_new_session=True)


def stop_wrapper(proc, grace, clock, sleep):
    """SIGTERM lets the wrapper's own cleanup reap its supervised tree.

    A wedged wrapper falls back to a kill of its own group plus a SIGKILL
    sweep over every descendant session it left behind.
    """
    if proc.poll() is not None:
        return
    groups = set()
    try:  # descendant groups below the wrapper; never its own group
        groups = set(queue_pressure_worker.descendant_groups(proc.pid))
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    try:
        proc.terminate()
    except ProcessLookupError:
        return
    end = clock() + grace
    while proc.poll() is None and clock() < end:
        sleep(min(0.02, max(0.0, end - clock())))
    if proc.poll() is None:
        try:
            groups |= set(queue_pressure_worker.descendant_groups(proc.pid))
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
        host_queue_worker.stop_group(proc)  # SIGKILL the wrapper's own group
    for group in groups:
        try:
            os.killpg(group, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    end, pending = clock() + 2, set(groups)
    while pending and clock() < end:
        sleep(min(0.02, max(0.0, end - clock())))
        for group in list(pending):
            try:
                os.killpg(group, 0)
            except (ProcessLookupError, PermissionError):
                pending.discard(group)


def outcome_line(proc, clock, sleep):
    """First stdout line of an exited child; bounded in bytes and wait.

    A stray descendant holding the pipe open cannot stall the drain, and
    long output is truncated rather than buffered.
    """
    stream = proc.stdout
    if stream is None:
        return ''
    try:
        fd = stream.fileno()
    except (AttributeError, io.UnsupportedOperation):
        return str(stream.readline())[:OUTCOME_LIMIT].strip()
    end, data = clock() + OUTCOME_WAIT, bytearray()
    try:
        while len(data) <= OUTCOME_LIMIT:
            left = end - clock()
            if left <= 0 or not select.select([fd], (), (), left)[0]:
                break
            chunk = os.read(fd, min(4096, OUTCOME_LIMIT + 1 - len(data)))
            if not chunk:
                break
            data += chunk
            if b'\n' in chunk:
                break
    except (OSError, ValueError):
        pass
    finally:
        try:
            stream.close()
        except (OSError, ValueError):
            pass
    return bytes(data).split(b'\n', 1)[0].decode('utf-8', 'replace').strip()


def run(args, clock=time.monotonic, sleep=time.sleep, spawn=spawn):
    """Serial bounded drain; clock/sleep/spawn are test seams."""
    stats = SimpleNamespace(attempted=0, completed=0, failed=0, killed=0,
                            idle=0, blocked=0, reason='deadline', status=0)
    end = clock() + args.deadline
    grace = args.term_grace_seconds + 4.0  # wrapper term grace + reap + slack
    try:
        while True:
            remaining = end - clock()
            if remaining < MIN_GRANT:
                break  # too little left to own and supervise a claim
            if stats.attempted >= args.max_jobs:
                stats.reason = 'max-jobs'
                break
            proc = None

            def kill():  # count and reap a still-live wrapper
                stats.attempted += 1
                stats.killed += 1
                stats.status = 1
                stop_wrapper(proc, grace, clock, sleep)

            argv = [sys.executable, WRAPPER,
                    '--db', args.db, '--host', args.host,
                    '--lease', str(args.lease), '--runtime', str(args.runtime),
                    '--metrics', str(args.metrics),
                    '--max-age-seconds', str(args.max_age_seconds),
                    '--state-dir', str(args.state_dir),
                    '--pause-file', str(args.pause_file),
                    '--receipt-dir', str(args.receipt_dir),
                    '--job', args.job,
                    '--poll-seconds', str(args.poll_seconds),
                    '--healthy-samples', str(args.healthy_samples),
                    '--launch-wait-seconds', str(args.launch_wait_seconds),
                    '--deadline-seconds', str(remaining),
                    '--max-paused-seconds', str(args.max_paused_seconds),
                    '--term-grace-seconds', str(args.term_grace_seconds),
                    '--', *args.command]
            try:
                proc = spawn(argv)
                while proc.poll() is None:
                    remaining = end - clock()
                    if remaining <= 0:
                        kill()
                        break
                    sleep(min(0.05, remaining))
            finally:
                if proc is not None and proc.poll() is None and stats.status == 0:
                    kill()
            line = outcome_line(proc, clock, sleep)
            if stats.status:
                break  # 'deadline' (or an exception is propagating)
            code = proc.returncode
            if code == 75:
                # Telemetry gate held: budget consumed, never a claim.
                stats.blocked += 1
            elif code == 0 and line == 'empty':
                stats.idle += 1
            elif code == 0 and line == 'success':
                stats.attempted += 1
                stats.completed += 1
                continue
            else:
                stats.attempted += 1
                stats.failed += 1
                stats.status = 1
                if code == 0:
                    stats.reason = 'worker protocol error'
                elif code == 124:
                    stats.reason = 'deadline'
                elif code == 71:
                    stats.reason = 'pause-budget-exhausted'
                elif code in (70, 127):
                    stats.reason = 'launch failed'
                elif code >= 128:
                    stats.reason = 'cancelled'
                else:
                    stats.reason = (line if line in FAILURES
                                    else 'worker failed')
                break
            sleep(min(args.idle, max(0.0, end - clock())))
    except KeyboardInterrupt:
        stats.reason = 'interrupted'
        stats.status = 1
    except (OSError, ValueError, subprocess.SubprocessError):
        stats.reason = 'launch failed'
        stats.status = 1
    return stats


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--db', required=True, help='coordinator-local SQLite database')
    p.add_argument('--host', required=True, type=host_queue.identifier)
    p.add_argument('--metrics', type=Path, required=True,
                   help='memguard metrics JSON')
    p.add_argument('--state-dir', type=Path, required=True,
                   help='shared memory-admission state directory')
    p.add_argument('--pause-file', type=Path,
                   default=memory_admission.defaults()[1])
    p.add_argument('--receipt-dir', type=Path, required=True,
                   help='private directory for wrapper receipts')
    p.add_argument('--job', default='queue', help='admission job label')
    p.add_argument('command', nargs=argparse.REMAINDER,
                   help='literal job argv after --')
    for name, kind, default in [
            ('--max-age-seconds', float, None),  # stale = unavailable
            ('--max-paused-seconds', float, None),  # exhaustion exits 71
            ('--poll-seconds', float, pressure_worker.POLL_SECONDS),
            ('--healthy-samples', int, pressure_worker.HEALTHY_SAMPLES),
            ('--launch-wait-seconds', float,
             pressure_worker.LAUNCH_WAIT_SECONDS),
            ('--term-grace-seconds', float,
             pressure_worker.TERM_GRACE_SECONDS),
            ('--lease', host_queue.positive, 30),
            ('--runtime', host_queue.positive, 300),
            ('--deadline', host_queue.positive, 3600),  # monotonic overall
            ('--max-jobs', host_queue.positive, 64),  # attempted jobs cap
            ('--idle', host_queue.positive, 5)]:  # empty/blocked wait
        p.add_argument(name, type=kind, default=default,
                       required=default is None)
    args = p.parse_args(sys.argv[1:] if argv is None else argv)
    if not args.command or args.command[0] != '--' or len(args.command) < 2:
        p.error('provide a literal worker argv after --')
    args.command = args.command[1:]
    timings = [args.max_age_seconds, args.poll_seconds,
               args.launch_wait_seconds, args.max_paused_seconds,
               args.term_grace_seconds]
    if (any(not math.isfinite(v) or v <= 0 for v in timings)
            or args.healthy_samples < 1
            or not memory_admission.IDENTIFIER.fullmatch(args.job)):
        p.error('invalid timing, sample or job configuration')

    def interrupted(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    try:
        stats = run(args)
    except (OSError, ValueError, OverflowError, KeyboardInterrupt):
        print('drain reason=interrupted')
        return 1
    print('drain attempted=%d completed=%d failed=%d killed=%d idle=%d '
          'blocked=%d reason=%s'
          % (stats.attempted, stats.completed, stats.failed, stats.killed,
             stats.idle, stats.blocked, stats.reason.replace(' ', '-')))
    return stats.status


if __name__ == '__main__':
    sys.exit(main())
