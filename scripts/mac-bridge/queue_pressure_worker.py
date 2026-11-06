#!/usr/bin/env python3
"""Shared-queue worker under host memory pressure: gate first, then supervise.

A queue worker must wait for healthy memory BEFORE claiming work, then stay
supervised while it owns the claim. This foreground wrapper composes the two
existing entry points without a shell: it waits for consecutive healthy
memguard samples, then spawns memory_supervised.supervised_command wrapping
host_queue_worker.py with its literal flags and job argv.

Supervised tree (two owned sessions, one claim):

    queue_pressure_worker          caller's session; signals nothing but the
      └─ W  memory_admission wrap   tree it spawned below
             → exec host_queue_worker            [new session, holds the claim]
               └─ J  job argv                    [new session, the workload]
                     └─ … possible further sessions the job creates

host_queue_worker claims immediately, then launches its job with
start_new_session=True, so J is a second process group inside W's tree that
signals to W alone can never reach. Stopping W on pressure would freeze its
lease renewal while the job kept running; killing W can orphan J; and J can
leave further sessions W's own killpg cannot reach. This wrapper therefore
walks ppid links below W each poll over numeric (pid, ppid, pgid) rows —
libproc in-process on macOS, /proc on Linux, no spawned probe — and signals
only the descendant session groups that walk reaches:

* Launch gate: identical to pressure_worker — the queue worker (and so its
  claim) is only spawned after healthy_samples consecutive healthy samples.
  Warning or unavailable telemetry consumes no claim (exit 75).
* Pause: only W's descendant groups are SIGSTOPped. The claim owner keeps
  running, so its own lease renewal continues while the job is paused and
  its runtime/lease enforcement stays authoritative. Pause cannot expire
  the lease — except when the tree cannot be enumerated: a discovery
  failure freezes W as well (an unsupervisable worker may not spawn work),
  and a renewal lost that way ends execution per the queue contract —
  'uncertain', never completed, never automatically recovered. This
  wrapper never renews, extends, releases or completes the claim itself.
* Termination: every owned group is continued, the claim owner is
  terminated first so its own cleanup runs, then each descendant group
  ever observed is SIGKILLed and awaited — including sessions the queue
  worker's own stop_group cannot reach.

Receipt schema and exit codes follow pressure_worker: the queue worker's
code is propagated (0 = success or empty), 75 launch blocked, 124 deadline,
71 pause budget exhausted, 70 launch/configuration failure, 128+signal
cancelled. 'subgroups' lists the descendant group ids ever observed.
"""

import argparse
import ctypes
import math
import os
from pathlib import Path
import signal
import struct
import subprocess
import sys
import time
import uuid

import host_queue
import host_queue_worker
import memory_admission
import memory_supervised
import pressure_worker

QUEUE_WORKER = Path(host_queue_worker.__file__).resolve()
POLL_SECONDS = pressure_worker.POLL_SECONDS
HEALTHY_SAMPLES = pressure_worker.HEALTHY_SAMPLES
LAUNCH_WAIT_SECONDS = pressure_worker.LAUNCH_WAIT_SECONDS
TERM_GRACE_SECONDS = pressure_worker.TERM_GRACE_SECONDS
REAP_SECONDS = pressure_worker.REAP_SECONDS


_PIDTBSDINFO = 3        # PROC_PIDTBSDINFO: pbi_ppid/pbi_pgid carrier
_BSDINFO_SIZE = 648     # PROC_PIDTBSDINFO_SIZE; stable ABI tail-padding


_LIBPROC = None


def _darwin_rows():
    """(pid, ppid, pgid) per live process via libproc; numeric fields only."""
    global _LIBPROC
    if _LIBPROC is None:
        _LIBPROC = ctypes.CDLL('/usr/lib/libproc.dylib')
    lib = _LIBPROC
    count = lib.proc_listallpids(None, 0)
    if count <= 0:
        raise ValueError('process table unavailable')
    buf = (ctypes.c_int * count)()
    if lib.proc_listallpids(buf, ctypes.sizeof(buf)) <= 0:
        raise ValueError('process table unavailable')
    info = ctypes.create_string_buffer(_BSDINFO_SIZE)
    rows = []
    for pid in buf:
        if pid <= 0 or lib.proc_pidinfo(pid, _PIDTBSDINFO, 0, info,
                                        _BSDINFO_SIZE) <= 0:
            continue
        rows.append((pid, struct.unpack_from('<I', info, 16)[0],
                     struct.unpack_from('<I', info, 100)[0]))
    return rows


