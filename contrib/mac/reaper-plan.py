"""Read disk-maint candidates and cache advisory gitlink checks."""
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile


JOB = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}')
AUDIT_JOB = re.compile(r'RQ-[A-Za-z0-9._-]{1,80}')
OID = re.compile(r'(?:[0-9a-f]{40}|[0-9a-f]{64})')
MAX_CACHE = 4 * 1024 * 1024


def valid_job(job):
    return JOB.fullmatch(job) and '..' not in job


def candidates(home, job=None):
    root = home / 'Projects/ashlrai/wt'
    phm = home / '.local/bin/phm'
    args = [str(phm), 'disk-maint', '--json', '--only', 'worktrees-jobs',
            '--home', str(home), '--runs-dir', str(home / '.ashlr-runs'), '--wt-dir', str(root)]
    if job is not None:
        if not valid_job(job):
            raise ValueError('invalid job')
        args += ['--worktree', job]
    env = {'HOME': str(home), 'PATH': f'{phm.parent}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'}
    result = subprocess.run(args, capture_output=True, check=True, timeout=30, env=env)
    plan = json.loads(result.stdout)
    [group] = plan['classes']
    items = group['candidates']
    if (plan['schema'] != 'disk-maint.v1' or plan['apply'] is not False or
            group['id'] != 'worktrees-jobs' or group['complete'] is not True or
            not isinstance(group['reapReasons'], dict) or not isinstance(group['protectReasons'], dict) or
            not isinstance(items, list) or group['reapable'] != len(items)):
        raise ValueError('classifier unavailable')
    selected = set()
    for item in items:
        value = item['path']
        path = home / value[2:] if value.startswith('~/') else Path(value)
        if (item['action'] != 'worktree-remove' or path.parent != root or
                not valid_job(path.name) or (job is not None and job != path.name)):
            raise ValueError('invalid candidate')
        selected.add(path)
    return selected


def read_regular(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ValueError('invalid state file')
        data = stream.read(limit + 1)
        if len(data) > limit:
            raise ValueError('state file too large')
        return data.decode(), info


def identity(worktree, roots):
    try:
        if worktree.resolve(strict=True) != worktree:
            return None
        gitlink, info = read_regular(worktree / '.git', 4096)
        if not gitlink.startswith('gitdir: /'):
            return None
        gitdir = Path(gitlink.rstrip('\n')[8:])
        common = gitdir.parent.parent
        if (gitdir.parent.name != 'worktrees' or common.name != '.git' or
                not (common.parent.parent == roots or common.parent == roots.parent.parent / 'src/weyv') or
                gitdir.resolve(strict=True) != gitdir):
            return None
        head = read_regular(gitdir / 'HEAD', 1024)[0].strip()
        if head.startswith('ref: '):
            ref = head[5:]
            if not re.fullmatch(r'refs/heads/[A-Za-z0-9._/-]+', ref) or any(
                    part in ('', '.', '..') for part in ref.split('/')):
                return None
            refpath = common / ref
            if refpath.resolve(strict=True) != refpath:
                return None
            head = read_regular(refpath, 1024)[0].strip()
        if OID.fullmatch(head):
            return [head, info.st_mtime_ns, info.st_dev, info.st_ino, str(gitdir)]
    except (OSError, RuntimeError, ValueError):
        pass
    return None


def atomic_text(path, value):
    fd, temp = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(value)
        os.replace(temp, path)
    finally:
        if os.path.lexists(temp):
            os.unlink(temp)


def audit(home, state, checker):
    runs = home / '.ashlr-runs'
    roots = home / 'Projects/ashlrai'
    cache = state / 'gitlink-cache.json'
    try:
        previous = json.loads(read_regular(cache, MAX_CACHE)[0])
        previous = previous if isinstance(previous, dict) else {}
    except (OSError, ValueError):
        previous = {}
    # The cache is only for the periodic advisory audit; operation gates still call gs_check.
    complete = True
    try:
        terminal = candidates(home)
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, AttributeError, KeyError):
        terminal = set()
        complete = False
    updated, unsafe = {}, []
    ok = bad = skipped = hits = 0
    for base in sorted(runs.glob('*.base')):
        try:
            if not valid_job(base.stem):
                continue
            row = read_regular(base, 8192)[0].splitlines()[0].split()
            path = Path(row[2])
            if not path.is_dir():
                continue
        except (OSError, ValueError, IndexError):
            continue
        if path.name == base.stem and path in terminal:
            skipped += 1
            continue
        name = str(path)
        key = identity(path, roots)
        saved = updated.get(name, previous.get(name))
        if (complete and key is not None and isinstance(saved, list) and len(saved) == 2 and
                saved[0] == key and type(saved[1]) is bool):
            safe = saved[1]
            hits += 1
        else:
            try:
                result = subprocess.run(['/bin/bash', str(checker), 'check', name],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
                safe = result.returncode == 0
            except (OSError, subprocess.SubprocessError):
                safe, key = False, None
            if key is not None and identity(path, roots) != key:
                safe, key = False, None
        if key is not None:
            updated[name] = [key, safe]
        if safe:
            ok += 1
        else:
            bad += 1
            if AUDIT_JOB.fullmatch(base.stem):
                unsafe.append(base.stem)
    serialized = json.dumps(updated, separators=(',', ':'))
    atomic_text(cache, serialized if len(serialized) <= MAX_CACHE else '{}')
    atomic_text(state / 'gitlink-unsafe.txt', ''.join(job + '\n' for job in unsafe))
    print(f'ok={ok},unsafe={bad},cached={hits},terminal={skipped}')
    return 1 if bad else 0


def main(argv):
    mode, home, *args = argv
    home = Path(home)
    if mode == 'audit' and len(args) == 2:
        return audit(home, Path(args[0]), Path(args[1]))
    if mode != 'plan' or len(args) > 1:
        return 2
    try:
        for candidate in sorted(candidates(home, args[0] if args else None)):
            print(candidate.name)
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, AttributeError, KeyError):
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
