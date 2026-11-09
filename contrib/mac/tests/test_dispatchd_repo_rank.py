"""Repo rank affects only ready queue ordering in a synthetic dispatch tick."""
import json
from pathlib import Path
import unittest

from test_dispatchd import build, tick, queue_job, launch_stubs, lane_slot, dispatched


def snapshot():
    return {'schemaVersion': 1, 'enrolled': ['phantom', 'locus'],
            'weights': {'prior': .5, 'recency': .25, 'leverage': .25},
            'generatedAt': '2026-11-09T00:00:00Z', 'proposals': [], 'history': [],
            'rankings': [{'repo': 'locus', 'weight': .6, 'score': 1},
                         {'repo': 'phantom', 'weight': .4, 'score': .5}]}


class DispatchRepoRank(unittest.TestCase):
    def run_queue(self, content):
        with build(slots={'codex-cmp': lane_slot()}) as tmp:
            home = Path(tmp).resolve()
            env = launch_stubs(home)
            for job in ('A', 'B', 'C', 'D'):
                queue_job(home, job, 'codex-cmp')
            queue_job(home, 'Z', 'codex-cmp', repo='locus')
            queue_job(home, 'RQ-FIX-MAIN-X', 'codex-cmp', repo='ashlr-md')
            if content is not None:
                path = home / '.ashlr/repo-rank.json'
                path.parent.mkdir()
                path.write_text(content)
            result = tick(home, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            return {j for j in ('A', 'B', 'C', 'D', 'Z', 'RQ-FIX-MAIN-X') if dispatched(home, j)}

    def test_rank_breaks_ties_but_not_priority(self):
        launched = self.run_queue(json.dumps(snapshot()))
        self.assertIn('Z', launched)
        self.assertIn('RQ-FIX-MAIN-X', launched)
        self.assertNotIn('C', launched)

    def test_missing_and_invalid_keep_legacy_order(self):
        invalid = snapshot()
        invalid['rankings'][0]['score'] = None
        for content in (None, '{', json.dumps(invalid)):
            with self.subTest(content=content):
                launched = self.run_queue(content)
                self.assertNotIn('Z', launched)
                self.assertIn('RQ-FIX-MAIN-X', launched)


if __name__ == '__main__':
    unittest.main()
