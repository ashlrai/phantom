#!/usr/bin/env python3
"""Host-wide, fail-closed admission for trusted local build/test commands.

No credentials, command arguments or environments are persisted. Kernel locks
coordinate worktrees; reservations deliberately double-count resident memory
to cover growth between samples. This is admission control, not an OS RSS cap.
"""

import argparse
import contextlib
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import pwd
import re
import resource
import shutil
import signal
import stat
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass

GIB = 1024 ** 3
MAX_ACTIVE = 4
MIN_FREE = 0.30
MAX_SWAP = 8 * GIB
DEFAULT_RESERVE = 4 * GIB
PROFILES = ('cargo-build', 'cargo-test', 'npm-test', 'tsc', 'other')
IDENTIFIER = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z')


def required_memory_bytes(jobs_path, pool, fallback_bytes):
    """Return max(fallback, observed pool peaks); ignore legacy/malformed rows.

    Sum RSS and attributed swap peaks conservatively. Unknown swap contributes
    no estimate; the controller's host pressure and fallback gates still apply.
    """
    if not isinstance(fallback_bytes, (int, float)) or not math.isfinite(fallback_bytes) or fallback_bytes < 0:
        raise ValueError("fallback_bytes must be finite and nonnegative")
    required = fallback_bytes
    try:
        with Path(jobs_path).open(encoding="utf-8") as records:
            for line in records:
                try:
                    row = json.loads(line)
                    if not isinstance(row, dict) or row.get("schemaVersion") != 1 or row.get("pool") != pool:
                        continue
                    memory = row.get("memory")
                    if not isinstance(memory, dict) or memory.get("schemaVersion") != 1:
                        continue
                    count = memory.get("sampleCount")
                    if type(count) is not int or count < 1:
                        continue
                    rss = memory.get("peakRssBytes")
                    swap = memory.get("peakSwapBytes")
                    if swap is None:
                        swap = 0
                    if any(type(n) not in (int, float) or not math.isfinite(n) or n < 0 for n in (rss, swap)):
                        continue
                    peak = rss + swap
                    if math.isfinite(peak):
                        required = max(required, peak)
                except (ValueError, TypeError, OverflowError):
                    continue
    except (OSError, UnicodeError):
        pass
    return required


@dataclass(frozen=True)
class Snapshot:
    total: int
    free: int
    swap: int


def decision(snapshot, reservations, requested, paused=False):
    if paused:
        return 'paused'
    values = [snapshot.total, snapshot.free, snapshot.swap, requested, *reservations]
    if any(not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0 for v in values):
        return 'telemetry-unavailable'
    if snapshot.total <= 0 or snapshot.free > snapshot.total or requested <= 0:
        return 'telemetry-unavailable'
    if snapshot.swap >= MAX_SWAP:
        return 'swap'
    if len(reservations) >= MAX_ACTIVE:
        return 'slots'
    if snapshot.free - sum(reservations) - requested < math.ceil(snapshot.total * MIN_FREE):
        return 'memory'
    return None


def parse_snapshot(memsize, vm_stat, swapusage):
    total = int(memsize.strip())
    page = re.search(r'page size of (\d+) bytes', vm_stat)
    free = re.search(r'^Pages free:\s+(\d+)\.', vm_stat, re.M)
    speculative = re.search(r'^Pages speculative:\s+(\d+)\.', vm_stat, re.M)
    swap = re.search(r'\bused\s*=\s*(\d+(?:\.\d+)?)\s*([KMGT])\b', swapusage)
    if not all((page, free, speculative, swap)):
        raise ValueError('unrecognized memory telemetry')
    # Inactive/compressed/purgeable pages are not a guaranteed free reserve.
    snapshot = Snapshot(total, (int(free[1]) + int(speculative[1])) * int(page[1]),
                        math.ceil(float(swap[1]) * 1024 ** ('KMGT'.index(swap[2]) + 1)))
    if total <= 0 or int(page[1]) <= 0 or not 0 <= snapshot.free <= total:
        raise ValueError('invalid memory telemetry')
    return snapshot


def output(command):
    return subprocess.run(command, check=True, text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, timeout=3).stdout


