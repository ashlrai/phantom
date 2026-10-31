import unittest
import os
from pathlib import Path
import subprocess
import tempfile
from recovery import claim, recover


class RecoveryTest(unittest.TestCase):
    def setUp(self):
        self.queue = {'RQ-A': dict(status='RUNNING', receipt='a1', attempts=1,
                                   pool='claude', prompt='repair existing code'),
                      'RQ-B': dict(status='READY', attempts=0, pool='devin')}

    def test_existing_files_tests_and_symbols_do_not_prove_acceptance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'clone' / '.git').mkdir(parents=True)
            git = root / 'git'
            git.write_text('#!/bin/sh\ncase "$*" in\n*symbolic-ref*) echo origin/master;;\n*ls-tree*) echo test/widget.test.ts;;\nesac\nexit 0\n')
            git.chmod(0o755)
            for text in ('repair widget.ts', 'repair `widget`'):
                run = subprocess.run(['bash', str(Path(__file__).with_name('precheck.sh')),
                                      'RQ-TEST-A ' + text, str(root / 'clone')],
                                     env={**os.environ, 'PATH': str(root) + ':' + os.environ['PATH']},
                                     capture_output=True, text=True, check=False)
                self.assertEqual(run.returncode, 0, run.stderr)
                self.assertEqual(run.stdout.strip(), 'GO RQ-TEST-A')

    def test_reroute_replay_and_claim_preserve_identity(self):
        queue, kind = recover(self.queue, 'RQ-A', 'a1', exit_code=1,
                              empty=True, pristine=True, stopped=True,
                              eligible=['claude', 'codex-personal'])
        self.assertEqual(kind, 'empty-worker')
        self.assertEqual(queue['RQ-A']['pool'], 'codex-personal')
        self.assertEqual(queue['RQ-A']['status'], 'READY')
        self.assertEqual(set(queue), set(self.queue))
        self.assertEqual(queue['RQ-B'], self.queue['RQ-B'])
        self.assertEqual(queue['RQ-A']['prompt'], self.queue['RQ-A']['prompt'])
        self.assertEqual(recover(queue, 'RQ-A', 'a1')[0], queue)
        running = claim(queue, 'RQ-A', 'a2')
        self.assertEqual(claim(running, 'RQ-A', 'a3'), running)
        self.assertEqual(recover(running, 'RQ-A', 'a1')[0], running)
        self.assertEqual(running['RQ-A']['attempts'], 2)
        self.assertEqual(self.queue['RQ-A']['pool'], 'claude')

    def test_uncertain_partial_cancelled_and_successful_runs_never_retry(self):
        for evidence in ({}, {'empty': True},
                         {'empty': True, 'stopped': True},
                         *[dict(empty=True, stopped=True, pristine=True, exit_code=code)
                           for code in (None, 0, 2, 124, 130, 137, 143)]):
            with self.subTest(evidence=evidence):
                queue, _ = recover(self.queue, 'RQ-A', 'a1', eligible=['devin'], **evidence)
                self.assertEqual(queue['RQ-A']['status'], 'BLOCKED')

    def test_budget_and_pool_eligibility_are_bounded(self):
        for attempts, eligible in ((3, ['devin']), (1, []), (1, ['claude'])):
            self.queue['RQ-A']['attempts'] = attempts
            queue, _ = recover(self.queue, 'RQ-A', 'a1', exit_code=1,
                               empty=True, pristine=True, stopped=True, eligible=eligible)
            self.assertEqual(queue['RQ-A']['status'], 'BLOCKED')
        self.queue['RQ-A'].update(status='READY', attempts=3)
        self.assertEqual(claim(self.queue, 'RQ-A', 'a2')['RQ-A']['status'], 'BLOCKED')

    def test_precheck_uncertainty_and_existence_are_not_completion(self):
        for code, reason, status in ((13, 'files_and_tests_exist', 'BLOCKED'),
                                     (13, 'symbols_defined', 'BLOCKED'),
                                     (12, 'PRECHECK_UNSURE_open', 'BLOCKED'),
                                     (2, '', 'BLOCKED'), (10, '', 'DONE'),
                                     (11, '', 'DONE'), (12, 'id_open_pr_42', 'DONE')):
            with self.subTest(code=code, reason=reason):
                queue, _ = recover(self.queue, 'RQ-A', 'a1', precheck=code, reason=reason)
                self.assertEqual(queue['RQ-A']['status'], status)
                self.assertEqual(len(queue), 2)


if __name__ == '__main__':
    unittest.main()
