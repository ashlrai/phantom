import io
import json
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

import host_queue_ingress as ingress

SCRIPT = Path(__file__).with_name('host_queue_ingress.py')
HEADER = b'#job repo=phantom lane=codex-personal tier=work\n\n'


class StopTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.drop = self.root / 'drop'
        self.drop.mkdir()
        self.db = self.root / 'queue.sqlite'
        self.source = self.drop / 'RQ-PHX-ABC.md'
        self.source.write_bytes(HEADER + b'Harmless prompt\n')

    def spawn(self, *extra):
        return subprocess.Popen(
            [sys.executable, str(SCRIPT), '--drop-dir', str(self.drop),
             '--db', str(self.db), '--cycles', '1000', '--interval', '3600', *extra],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def line(self, proc):
        text = proc.stdout.readline()
        self.assertTrue(text, 'ingress exited before reporting a scan')
        return json.loads(text)

    def rows(self):
        with sqlite3.connect(self.db) as db:
            return db.execute('SELECT job FROM jobs ORDER BY job').fetchall()

    def test_signal_during_interval_wait_stops_before_next_scan(self):
        for signum, name in ((signal.SIGTERM, 'SIGTERM'), (signal.SIGINT, 'SIGINT')):
            with self.subTest(signal=name):
                proc = self.spawn()
                try:
                    # The first scan line is the readiness barrier: afterwards
                    # the child is inside the interruptible interval wait.
                    self.assertEqual(self.line(proc)['eligible'], ['RQ-PHX-ABC'])
                    proc.send_signal(signum)
                    self.assertEqual(proc.wait(timeout=20), 0)
                    rest = [json.loads(text) for text in proc.stdout]
                finally:
                    proc.kill()
                    proc.stdout.close()
                    proc.stderr.close()
                self.assertEqual(rest, [{'stopped': True, 'cycles': 1, 'signal': name}])

    def test_sigterm_preserves_inserted_job_and_restart_dedupes(self):
        proc = self.spawn('--apply')
        try:
            self.assertEqual(self.line(proc)['inserted'], ['RQ-PHX-ABC'])
            proc.send_signal(signal.SIGTERM)
            self.assertEqual(proc.wait(timeout=20), 0)
            self.assertEqual(json.loads(proc.stdout.readline())['stopped'], True)
        finally:
            proc.kill()
            proc.stdout.close()
            proc.stderr.close()
        self.assertEqual(self.rows(), [('RQ-PHX-ABC',)])
        self.assertTrue(self.source.exists())
        again = subprocess.run(
            [sys.executable, str(SCRIPT), '--drop-dir', str(self.drop),
             '--db', str(self.db), '--once', '--apply'],
            capture_output=True, text=True, timeout=40)
        self.assertEqual(again.returncode, 0, again.stderr)
        report = json.loads(again.stdout)
        self.assertEqual(report['duplicate'], ['RQ-PHX-ABC'])
        self.assertEqual(report['inserted'], [])
        self.assertEqual(self.rows(), [('RQ-PHX-ABC',)])

    def test_preview_signal_never_creates_database(self):
        proc = self.spawn()
        try:
            self.line(proc)
            proc.send_signal(signal.SIGTERM)
            self.assertEqual(proc.wait(timeout=20), 0)
        finally:
            proc.kill()
            proc.stdout.close()
            proc.stderr.close()
        self.assertFalse(self.db.exists())
        self.assertTrue(self.source.exists())

    def test_scan_failure_stays_nonzero_and_is_not_a_clean_stop(self):
        proc = subprocess.run(
            [sys.executable, str(SCRIPT), '--drop-dir', str(self.drop),
             '--db', str(self.root / 'missing' / 'queue.sqlite'), '--once', '--apply'],
            capture_output=True, text=True, timeout=40)
        self.assertEqual(proc.returncode, 1)
        report = json.loads(proc.stdout)
        self.assertIn('error', report)
        self.assertNotIn('stopped', report)

    def test_injected_stop_skips_scan_and_restores_handlers(self):
        previous = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
        stop = threading.Event()
        stop.set()
        out = io.StringIO()
        rc = ingress.main(['--drop-dir', str(self.drop), '--db', str(self.db),
                           '--cycles', '1000'], deps={'stop': stop}, out=out)
        self.assertEqual(rc, 0)
        report = json.loads(out.getvalue())
        self.assertEqual(report, {'stopped': True, 'cycles': 0})
        for sig, handler in previous.items():
            self.assertIs(signal.getsignal(sig), handler)

    def test_stop_during_scan_finishes_scan_then_suppresses_next(self):
        stop = threading.Event()
        calls = 0
        real_cycle = ingress.cycle
        def scanning(args):
            nonlocal calls
            calls += 1
            stop.set()  # supervisor asks to stop while the scan is in flight
            return real_cycle(args)
        out = io.StringIO()
        with mock.patch.object(ingress, 'cycle', side_effect=scanning):
            rc = ingress.main(['--drop-dir', str(self.drop), '--db', str(self.db),
                               '--cycles', '1000', '--apply'], deps={'stop': stop}, out=out)
        self.assertEqual(rc, 0)
        lines = [json.loads(text) for text in out.getvalue().splitlines()]
        self.assertEqual(lines[0]['inserted'], ['RQ-PHX-ABC'])
        self.assertEqual(lines[1], {'stopped': True, 'cycles': 1})
        self.assertEqual(calls, 1)
        self.assertEqual(self.rows(), [('RQ-PHX-ABC',)])


if __name__ == '__main__':
    unittest.main()
