#!/usr/bin/env python3
"""Bounded historical worktree attribution; never a free-capacity signal.

Caller owns serialization and scheduling under its existing lock. Paths are input
only and are never returned. node_modules is excluded, as copied/shared extents
cannot be attributed uniquely. st_blocks remains an allocated-byte estimate.
"""
import math
import os
import stat
import time

CADENCE_SECONDS = 300
MAX_AGE_SECONDS = 900
MAX_ENTRIES = 10000
MAX_SECONDS = 2.0
MAX_ROOTS = 64


class Unsafe(Exception):
    pass


def _open_root(path):
    # Walk every component through directory descriptors; no symlink may be
    # substituted between path validation and open.
    if not os.path.isabs(path):
        raise Unsafe()
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.split('/'):
            if not part:
                continue
            if part in ('.', '..'):
                raise Unsafe()
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            info = os.fstat(child)
            named = os.stat(part, dir_fd=fd, follow_symlinks=False)
            trusted = info.st_uid in (0, os.getuid())
            sticky = info.st_uid == 0 and info.st_mode & stat.S_ISVTX
            if (not trusted or (info.st_mode & 0o022 and not sticky) or
                    (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino)):
                os.close(child)
                raise Unsafe()
            os.close(fd)
            fd = child
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise Unsafe()
        return fd, info
    except BaseException:
        os.close(fd)
        raise


