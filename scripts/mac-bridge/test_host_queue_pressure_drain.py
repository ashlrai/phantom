"""Pressure-gated serial drain contracts: one gated claim at a time.

Fake clock/spawn drive loop semantics; one short real subprocess run proves
serial completion, telemetry gating and reaping end to end. Every spawned
group is created and reaped inside temporary roots — no real fleet processes
or pressure probes are touched.
"""

import io
import json
import os
from pathlib import Path
import signal
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace

import host_queue
import host_queue_pressure_drain as drain

HERE = Path(__file__).resolve().parent
WRAPPER = str(HERE / 'queue_pressure_worker.py')
HEALTHY = {'freeMemoryPercent': 80, 'swapUsedBytes': 0, 'pressureLevel': 1}
MODERATE_JSON = json.dumps({'freeMemoryPercent': 20, 'swapUsedBytes': 0,
                            'pressureLevel': 1})


def drain_args(root, db, **overrides):
    base = dict(db=db, host='host-a', lease=5, runtime=30,
                metrics=str(root / 'memguard.json'), max_age_seconds=30.0,
                state_dir=str(root / 'state'),
                pause_file=str(root / 'PAUSE'),
                receipt_dir=str(root / 'receipts'), job='testjob',
                poll_seconds=0.05, healthy_samples=1,
                launch_wait_seconds=0.3, max_paused_seconds=8.0,
                term_grace_seconds=0.5, deadline=25, max_jobs=10, idle=0.3,
                command=['/bin/job', 'x'])
    base.update(overrides)
    return SimpleNamespace(**base)


class Clock:
    now = 0.0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class FakeWrapper:  # Popen stand-in reporting rc/line after `live` clock seconds
    def __init__(self, clock, live, rc, line):
        self.clock, self.until = clock, clock() + live
        self.rc, self.line, self.pid = rc, line, 2 ** 22  # implausible group
        self.returncode = None
        self.stdout = io.StringIO(line + '\n')
        self.dead = False

    def poll(self):
        if self.returncode is None and (self.dead or self.clock() >= self.until):
            self.returncode = 1 if self.dead else self.rc
        return self.returncode

    def terminate(self):
        self.dead = True


class DrainUnitTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)

    def unit(self, outcomes, **overrides):  # outcomes = scripted (live, rc, line)
        clock = Clock()
        calls, procs = [], []

        def spawn(argv):
            calls.append(argv)
            live, rc, line = (outcomes[len(calls) - 1]
                              if len(calls) <= len(outcomes) else (0, 0, 'empty'))
            procs.append(FakeWrapper(clock, live, rc, line))
            return procs[-1]

        stats = drain.run(drain_args(self.root, str(self.root / 'q.db'),
                                     **overrides),
                          clock=clock, sleep=clock.sleep, spawn=spawn)
        return stats, calls, procs

    def test_wrapper_argv_forwards_controls_with_capped_deadline(self):
        _, calls, _ = self.unit([(0, 75, '')], deadline=20, idle=2)
        self.assertGreaterEqual(len(calls), 2)
        argv = calls[0]
        self.assertEqual(argv[:2], [sys.executable, WRAPPER])
        flags = argv[2:argv.index('--')]
        pairs = dict(zip(flags[::2], flags[1::2]))
        for key, want in {'--metrics': str(self.root / 'memguard.json'),
                          '--max-age-seconds': '30.0',
                          '--state-dir': str(self.root / 'state'),
                          '--receipt-dir': str(self.root / 'receipts'),
                          '--pause-file': str(self.root / 'PAUSE'),
                          '--lease': '5', '--runtime': '30',
                          '--max-paused-seconds': '8.0', '--job': 'testjob',
                          '--deadline-seconds': '20.0'}.items():
            self.assertEqual(pairs[key], want)
        flags = calls[1][2:calls[1].index('--')]
        capped = dict(zip(flags[::2], flags[1::2]))['--deadline-seconds']
        self.assertEqual(capped, '18.0')  # capped to remaining budget
        self.assertEqual(argv[argv.index('--') + 1:], ['/bin/job', 'x'])

    def test_successes_continue_serially_until_max_jobs(self):
        stats, calls, _ = self.unit([(0, 0, 'success')] * 3, max_jobs=2)
        self.assertEqual((stats.completed, stats.attempted), (2, 2))
        self.assertEqual((stats.status, stats.reason), (0, 'max-jobs'))
        self.assertEqual(len(calls), 2)

    def test_empty_queue_is_bounded_idle(self):
        stats, calls, _ = self.unit([], deadline=7, idle=2)
        self.assertEqual((stats.status, stats.reason), (0, 'deadline'))
        self.assertEqual((stats.attempted, stats.completed), (0, 0))
        self.assertGreater(stats.idle, 0)
        self.assertLessEqual(len(calls), 4)  # one gated poll per idle round

    def test_blocked_waits_within_budget_and_never_attempts(self):
        stats, calls, _ = self.unit([(0, 75, '')] * 8, deadline=8, idle=2)
        self.assertEqual((stats.status, stats.reason), (0, 'deadline'))
        self.assertEqual((stats.attempted, stats.completed), (0, 0))
        self.assertEqual((stats.blocked, len(calls)), (4, 4))
        # A success before blocked rounds still counts only the real attempt.
        stats, _, _ = self.unit([(0, 0, 'success')] + [(0, 75, '')] * 9,
                                deadline=9, idle=2)
        self.assertEqual((stats.completed, stats.attempted), (1, 1))
        self.assertGreater(stats.blocked, 0)
        self.assertEqual(stats.status, 0)

    def test_terminal_outcomes_stop_without_retry(self):
        # rc, line, reason — every failure or uncertain outcome halts the drain.
        cases = [(1, 'timeout', 'timeout'), (1, 'bogus', 'worker failed'),
                 (71, '', 'pause-budget-exhausted'), (124, '', 'deadline'),
                 (143, '', 'cancelled'), (70, '', 'launch failed'),
                 (127, '', 'launch failed'), (0, 'bogus', 'worker protocol error'),
                 (0, 'x' * 5000, 'worker protocol error')]
        for rc, line, reason in cases:
            stats, calls, _ = self.unit([(0, rc, line), (0, 0, 'success')])
            self.assertEqual((stats.status, stats.reason, len(calls)),
                             (1, reason, 1), (rc, line))
            self.assertEqual((stats.attempted, stats.failed), (1, 1), (rc, line))
            self.assertEqual(stats.completed, 0)

    def test_outer_deadline_stops_live_wrapper(self):
        stats, _, procs = self.unit([(60, 0, 'success')], deadline=10)
        self.assertEqual((stats.status, stats.reason), (1, 'deadline'))
        self.assertEqual((stats.attempted, stats.killed, stats.completed),
                         (1, 1, 0))
        self.assertTrue(procs[0].dead)

    def test_sigterm_reaps_owned_wrapper_before_returning(self):
        clock = Clock()
        procs = []

        def spawn(argv):
            procs.append(FakeWrapper(clock, 60, 0, 'success'))
            return procs[-1]

        def sleep(seconds):
            clock.sleep(seconds)
            if clock.now >= 5:
                raise KeyboardInterrupt

        stats = drain.run(drain_args(self.root, str(self.root / 'q.db'),
                                     deadline=60),
                          clock=clock, sleep=sleep, spawn=spawn)
        self.assertEqual((stats.status, stats.reason), (1, 'interrupted'))
        self.assertEqual((stats.attempted, stats.killed), (1, 1))
        self.assertTrue(procs[0].dead)