def read_snapshot():
    if sys.platform == 'darwin':
        return parse_snapshot(output(['/usr/sbin/sysctl', '-n', 'hw.memsize']),
                              output(['/usr/bin/vm_stat']),
                              output(['/usr/sbin/sysctl', '-n', 'vm.swapusage']))
    if sys.platform.startswith('linux'):
        fields = {}
        for line in Path('/proc/meminfo').read_text().splitlines():
            name, value = line.split(':', 1)
            fields[name] = int(value.split()[0]) * 1024
        return Snapshot(fields['MemTotal'], fields['MemFree'],
                        fields['SwapTotal'] - fields['SwapFree'])
    raise ValueError('unsupported host memory telemetry')


def parse_processes(text):
    rows = []
    for line in text.splitlines():
        if not line.strip():
            continue
        fields = line.split()
        if len(fields) != 5:
            raise ValueError('invalid process telemetry')
        pid, ppid, pgid, rss = map(int, fields[:4])
        if pid <= 0 or min(ppid, pgid, rss) < 0:
            raise ValueError('invalid process telemetry')
        rows.append((pid, ppid, pgid, rss * 1024, fields[4]))
    return rows


def processes():
    # Explicit numeric fields only: never argv, command text or environments.
    return parse_processes(output(['/bin/ps', '-axo', 'pid=,ppid=,pgid=,rss=,stat=']))


def group_rss(rows, pgid):
    return sum(row[3] for row in rows if row[2] == pgid and not row[4].startswith('Z'))


def group_alive(rows, pgid):
    return any(row[2] == pgid and not row[4].startswith('Z') for row in rows)


def group_exists(pgid):
    """ESRCH is disappearance evidence even if ps has become unavailable."""
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def classify(command, args):
    command = Path(command).name
    if command == 'tsc':
        return 'tsc'
    if command == 'cargo':
        # Includes cargo +toolchain and global options before the subcommand.
        if any(a in ('test', 't') for a in args):
            return 'cargo-test'
        if any(a in ('build', 'b', 'check', 'c', 'clippy', 'bench', 'rustc') for a in args):
            return 'cargo-build'
    if command in ('npm', 'npx'):
        if 'tsc' in args or any(a == 'typecheck' or a.startswith('typecheck:') for a in args):
            return 'tsc'
        if any(a in ('test', 't', 'tst', 'vitest', 'test:ci', 'exec') or
               a.startswith(('test:', 'build:', 'lint:')) or a in ('build', 'lint') for a in args):
            return 'npm-test'
    return None


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
        raise ValueError('memory state directory must be private and owned by this user')


def open_lock(path):
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        os.close(fd)
        raise ValueError('unsafe memory lock file')
    return fd


