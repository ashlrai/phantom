#!/usr/bin/env python3
"""Pause/resume wrapper for one owned heavy worker under host memory pressure.

SIGSTOP freezes the owned process group but does NOT release resident memory:
paused pages stay attributed and keep occupying RAM or compressed swap. A
pause only removes the worker's CPU and I/O pressure so interactive GUI apps
stay responsive; when real memory must return, the caller must terminate the
workload. Only the group this wrapper created is ever signalled: never a
discovered PID, its parent group, a GUI app, or a command-name match. Global
newest-worker selection belongs to a future monitor; this is the safe
actuator for workers it owns.
"""

import argparse
import json
import math
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time
import uuid

# Bands follow contrib/mac/memguard rules and memory_admission.py.
CRITICAL_FREE_PERCENT = 10.0   # below: SIGSTOP the owned group
WARNING_FREE_PERCENT = 25.0    # below: hold new launches (memguard free-hard)
CRITICAL_PRESSURE_LEVEL = 4    # kern.memorystatus_vm_pressure_level critical
WARNING_PRESSURE_LEVEL = 2     # XNU warn level
MAX_SWAP_USED_BYTES = 8 * 1024 ** 3  # memory_admission MAX_SWAP
HEALTHY_SAMPLES = 3
POLL_SECONDS = 1.0
LAUNCH_WAIT_SECONDS = 30.0
TERM_GRACE_SECONDS = 5.0
REAP_SECONDS = 2.0
MAX_METRICS_BYTES = 65536


def _number(value, lo=None, hi=None, integer=False):
    bad = isinstance(value, bool) or not isinstance(value, (int, float)) or \
        not math.isfinite(value) or (lo is not None and value < lo) or \
        (hi is not None and value > hi) or (integer and not float(value).is_integer())
    return None if bad else (int(value) if integer else float(value))


def parse_metrics(text):
    row = json.loads(text)
    if not isinstance(row, dict):
        raise ValueError('invalid metrics')
    free = _number(row.get('freeMemoryPercent'), 0, 100)
    swap = _number(row.get('swapUsedBytes'), 0)
    pressure = None if 'pressureLevel' not in row else _number(row['pressureLevel'], 0, integer=True)
    if free is None or swap is None or ('pressureLevel' in row and pressure is None):
        raise ValueError('invalid metrics')
    return {'free': free, 'swap': swap, 'pressure': pressure}


def read_sample(path, max_age_seconds):
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_METRICS_BYTES:
        raise ValueError('invalid metrics file')
    if time.time() - info.st_mtime > max_age_seconds:
        raise ValueError('stale metrics')
    return parse_metrics(path.read_text())


def classify(sample):
    pressure, free, swap = sample['pressure'], sample['free'], sample['swap']
    if (pressure is not None and pressure >= CRITICAL_PRESSURE_LEVEL) or \
            free < CRITICAL_FREE_PERCENT or swap >= MAX_SWAP_USED_BYTES:
        return 'critical'
    if (pressure is not None and pressure >= WARNING_PRESSURE_LEVEL) or \
            free < WARNING_FREE_PERCENT:
        return 'moderate'
    return 'healthy'


def probe(path, max_age_seconds):
    try:
        return classify(read_sample(path, max_age_seconds))
    except (OSError, ValueError):
        return 'unavailable'


