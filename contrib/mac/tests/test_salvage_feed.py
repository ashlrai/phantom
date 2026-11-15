import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('salvage', Path(__file__).parents[1] / 'salvage-feed.py')
salvage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(salvage)


class SalvageTest(unittest.TestCase):
    def test_missing_empty_dirty_covered_and_cap(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for job in ('EMPTY', 'DIRTY', 'QUEUED', 'EXTRA'):
                path = root / job
                path.mkdir()
                def git(*args):
                    subprocess.run(['git', '-C', str(path), *args], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                git('init')
                git('config', 'user.name', 'Test')
                git('config', 'user.email', 'test@example.invalid')
                git('remote', 'add', 'origin', 'https://github.com/ashlrai/phantom.git')
                (path / 'file').write_text('original\n')
                git('add', 'file')
                git('commit', '-m', 'fixture')
                if job != 'EMPTY':
                    (path / 'file').write_text('changed\n')
            status = {'kept_worktrees': ['MISSING', 'EMPTY', 'DIRTY', 'QUEUED', 'EXTRA']}
            queue = '- READY OTHER: QUEUED\n'
            lines = salvage.plan(status, root, queue, 'work', 6)
            self.assertEqual(len(lines), 2)
            self.assertTrue(any('DIRTY' in line for line in lines))
            self.assertEqual(len(salvage.plan(status, root, queue, 'work', 1)), 1)
            self.assertEqual(len(salvage.plan(status, root, queue + 'Supersedes DIRTY\n', 'work', 6)), 1)


if __name__ == '__main__':
    unittest.main()
