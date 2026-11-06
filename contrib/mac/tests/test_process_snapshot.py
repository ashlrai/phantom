import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import process_snapshot as snapshot


def completed(text='', code=0):
    return subprocess.CompletedProcess(['ps'], code, text, '')


class ProcessSnapshotTests(unittest.TestCase):
    def test_reads_arguments_only_for_potential_owners(self):
        names = '1 /System/Chrome\n42 /usr/bin/codex\n43 /bin/bash\n'
        commands = '42 codex exec -C /fleet/wt/RQ-A\n43 bash publish.sh RQ-B\n'
        with patch.object(snapshot, '_bounded', side_effect=[completed(names), completed(commands)]) as run:
            result = snapshot.capture()
        self.assertEqual(result.returncode, 0)
        self.assertIn('/fleet/wt/RQ-A', result.stdout)
        self.assertIn('publish.sh RQ-B', result.stdout)
        self.assertEqual(run.call_args_list[0].args[0], ['ps', '-axo', 'pid=,comm='])
        self.assertEqual(run.call_args_list[1].args[0][3], '42,43')
        self.assertNotIn('1', run.call_args_list[1].args[0][3].split(','))

    def test_timeout_cleanup_does_not_join_an_uninterruptible_process(self):
        child = Mock(pid=12345, stdout=io.StringIO(), stderr=io.StringIO())
        child.communicate.side_effect = subprocess.TimeoutExpired(['ps'], 0.01)
        with patch.object(snapshot.subprocess, 'Popen', return_value=child), patch.object(snapshot.os, 'killpg') as kill:
            result = snapshot._bounded(['ps'], 0.01)
        self.assertEqual(result.returncode, 124)
        self.assertTrue(all(call.kwargs.get('timeout') is not None for call in child.communicate.call_args_list))
        self.assertTrue(child.stdout.closed)
        self.assertTrue(child.stderr.closed)
        kill.assert_called_once()

    def test_failed_inventory_is_unknown_and_does_not_query_arguments(self):
        with patch.object(snapshot, '_bounded', return_value=completed(code=124)) as run:
            result = snapshot.capture()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(run.call_count, 1)

    def test_empty_inventory_is_unknown(self):
        with patch.object(snapshot, '_bounded', return_value=completed()):
            result = snapshot.capture()
        self.assertNotEqual(result.returncode, 0)

    def test_argument_timeout_is_not_a_comm_only_success(self):
        with patch.object(snapshot, '_bounded', side_effect=[completed('42 /usr/bin/codex\n'), completed(code=124)]):
            result = snapshot.capture()
        self.assertNotEqual(result.returncode, 0)

    def test_missing_arguments_of_live_worker_is_unknown(self):
        with patch.object(snapshot, '_bounded', side_effect=[completed('42 /usr/bin/codex\n'), completed(code=1)]), patch.object(snapshot.os, 'kill'):
            result = snapshot.capture()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('/usr/bin/codex', result.stdout)

    def test_confirmed_exit_between_snapshots_is_safe(self):
        with patch.object(snapshot, '_bounded', side_effect=[completed('1 /System/idle\n42 /usr/bin/codex\n'), completed(code=1)]), patch.object(snapshot.os, 'kill', side_effect=ProcessLookupError):
            result = snapshot.capture()
        self.assertEqual(result.returncode, 0)
        self.assertNotIn('42 ', result.stdout)
        self.assertIn('1 /System/idle', result.stdout)

    def test_real_hung_argument_probe_returns_within_deadline(self):
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / 'ps'
            script.write_text('#!' + sys.executable + '\nimport sys,time\nif "-axo" in sys.argv: print("424242 /usr/bin/codex")\nelse: time.sleep(30)\n')
            script.chmod(0o755)
            start = time.monotonic()
            with patch.dict(os.environ, {'PATH': directory + ':' + os.environ.get('PATH', '')}):
                result = snapshot.capture(timeout=0.2)
            self.assertNotEqual(result.returncode, 0)
            self.assertLess(time.monotonic() - start, 2)


if __name__ == '__main__':
    unittest.main()
