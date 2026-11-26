"""Repo rank affects only ready queue ordering in a synthetic dispatch tick."""
import json
from pathlib import Path
import unittest
import time
from datetime import datetime, timezone

from test_dispatchd import build, tick, queue_job, launch_stubs, lane_slot, dispatched


class MergeYieldAdmission(unittest.TestCase):
    def test_fresh_repairs_finish_without_claims_and_unresolved_work_launches(self):
        with build(slots={'codex-personal': lane_slot()}) as tmp:
            home = Path(tmp).resolve(); env = launch_stubs(home)
            stub = home / 'stubbin/locus'
            stub.write_text('#!/usr/bin/env python3\nimport json, sys\n'
                            'n = int(sys.argv[6])\n'
                            'json.dump(dict(number=n, state="CLOSED" if n == 41 else "OPEN", '
                            'headRefOid="a"*40, mergeable="MERGEABLE", statusCheckRollup=['
                            'dict(__typename="StatusContext", context="Merge Gate", state="SUCCESS" if n == 42 else "PENDING")]), sys.stdout)\n')
            stub.chmod(0o755)
            jobs = [f'RQ-{kind}-phantom-{pr}-aaaaaaa' for kind, pr in
                    [('FIXUP', 41), ('FIXUP', 42), ('REBASE', 43), ('FIXUP', 44)]]
            for job in jobs:
                queue_job(home, job, 'codex-personal')
                (home / f'.ashlr-runs/queue/prompts/{job}.md').write_text(f'{job} (P1): check="Merge Gate"')
            result = tick(home, env); self.assertEqual(result.returncode, 0, result.stderr)
            ledger = [json.loads(line) for line in (home / '.ashlr-runs/metrics/jobs.jsonl').read_text().splitlines()]
            for job, reason in zip(jobs, ['target_pr_closed', 'target_pr_checks_resolved', 'target_pr_conflicts_resolved']):
                self.assertFalse(dispatched(home, job))
                self.assertFalse(any(r.get('job') == job and r.get('event') in ('claim', 'launch', 'batch_claim') for r in ledger))
                self.assertTrue(any(r.get('job') == job and r.get('state') == 'DONE-NOOP'
                                    and r.get('reason') == reason and r.get('launched') is False for r in ledger))
            self.assertTrue(dispatched(home, jobs[-1]))
            self.assertEqual((home / '.ashlr-runs/queue/ready.tsv').read_text().strip(), '')

    def test_repairs_wait_when_freshness_budget_is_exhausted(self):
        with build(slots={'codex-personal': lane_slot()}) as tmp:
            home = Path(tmp).resolve(); env = launch_stubs(home)
            job = 'RQ-FIXUP-phantom-42-aaaaaaa'
            queue_job(home, job, 'codex-personal')
            result = tick(home, dict(env, TICK_BUDGET_S='-1'))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(dispatched(home, job))
            self.assertIn(job, (home / '.ashlr-runs/queue/ready.tsv').read_text())

    def test_high_yield_launches_first_and_terminal_target_never_launches(self):
        stamp = datetime.fromtimestamp(time.time() - 60, timezone.utc).isoformat()
        rows = []
        for kind, count, merged in [('A', 4, 3), ('B', 25, 1)]:
            for i in range(count):
                row = dict(job=f'RQ-{kind}-{i}', repo='phantom', lane='codex-personal', tier='work', ts=stamp)
                rows += [dict(row, event='launch'), dict(job=row['job'], ts=stamp,
                         **(dict(event='outcome', state='MERGED') if i < merged else dict(event='finish', empty=True)))]
        rows += [dict(event='outcome', job='old', ts=stamp, state='MERGED', url='https://github.com/ashlrai/phantom/pull/42'),
                 dict(event='outcome', job='old2', ts=stamp, state='CLOSED', url='https://github.com/ashlrai/phantom/pull/43')]
        with build(slots={'codex-personal': lane_slot()}, finishes=rows) as tmp:
            home = Path(tmp).resolve(); env = launch_stubs(home)
            for job in ('RQ-B-next', 'RQ-A-next', 'RQ-C-merged', 'RQ-C-closed'):
                queue_job(home, job, 'codex-personal')
            for job, pr in [('RQ-C-merged', 42), ('RQ-C-closed', 43)]:
                (home / f'.ashlr-runs/queue/prompts/{job}.md').write_text(f'{job} (P1, pr={pr}): repair target')
            result = tick(home, env); self.assertEqual(result.returncode, 0, result.stderr)
            ledger = [json.loads(line) for line in (home / '.ashlr-runs/metrics/jobs.jsonl').read_text().splitlines()]
            self.assertEqual([r['job'] for r in ledger[len(rows):] if r.get('event') == 'launch'][0], 'RQ-A-next')
            for job in ('RQ-C-merged', 'RQ-C-closed'):
                self.assertFalse(dispatched(home, job))
                self.assertTrue(any(r.get('job') == job and r.get('state') == 'DONE-NOOP' for r in ledger))
            report = json.loads((home / '.ashlr-runs/queue/ranking.json').read_text())
            rates = {r['job']: r['mergeRate'] for r in report['decisions']}
            self.assertEqual((rates['RQ-A-next'], rates['RQ-B-next']), (.75, .04))

    def test_unknown_sampling_retry_identity_and_stale_closed_evidence(self):
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from launch_precheck import admission_history, admission_rank, terminal_target
        now = time.time()
        def row(age, **kw):
            return dict(job='RQ-A-1', repo='phantom', tier='work', lane='codex-personal',
                        ts=datetime.fromtimestamp(now - age, timezone.utc).isoformat(), **kw)
        url = 'https://github.com/ashlrai/phantom/pull/1'
        launch = row(60, event='launch')
        rows = [launch, launch, row(50, event='publish', url=url), row(40, event='launch'),
                row(30, event='outcome', state='MERGED', url=url), row(20, event='outcome', state='MERGED', url=url),
                row(10, event='outcome', state='MERGED'), dict(row(5, event='launch'), tier=[]),
                row(86401, event='launch'), row(-1, event='launch'), {'ts': 'invalid'}]
        rows[2].pop('repo')  # Production publish rows omit repo too.
        groups, states = admission_history(rows, now)
        rank = admission_rank('RQ-A-next', 'work', 'codex-personal', groups)
        self.assertEqual((rank['sampledLaunches'], rank['unknownLaunches'], rank['mergeRate']), (1, 1, 1))
        for tier, lane in [('fast', 'codex-personal'), ('work', 'claude')]:
            rank = admission_rank('RQ-A-next', tier, lane, groups)
            self.assertIsNone(rank['mergeRate']); self.assertEqual(rank['score'], 1)
        self.assertEqual(admission_rank('RQ-B', 'work', 'x', {('B', 'work', 'x'): [False]})['score'], .1)
        self.assertEqual(admission_rank('RQ-B', 'work', 'x', {('B', 'work', 'x'): [None]})['score'], .1)
        self.assertIsNone(terminal_target('J', 'locus', 'J (pr=1): repair', states))
        self.assertIsNone(terminal_target('J', 'phantom', 'J (P1): refer to PR #1', states))
        _, states = admission_history([row(301, event='outcome', state='CLOSED', url=url)], now)
        self.assertIsNone(terminal_target('J', 'phantom', 'J (pr=1): repair', states))


