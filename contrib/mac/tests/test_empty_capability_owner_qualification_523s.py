"""Qualify PR 6528's helper directly from its explicitly fetched review ref."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone

REF = 'refs/review/6528-qualification-523s'
ROOT = Path(__file__).resolve().parents[3]
NOW = 1760000000
FAILURE = 'empty_capability_gh_unavailable'


class OwnerQualification(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        path = Path(cls.tmp.name) / 'launch_precheck.py'
        path.write_bytes(subprocess.check_output(
            ['git', 'show', REF + ':contrib/mac/launch_precheck.py'], cwd=ROOT))
        spec = importlib.util.spec_from_file_location('candidate_6528', path)
        cls.helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.helper)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

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
            ledger.write_text(''.join(json.dumps(row) + '\n' for row in (self.claim, finish, self.claim)))
            self.assertNotIn('capability_failure', h.read_attempts(str(runs))[1])


if __name__ == '__main__':
    unittest.main()