def _linux_rows():
    rows = []
    for entry in os.listdir('/proc'):
        if not entry.isdigit():
            continue
        try:
            stat = Path('/proc', entry, 'stat').read_text()
            fields = stat[stat.rindex(')') + 2:].split()
            rows.append((int(entry), int(fields[1]), int(fields[2])))
        except (OSError, ValueError, IndexError):
            continue  # kernel threads and exits between listdir and read
    return rows


def process_rows():
    if sys.platform == 'darwin':
        return _darwin_rows()
    if sys.platform.startswith('linux'):
        return _linux_rows()
    raise ValueError('unsupported host process telemetry')


def descendant_groups(leader, *, rows=process_rows):
    """Session PGIDs rooted below the claim owner, minus its own group.

    Only pids reached by ppid links from the leader count; nothing outside
    that descendant tree is ever returned or signalled. rows is a test seam.
    """
    table = rows()
    tree, frontier = {leader}, {leader}
    while frontier:
        found = {row[0] for row in table if row[1] in frontier} - tree
        tree |= found
        frontier = found
    return {row[2] for row in table if row[0] in tree} - {leader}


def queue_worker_command(db, host, lease, runtime, command, state_dir,
                         pause_file, job):
    """Literal argv for the supervised claim owner; no shell, no echo of argv."""
    return memory_supervised.supervised_command(
        [sys.executable, str(QUEUE_WORKER), '--db', str(db), '--host', host,
         '--lease', str(lease), '--runtime', str(runtime), '--', *command],
        Path(state_dir).absolute(), Path(pause_file).absolute(), job)


