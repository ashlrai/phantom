"""RQ-BATCH-SESSIONS-2 Mac-side tools: zombie_report.py (which parent does not wait) and wt_closed_prune.py
(remove clean worktrees of closed jobs). Real throwaway git repos in a temp dir; no live process is signalled."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

MAC = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MAC))
import wt_closed_prune as prune  # noqa: E402
import zombie_report  # noqa: E402


class Zombies(unittest.TestCase):
    def test_groups_defunct_children_by_parent(self):
        table = ('  1     0 Ss   /sbin/launchd\n'
                 '100     1 S    /usr/bin/python3\n'
                 '101   100 Z    (git)\n'
                 '102   100 Z+   (git)\n'
                 '103   100 Z    (bash)\n'
                 '201   200 Z    (node)\n'
                 'junk line\n')
        counts, names = zombie_report.parse(table)
        self.assertEqual(dict(counts), {100: 3, 200: 1})
        self.assertEqual(dict(names[100]), {'(git)': 2, '(bash)': 1})

    def test_report_names_the_parent_command(self):
        def run(args, _timeout):
            if args[1] == '-axo':
                return subprocess.CompletedProcess(args, 0, '101 100 Z (git)\n102 100 Z (git)\n', '')
            return subprocess.CompletedProcess(args, 0, '100 /usr/bin/python3 dispatchd.py\n', '')
        rep = zombie_report.report(run)
        self.assertEqual(rep['zombies'], 2)
        self.assertEqual(rep['parents'][0]['parent_command'], '/usr/bin/python3 dispatchd.py')
        failed = zombie_report.report(lambda a, t: subprocess.CompletedProcess(a, 124, '', 'timed out'))
        self.assertFalse(failed['known'])


def git(*args, cwd=None):
    env = dict(os.environ, GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1', GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@t',
               GIT_COMMITTER_NAME='t', GIT_COMMITTER_EMAIL='t@t')
    return subprocess.run(['git', *args], cwd=cwd, env=env, capture_output=True, text=True, check=True)


class ClosedPrune(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name).resolve()
        self.repo = root / 'phantom'
        git('init', '-q', '-b', 'main', str(self.repo))
        (self.repo / '.gitignore').write_text('node_modules/\n')
        (self.repo / 'a.txt').write_text('a\n')
        (self.repo / 'models.ts').write_text('export const models = [];\n')  # source files are not model-weight directories
        git('add', '.', cwd=self.repo)
        git('commit', '-q', '-m', 'seed', cwd=self.repo)
        self.wtroot = root / 'wt'
        self.wtroot.mkdir()
        self.runs = root / 'runs'
        (self.runs / 'queue' / 'run').mkdir(parents=True)
        (self.runs / 'metrics').mkdir()
        rows = []
        for job in ('RQ-MERGED', 'RQ-CLOSED', 'RQ-DIRTY', 'RQ-OPEN', 'RQ-RELAUNCHED', 'RQ-KEEP', 'RQ-LEASED', 'RQ-LIVE'):
            git('worktree', 'add', '-q', '-b', f'codex-bridge/{job}', str(self.wtroot / job), cwd=self.repo)
            rows.append({'event': 'claim', 'job': job})
            if job != 'RQ-OPEN':
                rows.append({'event': 'outcome', 'job': job, 'state': 'CLOSED' if job == 'RQ-CLOSED' else 'MERGED'})
        rows.append({'event': 'launch', 'job': 'RQ-RELAUNCHED'})
        (self.runs / 'metrics' / 'jobs.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in rows))
        (self.wtroot / 'RQ-MERGED' / 'node_modules').mkdir()               # ignored output does not block
        (self.wtroot / 'RQ-MERGED' / 'node_modules' / 'x.js').write_text('x')
        (self.wtroot / 'RQ-DIRTY' / 'a.txt').write_text('changed\n')
        (self.runs / 'queue' / 'keep.txt').write_text('RQ-KEEP\n')
        (self.runs / 'queue' / 'run' / 'RQ-LEASED.batched').write_text('RQ-BATCH-X')
        (self.wtroot / 'not-a-job dir').mkdir()

    def run_cli(self, *args):
        stub = self.runs / 'stubbin'   # a fixed process list: RQ-LIVE is running
        stub.mkdir(exist_ok=True)
        (stub / 'ps').write_text('#!/bin/sh\necho "claude -p RQ-LIVE"\n')
        (stub / 'ps').chmod(0o755)
        return subprocess.run([sys.executable, '-B', str(MAC / 'wt_closed_prune.py'), '--wtroot', str(self.wtroot),
                               '--runs', str(self.runs), '--json', *args], capture_output=True, text=True, timeout=120,
                              env=dict(os.environ, GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1',
                                       PATH=str(stub) + ':' + os.environ.get('PATH', '/usr/bin:/bin')))

    def test_plan_only_offers_clean_unclaimed_closed_worktrees(self):
        rows = [json.loads(x) for x in (self.runs / 'metrics' / 'jobs.jsonl').read_text().splitlines()]
        items, held = prune.plan(str(self.wtroot), str(self.runs), rows, 'claude -p RQ-LIVE prompt\nRQ-MERGED-2 other\n')
        self.assertEqual([i['job'] for i in items], ['RQ-CLOSED', 'RQ-MERGED'])
        self.assertEqual(dict(held), {'dirty': 1, 'not-closed': 2, 'keep-list': 1, 'claimed': 1, 'live-process': 1})

    def test_dry_run_changes_nothing_and_apply_removes_only_the_plan(self):
        r = self.run_cli()
        self.assertIn(r.returncode, (0,), r.stderr)
        out = json.loads(r.stdout)
        self.assertTrue(out['dry_run'])
        self.assertIn('RQ-MERGED', out['removable_jobs'])
        self.assertTrue((self.wtroot / 'RQ-MERGED').exists())
        r = self.run_cli('--apply', '--max', '1')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(json.loads(r.stdout)['removed'], 1)
        r = self.run_cli('--apply')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        for gone in ('RQ-MERGED', 'RQ-CLOSED'):
            self.assertFalse((self.wtroot / gone).exists())
        for kept in ('RQ-DIRTY', 'RQ-OPEN', 'RQ-RELAUNCHED', 'RQ-KEEP', 'RQ-LEASED', 'RQ-LIVE'):
            self.assertTrue((self.wtroot / kept).exists(), kept)
        self.assertEqual((self.wtroot / 'RQ-DIRTY' / 'a.txt').read_text(), 'changed\n')
        listed = git('worktree', 'list', '--porcelain', cwd=self.repo).stdout
        self.assertNotIn('RQ-MERGED', listed)
        self.assertIn('refs/heads/codex-bridge/RQ-MERGED', git('branch', '--list', '--format=%(refname)', cwd=self.repo).stdout)

    def test_fresh_terminal_reaps_but_pinned_and_unknown_policy_stay(self):
        home = self.runs.parent
        (home / '.ashlr').mkdir()
        pins = home / '.ashlr/kept-worktrees.json'
        pins.write_text(json.dumps([str(self.wtroot / 'RQ-MERGED')]))
        with patch.dict(os.environ, {'HOME': str(home)}):
            r = self.run_cli('--apply')
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertFalse((self.wtroot / 'RQ-CLOSED').exists())  # no hour-long grace after terminal
            self.assertTrue((self.wtroot / 'RQ-MERGED').exists())
            pins.write_text('{broken')
            self.assertEqual(json.loads(self.run_cli('--apply').stdout)['held'], {'pins-unavailable': 1})
            pins.unlink()
            keep = self.runs / 'queue/keep.txt'
            keep.unlink(); keep.mkdir()
            self.assertEqual(json.loads(self.run_cli('--apply').stdout)['held'], {'keep-unavailable': 1})
            self.assertTrue((self.wtroot / 'RQ-MERGED').exists())

    def test_symlink_root_and_retention_change_refuse_removal(self):
        alias = self.runs.parent / 'alias'; alias.symlink_to(self.wtroot)
        self.assertEqual(prune.plan(str(alias), str(self.runs), [], '')[1], {'protected-root': 1})
        rows = [{'event': 'outcome', 'job': 'RQ-MERGED', 'state': 'MERGED'}]
        items, _ = prune.plan(str(self.wtroot), str(self.runs), rows, '')
        allowed, original = {'RQ-MERGED'}, prune.git
        def resolve_then_pin(args):
            result = original(args)
            if 'rev-parse' in args: allowed.clear()
            return result
        with patch.object(prune, 'git', side_effect=resolve_then_pin):
            self.assertEqual(prune.apply(items, 1, lambda job: job in allowed)[0], [])
        self.assertTrue((self.wtroot / 'RQ-MERGED').exists())

    def test_protected_ignored_payloads_and_damaged_ledger_are_retained(self):
        rows = [{'event': 'outcome', 'job': 'RQ-MERGED', 'state': 'MERGED'}]
        for name in ('models', '.codex-extra', 'Docker', 'Documents', 'weights.gguf'):
            with self.subTest(name=name):
                payload = self.wtroot / 'RQ-MERGED/node_modules' / name
                payload.mkdir()
                items, held = prune.plan(str(self.wtroot), str(self.runs), rows, '')
                self.assertEqual(items, [])
                self.assertEqual(held['protected-payload'], 1)
                payload.rmdir()
        with (self.runs / 'metrics/jobs.jsonl').open('a') as f: f.write('{"event":"launch"')
        self.assertEqual(json.loads(self.run_cli('--apply').stdout)['held'], {'ledger-unavailable': 1})
        self.assertTrue((self.wtroot / 'RQ-MERGED').exists())

    def test_delayed_outcome_cannot_close_a_new_attempt(self):
        rows = [{'event': 'publish', 'job': 'RQ-X', 'url': 'old'}, {'event': 'launch', 'job': 'RQ-X'},
                {'event': 'outcome', 'job': 'RQ-X', 'state': 'MERGED', 'url': 'old'}]
        self.assertEqual(prune.closed_jobs(rows), {})
        rows += [{'event': 'publish', 'job': 'RQ-X', 'url': 'new'},
                 {'event': 'outcome', 'job': 'RQ-X', 'state': 'MERGED', 'url': 'new'}]
        self.assertEqual(prune.closed_jobs(rows), {'RQ-X': 'MERGED'})


if __name__ == '__main__':
    unittest.main()
