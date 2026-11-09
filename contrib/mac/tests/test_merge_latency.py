import importlib.machinery
import importlib.util
from contextlib import redirect_stdout
from datetime import datetime, timezone
import io
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'merge-latency.py'
LOADER = importlib.machinery.SourceFileLoader('merge_latency', str(SCRIPT))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
ml = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(ml)

NOW = datetime(2026, 11, 9, 12, 0, tzinfo=timezone.utc)
URL = 'https://github.com/ashlrai/phantom/pull/%d'


def pub(job, n, ts, pool='codex-personal'):
    return dict(jobId=job, prUrl=URL % n, outcome='PUBLISHED', ts=ts, pool=pool)


def end(job, n, state, ts):
    return dict(jobId=job, prUrl=URL % n, outcome=state, ts=ts)


class LatencyTests(unittest.TestCase):
    def test_queued_merged_and_closed(self):
        rows = [pub('a', 1, '2026-11-09T10:00:00Z'), end('a', 1, 'MERGED', '2026-11-09T10:30:00Z'),
                pub('b', 2, '2026-11-09T11:00:00Z'),
                pub('c', 3, '2026-11-09T09:00:00Z'), end('c', 3, 'CLOSED', '2026-11-09T09:10:00Z')]
        out = ml.report(rows, NOW)
        self.assertEqual(out['merged'], dict(count=1, p50=1800.0, p90=1800.0, p95=1800.0, max=1800.0))
        self.assertEqual(out['queued'], dict(count=1, oldestAgeSeconds=3600.0))
        self.assertEqual(out['closed'], 1)
        self.assertEqual(out['byPool']['codex-personal']['count'], 1)

    def test_missing_timestamps_are_counted_not_guessed(self):
        rows = [pub('a', 1, None), dict(pub('b', 2, 'garbage')), pub('c', 3, '2026-11-09T10:00:00'),
                pub('d', 4, '2026-11-09T10:00:00Z'), end('d', 4, 'MERGED', None),
                dict(outcome='MERGED', ts='2026-11-09T10:00:00Z', prUrl=URL % 5)]
        out = ml.report(rows, NOW)
        self.assertEqual(out['missingOrInvalid'], 5)
        self.assertEqual(out['merged']['count'], 0)
        self.assertEqual(out['queued']['count'], 1)  # d: published, merge record unusable

    def test_merge_before_publish_is_invalid(self):
        rows = [pub('a', 1, '2026-11-09T10:00:00Z'), end('a', 1, 'MERGED', '2026-11-09T09:00:00Z')]
        out = ml.report(rows, NOW)
        self.assertEqual((out['merged']['count'], out['missingOrInvalid']), (0, 1))

    def test_percentiles_nearest_rank(self):
        self.assertIsNone(ml.percentile([], 50))
        values = list(range(1, 11))
        self.assertEqual([ml.percentile(values, p) for p in (50, 90, 95, 100)], [5, 9, 10, 10])
        self.assertEqual(ml.stats([30, 10, 20])['p50'], 20)
        self.assertEqual(ml.stats([])['max'], None)

    def test_offsets_legacy_fields_and_since(self):
        rows = [dict(job='old', pr=URL % 1, status='PUBLISHED', ts='2026-11-01T00:00:00+0000'),
                dict(job='new', pr=URL % 2, status='PUBLISHED', ts='2026-11-09T05:00:00-0500'),
                dict(job='new', pr=URL % 2, status='MERGED', ts='2026-11-09T11:00:00+01:00')]
        self.assertEqual(ml.report(rows, NOW)['queued']['count'], 1)
        out = ml.report(rows, NOW, since=datetime(2026, 11, 8, tzinfo=timezone.utc))
        self.assertEqual((out['merged']['p50'], out['queued']['count']), (0.0, 0))

    def test_cli_json_and_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Path(tmp) / 'jobs.jsonl'
            ledger.write_text('\n'.join([json.dumps(pub('a', 1, '2026-11-09T10:00:00Z')),
                                         'not json', '[]', '',
                                         json.dumps(end('a', 1, 'MERGED', '2026-11-09T11:00:00Z'))]))
            buf = io.StringIO()
            with redirect_stdout(buf):
                self.assertEqual(ml.main(['--jobs', str(ledger), '--json', '--now', '2026-11-09T12:00:00Z']), 0)
            data = json.loads(buf.getvalue())
            self.assertEqual((data['merged']['p95'], data['malformedLines']), (3600.0, 2))
            buf = io.StringIO()
            with redirect_stdout(buf):
                ml.main(['--jobs', str(ledger), '--now', '2026-11-09T12:00:00Z'])
            self.assertIn('p50 1h00m', buf.getvalue())
            self.assertEqual(ml.main(['--jobs', str(Path(tmp) / 'missing')]), 1)
            self.assertEqual(ml.main(['--jobs', str(ledger), '--now', 'nope']), 2)


if __name__ == '__main__':
    unittest.main()