def atomic_json(path, value):
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temporary.open('x', encoding='utf8') as handle:
            os.chmod(temporary, 0o600)
            json.dump(value, handle, allow_nan=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def private_directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('receipt directory must be private and owned by this user')


def run(command, metrics_path, max_age_seconds, receipt_dir, *, poll=POLL_SECONDS,
        healthy_samples=HEALTHY_SAMPLES, launch_wait=LAUNCH_WAIT_SECONDS,
        deadline=None, term_grace=TERM_GRACE_SECONDS):
    """Launch command under pressure control; return its propagated exit code.

    75 = launch blocked by telemetry, 124 = caller deadline, 128+sig = cancelled.
    """
    metrics_path, receipt_dir = Path(metrics_path), Path(receipt_dir)
    private_directory(receipt_dir)
    receipt = receipt_dir / (uuid.uuid4().hex + '.json')
    record = {'schemaVersion': 1, 'wrapperPid': os.getpid(), 'pgid': None,
              'state': 'waiting', 'reason': None, 'startedAt': time.time(),
              'updatedAt': time.time(), 'endedAt': None, 'returncode': None}
    child, stopped, handlers = None, [], {}

    def update(state, reason=None):
        record.update(state=state, reason=reason, updatedAt=time.time())
        atomic_json(receipt, record)

    def finish(state, reason, code):
        record.update(endedAt=time.time(), returncode=code)
        update(state, reason)
        return code

    def stop(signum, _frame):
        stopped.append(signum)

    def signal_group(sig):  # the only signal path: this wrapper's own group
        try:
            os.killpg(child.pid, sig)
        except (ProcessLookupError, PermissionError):
            pass

    def terminate(grace):
        if child is None or child.poll() is not None:
            return
        # A stopped group cannot act on TERM: always continue it first.
        signal_group(signal.SIGCONT)
        signal_group(signal.SIGTERM)
        try:
            child.wait(timeout=grace)
            return
        except subprocess.TimeoutExpired:
            pass
        signal_group(signal.SIGKILL)
        try:
            child.wait(timeout=REAP_SECONDS)
        except subprocess.TimeoutExpired:
            print('pressure-worker: reap timeout; group may outlive the wrapper',
                  file=sys.stderr, flush=True)

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        handlers[sig] = signal.signal(sig, stop)
    try:
        end = None if deadline is None else time.monotonic() + deadline
        limit = time.monotonic() + launch_wait
        if end is not None:
            limit = min(limit, end)
        state, healthy_run = 'unavailable', 0
        while healthy_run < healthy_samples:
            state = probe(metrics_path, max_age_seconds)
            healthy_run = healthy_run + 1 if state == 'healthy' else 0
            if stopped or healthy_run >= healthy_samples:
                break
            update('waiting', state)
            now = time.monotonic()
            if now >= limit:
                break
            time.sleep(min(poll, max(0.01, limit - now)))
        if stopped:
            return finish('cancelled', f'signal-{stopped[0]}', 128 + stopped[0])
        if healthy_run < healthy_samples:
            print(f'pressure-worker: launch blocked ({state})', file=sys.stderr, flush=True)
            return finish('blocked', state, 75)
        try:
            child = subprocess.Popen(list(command), start_new_session=True)
        except FileNotFoundError:
            return finish('launch-error', 'not-found', 127)
        try:
            foreign = os.getpgid(child.pid) != child.pid
        except ProcessLookupError:
            foreign = False
        if foreign and child.poll() is None:
            child.kill()  # own child PID only, never killpg on a foreign group
            child.wait()
            return finish('launch-error', 'process-group-mismatch', 70)
        record['pgid'] = child.pid
        update('running')
        paused, healthy_run, terminating = False, 0, None
        while True:
            now = time.monotonic()
            if stopped and terminating is None:
                terminating = ('cancelled', f'signal-{stopped[0]}', 128 + stopped[0])
            if terminating is None and end is not None and now >= end:
                terminating = ('deadline', 'deadline-exceeded', 124)
            if terminating is not None:
                update('terminating', terminating[1])
                terminate(term_grace)
                return finish(*terminating)
            code = child.poll()
            if code is not None:
                return finish('finished', None, 128 - code if code < 0 else code)
            state = probe(metrics_path, max_age_seconds)
            if state in ('critical', 'unavailable'):
                healthy_run = 0
                if not paused:
                    signal_group(signal.SIGSTOP)
                    paused = True
                    update('paused', state)
                    print(f'pressure-worker: paused owned group ({state})',
                          file=sys.stderr, flush=True)
            elif state == 'healthy':
                healthy_run += 1
                if paused and healthy_run >= healthy_samples:
                    signal_group(signal.SIGCONT)
                    paused = False
                    update('running', 'resumed')
                    print('pressure-worker: resumed owned group', file=sys.stderr, flush=True)
            else:
                healthy_run = 0
            wait = poll if end is None else min(poll, max(0.01, end - now))
            time.sleep(max(wait, 0.01))
    finally:
        terminate(term_grace)  # never orphan a stopped group
        for sig, handler in handlers.items():
            signal.signal(sig, handler)


def main(argv=None):
    raw = list(sys.argv[1:] if argv is None else argv)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--metrics', type=Path, required=True,
                        help='memguard metrics JSON (e.g. ~/.ashlr-runs/memguard.json)')
    parser.add_argument('--max-age-seconds', type=float, required=True,
                        help='metrics older than this count as unavailable')
    parser.add_argument('--receipt-dir', type=Path,
                        default=Path('~/.ashlr-runs/pressure-workers').expanduser())
    parser.add_argument('--poll-seconds', type=float, default=POLL_SECONDS)
    parser.add_argument('--healthy-samples', type=int, default=HEALTHY_SAMPLES,
                        help='consecutive healthy samples before launch/resume')
    parser.add_argument('--launch-wait-seconds', type=float, default=LAUNCH_WAIT_SECONDS)
    parser.add_argument('--deadline-seconds', type=float, default=None,
                        help='optional caller deadline over launch wait plus runtime')
    parser.add_argument('--term-grace-seconds', type=float, default=TERM_GRACE_SECONDS)
    # Split at -- so child options are never interpreted or echoed by argparse.
    divider = raw.index('--') if '--' in raw else len(raw)
    args = parser.parse_args(raw[:divider])
    command = raw[divider + 1:]
    if not command:
        parser.error('a command after -- is required')
    timings = [args.max_age_seconds, args.poll_seconds, args.launch_wait_seconds,
               args.term_grace_seconds]
    if args.deadline_seconds is not None:
        timings.append(args.deadline_seconds)
    if any(not math.isfinite(v) or v <= 0 for v in timings) or args.healthy_samples < 1:
        raise ValueError('invalid timing or sample configuration')
    return run(command, args.metrics, args.max_age_seconds, args.receipt_dir,
               poll=args.poll_seconds, healthy_samples=args.healthy_samples,
               launch_wait=args.launch_wait_seconds, deadline=args.deadline_seconds,
               term_grace=args.term_grace_seconds)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.SubprocessError):
        # Exceptions can include argv or arbitrary filesystem contents.
        print('pressure-worker: invalid configuration or unavailable host telemetry',
              file=sys.stderr)
        sys.exit(70)
