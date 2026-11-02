import contextlib
import io
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import host_queue  # noqa: E402
import host_queue_stdio  # noqa: E402
import remote_queue_submit as submit  # noqa: E402
import remote_queue_wait as rw  # noqa: E402

SCRIPT, STDIO = HERE / 'remote_queue_wait.py', HERE / 'host_queue_stdio.py'
JOB, SENTINEL = 'RQ-PHX-FAKE1', 'SENTINEL-REPLY-TEXT'


class FakeClock:
    def __init__(self):
        self.now, self.sleeps = 0.0, []

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class WaitLoopTests(unittest.TestCase):
    """wait() with injected clock/exchange plus the real local stdio transport."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = str(self.root / 'queue.sqlite')
        self.argv = [sys.executable, str(STDIO), '--db', self.db]

    def call(self, **fields):
        return host_queue.run(SimpleNamespace(db=self.db, **fields))

    def wait(self, job=JOB, deadline=10.0, interval=1.0, **deps):
        return rw.wait(list(self.argv), job, deadline, interval, **deps)

    def test_queued_claimed_completed_then_uncertain_over_real_stdio(self):
        (self.root / 'payload').write_bytes(b'payload-bytes')
        self.call(action='enqueue', job=JOB, payload=str(self.root / 'payload'))
        receipt, steps = self.root / 'receipt.json', []

        def hook(_seconds):
            steps.append(1)
            if len(steps) == 1:
                claim = self.call(action='claim', host='fake-mac', ttl=300)['claim']
                receipt.write_text(json.dumps(
                    {k: claim[k] for k in host_queue_stdio.RECEIPT_KEYS}))
            else:
                self.call(action='complete', receipt=str(receipt))

        code, result = self.wait(deadline=30.0, interval=0.01, sleep=hook)
        self.assertEqual((code, result), (0, {'state': 'completed', 'generation': 1,
                                              'polls': 3, 'reason': 'completed'}))
        with sqlite3.connect(self.db) as db:
            db.execute("UPDATE jobs SET state='claimed', expires=0 WHERE job=?", (JOB,))
        code, result = self.wait(deadline=30.0, interval=0.01)
        self.assertEqual((code, result['state'], result['polls']), (4, 'uncertain', 1))

    def test_status_only_requests_and_shrinking_budgets(self):
        fake, calls = FakeClock(), []
        replies = iter(({'ok': True, 'state': s, 'generation': g} for s, g in
                        (('queued', 0), ('claimed', 1), ('completed', 1))))

        def exchange(_argv, request, timeout):
            calls.append((json.loads(request), timeout))
            fake.now += 2.0  # transport time counts against the same deadline
            return next(replies)

        code, result = self.wait(clock=fake.clock, sleep=fake.sleep, exchange=exchange)
        self.assertEqual((code, result['polls']), (0, 3))
        self.assertEqual([req for req, _ in calls],
                         [{'action': 'status', 'job': JOB}] * 3)
        self.assertEqual([budget for _, budget in calls], [10.0, 7.0, 4.0])

    def test_failures_and_bad_replies_map_to_distinct_codes(self):
        def boom(text):
            def exchange(_a, _r, _t):
                raise submit.SubmitError(text)
            return exchange
        cases = [(boom(t), w) for t, w in
                 [('request timed out', 3), ('transport failed to start', 6),
                  ('transport or coordinator failed', 6), ('transport failed', 6),
                  ('response exceeds limit', 7), ('invalid response', 7)]]
        cases += [(lambda *a, reply=reply: reply, want) for reply, want in
                  [({'ok': False, 'error': 'job not found'}, 5),
                   ({'ok': False, 'error': SENTINEL}, 7),
                   ({'ok': True, 'state': 'withdrawn', 'generation': 0}, 7),
                   ({'ok': True, 'state': 'queued', 'generation': True}, 7)]]
        for exchange, want in cases:
            with self.subTest(want=want):
                code, result = self.wait(exchange=exchange)
                self.assertEqual((code, result['reason'], result['polls']),
                                 (want, rw.REASONS[want], 1))
                self.assertNotIn(SENTINEL, json.dumps(result))


class CliTests(unittest.TestCase):
    """The real CLI entry against fake transports and the real stdio server."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = str(self.root / 'queue.sqlite')
        self.argvf = self.root / 'coord.json'
        self.argvf.write_text(json.dumps([sys.executable, str(STDIO), '--db', self.db]))
        self.env = dict(os.environ, HOME=str(self.root))

    def invoke(self, argvf, *extra, timeout=60):
        return subprocess.run([sys.executable, str(SCRIPT), '--coordinator-argv',
                               str(argvf), '--job', JOB, *extra], env=self.env,
                              capture_output=True, text=True, timeout=timeout)

    def test_missing_job_reports_five(self):
        proc = self.invoke(self.argvf, '--deadline', '5', '--interval', '0.1')
        self.assertEqual((proc.returncode, json.loads(proc.stdout)),
                         (5, {'state': None, 'polls': 1, 'reason': 'job not found'}))

    def test_fake_transports_have_distinct_codes_and_no_leaks(self):
        big = host_queue_stdio.MAX_RESPONSE + 2
        cases = [('exit1', 'import sys;sys.exit(1)', 6),
                 ('garbage', f'print("not json {SENTINEL}")', 7),
                 ('oversize', f'import sys;sys.stdout.write("x"*{big})', 7)]
        for name, code, want in cases:
            with self.subTest(name=name):
                path = self.root / (name + '.json')
                path.write_text(json.dumps([sys.executable, '-c', code]))
                proc = self.invoke(path, '--deadline', '5', '--interval', '0.1')
                self.assertEqual(proc.returncode, want, proc.stderr + proc.stdout)
                self.assertNotIn(SENTINEL, proc.stdout + proc.stderr)

    def test_deadline_exhausted_inside_an_exchange(self):
        path = self.root / 'sleep.json'
        path.write_text(json.dumps([sys.executable, '-c', 'import time;time.sleep(60)']))
        proc = self.invoke(path, '--deadline', '1', '--interval', '0.1')
        self.assertEqual((proc.returncode, json.loads(proc.stdout)['reason']),
                         (3, 'deadline exceeded before completion'))

    def test_sigterm_kills_the_active_transport_group(self):
        marker = self.root / 'transport.pid'
        code = ('import os,subprocess,sys,time;'
                f'open({str(marker)!r},"w").write(str(os.getpid()));'
                'subprocess.Popen([sys.executable,"-c","import time;time.sleep(300)"]);'
                'time.sleep(300)')
        argvf = self.root / 'spawn.json'
        argvf.write_text(json.dumps([sys.executable, '-c', code]))
        proc = subprocess.Popen([sys.executable, str(SCRIPT), '--coordinator-argv',
                                 str(argvf), '--job', JOB, '--deadline', '300',
                                 '--interval', '1'], stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, env=self.env)
        try:
            end = time.monotonic() + 20
            while not marker.exists() and time.monotonic() < end:
                self.assertIsNone(proc.poll())
                time.sleep(0.05)
            self.assertTrue(marker.exists(), 'transport never started')
            pgid = int(marker.read_text())
            proc.send_signal(signal.SIGTERM)
            out, _ = proc.communicate(timeout=20)
            self.assertEqual(proc.returncode, 128 + signal.SIGTERM)
            self.assertEqual(json.loads(out)['reason'], 'cancelled by signal')
            end = time.monotonic() + 5
            while time.monotonic() < end:
                try:
                    os.killpg(pgid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.05)
            else:
                self.fail('transport group survived')
        finally:
            proc.kill()
            proc.stdout.close()
            proc.stderr.close()

    def test_argument_bounds_and_handler_restore(self):
        base = ['--coordinator-argv', str(self.argvf), '--job', JOB]
        for extra in (['--deadline', 'nan', '--interval', '1'],
                      ['--deadline', '0', '--interval', '1'],
                      ['--job', 'bad job!', '--deadline', '5', '--interval', '1']):
            with self.subTest(extra=extra), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    rw.main(base + extra)
                self.assertEqual(raised.exception.code, 2)
        sigint, sigterm = signal.getsignal(signal.SIGINT), signal.getsignal(signal.SIGTERM)
        with mock.patch.object(submit, 'exchange', return_value={
                'ok': True, 'state': 'completed', 'generation': 0}):
            out = io.StringIO()
            code = rw.main(base + ['--deadline', '5', '--interval', '1'], out=out)
        self.assertEqual((code, signal.getsignal(signal.SIGINT),
                          signal.getsignal(signal.SIGTERM)), (0, sigint, sigterm))


if __name__ == '__main__':
    unittest.main()
