"""Regression coverage for capability failure retry evidence."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[3]
NOW = 1760000000
FAILURE = 'empty_capability_gh_unavailable'


class OwnerQualification(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('launch_precheck', ROOT / 'contrib/mac/launch_precheck.py')
        cls.helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.helper)

    def setUp(self):
        self.identity = dict(repo='phantom', base_sha='base', task_hash='task', prompt_hash='prompt')
        self.claim = dict(self.identity, event='claim', job='job', lane='claude')
        self.finish = dict(event='finish', job='job', empty=True, exit_code=0,
                           ts=datetime.fromtimestamp(NOW, timezone.utc).isoformat(),
                           capability_failure=FAILURE)

    def test_new_claim_and_productive_retry_supersede_failure(self):
        h = self.helper
        self.assertEqual(h.empty_retry_blocks(self.identity, [self.claim, self.finish], NOW), {'claude': FAILURE})
        self.assertEqual(h.empty_retry_blocks(self.identity, [self.claim, self.finish, self.claim], NOW), {})
        self.assertEqual(h.empty_retry_blocks(self.identity, [self.claim, self.finish, self.claim,
                         dict(self.finish, empty=False)], NOW), {})
        self.assertIsNone(h.empty_reason('job', self.identity, [self.claim, self.finish], NOW))

    def test_repository_identity_does_not_leak(self):
        self.assertEqual(self.helper.empty_retry_blocks(dict(self.identity, repo='locus'),
                         [self.claim, self.finish], NOW), {})
        self.assertIsNone(self.helper.empty_reason('job', dict(self.identity, repo='locus'),
                          [self.claim, self.finish], NOW))

    def test_unknown_and_bad_timestamps_are_not_completion_or_holds(self):
        h = self.helper
        for stamp in ('bad', None, datetime.fromtimestamp(NOW + 1, timezone.utc).isoformat(),
                      datetime.fromtimestamp(NOW - 86400, timezone.utc).isoformat()):
            with self.subTest(stamp=stamp):
                finish = dict(self.finish, ts=stamp)
                self.assertEqual(h.empty_retry_blocks(self.identity, [self.claim, finish], NOW), {})
                self.assertIsNone(h.empty_reason('job', self.identity, [self.claim, finish], NOW))
        for failure in (None, 'unknown'):
            finish = dict(self.finish, capability_failure=failure, exit_code=1)
            self.assertEqual(h.empty_retry_blocks(self.identity, [self.claim, finish], NOW), {})
            self.assertIsNone(h.empty_reason('job', self.identity, [self.claim, finish], NOW))

    def test_gh_diagnostics_and_prose(self):
        h = self.helper
        for diagnostic in (
            'failed to create root command: failed to read configuration: open /fixture/.config/gh/config.yml: operation not permitted',
            'error reading configuration: open /fixture/.config/gh/config.yml: permission denied',
            'gh: command not found',
        ):
            with self.subTest(diagnostic=diagnostic):
                self.assertEqual(h.capability_failure(diagnostic), FAILURE)
        for prose in ('The task mentions gh and operation not permitted', 'Use gh to inspect the PR'):
            self.assertIsNone(h.capability_failure(prose))

    def test_successful_empty_still_suppresses(self):
        finish = dict(self.finish)
        finish.pop('capability_failure')
        self.assertEqual(self.helper.empty_reason('job', self.identity, [self.claim, finish], NOW),
                         'prompt_empty_same_base_24h')
        self.assertIsNone(self.helper.empty_reason('job', self.identity,
                          [self.claim, finish, self.claim], NOW))

    def test_log_evidence_is_bounded_to_matching_finish(self):
        h = self.helper
        with tempfile.TemporaryDirectory() as tmp:
            runs = Path(tmp)
            (runs / 'metrics').mkdir()
            now = datetime.now(timezone.utc).timestamp()
            finish = dict(self.finish, ts=datetime.fromtimestamp(now, timezone.utc).isoformat())
            log = runs / 'job.log'
            log.write_text('error reading configuration: open /fixture/.config/gh/config.yml: permission denied\n')
            os.utime(log, (now, now))
            ledger = runs / 'metrics/jobs.jsonl'
            ledger.write_text(''.join(json.dumps(row) + '\n' for row in (self.claim, finish)))
            # Remove the typed field so the candidate must inspect the log.
            finish.pop('capability_failure')
            ledger.write_text(''.join(json.dumps(row) + '\n' for row in (self.claim, finish)))
            self.assertEqual(h.read_attempts(str(runs))[-1].get('capability_failure'), FAILURE)
            os.utime(log, (now - 121, now - 121))
            self.assertNotIn('capability_failure', h.read_attempts(str(runs))[-1])
            os.utime(log, (now, now))
            ledger.write_text(''.join(json.dumps(row) + '\n' for row in (self.claim, finish, self.claim)))
            self.assertNotIn('capability_failure', h.read_attempts(str(runs))[1])


if __name__ == '__main__':
    unittest.main()
