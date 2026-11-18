#!/usr/bin/env python3
"""Plan conflict recuts from public GitHub data; only --apply writes the queue."""
import argparse
import contextlib
import fcntl
import json
import math
from pathlib import Path
import re
import time
import urllib.request

REPOS = {'phantom': 'P', 'phantom-secrets': 'PS', 'ashlr-plugin': 'AP',
         'ashlr-stack': 'AS', 'locus': 'L', 'lexicon': 'LX', 'ashlr-md': 'AM'}
URL = re.compile(r'https://github\.com/ashlrai/([a-z-]+)/pull/(\d+)\b')
SHA = re.compile(r'[0-9a-f]{40}')


def get_json(path):
    request = urllib.request.Request('https://api.github.com' + path, headers={
        'Accept': 'application/vnd.github+json', 'User-Agent': 'ashlr-recut-feed',
        'X-GitHub-Api-Version': '2022-11-28'})
    # Public GETs only. Never resolve local GitHub credentials.
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)


def fetch_prs(get=get_json):
    prs = []
    for repo in REPOS:
        page = 1
        while True:
            rows = get(f'/repos/ashlrai/{repo}/pulls?state=open&sort=created&direction=asc&per_page=100&page={page}')
            for row in rows:
                detail = get(f'/repos/ashlrai/{repo}/pulls/{int(row["number"])}')
                prs.append(dict(detail, repo=repo))
            if len(rows) < 100:
                break
            page += 1
    return prs


def references(text, repo=None):
    found = {(name, int(number)) for name, number in URL.findall(text)}
    found.update((name, int(number)) for name, number in
                 re.findall(r'\b(?:ashlrai/)?([a-z-]+)#(\d+)\b', text))
    if repo:
        found.update((repo, int(n)) for n in re.findall(r'(?<![\w/])#(\d+)\b', text))
    return found


def plan(prs, queue, maximum, pool=None, empty_jobs=()):
    reference = re.search(r'^- [A-Z-]+ RQ-RC3401N9Q8 \((.*?)\): (.+)$', queue, re.M)
    if not reference:
        raise ValueError('Queue must contain the RQ-RC3401N9Q8 reference line')
    covered = set()
    seen_jobs = set(re.findall(r'^- \S+ (\S+) \(', queue, re.M)) | set(empty_jobs)
    for line in queue.splitlines():
        head = re.search(r'\bsource-head=([0-9a-f]{40})(?=[, )])', line)
        empty = head and re.match(r'^- (DONE-NOOP|EMPTY|EMPTY_DONE|SKIPPED-EMPTY)\b', line)
        if empty or re.match(r'^- (READY|CLAIMED|RUNNING|PR-OPEN)\b', line) or re.search(r'\bSupersedes\b', line, re.I):
            refs = references(line)
            repo = re.search(r'\brepo=(?:ashlrai/)?([a-z-]+)', line)
            if repo:
                refs.update((repo[1], int(n)) for n in re.findall(r'(?:PR\s*#?|#)(\d+)\b', line, re.I))
            # Legacy or ambiguous references conservatively cover every head.
            sha = head[1] if head and len(refs) == 1 else None
            covered.update((name, number, sha) for name, number in refs)
    for pr in prs:
        for line in (pr.get('body') or '').splitlines():
            if re.search(r'\bSupersedes\b', line, re.I):
                covered.update((name, number, None) for name, number in references(line, pr['repo']))
    lines = []
    for pr in sorted(prs, key=lambda p: (p['created_at'], p['repo'], p['number'])):
        repo, number = pr['repo'], pr['number']
        head_info = pr.get('head')
        head = head_info.get('sha') if isinstance(head_info, dict) else None
        if not isinstance(head, str) or not SHA.fullmatch(head):
            continue  # Unknown head is not enough evidence to schedule work.
        job = f'RQ-RCF{REPOS[repo]}{number}Q8-{head.upper()}'
        if (pr.get('state') != 'open' or pr.get('mergeable_state') != 'dirty'
                or (repo, number, None) in covered or (repo, number, head) in covered
                or job in seen_jobs):
            continue
        if len(lines) >= maximum:
            break
        # Copy the leader's reviewed wording rather than invent another recut brief.
        attrs = re.sub(r'\brepo=(?:ashlrai/)?phantom\b', f'repo={repo}', reference[1])
        attrs += f', source-head={head}'
        if pool:
            attrs = (re.sub(r'\bpool=[a-z0-9-]+\b', f'pool={pool}', attrs, count=1)
                     if re.search(r'\bpool=[a-z0-9-]+\b', attrs) else f'{attrs}, pool={pool}')
        text = re.sub(r'\bphantom\b', repo, reference[2])
        text = re.sub(r'\b3401\b', str(number), text)
        lines.append(f'- READY {job} ({attrs}): Observed source head: {head}. '
                     f'Stop and re-observe if the head changed. {text}')
        covered.add((repo, number, head))
    return lines