def run(command, metrics_path, max_age_seconds, receipt_dir, *, db, host,
        lease, runtime, state_dir, pause_file, job='queue',
        poll=POLL_SECONDS, healthy_samples=HEALTHY_SAMPLES,
        launch_wait=LAUNCH_WAIT_SECONDS, deadline=None,
        term_grace=TERM_GRACE_SECONDS, max_paused=None,
        clock=time.monotonic, sleep=time.sleep, sampler=pressure_worker.probe,
        groups=descendant_groups):
    """Gate, then run the supervised queue worker; return its exit code.

    Same return contract as pressure_worker.run. groups() discovers the
    claim owner's descendant sessions; sampler/clock/sleep mirror
    pressure_worker's test seams.
    """
    if max_paused is not None and (not math.isfinite(max_paused) or max_paused <= 0):
        raise ValueError('max_paused must be a finite positive number of seconds')
    metrics_path, receipt_dir = Path(metrics_path), Path(receipt_dir)
    pressure_worker.private_directory(receipt_dir)
    receipt = receipt_dir / (uuid.uuid4().hex + '.json')
    record = {'schemaVersion': 1, 'wrapperPid': os.getpid(), 'pgid': None,
              'subgroups': [], 'state': 'waiting', 'reason': None,
              'startedAt': time.time(), 'updatedAt': time.time(),
              'endedAt': None, 'returncode': None,
              'maxPausedSeconds': max_paused, 'pausedSeconds': 0.0}
    child, stopped, handlers = None, [], {}
    tracked = set()          # descendant PGIDs ever observed under the leader
    leader_stopped = False   # W frozen as a discovery-failure fallback

    def update(state, reason=None):
        record['subgroups'] = sorted(tracked)
        record.update(state=state, reason=reason, updatedAt=time.time())
        pressure_worker.atomic_json(receipt, record)

    def finish(state, reason, code):
        record.update(endedAt=time.time(), returncode=code)
        update(state, reason)
        return code

    def stop(signum, _frame):
        stopped.append(signum)

    def signal_groups(targets, sig):  # only groups this wrapper discovered/owns
        for group in targets:
            try:
                os.killpg(group, sig)
            except (ProcessLookupError, PermissionError):
                pass

    def sweep():
        # Kill then await every descendant session ever observed. The claim
        # owner's own stop_group already ran on its clean exits; this covers
        # nested sessions it cannot reach and a killed leader's orphans.
        signal_groups(sorted(tracked), signal.SIGKILL)
        end_wait = clock() + REAP_SECONDS
        remaining = {g for g in tracked if memory_admission.group_exists(g)}
        while remaining and clock() < end_wait:
            sleep(0.02)
            remaining = {g for g in remaining if memory_admission.group_exists(g)}
        if remaining:
            print('queue-pressure-worker: reap timeout; groups may outlive '
                  'the wrapper', file=sys.stderr, flush=True)

    def terminate(grace):
        if child is None:
            return
        owned = set(tracked)
        if child.poll() is None or leader_stopped:
            owned.add(child.pid)
        # A stopped group cannot act on TERM: continue everything owned first.
        signal_groups(owned, signal.SIGCONT)
        if child.poll() is None:
            signal_groups({child.pid}, signal.SIGTERM)
            try:
                child.wait(timeout=grace)
            except subprocess.TimeoutExpired:
                signal_groups({child.pid}, signal.SIGKILL)
        try:
            child.wait(timeout=REAP_SECONDS)
        except subprocess.TimeoutExpired:
            print('queue-pressure-worker: leader reap timeout',
                  file=sys.stderr, flush=True)
        sweep()

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        handlers[sig] = signal.signal(sig, stop)
    try:
        end = None if deadline is None else clock() + deadline
        limit = clock() + launch_wait
        if end is not None:
            limit = min(limit, end)
        state, healthy_run = 'unavailable', 0
        while healthy_run < healthy_samples:
            state = sampler(metrics_path, max_age_seconds)
            healthy_run = healthy_run + 1 if state == 'healthy' else 0
            if stopped or healthy_run >= healthy_samples:
                break
            update('waiting', state)
            now = clock()
            if now >= limit:
                break
            sleep(min(poll, max(0.01, limit - now)))
        if stopped:
            return finish('cancelled', f'signal-{stopped[0]}', 128 + stopped[0])
        if healthy_run < healthy_samples:
            print(f'queue-pressure-worker: launch blocked ({state})',
                  file=sys.stderr, flush=True)
            return finish('blocked', state, 75)
        try:
            child = subprocess.Popen(
                queue_worker_command(db, host, lease, runtime, command,
                                     state_dir, pause_file, job),
                start_new_session=True)
        except OSError:
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
        paused_since = None
        while True:
            now = clock()
            if stopped and terminating is None:
                terminating = ('cancelled', f'signal-{stopped[0]}', 128 + stopped[0])
            if terminating is None and end is not None and now >= end:
                terminating = ('deadline', 'deadline-exceeded', 124)
            if (terminating is None and paused_since is not None
                    and max_paused is not None and now - paused_since >= max_paused):
                terminating = ('pressure-kill', 'pause-budget-exhausted', 71)
            if terminating is not None:
                record['pausedSeconds'] = (
                    0.0 if paused_since is None else round(now - paused_since, 3))
                update('terminating', terminating[1])
                terminate(term_grace)
                return finish(*terminating)
            code = child.poll()
            if code is not None:
                sweep()
                return finish('finished', None, 128 - code if code < 0 else code)
            try:
                tracked |= groups(child.pid)
                tree_known = True
            except (OSError, ValueError, subprocess.SubprocessError):
                tree_known = False
            state = sampler(metrics_path, max_age_seconds)
            if state in ('critical', 'unavailable'):
                healthy_run = 0
                if not tree_known and not leader_stopped:
                    # An unsupervisable claim owner may not keep spawning
                    # work; freezing W pauses renewal, so the lease can
                    # expire — that ends execution 'uncertain', never safe.
                    signal_groups({child.pid}, signal.SIGSTOP)
                    leader_stopped = True
                elif tree_known and leader_stopped:
                    # Visibility restored: release the owner so renewal
                    # resumes; job groups stay frozen via tracked.
                    signal_groups({child.pid}, signal.SIGCONT)
                    leader_stopped = False
                signal_groups(set(tracked), signal.SIGSTOP)
                if not paused:
                    paused, paused_since = True, now
                    update('paused', state)
                    print(f'queue-pressure-worker: paused job groups ({state})',
                          file=sys.stderr, flush=True)
            elif state == 'healthy':
                healthy_run += 1
                if paused and healthy_run >= healthy_samples:
                    thaw = set(tracked)
                    if leader_stopped:
                        thaw.add(child.pid)
                        leader_stopped = False
                    signal_groups(thaw, signal.SIGCONT)
                    paused, paused_since = False, None
                    update('running', 'resumed')
                    print('queue-pressure-worker: resumed job groups',
                          file=sys.stderr, flush=True)
            else:
                healthy_run = 0
            record['pausedSeconds'] = (
                0.0 if paused_since is None else round(now - paused_since, 3))
            wait = poll
            if end is not None:
                wait = min(wait, max(0.01, end - now))
            if paused_since is not None and max_paused is not None:
                wait = min(wait, max(0.01, paused_since + max_paused - now))
            sleep(max(wait, 0.01))
    finally:
        terminate(term_grace)  # never orphan a stopped or escaped group
        for sig, handler in handlers.items():
            signal.signal(sig, handler)


