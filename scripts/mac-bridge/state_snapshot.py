#!/usr/bin/env python3
"""Value-blind fleet-state snapshot and restore for a standby machine.

`create --root R --out DIR` copies only the fixed allow list of relative paths,
writes a sha256 manifest last, and publishes DIR by atomic rename. `verify DIR`
fails on any mismatch or unexpected entry. `restore DIR --root TARGET` is a dry
run unless --apply is given, refuses a snapshot that fails verify, and replaces
each file atomically. Nothing but metadata is ever printed: no file contents.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import time
import uuid

ALLOW_LIST = (
    'queue/router-queue.md',
    'queue/ready.tsv',
    'queue/slots.json',
    'leader/VISION.md',
    'leader/ORCHESTRATION.md',
    'metrics/jobs.jsonl',
)
ALLOWED = frozenset(ALLOW_LIST)
MANIFEST = 'manifest.json'
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_MANIFEST_BYTES = 1024 * 1024
DIGEST = re.compile(r'[0-9a-f]{64}\Z')
NOFOLLOW = getattr(os, 'O_NOFOLLOW', 0)


class SnapshotError(Exception):
    pass


def inside(path, root):
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def write_file(path, data, mode):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]
        os.fchmod(fd, mode)
        os.fsync(fd)
    finally:
        os.close(fd)


def fsync_dir(path):
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def read_regular(path, limit):
    """Bytes of a regular file opened without following a final symlink."""
    try:
        fd = os.open(path, os.O_RDONLY | NOFOLLOW)
    except OSError:
        return None, 'unreadable'
    with os.fdopen(fd, 'rb') as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode):
            return None, 'not-a-regular-file'
        if info.st_size > limit:
            return None, 'over-size-limit'
        data = handle.read(limit + 1)
    if len(data) > limit:
        return None, 'over-size-limit'
    return data, info


def stage_file(root, staging, rel):
    src = root / rel
    try:
        info = src.lstat()
    except FileNotFoundError:
        return {'path': rel, 'reason': 'missing'}, None
    except OSError:
        return {'path': rel, 'reason': 'unreadable'}, None
    if stat.S_ISLNK(info.st_mode):
        raise SnapshotError(f'refused: {rel} is a symlink')
    if not inside(src.resolve(), root):
        raise SnapshotError(f'refused: {rel} resolves outside root')
    if not stat.S_ISREG(info.st_mode):
        return {'path': rel, 'reason': 'not-a-regular-file'}, None
    if info.st_size > MAX_FILE_BYTES:
        return {'path': rel, 'reason': 'over-size-limit', 'size': info.st_size}, None
    data, opened = read_regular(src, MAX_FILE_BYTES)
    if data is None:
        return {'path': rel, 'reason': opened}, None
    mode = stat.S_IMODE(info.st_mode)
    dest = staging / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    write_file(dest, data, mode)
    return None, {'path': rel, 'sha256': hashlib.sha256(data).hexdigest(),
                  'size': len(data), 'mode': mode}


def create(root_arg, out_arg):
    root = Path(root_arg)
    if not root.is_dir() or root.is_symlink():
        raise SnapshotError('root is not a directory')
    root = root.resolve()
    out = Path(out_arg)
    if out.exists() or out.is_symlink():
        raise SnapshotError('output path already exists')
    if inside(out.resolve(), root):
        raise SnapshotError('refused: output path inside root')
    out.parent.mkdir(parents=True, exist_ok=True)
    staging = out.parent / (out.name + '.staging-' + uuid.uuid4().hex)
    staging.mkdir()
    files, skipped = [], []
    try:
        for rel in ALLOW_LIST:
            skip, entry = stage_file(root, staging, rel)
            if skip:
                skipped.append(skip)
            else:
                files.append(entry)
        manifest = {'version': 1, 'tool': 'state_snapshot', 'created': time.time(),
                    'files': files, 'skipped': skipped}
        payload = json.dumps(manifest, separators=(',', ':')).encode('utf-8')
        write_file(staging / MANIFEST, payload, 0o644)
        fsync_dir(staging)
        os.rename(staging, out)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    fsync_dir(out.parent)
    return {'ok': True, 'snapshot': str(out), 'files': len(files), 'skipped': skipped}


def load_manifest(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None, ['manifest missing']
    except OSError:
        return None, ['manifest unreadable']
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        return None, ['manifest is not a regular file']
    if info.st_size > MAX_MANIFEST_BYTES:
        return None, ['manifest too large']
    try:
        manifest = json.loads(path.read_bytes())
    except (ValueError, UnicodeError):
        return None, ['manifest is not valid JSON']
    if not isinstance(manifest, dict) or manifest.get('version') != 1:
        return None, ['unsupported manifest']
    files, skipped = manifest.get('files'), manifest.get('skipped', [])
    if not isinstance(files, list) or not isinstance(skipped, list):
        return None, ['malformed manifest']
    errors, seen = [], set()
    for entry in files:
        ok = (isinstance(entry, dict)
              and isinstance(entry.get('path'), str) and entry['path'] in ALLOWED
              and isinstance(entry.get('sha256'), str)
              and DIGEST.fullmatch(entry['sha256'])
              and type(entry.get('size')) is int and entry['size'] >= 0
              and type(entry.get('mode')) is int and 0 <= entry['mode'] <= 0o777)
        if not ok:
            errors.append('malformed manifest entry')
        elif entry['path'] in seen:
            errors.append(f"duplicate path: {entry['path']}")
        else:
            seen.add(entry['path'])
    for entry in skipped:
        if not (isinstance(entry, dict)
                and isinstance(entry.get('path'), str) and entry['path'] in ALLOWED
                and isinstance(entry.get('reason'), str)):
            errors.append('malformed skipped entry')
    if errors:
        return None, errors
    manifest['skipped'] = skipped
    return manifest, []


def sha256_file(path):
    digest = hashlib.sha256()
    fd = os.open(path, os.O_RDONLY | NOFOLLOW)
    with os.fdopen(fd, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def verify_snapshot(directory):
    snap = Path(directory)
    try:
        info = snap.lstat()
    except FileNotFoundError:
        return {'ok': False, 'errors': ['snapshot does not exist']}
    except OSError:
        return {'ok': False, 'errors': ['snapshot unreadable']}
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        return {'ok': False, 'errors': ['snapshot is not a directory']}
    manifest, errors = load_manifest(snap / MANIFEST)
    if manifest is None:
        return {'ok': False, 'errors': errors}
    files = manifest['files']
    for entry in files:
        rel, target = entry['path'], snap / entry['path']
        try:
            info = target.lstat()
        except FileNotFoundError:
            errors.append(f'missing file: {rel}')
            continue
        except OSError:
            errors.append(f'unreadable file: {rel}')
            continue
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            errors.append(f'not a regular file: {rel}')
            continue
        if info.st_size != entry['size']:
            errors.append(f'size mismatch: {rel}')
            continue
        try:
            if sha256_file(target) != entry['sha256']:
                errors.append(f'hash mismatch: {rel}')
        except OSError:
            errors.append(f'unreadable file: {rel}')
    expected_files = {MANIFEST} | {entry['path'] for entry in files}
    expected_dirs = {str(parent) for rel in expected_files
                     for parent in Path(rel).parents if str(parent) != '.'}

    def walk_error(err):
        errors.append(f'unreadable directory: {err.filename}')

    for dirpath, dirnames, filenames in os.walk(snap, followlinks=False,
                                                onerror=walk_error):
        base = Path(dirpath).relative_to(snap)
        for name in dirnames:
            rel = (base / name).as_posix()
            entry = Path(dirpath) / name
            if entry.is_symlink():
                errors.append(f'unexpected symlink: {rel}')
            elif rel not in expected_dirs:
                errors.append(f'unexpected directory: {rel}')
        for name in filenames:
            rel = (base / name).as_posix()
            entry = Path(dirpath) / name
            if entry.is_symlink():
                errors.append(f'unexpected symlink: {rel}')
            elif rel not in expected_files:
                errors.append(f'unexpected file: {rel}')
    return {'ok': not errors, 'errors': errors, 'manifest': manifest,
            'files': len(files), 'skipped': len(manifest['skipped'])}


def restore(directory, root_arg, apply):
    snap = Path(directory)
    check = verify_snapshot(snap)
    if not check['ok']:
        return {'ok': False, 'applied': False, 'planned': [], 'written': [],
                'errors': ['snapshot failed verification'] + check['errors']}
    root = Path(root_arg)
    if apply:
        try:
            root.mkdir(parents=True, exist_ok=True)
        except OSError:
            raise SnapshotError('restore root is not a writable directory')
    if root.exists() and (root.is_symlink() or not root.is_dir()):
        raise SnapshotError('restore root is not a directory')
    root, snap = root.resolve(), snap.resolve()
    if inside(root, snap):
        raise SnapshotError('refused: restore root inside snapshot')
    planned, written, errors = [], [], []
    for entry in check['manifest']['files']:
        rel = entry['path']
        target = root / rel
        if not inside(target.parent.resolve(), root):
            errors.append({'path': rel, 'error': 'target escapes restore root'})
            continue
        if not apply:
            action = 'replace' if target.exists() or target.is_symlink() else 'write'
            planned.append({'path': rel, 'action': action, 'bytes': entry['size']})
            continue
        data, _ = read_regular(snap / rel, entry['size'])
        if data is None or len(data) != entry['size'] \
                or hashlib.sha256(data).hexdigest() != entry['sha256']:
            errors.append({'path': rel, 'error': 'source changed since verify'})
            continue
        existed = target.exists() or target.is_symlink()
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            if not inside(target.parent.resolve(), root):
                errors.append({'path': rel, 'error': 'target escapes restore root'})
                continue
            temp = target.parent / ('.' + target.name + '.tmp-' + uuid.uuid4().hex)
            write_file(temp, data, entry['mode'])
            os.replace(temp, target)
            fsync_dir(target.parent)
            written.append({'path': rel,
                            'action': 'replaced' if existed else 'written'})
        except OSError:
            errors.append({'path': rel, 'error': 'write failed'})
    return {'ok': not errors, 'applied': apply, 'planned': planned,
            'written': written, 'errors': errors}


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='command', required=True)
    create_p = sub.add_parser('create', help='snapshot allow-listed files under --root')
    create_p.add_argument('--root', required=True, help='existing fleet-state directory')
    create_p.add_argument('--out', required=True, help='new snapshot directory path')
    verify_p = sub.add_parser('verify', help='check a snapshot against its manifest')
    verify_p.add_argument('dir', help='snapshot directory')
    restore_p = sub.add_parser('restore', help='write a verified snapshot under --root')
    restore_p.add_argument('dir', help='snapshot directory')
    restore_p.add_argument('--root', required=True, help='target fleet-state directory')
    restore_p.add_argument('--apply', action='store_true',
                           help='actually write; default is a dry run')
    return p


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        if args.command == 'create':
            result = create(args.root, args.out)
        elif args.command == 'verify':
            result = verify_snapshot(args.dir)
        else:
            result = restore(args.dir, args.root, args.apply)
    except (SnapshotError, OSError, ValueError) as exc:
        result = {'ok': False, 'error': str(exc) or 'snapshot operation failed'}
    result.pop('manifest', None)
    print(json.dumps(result, separators=(',', ':')))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
