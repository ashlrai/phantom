import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import host_lease
import state_snapshot

SCRIPT = Path(__file__).with_name('leader_failover.py')
CHILD = '''import os, pathlib, signal, sys, time
root, started, stopped = map(pathlib.Path, sys.argv[1:])
def stop(*_):
    stopped.write_text('stopped')
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
started.write_text(str(os.getpid()) + ':' + (root / 'leader/VISION.md').read_text())
while True: time.sleep(.02)
'''


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.db = self.base / 'leases.sqlite'
        self.clock = self.base / 'clock'
        self.clock.write_text('1000')
        self.env = dict(os.environ, HOME=str(self.base), HOST_LEASE_CLOCK_FILE=str(self.clock))
        source = self.base / 'source'
        (source / 'leader').mkdir(parents=True)
        (source / 'leader/VISION.md').write_text('restored')
        self.snapshot = self.base / 'snapshot'
        state_snapshot.create(source, self.snapshot)
        self.processes = []
        self.addCleanup(self.cleanup_processes)

    def cleanup_processes(self):
        for process in self.processes:
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
                try:
                    process.communicate(timeout=4)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate()

    def root(self, name):
        path = self.base / name
        path.mkdir(exist_ok=True)
        return path

    def command(self, host, root, *extra):
        return [sys.executable, str(SCRIPT), '--db', str(self.db), '--host', host,
                '--primary', 'primary', '--role', 'leader', '--ttl', '4', '--grace', '3',
                '--duration', '8', '--snapshot', str(self.snapshot), '--restore-root', str(root),
                *extra, '--', sys.executable, '-c', CHILD, str(root),
                str(self.base / (host + '.started')), str(self.base / (host + '.stopped'))]

    def spawn(self, host, root, *extra):
        process = subprocess.Popen(self.command(host, root, *extra), env=self.env,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.processes.append(process)
        return process

    def finish(self, process):
        out, err = process.communicate(timeout=8)
        return process.returncode, out, err

    def wait_file(self, path, process=None):
        end = time.monotonic() + 5
        while time.monotonic() < end:
            if path.exists():
                return path.read_text()
            if process is not None and process.poll() is not None:
                self.fail(f'process exited early: {self.finish(process)}')
            time.sleep(.02)
        self.fail('timed out waiting for sentinel')

    def lease(self, action, host='primary', fencing=None, ttl=4):
        args = host_lease.parser().parse_args(['--db', str(self.db), action, 'leader',
              '--host', host, *(['--ttl', str(ttl), '--primary', 'primary', '--grace', '3']
              if action == 'acquire' else ['--fencing', str(fencing)])])
        return host_lease.run(args, clock=lambda: float(self.clock.read_text()))

    def test_preview_and_healthy_primary_keep_standby_idle(self):
        root = self.root('standby-root')
        preview = self.spawn('standby', root)
        self.assertEqual(self.finish(preview)[:2], (0, 'preview\n'))
        self.assertFalse(self.db.exists())
        self.assertTrue(self.lease('acquire')['ok'])
        standby = self.spawn('standby', root, '--apply')
        self.assertEqual(self.finish(standby)[:2], (0, 'standby\n'))
        self.assertFalse((self.base / 'standby.started').exists())
        self.assertFalse((root / 'leader').exists())

    def test_expiry_and_grace_then_verified_restore_before_launch(self):
        self.assertTrue(self.lease('acquire')['ok'])
        root = self.root('standby-root')
        self.clock.write_text('1006')
        self.assertEqual(self.finish(self.spawn('standby', root, '--apply'))[:2], (0, 'standby\n'))
        self.clock.write_text('1007')
        process = self.spawn('standby', root, '--apply')
        data = self.wait_file(self.base / 'standby.started', process)
        self.assertTrue(data.endswith(':restored'))
        process.send_signal(signal.SIGTERM)
        self.assertNotEqual(self.finish(process)[0], 0)
        self.assertTrue((self.base / 'standby.stopped').exists())

    def test_contenders_start_only_one_and_cancel_releases(self):
        a = self.spawn('a', self.root('a-root'), '--apply')
        b = self.spawn('b', self.root('b-root'), '--apply')
        end = time.monotonic() + 5
        while not ((self.base / 'a.started').exists() or (self.base / 'b.started').exists()):
            self.assertLess(time.monotonic(), end)
            time.sleep(.02)
        winner, loser = (a, b) if (self.base / 'a.started').exists() else (b, a)
        self.assertEqual(self.finish(loser)[:2], (0, 'standby\n'))
        self.assertNotEqual((self.base / 'a.started').exists(), (self.base / 'b.started').exists())
        winner.send_signal(signal.SIGTERM)
        _, out, err = self.finish(winner)
        self.assertNotIn('release failed', out + err)
        with sqlite3.connect(self.db) as db:
            self.assertIsNone(db.execute('SELECT holder FROM leases').fetchone()[0])

    def test_corrupt_snapshot_never_launches(self):
        (self.snapshot / 'leader/VISION.md').write_text('corrupt')
        process = self.spawn('standby', self.root('root'), '--apply')
        self.assertNotEqual(self.finish(process)[0], 0)
        self.assertFalse((self.base / 'standby.started').exists())
        self.assertFalse(self.db.exists())

    def test_renewal_loss_stops_and_reaps_only_owned_child(self):
        process = self.spawn('primary', self.root('root'), '--apply')
        pid = int(self.wait_file(self.base / 'primary.started', process).split(':')[0])
        self.clock.write_text('1008')
        replacement = self.lease('acquire', 'standby')
        self.assertTrue(replacement['ok'])
        self.assertNotEqual(self.finish(process)[0], 0)
        self.assertTrue((self.base / 'primary.stopped').exists())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute('SELECT holder FROM leases').fetchone()[0], 'standby')

    def test_root_lock_prevents_restore_over_running_leader(self):
        root = self.root('root')
        first = self.spawn('primary', root, '--apply')
        self.wait_file(self.base / 'primary.started', first)
        first.send_signal(signal.SIGSTOP)
        self.addCleanup(lambda: first.poll() is None and first.send_signal(signal.SIGCONT))
        self.clock.write_text('1008')
        second = self.spawn('standby', root, '--apply')
        self.assertNotEqual(self.finish(second)[0], 0)
        self.assertFalse((self.base / 'standby.started').exists())
        self.assertEqual((root / 'leader/VISION.md').read_text(), 'restored')
        first.send_signal(signal.SIGCONT)
        first.send_signal(signal.SIGTERM)
        self.finish(first)

    def test_unavailable_coordinator_fails_closed_and_bounded(self):
        self.lease('acquire')
        with sqlite3.connect(self.db) as db:
            db.execute('BEGIN IMMEDIATE')
            start = time.monotonic()
            process = self.spawn('standby', self.root('root'), '--apply')
            self.assertNotEqual(self.finish(process)[0], 0)
            self.assertLess(time.monotonic() - start, 3)
            self.assertFalse((self.base / 'standby.started').exists())


if __name__ == '__main__':
    unittest.main()
