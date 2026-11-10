import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class RestockPrecheck(unittest.TestCase):
    def test_only_completed_work_is_retired(self):
        script = Path(__file__).with_name('restock.py').resolve()
        for code in (0, 10, 11, 12, 13, 2):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as home:
                root = Path(home)
                queue = root / '.ashlr-runs/queue'
                (queue / 'prompts').mkdir(parents=True)
                (queue / 'admission.json').write_text('{"cap": 10}')
                (queue / 'ready.tsv').write_text('')
                (root / 'Projects/ashlrai/phantom').mkdir(parents=True)
                binary = root / '.ashlr-runs/bin'
                binary.mkdir()
                (binary / 'precheck.sh').write_text(f'echo SKIP RQ-TEST code={code} reason=id_merged_pr_7\nexit {code}\n')
                source = '- READY RQ-TEST (P0, pool=codex-cmp, repo=phantom): test task\n'
                (queue / 'router-queue.md').write_text(source)
                env = dict(os.environ, HOME=home, PYTHONDONTWRITEBYTECODE='1')
                def run(*args):
                    return json.loads(subprocess.check_output(['python3', str(script), '--json', *args], env=env, text=True))
                dry = run('--dry-run')
                self.assertEqual((queue / 'router-queue.md').read_text(), source)
                self.assertEqual((queue / 'ready.tsv').read_text(), '')
                result = run()
                done = code == 10
                blocked = code in (11, 12, 13)
                self.assertEqual(result['queued'], 0 if done or blocked else 1)
                self.assertEqual(dry['done_noop'], ['RQ-TEST'] if done else [])
                ready = (queue / 'ready.tsv').read_text() if (queue / 'ready.tsv').exists() else ''
                self.assertEqual('RQ-TEST' in ready, not (done or blocked))
                self.assertEqual('DONE-NOOP' in (queue / 'router-queue.md').read_text(), done)
                self.assertEqual((queue / 'prompts/RQ-TEST.md').exists(), not (done or blocked))
                claimed = (queue / 'claimed.tsv').read_text() if (queue / 'claimed.tsv').exists() else ''
                self.assertEqual('RQ-TEST' in claimed, not (done or blocked))
                if blocked:
                    self.assertEqual((queue / 'router-queue.md').read_text(), source)
                    state = json.loads((queue / 'restock-precheck-parked.json').read_text())['RQ-TEST']
                    self.assertEqual(state['code'], code)
                    if code == 13:
                        self.assertEqual(state['reason'], 'invalid_or_unknown_receipt')
                    self.assertGreater(state['retry_at'], 0)


    def test_completion_requires_exact_receipt(self):
        from launch_precheck import precheck
        for output in ('reason=already-done', 'SKIP RQ-OTHER code=10 reason=id_merged_pr_7',
                       'SKIP RQ-TEST code=10 reason=files_exist',
                       'SKIP RQ-TEST code=10 reason=id_merged_pr_7\nextra'):
            with self.subTest(output=output):
                def runner(*args, **kwargs):
                    return subprocess.CompletedProcess([], 10, output, '')
                self.assertEqual(precheck('RQ-TEST', 'phantom', 'RQ-TEST (P0): repair',
                                          '/fixture', '/fixture/runs', runner),
                                 (13, 'unproven_completion'))

    def test_code_13_reasons_are_specific_and_untrusted_output_is_not_recorded(self):
        from launch_precheck import precheck
        for output, expected in (
            ('SKIP RQ-TEST code=13 reason=files_and_tests_exist\n', 'files_and_tests_exist'),
            ('SKIP RQ-TEST code=13 reason=symbols_defined\n', 'symbols_defined'),
            ('SKIP RQ-OTHER code=13 reason=symbols_defined\n', 'invalid_or_unknown_receipt'),
            ('SKIP RQ-TEST code=13 reason=private_value\n', 'invalid_or_unknown_receipt'),
            ('', 'invalid_or_unknown_receipt'),
        ):
            with self.subTest(expected=expected):
                def runner(*args, **kwargs):
                    return subprocess.CompletedProcess([], 13, output, '')
                self.assertEqual(precheck('RQ-TEST', 'phantom', 'RQ-TEST (P0): repair',
                                          '/fixture', '/fixture/runs', runner), (13, expected))


