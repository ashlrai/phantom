import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'merge-latency.py'
SPEC = importlib.util.spec_from_file_location('merge_latency', SCRIPT)
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


def event(job, state, hour=None, **extra):
    return dict(job=job, event=state.lower(), state=state,
                **({'ts': f'2026-11-01T{hour:02d}:00:00Z'} if hour is not None else {}), **extra)


class MergeLatencyTests(unittest.TestCase):
    def test_mixed_outcomes_duplicates_missing_and_blocking(self):
        rows = [event('a', 'QUEUED', 0), event('a', 'HELD', 1, reason='required checks'),
                event('a', 'MERGED', 3), event('closed', 'CLOSED', 4),
                event('missing', 'QUEUED'), event('missing', 'MERGED', 4),
                event('conflict', 'MERGED', 4, prUrl='pr/1'),
                event('conflict', 'CLOSED', 5, prUrl='pr/1'),
                event('stale', 'PUBLISHED', 0, prUrl='pr/2'),
                event('merge-conflict', 'PUBLISHED', 23, prUrl='pr/4', mergeable='CONFLICTING'),
                event('reverse', 'QUEUED', 5), event('reverse', 'MERGED', 4)]
        rows.append(rows[0].copy())
        report = m.analyze(rows, m.timestamp('2026-11-03T00:00:00Z'))
        self.assertEqual(report['measured'], 1)
        self.assertEqual(report['queueToMergeSeconds']['p95'], 10800)
        self.assertEqual(report['blockingSeconds'], {'required checks': 7200})
        self.assertEqual(report['duplicates'], 1)
        self.assertEqual([r['job'] for r in report['candidates']], ['conflict', 'merge-conflict', 'stale'])
        self.assertEqual(report, m.analyze(list(reversed(rows)), m.timestamp('2026-11-03T00:00:00Z')))

    def test_reconciler_aliases_and_ambiguous_attempts(self):
        rows = [event('a', 'QUEUED', 0), {'jobId': 'a', 'outcome': 'MERGED',
                'mergedAt': '2026-11-01T02:00:00Z'}, event('b', 'QUEUED', 0),
                event('b', 'QUEUED', 1), event('b', 'MERGED', 2)]
        report = m.analyze(rows, m.timestamp('2026-11-02T00:00:00Z'))
        self.assertEqual(report['measured'], 1)
        self.assertEqual(report['jobs'][1]['unmeasuredReason'], 'missing_or_ambiguous_boundaries')
        self.assertIsNone(m.analyze([], 0)['queueToMergeSeconds']['p50'])

    def test_cli_read_only_and_invalid_input(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'jobs.jsonl'
            path.write_text(json.dumps(event('a', 'QUEUED', 0)))
            before = path.read_bytes()
            result = subprocess.run([sys.executable, str(SCRIPT), '--jobs', str(path)], capture_output=True)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(list(Path(directory).iterdir()), [path])
            path.write_text('{bad')
            result = subprocess.run([sys.executable, str(SCRIPT), '--jobs', str(path)], capture_output=True)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, b'')

    def test_percentiles_future_and_current_conflicts(self):
        rows = []
        for n in range(1, 11):
            rows.extend([event(str(n), 'QUEUED', 0), event(str(n), 'MERGED', n)])
        rows.extend([event('future', 'QUEUED', 0), event('future', 'MERGED', 23),
                     event('pr', 'PUBLISHED', 0, prUrl='pr/3', mergeable='CONFLICTING'),
                     event('pr', 'PUBLISHED', 1, prUrl='pr/3', mergeable='MERGEABLE')])
        result = m.analyze(rows, m.timestamp('2026-11-01T12:00:00Z'))
        self.assertEqual(result['measured'], 10)
        self.assertEqual(result['queueToMergeSeconds'],
                         {'p50': 18000, 'p90': 32400, 'p95': 36000, 'p99': 36000})
        self.assertEqual(result['candidates'], [])