def _scan(fd, root_info, max_entries, deadline):
    count, total = 0, 0
    seen = set()
    def walk(directory):
        nonlocal count, total
        with os.scandir(directory) as entries:
            for entry in entries:
                count += 1
                if count > max_entries or time.monotonic() > deadline:
                    raise Unsafe()
                if entry.name == 'node_modules':
                    continue
                before = entry.stat(follow_symlinks=False)
                if stat.S_ISLNK(before.st_mode):
                    continue
                if before.st_dev != root_info.st_dev or before.st_uid != os.getuid():
                    raise Unsafe()
                ident = (before.st_dev, before.st_ino)
                if ident in seen:
                    continue
                seen.add(ident)
                if stat.S_ISDIR(before.st_mode):
                    if before.st_mode & 0o022:
                        raise Unsafe()
                    child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                    try:
                        actual = os.fstat(child)
                        if (actual.st_dev, actual.st_ino) != ident:
                            raise Unsafe()
                        total += actual.st_blocks * 512
                        walk(child)
                        after = os.stat(entry.name, dir_fd=directory, follow_symlinks=False)
                        if (after.st_dev, after.st_ino) != ident:
                            raise Unsafe()
                    finally:
                        os.close(child)
                elif stat.S_ISREG(before.st_mode):
                    file_fd = os.open(entry.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                    try:
                        actual = os.fstat(file_fd)
                        after = os.stat(entry.name, dir_fd=directory, follow_symlinks=False)
                        if (not stat.S_ISREG(actual.st_mode) or
                                (actual.st_dev, actual.st_ino) != ident or
                                (after.st_dev, after.st_ino) != ident):
                            raise Unsafe()
                        total += actual.st_blocks * 512
                    finally:
                        os.close(file_fd)
                else:
                    raise Unsafe()
    total = root_info.st_blocks * 512
    walk(fd)
    return total


def refresh(roots, previous=None, now=None, cadence=CADENCE_SECONDS,
            max_age=MAX_AGE_SECONDS, max_entries=MAX_ENTRIES, max_seconds=MAX_SECONDS):
    """Return per-job history. Errors, incomplete scans, and future times are unknown.

    Reuse before cadence is based only on elapsed time and identity, never mtime.
    Results represent historical worktree attribution, not current free space.
    """
    now = time.time() if now is None else now
    if not isinstance(now, (int, float)) or not math.isfinite(now):
        return []
    previous = previous if isinstance(previous, list) else []
    old = {r.get('job'): r for r in previous if isinstance(r, dict) and isinstance(r.get('job'), str)}
    rows = []
    if not isinstance(roots, list) or len(roots) > MAX_ROOTS:
        return rows
    seen_jobs = set()
    deadline = time.monotonic() + max_seconds
    for root in roots:
        if not isinstance(root, dict):
            continue
        job, path = root.get('job'), root.get('path')
        if not isinstance(job, str) or not job or len(job) > 128 or job in seen_jobs or not isinstance(path, str):
            continue
        seen_jobs.add(job)
        row = {'job': job, 'state': 'unknown', 'sampledAt': None, 'allocatedBytes': None,
               'identity': None, 'attemptedAt': None, 'excludesNodeModules': True}
        fd = None
        try:
            fd, info = _open_root(path)
            identity = [info.st_dev, info.st_ino]
            row['identity'] = identity
            prev = old.get(job, {})
            sampled = prev.get('sampledAt')
            size = prev.get('allocatedBytes')
            valid = (prev.get('identity') == identity and isinstance(sampled, (int, float))
                     and math.isfinite(sampled) and sampled <= now and isinstance(size, int)
                     and not isinstance(size, bool) and size >= 0)
            attempted = prev.get('attemptedAt')
            recent_failure = (prev.get('identity') == identity and prev.get('state') in ('unknown', 'stale')
                              and isinstance(attempted, (int, float)) and not isinstance(attempted, bool)
                              and math.isfinite(attempted) and 0 <= now - attempted < cadence)
            if (prev.get('identity') == identity and (
                    isinstance(sampled, (int, float)) and math.isfinite(sampled) and sampled > now or
                    isinstance(attempted, (int, float)) and math.isfinite(attempted) and attempted > now)):
                row['state'] = 'future'
            elif recent_failure:
                row.update(attemptedAt=attempted)
                if valid:
                    row.update(sampledAt=sampled, allocatedBytes=size, state='stale')
            elif valid and now - sampled < cadence:
                row.update(sampledAt=sampled, allocatedBytes=size, attemptedAt=prev.get('attemptedAt'),
                           state='historical' if now - sampled <= max_age else 'stale')
            else:
                row['attemptedAt'] = now
                measured = _scan(fd, info, max_entries, deadline)
                check_fd, check = _open_root(path)
                os.close(check_fd)
                if (check.st_dev, check.st_ino) != tuple(identity):
                    raise Unsafe()
                row.update(sampledAt=now, allocatedBytes=measured, state='historical')
        except (OSError, Unsafe, RecursionError, ValueError):
            # Preserve trusted prior history for the same physical root; do not
            # recast a failed refresh as current or free capacity.
            if fd is not None and 'valid' in locals() and valid:
                try:
                    check_fd, check = _open_root(path)
                    os.close(check_fd)
                    if (check.st_dev, check.st_ino) == tuple(identity):
                        row.update(sampledAt=sampled, allocatedBytes=size, state='stale')
                except (OSError, Unsafe, ValueError):
                    pass
        finally:
            if fd is not None:
                os.close(fd)
            valid = False
        rows.append(row)
    return rows


def refresh_persisted(directory, roots, read_json_at, write_json_at, now=None, **options):
    """Refresh under the caller's existing tick lock; cache is private history only.

    The source-owned bounded descriptor reader and atomic writer are injected by
    the runtime. An unsafe cache is never overwritten or treated as empty.
    """
    name = 'resource-session-disk-cache.json'
    try:
        cache = read_json_at(directory, name)
    except FileNotFoundError:
        cache = {'schemaVersion': 1, 'rows': []}
    if (not isinstance(cache, dict) or cache.get('schemaVersion') != 1
            or not isinstance(cache.get('rows'), list) or len(cache['rows']) > MAX_ROOTS):
        raise ValueError('invalid disk cache')
    rows = refresh(roots, cache['rows'], now=now, **options)
    write_json_at(directory, name, {'schemaVersion': 1, 'rows': rows})
    return rows
