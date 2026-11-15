"""No model or live queue access. Attempt and measurement regressions."""
import sys
import unittest
from pathlib import Path
from datetime import datetime, timezone
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from launch_precheck import empty_reason, attempt_identity, task_hash, with_prompt


class EmptyGateTests(unittest.TestCase):
    def setUp(self):
        self.identity = dict(repo='phantom', base_sha='a' * 40, prompt_hash='b' * 64)
        self.now = 1800000000
        self.claim = dict(self.identity, event='claim', job='RQ-UPKEEP-REL-1')
        self.finish = dict(event='finish', job=self.claim['job'], empty=True, exit_code=0,
                           ts=datetime.fromtimestamp(self.now - 60, timezone.utc).isoformat(), wall_s=8)

    def reason(self, **changes):
        return empty_reason(self.claim['job'], self.identity,
                            [self.claim, dict(self.finish, **changes)], self.now)

    def test_upkeep_empty_on_same_base_is_suppressed(self):
        self.assertEqual(self.reason(), 'upkeep_empty_same_base')
        self.assertIsNone(empty_reason(self.claim['job'], dict(self.identity, base_sha='c' * 40),
                                       [self.claim, self.finish], self.now))

    def test_failures_unknown_and_nonempty_retry(self):
        for changes in ({'exit_code': 1}, {'exit_code': None}, {'empty': False}):
            self.assertIsNone(self.reason(**changes))
        self.assertIsNone(empty_reason('RQ-TEST', {}, [self.finish], self.now))

    def test_prompt_cache_has_24_hour_expiry_and_matches_exact_prompt(self):
        rows = [dict(self.claim, job='RQ-OLD'), dict(self.finish, job='RQ-OLD')]
        self.assertEqual(empty_reason('RQ-NEW', self.identity, rows, self.now), 'prompt_empty_same_base_24h')
        self.assertIsNone(empty_reason('RQ-NEW', self.identity, rows, self.now + 86400))
        self.assertIsNone(empty_reason('RQ-NEW', dict(self.identity, prompt_hash='changed'), rows, self.now))

    def test_latest_attempt_supersedes_old_empty(self):
        rows = [self.claim, self.finish, self.claim, dict(self.finish, empty=False)]
        self.assertIsNone(empty_reason(self.claim['job'], self.identity, rows, self.now))

    def test_git_errors_fail_open(self):
        def fail(*args): raise OSError('unavailable')
        self.assertEqual(attempt_identity('phantom', 'task', '/tmp', fail), {})

    def test_replay_counts_empty_minutes_and_preserves_merged_outcomes(self):
        # 437 historical empty finishes: cache only prevents repeated successful
        # empties. Outcome records are carried through unchanged, never reclassified.
        rows = [self.claim, self.finish]
        skipped = 0
        for _ in range(436):
            skipped += empty_reason(self.claim['job'], self.identity, rows, self.now) is not None
        outcomes = [dict(event='outcome', state='MERGED', job='RQ-WORK')]
        before = [dict(self.finish, wall_s=395 * 60 / 437) for _ in range(437)] + outcomes
        after = before[:1] + outcomes
        def totals(records):
            empties = [r for r in records if r['event'] == 'finish' and r.get('empty') is True]
            return len(empties), sum(r['wall_s'] for r in empties) / 60, sum(r.get('state') == 'MERGED' for r in records)
        self.assertEqual(skipped, 436)
        self.assertAlmostEqual(totals(before)[1], 395)
        self.assertEqual(totals(after)[0], 1)
        self.assertEqual(totals(before)[2], totals(after)[2])


def prompt(job, lane, text='make the dispatcher dedupe empty re-cuts of one task'):
    """The restock.py prompt_body shape: the header names the job id and the lane."""
    return (f'Job {job} (pool {lane}, tier work, repo phantom). Task from the Ashlr router queue, verbatim:\n\n'
            f'{job} (P1, pool={lane}, tier=work, repo=phantom): {text}\n\nTreat the task as the minimum.')


