"""Pause-budget escalation contracts: fixture telemetry and owned groups only.

FakeClockTests drives worker.run in process with an injected monotonic clock,
an injected sleeper that advances it, and a scripted sampler, so pause-budget
timing is deterministic; each test still owns one tiny real child whose group
is stopped, terminated and reaped for real. ProcessTests repeats the wrapper
subprocess harness from test_pressure_worker.py so signals and group reaping
stay real. No production telemetry, fleet process, or GUI app is touched.
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

import pressure_worker as worker

HERE = Path(__file__).resolve().parent
HEALTHY = {'freeMemoryPercent': 80, 'swapUsedBytes': 0, 'pressureLevel': 1}
CRITICAL = {'freeMemoryPercent': 3, 'swapUsedBytes': 0, 'pressureLevel': 4}
KILL_EXIT = 71
KILL_STATE, KILL_REASON = 'pressure-kill', 'pause-budget-exhausted'


class FakeClock:
    """Monotonic clock advanced only by the wrapper's own sleeps."""

    def __init__(self):
        self.now = 1_000_000.0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += max(0.0, seconds)


def scripted(states, fallback='critical'):
    queue = list(states)
    calls = {'n': 0, 'healthy': 0}

    def sample(*_args):
        calls['n'] += 1
        state = queue.pop(0) if queue else fallback
        calls['healthy'] += state == 'healthy'
        return state

    return sample, calls


class FakeClockTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pressure-budget-test-')
        self.base = Path(self.temp.name)
        self.metrics = self.base / 'memguard.json'
        self.receipts = self.base / 'receipts'
        self.clock = FakeClock()

    def tearDown(self):
        self.temp.cleanup()

    def run_budget(self, states, fallback='critical', **kwargs):
        sampler, calls = scripted(states, fallback)
        args = dict(poll=1.0, healthy_samples=3, launch_wait=30, term_grace=0.5,
                    deadline=120, clock=self.clock, sleep=self.clock.sleep,
                    sampler=sampler)
        args.update(kwargs)
        code = worker.run([sys.executable, '-c', 'import time; time.sleep(60)'],
                          self.metrics, 30, self.receipts, **args)
        return code, calls

    def receipt(self):
        files = list(self.receipts.glob('*.json'))
        self.assertTrue(files)
        return json.loads(max(files, key=lambda p: p.stat().st_mtime).read_text())

    def assert_group_gone(self, pgid):
        with self.assertRaises(ProcessLookupError):
            os.killpg(pgid, 0)

    def assert_killed(self, code):
        receipt = self.receipt()
        self.assertEqual(code, KILL_EXIT)
        self.assertEqual((receipt['state'], receipt['reason'], receipt['returncode']),
                         (KILL_STATE, KILL_REASON, KILL_EXIT))
        self.assertGreaterEqual(receipt['pausedSeconds'], 5.0)
        self.assertEqual(receipt['maxPausedSeconds'], 5.0)
        for leaked in ('command', 'environment', 'argv', 'env'):
            self.assertNotIn(leaked, receipt)
        self.assert_group_gone(receipt['pgid'])
        return receipt

    def test_sustained_critical_kills_owned_group_at_budget(self):
        code, _calls = self.run_budget(['healthy'] * 3, max_paused=5.0)
        receipt = self.assert_killed(code)
        self.assertLess(receipt['pausedSeconds'], 6.0)

    def test_unavailable_telemetry_counts_toward_budget(self):
        code, _calls = self.run_budget(['healthy'] * 3, fallback='unavailable',
                                       max_paused=5.0)
        self.assert_killed(code)

    def test_healthy_blips_never_reset_budget(self):
        # Single healthy samples during the stop never reach the resume
        # hysteresis, so the group stays stopped and the budget still expires.
        blips = ['critical', 'critical', 'healthy', 'critical', 'moderate',
                 'healthy'] * 4
        code, calls = self.run_budget(['healthy'] * 3 + blips, max_paused=5.0)
        self.assertGreater(calls['healthy'], 3)  # blips really were sampled
        self.assert_killed(code)

    def test_real_resume_resets_budget(self):
        states = (['healthy'] * 3 + ['critical'] + ['healthy'] * 3 +
                  ['critical'] * 50)
        start = self.clock.now
        code, _calls = self.run_budget(states, max_paused=5.0)
        receipt = self.assert_killed(code)
        # Pause one ran 3 fake seconds to the resume, pause two ran the full
        # 5-second budget: an unreset budget would have fired ~3s earlier.
        self.assertGreaterEqual(self.clock.now - start, 8.0)
        self.assertLess(receipt['pausedSeconds'], 6.0)

    def test_omitted_budget_keeps_pause_unbounded(self):
        code, _calls = self.run_budget(['healthy'] * 3, deadline=20.0)
        receipt = self.receipt()
        self.assertEqual((code, receipt['state']), (124, 'deadline'))
        self.assertIsNone(receipt['maxPausedSeconds'])
        self.assertGreaterEqual(receipt['pausedSeconds'], 10.0)
        self.assert_group_gone(receipt['pgid'])

    def test_deadline_beats_pending_budget(self):
        code, _calls = self.run_budget(['healthy'] * 3, deadline=5.0,
                                       max_paused=60.0)
        receipt = self.receipt()
        self.assertEqual((code, receipt['state'], receipt['returncode']),
                         (124, 'deadline', 124))
        self.assert_group_gone(receipt['pgid'])

    def test_invalid_budget_rejected(self):
        for bad in (0, -1, float('nan'), float('inf')):
            with self.assertRaises(ValueError, msg=bad):
                worker.run(['true'], self.metrics, 30, self.receipts,
                           max_paused=bad)
        for bad in ('0', '-1', 'nan', 'inf'):
            with self.assertRaises(ValueError, msg=bad):
                worker.main(['--metrics', str(self.metrics), '--max-age-seconds',
                             '30', '--receipt-dir', str(self.receipts),
                             '--max-paused-seconds', bad, '--', 'true'])


