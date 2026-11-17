"""Hermetic qualification of the current freshness and repair boundaries."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from launch_precheck import admission_history, repair_freshness, terminal_target


class FreshnessOwnerQualification(unittest.TestCase):
    job = 'RQ-FIXUP-phantom-42-abcdef0'
    sha = 'abcdef0' + '1' * 33
    url = 'https://github.com/ashlrai/phantom/pull/42'

    def lookup(self, payload, code=0):
        calls = []
        def runner(cmd, timeout, **kwargs):
            calls.append((cmd, timeout, kwargs))
            return subprocess.CompletedProcess(cmd, code, payload, '')
        return runner, calls

    def check(self, data, prompt=None, code=0):
        runner, calls = self.lookup(data if isinstance(data, str) else json.dumps(data), code)
        with tempfile.TemporaryDirectory() as home:
            result = repair_freshness(self.job, 'phantom', prompt or self.job + ' (check="CI"): fix', home, runner)
            self.assertEqual(calls[0][0], ['locus', 'exec', '--', 'gh', 'pr', 'view', '42', '--repo',
                                          'ashlrai/phantom', '--json', 'number,state,headRefOid,mergeable,statusCheckRollup'])
            self.assertEqual(calls[0][1:], (3, {'cwd': home}))
        return result

    def test_terminal_and_moved_head(self):
        for state in ('MERGED', 'CLOSED'):
            with self.subTest(state=state):
                self.assertEqual(self.check({'number': 42, 'state': state}), 'target_pr_' + state.lower())
        self.assertIsNone(self.check({'number': 42, 'state': 'OPEN', 'headRefOid': 'f' * 40,
                                      'statusCheckRollup': [{'__typename': 'CheckRun', 'name': 'CI',
                                                             'status': 'COMPLETED', 'conclusion': 'SUCCESS'}]}))

    def test_unavailable_and_malformed_fail_open(self):
        for data, code in [('', 1), ('{', 0), ('[]', 0), ('x' * 65537, 0),
                           ({'number': 43, 'state': 'MERGED'}, 0),
                           ({'number': True, 'state': 'MERGED'}, 0),
                           ({'number': 42, 'state': 'OPEN', 'headRefOid': 'bad'}, 0)]:
            with self.subTest(data=str(data)[:80], code=code):
                self.assertIsNone(self.check(data, code=code))
        def unavailable(*args, **kwargs):
            raise subprocess.TimeoutExpired('fake', 3)
        self.assertIsNone(repair_freshness(self.job, 'phantom', '', '/fake', unavailable))

    def test_exact_head_requires_named_and_all_successful_checks(self):
        pr = {'number': 42, 'state': 'OPEN', 'headRefOid': self.sha,
              'statusCheckRollup': [{'__typename': 'CheckRun', 'name': 'CI',
                                     'status': 'COMPLETED', 'conclusion': 'SUCCESS'}]}
        self.assertEqual(self.check(pr), 'target_pr_checks_resolved')
        self.assertIsNone(self.check(pr, self.job + ' (P1): fix'))
        for check in ({'__typename': 'CheckRun', 'name': 'CI', 'status': 'IN_PROGRESS'},
                      {'__typename': 'CheckRun', 'name': 'other', 'status': 'COMPLETED', 'conclusion': 'SUCCESS'},
                      {'__typename': 'StatusContext', 'context': 'other', 'state': 'FAILURE'}, None):
            with self.subTest(check=check):
                self.assertIsNone(self.check({**pr, 'statusCheckRollup': [check]}))
        self.assertIsNone(self.check({**pr, 'statusCheckRollup': pr['statusCheckRollup'] + [
            {'__typename': 'StatusContext', 'context': 'other', 'state': 'FAILURE'}]}))

    def test_envelope_and_repo_scoped_evidence(self):
        states = {self.url: 'MERGED'}
        self.assertEqual(terminal_target('J', 'phantom', 'J (pr=42): fix', states), 'target_pr_merged')
        for prompt in ('J (parent_pr=42): fix', 'J (parent-pr=42): fix',
                       'J (P1): mentions pr=42', 'J (pr=42, pr=43): fix'):
            with self.subTest(prompt=prompt):
                self.assertIsNone(terminal_target('J', 'phantom', prompt, states))
        self.assertIsNone(terminal_target('J', 'locus', 'J (pr=42): fix', states))
        _, observed = admission_history([{'event': 'outcome', 'state': 'MERGED', 'repo': 'phantom',
                                          'job': 'J', 'ts': '2026-01-01T00:00:00+00:00'}], 1800000000)
        self.assertIsNone(terminal_target('J', 'phantom', '', observed))
        self.assertEqual(terminal_target(self.job, 'phantom', '', states), 'target_pr_merged')


if __name__ == '__main__':
    unittest.main()
