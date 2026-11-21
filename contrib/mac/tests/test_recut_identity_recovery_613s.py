"""RQ-PHX-RECUTIDENTITYRECOVER613S: recut identity and empty-result recovery (from #6469).

Fake repositories, fake heads and temporary files only.
"""
from concurrent.futures import ThreadPoolExecutor
import contextlib
import fcntl
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('recut_feed_613s', Path(__file__).parents[1] / 'recut-feed.py')
feed = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(feed)

TEMPLATE = ('- DONE RQ-RC3401N9Q8 (P0, pool=codex-personal, tier=frontier, repo=phantom, size<=300, src=leader): '
            'Recut https://github.com/ashlrai/phantom/pull/3401; preserve intent.\n')
A, B = 'a' * 40, 'b' * 40


def pr(number=1, head=A, **values):
    row = {'repo': 'phantom', 'number': number, 'state': 'open', 'mergeable_state': 'dirty',
           'created_at': f'2026-01-{number:02}T00:00:00Z', 'body': ''}
    if head is not None:
        row['head'] = {'sha': head}
    return dict(row, **values)


def make_tree(root):
    (root / 'queue').mkdir()
    (root / 'metrics').mkdir()
    queue = root / 'queue/router-queue.md'
    queue.write_text(TEMPLATE)
    return queue, root / 'metrics/jobs.jsonl'


class RecutIdentityRecovery(unittest.TestCase):
    def test_identity_ignores_lane_and_generated_job_name(self):
        line = feed.plan([pr()], TEMPLATE, 6, 'codex-personal')[0]
        self.assertIn(f'source-head={A}', line)
        self.assertIn(f'RQ-RCFP1Q8-{A.upper()}', line)
        renamed = line.replace(f'RQ-RCFP1Q8-{A.upper()}', 'RQ-ALTERNATE-NAME').replace('pool=codex-personal', 'pool=devin')
        for status in ('READY', 'CLAIMED', 'RUNNING', 'PR-OPEN'):
            queue = TEMPLATE + renamed.replace('- READY', f'- {status}')
            self.assertEqual(feed.plan([pr()], queue, 6, 'grok'), [], status)

    def test_full_sha_collision_stays_distinct(self):
        near = A[:-1] + 'b'  # shares a 39-character prefix
        line = feed.plan([pr()], TEMPLATE, 6)[0]
        again = feed.plan([pr(head=near)], TEMPLATE + line, 6)
        self.assertEqual(len(again), 1)
        self.assertNotEqual(line.split()[2], again[0].split()[2])

    def test_unknown_or_malformed_candidate_head_waits(self):
        for head in (None, 'unavailable', A[:12], A + 'a', 'G' * 40):
            self.assertEqual(feed.plan([pr(head=head)], TEMPLATE, 6), [], head)
        self.assertEqual(feed.plan([pr(head={})], TEMPLATE, 6), [])
        self.assertEqual(feed.plan([pr(head=['x'])], TEMPLATE, 6), [])

    def test_legacy_active_reference_without_head_suppresses_every_head(self):
        queue = TEMPLATE + '- READY LEGACY-NAME (repo=phantom): Recut PR #1\n'
        self.assertEqual(feed.plan([pr(head=A)], queue, 6), [])
        self.assertEqual(feed.plan([pr(head=B)], queue, 6), [])

    def test_empty_result_survives_queue_cleanup_until_head_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            queue, metrics = make_tree(Path(directory))
            job = feed.plan([pr()], TEMPLATE, 6)[0].split()[2]
            for outcome in ({'empty': True}, {'state': 'DONE-NOOP'}, {'state': 'EMPTY'}):
                metrics.write_text('torn{\n[]\n"x"\n' + json.dumps(dict(job=job, **outcome)) + '\n')
                for apply in (False, True):
                    self.assertEqual(feed.run([pr()], queue, 6, apply, 1)['count'], 0)
                self.assertEqual(queue.read_text(), TEMPLATE)  # terminal rows already removed
            changed = pr(head=B)
            self.assertEqual(feed.run([changed], queue, 6, True, 1)['count'], 1)
            self.assertEqual(feed.run([changed], queue, 6, True, 1)['count'], 0)

    def test_metrics_tail_is_bounded_and_missing_metrics_are_empty(self):
        with tempfile.TemporaryDirectory() as directory:
            queue, metrics = make_tree(Path(directory))
            self.assertEqual(feed.read_empty_jobs(queue), set())
            old = json.dumps({'job': 'OLD', 'empty': True}) + '\n'
            filler = json.dumps({'job': 'x', 'pad': 'p' * 1000}) + '\n'
            metrics.write_text(old + filler * (17 * 1024) + json.dumps({'job': 'NEW', 'empty': True}) + '\n')
            self.assertEqual(feed.read_empty_jobs(queue), {'NEW'})

    def test_concurrent_pools_append_exactly_one_line(self):
        with tempfile.TemporaryDirectory() as directory:
            queue, _ = make_tree(Path(directory))
            barrier = threading.Barrier(3)

            def enqueue(pool):
                barrier.wait(timeout=5)
                return feed.run([pr(), pr()], queue, 6, True, 5, pool)['count']
            with ThreadPoolExecutor(max_workers=3) as workers:
                counts = sorted(workers.map(enqueue, ('codex-personal', 'devin', 'grok')))
            self.assertEqual(counts, [0, 0, 1])
            self.assertEqual(queue.read_text().count('- READY '), 1)

    def test_apply_rereads_queue_and_empty_evidence_under_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            queue, metrics = make_tree(Path(directory))
            job = feed.plan([pr()], TEMPLATE, 6)[0].split()[2]
            with queue.with_name('ready.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                with self.assertRaises(TimeoutError):
                    feed.run([pr()], queue, 6, True, 0)
                self.assertEqual(queue.read_text(), TEMPLATE)
                # Evidence arrives while the lock is held; the waiter must see it.
                metrics.write_text(json.dumps({'job': job, 'empty': True}) + '\n')
                fcntl.flock(lock, fcntl.LOCK_UN)
            self.assertEqual(feed.run([pr()], queue, 6, True, 1)['count'], 0)
            self.assertEqual(queue.read_text(), TEMPLATE)

    def test_dry_run_does_not_mutate_or_create_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            queue, _ = make_tree(Path(directory))
            report = feed.run([pr()], queue, 6, False, 1)
            self.assertEqual((report['schemaVersion'], report['dryRun'], report['count']), (1, True, 1))
            self.assertEqual(queue.read_text(), TEMPLATE)
            self.assertFalse(queue.with_name('ready.lock').exists())

    def test_cli_keeps_output_schema_and_dry_run_default(self):
        with tempfile.TemporaryDirectory() as directory:
            queue, _ = make_tree(Path(directory))
            out = io.StringIO()
            argv = ['recut-feed.py', '--queue', str(queue)]
            with patch('sys.argv', argv), patch.object(feed, 'fetch_prs', return_value=[pr()]), \
                    contextlib.redirect_stdout(out):
                self.assertEqual(feed.main(), 0)
            report = json.loads(out.getvalue())
            self.assertEqual(sorted(report), ['count', 'dryRun', 'lines', 'schemaVersion'])
            self.assertTrue(report['dryRun'])
            self.assertEqual(queue.read_text(), TEMPLATE)


if __name__ == '__main__':
    unittest.main()
