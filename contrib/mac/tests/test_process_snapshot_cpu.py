"""capture(cpu=True) reads parent and %CPU columns from the same single inventory call (RQ-LOADGATE-PLACEMENT-1)."""
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import process_snapshot as snapshot


def completed(text='', code=0):
    return subprocess.CompletedProcess(['ps'], code, text, '')


class CpuInventoryTests(unittest.TestCase):
    def test_one_inventory_call_with_cpu_columns_and_no_extra_call_without_workers(self):
        names = '  1     0   0.0 /sbin/launchd\n  77     1 297.5 /System/Apps/Chrome Helper\n'
        with patch.object(snapshot, '_bounded', side_effect=[completed(names)]) as run:
            result = snapshot.capture(cpu=True)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args_list[0].args[0], ['ps', '-axo', 'pid=,ppid=,pcpu=,comm='])
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.cpu, {1: (0, 0.0), 77: (1, 297.5)})
        self.assertEqual(result.stdout, '1 /sbin/launchd\n77 /System/Apps/Chrome Helper\n')

    def test_worker_names_become_their_commands_and_keep_the_cpu_row(self):
        names = '  42     1   12.5 /usr/bin/codex\n  43    42   3.0 /bin/bash\n  50     1  0.5 /usr/sbin/cron\n'
        commands = '42 codex exec -C /fleet/wt/RQ-A\n43 bash publish.sh RQ-B\n'
        with patch.object(snapshot, '_bounded', side_effect=[completed(names), completed(commands)]) as run:
            result = snapshot.capture(cpu=True)
        self.assertEqual(run.call_args_list[1].args[0][3], '42,43')
        self.assertIn('42 codex exec -C /fleet/wt/RQ-A\n', result.stdout)
        self.assertIn('43 bash publish.sh RQ-B\n', result.stdout)
        self.assertEqual(result.cpu, {42: (1, 12.5), 43: (42, 3.0), 50: (1, 0.5)})

    def test_command_names_with_spaces_are_kept_whole(self):
        names = '  9  1  1.0 /Applications/Visual Studio Code.app/Contents/MacOS/Electron\n'
        with patch.object(snapshot, '_bounded', side_effect=[completed(names)]):
            result = snapshot.capture(cpu=True)
        self.assertEqual(result.stdout, '9 /Applications/Visual Studio Code.app/Contents/MacOS/Electron\n')
        self.assertEqual(result.cpu, {9: (1, 1.0)})

    def test_legacy_pid_comm_inventory_has_no_cpu_table_but_keeps_names(self):
        names = '1 /System/idle\n42 /usr/bin/tool\n'
        with patch.object(snapshot, '_bounded', side_effect=[completed(names)]):
            result = snapshot.capture(cpu=True)
        self.assertIsNone(result.cpu)
        self.assertEqual(result.stdout, '1 /System/idle\n42 /usr/bin/tool\n')

    def test_default_capture_keeps_the_legacy_argv_and_no_cpu_table(self):
        names = '1 /System/idle\n42 /usr/bin/tool\n'
        with patch.object(snapshot, '_bounded', side_effect=[completed(names)]) as run:
            result = snapshot.capture()
        self.assertEqual(run.call_args_list[0].args[0], ['ps', '-axo', 'pid=,comm='])
        self.assertIsNone(result.cpu)

    def test_failed_inventory_is_unknown_with_cpu_requested(self):
        with patch.object(snapshot, '_bounded', side_effect=[completed('', 1)]):
            result = snapshot.capture(cpu=True)
        self.assertNotEqual(result.returncode, 0)

    def test_empty_inventory_is_unknown_with_cpu_requested(self):
        with patch.object(snapshot, '_bounded', side_effect=[completed('\n')]):
            result = snapshot.capture(cpu=True)
        self.assertNotEqual(result.returncode, 0)


if __name__ == '__main__':
    unittest.main()
