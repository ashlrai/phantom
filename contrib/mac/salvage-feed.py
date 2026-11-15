#!/usr/bin/env python3
"""Plan salvage jobs for retained, dirty worktrees; apply only appends to the queue."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]*$')


def git(path, *args):
    return subprocess.check_output(['git', '-C', str(path), *args], stderr=subprocess.DEVNULL,
                                   env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'})


def plan(status, root, queue, pool, maximum):
    ids = status['kept_worktrees']
    if not isinstance(ids, list) or any(not isinstance(i, str) or not ID.fullmatch(i) for i in ids):
        raise ValueError('invalid kept_worktrees')
    covered = '\n'.join(line for line in queue.splitlines() if re.match(r'^\s*-\s+(READY|CLAIMED)\b', line) or re.search(r'\bSupersedes\b', line, re.I))
    candidates = []
    for job in set(ids):
        path = root / job
        if not path.is_dir() or re.search(r'(?<![\w-])' + re.escape(job) + r'(?![\w-])', covered):
            continue
        try:
            # NUL records keep unusual filenames out of the generated queue.
            changed = git(path, 'diff', '--name-only', '-z', 'HEAD').split(b'\0')[:-1]
            untracked = git(path, 'ls-files', '--others', '--exclude-standard', '-z').split(b'\0')[:-1]
            if not changed and not untracked:
                continue
            remote = git(path, 'remote', 'get-url', 'origin').decode().strip()
            match = re.search(r'(?:github\.com[:/])ashlrai/([A-Za-z0-9_.-]+?)(?:\.git)?$', remote)
            if not match:
                continue
            stats = git(path, 'diff', '--numstat', 'HEAD').decode('utf-8', 'replace').splitlines()
            lines = sum(int(n) for row in stats for n in row.split('\t')[:2] if n.isdigit())
            # Count untracked content without displaying it or following symlinks.
            for name in untracked:
                p = path / os.fsdecode(name)
                if p.is_file() and not p.is_symlink():
                    with p.open('rb') as f:
                        lines += sum(1 for _ in f)
            candidates.append((path.stat().st_mtime, job, match[1], len(set(changed + untracked)), lines))
        except (OSError, subprocess.CalledProcessError, UnicodeError):
            continue
    result = []
    for _, job, repo, files, lines in sorted(candidates)[:maximum]:
        short = hashlib.sha256(job.encode()).hexdigest()[:10].upper()
        result.append(f'- READY RQ-SV{short}Q8 (P1, pool={pool}, tier=work, repo={repo}, size<=250, src=leader): Salvage retained worktree {job}; review its uncommitted changes ({files} files, {lines} lines), complete and validate the work.')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--dry-run', action='store_true')
    mode.add_argument('--apply', action='store_true')
    parser.add_argument('--pool', required=True)
    parser.add_argument('--max', type=int, default=6)
    parser.add_argument('--status', type=Path, default=Path.home() / '.ashlr-runs/queue/status.json')
    parser.add_argument('--queue', type=Path, default=Path.home() / '.ashlr-runs/queue/router-queue.md')
    parser.add_argument('--worktrees', type=Path, default=Path.home() / 'Projects/ashlrai/wt')
    args = parser.parse_args()
    if args.max < 0 or not ID.fullmatch(args.pool):
        parser.error('invalid --max or --pool')
    try:
        status = json.loads(args.status.read_text())
        def run():
            text = args.queue.read_text()
            lines = plan(status, args.worktrees, text, args.pool, args.max)
            if args.apply and lines:
                with args.queue.open('a') as f:
                    f.write(('' if not text or text.endswith('\n') else '\n') + '\n'.join(lines) + '\n')
            return lines
        if args.apply:
            with args.queue.with_name('ready.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                lines = run()
        else:
            lines = run()
        print(json.dumps({'schemaVersion': 1, 'dryRun': not args.apply, 'count': len(lines), 'lines': lines}))
    except (OSError, ValueError, KeyError, TypeError):
        print(json.dumps({'schemaVersion': 1, 'error': 'Salvage feed failed; no plan applied.'}))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
