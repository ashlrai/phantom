#!/usr/bin/env python3
"""Resolve the publisher's latest.json and launch leader_failover on a pin.

Reads snapshot_publish's latest.json under --snapshot-store, verifies the named
generation, pins it to a private temporary verified copy, then runs the existing
leader_failover supervisor against the pin so pointer rotation or pruning during
selection cannot change restored bytes. Preview default; --apply forwards.
"""

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

import host_lease
import leader_failover
import snapshot_publish
import state_snapshot

TOOL = 'latest_failover'
SUPERVISOR = Path(__file__).resolve().parent / 'leader_failover.py'
MAX_POINTER_BYTES = 16 * 1024


class SelectionError(Exception):
    pass


def read_pointer(store):
    """(generation, manifestSha256) from a bounded nonsymlink latest.json."""
    data, info = state_snapshot.read_regular(store / snapshot_publish.POINTER,
                                             MAX_POINTER_BYTES)
    if data is None:
        raise SelectionError(f'latest.json {info}')
    try:
        pointer = json.loads(data)
    except (ValueError, UnicodeError):
        raise SelectionError('latest.json is not valid JSON')
    if not isinstance(pointer, dict) or pointer.get('version') != 1 \
            or pointer.get('tool') != snapshot_publish.TOOL:
        raise SelectionError('latest.json is not a supported pointer')
    name, digest = pointer.get('generation'), pointer.get('manifestSha256')
    if not isinstance(name, str) or not snapshot_publish.GENERATION.fullmatch(name) \
            or not isinstance(digest, str) \
            or not state_snapshot.DIGEST.fullmatch(digest):
        raise SelectionError('latest.json names no verified generation')
    return name, digest


def verified(directory, digest):
    """Require a complete verified generation whose manifest matches digest."""
    check = state_snapshot.verify_snapshot(directory)
    if not check['ok']:
        raise SelectionError('generation failed verification')
    if check['manifest'].get('skipped'):
        raise SelectionError('generation is incomplete')
    try:
        actual = state_snapshot.sha256_file(directory / state_snapshot.MANIFEST)
    except OSError:
        raise SelectionError('generation changed during selection')
    if actual != digest:
        raise SelectionError('manifest digest differs from latest.json')


def copy_generation(src, dst):
    """Isolated for tests; never follows symlinks found in the store."""
    shutil.copytree(src, dst, symlinks=True)


def pin(store, name, digest, pinned):
    """Private verified copy of the generation, immune to prune/rotation."""
    try:
        copy_generation(store / name, pinned)
    except (OSError, shutil.Error):
        raise SelectionError('generation changed during selection')
    verified(pinned, digest)


def build_parser():
    p = argparse.ArgumentParser(
        description=__doc__,
        epilog='leader_failover options pass through except --snapshot, '
               'which always comes from the verified latest.json selection.')
    p.add_argument('--snapshot-store', required=True, type=Path,
                   help='existing snapshot_publish destination directory')
    p.add_argument('--db', required=True)
    p.add_argument('--host', required=True, type=host_lease.identifier)
    p.add_argument('--primary', required=True, type=host_lease.identifier)
    p.add_argument('--role', required=True, type=host_lease.identifier)
    bounded = leader_failover.bounded
    p.add_argument('--ttl', type=bounded(2, 300), default=None)
    p.add_argument('--grace', type=bounded(0, 300), default=None)
    p.add_argument('--duration', type=bounded(1, 3600), default=None)
    p.add_argument('--attempts', type=bounded(1, 100), default=None)
    p.add_argument('--retry-interval', type=bounded(1, 60), default=None)
    p.add_argument('--restore-root', required=True)
    p.add_argument('--apply', action='store_true')
    p.add_argument('--snapshot', action='store_true', help=argparse.SUPPRESS)
    p.add_argument('command', nargs=argparse.REMAINDER)
    return p


def forward(args, pinned):
    """Supervisor argv: explicit options, pinned snapshot, literal command."""
    argv = [sys.executable, str(SUPERVISOR), '--db', args.db, '--host',
            args.host, '--primary', args.primary, '--role', args.role]
    for name in ('ttl', 'grace', 'duration', 'attempts', 'retry_interval'):
        value = getattr(args, name)
        if value is not None:
            argv += ['--' + name.replace('_', '-'), str(value)]
    argv += ['--snapshot', str(pinned), '--restore-root', args.restore_root]
    if args.apply:
        argv.append('--apply')
    return argv + ['--'] + args.command[1:]


def run_supervisor(argv):
    """Foreground exec boundary; isolated for tests."""
    return subprocess.call(argv)


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.snapshot:
        parser.error('--snapshot is selected from --snapshot-store latest.json')
    if not args.command or args.command[0] != '--' or len(args.command) < 2:
        parser.error('child command must follow --')
    try:
        if args.snapshot_store.is_symlink() or not args.snapshot_store.is_dir():
            raise SelectionError('snapshot store is not an existing directory')
        store = args.snapshot_store.resolve()
        name, digest = read_pointer(store)
        if not state_snapshot.inside((store / name).resolve(), store):
            raise SelectionError('generation escapes the snapshot store')
        verified(store / name, digest)
        with tempfile.TemporaryDirectory(prefix='latest-failover-') as temp:
            pinned = Path(temp) / name
            pin(store, name, digest, pinned)
            print(json.dumps({'tool': TOOL, 'generation': name, 'pinned': True},
                             separators=(',', ':')), file=sys.stderr, flush=True)
            try:
                return run_supervisor(forward(args, pinned))
            except KeyboardInterrupt:
                return 1
    except (SelectionError, OSError) as exc:
        print(f'{TOOL}: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