class Admission:
    def __init__(self, root, pause_file, reserve_bytes=DEFAULT_RESERVE, job='heavy', profile='other'):
        if not IDENTIFIER.fullmatch(job) or profile not in PROFILES:
            raise ValueError('invalid job or profile')
        if not isinstance(reserve_bytes, int) or reserve_bytes <= 0:
            raise ValueError('reservation must be positive bytes')
        self.root, self.pause_file = Path(root), Path(pause_file)
        private_directory(self.root)
        for name in ('queue', 'receipts'):
            private_directory(self.root / name)
        self.ticket = uuid.uuid4().hex
        self.path = self.root / 'queue' / (self.ticket + '.json')
        self.lease_path = self.path.with_suffix('.lease')
        self.fd = None
        self.record = dict(ticket=self.ticket, job=job, profile=profile,
                           reserveBytes=reserve_bytes, state='waiting', pid=os.getpid(), pgid=None)

    @contextlib.contextmanager
    def locked(self):
        fd = open_lock(self.root / 'coordinator.lock')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    def enqueue(self):
        with self.locked():
            if self.fd is not None:
                raise ValueError('already queued')
            self.fd = open_lock(self.lease_path)
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            # Sequence is serialized, independent of clock adjustments.
            sequence_file = self.root / 'sequence.json'
            sequence = json.loads(sequence_file.read_text()) if sequence_file.exists() else 0
            if not isinstance(sequence, int) or sequence < 0:
                raise ValueError('invalid queue sequence')
            self.record.update(sequence=sequence + 1, queuedAt=time.time())
            atomic_json(sequence_file, sequence + 1)
            atomic_json(self.path, self.record)

    def entries(self):
        entries = []
        for path in (self.root / 'queue').glob('*.json'):
            record = json.loads(path.read_text())
            if (not isinstance(record, dict) or record.get('state') not in ('waiting', 'active') or
                    not isinstance(record.get('sequence'), int) or
                    not isinstance(record.get('reserveBytes'), int) or record['reserveBytes'] <= 0 or
                    record.get('ticket') != path.stem or
                    (record.get('pgid') is not None and
                     (not isinstance(record['pgid'], int) or record['pgid'] <= 0))):
                raise ValueError('invalid queue record')
            if path != self.path:
                fd = open_lock(path.with_suffix('.lease'))
                try:
                    try:
                        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        entries.append(record)
                        continue
                    # No TTL takeover: a dead wrapper's process group still owns
                    # its reservation, even if a child closed inherited FDs.
                    if record.get('pgid') and group_alive(processes(), record['pgid']):
                        entries.append(record)
                        continue
                    record.update(state='abandoned', endedAt=time.time(), peakRssBytes=None)
                    atomic_json(self.root / 'receipts' / path.name, record)
                    path.unlink()
                    path.with_suffix('.lease').unlink(missing_ok=True)
                finally:
                    os.close(fd)
            else:
                entries.append(record)
        return sorted(entries, key=lambda entry: entry['sequence'])

    def attempt(self, snapshot=None):
        if self.fd is None:
            raise ValueError('enqueue before admission')
        with self.locked():
            try:
                entries = self.entries()
                waiting = [e for e in entries if e['state'] == 'waiting']
                if self.record['state'] == 'active':
                    return None
                if not waiting or waiting[0]['ticket'] != self.ticket:
                    return 'fifo'
                # stat errors (including sandbox denial) must NOT look unpaused.
                try:
                    self.pause_file.lstat()
                    paused = True
                except FileNotFoundError:
                    paused = False
                if paused:
                    return 'paused'
                history_path = self.root / 'peaks.json'
                history = json.loads(history_path.read_text()) if history_path.exists() else {}
                if not isinstance(history, dict):
                    raise ValueError('invalid historical peaks')
                peak = history.get(self.record['profile'], 0)
                if not isinstance(peak, int) or peak < 0:
                    raise ValueError('invalid historical peak')
                self.record['reserveBytes'] = max(self.record['reserveBytes'], math.ceil(peak * 1.25))
                if snapshot is None:
                    # Do not launch a command whose group we cannot observe.
                    processes()
                sample = snapshot if snapshot is not None else read_snapshot()
                reason = decision(sample, [e['reserveBytes'] for e in entries if e['state'] == 'active'],
                                  self.record['reserveBytes'], paused)
                if reason:
                    return reason
                self.record.update(state='active', startedAt=time.time(),
                                   admission=dict(totalBytes=sample.total, freeBytes=sample.free,
                                                  swapBytes=sample.swap))
                atomic_json(self.path, self.record)
                return None
            except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
                return 'telemetry-unavailable'

    def set_group(self, pgid):
        with self.locked():
            self.record['pgid'] = pgid
            atomic_json(self.path, self.record)

    def grow_reservation(self, peak):
        if peak > self.record['reserveBytes']:
            with self.locked():
                self.record['reserveBytes'] = math.ceil(peak * 1.25)
                atomic_json(self.path, self.record)

    def finish(self, peak_bytes, returncode, **details):
        with self.locked():
            if peak_bytes is not None:
                history_path = self.root / 'peaks.json'
                history = json.loads(history_path.read_text()) if history_path.exists() else {}
                if not isinstance(history, dict):
                    raise ValueError('invalid historical peaks')
                history[self.record['profile']] = max(history.get(self.record['profile'], 0), peak_bytes)
                atomic_json(history_path, history)
            self.record.update(state='finished', endedAt=time.time(), peakRssBytes=peak_bytes,
                               returncode=returncode, **details)
            atomic_json(self.root / 'receipts' / self.path.name, self.record)
            self.path.unlink(missing_ok=True)
            self.close()
            self.lease_path.unlink(missing_ok=True)

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


def inherited_lease(root):
    """Reuse a held lease FD or its active process group (npm closes extra FDs).

    The environment token alone is insufficient. A different process group
    cannot borrow a reservation merely by copying a ticket identifier.
    """
    try:
        token = os.environ.get('PHANTOM_MEMORY_LEASE', '')
        ticket, raw_fd = token.split(':')
        if not re.fullmatch('[0-9a-f]{32}', ticket):
            return None
        fd = int(raw_fd)
        lease = root / 'queue' / (ticket + '.lease')
        record = json.loads(lease.with_suffix('.json').read_text())
        if not isinstance(record, dict) or record.get('state') != 'active':
            return None
        if record.get('pgid') == os.getpgrp():
            return -1
        if record.get('pgid') is not None:
            return None
        own, stored = os.fstat(fd), lease.stat()
        if (own.st_dev, own.st_ino) != (stored.st_dev, stored.st_ino):
            return None
        return fd
    except (ValueError, OSError, KeyError):
        return None


