"""RQ-EMPTY-SIGNAL-1: EMPTY finishes split into no_diff / error / unknown.
No model, network or live queue access; the rollup case runs one repo-copy tick in a temp HOME."""
import json
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from launch_precheck import classify_empty, EMPTY_NO_DIFF, EMPTY_ERROR, EMPTY_UNKNOWN
from test_dispatchd import build, held_lanes, tick


class ClassifyEmptyTests(unittest.TestCase):
    def test_clean_exit_without_diff_is_no_diff(self):
        self.assertEqual(classify_empty(True, 0), EMPTY_NO_DIFF)

    def test_nonzero_exit_is_error(self):
        self.assertEqual(classify_empty(True, 1), EMPTY_ERROR)
        self.assertEqual(classify_empty(True, 124), EMPTY_ERROR)

    def test_pool_error_beats_clean_exit(self):
        self.assertEqual(classify_empty(True, 0, 'credits_exhausted'), EMPTY_ERROR)

    def test_missing_exit_status_is_unknown_not_blamed(self):
        self.assertEqual(classify_empty(True, None), EMPTY_UNKNOWN)

    def test_non_empty_or_unmeasured_is_none(self):
        self.assertIsNone(classify_empty(False, 1, 'x'))
        self.assertIsNone(classify_empty(None, 0))

    def test_bool_exit_code_is_not_a_status(self):
        self.assertEqual(classify_empty(True, False), EMPTY_UNKNOWN)


class RollupTests(unittest.TestCase):
    def test_rollup_splits_empty_and_keeps_empty_rate(self):
        ts = time.strftime('%Y-%m-%dT%H:%M:%S%z', time.localtime(time.time() - 60))
        def launch(j): return {'event': 'launch', 'job': j, 'lane': 'claude', 'tier': 'mid', 'ts': ts}
        def finish(j, **kw): return {'event': 'finish', 'job': j, 'lane': 'claude', 'ts': ts, **kw}
        rows = [launch(f'J{i}') for i in range(5)] + [
            finish('J0', empty=True, exit_code=0, empty_class='no_diff'),
            finish('J1', empty=True, exit_code=2),                      # legacy row: classified from exit_code
            finish('J2', empty=True, exit_code=0, pool_error='rate_limit'),  # legacy row with pool error
            finish('J3', empty=True),                                   # legacy row without exit status
            finish('J4', empty=False, exit_code=0),
        ]
        tmp = build(slots=held_lanes())
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name).resolve()
        (home / '.ashlr-runs/metrics/jobs.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in rows))
        result = tick(home)
        self.assertEqual(result.returncode, 0, result.stderr)
        lane = json.loads((home / '.ashlr-runs/queue/status.json').read_text())['rollup_24h']['by_lane']['claude']
        self.assertEqual((lane['finished'], lane['empty'], lane['empty_rate']), (5, 4, 0.8))
        self.assertEqual((lane['empty_no_diff'], lane['empty_error'], lane['empty_unknown']), (1, 2, 1))
        self.assertEqual(lane['empty_error_rate'], 0.4)


if __name__ == '__main__':
    unittest.main()
