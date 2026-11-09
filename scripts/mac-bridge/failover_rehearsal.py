#!/usr/bin/env python3
"""Bounded fake-host failover rehearsal over the real lease/snapshot/supervisor path.

Creates its own TemporaryDirectory, mints fake primary/standby identities, builds
a tiny allow-listed state_snapshot, and runs real leader_failover.py supervisors
with a literal `python3 -c` dummy child. It verifies the primary alone leads
while the standby contends, interrupts the primary supervisor, waits for its
process group to stop and the fenced lease to become available, then proves the
standby takes over with the expected restored state -- inside one
--deadline-seconds wall budget (default 25, bounded 5-60). Report is JSON
metadata only (phase ok booleans, elapsed ms). Everything is temp-local: no real
hosts, services, ~/.ashlr-runs, or shared/network SQLite; lease fencing is never
bypassed. --preview lists the phase plan; no real-host apply mode exists. Exit 0
requires the full handoff; a missing takeover, overlapping dummy children,
cancellation, or a deadline breach exits 1 after every descendant is reaped.
"""
import argparse
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time

import host_lease
import leader_failover
import state_snapshot

SCHEMA = 'ashlr.failover-rehearsal.v1'
SUPERVISOR = Path(__file__).resolve().with_name('leader_failover.py')
ROLE, PRIMARY, STANDBY = 'rehearsal-leader', 'rehearsal-primary', 'rehearsal-standby'
TTL, GRACE, RETRY_INTERVAL = 4, 2, 1
CONTENTION_SECONDS, CLEANUP_GRACE = 0.5, 1.5
MIN_DEADLINE, DEFAULT_DEADLINE, MAX_DEADLINE = 5.0, 25.0, 60.0
PHASES = ('snapshot', 'primaryLeader', 'singleLeader', 'primaryStopped',
          'leaseFree', 'standbyLeader', 'restoredState')
FAKE_STATE = {'queue/router-queue.md': 'fake queue\n',
              'queue/ready.tsv': 'fake\tready\n',
              'leader/VISION.md': 'fake vision\n'}
DUMMY_CHILD = '''import os, pathlib, signal, sys, time
root = pathlib.Path(sys.argv[1])
started, stopped, quit = map(pathlib.Path, sys.argv[2:5])
def stop(*_):
    stopped.write_text(str(os.getpid()))
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
started.write_text(str(os.getpid()))
while not quit.exists(): time.sleep(0.02)
'''

cancelled = False


def cancel(_signum, _frame):
    global cancelled
    cancelled = True


def deadline_seconds(value):
    try:
        number = float(value)
    except ValueError:
        number = math.nan
    if not math.isfinite(number) or not MIN_DEADLINE <= number <= MAX_DEADLINE:
        raise argparse.ArgumentTypeError(
            'must be a finite number from %g to %g' % (MIN_DEADLINE, MAX_DEADLINE))
    return number


def build_parser():
    p = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        epilog='Invocation: python3 scripts/mac-bridge/failover_rehearsal.py '
               '--deadline-seconds 20 -- exits 0 only if the fake standby takes '
               'over inside the budget; --preview prints the phase plan.')
    p.add_argument('--deadline-seconds', type=deadline_seconds,
                   default=DEFAULT_DEADLINE, metavar='SECONDS',
                   help='total wall budget %g-%gs (default %g)'
                   % (MIN_DEADLINE, MAX_DEADLINE, DEFAULT_DEADLINE))
    p.add_argument('--preview', action='store_true',
                   help='print the phase plan and exit; nothing is spawned')
    return p


def child_argv(markers, host, root):
    """Literal `python3 -c` dummy child: records its pid, exits on quit/SIGTERM."""
    return [sys.executable, '-c', DUMMY_CHILD, str(root),
            str(markers / (host + '.started')),
            str(markers / (host + '.stopped')),
            str(markers / (host + '.quit'))]


def supervisor_argv(db, host, snapshot, root, duration, attempts, markers,
                    child_for):
    return [sys.executable, str(SUPERVISOR), '--db', str(db), '--host', host,
            '--primary', PRIMARY, '--role', ROLE, '--ttl', str(TTL),
            '--grace', str(GRACE), '--duration', str(int(duration)),
            '--attempts', str(attempts), '--retry-interval', str(RETRY_INTERVAL),
            '--snapshot', str(snapshot), '--restore-root', str(root), '--apply',
            '--'] + list(child_for(markers, host, root))


