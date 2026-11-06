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
import threading
import unittest
from types import SimpleNamespace
from unittest import mock

import host_queue
import host_queue_wait

SCRIPT = Path(__file__).with_name('host_queue_wait.py')
PAYLOAD = b'secret-payload-\x00\x01marker'


class FakeClock:
    """Injected monotonic clock; sleep advances it so deadline arithmetic is exact."""

    def __init__(self, on_sleep=None):
        self.now = 0.0
        self.sleeps = []
        self.on_sleep = on_sleep

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds
        if self.on_sleep:
            self.on_sleep(self)


class WaitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = str(self.root / 'queue.sqlite')
        self.payload = self.root / 'payload'
        self.payload.write_bytes(PAYLOAD)
        self.call(action='enqueue', job='job-1', payload=str(self.payload))

    def call(self, **fields):
        return host_queue.run(SimpleNamespace(db=self.db, **fields))

    def worker_complete(self):
        claim = self.call(action='claim', host='fake-mac', ttl=300)['claim']
        receipt = self.root / 'receipt.json'
        receipt.write_text(json.dumps({k: claim[k] for k in ('job', 'host', 'token', 'generation')}))
        self.call(action='complete', receipt=str(receipt))
        return claim

    def rows(self):
        db = sqlite3.connect(self.db)
        try:
            return db.execute('SELECT job, state, generation FROM jobs ORDER BY job').fetchall()
        finally:
            db.close()

    def wait(self, sleep_hook=None, deadline=10.0, interval=1.0):
        fake = FakeClock(sleep_hook)
        code, result = host_queue_wait.wait(self.db, 'job-1', deadline, interval,
                                            clock=fake.clock, sleep=fake.sleep)
        return code, result, fake

    def test_fake_worker_completion_succeeds(self):
        code, result, fake = self.wait(sleep_hook=lambda clock: self.worker_complete() if clock.now >= 2 else None)
        self.assertEqual(code, host_queue_wait.COMPLETED)
        self.assertEqual(result, {'state': 'completed', 'generation': 1, 'polls': 3, 'reason': 'completed'})
        self.assertEqual(fake.sleeps, [1.0, 1.0])

    def test_queued_job_times_out_at_monotonic_deadline(self):
        code, result, fake = self.wait(deadline=1.0, interval=0.25)
        self.assertEqual(code, host_queue_wait.DEADLINE)
        self.assertEqual(result['state'], 'queued')
        self.assertEqual(result['polls'], 5)
        self.assertEqual(fake.now, 1.0)
        self.assertEqual(self.rows(), [('job-1', 'queued', 0)])

    def test_last_sleep_is_clipped_to_deadline(self):
        code, result, fake = self.wait(deadline=2.5, interval=1.0)
        self.assertEqual(code, host_queue_wait.DEADLINE)
        self.assertEqual(fake.sleeps, [1.0, 1.0, 0.5])

    def test_claimed_then_expired_is_uncertain_and_never_recovered(self):
        self.call(action='claim', host='fake-mac', ttl=300)
        db = sqlite3.connect(self.db)
        self.addCleanup(db.close)
        # Lease lapse without a renew: status itself marks the expired claim uncertain.
        db.execute("UPDATE jobs SET expires=0 WHERE job='job-1'")
        db.commit()

        code, result, _ = self.wait()
        self.assertEqual(code, host_queue_wait.UNCERTAIN)
        self.assertEqual(result, {'state': 'uncertain', 'generation': 1, 'polls': 1,
                                  'reason': host_queue_wait.REASONS[host_queue_wait.UNCERTAIN]})
        self.assertEqual(self.rows(), [('job-1', 'uncertain', 1)])
        self.assertIsNone(self.call(action='claim', host='fake-mac', ttl=300)['claim'])
        self.assertEqual(db.execute('SELECT COUNT(*) FROM recoveries').fetchone()[0], 0)

    def test_claimed_lease_expiring_mid_wait_stops_polling(self):
        self.call(action='claim', host='fake-mac', ttl=300)
        db = sqlite3.connect(self.db)
        self.addCleanup(db.close)

        def lapse(clock):
            if clock.now >= 2:
                db.execute("UPDATE jobs SET expires=0 WHERE job='job-1'")
                db.commit()

        code, result, fake = self.wait(sleep_hook=lapse, deadline=60.0, interval=1.0)
        self.assertEqual(code, host_queue_wait.UNCERTAIN)
        self.assertEqual(result['polls'], 3)
        self.assertEqual(len(fake.sleeps), 2)

    def test_missing_job_fails_without_creating_work(self):
        fake = FakeClock()
        code, result = host_queue_wait.wait(self.db, 'absent', 10.0, 1.0, clock=fake.clock, sleep=fake.sleep)
        self.assertEqual(code, host_queue_wait.MISSING)
        self.assertEqual(result, {'state': None, 'polls': 1, 'reason': 'job not found'})
        self.assertEqual(fake.sleeps, [])
        self.assertEqual([row[0] for row in self.rows()], ['job-1'])

    def test_malformed_coordinator_response_is_rejected(self):
        for response in ({'ok': True, 'state': 'bogus', 'generation': 0},
                         {'ok': True, 'state': 'queued', 'generation': True},
                         {'ok': False, 'error': 'secret internal detail'},
                         ['not', 'a', 'dict']):
            with self.subTest(response=response), mock.patch.object(host_queue, 'run', return_value=response):
                code, result, fake = self.wait()
                self.assertEqual(code, host_queue_wait.MALFORMED)
                self.assertEqual(result['reason'], 'malformed coordinator response')
                self.assertNotIn('secret', json.dumps(result))
                self.assertEqual(fake.sleeps, [])

    def test_inaccessible_coordinator_exits_without_polling_again(self):
        with mock.patch.object(host_queue, 'run', side_effect=sqlite3.OperationalError('unable to open')):
            code, result, fake = self.wait()
        self.assertEqual(code, host_queue_wait.INACCESSIBLE)
        self.assertEqual(result, {'state': None, 'polls': 1, 'reason': 'coordinator inaccessible'})
        self.assertEqual(fake.sleeps, [])

    def test_cancellation_stops_polling_with_signal_code(self):
        fake = FakeClock(lambda clock: host_queue_wait.cancel(signal.SIGTERM, None))
        code, result = host_queue_wait.wait(self.db, 'job-1', 60.0, 1.0, clock=fake.clock, sleep=fake.sleep)
        self.assertEqual(code, 128 + signal.SIGTERM)
        self.assertEqual(result, {'state': 'queued', 'generation': 0, 'polls': 1, 'reason': 'cancelled by signal'})
        self.assertEqual(len(fake.sleeps), 1)

    def test_argument_bounds_reject_non_finite_and_out_of_range(self):
        base = ['--db', self.db, '--job', 'job-1']
        for extra in (['--deadline', 'nan', '--interval', '1'], ['--deadline', 'inf', '--interval', '1'],
                      ['--deadline', '0', '--interval', '1'], ['--deadline', '86401', '--interval', '1'],
                      ['--deadline', '5', '--interval', '0.05'], ['--deadline', '5', '--interval', 'inf'],
                      ['--deadline', '5', '--interval', '1', '--job', 'bad job!']):
            with self.subTest(extra=extra), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    host_queue_wait.main(base + extra)
                self.assertEqual(raised.exception.code, 2)


class CliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = str(self.root / 'queue.sqlite')
        self.payload = self.root / 'payload'
        self.payload.write_bytes(PAYLOAD)
        self.env = dict(os.environ, HOME=str(self.root))

    def invoke(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), '--db', self.db, *args], env=self.env,
                              capture_output=True, text=True, timeout=30)

    def test_completed_job_prints_one_small_json_result_without_payload_or_token(self):
        host_queue.run(SimpleNamespace(action='enqueue', db=self.db, job='job-1', payload=str(self.payload)))
        claim = host_queue.run(SimpleNamespace(action='claim', db=self.db, host='fake-mac', ttl=300))['claim']
        receipt = self.root / 'receipt.json'
        receipt.write_text(json.dumps({k: claim[k] for k in ('job', 'host', 'token', 'generation')}))
        host_queue.run(SimpleNamespace(action='complete', db=self.db, receipt=str(receipt)))

        proc = self.invoke('--job', 'job-1', '--deadline', '5', '--interval', '0.1')
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.count('\n'), 1)
        result = json.loads(proc.stdout)
        self.assertEqual(result, {'state': 'completed', 'generation': 1, 'polls': 1, 'reason': 'completed'})
        self.assertNotIn(claim['token'], proc.stdout)
        self.assertNotIn('secret-payload', proc.stdout)
        self.assertNotIn('payload', proc.stdout)

    def test_main_reports_missing_database_without_creating_it(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = host_queue_wait.main(['--db', self.db, '--job', 'job-1', '--deadline', '5', '--interval', '0.1'])
        self.assertEqual(code, host_queue_wait.INACCESSIBLE)
        self.assertEqual(json.loads(out.getvalue())['reason'], 'coordinator inaccessible')
        self.assertFalse(os.path.exists(self.db))

    def test_main_queued_deadline_exits_with_distinct_code(self):
        host_queue.run(SimpleNamespace(action='enqueue', db=self.db, job='job-1', payload=str(self.payload)))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = host_queue_wait.main(['--db', self.db, '--job', 'job-1', '--deadline', '0.3', '--interval', '0.1'])
        self.assertEqual(code, host_queue_wait.DEADLINE)
        self.assertEqual(json.loads(out.getvalue())['state'], 'queued')

    def test_sigterm_during_wait_stops_polling_with_signal_code(self):
        host_queue.run(SimpleNamespace(action='enqueue', db=self.db, job='job-1', payload=str(self.payload)))
        polling = threading.Event()
        real_run = host_queue.run

        def announce(*args, **kwargs):
            # Only after the first status call: main() has installed its handlers by then.
            polling.set()
            return real_run(*args, **kwargs)

        def send():
            polling.wait(10)
            os.kill(os.getpid(), signal.SIGTERM)

        sender = threading.Thread(target=send)
        sender.start()
        out = io.StringIO()
        with mock.patch.object(host_queue, 'run', side_effect=announce), contextlib.redirect_stdout(out):
            code = host_queue_wait.main(['--db', self.db, '--job', 'job-1', '--deadline', '60', '--interval', '0.1'])
        sender.join(10)
        self.assertEqual(code, 128 + signal.SIGTERM)
        result = json.loads(out.getvalue())
        # The signal may land before the first status completes, so no state is known yet.
        self.assertIn(result['state'], (None, 'queued'))
        self.assertEqual(result['reason'], 'cancelled by signal')
        self.assertIs(signal.getsignal(signal.SIGTERM), signal.SIG_DFL)

if __name__ == '__main__':
    unittest.main()
