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

    def test_upkeep_empty_same_base_never_reenqueues(self):
        script = Path(__file__).with_name('restock.py').resolve()
        with tempfile.TemporaryDirectory() as home:
            root = Path(home)
            queue = root / '.ashlr-runs/queue'
            (queue / 'prompts').mkdir(parents=True)
            metrics = root / '.ashlr-runs/metrics'
            metrics.mkdir()
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
            self.assertFalse((queue / 'ready.tsv').exists())


if __name__ == '__main__':
    unittest.main()
