"""Coverage for the RQ-MERGELAT9Q8 (PR #4265) features recut onto the
merge-latency.v1 analyzer: the published-to-merge boundary, in-flight
queue age, closed count, per-pool percentiles, --since-hours and the
default ledger path. Exercised through analyze() and the real CLI."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'merge-latency.py'
SPEC = importlib.util.spec_from_file_location('merge_latency_recut', SCRIPT)
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)

NOW = m.timestamp('2026-11-09T12:00:00Z')


def row(job, state, ts=None, **extra):
    out = dict(jobId=job, outcome=state)
    if ts is not None:
        out['ts'] = ts
    out.update(extra)
    return out


def run_cli(*args, home=None):
    env = dict(os.environ)
    if home is not None:
        env['HOME'] = home
    return subprocess.run([sys.executable, str(SCRIPT), *args],
                          capture_output=True, text=True, env=env)


class PublishedBoundaryTests(unittest.TestCase):
    def test_published_to_merge_measured_independently(self):
        rows = [row('pub', 'PUBLISHED', '2026-11-09T10:00:00Z'),
                row('pub', 'MERGED', '2026-11-09T10:30:00Z'),
                row('both', 'QUEUED', '2026-11-09T09:00:00Z'),
                row('both', 'PUBLISHED', '2026-11-09T09:30:00Z'),
                row('both', 'MERGED', '2026-11-09T11:30:00Z')]
        report = m.analyze(rows, NOW)
        self.assertEqual(report['publishedMeasured'], 2)
        self.assertEqual(report['publishedToMergeSeconds']['p50'], 1800)
        self.assertEqual(report['publishedToMergeSeconds']['p99'], 7200)
        self.assertEqual(report['measured'], 1)  # only 'both' has a queue boundary
        by_job = {j['job']: j for j in report['jobs']}
        self.assertEqual(by_job['pub']['publishedToMergeSeconds'], 1800)
        self.assertIsNone(by_job['pub']['publishedUnmeasuredReason'])
        self.assertEqual(by_job['pub']['unmeasuredReason'], 'missing_or_ambiguous_boundaries')
        self.assertEqual(by_job['both']['queueToMergeSeconds'], 9000)
        self.assertEqual(by_job['both']['publishedToMergeSeconds'], 7200)

    def test_published_guards_match_queue_guards(self):
        rows = [row('rev', 'PUBLISHED', '2026-11-09T10:00:00Z'),
                row('rev', 'MERGED', '2026-11-09T09:00:00Z'),
                row('dupe', 'PUBLISHED', '2026-11-09T10:00:00Z'),
                row('dupe', 'PUBLISHED', '2026-11-09T10:05:00Z'),
                row('dupe', 'MERGED', '2026-11-09T11:00:00Z'),
                row('clash', 'PUBLISHED', '2026-11-09T10:00:00Z', prUrl='pr/1'),
                row('clash', 'MERGED', '2026-11-09T11:00:00Z', prUrl='pr/2')]
        report = m.analyze(rows, NOW)
        self.assertEqual(report['publishedMeasured'], 0)
        by_job = {j['job']: j for j in report['jobs']}
        self.assertEqual(by_job['rev']['publishedUnmeasuredReason'], 'reversed_or_future_timestamp')
        self.assertEqual(by_job['dupe']['publishedUnmeasuredReason'], 'missing_or_ambiguous_boundaries')
        self.assertEqual(by_job['clash']['publishedUnmeasuredReason'], 'conflicting_outcomes_or_prs')


class QueueSummaryTests(unittest.TestCase):
    def test_queued_closed_and_generated_at(self):
        rows = [row('old', 'PUBLISHED', '2026-11-09T04:00:00Z'),
                row('new', 'QUEUED', '2026-11-09T11:30:00Z'),
                row('done', 'PUBLISHED', '2026-11-09T10:00:00Z'),
                row('done', 'CLOSED', '2026-11-09T10:10:00Z'),
                row('failed', 'QUEUED', '2026-11-09T05:00:00Z'),
                row('failed', 'FAILED', '2026-11-09T06:00:00Z')]
        report = m.analyze(rows, NOW)
        self.assertEqual(report['queued'], {'count': 2, 'oldestAgeSeconds': 28800})
        self.assertEqual(report['closed'], 1)
        self.assertEqual(report['generatedAt'], '2026-11-09T12:00:00+00:00')

    def test_colonless_offset_and_naive_ts(self):
        self.assertEqual(m.timestamp('2026-11-01T00:00:00+0000'),
                         m.timestamp('2026-11-01T00:00:00Z'))
        self.assertIsNone(m.timestamp('2026-11-01T00:00:00'))

    def test_queued_empty_when_everything_terminal_or_boundariless(self):
        rows = [row('done', 'MERGED', '2026-11-09T10:00:00Z'),
                row('silent', 'HELD', reason='required checks')]
        report = m.analyze(rows, NOW)
        self.assertEqual(report['queued'], {'count': 0, 'oldestAgeSeconds': None})

    def test_by_pool_groups_measured_durations(self):
        stamps = {'a': '2026-11-09T10:10:00Z', 'b': '2026-11-09T10:30:00Z',
                  'c': '2026-11-09T11:00:00Z', 'd': '2026-11-09T10:15:00Z'}
        rows = []
        for job, pool in [('a', 'codex'), ('b', 'codex'), ('c', 'devin'), ('d', None)]:
            rows.append(row(job, 'QUEUED', '2026-11-09T10:00:00Z', pool=pool))
            rows.append(row(job, 'MERGED', stamps[job]))
        report = m.analyze(rows, NOW)
        self.assertEqual(report['measured'], 4)
        self.assertEqual(report['byPool']['codex'], {'count': 2, 'p50': 600, 'p90': 1800,
                                                     'p95': 1800, 'p99': 1800})
        self.assertEqual(report['byPool']['devin']['count'], 1)
        self.assertEqual(report['byPool']['unknown'], {'count': 1, 'p50': 900, 'p90': 900,
                                                       'p95': 900, 'p99': 900})


class SinceWindowTests(unittest.TestCase):
    def test_since_drops_jobs_with_old_boundaries(self):
        rows = [row('old', 'PUBLISHED', '2026-11-01T00:00:00Z'),
                row('old', 'MERGED', '2026-11-01T01:00:00Z'),
                row('recent', 'QUEUED', '2026-11-09T11:00:00Z'),
                row('recent', 'MERGED', '2026-11-09T11:30:00Z'),
                row('open', 'PUBLISHED', '2026-11-09T11:45:00Z')]
        since = NOW - 6 * 3600
        report = m.analyze(rows, NOW, since=since)
        self.assertEqual([j['job'] for j in report['jobs']], ['open', 'recent'])
        self.assertEqual(report['measured'], 1)
        self.assertEqual(report['publishedMeasured'], 0)  # 'old' filtered before outcome pairing
        self.assertEqual(report['queued'], {'count': 1, 'oldestAgeSeconds': 900})

    def test_since_none_keeps_everything(self):
        rows = [row('old', 'PUBLISHED', '2020-01-01T00:00:00Z'),
                row('old', 'MERGED', '2020-01-01T01:00:00Z')]
        report = m.analyze(rows, NOW)
        self.assertEqual(report['publishedMeasured'], 1)
        self.assertEqual(len(report['jobs']), 1)


class CliTests(unittest.TestCase):
    def test_cli_default_jobs_path_since_and_read_only(self):
        with tempfile.TemporaryDirectory() as home:
            ledger = Path(home) / '.ashlr-runs/metrics/jobs.jsonl'
            ledger.parent.mkdir(parents=True)
            rows = [row('a', 'QUEUED', '2026-11-09T10:00:00Z'),
                    row('a', 'MERGED', '2026-11-09T11:00:00Z'),
                    row('stale', 'PUBLISHED', '2026-11-01T00:00:00Z')]
            ledger.write_text('\n'.join(json.dumps(r) for r in rows) + '\n')
            before = ledger.read_bytes()
            result = run_cli('--now', '2026-11-09T12:00:00Z', home=home)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report['schemaVersion'], 'merge-latency.v1')
            self.assertEqual(report['measured'], 1)
            self.assertEqual(report['queueToMergeSeconds']['p50'], 3600)
            self.assertEqual(report['queued']['count'], 1)
            self.assertEqual(ledger.read_bytes(), before)
            result = run_cli('--now', '2026-11-09T12:00:00Z', '--since-hours', '3', home=home)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report['measured'], 1)
            self.assertEqual(report['queued']['count'], 0)

    def test_cli_rejects_bad_since_and_missing_default(self):
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as tmp:
            ledger = Path(tmp) / 'jobs.jsonl'
            ledger.write_text(json.dumps(row('a', 'QUEUED', '2026-11-09T10:00:00Z')))
            result = run_cli('--jobs', str(ledger), '--since-hours', '-1', home=home)
            self.assertEqual(result.returncode, 2)
            result = run_cli('--jobs', str(ledger), '--since-hours', 'nan', home=home)
            self.assertEqual(result.returncode, 2)
            result = run_cli('--now', '2026-11-09T12:00:00Z', home=home)
            self.assertEqual(result.returncode, 2)  # default ledger absent
            self.assertEqual(result.stdout, '')


if __name__ == '__main__':
    unittest.main()