class EmptyStreakPrecheck(unittest.TestCase):
    """A job id whose last finishes all came back empty is retired, not relaunched."""

    def runs(self, root, rows):
        runs = Path(root) / '.ashlr-runs'
        (runs / 'metrics').mkdir(parents=True)
        text = ''.join(json.dumps(row) + '\n' for row in rows)
        (runs / 'metrics' / 'jobs.jsonl').write_text(text)
        return str(runs)

    def test_two_trailing_empty_finishes_suppress_without_a_subprocess(self):
        from launch_precheck import EMPTY_CODE, precheck
        with tempfile.TemporaryDirectory() as home:
            runs = self.runs(home, [
                {'event': 'finish', 'job': 'RQ-TEST', 'empty': True},
                {'event': 'finish', 'job': 'RQ-OTHER', 'empty': True},
                {'event': 'finish', 'job': 'RQ-TEST', 'empty': True},
            ])
            calls = []
            def runner(*args, **kwargs):
                calls.append(args)
                return subprocess.CompletedProcess([], 0, 'GO RQ-TEST\n', '')
            self.assertEqual(precheck('RQ-TEST', 'phantom', 'RQ-TEST (P0): repair',
                                      '/fixture', runs, runner), (EMPTY_CODE, 'empty_streak_2x'))
            self.assertEqual(calls, [])

    def test_single_empty_and_newer_evidence_fail_open(self):
        from launch_precheck import precheck
        cases = (
            # One empty finish is a flake, not proof.
            [{'event': 'finish', 'job': 'RQ-TEST', 'empty': True}],
            # A productive finish breaks the streak.
            [{'event': 'finish', 'job': 'RQ-TEST', 'empty': True},
             {'event': 'finish', 'job': 'RQ-TEST', 'empty': True},
             {'event': 'finish', 'job': 'RQ-TEST', 'empty': False}],
            # An unmeasured finish is not empty evidence.
            [{'event': 'finish', 'job': 'RQ-TEST', 'empty': True},
             {'event': 'finish', 'job': 'RQ-TEST'}],
            # A merge after the empties is newer terminal evidence.
            [{'event': 'finish', 'job': 'RQ-TEST', 'empty': True},
             {'event': 'finish', 'job': 'RQ-TEST', 'empty': True},
             {'event': 'outcome', 'job': 'RQ-TEST', 'state': 'MERGED'}],
        )
        for rows in cases:
            with self.subTest(rows=rows), tempfile.TemporaryDirectory() as home:
                runs = self.runs(home, rows)
                def runner(*args, **kwargs):
                    return subprocess.CompletedProcess([], 0, 'GO RQ-TEST\n', '')
                self.assertIsNone(precheck('RQ-TEST', 'phantom', 'RQ-TEST (P0): repair',
                                           '/fixture', runs, runner))

    def test_terminal_empty_outcome_rows_count_as_empty_evidence(self):
        from launch_precheck import EMPTY_CODE, precheck
        with tempfile.TemporaryDirectory() as home:
            runs = self.runs(home, [
                {'event': 'outcome', 'job': 'RQ-TEST', 'outcome': 'DONE-NOOP'},
                {'event': 'outcome', 'job': 'RQ-TEST', 'state': 'EMPTY'},
            ])
            self.assertEqual(precheck('RQ-TEST', 'phantom', 'RQ-TEST (P0): repair',
                                      '/fixture', runs, lambda *a, **k: None), (EMPTY_CODE, 'empty_streak_2x'))

    def test_missing_malformed_and_empty_ledgers_never_suppress(self):
        from launch_precheck import precheck
        with tempfile.TemporaryDirectory() as home:
            runs = str(Path(home) / '.ashlr-runs')
            def runner(*args, **kwargs):
                return subprocess.CompletedProcess([], 0, 'GO RQ-TEST\n', '')
            self.assertIsNone(precheck('RQ-TEST', 'phantom', 'RQ-TEST (P0): repair',
                                       '/fixture', runs, runner))
            self.runs(home, [])
            (Path(runs) / 'metrics' / 'jobs.jsonl').write_text('not json\n{"event":"finish"}\n')
            self.assertIsNone(precheck('RQ-TEST', 'phantom', 'RQ-TEST (P0): repair',
                                       '/fixture', runs, runner))

    def test_upkeep_empty_same_base_never_reenqueues(self):
        script = Path(__file__).with_name('restock.py').resolve()
        with tempfile.TemporaryDirectory() as home:
            root = Path(home)
            queue = root / '.ashlr-runs/queue'
            (queue / 'prompts').mkdir(parents=True)
            metrics = root / '.ashlr-runs/metrics'
            metrics.mkdir()
            (queue / 'admission.json').write_text('{"cap": 10}')
            (queue / 'ready.tsv').write_text('')
            repo = root / 'Projects/ashlrai/phantom'
            repo.mkdir(parents=True)
            for args in (['init'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                                    'commit', '--allow-empty', '-m', 'base'],
                         ['update-ref', 'refs/remotes/origin/main', 'HEAD'],
                         ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']):
                subprocess.run(['git', '-C', str(repo)] + args, check=True, capture_output=True)
            sha = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
            job = 'RQ-UPKEEP-REL-1'
            (queue / 'router-queue.md').write_text(f'- READY {job} (repo=phantom): maintenance\n')
            (metrics / 'jobs.jsonl').write_text(json.dumps(dict(event='claim', job=job, repo='phantom', base_sha=sha)) + '\n' +
                                              json.dumps(dict(event='finish', job=job, empty=True, exit_code=0)) + '\n')
            env = dict(os.environ, HOME=home, PYTHONDONTWRITEBYTECODE='1')
            for _ in range(2):
                result = json.loads(subprocess.check_output(['python3', str(script), '--json'], env=env, text=True))
                self.assertEqual(result['queued'], 0)
                self.assertEqual(result['skips']['upkeep_empty_same_base'], 1)
            self.assertEqual((queue / 'ready.tsv').read_text(), '')


if __name__ == '__main__':
    unittest.main()
