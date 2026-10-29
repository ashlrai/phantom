from concurrent.futures import ThreadPoolExecutor
import importlib.machinery
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'metrics-outcomes'
LOADER = importlib.machinery.SourceFileLoader('metrics_outcomes', str(SCRIPT))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
metrics = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(metrics)
FIXTURES = json.loads((Path(__file__).parent / 'fixtures/prs.json').read_text())


class ReconcileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'jobs.jsonl'
        self.rows = [dict(jobId=f'job-{i}', prUrl=url, outcome='PUBLISHED',
                          ts='2026-10-25T18:50:00Z', pool='codex-personal')
                     for i, url in enumerate(FIXTURES)]
        self.write(self.rows)

    def write(self, rows):
        self.path.write_text('\n'.join(json.dumps(r) for r in rows))

    def test_fork_squash_closed_and_idempotent_replay(self):
        original = self.path.read_bytes()
        self.assertEqual(metrics.reconcile(self.path, FIXTURES.__getitem__), (3, 0))
        rows = metrics.records(self.path.read_text())
        self.assertTrue(self.path.read_bytes().startswith(original))
        self.assertEqual([r['outcome'] for r in rows[3:]], ['MERGED', 'MERGED', 'CLOSED'])
        for event, fixture in zip(rows[3:], FIXTURES.values()):
            self.assertEqual(event['ts'], fixture['mergedAt'] or fixture['closedAt'])
            self.assertEqual(event['pool'], 'codex-personal')
        before = self.path.read_bytes()
        self.assertEqual(metrics.reconcile(self.path, lambda _: self.fail('already resolved')), (0, 0))
        self.assertEqual(self.path.read_bytes(), before)

    def test_open_failure_and_retry(self):
        def lookup(url):
            if url.endswith('101'):
                return {'state': 'OPEN', 'mergedAt': None}
            if url.endswith('102'):
                raise ValueError('unavailable')
            return FIXTURES[url]
        self.assertEqual(metrics.reconcile(self.path, lookup), (1, 1))
        self.assertEqual(metrics.reconcile(self.path, FIXTURES.__getitem__), (2, 0))

    def test_duplicate_publications_and_legacy_fields(self):
        row = dict(job='legacy', pr=next(iter(FIXTURES)) + '/', status='PUBLISHED')
        self.write([row, row])
        self.assertEqual(metrics.reconcile(self.path, FIXTURES.__getitem__), (1, 0))
        self.assertEqual(metrics.records(self.path.read_text())[-1]['status'], 'MERGED')

    def test_malformed_ledger_is_not_modified(self):
        self.path.write_text(json.dumps(self.rows[0]) + '\n{')
        before = self.path.read_bytes()
        with self.assertRaises(ValueError):
            metrics.reconcile(self.path, FIXTURES.__getitem__)
        self.assertEqual(self.path.read_bytes(), before)

    def test_incomplete_terminal_evidence_is_not_recorded(self):
        self.assertEqual(metrics.reconcile(self.path, lambda _: {'state': 'MERGED'}), (0, 3))

    def test_concurrent_reconcilers_append_once(self):
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(metrics.reconcile, self.path, FIXTURES.__getitem__)
                       for _ in range(2)]
            results = [future.result() for future in futures]
        self.assertEqual(sorted(results), [(0, 0), (3, 0)])
        self.assertEqual(len(metrics.records(self.path.read_text())), 6)

    def test_shared_pr_is_resolved_once_for_distinct_jobs(self):
        first = self.rows[0]
        second = dict(first, jobId='another-job')
        self.write([first, second])
        with patch.object(metrics, 'github_pr', return_value=FIXTURES[first['prUrl']]) as lookup:
            self.assertEqual(metrics.reconcile(self.path, lookup), (2, 0))
            self.assertEqual(lookup.call_count, 1)

    def test_existing_outcome_only_suppresses_matching_job_and_pr(self):
        self.write(self.rows + [dict(self.rows[0], outcome='MERGED')])
        self.assertEqual(metrics.reconcile(self.path, FIXTURES.__getitem__), (2, 0))

    def test_invalid_response_is_retryable(self):
        self.assertEqual(metrics.reconcile(self.path, lambda _: []), (0, 3))

    def test_gh_uses_full_url_and_authoritative_fields(self):
        url = next(iter(FIXTURES))
        with patch.object(metrics.subprocess, 'run') as run:
            run.return_value.returncode = 0
            run.return_value.stdout = json.dumps(FIXTURES[url])
            self.assertEqual(metrics.github_pr(url), FIXTURES[url])
            self.assertEqual(run.call_args.args[0],
                             ['gh', 'pr', 'view', url, '--json', 'state,mergedAt,closedAt'])


if __name__ == '__main__':
    unittest.main()