def run(command, admission, poll=1.0, wait_seconds=None):
    stopped = []
    child = None
    handlers = {}
    peak, samples, sample_errors = 0, 0, 0
    started = time.monotonic()
    previous_reason = None

    def stop(signum, _frame):
        stopped.append(signum)

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        handlers[sig] = signal.signal(sig, stop)
    try:
        admission.enqueue()
        while not stopped:
            reason = admission.attempt()
            if reason is None:
                # PAUSE can appear while telemetry is being read. Release the
                # reservation without losing FIFO position, then try again.
                try:
                    admission.pause_file.lstat()
                    with admission.locked():
                        admission.record['state'] = 'waiting'
                        atomic_json(admission.path, admission.record)
                    reason = 'paused'
                except FileNotFoundError:
                    break
            if reason != previous_reason:
                print(f'memory-admission: queued ({reason})', file=sys.stderr, flush=True)
                previous_reason = reason
            if wait_seconds is not None and time.monotonic() - started >= wait_seconds:
                admission.finish(None, 75, outcome='queue-timeout')
                return 75
            time.sleep(poll)
        if stopped:
            code = 128 + stopped[0]
            admission.finish(None, code, outcome='cancelled')
            return code
        env = dict(os.environ)
        env['CARGO_BUILD_JOBS'] = '4'
        env['PHANTOM_MEMORY_STATE_DIR'] = str(admission.root.absolute())
        env['PHANTOM_MEMORY_PAUSE_FILE'] = str(admission.pause_file.absolute())
        env['PHANTOM_MEMORY_LEASE'] = f'{admission.ticket}:{admission.fd}'
        ready_read, ready_write = os.pipe()
        try:
            # The child cannot exec until its group is durable. EOF after a
            # wrapper crash aborts the child, closing the spawn/record race.
            child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()),
                                      '_exec', str(ready_read), *command],
                                     start_new_session=True, env=env,
                                     pass_fds=(admission.fd, ready_read))
            admission.set_group(child.pid)
            os.write(ready_write, b'1')
        finally:
            os.close(ready_read)
            os.close(ready_write)
        termination_at = None
        while True:
            if stopped and termination_at is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                termination_at = time.monotonic()
            if termination_at is not None and time.monotonic() - termination_at >= 5:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            code = child.poll()
            try:
                rows = processes()
                peak = max(peak, group_rss(rows, child.pid))
                admission.grow_reservation(peak)
                samples += 1
                alive = group_alive(rows, child.pid)
            except (OSError, ValueError, subprocess.SubprocessError):
                sample_errors += 1
                # Only an explicit ESRCH proves disappearance. Failed ps is
                # never interpreted as zero RSS or a dead process group.
                alive = group_exists(child.pid)
            if code is not None and not alive:
                break
            time.sleep(poll)
        # Kernel high-water mark covers short children that fell between ps
        # samples. It is the largest child, not the simultaneous tree total.
        child_peak = int(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss)
        if sys.platform != 'darwin':
            child_peak *= 1024
        result = 128 + stopped[0] if stopped else (128 - code if code < 0 else code)
        admission.finish(max(peak, child_peak), result, sampledGroupPeakBytes=peak,
                         childHighWaterBytes=child_peak, rssSamples=samples,
                         rssSampleErrors=sample_errors, outcome='completed')
        return result
    except (OSError, ValueError, subprocess.SubprocessError):
        # Do not erase an active child's reservation on an accounting failure.
        # A successor reaps only after the group and inherited lease are gone.
        if child is None:
            admission.finish(None, 70, outcome='launch-error')
        print('memory-admission: launch/accounting unavailable; reservation retained if active',
              file=sys.stderr)
        return 70
    finally:
        admission.close()
        for sig, handler in handlers.items():
            signal.signal(sig, handler)


def defaults():
    # HOME is intentionally not part of the semaphore identity: isolated test
    # homes and worktrees on one host must compete for the same four slots.
    root = Path(os.environ.get('PHANTOM_MEMORY_STATE_DIR', f'/tmp/phantom-memory-{os.getuid()}')).absolute()
    pause = Path(os.environ.get('PHANTOM_MEMORY_PAUSE_FILE',
                                str(Path(pwd.getpwuid(os.getuid()).pw_dir) / '.ashlr-runs' / 'PAUSE'))).absolute()
    return root, pause


