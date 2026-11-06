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
                self.assertFalse((queue / 'ready.tsv').exists())
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


if __name__ == '__main__':
    unittest.main()
