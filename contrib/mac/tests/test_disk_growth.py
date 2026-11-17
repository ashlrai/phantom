import importlib.util
from pathlib import Path
import subprocess
import json
import tempfile
import sys
import unittest

spec = importlib.util.spec_from_file_location('disk_growth', Path(__file__).parents[1] / 'disk-growth.py')
disk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(disk)


class DiskGrowthTest(unittest.TestCase):
    def test_rate_projection_and_growers(self):
        previous = {'at': 100, 'free_gb': 509, 'sizes_gb': {'a': 10, 'b': 20}}
        current = {'at': 3700, 'free_gb': 487, 'sizes_gb': {'a': 15, 'b': 21}, 'timed_out': False}
        result = disk.calculate([previous], current)
        self.assertEqual(result['growth_gb_per_h'], 22)
        self.assertEqual(result['hours_to_reuse_only'], 17.59)
        self.assertEqual(result['top_growers'][0], {'path': 'a', 'growth_gb_per_h': 5})
        current['free_gb'] = 90
        self.assertEqual(disk.calculate([], current)['hours_to_reuse_only'], 0)
        current['free_gb'] = 510
        self.assertIsNone(disk.calculate([previous], current)['hours_to_reuse_only'])

    def test_budget_stops_after_timeout(self):
        calls = []
        def run(*args, **kwargs):
            calls.append(kwargs['timeout'])
            raise subprocess.TimeoutExpired('du', kwargs['timeout'])
        sizes, timed_out = disk.sample_sizes([Path(__file__), Path(__file__)], 2, clock=lambda: 10, run=run)
        self.assertEqual(calls, [2])
        self.assertTrue(timed_out)
        self.assertEqual(sizes, {str(Path(__file__)): None})

    def test_delta_uses_latest_sample_and_preserves_unknown(self):
        history = [{'at': 1, 'free_gb': 300, 'sizes_gb': {'a': 2}},
                   {'at': 10, 'free_gb': 200, 'sizes_gb': {'a': 5}}]
        current = {'at': 20, 'free_gb': 190, 'sizes_gb': {'a': 3, 'b': None, 'c': 1}, 'timed_out': True}
        report = disk.calculate(history, current)
        self.assertEqual(report['previous_sampled_at'], 10)
        self.assertEqual([row['delta_gb'] for row in report['directories']], [-2, None, None])
        self.assertIsNone(disk.calculate([{'at': 10}], current)['previous_sampled_at'])

    def test_top_level_targets_do_not_follow_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp).resolve()
            paths = [home / '.ashlr-runs/logs', home / 'Projects/ashlrai/wt/RQ-A']
            for path in paths: path.mkdir(parents=True)
            (home / 'Documents').mkdir()
            (paths[0].parent / 'link').symlink_to(home / 'Documents')
            self.assertEqual(disk.targets(home), paths)
            (home / '.ashlr-runs/queue').symlink_to(home / 'Documents')
            result = subprocess.run([sys.executable, str(Path(disk.__file__)), '--home', str(home)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(list((home / 'Documents').iterdir()), [])

    def test_first_sample_is_unknown(self):
        result = disk.calculate([], {'at': 1, 'free_gb': 200, 'sizes_gb': {}, 'timed_out': False})
        self.assertIsNone(result['growth_gb_per_h'])
        self.assertIsNone(result['hours_to_reuse_only'])

    def test_dispatcher_publishes_report(self):
        sys.path.insert(0, str(Path(__file__).parent))
        from test_dispatchd import build, tick
        tmp = build()
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        report = {'growth_gb_per_h': 22, 'hours_to_reuse_only': 15, 'top_growers': []}
        (home / '.ashlr-runs/queue/disk-growth.json').write_text(json.dumps(report))
        result = tick(home)
        self.assertEqual(result.returncode, 0, result.stderr)
        status = json.loads((home / '.ashlr-runs/queue/status.json').read_text())
        self.assertEqual(status['autopilot']['disk'], report)


if __name__ == '__main__':
    unittest.main()