def read_pid(path):
    try:
        return int(path.read_text().split(':')[0])
    except (OSError, ValueError):
        return None


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, OSError):
        return False


def wait_until(pred, end, halted):
    while not halted():
        if pred():
            return True
        remaining = end - time.monotonic()
        if remaining <= 0:
            return False
        time.sleep(min(0.02, remaining))
    return False


def cleanup(markers, procs):
    """Terminate and reap every descendant; bounded even under blockage."""
    for host, proc in procs:
        try:
            (markers / (host + '.quit')).write_text('q')
        except OSError:
            pass
        if proc.poll() is None:
            try:
                proc.send_signal(signal.SIGTERM)
            except OSError:
                pass
    grace_end = time.monotonic() + CLEANUP_GRACE
    for host, proc in procs:
        try:
            proc.wait(timeout=max(0.0, grace_end - time.monotonic()))
        except subprocess.TimeoutExpired:
            try:
                leader_failover.stop_group(proc, 0.3)
            except Exception:
                pass
        if proc.stdout is not None:
            try:
                proc.stdout.close()
            except OSError:
                pass
        # A dummy child orphaned by a SIGKILLed supervisor is its own group
        # leader; its started marker records the pid.
        pid = read_pid(markers / (host + '.started'))
        for sig in (signal.SIGTERM, signal.SIGKILL):
            if pid is None or not pid_alive(pid):
                break
            try:
                os.killpg(pid, sig)
            except (ProcessLookupError, PermissionError, OSError):
                break
            kill_end = time.monotonic() + 0.4
            while pid_alive(pid) and time.monotonic() < kill_end:
                time.sleep(0.02)


