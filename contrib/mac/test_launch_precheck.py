import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class RestockPrecheck(unittest.TestCase):
    def test_done_never_queued(self):
        script = Path(__file__).with_name('restock.py').resolve()
        for code in (0, 10, 11, 12, 13, 2):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as home:
                root = Path(home)
                queue = root / '.ashlr-runs/queue'
                (queue / 'prompts').mkdir(parents=True)
                (root / 'Projects/ashlrai/phantom').mkdir(parents=True)
                binary = root / '.ashlr-runs/bin'
                binary.mkdir()
                (binary / 'precheck.sh').write_text(f'echo reason=already-done\nexit {code}\n')
                source = '- READY RQ-TEST (P0, pool=codex-cmp, repo=phantom): test task\n'
                (queue / 'router-queue.md').write_text(source)
                env = dict(os.environ, HOME=home, PYTHONDONTWRITEBYTECODE='1')
                def run(*args):
                    return json.loads(subprocess.check_output(['python3', str(script), '--json', *args], env=env, text=True))
                dry = run('--dry-run')
                self.assertEqual((queue / 'router-queue.md').read_text(), source)
                self.assertFalse((queue / 'ready.tsv').exists())
                result = run()
                done = code in (10, 11, 12, 13)
                self.assertEqual(result['queued'], 0 if done else 1)
                self.assertEqual(dry['done_noop'], ['RQ-TEST'] if done else [])
                self.assertEqual('RQ-TEST' in (queue / 'ready.tsv').read_text(), not done)
                self.assertEqual('DONE-NOOP' in (queue / 'router-queue.md').read_text(), done)
                self.assertEqual((queue / 'prompts/RQ-TEST.md').exists(), not done)
                self.assertEqual('RQ-TEST' in (queue / 'claimed.tsv').read_text(), not done)


if __name__ == '__main__':
    unittest.main()