def main(argv=None):
    raw = list(sys.argv[1:] if argv is None else argv)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', required=True,
                        help='coordinator-local SQLite database')
    parser.add_argument('--host', required=True, type=host_queue.identifier,
                        help='claim host identity presented to the queue')
    parser.add_argument('--lease', required=True, type=host_queue.positive,
                        help='queue lease seconds (1-86400)')
    parser.add_argument('--runtime', required=True, type=host_queue.positive,
                        help='queue worker maximum runtime seconds (1-86400)')
    parser.add_argument('--metrics', type=Path, required=True,
                        help='memguard metrics JSON (e.g. ~/.ashlr-runs/memguard.json)')
    parser.add_argument('--max-age-seconds', type=float, required=True,
                        help='metrics older than this count as unavailable')
    parser.add_argument('--state-dir', type=Path, required=True,
                        help='shared memory-admission state directory')
    parser.add_argument('--pause-file', type=Path,
                        default=memory_admission.defaults()[1],
                        help='admission pause sentinel path')
    parser.add_argument('--receipt-dir', type=Path, required=True,
                        help='private directory for wrapper receipts')
    parser.add_argument('--job', default='queue', help='admission job label')
    parser.add_argument('--poll-seconds', type=float, default=POLL_SECONDS)
    parser.add_argument('--healthy-samples', type=int, default=HEALTHY_SAMPLES,
                        help='consecutive healthy samples before launch/resume')
    parser.add_argument('--launch-wait-seconds', type=float,
                        default=LAUNCH_WAIT_SECONDS)
    parser.add_argument('--deadline-seconds', type=float, required=True,
                        help='hard bound over launch wait plus runtime')
    parser.add_argument('--max-paused-seconds', type=float, required=True,
                        help='continuous pause budget; exhaustion terminates '
                             'the owned tree (exit 71)')
    parser.add_argument('--term-grace-seconds', type=float,
                        default=TERM_GRACE_SECONDS)
    # Split at -- so job options are never interpreted or echoed by argparse.
    divider = raw.index('--') if '--' in raw else len(raw)
    args = parser.parse_args(raw[:divider])
    command = raw[divider + 1:]
    if not command:
        parser.error('a command after -- is required')
    timings = [args.max_age_seconds, args.poll_seconds, args.launch_wait_seconds,
               args.deadline_seconds, args.max_paused_seconds,
               args.term_grace_seconds]
    if (any(not math.isfinite(v) or v <= 0 for v in timings) or
            args.healthy_samples < 1 or
            not memory_admission.IDENTIFIER.fullmatch(args.job)):
        raise ValueError('invalid timing, sample or job configuration')
    return run(command, args.metrics, args.max_age_seconds, args.receipt_dir,
               db=args.db, host=args.host, lease=args.lease,
               runtime=args.runtime, state_dir=args.state_dir,
               pause_file=args.pause_file, job=args.job,
               poll=args.poll_seconds, healthy_samples=args.healthy_samples,
               launch_wait=args.launch_wait_seconds,
               deadline=args.deadline_seconds,
               term_grace=args.term_grace_seconds,
               max_paused=args.max_paused_seconds)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.SubprocessError):
        # Exceptions can include argv or arbitrary filesystem contents.
        print('queue-pressure-worker: invalid configuration or unavailable '
              'host telemetry', file=sys.stderr)
        sys.exit(70)
