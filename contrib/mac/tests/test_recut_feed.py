"""Offline public REST fixtures and queue-write regressions."""
import fcntl
import importlib.util
from pathlib import Path
import tempfile
from unittest.mock import patch
import io
import contextlib
import unittest

SPEC = importlib.util.spec_from_file_location('recut_feed', Path(__file__).parents[1] / 'recut-feed.py')
feed = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(feed)


TEMPLATE = ('- DONE RQ-RC3401N9Q8 (P0, pool=codex-personal, tier=frontier, repo=phantom, size<=300, src=leader): '
            'Recut https://github.com/ashlrai/phantom/pull/3401; preserve intent.\n')


def plan(rows, queue='', maximum=6):
    return feed.plan(rows, TEMPLATE + queue, maximum)


def pr(number=1, repo='phantom', **values):
    return dict({'repo': repo, 'number': number, 'state': 'open', 'mergeable_state': 'dirty',
                 'created_at': f'2026-01-{number:02}T00:00:00Z', 'body': ''}, **values)


class RecutFeedTests(unittest.TestCase):
    def test_dirty_clean_closed_unknown_and_oldest(self):
        rows = [pr(4), pr(2, mergeable_state='clean'), pr(3, state='closed'),
                pr(5, mergeable_state=None), pr(1)]
        lines = plan(rows, '', 6)
        self.assertEqual(len(lines), 2)
        self.assertIn('RQ-RCFP1Q8', lines[0])
        self.assertIn('RQ-RCFP4Q8', lines[1])
        self.assertTrue(lines[0].startswith('- READY RQ-RCFP1Q8 (P0, pool=codex-personal, tier=frontier, repo=phantom,'))

    def test_reference_text_is_copied_and_required(self):
        line = plan([pr(7, repo='locus')])[0]
        self.assertTrue(line.endswith('Recut https://github.com/ashlrai/locus/pull/7; preserve intent.'))
        self.assertIn('repo=locus', line)
        with self.assertRaises(ValueError):
            feed.plan([pr()], '', 6)

    def test_pool_stamp_replaces_reference_pool(self):
        line = feed.plan([pr()], TEMPLATE, 6, pool='devin')[0]
        self.assertIn('pool=devin', line)
        self.assertNotIn('pool=codex-personal', line)
        self.assertTrue(line.startswith('- READY RQ-RCFP1Q8 (P0, pool=devin,'))

    def test_dedupe_queue_and_supersedes(self):
        queue = ('- READY OTHER (repo=phantom): PR #1\n'
                 '- CLAIMED NEXT (repo=phantom): https://github.com/ashlrai/phantom/pull/2\n'
                 'Supersedes https://github.com/ashlrai/phantom/pull/3\n')
        rows = [pr(n) for n in range(1, 6)]
        rows[-1]['body'] = 'Supersedes #4'
        lines = plan(rows, queue, 6)
        self.assertEqual(len(lines), 1)
        self.assertIn('RQ-RCFP5Q8', lines[0])
        self.assertEqual(plan(rows, queue + lines[0], 6), [])

    def test_repo_scope_and_max(self):
        queue = '- READY OTHER (repo=locus): PR #1\n'
        rows = [pr(n) for n in range(1, 9)]
        self.assertEqual(len(plan(rows, queue, 6)), 6)
        self.assertEqual(len(plan(rows, queue, 2)), 2)
        self.assertEqual(plan(rows, queue, 0), [])
        ids = [plan([pr(repo=r)], '', 1)[0].split()[2] for r in feed.REPOS]
        self.assertEqual(len(set(ids)), 7)

    def test_rest_pagination_and_detail(self):
        calls = []
        def get(path):
            calls.append(path)
            if '?' not in path:
                return pr()
            return [{'number': 1}] * (100 if path.endswith('page=1') and '/phantom/' in path else 0)
        rows = feed.fetch_prs(get)
        self.assertEqual(len(rows), 100)
        self.assertTrue(any(path.endswith('page=2') for path in calls))
        self.assertEqual(sum('/pulls?' in p for p in calls), 8)

    def test_dry_run_apply_repeat_and_missing_queue(self):
        with tempfile.TemporaryDirectory() as directory:
            queue = Path(directory) / 'router-queue.md'
            with self.assertRaises(FileNotFoundError):
                feed.run([pr()], queue, 6, False, 0)
            queue.write_text(TEMPLATE + 'existing')
            report = feed.run([pr()], queue, 6, False, 0)
            self.assertEqual(report['count'], 1)
            self.assertEqual(queue.read_text(), TEMPLATE + 'existing')
            self.assertFalse(queue.with_name('ready.lock').exists())
            feed.run([pr()], queue, 6, True, 0)
            self.assertIn('existing\n- READY', queue.read_text())
            self.assertEqual(feed.run([pr()], queue, 6, True, 0)['count'], 0)

    def test_api_error_never_applies_partial_results(self):
        with tempfile.TemporaryDirectory() as directory:
            queue = Path(directory) / 'router-queue.md'
            queue.write_text(TEMPLATE)
            with patch.object(feed, 'fetch_prs', side_effect=OSError('offline')), \
                    patch('sys.argv', ['recut-feed.py', '--apply', '--queue', str(queue)]), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(feed.main(), 1)
            self.assertIn('OSError', output.getvalue())
            self.assertEqual(queue.read_text(), TEMPLATE)

    def test_lock_timeout_and_locked_reread(self):
        with tempfile.TemporaryDirectory() as directory:
            queue = Path(directory) / 'router-queue.md'
            queue.write_text(TEMPLATE + 'unchanged\n')
            with queue.with_name('ready.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaises(TimeoutError):
                    feed.run([pr()], queue, 6, True, 0.02)
            self.assertEqual(queue.read_text(), TEMPLATE + 'unchanged\n')
            queue.write_text(TEMPLATE + plan([pr()], '', 1)[0])
            self.assertEqual(feed.run([pr()], queue, 6, True, 0)['count'], 0)
