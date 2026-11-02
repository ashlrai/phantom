import unittest
from copy import deepcopy

from lane_route import FAST_TIER, FAILOVER_REASON, RESTORE_REASON, route


class LaneRouteTest(unittest.TestCase):
    def setUp(self):
        self.queue = {
            'RQ-BET-1': dict(status='READY', pool='devin', tier='work',
                             src='leader', bet='bold', attempts=0),
            'RQ-BET-2': dict(status='READY', pool='claude', tier='mid',
                             src='leader', bet='safe', attempts=0),
            'RQ-LOCAL': dict(status='READY', pool='local', tier='work',
                             size=80, attempts=0),
            'RQ-BUSY': dict(status='RUNNING', pool='claude', tier='work',
                            receipt='a1', attempts=1),
        }
        self.snapshot = deepcopy(self.queue)

    def decide(self, job_id, eligible, queue=None):
        return route(queue or self.queue, job_id, eligible=eligible)

    # Requested eligible lanes are honored ---------------------------------

    def test_requested_eligible_lane_is_honored_not_reranked(self):
        # The dispatcher's approved order puts 'claude' first; the job asked
        # for 'devin' and must get 'devin'.
        queue, decision = self.decide('RQ-BET-1', ['claude', 'devin'])
        self.assertEqual(decision, {'job': 'RQ-BET-1', 'kind': 'requested',
                                    'lane': 'devin', 'reason': None,
                                    'tier': 'work', 'restored': False})
        job = queue['RQ-BET-1']
        self.assertEqual(job['pool'], 'devin')
        self.assertNotIn('failover', job)
        self.assertNotIn('requestedPool', job)
        # src=leader / bet= markers are inert envelope data, never authority.
        self.assertEqual(job['src'], 'leader')
        self.assertEqual(job['bet'], 'bold')
        # The caller's snapshot is never mutated.
        self.assertEqual(self.queue, self.snapshot)

    def test_requested_lane_last_in_order_still_wins(self):
        queue, decision = self.decide('RQ-BET-2', ['local', 'devin', 'codex', 'claude'])
        self.assertEqual(decision['kind'], 'requested')
        self.assertEqual(decision['lane'], 'claude')
        self.assertEqual(queue['RQ-BET-2']['pool'], 'claude')

    # Unavailable lanes fail over explicitly -------------------------------

    def test_unavailable_requested_lane_fails_over_explicitly(self):
        queue, decision = self.decide('RQ-BET-2', ['devin', 'codex'])
        self.assertEqual(decision['kind'], 'failover')
        self.assertEqual(decision['lane'], 'devin')
        job = queue['RQ-BET-2']
        self.assertEqual(job['pool'], 'devin')
        self.assertEqual(job['requestedPool'], 'claude')
        self.assertEqual(job['failover'], {'requested': 'claude', 'lane': 'devin',
                                           'reason': FAILOVER_REASON})

    def test_no_eligible_pool_holds_the_job_on_its_request(self):
        for eligible in ([], ['', None, 0]):
            with self.subTest(eligible=eligible):
                queue, decision = self.decide('RQ-BET-1', eligible)
                self.assertEqual(decision['kind'], 'held')
                self.assertEqual(decision['reason'], 'no-eligible-pool')
                self.assertIsNone(decision['lane'])
                job = queue['RQ-BET-1']
                self.assertEqual(job['pool'], 'devin')
                self.assertNotIn('failover', job)

    def test_undeclared_pool_is_held_not_invented(self):
        for pool in (None, '', 7):
            with self.subTest(pool=pool):
                self.queue['RQ-BET-1']['pool'] = pool
                queue, decision = self.decide('RQ-BET-1', ['devin'])
                self.assertEqual(decision['kind'], 'held')
                self.assertEqual(decision['reason'], 'pool-undeclared')

    def test_only_ready_jobs_route(self):
        for status in ('RUNNING', 'CLAIMED', 'STARTING', 'FINISHED', 'DONE',
                       'FAILED', 'BLOCKED', 'HOLD', 'CANCELLED', 'PR-OPEN'):
            with self.subTest(status=status):
                self.queue['RQ-BUSY']['status'] = status
                queue, decision = self.decide('RQ-BUSY', ['devin'])
                self.assertEqual(decision['kind'], 'held')
                self.assertEqual(decision['reason'], 'not-ready')
                job = queue['RQ-BUSY']
                self.assertEqual(job['pool'], 'claude')
                self.assertNotIn('failover', job)
                self.assertNotIn('requestedPool', job)

    def test_chained_failover_keeps_the_original_request(self):
        queue, _ = self.decide('RQ-BET-2', ['devin'])
        self.assertEqual(queue['RQ-BET-2']['requestedPool'], 'claude')
        self.assertEqual(queue['RQ-BET-2']['pool'], 'devin')
        # 'devin' drops out too: the job moves again, still under 'claude'.
        queue, decision = route(queue, 'RQ-BET-2', eligible=['codex'])
        self.assertEqual(decision['kind'], 'failover')
        self.assertEqual(decision['lane'], 'codex')
        job = queue['RQ-BET-2']
        self.assertEqual(job['pool'], 'codex')
        self.assertEqual(job['requestedPool'], 'claude')
        self.assertEqual(job['failover'], {'requested': 'claude', 'lane': 'codex',
                                           'reason': FAILOVER_REASON})

    def test_requested_lane_again_eligible_restores_explicitly(self):
        queue, _ = self.decide('RQ-BET-2', ['devin'])
        queue, decision = route(queue, 'RQ-BET-2', eligible=['claude', 'devin'])
        self.assertEqual(decision['kind'], 'requested')
        self.assertEqual(decision['lane'], 'claude')
        self.assertTrue(decision['restored'])
        job = queue['RQ-BET-2']
        self.assertEqual(job['pool'], 'claude')
        self.assertNotIn('requestedPool', job)
        self.assertEqual(job['failover'], {'requested': 'devin', 'lane': 'claude',
                                           'reason': RESTORE_REASON})

    # Local jobs remain fast-tier under 100 lines --------------------------

    def test_local_job_under_100_lines_stays_fast_tier(self):
        queue, decision = self.decide('RQ-LOCAL', ['local', 'devin'])
        self.assertEqual(decision['kind'], 'requested')
        self.assertEqual(decision['tier'], FAST_TIER)
        self.assertEqual(queue['RQ-LOCAL']['tier'], FAST_TIER)

    def test_fast_tier_bound_includes_a_100_line_bound(self):
        for size, tier in ((1, FAST_TIER), (50, FAST_TIER), (99, FAST_TIER),
                           (100, FAST_TIER), (101, 'work'), (250, 'work')):
            with self.subTest(size=size):
                self.queue['RQ-LOCAL']['size'] = size
                queue, decision = self.decide('RQ-LOCAL', ['local'])
                self.assertEqual(queue['RQ-LOCAL']['tier'], tier)
                self.assertEqual(decision['tier'], tier)

    def test_fast_tier_needs_a_declared_bound(self):
        for size in (None, 'small', '80', True, 0, -5, 2_000_000):
            with self.subTest(size=size):
                self.queue['RQ-LOCAL']['size'] = size
                queue, _ = self.decide('RQ-LOCAL', ['local'])
                self.assertEqual(queue['RQ-LOCAL']['tier'], 'work')

    def test_fast_tier_applies_to_a_local_failover(self):
        self.queue['RQ-BET-1']['size'] = 90
        queue, decision = self.decide('RQ-BET-1', ['local'])
        self.assertEqual(decision['kind'], 'failover')
        self.assertEqual(decision['lane'], 'local')
        self.assertEqual(decision['tier'], FAST_TIER)
        self.assertEqual(queue['RQ-BET-1']['tier'], FAST_TIER)

    def test_non_local_lanes_never_take_the_fast_override(self):
        self.queue['RQ-BET-1']['size'] = 40
        queue, decision = self.decide('RQ-BET-1', ['devin'])
        self.assertEqual(queue['RQ-BET-1']['tier'], 'work')
        self.assertEqual(decision['tier'], 'work')

    # Queue integrity ------------------------------------------------------

    def test_route_touches_only_the_named_job(self):
        queue, _ = self.decide('RQ-BET-2', ['devin'])
        for job_id in ('RQ-BET-1', 'RQ-LOCAL', 'RQ-BUSY'):
            self.assertEqual(queue[job_id], self.snapshot[job_id])

    def test_unknown_job_id_raises(self):
        with self.assertRaises(KeyError):
            self.decide('RQ-MISSING', ['devin'])


if __name__ == '__main__':
    unittest.main()