def wrap(command, root, pause, job):
    private_directory(root)
    module = Path(__file__).resolve()
    directory = root / ('shims-' + hashlib.sha256(str(module).encode()).hexdigest()[:16])
    private_directory(directory)
    for name in ('cargo', 'npm', 'npx', 'tsc'):
        path = directory / name
        try:
            path.symlink_to(module)
        except FileExistsError:
            if not path.is_symlink() or path.resolve() != module:
                raise ValueError('unexpected memory shim')
    env = dict(os.environ)
    env['PHANTOM_MEMORY_STATE_DIR'] = str(root)
    env['PHANTOM_MEMORY_PAUSE_FILE'] = str(pause)
    env['PHANTOM_MEMORY_JOB'] = job
    original = env.get('PHANTOM_MEMORY_ORIGINAL_PATH', os.defpath if 'PATH' not in env else env['PATH'])
    env['PHANTOM_MEMORY_ORIGINAL_PATH'] = original
    env['PATH'] = str(directory) + os.pathsep + original
    os.execvpe(command[0], command, env)


def main(argv=None):
    raw = list(sys.argv[1:] if argv is None else argv)
    if raw and raw[0] == '_exec':
        fd = int(raw[1])
        ready = os.read(fd, 1)
        os.close(fd)
        if ready != b'1':
            return 70
        os.execvp(raw[2], raw[2:])
    root, pause = defaults()
    invoked = Path(sys.argv[0]).name
    if invoked in ('cargo', 'npm', 'npx', 'tsc'):
        args = sys.argv[1:]
        executable = shutil.which(invoked, path=os.environ.get('PHANTOM_MEMORY_ORIGINAL_PATH', os.defpath))
        if executable is None or Path(executable).resolve() == Path(__file__).resolve():
            raise ValueError('original executable unavailable')
        command = [executable, *args]
        profile = classify(invoked, args)
        fd = inherited_lease(root)
        if profile is None or fd is not None:
            if fd is not None and fd >= 0:
                os.set_inheritable(fd, True)
            os.execv(executable, command)
        return run(command, Admission(root, pause, profile=profile,
                                     job=os.environ.get('PHANTOM_MEMORY_JOB', 'heavy')))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('run', 'wrap', 'status'))
    parser.add_argument('--state-dir', type=Path, default=root)
    parser.add_argument('--pause-file', type=Path, default=pause)
    parser.add_argument('--job', default='heavy')
    parser.add_argument('--profile', choices=PROFILES, default='other')
    parser.add_argument('--reserve-gib', type=int, default=4)
    parser.add_argument('--wait-seconds', type=float, help='optional caller deadline; 75 means still queued')
    # Split at -- so child options are never interpreted or echoed by argparse.
    divider = raw.index('--') if '--' in raw else len(raw)
    args = parser.parse_args(raw[:divider])
    command = raw[divider + 1:]
    root, pause = args.state_dir.absolute(), args.pause_file.absolute()
    if args.reserve_gib < 1 or (args.wait_seconds is not None and
                               (not math.isfinite(args.wait_seconds) or args.wait_seconds <= 0)):
        raise ValueError('invalid reservation or deadline')
    if args.action == 'status':
        snapshot = read_snapshot()
        print(json.dumps(dict(totalBytes=snapshot.total, freeBytes=snapshot.free, swapBytes=snapshot.swap,
                              maxActive=MAX_ACTIVE, minimumFreeFraction=MIN_FREE, maxSwapBytes=MAX_SWAP)))
        return 0
    if not command:
        raise ValueError('a command after -- is required')
    if args.action == 'wrap':
        if not IDENTIFIER.fullmatch(args.job):
            raise ValueError('invalid job')
        wrap(command, root, pause, args.job)
    fd = inherited_lease(root)
    if fd is not None:
        if fd >= 0:
            os.set_inheritable(fd, True)
        os.execvp(command[0], command)
    return run(command, Admission(root, pause, args.reserve_gib * GIB, args.job, args.profile),
               wait_seconds=args.wait_seconds)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.SubprocessError):
        # Exceptions can include argv or arbitrary filesystem contents.
        print('memory-admission: invalid configuration or unavailable host telemetry', file=sys.stderr)
        sys.exit(70)
