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


if __name__ == '__main__':
    unittest.main()
