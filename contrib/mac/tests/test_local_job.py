import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import json

spec = importlib.util.spec_from_file_location('local_job', Path(__file__).resolve().parents[1] / 'local_job.py')
local_job = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local_job)


class LocalJobTests(unittest.TestCase):
    def test_success_preserves_exit_and_has_no_timeout(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / 'timeout'
            self.assertEqual(local_job.supervise([sys.executable, '-c', 'raise SystemExit(7)'], marker, 2), 7)
            self.assertFalse(marker.exists())

    def test_deadline_kills_group_and_records_elapsed(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / 'timeout'
            child = Path(tmp) / 'child'
            command = [sys.executable, '-c',
                       'import subprocess,time; subprocess.Popen(["/bin/sh", "-c", '
                       '"sleep 0.6; touch ' + str(child) + '"]); time.sleep(30)']
            self.assertEqual(local_job.supervise(command, marker, .1), 124)
            outcome = json.loads(marker.read_text())
            self.assertEqual(outcome['reason'], 'timeout')
            self.assertLess(outcome['wall_s'], 2)
            subprocess.run(['/bin/sleep', '0.8'], check=True)
            self.assertFalse(child.exists())

    def test_production_cap_is_2400_seconds(self):
        self.assertEqual(local_job.WALL_CAP_S, 2400)

    def test_timeout_finish_is_logged_without_base_or_worktree(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / '.ashlr-runs'
            (root / 'queue' / 'run').mkdir(parents=True)
            (root / 'metrics').mkdir()
            def timeout(command, marker):
                Path(marker).write_text(json.dumps({'reason': 'timeout', 'wall_s': 2400, 'wall_cap_s': 2400}))
                return 124
            with patch.object(local_job.Path, 'home', return_value=Path(tmp)), \
                 patch.object(local_job, 'supervise', side_effect=timeout), \
                 patch.object(sys, 'argv', ['local_job.py', 'job1', 'phantom', 'codex-local', 'mid']):
                self.assertEqual(local_job.main(), 124)
            rows = [json.loads(line) for line in (root / 'metrics' / 'jobs.jsonl').read_text().splitlines()]
            self.assertEqual(len(rows), 1)
            self.assertEqual((rows[0]['event'], rows[0]['reason'], rows[0]['exit_code']), ('finish', 'timeout', 124))
            self.assertEqual((root / 'queue' / 'run' / 'job1.rc').read_text(), '124\n')
