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
from types import SimpleNamespace

import host_queue

REMOTE = str(Path(__file__).with_name('remote_queue_worker.py'))
STDIO = str(Path(__file__).with_name('host_queue_stdio.py'))
PAYLOAD = b'opaque payload bytes\x00\xff\x80'
SUBTREE = ("import pathlib,subprocess,sys,time; subprocess.Popen([sys.executable,'-c',"
           "sys.argv[3],sys.argv[2]]); pathlib.Path(sys.argv[1]).touch(); time.sleep(30)")
GRANDCHILD = ("import pathlib,sys,time; p=pathlib.Path(sys.argv[1]); "
              "exec('while True:\\n p.write_text(str(time.monotonic()))\\n time.sleep(.03)')")
# Transport: log each request ('Q ') and response ('A ') to argv[1]; proxy to stdio.
PROXY = ("import subprocess,sys\n"
         "raw=sys.stdin.buffer.read(100*1024)\n"
         "open(sys.argv[1],'ab').write(b'Q '+raw+b'\\n')\n"
         "out=subprocess.run([sys.executable,sys.argv[2],'--db',sys.argv[3]],input=raw,"
         "capture_output=True,timeout=30)\n"
         "open(sys.argv[1],'ab').write(b'A '+out.stdout+b'\\n')\n"
         "sys.stdout.buffer.write(out.stdout)\n"
         "sys.exit(out.returncode)\n")
# Transport: heartbeat forever on renew; proxy everything else to stdio.
BLOCKER = ("import json,pathlib,subprocess,sys,time\n"
           "raw=sys.stdin.buffer.read(100*1024)\n"
           "try: action=json.loads(raw).get('action')\n"
           "except Exception: action=None\n"
           "if action=='renew':\n"
           " p=pathlib.Path(sys.argv[1])\n"
           " while True: p.write_text(str(time.monotonic())); time.sleep(.03)\n"
           "out=subprocess.run([sys.executable,sys.argv[2],'--db',sys.argv[3]],input=raw,"
           "capture_output=True,timeout=30)\n"
           "sys.stdout.buffer.write(out.stdout)\n"
           "sys.exit(out.returncode)\n")
# Transport: reply with canned bytes from file argv[1] and exit code argv[2].
RESPONDER = ("import sys\n"
             "sys.stdin.buffer.read(100*1024)\n"
             "sys.stdout.buffer.write(open(sys.argv[1],'rb').read())\n"
             "sys.exit(int(sys.argv[2]))\n")
MARK = "import pathlib,sys; pathlib.Path(sys.argv[1]).touch()"


class RemoteWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.cleanup_processes)
        self.root = Path(self.temp.name)
        self.db = str(self.root / 'queue.db')
        self.argv_file = self.root / 'coordinator.json'
        self.processes = []

    def cleanup_processes(self):
        for proc in self.processes:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)

    def transport(self, *argv):
        self.argv_file.write_text(json.dumps([*map(str, argv)]))

    def stdio(self):
        self.transport(sys.executable, STDIO, '--db', self.db)

    def enqueue(self, job, payload):
        path = self.root / ('payload-' + job)
        path.write_bytes(payload)
        result = host_queue.run(SimpleNamespace(db=self.db, action='enqueue',
                                                job=job, payload=str(path)))
        self.assertTrue(result['ok'])

    def state(self, job):
        return host_queue.run(SimpleNamespace(db=self.db, action='status', job=job))['state']

    def worker(self, host, command, lease=5, runtime=30, timeout=10):
        argv = [sys.executable, REMOTE, '--host', host, '--lease', str(lease),
                '--runtime', str(runtime), '--request-timeout', str(timeout),
                '--coordinator-argv', str(self.argv_file), '--', *command]
        proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.processes.append(proc)
        return proc

    def finish(self, proc, expected=0):
        out, err = proc.communicate(timeout=45)
        self.assertEqual(proc.returncode, expected, (out, err))
        self.assertEqual(err, b'')
        return out

    def wait_file(self, path):
        end = time.monotonic() + 15
        while not path.exists():
            if time.monotonic() > end:
                self.fail('child did not start')
            time.sleep(0.02)

    def beats_stopped(self, path):
        self.assertTrue(path.exists())
        time.sleep(.1)
        last = path.read_bytes()
        time.sleep(.3)
        self.assertEqual(path.read_bytes(), last)

    def subtree(self, marker, beats):
        return [sys.executable, '-c', SUBTREE, str(marker), str(beats), GRANDCHILD]

    def subtree_worker(self, lease=10, runtime=60, timeout=10):
        self.enqueue('slow', b'work')
        marker, beats = self.root / 'started', self.root / 'beats'
        proc = self.worker('mac2', self.subtree(marker, beats),
                           lease=lease, runtime=runtime, timeout=timeout)
        self.wait_file(marker)
        self.wait_file(beats)
        return proc, beats

    def test_enqueue_claim_stdin_renew_complete_success(self):
        log = self.root / 'requests.jsonl'
        self.transport(sys.executable, '-c', PROXY, log, STDIO, self.db)
        self.enqueue('one', PAYLOAD)
        result = self.root / 'result'
        code = ("import sys,pathlib,time; d=sys.stdin.buffer.read(); time.sleep(2.6); "
                "pathlib.Path(sys.argv[1]).write_bytes(d)")
        out = self.finish(self.worker('mac2', [sys.executable, '-c', code, str(result)],
                                      lease=10, runtime=20))
        self.assertEqual(out, b'remote outcome=success host=mac2 job=one\n')
        self.assertEqual(result.read_bytes(), PAYLOAD)
        self.assertEqual(self.state('one'), 'completed')
        lines = log.read_bytes().splitlines()
        requests = [json.loads(l[2:]) for l in lines if l.startswith(b'Q ')]
        responses = [json.loads(l[2:]) for l in lines if l.startswith(b'A ')]
        self.assertEqual(len(requests), len(responses))
        actions = [r['action'] for r in requests]
        self.assertEqual((actions[0], actions[-1]), ('claim', 'complete'))
        renew_at = next(i for i, r in enumerate(requests) if r['action'] == 'renew')
        self.assertTrue(responses[renew_at]['ok'])
        # The renewal really extended the coordinator's expiry.
        self.assertGreater(responses[renew_at]['expires'],
                           responses[0]['claim']['expires'])
        token = requests[renew_at]['receipt']['token']
        self.assertRegex(token, r'[0-9a-f]{64}\Z')
        # Receipt tokens and payload bytes never appear in worker output.
        self.assertNotIn(token.encode(), out)
        self.assertNotIn(PAYLOAD, out)
        for request in requests:
            self.assertLessEqual(len(json.dumps(request)), 96 * 1024)

    def test_empty_queue_never_launches(self):
        self.stdio()
        marker = self.root / 'unexpected'
        out = self.finish(self.worker('mac2', [sys.executable, '-c', MARK, str(marker)]))
        self.assertEqual(out, b'remote outcome=empty host=mac2\n')
        self.assertFalse(marker.exists())

    def test_child_failure_is_never_completed(self):
        self.stdio()
        self.enqueue('fail', b'work')
        out = self.finish(self.worker('mac2', [sys.executable, '-c', 'raise SystemExit(3)'],
                                      lease=10), expected=1)
        self.assertEqual(out, b'remote outcome=worker failed host=mac2 job=fail\n')
        self.assertEqual(self.state('fail'), 'claimed')
        with sqlite3.connect(self.db) as db:
            db.execute("UPDATE jobs SET expires=0 WHERE job='fail'")
        self.assertEqual(self.state('fail'), 'uncertain')
        out = self.finish(self.worker('mac3', [sys.executable, '-c', 'pass']))
        self.assertEqual(out, b'remote outcome=empty host=mac3\n')

    def test_blocked_renew_kills_worker_and_transport_subtrees(self):
        trans_beats = self.root / 'transport-beats'
        self.transport(sys.executable, '-c', BLOCKER, trans_beats, STDIO, self.db)
        proc, beats = self.subtree_worker(lease=12, runtime=30, timeout=6)
        out = self.finish(proc, expected=1)
        self.assertEqual(out, b'remote outcome=lease lost host=mac2 job=slow\n')
        self.assertNotEqual(self.state('slow'), 'completed')
        self.beats_stopped(beats)         # worker descendants killed
        self.beats_stopped(trans_beats)   # blocked transport group killed
        with sqlite3.connect(self.db) as db:
            db.execute("UPDATE jobs SET expires=0 WHERE job='slow'")
        self.assertEqual(self.state('slow'), 'uncertain')

    def test_malformed_and_oversized_responses_never_launch(self):
        self.enqueue('one', b'work')
        marker = self.root / 'unexpected'
        claim = {'job': 'one', 'host': 'mac2', 'token': 'a' * 64, 'generation': 1,
                 'expires': time.time() + 60,
                 'payload_base64': base64.b64encode(b'x').decode()}

        def body(c):
            return json.dumps({'ok': True, 'claim': c}).encode()
        cases = [
            (b'not json', 'claim uncertain', 0),
            (b'{"ok":false,"error":"x"}', 'claim failed', 0),
            (b'{"ok":true,"claim":null}', 'empty', 0),
            (b'x' * (96 * 1024 + 1), 'claim uncertain', 0),
            (body(claim), 'claim uncertain', 1),              # nonzero exit after ok
            (body(dict(claim, host='mac9')), 'claim uncertain', 0),
            (body(dict(claim, token='z' * 64)), 'claim uncertain', 0),
            (body(dict(claim, payload_base64='%%%')), 'claim unusable', 0),
        ]
        for response, outcome, rc in cases:
            with self.subTest(outcome=outcome, rc=rc):
                canned = self.root / ('response-%d' % time.monotonic_ns())
                canned.write_bytes(response)
                self.transport(sys.executable, '-c', RESPONDER, canned, rc)
                out = self.finish(self.worker('mac2', [sys.executable, '-c', MARK,
                                                       str(marker)], lease=2, timeout=3),
                                  expected=0 if outcome == 'empty' else 1)
                line = 'remote outcome=%s host=mac2' % outcome
                if outcome == 'claim unusable':
                    line += ' job=one'
                self.assertEqual(out, (line + '\n').encode())
                self.assertFalse(marker.exists())
                self.assertEqual(self.state('one'), 'queued')

    def test_two_hosts_one_job_executes_once(self):
        self.stdio()
        self.enqueue('one', b'payload-line')
        counter = self.root / 'runs'
        code = "import sys; d=sys.stdin.buffer.read(); open(sys.argv[1],'ab').write(d+b'\\n')"
        a = self.worker('mac2', [sys.executable, '-c', code, str(counter)], lease=8)
        b = self.worker('mac3', [sys.executable, '-c', code, str(counter)], lease=8)
        outa, outb = self.finish(a), self.finish(b)
        self.assertEqual(counter.read_bytes().splitlines(), [b'payload-line'])
        lines = [outa.decode().strip(), outb.decode().strip()]
        self.assertEqual(len([l for l in lines if 'outcome=empty' in l]), 1)
        wins = [l for l in lines if 'outcome=success' in l and 'job=one' in l]
        self.assertEqual(len(wins), 1)
        self.assertEqual(sorted(l.split('host=')[1].split()[0] for l in lines),
                         ['mac2', 'mac3'])
        self.assertEqual(self.state('one'), 'completed')
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute('SELECT generation FROM jobs').fetchall(), [(1,)])

    def test_sigterm_cleans_worker_subtree(self):
        self.stdio()
        proc, beats = self.subtree_worker(lease=10, runtime=60)
        proc.send_signal(signal.SIGTERM)
        out = self.finish(proc, expected=1)
        self.assertEqual(out, b'remote outcome=interrupted host=mac2 job=slow\n')
        self.assertNotEqual(self.state('slow'), 'completed')
        self.beats_stopped(beats)

    def test_bad_coordinator_argv_is_usage_error(self):
        marker = self.root / 'unexpected'
        cases = ['{"not":"array"}', '[]', json.dumps(['x'] * 65)]
        for data in cases:
            with self.subTest(data=data):
                self.argv_file.write_text(data)
                proc = self.worker('mac2', [sys.executable, '-c', MARK, str(marker)])
                out, _ = proc.communicate(timeout=15)
                self.assertEqual((proc.returncode, out, marker.exists()), (2, b'', False))
        self.argv_file = self.root / 'missing.json'
        proc = self.worker('mac2', [sys.executable, '-c', MARK, str(marker)])
        out, _ = proc.communicate(timeout=15)
        self.assertEqual((proc.returncode, out, marker.exists()), (2, b'', False))


if __name__ == '__main__':
    unittest.main()