class TaskRepeatTests(unittest.TestCase):
    """RQ-CODEXP-EMPTY-1: prompt_hash misses re-cuts, re-routes and base movement."""
    def setUp(self):
        self.now = 1800000000
        self.base = dict(repo='phantom', base_sha='a' * 40)

    def attempt(self, job, lane, base_sha, age_s=60, empty=True, exit_code=0, text=None):
        identity = with_prompt(dict(self.base, base_sha=base_sha), job, prompt(job, lane, *(text and [text] or [])))
        claim = dict(identity, event='claim', job=job, lane=lane)
        finish = dict(event='finish', job=job, lane=lane, empty=empty, exit_code=exit_code,
                      ts=datetime.fromtimestamp(self.now - age_s, timezone.utc).isoformat())
        return [claim, finish]

    def gate(self, rows, job='RQ-RECUT-3', lane='codex-personal', base_sha='d' * 40):
        return empty_reason(job, with_prompt(dict(self.base, base_sha=base_sha), job, prompt(job, lane)), rows, self.now)

    def test_task_hash_ignores_job_id_lane_attrs_case_and_spacing(self):
        a = task_hash('RQ-A', prompt('RQ-A', 'codex-personal'))
        self.assertEqual(a, task_hash('RQ-B', prompt('RQ-B', 'devin', 'Make  the dispatcher dedupe EMPTY re-cuts of one task')))
        self.assertNotEqual(a, task_hash('RQ-A', prompt('RQ-A', 'codex-personal', 'a different task entirely, longer')))
        self.assertEqual(task_hash('RQ-A', prompt('RQ-A', 'x', 'fix RQ-A docs and tests')),
                         task_hash('RQ-Z', prompt('RQ-Z', 'y', 'fix RQ-Z docs and tests')))

    def test_task_hash_fails_open(self):
        self.assertIsNone(task_hash('RQ-A', 'no task line here'))
        self.assertIsNone(task_hash('RQ-A', 'RQ-A (P1): short'))
        self.assertIsNone(task_hash('RQ-A', None))
        self.assertEqual(with_prompt({}, 'RQ-A', prompt('RQ-A', 'x')), {})
        self.assertNotIn('task_hash', with_prompt(self.base, 'RQ-A', 'free text prompt'))
        self.assertIn('prompt_hash', with_prompt(self.base, 'RQ-A', 'free text prompt'))

    def test_two_empty_attempts_of_one_task_suppress_across_ids_lanes_and_bases(self):
        rows = self.attempt('RQ-RECUT-1', 'codex-personal', 'b' * 40) + self.attempt('RQ-RECUT-2', 'devin', 'c' * 40)
        # The exact-prompt rule cannot see either attempt: different id, lane and base.
        self.assertEqual(self.gate(rows), 'task_empty_repeat_24h')

    def test_one_empty_attempt_still_retries_on_a_new_base(self):
        self.assertIsNone(self.gate(self.attempt('RQ-RECUT-1', 'codex-personal', 'b' * 40)))

    def test_failed_old_superseded_or_other_task_attempts_do_not_count(self):
        one = self.attempt('RQ-RECUT-1', 'codex-personal', 'b' * 40)
        for other in (self.attempt('RQ-X', 'devin', 'c' * 40, exit_code=1),
                      self.attempt('RQ-X', 'devin', 'c' * 40, age_s=86400 + 5),
                      self.attempt('RQ-X', 'devin', 'c' * 40, empty=False),
                      self.attempt('RQ-X', 'devin', 'c' * 40, text='another task with the same lane and base'),
                      self.attempt('RQ-X', 'devin', 'c' * 40) + self.attempt('RQ-X', 'devin', 'c' * 40, empty=False)):
            self.assertIsNone(self.gate(one + other))

    def test_other_repo_attempts_do_not_count(self):
        rows = self.attempt('RQ-RECUT-1', 'codex-personal', 'b' * 40) + self.attempt('RQ-RECUT-2', 'devin', 'c' * 40)
        rows[2] = dict(rows[2], repo='locus')
        self.assertIsNone(self.gate(rows))

    def test_exact_prompt_rule_keeps_priority(self):
        rows = self.attempt('RQ-RECUT-3', 'codex-personal', 'd' * 40)
        self.assertEqual(self.gate(rows), 'prompt_empty_same_base_24h')


class EmptyReasonPromptTests(unittest.TestCase):
    def test_launcher_candidate_and_patch_ask_for_a_machine_readable_empty_reason(self):
        line = ('If you finish with no change, end your final message with the line EMPTY_REASON: <code> '
                'and put the same line first in BRIDGE_NOTES.md; code is duplicate-landed')
        host = Path(__file__).resolve().parents[1] / 'host-integration'
        self.assertIn(line, (host / 'launch.candidate.sh').read_text())
        self.assertIn('\n+' + line, (host / 'launch.patch').read_text())


if __name__ == '__main__': unittest.main()
