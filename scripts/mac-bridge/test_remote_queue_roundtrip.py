import base64
import json
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import remote_queue_roundtrip as rt  # noqa: E402
import remote_queue_submit as submit  # noqa: E402

SCRIPT = HERE / 'remote_queue_roundtrip.py'
STDIO = HERE / 'host_queue_stdio.py'
HEADER = b'#job repo=phantom lane=codex-personal tier=work\n\n'
DROP = 'RQ-PHX-ABC'
SECRET = 'PRIVATE-PROMPT-MARKER'

# Fake coordinator: logs each action name, then relays the request unchanged to
# the real host_queue_stdio over a temporary SQLite. "complete" marks the job
# completed on the first status so the observation terminates.
WRAPPER = '''
import json, sqlite3, subprocess, sys
db, log, stdio, mode = sys.argv[1:5]
data = sys.stdin.buffer.read()
action = json.loads(data)['action']
with open(log, 'a') as handle:
    handle.write(action + '\\n')
if action == 'status' and mode == 'complete':
    with sqlite3.connect(db) as conn:
        conn.execute("UPDATE jobs SET state='completed'")
result = subprocess.run([sys.executable, stdio, '--db', db], input=data,
                        capture_output=True)
sys.stdout.buffer.write(result.stdout)
sys.exit(result.returncode)
'''


class RemoteRoundtripTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.drop = self.root / 'drop'
        self.drop.mkdir()
        self.db = self.root / 'queue.sqlite'
        self.log = self.root / 'actions.log'
        self.wrapper = self.root / 'wrapper.py'
        self.wrapper.write_text(WRAPPER)

    def file(self, data=HEADER + b'Harmless prompt\n'):
        path = self.drop / (DROP + '.md')
        path.write_bytes(data)
        return path

    def argv_file(self, name, argv):
        path = self.root / name
        path.write_text(json.dumps(argv))
        return path

    def fake(self, mode='queued'):
        argv = [sys.executable, str(self.wrapper), str(self.db), str(self.log),
                str(STDIO), mode]
        return self.argv_file(f'fake-{mode}.json', argv)

    def actions(self):
        return self.log.read_text().split() if self.log.exists() else []

    def command(self, argv_path, *extra, job=DROP, deadline='20', interval='0.1'):
        return [sys.executable, str(SCRIPT), '--drop-dir', str(self.drop),
                '--job', job, '--coordinator-argv', str(argv_path),
                '--deadline', deadline, '--interval', interval, *extra]

    def call(self, argv_path, *extra, code=0, **kwargs):
        proc = subprocess.run(self.command(argv_path, *extra, **kwargs),
                              capture_output=True, text=True, timeout=90)
        self.assertEqual(proc.returncode, code, proc.stderr + proc.stdout)
        self.assertEqual(len(proc.stdout.splitlines()), 1, proc.stdout)
        return json.loads(proc.stdout), proc

    def rows(self):
        with sqlite3.connect(self.db) as db:
            return db.execute('SELECT job, payload FROM jobs ORDER BY job').fetchall()

    def test_preview_validates_and_spawns_nothing(self):
        data = HEADER + SECRET.encode()
        source = self.file(data=data)
        before = source.stat().st_mtime_ns
        result, proc = self.call(self.fake())
        self.assertEqual((result['ok'], result['phase'], result['state']),
                         (True, 'validate', 'preview'))
        self.assertEqual(self.actions(), [])
        self.assertFalse(self.db.exists())
        self.assertNotIn(SECRET, proc.stdout + proc.stderr)
        self.assertEqual((source.read_bytes(), source.stat().st_mtime_ns), (data, before))
        bad = subprocess.run(self.command(self.fake(), job='RQ-PHX-AB'),
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(bad.returncode, 1)  # submit's job grammar, before any exchange
        self.assertIn('"state":"invalid"', bad.stdout)
        self.assertEqual(self.actions(), [])
        self.assertFalse(self.db.exists())

    def test_happy_path_enqueues_once_then_observes_completed(self):
        data = HEADER + SECRET.encode()
        source = self.file(data=data)
        result, proc = self.call(self.fake('complete'), '--apply')
        self.assertEqual({k: result[k] for k in ('ok', 'phase', 'state', 'exit')},
                         {'ok': True, 'phase': 'wait', 'state': 'completed', 'exit': 0})
        self.assertEqual(self.actions(), ['enqueue', 'status'])
        self.assertEqual(self.rows(), [(DROP, data)])
        self.assertEqual(source.read_bytes(), data)
        combined = proc.stdout + proc.stderr
        self.assertNotIn(SECRET, combined)
        self.assertNotIn(base64.b64encode(data).decode(), combined)
        self.assertEqual(set(result) - {'tool', 'ok', 'apply', 'job', 'exit', 'phase',
                                        'state', 'reason', 'polls', 'generation'}, set())

    def test_existing_unverified_exits_nonzero_with_zero_status_requests(self):
        first = HEADER + b'first harmless prompt'
        seeded = subprocess.run([sys.executable, str(STDIO), '--db', str(self.db)],
                                input=json.dumps({'action': 'enqueue', 'job': DROP,
                                                  'payload_base64': base64.b64encode(first)
                                                  .decode('ascii')}).encode(),
                                capture_output=True, timeout=60)
        self.assertEqual(seeded.returncode, 0)
        source = self.file(data=HEADER + b'second harmless prompt')
        result, _ = self.call(self.fake('complete'), '--apply', code=2)
        self.assertEqual({k: result[k] for k in ('ok', 'phase', 'state', 'exit')},
                         {'ok': False, 'phase': 'submit',
                          'state': 'existing-unverified', 'exit': 2})
        self.assertEqual(self.actions(), ['enqueue'])
        self.assertEqual(self.rows(), [(DROP, first)])
        self.assertEqual(source.read_bytes(), HEADER + b'second harmless prompt')

    def test_submit_rejection_prevents_wait(self):
        self.file()
        code = ('import json,sys;'
                f'open({str(self.log)!r},"a").write("enqueue\\n");'
                'print(json.dumps({"ok":False,"error":"weird"}))')
        argvf = self.argv_file('reject.json', [sys.executable, '-c', code])
        result, proc = self.call(argvf, '--apply', code=1)
        self.assertEqual((result['phase'], result['state'], result['reason']),
                         ('submit', 'rejected', 'request rejected'))
        self.assertEqual(self.actions(), ['enqueue'])
        self.assertNotIn('weird', proc.stdout + proc.stderr)

    def test_total_deadline_includes_submission_elapsed_time(self):
        self.file()
        clock = FakeClock()
        submit_timeouts, statuses, sleeps = [], [], []

        def slow_submit(program, request, timeout):
            submit_timeouts.append(timeout)
            clock.now += 3.0  # transport time spent inside the enqueue
            return {'ok': True}

        def status(program, request, budget):
            statuses.append(budget)
            clock.now += 0.5
            return {'ok': True, 'state': 'queued', 'generation': 1}

        def fake_sleep(seconds):
            sleeps.append(seconds)
            clock.now += seconds

        args = rt.parse_args(['--drop-dir', str(self.drop), '--job', DROP,
                              '--coordinator-argv', str(self.fake()),
                              '--deadline', '5', '--interval', '1', '--apply'])
        progress = {}
        with mock.patch.object(submit, 'exchange', side_effect=slow_submit):
            code, body = rt.roundtrip(args, progress, clock=clock, sleep=fake_sleep,
                                      status=status)
        self.assertEqual(code, rt.watch.DEADLINE)
        self.assertEqual((body['phase'], body['state'], body['polls']),
                         ('wait', 'queued', 2))
        self.assertEqual(submit_timeouts, [5.0])
        self.assertEqual(statuses, [2.0, 0.5])
        self.assertEqual(sleeps, [1.0])
        self.assertEqual(clock.now, 105.0)  # start 100 + one 5 s total deadline

    def test_cancellation_stops_without_second_enqueue(self):
        self.file()
        proc = subprocess.Popen(self.command(self.fake(), '--apply', interval='30',
                                             deadline='60'),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True)
        try:
            end = time.monotonic() + 30
            while 'status' not in self.actions():
                self.assertIsNone(proc.poll(), 'exited before the wait began')
                self.assertLess(time.monotonic(), end, 'wait never started')
                time.sleep(0.05)
            proc.send_signal(signal.SIGTERM)
            out, _ = proc.communicate(timeout=30)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.communicate()
        self.assertEqual(proc.returncode, 128 + signal.SIGTERM)
        self.assertEqual(len(out.splitlines()), 1, out)
        result = json.loads(out)
        self.assertEqual((result['phase'], result['exit'], result['ok']),
                         ('wait', 143, False))
        self.assertEqual(self.actions().count('enqueue'), 1)
        self.assertEqual(len(self.rows()), 1)


class FakeClock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now


if __name__ == '__main__':
    unittest.main()