class ProcessTests(unittest.TestCase):
    """Real wrapper subprocesses and real-time pressure windows."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pressure-budget-proc-')
        self.base = Path(self.temp.name)
        self.metrics = self.base / 'memguard.json'
        self.receipts = self.base / 'receipts'
        self.children = []
        self.set_metrics(HEALTHY)

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=10)
        self.temp.cleanup()

    def set_metrics(self, row):
        self.metrics.write_text(json.dumps(row))

    def start(self, script, **args):
        args = dict(poll=0.03, healthy_samples=2, launch_wait=5,
                    term_grace=1.0, **args)
        source = (f"import sys; sys.path.insert(0, {str(HERE)!r}); "
                  f"import pressure_worker as w; "
                  f"sys.exit(w.run([sys.executable, '-c', {script!r}], "
                  f"{str(self.metrics)!r}, 30, {str(self.receipts)!r}, "
                  + ', '.join(f'{k}={v!r}' for k, v in args.items()) + '))')
        child = subprocess.Popen([sys.executable, '-c', source],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                 text=True)
        self.children.append(child)
        return child

    def receipt(self):
        files = list(self.receipts.glob('*.json'))
        self.assertTrue(files)
        return json.loads(max(files, key=lambda p: p.stat().st_mtime).read_text())

    def wait_state(self, state, timeout=6):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            files = list(self.receipts.glob('*.json'))
            if files:
                receipt = json.loads(
                    max(files, key=lambda p: p.stat().st_mtime).read_text())
                if receipt['state'] == state:
                    return receipt
            time.sleep(0.03)
        self.assertEqual(self.receipt()['state'], state)
        return self.receipt()

    def wait_pid_gone(self, pid, timeout=4):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.03)
        self.fail(f'pid {pid} still alive')

    def wait_group_gone(self, pgid, timeout=4):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                os.killpg(pgid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.03)
        self.fail(f'process group {pgid} still alive')

    def test_sustained_critical_terminates_child_and_descendant(self):
        marker = self.base / 'descendant.pid'
        script = ("import subprocess,sys,time; "
                  f"d=subprocess.Popen([sys.executable,'-c','import time;"
                  f"time.sleep(60)']); open({str(marker)!r},'w')"
                  ".write(str(d.pid)); time.sleep(60)")
        child = self.start(script, max_paused=0.6)
        pgid = self.wait_state('running')['pgid']
        deadline = time.monotonic() + 6
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(0.03)
        self.assertTrue(marker.exists())
        descendant = int(marker.read_text())
        self.set_metrics(CRITICAL)
        _, errors = child.communicate(timeout=15)
        self.assertEqual(child.returncode, KILL_EXIT, errors)
        receipt = self.receipt()
        self.assertEqual((receipt['state'], receipt['reason'], receipt['returncode']),
                         (KILL_STATE, KILL_REASON, KILL_EXIT))
        self.assertGreaterEqual(receipt['pausedSeconds'], 0.6)
        self.assertEqual(receipt['maxPausedSeconds'], 0.6)
        self.wait_group_gone(pgid)
        self.wait_pid_gone(descendant)

    def test_brief_pressure_resumes_within_budget(self):
        child = self.start("import time; time.sleep(60)", max_paused=4.0)
        self.wait_state('running')
        self.set_metrics(CRITICAL)
        self.assertEqual(self.wait_state('paused')['reason'], 'critical')
        self.set_metrics(HEALTHY)
        self.assertEqual(self.wait_state('running')['reason'], 'resumed')
        child.send_signal(signal.SIGTERM)
        _, errors = child.communicate(timeout=15)
        self.assertEqual(child.returncode, 143, errors)
        self.assertEqual(self.receipt()['state'], 'cancelled')

    def test_missing_telemetry_reaches_budget(self):
        child = self.start("import time; time.sleep(60)", max_paused=0.6)
        self.wait_state('running')
        self.metrics.unlink()
        _, errors = child.communicate(timeout=15)
        self.assertEqual(child.returncode, KILL_EXIT, errors)
        self.assertEqual(self.receipt()['reason'], KILL_REASON)

    def test_cancel_while_paused_keeps_cancelled_outcome(self):
        child = self.start("import time; time.sleep(60)", max_paused=30.0)
        self.wait_state('running')
        self.set_metrics(CRITICAL)
        self.wait_state('paused')
        child.send_signal(signal.SIGTERM)
        _, errors = child.communicate(timeout=15)
        self.assertEqual(child.returncode, 143, errors)
        self.assertEqual(self.receipt()['state'], 'cancelled')

    def test_deadline_while_paused_keeps_deadline_outcome(self):
        child = self.start("import time; time.sleep(60)", max_paused=30.0,
                           deadline=1.2)
        self.wait_state('running')
        self.set_metrics(CRITICAL)
        self.wait_state('paused')
        _, errors = child.communicate(timeout=15)
        self.assertEqual(child.returncode, 124, errors)
        self.assertEqual(self.receipt()['state'], 'deadline')


if __name__ == '__main__':
    unittest.main()
