"""Supervised launcher contracts: wrap shims inside a pressure-owned group.

Metrics files are the injected probe; children are real python processes this
suite creates. Signals only ever reach groups spawned here — never a fleet
process, a GUI app, or a discovered PID.
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

import memory_admission
import memory_supervised

HERE = Path(__file__).resolve().parent
SHELL = HERE / 'with-memory.sh'
HEALTHY = {'freeMemoryPercent': 80, 'swapUsedBytes': 0, 'pressureLevel': 1}
CRITICAL = {'freeMemoryPercent': 3, 'swapUsedBytes': 0, 'pressureLevel': 4}
GIB = memory_admission.GIB


def ticker(path, seconds=30):
    return (f"import time\nfrom pathlib import Path\np = Path({str(path)!r})\n"
            f"end = time.time() + {seconds}\n"
            "while time.time() < end: p.open('a').write('x'); time.sleep(0.02)\n")


def marker(script_path):
    return ("import json, os, sys\nfrom pathlib import Path\n"
            f"Path({str(script_path)!r}).write_text(json.dumps({{"
            "'pid': os.getpid(), 'ppid': os.getppid(), 'pgid': os.getpgrp(), "
            "'sid': os.getsid(0), 'argv': sys.argv[2:], "
            "'path0': os.environ['PATH'].split(os.pathsep)[0], "
            "'job': os.environ.get('PHANTOM_MEMORY_JOB'), "
            "'stateDir': os.environ.get('PHANTOM_MEMORY_STATE_DIR')}))\n")


class ArgvTests(unittest.TestCase):
    def test_command_forwards_literal_argv(self):
        child = ['/p/launch.sh', 'JOB', 'repo', 'pool', '--supervise', '-x', '--']
        argv = memory_supervised.supervised_command(child, '/state', '/pause', 'job7')
        self.assertEqual(argv[0], sys.executable)
        self.assertEqual(argv[1], str(memory_supervised.ADMISSION))
        self.assertEqual(argv[2:10], ['wrap', '--state-dir', '/state',
                                     '--pause-file', '/pause', '--job', 'job7', '--'])
        self.assertEqual(argv[10:], child)

    def test_missing_and_invalid_options_rejected(self):
        exits = (['--metrics', '/m', '--max-age-seconds', '30'],
                 ['--job', 'x', '--', 'true'])
        for argv in exits:
            with self.assertRaises(SystemExit, msg=argv):
                memory_supervised.main(argv)
        bad = (['--metrics', '/m', '--max-age-seconds', '30',
                '--job', 'bad job!', '--', 'true'],
               ['--metrics', '/m', '--max-age-seconds', '-1', '--', 'true'])
        for argv in bad:
            with self.assertRaises(ValueError, msg=argv):
                memory_supervised.main(argv)


class SupervisedTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='memory-supervised-test-')
        self.base = Path(self.temp.name)
        self.metrics = self.base / 'memguard.json'
        self.receipts = self.base / 'receipts'
        self.state = self.base / 'state'
        self.pause_file = self.base / 'PAUSE'
        self.children, self.groups = [], []
        self.set_metrics(HEALTHY)

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=10)
        for group in self.groups:
            try:
                os.killpg(group, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        if self.receipts.exists():
            for path in self.receipts.glob('*.json'):
                try:
                    os.killpg(json.loads(path.read_text())['pgid'], signal.SIGKILL)
                except (ProcessLookupError, PermissionError, TypeError, ValueError):
                    pass
        self.temp.cleanup()

    def set_metrics(self, row, age=0):
        self.metrics.write_text(json.dumps(row))
        if age:
            stamp = time.time() - age
            os.utime(self.metrics, (stamp, stamp))

    def supervised_args(self, script, launch_wait=5.0, healthy=2, deadline=None):
        args = ['--supervise', '--job', 'testjob',
                '--metrics', str(self.metrics), '--max-age-seconds', '30',
                '--receipt-dir', str(self.receipts),
                '--state-dir', str(self.state), '--pause-file', str(self.pause_file),
                '--poll-seconds', '0.05', '--healthy-samples', str(healthy),
                '--launch-wait-seconds', str(launch_wait),
                '--term-grace-seconds', '0.5']
        if deadline is not None:
            args += ['--deadline-seconds', str(deadline)]
        return args + ['--', sys.executable, '-c', script]

    def start(self, script, **kwargs):
        child = subprocess.Popen(['/bin/bash', str(SHELL), *self.supervised_args(script, **kwargs)],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        self.children.append(child)
        return child

    def receipt(self):
        files = list(self.receipts.glob('*.json'))
        self.assertTrue(files)
        return json.loads(max(files, key=lambda p: p.stat().st_mtime).read_text())

    def wait_state(self, state, timeout=6):
        deadline = time.monotonic() + timeout
        while self.receipt()['state'] != state and time.monotonic() < deadline:
            time.sleep(0.03)
        self.assertEqual(self.receipt()['state'], state)
        return self.receipt()

    def wait_json(self, path, timeout=6):
        deadline = time.monotonic() + timeout
        while not path.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(path.exists())
        return json.loads(path.read_text())

    def ticks(self, path):
        return path.stat().st_size if path.exists() else 0

    def wait_ticks(self, path, minimum=1, timeout=6):
        deadline = time.monotonic() + timeout
        while self.ticks(path) < minimum and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertGreaterEqual(self.ticks(path), minimum)

    def assert_stalled(self, path, window=0.4):
        before = self.ticks(path)
        time.sleep(window)
        self.assertEqual(self.ticks(path), before)

    def assert_growing(self, path, window=0.4):
        before = self.ticks(path)
        time.sleep(window)
        self.assertGreater(self.ticks(path), before)

    def test_legacy_invocation_reaches_wrap_with_unchanged_argv(self):
        marker_path = self.base / 'legacy.json'
        env = dict(os.environ, PHANTOM_MEMORY_STATE_DIR=str(self.state),
                   PHANTOM_MEMORY_PAUSE_FILE=str(self.pause_file))
        args = ['/bin/bash', str(SHELL), '--job', 'testjob', '--',
                sys.executable, '-c', marker(marker_path), str(marker_path),
                'a', 'b', '--supervise']
        child = subprocess.Popen(args, env=env, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.PIPE, text=True)
        self.children.append(child)
        _, errors = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 0, errors)
        seen = json.loads(marker_path.read_text())
        # Post-divider argv is literal: '--supervise' stays a child argument.
        self.assertEqual(seen['argv'], ['a', 'b', '--supervise'])
        self.assertEqual((seen['job'], seen['stateDir']), ('testjob', str(self.state)))
        self.assertIn('shims-', Path(seen['path0']).name)

    def test_supervised_child_is_the_pressure_owned_group_leader(self):
        marker_path = self.base / 'child.json'
        child = self.start(marker(marker_path))
        _, errors = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 0, errors)
        seen = json.loads(marker_path.read_text())
        receipt = self.receipt()
        self.assertEqual((receipt['state'], receipt['returncode']), ('finished', 0))
        # Kernel state: the exec'd launcher — not an intermediate wrapper — is
        # the session/group leader pressure_worker signals.
        self.assertEqual(seen['pid'], seen['pgid'])
        self.assertEqual(seen['sid'], seen['pgid'])
        self.assertEqual(receipt['pgid'], seen['pgid'])
        self.assertEqual(seen['ppid'], child.pid)
        # The admission shims were installed inside that same group.
        self.assertIn('shims-', Path(seen['path0']).name)
        self.assertEqual((seen['job'], seen['stateDir']), ('testjob', str(self.state)))

    def test_stale_metrics_refuse_before_child_marker(self):
        self.set_metrics(HEALTHY, age=3600)
        marker_path = self.base / 'should-not-run'
        child = self.start(marker(marker_path), launch_wait=0.3, healthy=1)
        _, errors = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 75, errors)
        self.assertFalse(marker_path.exists())
        self.assertEqual(self.receipt()['state'], 'blocked')

    def test_critical_pauses_then_healthy_resumes_child_and_descendant(self):
        ticks_path = self.base / 'child.ticks'
        desc_ticks = self.base / 'desc.ticks'
        desc_marker = self.base / 'desc.json'
        marker_path = self.base / 'child.json'
        descendant = marker(desc_marker) + ticker(desc_ticks)
        script = (marker(marker_path) +
                  f"import subprocess, sys\n"
                  f"subprocess.Popen([sys.executable, '-c', {descendant!r}])\n" +
                  ticker(ticks_path))
        child = self.start(script)
        self.wait_ticks(ticks_path)
        self.wait_ticks(desc_ticks)
        self.set_metrics(CRITICAL)
        pgid = self.wait_state('paused')['pgid']
        seen, desc = json.loads(marker_path.read_text()), self.wait_json(desc_marker)
        self.assertEqual((seen['pid'], seen['pgid'], desc['pgid']), (pgid, pgid, pgid))
        self.assert_stalled(ticks_path)
        self.assert_stalled(desc_ticks)
        self.set_metrics(HEALTHY)
        self.wait_state('running')
        self.assert_growing(ticks_path)
        self.assert_growing(desc_ticks)
        child.send_signal(signal.SIGTERM)
        _, errors = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 143, errors)
        with self.assertRaises(ProcessLookupError):
            os.killpg(pgid, 0)

    def test_cancellation_reaps_descendants_and_releases_reservation(self):
        desc_ticks = self.base / 'desc.ticks'
        marker_path = self.base / 'reserved.json'
        script = (
            f"import sys\nsys.path.insert(0, {str(HERE)!r})\n"
            "import json, os, subprocess, time\nfrom pathlib import Path\n"
            "import memory_admission as ma\n"
            f"adm = ma.Admission({str(self.state)!r}, {str(self.pause_file)!r}, "
            "ma.GIB, 'testjob', 'other')\n"
            "adm.enqueue()\n"
            "reason = adm.attempt(ma.Snapshot(64 * ma.GIB, 60 * ma.GIB, 0))\n"
            f"subprocess.Popen([sys.executable, '-c', {ticker(desc_ticks)!r}])\n"
            f"Path({str(marker_path)!r}).write_text(json.dumps({{'ticket': adm.ticket, "
            "'reason': reason, 'state': adm.record['state'], 'pgid': os.getpgrp()}))\n"
            "time.sleep(30)\n")
        child = self.start(script)
        held = self.wait_json(marker_path)
        self.assertEqual((held['state'], held['reason']), ('active', None))
        self.wait_ticks(desc_ticks)
        child.send_signal(signal.SIGTERM)
        _, errors = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 143, errors)
        with self.assertRaises(ProcessLookupError):
            os.killpg(held['pgid'], 0)
        # A successor reaps the dead holder's slot instead of leaking it.
        probe = memory_admission.Admission(self.state, self.pause_file, GIB, 'probe', 'other')
        self.assertEqual(probe.entries(), [])
        receipts = list((self.state / 'receipts').glob('*.json'))
        self.assertEqual(len(receipts), 1)
        gone = json.loads(receipts[0].read_text())
        self.assertEqual((gone['ticket'], gone['state']), (held['ticket'], 'abandoned'))

    def test_deadline_terminates_running_group(self):
        ticks_path = self.base / 'child.ticks'
        # Deadline covers launch wait plus runtime; the adapter -> wrap -> exec
        # interpreter chain precedes the first tick.
        child = self.start(ticker(ticks_path), deadline=4.0)
        self.wait_ticks(ticks_path)
        _, errors = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 124, errors)
        receipt = self.receipt()
        self.assertEqual(receipt['state'], 'deadline')
        with self.assertRaises(ProcessLookupError):
            os.killpg(receipt['pgid'], 0)

    def test_signals_never_reach_foreign_groups(self):
        audit = self.base / 'signals.log'
        bystander_ticks = self.base / 'bystander.ticks'
        ticks_path = self.base / 'child.ticks'
        bystander = subprocess.Popen([sys.executable, '-c', ticker(bystander_ticks)],
                                     start_new_session=True)
        self.children.append(bystander)
        self.groups.append(bystander.pid)
        # Drive memory_supervised.main with a killpg audit hook in-process.
        driver = (f"import os, sys\nsys.path.insert(0, {str(HERE)!r})\n"
                  f"_log = {str(audit)!r}\n_orig = os.killpg\n"
                  "def _k(g, s):\n    open(_log, 'a').write(f'{g} {s}\\n')\n"
                  "    return _orig(g, s)\nos.killpg = _k\n"
                  "import memory_supervised as m\n"
                  f"sys.exit(m.main({self.supervised_args(ticker(ticks_path))!r}))\n")
        child = subprocess.Popen([sys.executable, '-c', driver],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        self.children.append(child)
        self.wait_ticks(ticks_path)
        self.wait_ticks(bystander_ticks)
        self.set_metrics(CRITICAL)
        pgid = self.wait_state('paused')['pgid']
        self.assert_stalled(ticks_path)
        self.assert_growing(bystander_ticks)
        child.send_signal(signal.SIGTERM)
        _, errors = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 143, errors)
        signalled = {int(line.split()[0]) for line in audit.read_text().splitlines()}
        self.assertEqual(signalled, {pgid})
        with self.assertRaises(ProcessLookupError):
            os.killpg(pgid, 0)
        self.assertIsNone(bystander.poll())
        os.killpg(bystander.pid, signal.SIGKILL)


if __name__ == '__main__':
    unittest.main()