def snapshot():
    return {'schemaVersion': 1, 'enrolled': ['phantom', 'locus'],
            'weights': {'prior': .5, 'recency': .25, 'leverage': .25},
            'generatedAt': '2026-11-09T00:00:00Z', 'proposals': [], 'history': [],
            'rankings': [{'repo': 'locus', 'weight': .6, 'score': 1},
                         {'repo': 'phantom', 'weight': .4, 'score': .5}]}


class DispatchRepoRank(unittest.TestCase):
    def run_queue(self, content, pause=False):
        with build(slots={'codex-personal': lane_slot(), 'hard_cap': 4}) as tmp:
            home = Path(tmp).resolve()
            env = launch_stubs(home)
            for job in ('A', 'B', 'C', 'D'):
                queue_job(home, job, 'codex-personal')
            queue_job(home, 'Z', 'codex-personal', repo='locus')
            queue_job(home, 'RQ-FIX-MAIN-X', 'codex-personal', repo='ashlr-md')
            if content is not None:
                path = home / '.ashlr/repo-rank.json'
                path.parent.mkdir()
                path.write_text(content)
            if pause:
                path = home / '.ashlr/repo-priority'
                path.mkdir(parents=True, exist_ok=True)
                (path / 'ashlrai@locus').write_text('pause')
            result = tick(home, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            return {j for j in ('A', 'B', 'C', 'D', 'Z', 'RQ-FIX-MAIN-X') if dispatched(home, j)}

    def test_value_share_apportions_ready_work_without_a_fixed_hierarchy(self):
        launched = self.run_queue(json.dumps(snapshot()))
        self.assertIn('Z', launched)
        self.assertIn('RQ-FIX-MAIN-X', launched)
        self.assertNotIn('C', launched)

    def test_missing_and_invalid_historical_snapshots_keep_value_share(self):
        invalid = snapshot()
        invalid['rankings'][0]['score'] = None
        for content in (None, '{', json.dumps(invalid)):
            with self.subTest(content=content):
                launched = self.run_queue(content)
                self.assertIn('Z', launched)
                self.assertIn('RQ-FIX-MAIN-X', launched)

    def test_owner_pause_keeps_ready_repo_out_of_claims(self):
        launched = self.run_queue(None, pause=True)
        self.assertNotIn('Z', launched)
        self.assertIn('RQ-FIX-MAIN-X', launched)


if __name__ == '__main__':
    unittest.main()
