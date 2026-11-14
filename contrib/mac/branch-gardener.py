#!/usr/bin/env python3
"""Audit remote branches; delete proven disposable refs only with --apply. See docs/BRANCH-GARDENER.md."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from collections import Counter
from functools import lru_cache
import fcntl
import fnmatch
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

REPOS = ('phantom', 'phantom-secrets', 'locus', 'lexicon', 'ashlr-md',
         'ashlr-stack', 'ashlr-plugin', 'binshield', '.github')
HOLDS = {'phantom': {197, 878, 743, 725, 738, 744, 693, 1228},
         'phantom-secrets': {140, 197, 375, 168, 418, 136}, 'ashlr-plugin': {152, 157}}
SECURITY = re.compile(r'(^|[-_/])(sec|security|pin|pinned|hold)([-_/]|$)', re.I)
SHA = re.compile(r'^[0-9a-f]{40}$')
REF = re.compile(r'^[^\x00-\x20\x7f~^:?*\[\\]+$')


class Refused(Exception):
    """A fixed diagnostic, never child-process output or credential-bearing text."""


def require(ok, reason):
    if not ok:
        raise Refused(reason)


def command(args, cwd=None, allowed=(0,)):
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env.update(GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_SYSTEM='/dev/null',
               GIT_TERMINAL_PROMPT='0', GIT_NO_REPLACE_OBJECTS='1', GH_PROMPT_DISABLED='1')
    try:
        result = subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True,
                                stdin=subprocess.DEVNULL, timeout=180)
    except (OSError, subprocess.SubprocessError):
        raise Refused('command-unavailable-or-timeout') from None
    require(result.returncode in allowed, 'command-failed')
    return result


def git(directory, *args, allowed=(0,)):
    return command(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
                    '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
                    '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
                    *args], cwd=directory, allowed=allowed)


def api(endpoint):
    try:
        return json.loads(command(['gh', 'api', '--hostname', 'github.com', endpoint]).stdout)
    except ValueError:
        raise Refused('invalid-api-json') from None


def pages(endpoint):
    for page in range(1, 1001):
        batch = api(f'{endpoint}&per_page=100&page={page}')
        require(isinstance(batch, list), 'invalid-api-page')
        yield from batch
        if len(batch) < 100:
            return
    raise Refused('pagination-limit')


def branches(repository):
    rows = pages(f'repos/{repository}/branches?')
    out = {}
    for row in rows:
        name, sha = row['name'], row['commit']['sha']
        require(isinstance(name, str) and REF.fullmatch(name) and '..' not in name
                and SHA.fullmatch(sha) and isinstance(row['protected'], bool), 'invalid-branch')
        require(name not in out, 'unstable-branch-pagination')
        out[name] = {'sha': sha, 'protected': row['protected']}
    return out


def pulls(repository, state='all'):
    out = []
    for row in pages(f'repos/{repository}/pulls?state={state}&sort=created&direction=asc'):
        head = row['head']
        require(row['state'] in ('open', 'closed') and type(row['number']) is int
                and row['number'] > 0 and SHA.fullmatch(head['sha'])
                and isinstance(head['ref'], str), 'invalid-pr')
        out.append({'number': row['number'], 'state': row['state'], 'sha': head['sha'],
                    'branch': head['ref'], 'repo': head['repo']['full_name'].lower() if head['repo'] else None,
                    'base': repository, 'merged': bool(row['merged_at'])})
    return out


def metadata(repository):
    row = api(f'repos/{repository}')
    require(row['full_name'].lower() == repository.lower(), 'repository-identity-mismatch')
    name = row['default_branch']
    require(isinstance(name, str) and REF.fullmatch(name) and '..' not in name, 'invalid-default')
    return name


def contents(path):
    require(not path.is_symlink(), 'symlinked-safety-evidence')
    require(path.stat().st_size <= 1024 * 1024, 'oversize-safety-evidence')
    return path.read_text()


def children(path):
    try:
        require(not path.is_symlink(), 'symlinked-safety-directory')
        return list(path.iterdir())
    except FileNotFoundError:
        return []


def active_branches(projects, runs, wt_roots):
    """Conservative union across repos: records, existing wt dirs and registered HEADs."""
    names, tips, gitdirs = set(), set(), set()

    def checkout(path):
        dot = path / '.git'
        if dot.is_file():
            link = contents(dot).strip()
            require(link.startswith('gitdir: '), 'invalid-worktree-gitlink')
            gitdirs.add((path / link[8:]).resolve())
        elif dot.is_dir():
            require(not dot.is_symlink(), 'symlinked-git-directory')
            gitdirs.add(dot)

    for repo in REPOS:
        checkout(projects / repo)
    for root in [*wt_roots, runs]:
        for path in children(root):
            if path.is_dir():
                if root != runs:
                    names.add('codex-bridge/' + path.name)
                checkout(path)
    for path in children(runs):
        if path.name.endswith('.base'):
            fields = contents(path).split()
            require(len(fields) >= 4, 'invalid-run-base')
            names.add(fields[1])
            names.add('codex-bridge/' + path.name[:-5])
            checkout(Path(fields[2]))
    for path in children(runs / 'queue/run'):
        if path.suffix in ('.line', '.dispatched', '.batched', '.reaping'):
            names.add('codex-bridge/' + path.stem)
    keep = runs / 'queue/keep.txt'
    if keep.exists():
        names.update('codex-bridge/' + job for job in contents(keep).split())
    for directory in list(gitdirs):
        common = directory / 'commondir'
        if common.exists():
            gitdirs.add((directory / contents(common).strip()).resolve())
    for directory in list(gitdirs):
        gitdirs.update(children(directory / 'worktrees'))
    for directory in gitdirs:
        head = contents(directory / 'HEAD').strip()
        if head.startswith('ref: refs/heads/'):
            names.add(head[16:])
        else:
            require(SHA.fullmatch(head), 'invalid-worktree-head')
            tips.add(head)
    return names, tips


def protected(name, branch, defaults, active, pins):
    return (name in defaults or name in ('main', 'master') or branch['protected']
            or name in active[0] or branch['sha'] in active[1] or SECURITY.search(name)
            or any(fnmatch.fnmatchcase(name, pattern) for pattern in pins))


def classify(name, branch, prs, repository, defaults, active, pins, ancestor, stale_empty):
    row = {'branch': name, 'sha': branch['sha'], 'action': 'keep', 'reason': 'protected'}
    if protected(name, branch, defaults, active, pins):
        return row
    matching = [pr for pr in prs if pr['repo'] in (repository, None) and pr['branch'] == name]
    if any(pr['number'] in HOLDS.get(pr['base'].split('/')[1], set()) for pr in matching):
        row['reason'] = 'held-pr'
    elif any(pr['state'] == 'open' for pr in matching):
        row['reason'] = 'open-pr'
    elif any(pr['sha'] == branch['sha'] for pr in matching):
        pr = next(pr for pr in matching if pr['sha'] == branch['sha'])
        row.update(action='delete', reason='merged-pr' if pr['merged'] else 'closed-pr', pr=pr)
    elif matching:
        row.update(action='flag', reason='tip-changed-after-pr')
    elif ancestor(branch['sha']):
        row.update(action='delete', reason='ancestor-of-default')
    elif stale_empty(branch['sha']):
        row.update(action='delete', reason='stale-no-unique-commits')
    else:
        row.update(action='flag', reason='pr-less-unique-or-recent')
    return row


def verify_pr_refs(directory, rows):
    groups = {}
    for i, row in enumerate(rows):
        if row.get('pr'):
            groups.setdefault(row['pr']['base'], []).append((row, 'refs/gardener/pr/' + str(i)))
    for source, entries in groups.items():
        for start in range(0, len(entries), 100):
            batch = entries[start:start + 100]
            git(directory, 'fetch', '--quiet', '--no-tags', '--no-recurse-submodules',
                f'https://github.com/{source}.git',
                *[f"refs/pull/{row['pr']['number']}/head:{dest}" for row, dest in batch])
            saved = git(directory, 'rev-parse', *[dest for _, dest in batch]).stdout.splitlines()
            require(saved == [row['sha'] for row, _ in batch], 'pr-ref-does-not-preserve-tip')


def delete_batch(directory, url, rows):
    leases = ['--force-with-lease=refs/heads/' + row['branch'] + ':' + row['sha'] for row in rows]
    # Atomic plus explicit old-OID leases: any moved tip refuses the entire batch.
    git(directory, 'push', '--porcelain', '--atomic', *leases, url, '--delete',
        *['refs/heads/' + row['branch'] for row in rows])


def journal(runs, row):
    path = runs / 'metrics/branch-gardener.jsonl'
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        stream.write(json.dumps(row, sort_keys=True) + '\n')
        stream.flush()
        os.fsync(stream.fileno())
    with (runs / 'dispatch-events.log').open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        counts = Counter(item['result'] for item in row.get('rows', []))
        stamp = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(row['at']))
        stream.write(f"{stamp} BRANCH_GARDENER {row['event']} repo={row.get('repo', '-')} "
                     f"branches={len(row.get('rows', []))} deleted={counts['deleted']} "
                     f"error={int(bool(row.get('error')))}\n")
        stream.flush()
        os.fsync(stream.fileno())


def garden(repository, cfg, runs, projects, roots, apply):
    report = {'repo': repository, 'rows': [], 'error': None}
    emit = lambda event, **kw: journal(runs, {'schema': 'branch-gardener.v1', 'at': time.time(),
                                           'repo': repository, 'event': event, **kw})
    try:
        canonical = 'ashlrai/' + repository.split('/')[1]
        sources = sorted({repository, canonical})
        defaults = {source: metadata(source) for source in sources}
        snapshot = branches(repository)
        prs = [pr for source in sources for pr in pulls(source)]
        active = active_branches(projects, runs, roots)
        with tempfile.TemporaryDirectory(prefix='branch-gardener-') as scratch:
            directory = Path(scratch)
            git(directory, 'init', '--bare', '--quiet', '--template=')
            url = f'https://github.com/{repository}.git'
            git(directory, 'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', url,
                '+refs/heads/*:refs/heads/*')
            git(directory, 'fetch', '--quiet', '--no-tags', '--no-recurse-submodules',
                f'https://github.com/{canonical}.git',
                'refs/heads/' + defaults[canonical] + ':refs/gardener/default')
            base = git(directory, 'rev-parse', 'refs/gardener/default').stdout.strip()

            @lru_cache(maxsize=None)
            def ancestor(sha):
                return git(directory, 'merge-base', '--is-ancestor', sha, base, allowed=(0, 1)).returncode == 0

            @lru_cache(maxsize=None)
            def stale_empty(sha):
                stamp = int(git(directory, 'show', '-s', '--format=%ct', sha).stdout)
                if time.time() - stamp <= 14 * 86400:
                    return False
                # Cherry ignores merges. Unique merge resolutions must always survive.
                if git(directory, 'rev-list', '--merges', base + '..' + sha).stdout.strip():
                    return False
                return not any(line.startswith('+') for line in git(directory, 'cherry', base, sha).stdout.splitlines())

            for name, branch in sorted(snapshot.items()):
                row = classify(name, branch, prs, repository, set(defaults.values()), active,
                               cfg['pins'], ancestor, stale_empty)
                row['result'] = 'planned' if row['action'] == 'delete' else 'retained'
                report['rows'].append(row)
            verify_pr_refs(directory, report['rows'])
            emit('plan', dry_run=not apply, rows=report['rows'])
            candidates = [row for row in report['rows'] if row['action'] == 'delete']
            if apply:
                for start in range(0, len(candidates), 100):
                    # Re-read all guards immediately before each push. No saved plan is executable.
                    require(not (Path.home() / '.ashlr/KILL').exists(), 'fleet-killed')
                    fresh_defaults = {source: metadata(source) for source in sources}
                    fresh = branches(repository)
                    git(directory, 'fetch', '--quiet', '--no-tags', '--no-recurse-submodules',
                        f'https://github.com/{canonical}.git',
                        '+refs/heads/' + fresh_defaults[canonical] + ':refs/gardener/revalidate')
                    latest = git(directory, 'rev-parse', 'refs/gardener/revalidate').stdout.strip()
                    retained = git(directory, 'merge-base', '--is-ancestor', base, latest,
                                   allowed=(0, 1)).returncode == 0
                    opened = [pr for source in sources for pr in pulls(source, 'open')]
                    busy = active_branches(projects, runs, roots)
                    batch = []
                    for row in candidates[start:start + 100]:
                        current = fresh.get(row['branch'])
                        if (not retained or fresh_defaults != defaults or not current or current['sha'] != row['sha']
                                or protected(row['branch'], current, set(fresh_defaults.values()), busy, cfg['pins'])
                                or any(pr['repo'] in (repository, None) and pr['branch'] == row['branch'] for pr in opened)):
                            row['result'] = 'guard-changed'
                        else:
                            batch.append(row)
                    if batch:
                        emit('delete-intent', rows=batch)  # durable audit before remote mutation
                        try:
                            delete_batch(directory, url, batch)
                        except Refused:
                            for row in batch:
                                row['result'] = 'failed-or-uncertain'
                            raise
                        for row in batch:
                            row['result'] = 'deleted'
                        emit('deleted', rows=batch)
    except (Refused, OSError, ValueError, KeyError, TypeError) as error:
        report['error'] = str(error) if isinstance(error, Refused) else 'evidence-unavailable-or-invalid'
    report['counts'] = dict(Counter(row['result'] for row in report['rows']))
    emit('result', **report)
    return report


def config(path):
    cfg = {'owners': ['ashlrai', 'masonwyatt23'], 'repos': list(REPOS), 'pins': [],
           'dry_run': True, 'dry_run_until': None, 'streams': 3}
    if path.exists():
        value = json.loads(contents(path))
        require(isinstance(value, dict) and not set(value) - set(cfg), 'invalid-config-keys')
        cfg.update(value)
    require(isinstance(cfg['owners'], list) and cfg['owners']
            and all(owner in ('ashlrai', 'masonwyatt23') for owner in cfg['owners']), 'invalid-owners')
    require(isinstance(cfg['repos'], list) and cfg['repos']
            and all(repo in REPOS for repo in cfg['repos']), 'invalid-repos')
    require(isinstance(cfg['pins'], list) and all(isinstance(p, str) and p for p in cfg['pins']), 'invalid-pins')
    require(type(cfg['dry_run']) is bool and type(cfg['streams']) is int and 1 <= cfg['streams'] <= 4,
            'invalid-config-values')
    if cfg['dry_run_until'] is not None:
        require(isinstance(cfg['dry_run_until'], str), 'invalid-dry-run-until')
        until = datetime.fromisoformat(cfg['dry_run_until'].replace('Z', '+00:00'))
        require(until.tzinfo is not None, 'dry-run-until-needs-timezone')
        cfg['dry_run'] |= datetime.now(timezone.utc) < until
    return cfg


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runs', type=Path, default=Path.home() / '.ashlr-runs')
    parser.add_argument('--projects', type=Path, default=Path.home() / 'Projects/ashlrai')
    parser.add_argument('--wt-root', type=Path, action='append', default=[])
    parser.add_argument('--config', type=Path)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    os.umask(0o077)
    try:
        cfg = config(args.config or args.runs / 'branch-gardener.json')
        args.runs.mkdir(parents=True, exist_ok=True)
        with (args.runs / 'branch-gardener.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Refused('already-running') from None
            apply = args.apply and not cfg['dry_run']
            roots = [args.projects / 'wt', *args.wt_root]
            targets = sorted({owner + '/' + repo for owner in cfg['owners'] for repo in cfg['repos']})
            with ThreadPoolExecutor(max_workers=cfg['streams']) as pool:
                reports = list(pool.map(lambda repo: garden(repo, cfg, args.runs, args.projects, roots, apply), targets))
        result = {'schema': 'branch-gardener.v1', 'dry_run': not apply, 'repos': reports}
        print(json.dumps(result, indent=None if args.json else 2))
        return int(any(report['error'] for report in reports))
    except (Refused, OSError, ValueError, TypeError, AttributeError) as error:
        print(json.dumps({'error': str(error) if isinstance(error, Refused)
                          else 'gardener-refused-config-lock-or-audit'}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
