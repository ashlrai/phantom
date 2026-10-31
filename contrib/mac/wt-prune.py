#!/usr/bin/env python3
"""Reclaim only ignored build directories in quiet, unclaimed run worktrees."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import stat
import subprocess
import sys
import time

QUIET_SECONDS = 20 * 60
INTERVAL_SECONDS = 30 * 60
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


class Hold(Exception):
    """Missing evidence is never permission to delete."""


def protected(name):
    return name.startswith('.codex')


def inside(path, parent):
    return path == parent or parent in path.parents


@contextlib.contextmanager
def opened(root, relative=Path('.')):
    """Open each component without following a symlink, including the root."""
    fd = os.open(root, DIR_FLAGS)
    try:
        for index, part in enumerate(relative.parts):
            if part in ('.', '..') or protected(part) or (index == 0 and part == 'queue'):
                raise Hold('protected-path')
            next_fd = os.open(part, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        yield fd
    finally:
        os.close(fd)


def run(args):
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Hold('inspection-failed') from None
    if result.returncode or result.stderr:
        raise Hold('inspection-failed')
    return result.stdout


def process_cwds():
    if sys.platform == 'darwin':
        # NUL fields preserve spaces and newlines. Never log process arguments.
        data = run(['lsof', '-nP', '-a', '-d', 'cwd', '-F0pn'])
        paths = []
        pid = False
        has_path = False
        for field in data.split(b'\0'):
            field = field.lstrip(b'\n')
            if field.startswith(b'p') and field[1:].isdigit():
                if pid and not has_path:
                    raise Hold('cwd-inventory-incomplete')
                pid = True
                has_path = False
            elif field.startswith(b'n'):
                path = Path(os.fsdecode(field[1:]))
                if not pid or not path.is_absolute():
                    raise Hold('cwd-inventory-invalid')
                # lsof also reports deleted cwd paths. Keep their lexical
                # boundary as a conservative veto without aborting all cleanup.
                paths.append(path.resolve(strict=False))
                has_path = True
        if not paths or (pid and not has_path):
            raise Hold('cwd-inventory-empty')
        return paths
    if sys.platform.startswith('linux'):
        paths = []
        for entry in Path('/proc').iterdir():
            if not entry.name.isdigit():
                continue
            try:
                target = os.readlink(entry / 'cwd')
                # Linux appends this marker for unlinked cwd inodes. Holding
                # the old lexical boundary is conservative if a path is reused.
                if target.endswith(' (deleted)'):
                    target = target[:-10]
                paths.append(Path(target).resolve(strict=False))
            except FileNotFoundError:
                continue  # A process exited (or has no userspace cwd).
        if not paths:
            raise Hold('cwd-inventory-empty')
        return paths
    raise Hold('unsupported-process-inspection')


def no_live_cwd(wt, inventory=None):
    if any(inside(path, wt) for path in (process_cwds() if inventory is None else inventory)):
        raise Hold('live-cwd')


def pid_alive(pid):
    if type(pid) is not int or not 0 < pid <= 2147483647:
        raise Hold('invalid-claim')
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def no_claim(root, wt):
    # The bridge names claims after the canonical worktree basename. PID reuse
    # conservatively holds a tree; cleanup must never evict a possible owner.
    claim_path = root / (wt.name + '.claim')
    try:
        fd = os.open(claim_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 8192 or info.st_nlink != 1:
            raise Hold('invalid-claim')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            claim = json.load(stream)
        validate_owner(claim, wt)
        if pid_alive(claim.get('pid')):
            raise Hold('live-claim')
        if 'supervisor_pid' in claim and pid_alive(claim['supervisor_pid']):
            raise Hold('live-supervisor')
    except (ValueError, TypeError):
        raise Hold('invalid-claim') from None
    finally:
        os.close(fd)


def validate_owner(owner, wt):
    if not isinstance(owner, dict) or owner.get('worktree') != str(wt):
        raise Hold('invalid-owner')
    created = owner.get('created_at')
    if (type(created) not in (int, float) or not 0 <= created <= time.time() or
            not math.isfinite(created) or
            time.time() - created < QUIET_SECONDS or
            not isinstance(owner.get('process_start'), str)):
        raise Hold('invalid-or-recent-owner')
    # Validate even inactive metadata so malformed ownership never qualifies.
    pid_alive(owner.get('pid'))


def no_lock_owner(fd, wt):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_size > 8192 or info.st_nlink != 1:
        raise Hold('invalid-lock')
    if info.st_size:
        try:
            owner = json.loads(os.pread(fd, 8193, 0))
            validate_owner(owner, wt)
            if type(owner.get('active')) is not bool:
                raise Hold('invalid-lock')
            if owner['active'] and pid_alive(owner['pid']):
                raise Hold('live-lock-owner')
        except (ValueError, TypeError):
            raise Hold('invalid-lock') from None


@contextlib.contextmanager
def lease(root, wt):
    # Same persistent inode and hash as scripts/mac-bridge/bridge.py. Do not
    # truncate, rewrite or unlink its ownership metadata or its lock file.
    with opened(root) as root_fd:
        try:
            os.mkdir('locks', mode=0o700, dir_fd=root_fd)
        except FileExistsError:
            pass
        with opened(root, Path('locks')) as locks_fd:
            name = hashlib.sha256(str(wt).encode()).hexdigest() + '.lock'
            fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                         0o600, dir_fd=locks_fd)
            try:
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    raise Hold('invalid-lock')
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                no_lock_owner(fd, wt)
                no_claim(root, wt)
                yield
            finally:
                os.close(fd)


def worktrees(root):
    """Discover physical Git roots only; sidecar paths cannot widen scope."""
    pending = [Path('.')]
    while pending:
        relative = pending.pop()
        with opened(root, relative) as fd:
            entries = sorted(os.listdir(fd))
            if '.git' in entries and relative != Path('.'):
                info = os.stat('.git', dir_fd=fd, follow_symlinks=False)
                if stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode):
                    yield relative
                continue
            for name in entries:
                if ((relative == Path('.') and name == 'queue') or protected(name) or
                        name in ('locks', '.git', 'node_modules', 'target', 'dist', '.turbo')):
                    continue
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode) and info.st_dev == os.fstat(fd).st_dev:
                    pending.append(relative / name)


def scan(wt, cutoff):
    """Check all descendant timestamps; never walk symlinks or nested repos."""
    candidates = []
    with opened(wt) as fd:
        device = os.fstat(fd).st_dev
        def failed_walk(error):
            raise error

        for directory, names, files, walk_fd in os.fwalk(
                '.', follow_symlinks=False, dir_fd=fd, onerror=failed_walk):
            relative = Path(directory)
            info = os.fstat(walk_fd)
            if max(info.st_mtime, info.st_ctime) > cutoff:
                raise Hold('recent-worktree')
            if info.st_dev != device:
                raise Hold('mount-boundary')
            for name in names + files:
                info = os.stat(name, dir_fd=walk_fd, follow_symlinks=False)
                if max(info.st_mtime, info.st_ctime) > cutoff:
                    raise Hold('recent-worktree')
                if protected(name) or (name == '.git' and relative != Path('.')):
                    raise Hold('protected-descendant')
                if (stat.S_ISDIR(info.st_mode) and
                        '.git' not in relative.parts and
                        ((name in ('target', '.turbo', 'dist') and 'node_modules' not in relative.parts) or
                         (name == '.cache' and relative.name == 'node_modules'))):
                    candidates.append(relative / name)
    # Delete outer candidates once, without double-counting nested artifacts.
    return [p for p in candidates if not any(q != p and q in p.parents for q in candidates)]


def ignored_only(wt, relative):
    git = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.excludesFile=/dev/null',
           '-C', str(wt)]
    if run(git + ['rev-parse', '--show-toplevel']).rstrip(b'\n') != os.fsencode(wt):
        raise Hold('git-root-mismatch')
    run(git + ['check-ignore', '-q', '--', str(relative)])
    if run(git + ['--literal-pathspecs', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', str(relative)]):
        raise Hold('source-in-artifact')


def artifact_bytes(fd, device, cutoff):
    total = 0
    info = os.fstat(fd)
    if info.st_dev != device or max(info.st_mtime, info.st_ctime) > cutoff:
        raise Hold('changed-artifact')
    for name in os.listdir(fd):
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if max(info.st_mtime, info.st_ctime) > cutoff:
            raise Hold('changed-artifact')
        if protected(name) or name == '.git' or info.st_dev != device:
            raise Hold('protected-artifact')
        if stat.S_ISDIR(info.st_mode):
            child = os.open(name, DIR_FLAGS, dir_fd=fd)
            try:
                total += artifact_bytes(child, device, cutoff)
            finally:
                os.close(child)
        elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
            total += info.st_blocks * 512
        else:
            raise Hold('linked-or-special-artifact')
    return total


def remove_contents(fd, device, cutoff):
    # All unlinks are relative to non-following descriptors. No shell expansion,
    # shutil.rmtree symlink fallback, or traversal outside the candidate.
    info = os.fstat(fd)
    if info.st_dev != device or max(info.st_mtime, info.st_ctime) > cutoff:
        raise Hold('changed-artifact')
    for name in os.listdir(fd):
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if info.st_dev != device or max(info.st_mtime, info.st_ctime) > cutoff:
            raise Hold('changed-artifact')
        if protected(name) or name == '.git':
            raise Hold('protected-artifact')
        if stat.S_ISDIR(info.st_mode):
            child = os.open(name, DIR_FLAGS, dir_fd=fd)
            try:
                remove_contents(child, device, cutoff)
            finally:
                os.close(child)
            os.rmdir(name, dir_fd=fd)
        elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
            os.unlink(name, dir_fd=fd)
        else:
            raise Hold('linked-or-special-artifact')


def sweep(home, dry_run=False, event_path=None):
    root = home.resolve(strict=True) / '.ashlr-runs'
    freed = planned = removed = held = 0
    if not os.path.lexists(root):
        print('WT_PRUNE freed_bytes=0 would_free_bytes=0 removed=0 held=0')
        return 0
    try:
        selected = [p for p in worktrees(root) if event_path is None or root / p == event_path]
        # One initial inventory, then a fresh snapshot immediately before each
        # eligible tree's removals. Missing/removed event paths need no inspector.
        inventory = process_cwds() if selected else []
        for relative in selected:
            wt = root / relative
            try:
                with lease(root, wt):
                    no_live_cwd(wt, inventory)
                    with opened(root, relative) as wt_fd:
                        device = os.fstat(wt_fd).st_dev
                    cutoff = time.time() - QUIET_SECONDS
                    candidates = scan(wt, cutoff)
                    if not candidates:
                        continue
                    # Validate the complete plan before deleting anything, then
                    # refresh cwd/claims and timestamps after slow Git checks.
                    # Our own removals update ancestor timestamps, so checking
                    # the whole tree between removals would veto itself.
                    for candidate in candidates:
                        ignored_only(wt, candidate)
                        with opened(root, relative / candidate) as fd:
                            artifact_bytes(fd, device, cutoff)
                    no_claim(root, wt)
                    no_live_cwd(wt)
                    scan(wt, cutoff)
                    for candidate in candidates:
                        with opened(root, relative / candidate) as fd:
                            size = artifact_bytes(fd, device, cutoff)
                            if dry_run:
                                planned += size
                                continue
                            with opened(root, (relative / candidate).parent) as parent_fd:
                                identity = os.fstat(fd)
                                current = os.stat(candidate.name, dir_fd=parent_fd, follow_symlinks=False)
                                if (identity.st_dev, identity.st_ino) != (current.st_dev, current.st_ino):
                                    raise Hold('replaced-artifact')
                                remove_contents(fd, identity.st_dev, cutoff)
                                current = os.stat(candidate.name, dir_fd=parent_fd, follow_symlinks=False)
                                if (identity.st_dev, identity.st_ino) != (current.st_dev, current.st_ino):
                                    raise Hold('replaced-artifact')
                                os.rmdir(candidate.name, dir_fd=parent_fd)
                            freed += size
                            removed += 1
            except (Hold, OSError):
                held += 1
    except (Hold, OSError):
        print('WT_PRUNE inspection_failed=1', file=sys.stderr)
        print(f'WT_PRUNE freed_bytes={freed} would_free_bytes={planned} removed={removed} held={held}')
        return 1
    print(f'WT_PRUNE freed_bytes={freed} would_free_bytes={planned} removed={removed} held={held}')
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dry-run', action='store_true', help='inspect only; freed_bytes stays zero')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--watch', action='store_true', help='sweep immediately and every 30 minutes')
    mode.add_argument('--event', choices=['WT_REMOVED'], help='run a guarded event sweep')
    parser.add_argument('worktree', nargs='?', help='optional absolute worktree path for WT_REMOVED')
    args = parser.parse_args()
    if args.worktree and not args.event:
        parser.error('worktree requires --event WT_REMOVED')
    home = Path.home()
    event_path = Path(args.worktree) if args.worktree else None
    if event_path is not None:
        root = home.resolve(strict=True) / '.ashlr-runs'
        if (not event_path.is_absolute() or '..' in event_path.parts or event_path == root or
                not inside(event_path, root) or event_path.relative_to(root).parts[0] == 'queue' or
                any(protected(p) for p in event_path.relative_to(root).parts)):
            parser.error('event worktree must be strictly under ~/.ashlr-runs and outside protected paths')
    try:
        while True:
            next_sweep = time.monotonic() + INTERVAL_SECONDS
            result = sweep(home, args.dry_run, event_path)
            if not args.watch:
                return result
            time.sleep(max(0, next_sweep - time.monotonic()))
    except KeyboardInterrupt:
        return 0


if __name__ == '__main__':
    sys.exit(main())
