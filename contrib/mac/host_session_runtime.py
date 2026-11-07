"""Owned observation files for the existing dispatcher; no launch authority.

The dispatcher serializes its observation/cache writes with its EXISTING lock.
The launcher writes distinct per-job claim files. No new controller or semaphore
is introduced. Missing custody is unknown, never a zero-resource observation.
"""
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
import re
import secrets
import stat

from host_session_observation import observe_sessions, identity_census, pressure_level, _bounded, _table

JOB = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}\Z')
MAX_BYTES = 1024 * 1024


def _identity(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


def _owned(info, directory=False):
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    return (kind(info.st_mode) and info.st_uid == os.getuid()
            and not info.st_mode & 0o022 and (directory or info.st_nlink == 1))


@contextlib.contextmanager
def runs_directory(path):
    """Anchor the canonical owned 0755-compatible runs root without following links."""
    if not os.path.isabs(path) or os.path.normpath(path) != path:
        raise ValueError('noncanonical runs root')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in path.split('/')[1:]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            info = os.fstat(child)
            named = os.stat(component, dir_fd=fd, follow_symlinks=False)
            if (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino):
                os.close(child)
                raise ValueError('runs ancestor changed')
            trusted = info.st_uid in (0, os.getuid())
            sticky_root = info.st_uid == 0 and info.st_mode & stat.S_ISVTX
            if not trusted or info.st_mode & 0o022 and not sticky_root:
                os.close(child)
                raise ValueError('unsafe runs ancestor')
            os.close(fd)
            fd = child
        if not _owned(os.fstat(fd), directory=True):
            raise ValueError('unsafe runs root')
        yield fd
    finally:
        os.close(fd)


def read_bytes_at(directory, name, limit=MAX_BYTES):
    if '/' in name or name in ('', '.', '..'):
        raise ValueError('invalid observation name')
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        before = os.fstat(fd)
        if not _owned(before) or before.st_size > limit:
            raise ValueError('unsafe observation file')
        raw = bytearray()
        while len(raw) <= limit:
            part = os.read(fd, min(65536, limit + 1 - len(raw)))
            if not part:
                break
            raw.extend(part)
        after = os.fstat(fd)
        named = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if (len(raw) > limit or not _owned(after) or _identity(before) != _identity(after)
                or _identity(after) != _identity(named)):
            raise ValueError('observation changed')
        return bytes(raw), _identity(after)
    finally:
        os.close(fd)


def read_json_at(directory, name, limit=MAX_BYTES):
    raw, _ = read_bytes_at(directory, name, limit)
    return json.loads(raw.decode('utf-8', errors='strict'))


def write_json_at(directory, name, value):
    """Atomic bounded writer; callers preserve the existing dispatcher/job lock."""
    if '/' in name or name in ('', '.', '..'):
        raise ValueError('invalid observation name')
    raw = (json.dumps(value, separators=(',', ':'), allow_nan=False) + '\n').encode('utf-8')
    if len(raw) > MAX_BYTES:
        raise ValueError('observation exceeds budget')
    try:
        current = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if not _owned(current):
            raise ValueError('unsafe prior observation')
    except FileNotFoundError:
        current = None
    temporary = '.resource-observation-' + secrets.token_hex(16)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                 0o600, dir_fd=directory)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            latest = os.stat(name, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            latest = None
        if ((current is None) != (latest is None)
                or current is not None and _identity(current) != _identity(latest)):
            raise ValueError('prior observation changed')
        os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass


def boot_identity(run=_bounded):
    """Same fixed boot UUID observation as the current native boot reader."""
    value = run(['/usr/sbin/sysctl', '-n', 'kern.bootsessionuuid']).strip().lower()
    if not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', value):
        raise ValueError('boot identity unavailable')
    return value


def collect_observation(claims, verify_claim, *, census=identity_census,
                        boot=boot_identity, pressure=pressure_level, now=None):
    """Compose the actual typed sampler; caller supplies currently verified claims.

    The fixed-file claim adapter and dispatcher caller are intentionally separate
    from the UI projection; neither a UI row nor its historical cache grants
    permission to launch. Missing any component degrades sessions independently.
    """
    instant = now or datetime.datetime.now(datetime.timezone.utc)
    result = {'schemaVersion': 1, 'observedAt': instant.isoformat().replace('+00:00', 'Z'),
              'pressure': pressure(), 'censusState': 'unknown',
              'sessionsState': 'unknown', 'sessions': []}
    try:
        before = boot()
        first, second = census(), census()
        if boot() != before:
            raise ValueError('boot changed')
        result['censusState'] = 'known'
        rows = observe_sessions(claims, first, second, before, os.cpu_count(), verify_claim)
        if boot() != before:
            raise ValueError('boot changed')
        result.update(sessionsState='known', sessions=rows)
    except (OSError, ValueError, TimeoutError):
        pass
    return result


def publish_observation(runs, observation):
    """Only the existing dispatcher calls this under dispatchd.lock."""
    with runs_directory(runs) as directory:
        original = os.fstat(directory)
        write_json_at(directory, 'resource-session-observation.json', observation)
        with runs_directory(runs) as current:
            fresh = os.fstat(current)
            if (original.st_dev, original.st_ino) != (fresh.st_dev, fresh.st_ino):
                raise ValueError('runs directory changed during publication')


@contextlib.contextmanager
def claim_directory(runs, create=False):
    """Private observation child below the existing protected 0755 runs tree."""
    with runs_directory(runs) as root:
        fds = []
        parent = root
        try:
            for name in ('queue', 'run', 'resource-sessions'):
                if create and name == 'resource-sessions':
                    try:
                        os.mkdir(name, 0o700, dir_fd=parent)
                    except FileExistsError:
                        pass
                fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                fds.append(fd)
                info = os.fstat(fd)
                named = os.stat(name, dir_fd=parent, follow_symlinks=False)
                if (not _owned(info, directory=True) or (info.st_dev, info.st_ino)
                        != (named.st_dev, named.st_ino)
                        or name == 'resource-sessions' and info.st_mode & 0o077):
                    raise ValueError('unsafe session observation directory')
                parent = fd
            # Only observation registration is serialized here. Contention is
            # immediate unknown telemetry; this is never a worker/admission cap.
            if create:
                try:
                    fcntl.flock(fds[-1], fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    raise ValueError('session registration busy') from None
            yield fds[-2], fds[-1]
            parent = root
            for name, fd in zip(('queue', 'run', 'resource-sessions'), fds):
                info = os.fstat(fd)
                named = os.stat(name, dir_fd=parent, follow_symlinks=False)
                if not _owned(info, directory=True) or (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino):
                    raise ValueError('session directory changed')
                parent = fd
        finally:
            for fd in reversed(fds):
                os.close(fd)


def _owner_witness(root, run_directory, job, worktree_root=None):
    """Hash protected attempt records and physical worktree; never export bodies.

    Root-managed jobs retain the legacy owner-only witness where the dispatcher
    records are absent; if records are present they must all validate.
    """
    owner = None
    try:
        fd = os.open(job + '.root-owner', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                     dir_fd=run_directory)
    except FileNotFoundError:
        pass
    else:
        try:
            info = os.fstat(fd)
            named = os.stat(job + '.root-owner', dir_fd=run_directory, follow_symlinks=False)
            if not _owned(info, directory=True) or (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino):
                raise ValueError('unsafe owner directory')
            raw, ident = read_bytes_at(fd, 'owner.json', 16384)
            parsed = json.loads(raw.decode('utf-8'))
            if not isinstance(parsed, dict) or not isinstance(parsed.get('owner'), str) or not parsed['owner']:
                raise ValueError('missing current session owner')
            owner = [raw.hex(), ident, (info.st_dev, info.st_ino)]
        finally:
            os.close(fd)
    try:
        line, li = read_bytes_at(run_directory, job + '.line', 16384)
    except FileNotFoundError:
        if owner is None:
            raise ValueError('missing dispatcher ownership')
        return hashlib.sha256(json.dumps(owner, separators=(',', ':')).encode()).hexdigest()
    base, bi = read_bytes_at(root, job + '.base', 16384)
    dispatched, di = read_bytes_at(run_directory, job + '.dispatched', 128)
    fields = line.decode('utf-8', errors='strict').rstrip('\n').split('\t')
    tokens = base.decode('utf-8', errors='strict').split()
    if (len(fields) not in (5, 6) or fields[0] != job or (len(fields) == 6 and fields[5] != 'pin')
            or any(not x or any(ord(c) < 32 or ord(c) == 127 for c in x) for x in fields)
            or len(tokens) != 4 or tokens[1] != 'codex-bridge/' + job or tokens[3] != fields[2]
            or not re.fullmatch(r'[0-9a-fA-F]{40,64}', tokens[0])
            or not re.fullmatch(r'[0-9]+', dispatched.decode('ascii').strip())):
        raise ValueError('malformed dispatcher ownership')
    parent = worktree_root or os.path.expanduser('~/Projects/ashlrai/wt')
    if not os.path.isabs(parent) or os.path.normpath(parent) != parent or tokens[2] != os.path.join(parent, job):
        raise ValueError('worktree path mismatch')
    with runs_directory(parent) as wtroot:
        fd = os.open(job, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=wtroot)
        try:
            info = os.fstat(fd)
            named = os.stat(job, dir_fd=wtroot, follow_symlinks=False)
            if not _owned(info, directory=True) or (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino):
                raise ValueError('unsafe worktree')
            physical = (info.st_dev, info.st_ino)
        finally:
            os.close(fd)
    binding = [line.hex(), li, base.hex(), bi, dispatched.hex(), di, physical, owner]
    return hashlib.sha256(json.dumps(binding, separators=(',', ':')).encode()).hexdigest()


def _attempt_binding(records, pid, start, boot):
    """Bind protected records and this observed process incarnation and boot."""
    raw = json.dumps([records, pid, start, boot], separators=(',', ':'), allow_nan=False).encode()
    return hashlib.sha256(raw).hexdigest()


def register_claim(runs, job, root_pid, *, census=identity_census, boot=boot_identity, worktree_root=None):
    """Observe a just-started child; failure never changes whether it was launched."""
    if not JOB.fullmatch(job) or type(root_pid) is not int or root_pid <= 0:
        raise ValueError('invalid session registration')
    with claim_directory(runs, create=True) as (run_directory, directory):
        with runs_directory(runs) as root:
            owner = _owner_witness(root, run_directory, job, worktree_root)
        before = boot()
        first = {r['pid']: r for r in census()}
        second = {r['pid']: r for r in census()}
        if (boot() != before or root_pid not in first or root_pid not in second
                or first[root_pid]['start'] != second[root_pid]['start']
                or first[root_pid].get('uid') != os.getuid() or second[root_pid].get('uid') != os.getuid()):
            raise ValueError('session registration changed')
        with runs_directory(runs) as root:
            if _owner_witness(root, run_directory, job, worktree_root) != owner:
                raise ValueError('session registration changed')
        with runs_directory(runs) as root:
            captured = _attempt_snapshot(root, run_directory, job)
            if _owner_witness(root, run_directory, job, worktree_root) != owner:
                raise ValueError('session registration changed')
        registration_pins = _registration_pins(captured, job)
        owner = _attempt_binding(owner, root_pid, second[root_pid]['start'], before)
        try:
            prior = read_json_at(directory, job + '.json', 16384)
        except FileNotFoundError:
            prior = None
        if prior is not None:
            if (not isinstance(prior, dict) or prior.get('jobId') != job
                    or prior.get('schemaVersion') != 1 or type(prior.get('rootPid')) is not int
                    or prior['rootPid'] <= 0 or not isinstance(prior.get('start'), str)
                    or not prior['start'] or not isinstance(prior.get('bootId'), str)
                    or not prior['bootId'] or prior.get('startSource') != 'ps-lstart'
                    or not re.fullmatch(r'[0-9a-f]{64}', str(prior.get('ownerWitness', '')))
                    or not re.fullmatch(r'[0-9a-f]{64}', str(prior.get('ownerNonce', '')))):
                raise ValueError('prior session claim unavailable')
            previous_pid = prior.get('rootPid')
            old_in_first = (prior.get('bootId') == before and previous_pid in first
                            and first[previous_pid]['start'] == prior.get('start'))
            old_in_second = (prior.get('bootId') == before and previous_pid in second
                             and second[previous_pid]['start'] == prior.get('start'))
            if old_in_first or old_in_second:
                if (old_in_first and old_in_second and previous_pid == root_pid
                        and prior.get('ownerWitness') == owner):
                    return prior  # Same observed attempt; retain its exact nonce.
                raise ValueError('another session attempt is still active or uncertain')
            # History remains a distinct immutable record; no stale claim can
            # be converted into current metrics by overwriting its identity.
            try:
                os.mkdir('history', 0o700, dir_fd=directory)
            except FileExistsError:
                pass
            history = os.open('history', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                              dir_fd=directory)
            try:
                info = os.fstat(history)
                if not _owned(info, directory=True) or info.st_mode & 0o077:
                    raise ValueError('unsafe session history')
                name = job + '.' + prior['ownerNonce'] + '.json'
                try:
                    archived = read_json_at(history, name, 16384)
                    if archived != prior:
                        raise ValueError('session history differs')
                except FileNotFoundError:
                    write_json_at(history, name, prior)
            finally:
                os.close(history)
        claim = {'schemaVersion': 1, 'jobId': job, 'rootPid': root_pid,
                 'start': second[root_pid]['start'], 'startSource': 'ps-lstart',
                 'bootId': before, 'ownerWitness': owner, 'ownerNonce': secrets.token_hex(32),
                 'registrationPins': registration_pins}
        # The pinned private directory lock covers prior check plus replacement.
        # It is released automatically on descriptor close, including crashes.
        write_json_at(directory, job + '.json', claim)
        return claim


MAX_RECONCILE_CLAIMS = 512


def _attempt_snapshot(root, run, job):
    """Reject-only fixed-record pins, including proven absence after ordinary reap."""
    result = {}
    for directory, name in [(root, job + '.base'), (run, job + '.line'), (run, job + '.dispatched'), (run, job + '.rc'), (run, job + '.fin')]:
        try:
            raw, identity = read_bytes_at(directory, name, 16384)
            result[name] = [hashlib.sha256(raw).hexdigest(), identity]
        except FileNotFoundError:
            result[name] = None
    try:
        fd = os.open(job + '.root-owner', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=run)
    except FileNotFoundError:
        result['owner'] = None
    else:
        try:
            info = os.fstat(fd)
            named = os.stat(job + '.root-owner', dir_fd=run, follow_symlinks=False)
            if not _owned(info, directory=True) or (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino):
                raise ValueError('owner changed')
            raw, identity = read_bytes_at(fd, 'owner.json', 16384)
            owner = json.loads(raw.decode('utf-8', errors='strict'))
            if not isinstance(owner, dict) or not isinstance(owner.get('owner'), str) or not owner['owner']:
                raise ValueError('owner unavailable')
            result['owner'] = [hashlib.sha256(raw).hexdigest(), identity, (info.st_dev, info.st_ino)]
        finally:
            os.close(fd)
    return result


def _registration_pins(snapshot, job):
    def hashed(value):
        return None if value is None else hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return {key: hashed(snapshot[name]) for key, name in [('base',job+'.base'), ('line',job+'.line'), ('dispatched',job+'.dispatched'), ('owner','owner')]}


def _claim_directory_named(runs, expected):
    with claim_directory(runs) as (_, current):
        a, b = os.fstat(expected), os.fstat(current)
        return (a.st_dev, a.st_ino) == (b.st_dev, b.st_ino)


def _terminal_exit(run, job):
    try:
        raw, _ = read_bytes_at(run, job + '.rc', 64)
    except FileNotFoundError:
        return False
    # Exact existing dispatcher/reaper completed-agent receipt grammar.
    if not re.fullmatch(rb'-?[0-9]{1,6}\s*', raw):
        raise ValueError('terminal attempt receipt unavailable')
    return True


def reconcile_closed_claims(runs, *, census=identity_census, boot=boot_identity, worktree_root=None):
    """Archive only a bounded batch proven absent in two complete fresh censuses.

    The existing private directory flock serializes registration and retirement.
    Active, reused, changed or unknown identities remain untouched. History is
    outside the current inventory and never contributes current disk/process use.
    """
    with claim_directory(runs, create=True) as (run, directory):
        names = []
        with os.scandir(directory) as entries:
            for entry in entries:
                if entry.name == 'history':
                    continue
                if not entry.name.endswith('.json') or not JOB.fullmatch(entry.name[:-5]):
                    raise ValueError('invalid current claim name')
                names.append(entry.name)
                if len(names) >= MAX_RECONCILE_CLAIMS:
                    break
        if not names:
            return 0
        with runs_directory(runs) as root:
            snapshots = {name: _attempt_snapshot(root, run, name[:-5]) for name in names}
        before_boot = boot()
        if not isinstance(before_boot, str) or not before_boot:
            raise ValueError('boot unavailable')
        first_rows, second_rows = census(), census()
        first, second = _table(first_rows), _table(second_rows)
        if any(type(row.get('uid')) is not int or row['uid'] < 0 for row in first_rows + second_rows) or boot() != before_boot:
            raise ValueError('incomplete claim census')
        retired = 0
        for name in names:
            raw, identity = read_bytes_at(directory, name, 16384)
            claim = json.loads(raw.decode('utf-8', errors='strict'))
            job = name[:-5]
            if (not isinstance(claim, dict) or claim.get('jobId') != job or claim.get('schemaVersion') != 1
                    or type(claim.get('rootPid')) is not int or claim['rootPid'] <= 0
                    or not isinstance(claim.get('start'), str) or not claim['start']
                    or not isinstance(claim.get('bootId'), str) or not claim['bootId']
                    or claim.get('startSource') != 'ps-lstart'
                    or not re.fullmatch(r'[0-9a-f]{64}', str(claim.get('ownerWitness', '')))
                    or not re.fullmatch(r'[0-9a-f]{64}', str(claim.get('ownerNonce', '')))):
                continue
            # Any appearance of this PID, including a different birth, is not
            # absence proof. Never retire on a PID-reuse or partial-snapshot guess.
            if claim['rootPid'] in first or claim['rootPid'] in second:
                continue
            with runs_directory(runs) as root:
                current = _attempt_snapshot(root, run, job)
                if current != snapshots[name]:
                    continue
                registered = claim.get('registrationPins')
                if (not isinstance(registered, dict) or set(registered) != {'base','line','dispatched','owner'}
                        or any(value is not None and not re.fullmatch(r'[0-9a-f]{64}', str(value)) for value in registered.values())):
                    continue  # Legacy/invalid provenance is preserved, never guessed.
                pins = _registration_pins(current, job)
                fully_absent = all(pins[key] is None for key in ['base','line','dispatched','owner'])
                if ((pins['line'] != registered['line'] and not fully_absent) or
                        any(pins[key] is not None and pins[key] != registered[key] for key in ['base','dispatched','owner'])):
                    continue
                absent_attempt = (current[job + '.base'] is None and current[job + '.dispatched'] is None
                                  and current['owner'] is None)
                terminal_attempt = current[job + '.dispatched'] is None and _terminal_exit(run, job)
                if not absent_attempt and not terminal_attempt:
                    try:
                        witness = _attempt_binding(_owner_witness(root, run, job, worktree_root),
                                                   claim['rootPid'], claim['start'], claim['bootId'])
                    except (OSError, ValueError):
                        continue
                    if witness != claim.get('ownerWitness'):
                        continue
            latest, latest_identity = read_bytes_at(directory, name, 16384)
            if latest != raw or latest_identity != identity:
                continue
            if not _claim_directory_named(runs, directory):
                raise ValueError('current claim directory changed')
            try:
                os.mkdir('history', 0o700, dir_fd=directory)
            except FileExistsError:
                pass
            history = os.open('history', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            try:
                info = os.fstat(history)
                if not _owned(info, directory=True) or info.st_mode & 0o077:
                    raise ValueError('unsafe claim history')
                target = job + '.' + claim['ownerNonce'] + '.json'
                try:
                    archived = read_json_at(history, target, 16384)
                    if archived != claim:
                        raise ValueError('claim history differs')
                except FileNotFoundError:
                    write_json_at(history, target, claim)
                # Both source writers hold this same directory flock. Re-read
                # the exact current record and metadata before its relative unlink.
                latest, latest_identity = read_bytes_at(directory, name, 16384)
                with runs_directory(runs) as root:
                    unchanged = _attempt_snapshot(root, run, job) == snapshots[name]
                if not unchanged or latest != raw or latest_identity != identity or not _claim_directory_named(runs, directory):
                    continue
                os.unlink(name, dir_fd=directory)
                os.fsync(directory)
                retired += 1
            finally:
                os.close(history)
        return retired


def read_claims(runs):
    with claim_directory(runs) as (_, directory):
        names = []
        with os.scandir(directory) as entries:
            for entry in entries:
                if entry.name == 'history':
                    continue
                names.append(entry.name)
                if len(names) > 256:
                    raise ValueError('session claim inventory exceeds budget')
        result = []
        for name in sorted(names):
            if name.endswith('.json'):
                if not JOB.fullmatch(name[:-5]):
                    raise ValueError('invalid claim filename')
                claim = read_json_at(directory, name, 16384)
                if not isinstance(claim, dict) or claim.get('jobId') != name[:-5]:
                    raise ValueError('claim filename does not match job')
                result.append(claim)
        return result


def verify_current_claim(runs, claim, *, worktree_root=None):
    if not isinstance(claim, dict) or not JOB.fullmatch(str(claim.get('jobId', ''))):
        return False
    try:
        with claim_directory(runs) as (run_directory, directory):
            with runs_directory(runs) as root:
                return (read_json_at(directory, claim['jobId'] + '.json', 16384) == claim
                        and _attempt_binding(_owner_witness(root, run_directory, claim['jobId'], worktree_root),
                                             claim['rootPid'], claim['start'], claim['bootId']) == claim['ownerWitness'])
    except (OSError, ValueError, KeyError):
        return False


def verified_worktrees(runs, worktree_root=None):
    """Return transient scan inputs only for current protected attempts.

    The disk scanner must independently bind and recheck each physical directory.
    Missing or partial custody raises, never creates a healthy empty inventory.
    """
    parent = worktree_root or os.path.expanduser('~/Projects/ashlrai/wt')
    claims = read_claims(runs)
    if not claims:
        raise ValueError('unverified empty worktree inventory')
    result = []
    for claim in claims:
        job = claim['jobId']
        if not verify_current_claim(runs, claim, worktree_root=parent):
            raise ValueError('unverified disk worktree')
        # Root-only legacy witness does not establish a physical worktree.
        with runs_directory(runs) as root:
            raw, _ = read_bytes_at(root, job + '.base', 16384)
        tokens = raw.decode('utf-8', errors='strict').split()
        if len(tokens) != 4 or tokens[2] != os.path.join(parent, job):
            raise ValueError('unverified disk worktree')
        result.append({'job': job, 'path': tokens[2]})
    return result


def collect_and_publish(runs, **dependencies):
    """Actual fixed-file observation path, called by the existing locked tick."""
    try:
        reconcile_closed_claims(runs, census=dependencies.get('census', identity_census),
                                boot=dependencies.get('boot', boot_identity))
        claims = read_claims(runs)
    except (OSError, ValueError):
        claims = None
    observation = collect_observation(claims or [], lambda claim: verify_current_claim(runs, claim),
                                      **dependencies)
    # Claim files are not a complete fleet inventory: zero files cannot prove
    # that no eligible worker exists.
    if not claims:
        observation.update(sessionsState='unknown', sessions=[])
    publish_observation(runs, observation)
    return observation
