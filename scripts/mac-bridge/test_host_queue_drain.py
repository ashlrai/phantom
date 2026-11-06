import io
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace

import host_queue
import host_queue_drain

DRAIN = str(Path(__file__).with_name('host_queue_drain.py'))
WRITE = "import sys,pathlib; d=sys.stdin.buffer.read(); pathlib.Path(sys.argv[1],d.decode()).write_bytes(d)"


class Clock:
    now = 0.0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class FakeWorker:  # Popen stand-in reporting an outcome line after `live` clock seconds
    def __init__(self, clock, live, rc, line):
        self.clock, self.until, self.rc, self.line = clock, clock() + live, rc, line
        self.pid = 2 ** 22  # implausible live process group
        self.returncode = None
        self.stdout = io.StringIO(line + '\n')
        self.dead = False

    def poll(self):
        if self.returncode is None and (self.dead or self.clock() >= self.until):
            self.returncode = 1 if self.dead else self.rc
        return self.returncode

    def terminate(self):
        self.dead = True


class DrainTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = str(self.root / 'queue.db')
        self.processes = []
        self.addCleanup(self.cleanup)

    def cleanup(self):
        for proc in self.processes:
            if proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=5)

    def enqueue(self, job, payload):
        path = self.root / ('payload-' + job)
        path.write_bytes(payload)
        result = host_queue.run(SimpleNamespace(db=self.db, action='enqueue', job=job, payload=str(path)))
        self.assertTrue(result['ok'])

    def state(self, job):
        return host_queue.run(SimpleNamespace(db=self.db, action='status', job=job))['state']

    def args(self, **overrides):
        base = dict(db=self.db, host='host-a', lease=30, runtime=300, max_jobs=10,
                    deadline=60, idle=5, pause_file=None, command=['true'])
        base.update(overrides)
        return SimpleNamespace(**base)

    def unit(self, outcomes, **overrides):  # outcomes = scripted (live, rc, line) workers
        clock = Clock()
        calls = []

        def spawn(argv):
            calls.append(argv)
            live, rc, line = outcomes[len(calls) - 1] if len(calls) <= len(outcomes) else (0, 0, 'empty')
            return FakeWorker(clock, live, rc, line)

        stats = host_queue_drain.run(self.args(**overrides), clock=clock,
                                     sleep=clock.sleep, spawn=spawn)
        return stats, calls, clock

    def drain(self, *args):
        proc = subprocess.Popen([sys.executable, DRAIN, '--db', self.db, '--host', 'host-a', *args],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=self.root)
        self.processes.append(proc)
        return proc

    def finish(self, proc, expected=0):
        out, err = proc.communicate(timeout=40)
        self.assertEqual(proc.returncode, expected, (out, err))
        self.assertEqual(err, '')
        return out

    def drain_writers(self, jobs, max_jobs):
        for job in jobs:
            self.enqueue(job, job.encode())
        proc = self.drain('--lease', '5', '--runtime', '10', '--max-jobs', str(max_jobs),
                          '--deadline', '60', '--idle', '1', '--',
                          sys.executable, '-c', WRITE, str(self.root))
        return self.finish(proc)

    def test_empty_queue_idles_bounded_until_deadline(self):
        stats, calls, _ = self.unit([], deadline=10, idle=3)
        self.assertEqual((stats.status, stats.reason), (0, 'deadline'))
        self.assertEqual((stats.attempted, stats.completed), (0, 0))
        self.assertLessEqual(len(calls), 4)  # one claim per idle round, no spin
        self.assertGreater(stats.idle, 0)

    def test_pause_blocks_claims_but_owned_worker_finishes(self):
        pause = self.root / 'PAUSE'
        pause.touch()
        self.enqueue('held', b'work')
        stats, calls, _ = self.unit([(0, 0, 'success')], deadline=6, idle=2,
                                    pause_file=str(pause))
        self.assertEqual(len(calls), 0)
        self.assertEqual(self.state('held'), 'queued')
        self.assertEqual((stats.status, stats.reason), (0, 'deadline'))
        self.assertGreater(stats.paused, 0)
        self.assertTrue(pause.exists())  # the sentinel is never deleted

        pause.unlink()
        clock = Clock()
        calls = []

        def spawn(argv):  # one real claim, then only empties; pause lands mid-run
            calls.append(argv)
            first = len(calls) == 1
            return FakeWorker(clock, 10 if first else 0, 0, 'success' if first else 'empty')

        def sleep(seconds):
            clock.sleep(seconds)
            if clock.now >= 5:
                pause.touch()

        stats = host_queue_drain.run(self.args(deadline=30, idle=2, pause_file=str(pause)),
                                     clock=clock, sleep=sleep, spawn=spawn)
        self.assertEqual(stats.completed, 1)
        self.assertEqual(len(calls), 1)

    def test_failure_stops_without_retry(self):
        stats, calls, _ = self.unit([(0, 1, 'worker failed'), (0, 0, 'success')])
        self.assertEqual((stats.status, stats.reason), (1, 'worker failed'))
        self.assertEqual((stats.attempted, stats.failed), (1, 1))
        self.assertEqual(len(calls), 1)

    def test_deadline_kills_owned_worker_and_counts_attempt(self):
        stats, _, _ = self.unit([(60, 0, 'success')], deadline=10)
        self.assertEqual((stats.status, stats.reason), (1, 'deadline'))
        self.assertEqual((stats.attempted, stats.killed, stats.completed), (1, 1, 0))

    def test_three_jobs_run_sequentially_once_then_max_jobs(self):
        out = self.drain_writers(('one', 'two', 'three'), 3)
        self.assertIn('reason=max-jobs', out)
        self.assertIn('completed=3', out)
        for job in ('one', 'two', 'three'):
            self.assertEqual((self.root / job).read_bytes(), job.encode())
            self.assertEqual(self.state(job), 'completed')
        with sqlite3.connect(self.db) as db:
            rows = db.execute('SELECT generation FROM jobs').fetchall()
        self.assertEqual(rows, [(1,), (1,), (1,)])

    def test_max_jobs_leaves_remaining_queued(self):
        out = self.drain_writers(('a', 'b', 'c'), 2)
        self.assertIn('reason=max-jobs', out)
        self.assertIn('completed=2', out)
        self.assertEqual([self.state(j) for j in ('a', 'b', 'c')],
                         ['completed', 'completed', 'queued'])
        self.assertFalse((self.root / 'c').exists())

    def kill_setup(self):
        self.enqueue('slow', b'work')
        marker, beats = self.root / 'started', self.root / 'beats'
        grandchild = ("import pathlib,sys,time; p=pathlib.Path(sys.argv[1]); "
                      "exec('while True:\\n p.write_text(str(time.monotonic()))\\n time.sleep(.03)')")
        code = ("import pathlib,subprocess,sys,time; "
                "subprocess.Popen([sys.executable,'-c',sys.argv[3],sys.argv[2]]); "
                "pathlib.Path(sys.argv[1]).touch(); time.sleep(30)")
        return marker, beats, [sys.executable, '-c', code, str(marker), str(beats), grandchild]

    def assert_descendants_stopped(self, beats):
        self.assertTrue(beats.exists())
        time.sleep(.1)
        last = beats.read_bytes()
        time.sleep(.2)
        self.assertEqual(beats.read_bytes(), last)

    def test_deadline_terminates_subtree_and_never_completes(self):
        _, beats, argv = self.kill_setup()
        proc = self.drain('--lease', '30', '--runtime', '30', '--deadline', '6', '--', *argv)
        out = self.finish(proc, expected=1)
        self.assertIn('reason=deadline', out)
        self.assertIn('killed=1', out)
        self.assertNotEqual(self.state('slow'), 'completed')
        self.assert_descendants_stopped(beats)
        with sqlite3.connect(self.db) as db:
            db.execute("UPDATE jobs SET expires=0 WHERE job='slow'")
        self.assertEqual(self.state('slow'), 'uncertain')

    def test_sigterm_terminates_subtree_and_never_completes(self):
        _, beats, argv = self.kill_setup()
        proc = self.drain('--lease', '30', '--runtime', '30', '--deadline', '60', '--', *argv)
        end = time.monotonic() + 10
        while not beats.exists():
            self.assertLess(time.monotonic(), end, 'worker payload never started')
            time.sleep(0.05)
        proc.send_signal(signal.SIGTERM)
        out = self.finish(proc, expected=1)
        self.assertIn('reason=interrupted', out)
        self.assertNotEqual(self.state('slow'), 'completed')
        self.assert_descendants_stopped(beats)


if __name__ == '__main__':
    unittest.main()
