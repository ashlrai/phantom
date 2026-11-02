#!/usr/bin/env python3
"""Foreground periodic publisher of verified fleet-state snapshots.

Each cycle stages a uniquely named generation under --destination via
state_snapshot.create, verifies it with state_snapshot.verify_snapshot and,
only when complete and valid, atomically replaces a small latest.json pointer
with the generation name and manifest digest. Readers always observe either
the previous verified generation or the new verified one; a failed or partial
publication leaves the old pointer untouched. One non-blocking lock prevents
overlapping publishers. Emits metadata only, never file contents.
"""

import argparse
import fcntl
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import sys
import threading
import time
import uuid

import state_snapshot

TOOL, POINTER, LOCK_NAME = 'snapshot_publish', 'latest.json', 'publisher.lock'
GENERATION = re.compile(r'snap-\d{8}T\d{6}Z-[0-9a-f]{8}\Z')
STAGING = re.compile(r'snap-\d{8}T\d{6}Z-[0-9a-f]{8}\.staging-[0-9a-f]{32}\Z')
POINTER_TMP = re.compile(r'latest\.json\.[0-9a-f]{32}\.tmp\Z')
MIN_INTERVAL, MAX_INTERVAL, MIN_RETAIN, MAX_RETAIN = 1.0, 3600.0, 1, 64

EXAMPLE = """\
example with a fake fleet-state tree:
    mkdir -p /tmp/fake-fleet/queue /tmp/fake-fleet/leader /tmp/fake-fleet/metrics /tmp/snaps
    python3 snapshot_publish.py --root /tmp/fake-fleet --destination /tmp/snaps --once

note: --destination stays on this host; copying it to a standby machine is an
external transport step (rsync, file share) this tool does not perform.
"""


class PublishError(Exception):
    pass


