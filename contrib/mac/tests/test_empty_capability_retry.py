"""C499 replay: denied gh access bounds EMPTY retries without retiring the task."""
import json
from datetime import datetime, timezone
import os
from pathlib import Path
import sys
import subprocess
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from launch_precheck import capability_failure, empty_reason, empty_retry_blocks, read_attempts, with_prompt
from test_empty_gate import prompt
import test_dispatchd as dispatch_tests
import test_work_market as market_tests


class EmptyCapabilityRetry(unittest.TestCase):
    def fixture(self, targets=None):
        home, q = market_tests.MarketTick.fixture(self, targets)
        repo = home / 'Projects/ashlrai/phantom'
        for args in (['init', '-q'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                     'commit', '--allow-empty', '-qm', 'base'], ['update-ref', 'refs/remotes/origin/main', 'HEAD'],
                     ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']):
            subprocess.run(['git', '-C', str(repo)] + args, check=True, capture_output=True)
        return home, q
    add = market_tests.MarketTick.add
    rows = market_tests.MarketTick.rows
    run_tick = market_tests.MarketTick.run_tick
    def replay(self, home, job, text, code=0):
        now = int(time.time())
        identity = with_prompt(dict(repo='phantom', base_sha='a' * 40), job, prompt(job, 'claude', text))
        rows = [dict(identity, event='claim', job=job, lane='claude'),
                dict(event='finish', job=job, lane='claude', ts=datetime.fromtimestamp(now, timezone.utc).isoformat(), empty=True, exit_code=code, wall_s=25)]
        runs = home / '.ashlr-runs'
        with (runs / 'metrics/jobs.jsonl').open('a') as stream:
            stream.write(''.join(json.dumps(row) + '\n' for row in rows))
        (runs / f'{job}.log').write_text('error reading configuration: open /fixture/.config/gh/hosts.yml: operation not permitted\n')
        return identity, read_attempts(str(runs)), now

    def test_c499_replay_reroutes_all_four_unchanged_goals(self):
        for name in ('RECUTCOREFLEET', 'RECUTFLEETCLI', 'RECUTTESTONLY', 'REDTESTFIX'):
            with self.subTest(name=name):
                home, q = self.fixture({'claude': 1, 'codex-personal': 1})
                text = f'Recover the {name} pull requests with gh and ship the tested changes.'
                old = f'RQ-PHX-{name}C499'
                identity, rows, now = self.replay(home, old, text)
                self.assertEqual(empty_retry_blocks(identity, rows, now), {'claude': 'empty_capability_gh_unavailable'})
                self.assertIsNone(empty_reason(old, identity, rows, now))
                job = f'RQ-PHX-{name}C500'
                self.add(home, job, lane='claude', preferred_lane='claude')
                (q / f'prompts/{job}.md').write_text(prompt(job, 'claude', text))
                self.run_tick(home)
                decision = self.rows(home)[0]
                self.assertEqual(decision['chosen_lane'], 'codex-personal')
                self.assertTrue(dispatch_tests.dispatched(home, job))
                rejected = {r['lane']: r['reason_codes'] for r in decision['rejected_lanes']}
                self.assertIn('empty_capability_gh_unavailable', rejected['claude'])
                self.run_tick(home)
                self.assertEqual(len(self.rows(home)), 1)  # no repeated model launch

    def test_waits_without_capable_capacity_and_preserves_hysteresis(self):
        home, q = self.fixture({'claude': 1})
        identity, rows, now = self.replay(home, 'RQ-C499', 'Recover pull requests with gh and ship changes.')
        self.add(home, 'RQ-C500', lane='claude', preferred_lane='claude')
        (q / 'prompts/RQ-C500.md').write_text(prompt('RQ-C500', 'claude', 'Recover pull requests with gh and ship changes.'))
        for _ in range(3): self.run_tick(home)
        self.assertTrue((q / 'ready.tsv').read_text())
        self.assertFalse(dispatch_tests.dispatched(home, 'RQ-C500'))
        self.assertTrue(all(r['chosen_lane'] is None for r in self.rows(home)))
        from test_work_market import MarketUnit, view
        lanes = view(); lanes['claude']['unavailable'] = empty_retry_blocks(identity, rows, now)['claude']
        lanes['codex-personal']['capabilities'] = set()
        result, _ = MarketUnit().choose({'preferred_lane': 'claude', 'needs': ['gh']}, lanes)
        self.assertIsNone(result['chosen_lane'])
        lanes['codex-personal']['capabilities'] = {'gh'}
        result, _ = MarketUnit().choose({'preferred_lane': 'claude', 'needs': ['gh']}, lanes,
                                       {'pool': 'claude', 'decided_at': 9999, 'moves': []})
        self.assertIn('hysteresis_minimum_residency', result['reason_codes'])
        self.assertIsNone(result['chosen_lane'])

    def test_evidence_scope_expiry_supersession_and_unknown_errors(self):
        home, _ = self.fixture()
        identity, rows, now = self.replay(home, 'RQ-C499', 'Recover pull requests with gh and ship changes.', code=1)
        self.assertFalse(empty_retry_blocks(identity, rows, now + 86401))
        for changed in (dict(identity, repo='locus'), dict(identity, task_hash='new', prompt_hash='new')):
            self.assertFalse(empty_retry_blocks(changed, rows, now))
        self.assertFalse(empty_retry_blocks(identity, rows + [dict(rows[-1], empty=False)], now))
        self.assertFalse(empty_retry_blocks(identity, rows + [rows[0]], now))
        self.assertIsNone(capability_failure('The task mentions gh and operation not permitted'))
        self.assertIsNone(capability_failure('ERROR: provider rate limit exceeded'))
        log = home / '.ashlr-runs/RQ-C499.log'
        os.utime(log, (now + 300, now + 300))
        self.assertNotIn('capability_failure', read_attempts(str(home / '.ashlr-runs'))[-1])

    def test_reap_persists_typed_failure_for_future_retries(self):
        row = dispatch_tests.DiffMetricsTests.measure(self, lambda wt, git: None, lane='claude', rc=0,
            log='error reading configuration: open /fixture/.config/gh/config.yml: permission denied\n')
        self.assertEqual(row['capability_failure'], 'empty_capability_gh_unavailable')
