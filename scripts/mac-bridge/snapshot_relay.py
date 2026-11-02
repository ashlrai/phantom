#!/usr/bin/env python3
"""Transfer the verified published snapshot to a standby directory.

snapshot_publish stages each generation under its --destination, verifies it,
then flips latest.json — but leaves transport to an external step. This relay
is that step for a plain filesystem destination: it reads the source
publication's latest.json under the existing generation grammar and digest
contract, re-verifies the named generation with state_snapshot.verify_snapshot,
copies only that generation through a private staging directory under
--destination, verifies the copy, then atomically replaces the destination
latest.json via the publisher's own commit path. The destination keeps the
same pointer grammar, so existing readers can consume it. The prior
destination latest.json survives any failure; a repeated identical
publication is a successful no-op. Preview is the default and writes nothing;
--apply performs the transfer. One non-blocking destination lock (the
publisher's lock) serializes competing relays and any publisher on the same
destination. Emits bounded metadata only, never file contents. Filesystem
transport support only — not proof of cross-machine coordinator safety.
"""

import argparse
import json
import os
from pathlib import Path
import shutil
import sys
import time
import uuid

import snapshot_publish
import state_snapshot

TOOL = 'snapshot_relay'
MAX_POINTER_BYTES = 16 * 1024
STAGING_SUFFIX = '.relay-'

EXAMPLE = """\
example with fake directories:
    mkdir -p /tmp/fake-fleet/queue /tmp/fake-fleet/leader /tmp/fake-fleet/metrics \\
        /tmp/fake-snaps /tmp/fake-standby
    python3 snapshot_publish.py --root /tmp/fake-fleet --destination /tmp/fake-snaps --once
    python3 snapshot_relay.py --source /tmp/fake-snaps --destination /tmp/fake-standby
    python3 snapshot_relay.py --source /tmp/fake-snaps --destination /tmp/fake-standby --apply
"""


class RelayError(Exception):
    pass


def check_dirs(source, destination):
    """Resolved (source, destination); refuses symlinks and nested roots."""
    src = Path(source)
    if not src.is_dir() or src.is_symlink():
        raise RelayError('source is not an existing directory')
    src = src.resolve()
    dest = Path(destination)
    if not dest.is_dir() or dest.is_symlink():
        raise RelayError('destination is not an existing directory')
    dest = dest.resolve()
    if state_snapshot.inside(dest, src) or state_snapshot.inside(src, dest):
        raise RelayError('refused: source and destination are nested')
    return src, dest


def read_pointer(store):
    """(generation, manifestSha256) from a bounded nonsymlink latest.json."""
    data, info = state_snapshot.read_regular(store / snapshot_publish.POINTER,
                                             MAX_POINTER_BYTES)
    if data is None:
        raise RelayError(f'latest.json {info}')
    try:
        pointer = json.loads(data)
    except (ValueError, UnicodeError):
        raise RelayError('latest.json is not valid JSON')
    if not isinstance(pointer, dict) or pointer.get('version') != 1 \
            or pointer.get('tool') != snapshot_publish.TOOL:
        raise RelayError('latest.json is not a supported pointer')
    name, digest = pointer.get('generation'), pointer.get('manifestSha256')
    if not isinstance(name, str) or not snapshot_publish.GENERATION.fullmatch(name) \
            or not isinstance(digest, str) \
            or not state_snapshot.DIGEST.fullmatch(digest):
        raise RelayError('latest.json names no verified generation')
    return name, digest


def verified(directory, digest):
    """Require a complete verified generation whose manifest matches digest."""
    check = state_snapshot.verify_snapshot(directory)
    if not check['ok']:
        raise RelayError('generation failed verification')
    if check['manifest'].get('skipped'):
        raise RelayError('generation is incomplete')
    try:
        actual = state_snapshot.sha256_file(directory / state_snapshot.MANIFEST)
    except OSError:
        raise RelayError('generation changed during relay')
    if actual != digest:
        raise RelayError('manifest digest differs from latest.json')
    return check


def already_published(dest, name, digest):
    """True when destination latest.json already selects this verified copy."""
    try:
        current, current_digest = read_pointer(dest)
    except RelayError:
        return False
    if (current, current_digest) != (name, digest):
        return False
    try:
        verified(dest / name, digest)
    except RelayError:
        return False
    return True


def copy_generation(src, dst):
    """Isolated for tests; symlinks are preserved, never followed."""
    shutil.copytree(src, dst, symlinks=True)


def relay(source, destination, apply):
    """Preview or perform the transfer; never touches the prior pointer on failure."""
    src, dest = check_dirs(source, destination)
    lock = snapshot_publish.acquire_lock(dest) if apply else None
    staging = None
    try:
        name, digest = read_pointer(src)
        generation = src / name
        if not state_snapshot.inside(generation.resolve(), src):
            raise RelayError('generation escapes the source store')
        check = verified(generation, digest)
        result = {'tool': TOOL, 'ok': True, 'apply': apply, 'generation': name,
                  'manifestSha256': digest, 'files': check['files']}
        if already_published(dest, name, digest):
            result['noop'] = True
            return result
        result['noop'] = False
        if not apply:
            return result
        result['copied'] = False
        target = dest / name
        if target.exists() or target.is_symlink():
            verified(target, digest)  # verified remnant: adopt, else refuse
        else:
            staging = dest / (name + STAGING_SUFFIX + uuid.uuid4().hex)
            try:
                copy_generation(generation, staging)
            except (OSError, shutil.Error):
                raise RelayError('generation changed during relay')
            verified(staging, digest)  # catches drift, links, extra entries
            os.rename(staging, target)
            staging = None
            state_snapshot.fsync_dir(dest)
            result['copied'] = True
        payload = json.dumps({'version': 1, 'tool': snapshot_publish.TOOL,
                              'generation': name, 'manifestSha256': digest,
                              'files': check['files'], 'published': time.time()},
                             separators=(',', ':')).encode('utf-8')
        snapshot_publish.commit_pointer(dest, payload)
        return result
    finally:
        if staging is not None and staging.is_dir() \
                and not staging.is_symlink():
            shutil.rmtree(staging, ignore_errors=True)
        if lock is not None:
            os.close(lock)


def build_parser():
    parser = argparse.ArgumentParser(
        description=__doc__, epilog=EXAMPLE,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--source', required=True, type=Path,
                        help='existing snapshot_publish destination to read')
    parser.add_argument('--destination', required=True, type=Path,
                        help='existing standby publication directory; must not nest --source')
    parser.add_argument('--apply', action='store_true',
                        help='perform the transfer; default is a preview that writes nothing')
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    os.umask(0o077)
    try:
        result = relay(args.source, args.destination, args.apply)
    except KeyboardInterrupt:
        result = {'tool': TOOL, 'ok': False, 'error': 'interrupted'}
    except (RelayError, snapshot_publish.PublishError, OSError, ValueError) as exc:
        result = {'tool': TOOL, 'ok': False, 'error': str(exc) or 'relay failed'}
    print(json.dumps(result, separators=(',', ':')), flush=True)
    if not result['ok']:
        print(f"{TOOL}: {result['error']}", file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