class DrainSubprocessTests(unittest.TestCase):
    """Real queue + real wrappers through drain.run's default spawn seam."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pressure-drain-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = str(self.root / 'queue.db')
        self.metrics = self.root / 'memguard.json'
        self.receipts = self.root / 'receipts'
        self.addCleanup(self.reap)
        self.set_metrics(HEALTHY)

    def reap(self):
        for group in self.groups():
            try:
                os.killpg(group, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass

    def set_metrics(self, row):
        self.metrics.write_text(json.dumps(row))

    def enqueue(self, job):
        payload = self.root / ('payload-' + job)
        payload.write_bytes(job.encode())
        self.assertTrue(host_queue.run(SimpleNamespace(
            db=self.db, action='enqueue', job=job, payload=str(payload)))['ok'])

    def state(self, job):
        return host_queue.run(SimpleNamespace(
            db=self.db, action='status', job=job))['state']

    def groups(self):  # every session group ever recorded in receipts
        seen = []
        for path in self.receipts.glob('*.json') if self.receipts.exists() else []:
            try:
                record = json.loads(path.read_text())
                seen += [record['pgid'], *record.get('subgroups', [])]
            except (ValueError, TypeError):
                pass
        return [g for g in seen if isinstance(g, int) and g > 0]

    def test_serial_completion_then_telemetry_gate(self):
        """Serial completions, then the clouded gate holds 'held' forever.

        'gate' clouds the metrics before exiting, so 'held' behind it can
        never pass an admission gate inside the deadline.
        """
        for name in ('one', 'gate', 'held'):
            self.enqueue(name)
        self.metrics.unlink()  # missing telemetry must not claim
        args = drain_args(
            self.root, self.db,
            command=['/bin/sh', '-c',
                     'n=$(cat); printf %s "$n" >"$1/$n";'
                     '[ "$n" = gate ] && printf %s "$2" >"$3"; exit 0',
                     'w', str(self.root), MODERATE_JSON, str(self.metrics)])
        result = []
        thread = threading.Thread(
            target=lambda: result.append(drain.run(args)), daemon=True)
        thread.start()
        time.sleep(3.5)  # covers spawn overhead plus one blocked round
        self.assertEqual(self.state('one'), 'queued')  # still gated
        self.set_metrics(HEALTHY)
        end = time.monotonic() + 20
        while self.state('gate') != 'completed' and time.monotonic() < end:
            time.sleep(0.1)
        self.assertEqual(self.state('gate'), 'completed')
        thread.join(timeout=40)
        self.assertFalse(thread.is_alive())
        stats = result[0]
        self.assertEqual(stats.reason, 'deadline')
        self.assertEqual(stats.completed, 2)
        self.assertGreaterEqual(stats.blocked, 1)
        for name in ('one', 'gate'):
            self.assertEqual((self.root / name).read_bytes(), name.encode())
            self.assertEqual(self.state(name), 'completed')
        self.assertEqual(self.state('held'), 'queued')  # never claimed
        self.assertFalse((self.root / 'held').exists())
        db = sqlite3.connect(self.db)
        rows = db.execute('SELECT generation FROM jobs ORDER BY rowid'
                          ).fetchall()
        db.close()
        self.assertEqual(rows, [(1,), (1,), (0,)])  # 'held' never claimed
        for group in self.groups():
            self.assertRaises(ProcessLookupError, os.killpg, group, 0)


if __name__ == '__main__':
    unittest.main()