def rehearse(args, deps):
    global cancelled
    cancelled = False
    stop = deps.get('stop')

    def stopped():
        return cancelled or (stop is not None and stop.is_set())

    popen = deps.get('popen') or subprocess.Popen
    child_for = deps.get('child_argv') or child_argv
    temp_factory = deps.get('tempdir') or (
        lambda: tempfile.TemporaryDirectory(prefix='failover-rehearsal-'))
    started = time.monotonic()
    end = started + args.deadline_seconds
    duration = int(args.deadline_seconds) + 2  # supervisor outlives our deadline
    attempts = min(100, max(4, duration))
    phases, procs, sup = {}, [], {}
    failed, overlap = None, False
    interrupted_at = takeover_at = None
    previous = {}
    if threading.current_thread() is threading.main_thread():
        for sig in (signal.SIGINT, signal.SIGTERM):
            previous[sig] = signal.signal(sig, cancel)
    try:
        with temp_factory() as temp:
            base = Path(temp)
            markers, roots = base / 'markers', base / 'roots'
            (roots / PRIMARY).mkdir(parents=True)
            (roots / STANDBY).mkdir()
            markers.mkdir()
            source, snapshot = base / 'source', base / 'snapshot'
            db = base / 'leases.sqlite'

            def marker(host, kind):
                return markers / (host + '.' + kind)

            def phase(name, fn):
                nonlocal failed
                tick = time.monotonic()
                try:
                    ok = bool(fn()) and not stopped()
                except Exception:
                    ok = False
                phases[name] = {'ok': ok,
                                'ms': int((time.monotonic() - tick) * 1000)}
                if not ok:
                    failed = failed or name
                return ok

            def spawn_supervisor(host):
                env = dict(os.environ)
                env.pop('HOST_LEASE_CLOCK_FILE', None)  # real clock only
                proc = popen(supervisor_argv(
                    db, host, snapshot, roots / host, duration, attempts,
                    markers, child_for), stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    start_new_session=True, text=True, env=env)
                procs.append((host, proc))
                sup[host] = proc

            def lead(host):
                if host not in sup:
                    spawn_supervisor(host)
                proc = sup[host]
                return wait_until(lambda: marker(host, 'started').exists()
                                  or proc.poll() is not None, end, stopped) \
                    and proc.poll() is None \
                    and marker(host, 'started').exists()

            def make_snapshot():
                for rel, text in FAKE_STATE.items():
                    path = source / rel
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(text)
                state_snapshot.create(source, snapshot)
                return state_snapshot.verify_snapshot(snapshot)['ok']

            def single_leader():
                # Spawn the contending standby; fencing must keep it from leading.
                nonlocal overlap
                spawn_supervisor(STANDBY)
                until = min(end, time.monotonic() + CONTENTION_SECONDS)
                while time.monotonic() <= until:
                    if marker(STANDBY, 'started').exists():
                        overlap = True
                        return False
                    if sup[PRIMARY].poll() is not None or stopped():
                        return False
                    time.sleep(min(0.02, max(0.0, until - time.monotonic())))
                return sup[STANDBY].poll() is None

            def stop_primary():
                nonlocal interrupted_at, overlap
                try:
                    sup[PRIMARY].send_signal(signal.SIGTERM)
                except OSError:
                    pass
                interrupted_at = time.monotonic()
                while time.monotonic() < end:
                    if marker(STANDBY, 'started').exists():
                        overlap = True
                        return False
                    pid = read_pid(marker(PRIMARY, 'started'))
                    if sup[PRIMARY].poll() is not None and (
                            marker(PRIMARY, 'stopped').exists()
                            or (pid is not None and not pid_alive(pid))):
                        return True
                    if stopped():
                        return False
                    time.sleep(0.02)
                return False

            def lease_free():
                def available():
                    try:
                        st = host_lease.run(argparse.Namespace(
                            db=str(db), action='status', role=ROLE, host=None,
                            primary=None, ttl=TTL, grace=GRACE, fencing=None),
                            clock=time.time)
                    except Exception:
                        return False
                    return st.get('state') == 'free' \
                        or st.get('holder') == STANDBY or stopped() \
                        or (st.get('state') == 'expired'
                            and st.get('now', 0) >= (st.get('expires') or 0)
                            + GRACE)
                return wait_until(available, end, stopped)

            def lead_standby():
                nonlocal takeover_at
                ok = lead(STANDBY)
                takeover_at = time.monotonic()
                return ok

            def restored():
                root = roots / STANDBY
                for rel in state_snapshot.ALLOW_LIST:
                    target = root / rel
                    expected = FAKE_STATE.get(rel)
                    if expected is None:
                        if target.exists() or target.is_symlink():
                            return False
                    elif not target.is_file() or target.read_text() != expected:
                        return False
                return True

            try:
                for name, fn in (('snapshot', make_snapshot),
                                 ('primaryLeader', lambda: lead(PRIMARY)),
                                 ('singleLeader', single_leader),
                                 ('primaryStopped', stop_primary),
                                 ('leaseFree', lease_free),
                                 ('standbyLeader', lead_standby),
                                 ('restoredState', restored)):
                    if not phase(name, fn):
                        break
            finally:
                cleanup(markers, procs)
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    if stopped():
        outcome = 'cancelled'
    elif overlap:
        outcome = 'overlap'
    elif failed is None:
        outcome = 'ok'
    else:
        outcome = 'deadline' if time.monotonic() >= end else 'failed'
    report = {'schema': SCHEMA, 'ok': outcome == 'ok', 'outcome': outcome,
              'deadlineSeconds': args.deadline_seconds,
              'elapsedMs': int((time.monotonic() - started) * 1000),
              'phases': phases, 'failedPhase': failed,
              'cancelled': bool(stopped())}
    if interrupted_at is not None and takeover_at is not None:
        report['takeoverMs'] = int((takeover_at - interrupted_at) * 1000)
    return report


def main(argv=None, deps=None, out=None):
    args = build_parser().parse_args(argv)
    deps = deps or {}
    out = out or sys.stdout
    if args.preview:
        print(json.dumps({'schema': SCHEMA, 'preview': True,
                          'deadlineSeconds': args.deadline_seconds,
                          'phases': list(PHASES)},
                         separators=(',', ':')), file=out, flush=True)
        return 0
    started = time.monotonic()
    try:
        report = rehearse(args, deps)
    except Exception as exc:
        report = {'schema': SCHEMA, 'ok': False, 'outcome': 'failed',
                  'deadlineSeconds': args.deadline_seconds,
                  'elapsedMs': int((time.monotonic() - started) * 1000),
                  'phases': {}, 'failedPhase': None, 'cancelled': False,
                  'error': type(exc).__name__}
    print(json.dumps(report, separators=(',', ':')), file=out, flush=True)
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