def read_empty_jobs(queue):
    """Keep proven empty identities even after terminal rows leave the queue."""
    try:
        with (queue.parent.parent / 'metrics/jobs.jsonl').open('rb') as stream:
            stream.seek(0, 2)
            start = max(0, stream.tell() - 16 * 1024 * 1024)
            stream.seek(start)
            if start:
                stream.readline()  # Discard a possibly partial first row.
            rows = stream.read(16 * 1024 * 1024).decode('utf-8', errors='replace').splitlines()
    except FileNotFoundError:
        return set()
    jobs = set()
    for line in rows:
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict) and (row.get('empty') is True or
                row.get('state') in ('EMPTY', 'DONE-NOOP', 'EMPTY_DONE', 'SKIPPED-EMPTY')):
            job = row.get('job') or row.get('job_id') or row.get('jobId')
            if isinstance(job, str):
                jobs.add(job)
    return jobs


@contextlib.contextmanager
def queue_lock(path, timeout):
    with path.open('a') as lock:
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError('ready.lock busy; queue unchanged') from None
                time.sleep(min(0.05, max(0, deadline - time.monotonic())))
        yield


def run(prs, queue, maximum, apply, timeout, pool=None):
    def emit():
        text = queue.read_text()
        lines = plan(prs, text, maximum, pool, read_empty_jobs(queue))
        if apply and lines:
            with queue.open('a') as stream:
                stream.write(('' if not text or text.endswith('\n') else '\n') + '\n'.join(lines) + '\n')
        return {'schemaVersion': 1, 'dryRun': not apply, 'count': len(lines), 'lines': lines}
    if apply:
        with queue_lock(queue.with_name('ready.lock'), timeout):
            return emit()
    return emit()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--dry-run', action='store_true', help='print JSON without writing (default)')
    mode.add_argument('--apply', action='store_true', help='append planned lines under ready.lock')
    parser.add_argument('--max', type=int, default=6, help='maximum lines (default: 6)')
    parser.add_argument('--pool', help='stamp pool=<lane> on every generated line (self-supply)')
    parser.add_argument('--queue', type=Path, default=Path.home() / '.ashlr-runs/queue/router-queue.md')
    parser.add_argument('--lock-timeout', type=float, default=10, help='seconds to wait (default: 10)')
    args = parser.parse_args()
    if args.max < 0 or not math.isfinite(args.lock_timeout) or args.lock_timeout < 0:
        parser.error('--max and --lock-timeout must be nonnegative and finite')
    if args.pool is not None and not re.fullmatch(r'[a-z0-9-]+', args.pool):
        parser.error('--pool must be a lane name (lowercase letters, digits, dashes)')
    try:
        print(json.dumps(run(fetch_prs(), args.queue, args.max, args.apply, args.lock_timeout, args.pool)))
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({'schemaVersion': 1, 'error': type(error).__name__,
                          'message': 'Recut feed failed; no plan applied.'}))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
