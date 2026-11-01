"""Pressure worker contracts: fixture metrics and fixture-owned groups only.

Metrics files are the injected probe; signals are real but only ever target
groups this suite created. No production telemetry, fleet process, or GUI app
is touched.
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
MODERATE = {'freeMemoryPercent': 20, 'swapUsedBytes': 0, 'pressureLevel': 1}


class ParseTests(unittest.TestCase):
    def test_metrics_parsing_and_classification(self):
        good = worker.parse_metrics('{"freeMemoryPercent": 80, "swapUsedBytes": 1024}')
        self.assertEqual(worker.classify(good), 'healthy')
        for text in ['{}', '4', 'null', '[]', '{"freeMemoryPercent": true, "swapUsedBytes": 0}',
                     '{"freeMemoryPercent": NaN, "swapUsedBytes": 0}',
                     '{"freeMemoryPercent": 101, "swapUsedBytes": 0}',
                     '{"freeMemoryPercent": 50, "swapUsedBytes": -1}',
                     '{"freeMemoryPercent": 50, "swapUsedBytes": 0, "pressureLevel": "4"}',
                     '{"freeMemoryPercent": 50, "swapUsedBytes": 0, "pressureLevel": 1.5}']:
            with self.assertRaises(ValueError, msg=text):
                worker.parse_metrics(text)
        self.assertEqual(worker.classify({'free': 9.9, 'swap': 0, 'pressure': 1}), 'critical')
        self.assertEqual(worker.classify({'free': 10, 'swap': 0, 'pressure': 1}), 'moderate')
        self.assertEqual(worker.classify({'free': 50, 'swap': 0, 'pressure': 4}), 'critical')
        self.assertEqual(worker.classify({'free': 50, 'swap': 0, 'pressure': 2}), 'moderate')
        self.assertEqual(worker.classify({'free': 80, 'swap': worker.MAX_SWAP_USED_BYTES,
                                          'pressure': 1}), 'critical')
        self.assertEqual(worker.classify({'free': 50, 'swap': 0, 'pressure': None}), 'healthy')

    def test_stale_and_missing_metrics_are_unavailable(self):
        with tempfile.TemporaryDirectory() as base:
            path = Path(base) / 'memguard.json'
            self.assertEqual(worker.probe(path, 30), 'unavailable')
            path.write_text(json.dumps(HEALTHY))
            self.assertEqual(worker.probe(path, 30), 'healthy')
            old = time.time() - 3600
            os.utime(path, (old, old))
            self.assertEqual(worker.probe(path, 30), 'unavailable')
            path.write_text('{not json')
            os.utime(path, None)
            self.assertEqual(worker.probe(path, 30), 'unavailable')


class ProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pressure-worker-test-')
        self.base = Path(self.temp.name)
        self.metrics = self.base / 'memguard.json'
        self.receipts = self.base / 'receipts'
        self.children, self.groups = [], []
        self.set_metrics(HEALTHY)

    def tearDown(self):
        for group in self.groups:
            try:
                os.killpg(group, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        for child in self.children:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=10)
        self.temp.cleanup()

    def set_metrics(self, row, age=0):
        self.metrics.write_text(json.dumps(row))
        if age:
            stamp = time.time() - age
            os.utime(self.metrics, (stamp, stamp))

    def start(self, script, *, max_age=30, launch_wait=5, inject='', **args):
        args = dict(poll=0.03, healthy_samples=2, launch_wait=launch_wait,
                    term_grace=1.0, **args)
        source = (f"import sys; sys.path.insert(0, {str(HERE)!r}); import pressure_worker as w; "
                  + inject +
                  f"sys.exit(w.run([sys.executable, '-c', {script!r}], {str(self.metrics)!r}, "
                  f"{max_age}, {str(self.receipts)!r}, "
                  + ', '.join(f'{k}={v!r}' for k, v in args.items()) + '))')
        child = subprocess.Popen([sys.executable, '-c', source],
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

    def ticks(self, path):
        return path.stat().st_size if path.exists() else 0

    def assert_stalled(self, path, window=0.5):
        before = self.ticks(path)
        time.sleep(window)
        self.assertEqual(self.ticks(path), before)

    def assert_growing(self, path, window=0.5):
        before = self.ticks(path)
        time.sleep(window)
        self.assertGreater(self.ticks(path), before)

    def wait_ticks(self, path, minimum=1, timeout=6):
        deadline = time.monotonic() + timeout
        while self.ticks(path) < minimum and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertGreaterEqual(self.ticks(path), minimum)

    def ticker(self, name, exit_code=0, seconds=30):
        path = self.base / name
        script = (f"import time,sys; from pathlib import Path; p=Path({str(path)!r}); "
                  f"end=time.time()+{seconds}; "
                  "\nwhile time.time()<end: p.open('a').write('x'); time.sleep(0.02)\n"
                  f"sys.exit({exit_code})")
        return script, path

    def test_healthy_run_propagates_exit_status(self):
        script, path = self.ticker('ticks', exit_code=7, seconds=0.3)
        child = self.start(script)
        _, errors = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 7, errors)
        self.assertGreater(self.ticks(path), 0)
        receipt = self.receipt()
        self.assertEqual((receipt['state'], receipt['returncode']), ('finished', 7))
        self.assertIsInstance(receipt['pgid'], int)
        self.assertGreater(receipt['pgid'], 0)
        for leaked in ('command', 'environment', 'argv', 'env'):
            self.assertNotIn(leaked, receipt)

    def test_critical_pauses_and_healthy_resumes(self):
        script, path = self.ticker('ticks', seconds=6)
        child = self.start(script)
        self.wait_ticks(path)
        self.set_metrics(CRITICAL)
        self.wait_state('paused')
        self.assert_stalled(path)
        self.set_metrics(HEALTHY)
        self.wait_state('running')
        self.assert_growing(path)
        child.send_signal(signal.SIGTERM)
        _, errors = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 143, errors)

    def test_cancellation_while_paused_reaps_owned_group(self):
        script, path = self.ticker('ticks')
        child = self.start(script)
        self.wait_ticks(path)
        self.set_metrics(CRITICAL)
        group = self.wait_state('paused')['pgid']
        child.send_signal(signal.SIGTERM)
        _, errors = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 143, errors)
        with self.assertRaises(ProcessLookupError):
            os.killpg(group, 0)
        self.assertEqual(self.receipt()['state'], 'cancelled')

    def test_stale_metrics_block_launch(self):
        marker = self.base / 'should-not-run'
        self.set_metrics(HEALTHY, age=3600)
        child = self.start(f'from pathlib import Path; Path({str(marker)!r}).touch()',
                           launch_wait=0.3)
        _, errors = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 75, errors)
        self.assertFalse(marker.exists())
        self.assertEqual(self.receipt()['state'], 'blocked')

    def test_moderate_blocks_launch_but_running_child_finishes(self):
        marker = self.base / 'should-not-run'
        self.set_metrics(MODERATE)
        child = self.start(f'from pathlib import Path; Path({str(marker)!r}).touch()',
                           launch_wait=0.3)
        _, errors = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 75, errors)
        self.assertFalse(marker.exists())
        self.set_metrics(HEALTHY)
        script, path = self.ticker('ticks', seconds=0.5)
        child = self.start(script)
        self.wait_ticks(path)
        self.set_metrics(MODERATE)
        _, errors = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 0, errors)
        self.assertEqual(self.receipt()['state'], 'finished')

    def test_unavailable_metrics_pause_running_child(self):
        script, path = self.ticker('ticks', seconds=6)
        child = self.start(script)
        self.wait_ticks(path)
        self.metrics.unlink()
        self.assertEqual(self.wait_state('paused')['reason'], 'unavailable')
        self.assert_stalled(path)
        child.send_signal(signal.SIGTERM)
        _, errors = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 143, errors)

    def test_caller_deadline_terminates_running_child(self):
        marker = self.base / 'started'
        child = self.start(f"import time; from pathlib import Path; "
                           f"Path({str(marker)!r}).touch(); time.sleep(30)", deadline=1.2)
        _, errors = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 124, errors)
        self.assertTrue(marker.exists())
        self.assertEqual(self.receipt()['state'], 'deadline')
        with self.assertRaises(ProcessLookupError):
            os.killpg(self.receipt()['pgid'], 0)

    def test_signals_only_hit_the_owned_group(self):
        audit = self.base / 'signals.log'
        inject = (f"import os\n_log={str(audit)!r}\n_orig=os.killpg\n"
                  "def _k(g, s):\n    open(_log, 'a').write(f'{g} {s}\\n')\n"
                  "    return _orig(g, s)\nos.killpg=_k\n")
        # An unrelated ticking process in its own session, never wrapped.
        bystander_script, bystander_path = self.ticker('bystander', seconds=6)
        bystander = subprocess.Popen([sys.executable, '-c', bystander_script],
                                     start_new_session=True)
        self.children.append(bystander)
        self.groups.append(bystander.pid)
        script, path = self.ticker('ticks')
        child = self.start(script, inject=inject)
        self.wait_ticks(path)
        self.wait_ticks(bystander_path)
        self.set_metrics(CRITICAL)
        group = self.wait_state('paused')['pgid']
        child.send_signal(signal.SIGTERM)
        _, errors = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 143, errors)
        signalled = {int(line.split()[0]) for line in audit.read_text().splitlines()}
        self.assertEqual(signalled, {group})
        with self.assertRaises(ProcessLookupError):
            os.killpg(group, 0)
        self.assert_growing(bystander_path)
        self.assertIsNone(bystander.poll())
        os.killpg(bystander.pid, signal.SIGKILL)


if __name__ == '__main__':
    unittest.main()