def acquire_lock(dest):
    """Non-blocking exclusive publisher lock, held for the process lifetime."""
    fd = os.open(dest / LOCK_NAME, os.O_RDWR | os.O_CREAT | state_snapshot.NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise PublishError('unsafe publisher lock file')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise PublishError(f'another publisher holds {dest / LOCK_NAME}')
    except BaseException:
        os.close(fd)
        raise
    return fd


def sweep_staging(dest):
    """Remove only this publisher's own interrupted-work remnants."""
    for entry in dest.iterdir():
        if POINTER_TMP.fullmatch(entry.name) and entry.is_file() \
                and not entry.is_symlink():
            entry.unlink(missing_ok=True)
        elif STAGING.fullmatch(entry.name) and entry.is_dir() \
                and not entry.is_symlink():
            shutil.rmtree(entry, ignore_errors=True)


def generations(dest):
    """Generations this publisher created (pattern + manifest), oldest first."""
    found = []
    for entry in dest.iterdir():
        if not GENERATION.fullmatch(entry.name) or entry.is_symlink() \
                or not entry.is_dir():
            continue
        try:
            manifest = json.loads((entry / state_snapshot.MANIFEST).read_bytes())
        except (OSError, ValueError, UnicodeError):
            continue
        if isinstance(manifest, dict) and manifest.get('tool') == 'state_snapshot':
            created = manifest.get('created', 0)
            found.append((created if type(created) in (int, float) else 0, entry))
    return [e for _, e in sorted(found, key=lambda p: (p[0], p[1].name))]


def prune(dest, keep_name, retain):
    """Delete only surplus prior generations this publisher itself created."""
    priors = [g for g in generations(dest) if g.name != keep_name]
    victims = priors[:max(0, len(priors) - retain)]
    for victim in victims:
        shutil.rmtree(victim)
    return [v.name for v in victims]


def commit_pointer(dest, payload):
    """Atomically replace latest.json via exclusive temp file and rename."""
    temp = dest / (POINTER + '.' + uuid.uuid4().hex + '.tmp')
    try:
        state_snapshot.write_file(temp, payload, 0o600)
        os.replace(temp, dest / POINTER)
        state_snapshot.fsync_dir(dest)
    finally:
        temp.unlink(missing_ok=True)


def adopt(dest, name):
    """Verify a generation and flip latest.json; refuses incomplete snapshots."""
    check = state_snapshot.verify_snapshot(dest / name)
    if not check['ok']:
        return {'ok': False, 'stage': 'verify', 'errors': check['errors']}
    skipped = check['manifest'].get('skipped')
    if skipped:
        return {'ok': False, 'stage': 'incomplete', 'skipped': skipped}
    digest = state_snapshot.sha256_file(dest / name / state_snapshot.MANIFEST)
    pointer = {'version': 1, 'tool': TOOL, 'generation': name,
               'manifestSha256': digest, 'files': check['files'],
               'published': time.time()}
    commit_pointer(dest, json.dumps(pointer, separators=(',', ':')).encode('utf-8'))
    return {'ok': True, 'files': check['files'], 'manifestSha256': digest}


class Publisher:
    def __init__(self, root, destination, interval, retain):
        root = Path(root)
        if not root.is_dir() or root.is_symlink():
            raise PublishError('root is not a directory')
        self.root = root.resolve()
        dest = Path(destination)
        if not dest.is_dir() or dest.is_symlink():
            raise PublishError('destination is not an existing directory')
        self.dest = dest.resolve()
        if state_snapshot.inside(self.dest, self.root):
            raise PublishError('refused: destination inside root')
        self.interval, self.retain = interval, retain
        self.count, self.published, self.stop = 0, 0, False
        self.wake = threading.Event()

    def cycle(self):
        self.count += 1
        name = 'snap-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) \
               + '-' + uuid.uuid4().hex[:8]
        gen, created = self.dest / name, None
        try:
            sweep_staging(self.dest)
            created = state_snapshot.create(self.root, gen)
            outcome = adopt(self.dest, name)
            if outcome['ok']:
                outcome['pruned'] = prune(self.dest, name, self.retain)
        except (state_snapshot.SnapshotError, OSError, ValueError) as exc:
            outcome = {'ok': False, 'error': str(exc) or 'publish failed'}
        if not outcome['ok']:
            if not gen.is_symlink() and gen.is_dir():  # only this cycle's own gen
                shutil.rmtree(gen, ignore_errors=True)
            report = {'cycle': self.count, 'ok': False}
            for key in ('errors', 'error', 'skipped'):
                value = outcome.get(key) or (created or {}).get(key)
                if value:
                    report[key] = value
            return report
        self.published += 1
        return {'cycle': self.count, 'ok': True, 'generation': name,
                'files': outcome['files'],
                'manifestSha256': outcome['manifestSha256'],
                'pruned': outcome['pruned']}

    def run(self, max_cycles=None):
        while not self.stop:
            print(json.dumps(self.cycle(), separators=(',', ':')), flush=True)
            if max_cycles is not None and self.count >= max_cycles:
                break
            self.wake.wait(self.interval)
        return self.published


def build_parser():
    parser = argparse.ArgumentParser(
        description=__doc__, epilog=EXAMPLE,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--root', required=True, type=Path,
                        help='existing fleet-state directory to snapshot')
    parser.add_argument('--destination', required=True, type=Path,
                        help='existing trusted snapshot directory; must be outside --root')
    parser.add_argument('--interval', type=float, default=60.0,
                        help=f'seconds between cycles, {MIN_INTERVAL:g}..{MAX_INTERVAL:g} (default 60)')
    limit = parser.add_mutually_exclusive_group()
    limit.add_argument('--once', action='store_true',
                       help='publish exactly one cycle and exit')
    limit.add_argument('--max-cycles', type=int, default=None,
                       help='publish at most N cycles then exit')
    parser.add_argument('--retain', type=int, default=3,
                        help=f'prior generations kept after each publication, {MIN_RETAIN}..{MAX_RETAIN} (default 3)')
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if not math.isfinite(args.interval) \
            or not MIN_INTERVAL <= args.interval <= MAX_INTERVAL:
        parser.error(f'--interval must be between {MIN_INTERVAL:g} and {MAX_INTERVAL:g} seconds')
    if args.max_cycles is not None and args.max_cycles < 1:
        parser.error('--max-cycles must be a positive integer')
    if not MIN_RETAIN <= args.retain <= MAX_RETAIN:
        parser.error(f'--retain must be between {MIN_RETAIN} and {MAX_RETAIN}')
    os.umask(0o077)
    try:
        publisher = Publisher(args.root, args.destination, args.interval, args.retain)
        lock = acquire_lock(publisher.dest)
    except (PublishError, OSError, ValueError) as exc:
        print(f'{TOOL}: {exc}', file=sys.stderr)
        return 1

    def halt(signum, frame):
        publisher.stop = True
        publisher.wake.set()

    signal.signal(signal.SIGINT, halt)
    signal.signal(signal.SIGTERM, halt)
    try:
        published = publisher.run(1 if args.once else args.max_cycles)
    finally:
        os.close(lock)
    print(json.dumps({'tool': TOOL, 'cycles': publisher.count,
                      'published': published, 'stopped': publisher.stop},
                     separators=(',', ':')), flush=True)
    return 0 if published else 1


if __name__ == '__main__':
    sys.exit(main())
