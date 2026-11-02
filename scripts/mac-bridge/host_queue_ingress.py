#!/usr/bin/env python3
"""Preview or submit bounded Phantom drop files to the local coordinator."""

import argparse
from contextlib import closing
import json
import os
import re
import sqlite3
import stat
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

import host_queue

JOB_FILE = re.compile(r'(RQ-PHX-[A-Z0-9]{3,40})\.md\Z')
HEADER = re.compile(rb'#job repo=phantom lane=(claude|codex-personal|devin|codex-local) tier=(frontier|work|mid|fast)\Z')
MAX_SCAN = 4096
BATCH = 100


def bounded(maximum):
    def parse(value):
        try:
            number = int(value)
            if 1 <= number <= maximum:
                return number
        except ValueError:
            pass
        raise argparse.ArgumentTypeError('outside allowed range')
    return parse


def snapshot(directory, name):
    """Read a stable, non-symlink regular file relative to the opened directory."""
    try:
        before = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= host_queue.MAX_PAYLOAD:
            return None
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(fd, 'rb') as handle:
            opened = os.fstat(handle.fileno())
            data = handle.read(host_queue.MAX_PAYLOAD + 1)
            after = os.fstat(handle.fileno())
        latest = os.stat(name, dir_fd=directory, follow_symlinks=False)
        def identity(info):
            return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
                    info.st_mtime_ns, info.st_ctime_ns)
        if (identity(before) != identity(opened) or identity(opened) != identity(after)
                or identity(after) != identity(latest) or len(data) != after.st_size):
            return None
        first = data.split(b'\n', 1)[0].removesuffix(b'\r')
        return data if HEADER.fullmatch(first) else None
    except OSError:
        return None


def existing(db_path, job, data):
    # mode=ro cannot create a new database if the coordinator disappears.
    uri = Path(db_path).absolute().as_uri() + '?mode=ro'
    with closing(sqlite3.connect(uri, uri=True, timeout=30, isolation_level=None)) as db:
        db.execute('BEGIN')
        row = db.execute('SELECT payload FROM jobs WHERE job=?', (job,)).fetchone()
        db.execute('COMMIT')
    return None if row is None else ('duplicate' if row[0] == data else 'conflict')


def cycle(args):
    result = {'eligible': [], 'inserted': [], 'duplicate': [], 'conflict': [],
              'deferred': [], 'excluded': 0}
    directory = os.open(args.drop_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        # Refuse oversized directories before submitting anything; never silently truncate.
        with os.scandir(directory) as entries:
            names = []
            for entry in entries:
                names.append(entry.name)
                if len(names) > MAX_SCAN:
                    raise ValueError('scan limit exceeded')
        if args.apply:
            host_queue.database(args.db).close()
        attempts = 0
        for name in sorted(names):
            match = JOB_FILE.fullmatch(name)
            if not match:
                result['excluded'] += 1
                continue
            data = snapshot(directory, name)
            if data is None:
                result['excluded'] += 1
                continue
            job = match.group(1)
            if not args.apply:
                result['eligible'].append(job)
                continue
            state = existing(args.db, job, data)
            if state:
                result[state].append(job)
                continue
            if attempts >= BATCH:
                result['deferred'].append(job)
                continue
            attempts += 1
            # The queue reopens a path, so use a private snapshot, never the drop path.
            with tempfile.TemporaryDirectory(prefix='host-queue-ingress-') as private:
                path = os.path.join(private, 'payload')
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, 'wb') as handle:
                    handle.write(data)
                outcome = host_queue.run(SimpleNamespace(db=args.db, action='enqueue', job=job, payload=path))
            if outcome.get('ok'):
                result['inserted'].append(job)
            elif outcome.get('error') == 'job already exists':
                state = existing(args.db, job, data)
                if state is None:
                    raise ValueError('queue identity disappeared')
                result[state].append(job)
            else:
                raise ValueError('enqueue failed')
        return result
    finally:
        os.close(directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--drop-dir', required=True)
    parser.add_argument('--db', required=True)
    schedule = parser.add_mutually_exclusive_group(required=True)
    schedule.add_argument('--once', action='store_true')
    schedule.add_argument('--cycles', type=bounded(1000))
    parser.add_argument('--interval', type=bounded(3600), default=1, help='seconds between cycles')
    parser.add_argument('--apply', action='store_true', help='submit eligible files')
    args = parser.parse_args()
    failed = False
    try:
        for number in range(1 if args.once else args.cycles):
            if number:
                time.sleep(args.interval)
            result = cycle(args)
            print(json.dumps(result, separators=(',', ':')), flush=True)
            failed |= bool(result['conflict'])
    except (OSError, ValueError, sqlite3.Error, OverflowError):
        print(json.dumps({'error': 'drop scan or coordinator failure'}), flush=True)
        return 1
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
