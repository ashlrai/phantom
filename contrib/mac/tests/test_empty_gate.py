"""No model or live queue access. Attempt and measurement regressions."""
import sys
import unittest
from pathlib import Path
from datetime import datetime, timezone
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from launch_precheck import empty_reason, attempt_identity


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


if __name__ == '__main__': unittest.main()
