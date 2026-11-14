"""RQ-BATCH-SESSIONS-2: config, model mix, Devin routing, single-claim leases, the per-line bundle prompt,
northstar metrics (pure), and batch-launch.sh against real throwaway git repositories in a temp HOME."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

MAC = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MAC))
import batch_sessions as bs  # noqa: E402
import batcher  # noqa: E402


def ts(epoch):
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(epoch))


class Config(unittest.TestCase):
    def test_defaults_keep_devin_routing_off_until_the_file_is_adopted(self):
        cfg = bs.load_config('/nonexistent/batch-sessions.json')
        self.assertEqual((cfg['max_lines'], cfg['min_lines']), (10, 2))
        self.assertFalse(cfg['devin']['route'])
        self.assertNotIn('claude-api', cfg['lanes'])

    def test_shipped_file_turns_routing_on_and_drops_paid_lanes(self):
        cfg = bs.load_config(str(MAC / 'batch-sessions.json'))
        self.assertTrue(cfg['devin']['route'])
        self.assertEqual(cfg['models']['codex']['default'], 'gpt-6.1-terra')
        self.assertEqual(cfg['models']['devin']['default'], 'swe-2-flash')
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'c.json'
            p.write_text(json.dumps({'schema': bs.SCHEMA, 'max_lines': 50, 'lanes': ['claude', 'claude-api', 'codex-local'],
                                     'devin': {'route': False, 'fallback_lanes': ['devin', 'claude-api', 'claude']},
                                     'models': {'claude': {'hard': 'opus; rm -rf /'}}}))
            cfg = bs.load_config(str(p))
            self.assertEqual(cfg['max_lines'], 10)            # out of range: default kept
            self.assertEqual(cfg['lanes'], ['claude'])
            self.assertFalse(cfg['devin']['route'])
            self.assertEqual(cfg['devin']['fallback_lanes'], ['claude'])
            self.assertEqual(cfg['models']['claude']['hard'], 'opus')   # unsafe model id ignored
            p.write_text('{"schema": "other"}')
            self.assertFalse(bs.load_config(str(p))['devin']['route'])


class ModelMix(unittest.TestCase):
    cfg = bs.load_config(str(MAC / 'batch-sessions.json'))

    def test_claude_sonnet_by_default_opus_for_hard_lines(self):
        self.assertEqual(bs.model_for('claude', 'work', 'Fix the typo in docs/a.md', self.cfg)[0], 'sonnet')
        self.assertEqual(bs.model_for('claude', 'frontier', 'Fix the typo', self.cfg)[0], 'opus')
        self.assertEqual(bs.model_for('claude', 'work', 'Rework the lease ARCHITECTURE', self.cfg)[0], 'opus')

    def test_codex_terra_devin_flash_and_no_fable_pick(self):
        self.assertEqual(bs.model_for('codex-personal', 'work', '', self.cfg)[0], 'gpt-6.1-terra')
        self.assertEqual(bs.model_for('codex-cmp', 'frontier', '', self.cfg)[0], 'gpt-6.1-terra')
        self.assertEqual(bs.model_for('devin', 'work', '', self.cfg)[0], 'swe-2-flash')
        self.assertEqual(bs.model_for('codex-local', 'fast', '', self.cfg)[0], None)
        picks = {bs.model_for('claude', t, p, self.cfg)[0] for t in ('work', 'frontier') for p in ('', 'security')}
        self.assertFalse({m for m in picks if 'fable' in m})

    def test_devin_route(self):
        self.assertEqual(bs.devin_route('locus', 50, self.cfg), 'repo-not-eligible')
        self.assertEqual(bs.devin_route('phantom', None, self.cfg), 'size-not-sm')
        self.assertEqual(bs.devin_route('phantom', 101, self.cfg), 'size-not-sm')
        self.assertIsNone(bs.devin_route('phantom', 100, self.cfg))
        self.assertIsNone(bs.devin_route('locus', None, bs.load_config('/nonexistent')))   # routing off
        self.assertEqual(bs.size_of('- READY RQ-X (pool=devin, size<=80): x'), 80)
        self.assertIsNone(bs.size_of('mentions size 80 in prose'))


class Leases(unittest.TestCase):
    def test_single_claim_and_owner_only_release(self):
        with tempfile.TemporaryDirectory() as run:
            self.assertTrue(bs.acquire_lease(run, 'RQ-A', 'RQ-BATCH-1'))
            self.assertFalse(bs.acquire_lease(run, 'RQ-A', 'RQ-BATCH-2'))
            self.assertEqual(bs.lease_owner(run, 'RQ-A'), 'RQ-BATCH-1')
            self.assertFalse(bs.release_lease(run, 'RQ-A', 'RQ-BATCH-2'))
            self.assertEqual(bs.lease_owner(run, 'RQ-A'), 'RQ-BATCH-1')
            self.assertTrue(bs.release_lease(run, 'RQ-A', 'RQ-BATCH-1'))
            self.assertIsNone(bs.lease_owner(run, 'RQ-A'))
            self.assertFalse(bs.acquire_lease(run, '../evil', 'RQ-BATCH-1'))
            os.symlink('/dev/null', os.path.join(run, 'RQ-L.batched'))
            self.assertFalse(bs.acquire_lease(run, 'RQ-L', 'RQ-BATCH-1'))

    def test_rekey_moves_only_an_owned_lease_and_leaves_no_temp_file(self):
        with tempfile.TemporaryDirectory() as run:
            self.assertTrue(bs.acquire_lease(run, 'RQ-A', 'RQ-BATCH-1'))
            self.assertFalse(bs.rekey_lease(run, 'RQ-A', 'RQ-BATCH-OTHER', 'RQ-BATCH-2'))   # not the owner
            self.assertEqual(bs.lease_owner(run, 'RQ-A'), 'RQ-BATCH-1')
            self.assertFalse(bs.rekey_lease(run, 'RQ-NONE', 'RQ-BATCH-1', 'RQ-BATCH-2'))     # no lease at all
            self.assertFalse(os.path.exists(os.path.join(run, 'RQ-NONE.batched')))
            self.assertFalse(bs.rekey_lease(run, 'RQ-A', 'RQ-BATCH-1', '../evil'))
            self.assertTrue(bs.rekey_lease(run, 'RQ-A', 'RQ-BATCH-1', 'RQ-BATCH-2'))
            self.assertEqual(bs.lease_owner(run, 'RQ-A'), 'RQ-BATCH-2')
            self.assertEqual(sorted(os.listdir(run)), ['RQ-A.batched'])


class Render(unittest.TestCase):
    def test_prompt_gives_each_line_its_worktree_model_and_a_parseable_checklist(self):
        members = [{'job': 'RQ-A', 'prompt': 'Do A.', 'model': 'opus'}, {'job': 'RQ-B', 'prompt': 'Do B.', 'model': 'swe-2-flash'}]
        text = bs.render('RQ-BATCH-X', 'phantom', 'src/core/queue', members, '/wt')
        self.assertIn('Worktree: /wt/RQ-A (branch codex-bridge/RQ-A)', text)
        self.assertIn('Subagent model: opus (claude-opus-5-5)', text)
        self.assertIn('Subagent model: swe-2-flash', text)
        self.assertIn('ships its own PR', text)
        self.assertNotIn('—', text)   # no em dashes
        self.assertEqual(batcher.parse_outcomes(text, ['RQ-A', 'RQ-B']), {'RQ-A': 'unreported', 'RQ-B': 'unreported'})
        done = text.replace('- [ ] RQ-A: pending', '- [x] RQ-A: done: shipped').replace('- [ ] RQ-B: pending', '- [ ] RQ-B: failed: flaky')
        self.assertEqual(batcher.parse_outcomes(done, ['RQ-A', 'RQ-B']), {'RQ-A': 'done', 'RQ-B': 'failed'})


class Northstar(unittest.TestCase):
    def test_counts_sessions_tasks_and_merges(self):
        t0 = 1_800_000_000
        rows = [
            {'event': 'finish', 'job': 'RQ-SOLO', 'ts': ts(t0 + 60), 'empty': False},
            {'event': 'finish', 'job': 'RQ-EMPTY', 'ts': ts(t0 + 120), 'empty': True},
            {'event': 'finish', 'job': 'RQ-BATCH-1', 'ts': ts(t0 + 180), 'batch_size': 3},
            {'event': 'task_outcome', 'job': 'RQ-M1', 'batch': 'RQ-BATCH-1', 'outcome': 'done'},
            {'event': 'task_outcome', 'job': 'RQ-M2', 'batch': 'RQ-BATCH-1', 'outcome': 'done'},
            {'event': 'task_outcome', 'job': 'RQ-M3', 'batch': 'RQ-BATCH-1', 'outcome': 'failed'},
            {'event': 'finish', 'job': 'RQ-M1', 'ts': ts(t0 + 240), 'bundle': 'RQ-BATCH-1'},   # its own reap row
            {'event': 'outcome', 'job': 'RQ-M1', 'state': 'MERGED'},
            {'event': 'outcome', 'job': 'RQ-SOLO', 'state': 'MERGED'},
            {'event': 'outcome', 'job': 'RQ-EMPTY', 'state': 'CLOSED'},
            {'event': 'finish', 'job': 'RQ-OLD', 'ts': ts(t0 - 10)},
        ]
        n = bs.northstar(rows, t0, t0 + 3600)
        self.assertEqual((n['sessions'], n['bundle_sessions'], n['tasks_finished'], n['merged_prs']), (3, 1, 3, 2))
        self.assertEqual((n['tasks_per_session'], n['iterations_per_hour'], n['merged_prs_per_iteration']), (1.0, 3.0, 0.667))
        empty = bs.northstar([], t0, t0 + 3600)
        self.assertIsNone(empty['tasks_per_session'])
        md = bs.first_numbers_md(empty, n, t0)
        self.assertIn('| tasks_per_session | n/a | 1.0 |', md)
        self.assertNotIn('—', md)

    def test_cli_records_rows_and_bus_note(self):
        with tempfile.TemporaryDirectory() as d:
            runs = Path(d)
            (runs / 'metrics').mkdir()
            now = time.time()
            (runs / 'metrics' / 'jobs.jsonl').write_text(
                json.dumps({'event': 'finish', 'job': 'RQ-A', 'ts': ts(now - 7200)}) + '\n'
                + json.dumps({'event': 'finish', 'job': 'RQ-B', 'ts': ts(now - 60)}) + '\n')
            r = subprocess.run([sys.executable, '-B', str(MAC / 'batch_sessions.py'), 'northstar', '--runs', str(runs),
                                '--cutover', str(now - 3600), '--window-h', '2', '--record'],
                               capture_output=True, text=True, timeout=60, cwd=str(MAC))
            self.assertEqual(r.returncode, 0, r.stderr)
            rows = [json.loads(x) for x in (runs / 'metrics' / 'northstar.jsonl').read_text().splitlines()]
            self.assertEqual([(x['phase'], x['sessions']) for x in rows], [('before', 1), ('after', 1)])
            self.assertIn('| sessions | 1 | 1 |', (runs / 'bus' / 'batch-sessions-first-numbers.md').read_text())


def git(*args, cwd=None):
    env = dict(os.environ, GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1', GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@t',
               GIT_COMMITTER_NAME='t', GIT_COMMITTER_EMAIL='t@t')
    return subprocess.run(['git', *args], cwd=cwd, env=env, capture_output=True, text=True, check=True)


class Wrapper(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = home = Path(tmp.name).resolve()
        self.r = home / '.ashlr-runs'
        self.run_dir = self.r / 'queue' / 'run'
        self.run_dir.mkdir(parents=True)
        (self.r / 'queue' / 'batches').mkdir()
        (self.r / 'bin').mkdir()
        origin = home / 'origin.git'
        git('init', '-q', '--bare', '-b', 'main', str(origin))
        seed = home / 'seed'
        git('init', '-q', '-b', 'main', str(seed))
        (seed / 'a.txt').write_text('a\n')
        git('add', 'a.txt', cwd=seed)
        git('commit', '-q', '-m', 'seed', cwd=seed)
        git('push', '-q', str(origin), 'main', cwd=seed)
        self.rp = home / 'Projects' / 'ashlrai' / 'phantom'
        self.rp.parent.mkdir(parents=True)
        (home / 'Projects' / 'ashlrai' / 'wt').mkdir()
        git('clone', '-q', str(origin), str(self.rp))
        (self.rp / 'node_modules').mkdir()
        (self.rp / 'node_modules' / 'dep.js').write_text('x')
        launch = self.r / 'bin' / 'launch.sh'
        launch.write_text('#!/bin/bash\necho "launched $@"\ncat > "$HOME/.ashlr-runs/launch.stdin"\n')
        launch.chmod(0o755)

    def bundle(self, bid, members):
        (self.r / 'queue' / 'batches' / f'{bid}.json').write_text(json.dumps(
            {'schema': batcher.SCHEMA, 'id': bid, 'repo': 'phantom', 'members': [{'job': m} for m in members]}))

    def launch(self, bid, stdin='bundle prompt\n'):
        env = {'HOME': str(self.home), 'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'LANG': 'C',
               'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1'}
        return subprocess.run(['/bin/bash', str(MAC / 'batch-launch.sh'), bid, 'phantom', 'claude', 'work'],
                              input=stdin, env=env, capture_output=True, text=True, timeout=120)

    def test_each_leased_member_gets_its_own_worktree_and_base_then_launch_runs(self):
        bid = 'RQ-BATCH-PHANTOM-X-1'
        members = ['RQ-M-1', 'RQ-M-2', 'RQ-M-3', 'RQ-M-4']
        self.bundle(bid, members)
        for m in members[:3]:
            bs.acquire_lease(str(self.run_dir), m, bid)
        bs.acquire_lease(str(self.run_dir), 'RQ-M-4', 'RQ-BATCH-OTHER')   # leased elsewhere: never prepared here
        (self.home / 'Projects/ashlrai/wt/RQ-M-3').mkdir()                 # path taken: deferred, not touched
        r = self.launch(bid)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn(f'BUNDLE_PREPARED {bid} members=4 ready=2 deferred=2', r.stdout)
        self.assertIn(f'launched {bid} phantom claude work', r.stdout)
        self.assertEqual((self.r / 'launch.stdin').read_text(), 'bundle prompt\n')
        head = git('rev-parse', 'origin/main', cwd=self.rp).stdout.strip()
        for m in ('RQ-M-1', 'RQ-M-2'):
            wt = self.home / 'Projects/ashlrai/wt' / m
            self.assertEqual((self.r / f'{m}.base').read_text(), f'{head} codex-bridge/{m} {wt} claude\n')
            self.assertEqual(git('rev-parse', '--abbrev-ref', 'HEAD', cwd=wt).stdout.strip(), f'codex-bridge/{m}')
            self.assertTrue((wt / 'node_modules' / 'dep.js').exists())
            self.assertEqual((self.run_dir / f'{m}.bundle-wt').read_text().strip(), bid)
        # Shared object store: a member worktree is linked to the main clone, not a second copy.
        self.assertEqual(Path(git('rev-parse', '--git-common-dir', cwd=self.home / 'Projects/ashlrai/wt/RQ-M-1').stdout.strip()),
                         self.rp / '.git')
        self.assertIn('worktree path exists', (self.run_dir / 'RQ-M-3.prep-failed').read_text())
        self.assertIn('lease not held', (self.run_dir / 'RQ-M-4.prep-failed').read_text())
        self.assertEqual(list((self.home / 'Projects/ashlrai/wt/RQ-M-3').iterdir()), [])
        self.assertFalse((self.r / 'RQ-M-4.base').exists())
        self.assertFalse((self.r / '.lock-phantom').exists())

    def test_holds_when_no_member_is_ready_and_refuses_bad_input(self):
        bid = 'RQ-BATCH-PHANTOM-X-2'
        self.bundle(bid, ['RQ-N-1'])
        git('branch', 'codex-bridge/RQ-N-1', cwd=self.rp)   # stale branch: the solo path owns reuse
        bs.acquire_lease(str(self.run_dir), 'RQ-N-1', bid)
        r = self.launch(bid)
        self.assertEqual(r.returncode, 3)
        self.assertIn('HELD: no member', r.stdout)
        self.assertFalse((self.r / 'launch.stdin').exists())
        self.assertEqual(self.launch('RQ-NOT-A-BUNDLE').returncode, 5)
        self.assertEqual(self.launch('RQ-BATCH-MISSING').returncode, 5)


if __name__ == '__main__':
    unittest.main()
