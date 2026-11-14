#!/usr/bin/env python3
"""Offline regression tests: real Git objects, PR refs and atomic remote deletion."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('gardener', HERE / 'branch-gardener.py')
g = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(g)


class GardenerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='branch-gardener-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.runs = self.root / 'runs'
        self.runs.mkdir()
        self.projects = self.root / 'projects'
        self.local = self.projects / 'phantom'
        self.local.mkdir(parents=True)
        self.wt = self.projects / 'wt'
        self.wt.mkdir()
        self.remote = self.root / 'remote.git'
        self.git(self.root, 'init', '--bare', str(self.remote))
        self.git(self.local, 'init', '-b', 'main')
        self.git(self.local, 'config', 'user.name', 'Gardener Fixture')
        self.git(self.local, 'config', 'user.email', 'fixture@example.invalid')
        (self.local / 'file').write_text('base\n')
        self.git(self.local, 'add', 'file')
        self.git(self.local, 'commit', '-qm', 'base')
        self.base = self.git(self.local, 'rev-parse', 'HEAD').strip()
        self.git(self.local, 'push', str(self.remote), 'main')
        self.prs = []
        self.protected = set()
        self.cfg = {'pins': []}
        self.before_refresh = lambda: None
        self.real_command = g.command
        for patcher in (patch.object(g, 'api', side_effect=self.api),
                        patch.object(g, 'command', side_effect=self.transport)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def git(self, cwd, *args, date=None):
        env = {**os.environ, 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_SYSTEM': '/dev/null'}
        if date:
            env.update(GIT_AUTHOR_DATE=date, GIT_COMMITTER_DATE=date)
        return subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-C', str(cwd), *args],
                              env=env, capture_output=True, text=True, check=True).stdout

    def transport(self, args, **kwargs):
        if args[0] == 'git':
            args = [str(self.remote) if a.startswith('https://github.com/') else a for a in args]
            args[1:1] = ['-c', 'protocol.file.allow=always']
        return self.real_command(args, **kwargs)

    def api(self, endpoint):
        path = urlsplit(endpoint).path
        query = parse_qs(urlsplit(endpoint).query)
        if path.endswith('/branches'):
            lines = self.git(self.remote, 'for-each-ref', '--format=%(refname:strip=2) %(objectname)', 'refs/heads').splitlines()
            rows = [{'name': n, 'commit': {'sha': s}, 'protected': n in self.protected}
                    for n, s in (line.split() for line in lines)]
        elif path.endswith('/pulls'):
            state = query['state'][0]
            if state == 'open':
                self.before_refresh()
            rows = [p for p in self.prs if state == 'all' or p['state'] == state]
        else:
            return {'full_name': path.removeprefix('repos/'), 'default_branch': 'main'}
        start = (int(query['page'][0]) - 1) * 100
        return rows[start:start + 100]

    def branch(self, name, unique=False, old=False):
        self.git(self.local, 'checkout', '-qb', name, self.base)
        if unique:
            (self.local / 'file').write_text(name + '\n')
            self.git(self.local, 'commit', '-qam', name,
                     date='2000-01-01T00:00:00Z' if old else None)
        sha = self.git(self.local, 'rev-parse', 'HEAD').strip()
        self.git(self.local, 'push', str(self.remote), name)
        self.git(self.local, 'checkout', '-q', 'main')
        return sha

    def pr(self, name, sha, state='closed', merged=False, owner='ashlrai', number=10000):
        self.prs.append({'head': {'ref': name, 'sha': sha, 'repo': {'full_name': owner + '/phantom'}},
                         'number': number, 'state': state, 'merged_at': '2026-01-01' if merged else None})
        if state == 'closed':
            self.git(self.remote, 'update-ref', f'refs/pull/{number}/head', sha)

    def sweep(self, apply=False):
        result = g.garden('ashlrai/phantom', self.cfg, self.runs, self.projects, [self.wt], apply)
        self.assertIsNone(result['error'], result)
        return {r['branch']: r for r in result['rows']}

    def exists(self, name):
        return bool(self.git(self.remote, 'for-each-ref', '--format=%(objectname)', 'refs/heads/' + name).strip())

    def test_complete_dry_run_then_delete_preserves_pr_refs_and_unique_work(self):
        closed = self.branch('closed', unique=True)
        merged = self.branch('merged', unique=True)
        self.branch('integrated')
        self.branch('feature/with+plus')
        self.branch('orphan-old', unique=True, old=True)
        opened = self.branch('open', unique=True)
        self.pr('closed', closed)
        self.pr('merged', merged, merged=True, number=10001)
        self.pr('open', opened, state='open')
        rows = self.sweep()
        self.assertEqual(rows['closed']['reason'], 'closed-pr')
        self.assertEqual(rows['merged']['reason'], 'merged-pr')
        self.assertEqual(rows['integrated']['reason'], 'ancestor-of-default')
        self.assertEqual(rows['orphan-old']['action'], 'flag')
        self.assertEqual(rows['open']['reason'], 'open-pr')
        self.assertTrue(self.exists('closed'))
        rows = self.sweep(True)
        for name in ('closed', 'merged', 'integrated', 'feature/with+plus'):
            self.assertFalse(self.exists(name))
            self.assertEqual(rows[name]['result'], 'deleted')
        for name in ('main', 'open', 'orphan-old'):
            self.assertTrue(self.exists(name))
        self.assertEqual(self.git(self.remote, 'rev-parse', 'refs/pull/10000/head').strip(), closed)
        log = [json.loads(line) for line in (self.runs / 'metrics/branch-gardener.jsonl').read_text().splitlines()]
        self.assertIn('delete-intent', [r['event'] for r in log])
        self.assertIn('BRANCH_GARDENER deleted', (self.runs / 'dispatch-events.log').read_text())

    def test_active_records_registered_worktrees_pins_holds_and_protection(self):
        for name in ('security/fix', 'RQ-FIX-sec', 'pinned/fix', 'custom-keep', 'protected', 'held',
                     'registered', 'codex-bridge/RQ-dir', 'codex-bridge/RQ-run', 'recorded'):
            self.branch(name)
        self.cfg['pins'] = ['custom-*']
        self.protected.add('protected')
        self.pr('held', self.base, number=197)
        self.git(self.local, 'worktree', 'add', str(self.root / 'elsewhere'), 'registered')
        (self.wt / 'RQ-dir').mkdir()
        (self.runs / 'queue/run').mkdir(parents=True)
        (self.runs / 'queue/run/RQ-run.dispatched').touch()
        (self.runs / 'RQ-base.base').write_text(f'{self.base} recorded {self.root / "absent"} codex\n')
        rows = self.sweep(True)
        self.assertTrue(all(r['action'] == 'keep' for r in rows.values()))
        self.assertEqual(rows['held']['reason'], 'held-pr')

    def test_open_pr_on_second_page_and_same_name_in_other_fork(self):
        self.branch('second-page')
        self.branch('other-fork')
        for i in range(100):
            self.pr('unrelated-' + str(i), self.base, state='open', number=1000 + i)
        self.pr('second-page', self.base, state='open', number=2000)
        self.pr('other-fork', self.base, state='open', owner='someone-else', number=2001)
        rows = self.sweep(True)
        self.assertEqual(rows['second-page']['reason'], 'open-pr')
        self.assertFalse(self.exists('other-fork'))

    def test_changed_closed_tip_and_missing_preservation_ref_fail_closed(self):
        sha = self.branch('changed', unique=True)
        self.pr('changed', self.base)
        self.assertEqual(self.sweep(True)['changed']['reason'], 'tip-changed-after-pr')
        self.prs = []
        self.pr('changed', sha)
        self.git(self.remote, 'update-ref', '-d', 'refs/pull/10000/head')
        report = g.garden('ashlrai/phantom', self.cfg, self.runs, self.projects, [self.wt], True)
        self.assertIsNotNone(report['error'])
        self.assertTrue(self.exists('changed'))

    def test_guards_are_refreshed_before_deletion(self):
        self.branch('reopened')
        self.branch('codex-bridge/RQ-race')

        def change_guards():
            self.pr('reopened', self.base, state='open')
            (self.wt / 'RQ-race').mkdir(exist_ok=True)

        self.before_refresh = change_guards
        rows = self.sweep(True)
        self.assertEqual(rows['reopened']['result'], 'guard-changed')
        self.assertEqual(rows['codex-bridge/RQ-race']['result'], 'guard-changed')
        self.assertTrue(self.exists('reopened'))
        self.assertTrue(self.exists('codex-bridge/RQ-race'))

    def test_upstream_default_rewrite_invalidates_ancestry_proof(self):
        sha = self.branch('previously-integrated', unique=True)
        self.git(self.remote, 'update-ref', 'refs/heads/main', sha)
        original = g.git

        def rewrite_before_fetch(directory, *args, **kwargs):
            if args[0] == 'fetch' and any('refs/gardener/revalidate' in arg for arg in args):
                self.git(self.remote, 'update-ref', 'refs/heads/main', self.base)
            return original(directory, *args, **kwargs)

        with patch.object(g, 'git', side_effect=rewrite_before_fetch):
            rows = self.sweep(True)
        self.assertEqual(rows['previously-integrated']['result'], 'guard-changed')
        self.assertTrue(self.exists('previously-integrated'))

    def test_fleet_kill_blocks_deletion(self):
        self.branch('kill-candidate')
        (self.root / '.ashlr').mkdir()
        (self.root / '.ashlr/KILL').touch()
        with patch.object(g.Path, 'home', return_value=self.root):
            report = g.garden('ashlrai/phantom', self.cfg, self.runs, self.projects, [self.wt], True)
        self.assertEqual(report['error'], 'fleet-killed')
        self.assertTrue(self.exists('kill-candidate'))

    def test_delete_lease_is_atomic_when_tip_moves_after_last_check(self):
        self.branch('moved')
        self.branch('safe')
        new = self.branch('new', unique=True)
        self.git(self.remote, 'update-ref', 'refs/heads/moved', new)
        with tempfile.TemporaryDirectory() as directory:
            self.git(Path(directory), 'init', '--bare')
            with self.assertRaises(g.Refused):
                g.delete_batch(Path(directory), 'https://github.com/ashlrai/phantom.git',
                               [{'branch': n, 'sha': self.base} for n in ('moved', 'safe')])
        self.assertTrue(self.exists('moved'))
        self.assertTrue(self.exists('safe'))

    def test_stale_patch_equivalence_but_recent_and_merge_work_survives(self):
        old = self.branch('equivalent', unique=True, old=True)
        self.git(self.local, 'cherry-pick', old)
        self.git(self.local, 'push', str(self.remote), 'main')
        self.git(self.local, 'checkout', '-qb', 'recent-equivalent', old)
        self.git(self.local, 'commit', '--amend', '-qm', 'recent equivalent')
        self.git(self.local, 'push', str(self.remote), 'recent-equivalent')
        self.git(self.local, 'checkout', '-q', 'main')
        rows = self.sweep(True)
        self.assertEqual(rows['recent-equivalent']['action'], 'flag')
        self.assertEqual(rows['equivalent']['reason'], 'stale-no-unique-commits')
        self.assertFalse(self.exists('equivalent'))
        self.branch('merge-work')
        self.git(self.local, 'checkout', '-q', 'merge-work')
        self.git(self.local, 'merge', '--no-ff', '-m', 'unique merge', old, date='2000-01-01T00:00:00Z')
        self.git(self.local, 'push', str(self.remote), 'merge-work')
        self.git(self.local, 'checkout', '-q', 'main')
        self.assertEqual(self.sweep(True)['merge-work']['action'], 'flag')

    def test_missing_api_invalid_record_and_unwritable_audit_never_delete(self):
        self.branch('candidate')
        (self.runs / 'bad.base').write_text('invalid')
        report = g.garden('ashlrai/phantom', self.cfg, self.runs, self.projects, [self.wt], True)
        self.assertEqual(report['error'], 'invalid-run-base')
        (self.runs / 'bad.base').unlink()
        with patch.object(g, 'api', side_effect=g.Refused('api-down')):
            self.assertEqual(g.garden('ashlrai/phantom', self.cfg, self.runs, self.projects, [self.wt], True)['error'], 'api-down')
        with patch.object(g, 'journal', side_effect=OSError('audit unavailable')):
            with self.assertRaises(OSError):
                g.garden('ashlrai/phantom', self.cfg, self.runs, self.projects, [self.wt], True)
        self.assertTrue(self.exists('candidate'))

    def test_configuration_warmup_requires_explicit_live_config(self):
        cfg = self.root / 'config.json'
        self.assertTrue(g.config(cfg)['dry_run'])
        cfg.write_text(json.dumps({'dry_run': False, 'dry_run_until': '2999-01-01T00:00:00Z'}))
        self.assertTrue(g.config(cfg)['dry_run'])
        cfg.write_text(json.dumps({'dry_run': False, 'dry_run_until': '2000-01-01T00:00:00Z'}))
        self.assertFalse(g.config(cfg)['dry_run'])
        for data in ({'owners': ['other']}, {'repos': ['other']}, {'streams': 0}, {'dry_run': 'false'}, {'unknown': 1}):
            cfg.write_text(json.dumps(data))
            with self.assertRaises(g.Refused):
                g.config(cfg)

    def test_fork_branches_are_matched_to_upstream_pr_head_repository(self):
        self.branch('fork-open')
        self.pr('fork-open', self.base, state='open', owner='masonwyatt23')
        result = g.garden('masonwyatt23/phantom', self.cfg, self.runs, self.projects, [self.wt], True)
        self.assertIsNone(result['error'])
        rows = {row['branch']: row for row in result['rows']}
        self.assertEqual(rows['fork-open']['reason'], 'open-pr')
        self.assertTrue(self.exists('fork-open'))

    def test_batch_limit_and_detached_worktree_guard(self):
        refs = ''.join(f'create refs/heads/batch-{i:03} {self.base}\n' for i in range(205))
        subprocess.run(['git', '-C', str(self.remote), 'update-ref', '--stdin'],
                       input=refs, text=True, capture_output=True, check=True)
        sha = self.branch('detached', unique=True)
        self.git(self.local, 'worktree', 'add', '--detach', str(self.root / 'detached-wt'), sha)
        original = g.delete_batch
        with patch.object(g, 'delete_batch', wraps=original) as deleting:
            rows = self.sweep(True)
        self.assertEqual([len(call.args[2]) for call in deleting.call_args_list], [100, 100, 5])
        self.assertEqual(rows['detached']['reason'], 'protected')
        self.assertTrue(self.exists('detached'))
        self.assertFalse(self.exists('batch-204'))

    def test_main_dry_run_gate_and_singleton_lock(self):
        cfg = self.root / 'config.json'
        cfg.write_text(json.dumps({'owners': ['ashlrai'], 'repos': ['phantom']}))
        args = ['--config', str(cfg), '--runs', str(self.runs), '--projects', str(self.projects), '--apply', '--json']
        with patch.object(g, 'garden', return_value={'error': None}) as garden:
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(g.main(args), 0)
            self.assertTrue(json.loads(output.getvalue())['dry_run'])
            self.assertFalse(garden.call_args.args[-1])
        import fcntl
        with (self.runs / 'branch-gardener.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(g, 'garden') as garden, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(g.main(args), 1)
                garden.assert_not_called()

    def test_six_hour_launchd_template_is_dormant(self):
        data = (HERE / 'com.ashlr.branch-gardener.plist.in').read_bytes()
        plist = plistlib.loads(data)
        self.assertEqual(plist['StartInterval'], 21600)
        self.assertFalse(plist['RunAtLoad'])
        self.assertIn('--apply', plist['ProgramArguments'])


if __name__ == '__main__':
    unittest.main()
