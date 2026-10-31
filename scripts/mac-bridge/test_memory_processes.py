"""Small real-process contracts with injected memory and process-table telemetry.

The agent sandbox denies ps, so process rows use killpg(0) on fixture-owned
process groups with zero sampled RSS. Kernel child high-water RSS remains real.
No production environment option can enable these injected observations.
"""

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import memory_admission as memory

HERE = Path(__file__).resolve().parent
HOST = memory.Snapshot(32 * memory.GIB, 24 * memory.GIB, 0)


def runner_source(root, pause, job, command, reserve=2 * memory.GIB, deadline=10):
    return (
        f"import sys; sys.path.insert(0, {str(HERE)!r}); import memory_admission as m; "
        "m.read_snapshot=lambda: m.Snapshot(32*m.GIB,24*m.GIB,0); "
        f"import test_memory_processes as fixtures; m.processes=lambda: fixtures.known_groups(m.Path({str(root)!r})); "
        f"gate=m.Admission(m.Path({str(root)!r}),m.Path({str(pause)!r}),{reserve},{job!r},'other'); "
        f"sys.exit(m.run({command!r},gate,poll=0.03,wait_seconds={deadline}))"
    )


def known_groups(root):
    """Numeric liveness for fixture-owned groups only; no process listing."""
    rows = []
    for path in (root / 'queue').glob('*.json'):
        try:
            record = json.loads(path.read_text())
        except FileNotFoundError:
            continue
        group = record.get('pgid')
        if group:
            try:
                os.killpg(group, 0)
                rows.append((group, 1, group, 0, 'S'))
            except ProcessLookupError:
                pass
    return rows


class ProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='memory-process-test-')
        self.base = Path(self.temp.name)
        self.root = self.base / 'state'
        self.pause = self.base / 'PAUSE'
        self.children = []
        self.groups = []

    def tearDown(self):
        for group in self.groups:
            try:
                os.killpg(group, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for child in self.children:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=10)
        self.temp.cleanup()

    def start(self, job, script, reserve=2 * memory.GIB, deadline=10):
        source = runner_source(self.root, self.pause, job,
                               [sys.executable, '-c', script], reserve, deadline)
        child = subprocess.Popen([sys.executable, '-c', source], stdout=subprocess.DEVNULL,
                                 stderr=subprocess.PIPE, text=True)
        self.children.append(child)
        return child

    def wait_file(self, path, timeout=8):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if path.exists():
                return
            time.sleep(0.02)
        self.fail('fixture process did not become ready')

    def receipts(self):
        return [json.loads(path.read_text()) for path in (self.root / 'receipts').glob('*.json')]

    def test_25_process_batch_respects_four_global_slots(self):
        clients = [self.start(f'batch-{i:02d}', 'import time; time.sleep(0.15)') for i in range(25)]
        for child in clients:
            _, errors = child.communicate(timeout=30)
            self.assertEqual(child.returncode, 0, errors)
        receipts = self.receipts()
        self.assertEqual(len(receipts), 25)
        events = [(receipt['startedAt'], 1) for receipt in receipts]
        events += [(receipt['endedAt'], -1) for receipt in receipts]
        active = maximum = 0
        for _, change in sorted(events):
            active += change
            maximum = max(maximum, active)
            self.assertLessEqual(active, 4)
        self.assertEqual(active, 0)
        self.assertEqual(maximum, 4)
        self.assertFalse(list((self.root / 'queue').glob('*.json')))

    def test_nonzero_exit_and_real_rss_receipt(self):
        child = self.start('exit-seven',
                           "import os,time,sys; assert os.environ['CARGO_BUILD_JOBS']=='4'; "
                           "data=bytearray(1024*1024); time.sleep(0.12); sys.exit(7)")
        _, errors = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 7, errors)
        receipt, = self.receipts()
        self.assertEqual(receipt['returncode'], 7)
        self.assertGreater(receipt['peakRssBytes'], 0)
        self.assertGreater(receipt['rssSamples'], 0)
        self.assertEqual(receipt['rssSampleErrors'], 0)
        self.assertGreaterEqual(receipt['peakRssBytes'], receipt['sampledGroupPeakBytes'])
        self.assertNotIn('command', receipt)
        self.assertNotIn('environment', receipt)

    def test_cancelled_waiter_does_not_execute_child(self):
        self.pause.touch()
        marker = self.base / 'should-not-run'
        child = self.start('cancelled', f'from pathlib import Path; Path({str(marker)!r}).touch()')
        deadline = time.monotonic() + 8
        while not list((self.root / 'queue').glob('*.json')) and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(list((self.root / 'queue').glob('*.json')))
        child.send_signal(signal.SIGTERM)
        child.communicate(timeout=10)
        self.assertEqual(child.returncode, 143)
        self.assertFalse(marker.exists())
        receipt, = self.receipts()
        self.assertEqual(receipt['outcome'], 'cancelled')

    def test_active_termination_releases_group_and_slot(self):
        marker = self.base / 'child-pid'
        child = self.start('terminate',
                           f'import os,time; from pathlib import Path; '
                           f'Path({str(marker)!r}).write_text(str(os.getpid())); time.sleep(30)')
        self.wait_file(marker)
        group = int(marker.read_text())
        self.groups.append(group)
        child.send_signal(signal.SIGTERM)
        child.communicate(timeout=10)
        self.assertEqual(child.returncode, 143)
        with self.assertRaises(ProcessLookupError):
            os.killpg(group, 0)
        self.assertFalse(list((self.root / 'queue').glob('*.json')))

    def test_nested_command_reuses_group_after_spawn_closes_descriptor(self):
        nested = (
            f"import sys; sys.path.insert(0,{str(HERE)!r}); import memory_admission as m; "
            f"sys.exit(m.main(['run','--state-dir',{str(self.root)!r},'--pause-file',{str(self.pause)!r},"
            f"'--wait-seconds','0.2','--',{sys.executable!r},'-c','import sys; sys.exit(9)']))"
        )
        # Python close_fds=True matches Node's npm -> npx subprocess behavior.
        script = (
            "import subprocess,sys; "
            f"sys.exit(subprocess.call([sys.executable,'-c',{nested!r}],close_fds=True))"
        )
        child = self.start('nested', script)
        _, errors = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 9, errors)
        receipt, = self.receipts()
        self.assertEqual(receipt['job'], 'nested')

    def test_cancellation_finishes_when_process_telemetry_disappears(self):
        marker = self.base / 'telemetry-child'
        command = [sys.executable, '-c',
                   f'import os,time; from pathlib import Path; '
                   f'Path({str(marker)!r}).write_text(str(os.getpid())); time.sleep(30)']
        source = runner_source(self.root, self.pause, 'lost-telemetry', command)
        injection = (
            'calls=[0]; '
            'm.processes=lambda: (calls.__setitem__(0,calls[0]+1), '
            '[] if calls[0]==1 else (_ for _ in ()).throw(PermissionError()))[1]; '
        )
        source = source.replace('sys.exit(m.run(', injection + 'sys.exit(m.run(')
        child = subprocess.Popen([sys.executable, '-c', source], stdout=subprocess.DEVNULL,
                                 stderr=subprocess.PIPE, text=True)
        self.children.append(child)
        self.wait_file(marker)
        group = int(marker.read_text())
        self.groups.append(group)
        child.send_signal(signal.SIGTERM)
        _, errors = child.communicate(timeout=8)
        self.assertEqual(child.returncode, 143, errors)
        with self.assertRaises(ProcessLookupError):
            os.killpg(group, 0)
        receipt, = self.receipts()
        self.assertGreater(receipt['rssSampleErrors'], 0)
        self.assertFalse(list((self.root / 'queue').glob('*.json')))

    def adapter(self, args):
        fake_bin = self.base / 'fake-bin'
        fake_bin.mkdir()
        marker = self.base / 'fake-npm-args.json'
        executable = fake_bin / 'npm'
        executable.write_text(
            f'#!{sys.executable}\n'
            'import json,sys\nfrom pathlib import Path\n'
            f'Path({str(marker)!r}).write_text(json.dumps(sys.argv[1:]))\n'
            'sys.exit(17)\n')
        executable.chmod(0o700)
        env = dict(os.environ)
        env.pop('PHANTOM_MEMORY_ORIGINAL_PATH', None)
        env.pop('PHANTOM_MEMORY_LEASE', None)
        env['PATH'] = str(fake_bin) + os.pathsep + os.environ.get('PATH', os.defpath)
        child = subprocess.Popen(
            ['/bin/bash', str(HERE / 'with-memory.sh'), '--state-dir', str(self.root),
             '--pause-file', str(self.pause), '--job', 'adapter', '--', 'npm', *args],
            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        self.children.append(child)
        return child, marker

    def test_adapter_light_command_preserves_arguments_and_exit(self):
        args = ['--version', 'two words', 'literal-$value']
        child, marker = self.adapter(args)
        _, errors = child.communicate(timeout=5)
        self.assertEqual(child.returncode, 17, errors)
        self.assertEqual(json.loads(marker.read_text()), args)
        self.assertFalse((self.root / 'queue').exists())

    def test_adapter_heavy_command_reaches_shared_queue(self):
        self.pause.touch()
        child, marker = self.adapter(['test'])
        deadline = time.monotonic() + 5
        while not list((self.root / 'queue').glob('*.json')) and time.monotonic() < deadline:
            time.sleep(0.02)
        records = list((self.root / 'queue').glob('*.json'))
        self.assertEqual(len(records), 1)
        record = json.loads(records[0].read_text())
        self.assertEqual(record['profile'], 'npm-test')
        self.assertEqual(record['job'], 'adapter')
        self.assertEqual(record['state'], 'waiting')
        self.assertFalse(marker.exists())
        child.send_signal(signal.SIGTERM)
        _, errors = child.communicate(timeout=5)
        self.assertEqual(child.returncode, 143, errors)
        self.assertFalse(marker.exists())
        receipt, = self.receipts()
        self.assertEqual(receipt['outcome'], 'cancelled')

    def test_unobservable_processes_queue_without_launching(self):
        marker = self.base / 'must-not-launch'
        command = [sys.executable, '-c',
                   f'from pathlib import Path; Path({str(marker)!r}).touch()']
        source = runner_source(self.root, self.pause, 'unobservable', command, deadline=0.15)
        source = source.replace(
            'sys.exit(m.run(',
            'm.processes=lambda: (_ for _ in ()).throw(PermissionError()); sys.exit(m.run(')
        child = subprocess.Popen([sys.executable, '-c', source], stdout=subprocess.DEVNULL,
                                 stderr=subprocess.PIPE, text=True)
        self.children.append(child)
        _, errors = child.communicate(timeout=5)
        self.assertEqual(child.returncode, 75, errors)
        self.assertIn('telemetry-unavailable', errors)
        self.assertFalse(marker.exists())
        receipt, = self.receipts()
        self.assertEqual(receipt['outcome'], 'queue-timeout')
        self.assertIsNone(receipt['peakRssBytes'])

    def test_crash_before_group_record_aborts_handshake_child(self):
        group_marker = self.base / 'handshake-group'
        command_marker = self.base / 'must-not-exec'
        command = [sys.executable, '-c',
                   f'from pathlib import Path; Path({str(command_marker)!r}).touch()']
        source = runner_source(self.root, self.pause, 'handshake-crash', command)
        injection = (
            'import os; '
            f'gate.set_group=lambda pgid: (m.Path({str(group_marker)!r}).write_text(str(pgid)),os._exit(88)); '
        )
        source = source.replace('sys.exit(m.run(', injection + 'sys.exit(m.run(')
        child = subprocess.Popen([sys.executable, '-c', source], stdout=subprocess.DEVNULL,
                                 stderr=subprocess.PIPE, text=True)
        self.children.append(child)
        child.communicate(timeout=5)
        self.assertEqual(child.returncode, 88)
        self.wait_file(group_marker)
        group = int(group_marker.read_text())
        self.groups.append(group)
        deadline = time.monotonic() + 5
        alive = True
        while alive and time.monotonic() < deadline:
            try:
                os.killpg(group, 0)
            except ProcessLookupError:
                alive = False
            time.sleep(0.02)
        self.assertFalse(alive, 'handshake child survived wrapper EOF')
        self.assertFalse(command_marker.exists())
        follower = memory.Admission(self.root, self.pause, memory.GIB, 'after-crash', 'other')
        try:
            follower.enqueue()
            self.assertIsNone(follower.attempt(HOST))
            follower.finish(0, 0)
            abandoned = [r for r in self.receipts() if r['job'] == 'handshake-crash']
            self.assertEqual(len(abandoned), 1)
            self.assertEqual(abandoned[0]['state'], 'abandoned')
        finally:
            follower.close()

    def test_sigkill_wrapper_keeps_live_child_reservation(self):
        marker = self.base / 'orphan-pid'
        child = self.start('orphan',
                           f'import os,time; from pathlib import Path; '
                           f'Path({str(marker)!r}).write_text(str(os.getpid())); time.sleep(1.2)',
                           reserve=10 * memory.GIB)
        self.wait_file(marker)
        group = int(marker.read_text())
        self.groups.append(group)
        child.kill()
        child.wait(timeout=5)
        follower = memory.Admission(self.root, self.pause, 10 * memory.GIB, 'follower', 'other')
        try:
            follower.enqueue()
            with patch.object(memory, 'processes', lambda: known_groups(self.root)):
                self.assertIsNotNone(follower.attempt(HOST))
            self.assertEqual(len(list((self.root / 'queue').glob('*.json'))), 2)
            deadline = time.monotonic() + 8
            reason = 'waiting'
            while time.monotonic() < deadline:
                with patch.object(memory, 'processes', lambda: known_groups(self.root)):
                    reason = follower.attempt(HOST)
                if reason is None:
                    break
                time.sleep(0.05)
            self.assertIsNone(reason)
            follower.finish(0, 0)
            abandoned = [r for r in self.receipts() if r['job'] == 'orphan']
            self.assertEqual(len(abandoned), 1)
            self.assertEqual(abandoned[0]['state'], 'abandoned')
            self.assertIsNone(abandoned[0]['peakRssBytes'])
        finally:
            follower.close()


if __name__ == '__main__':
    unittest.main()
