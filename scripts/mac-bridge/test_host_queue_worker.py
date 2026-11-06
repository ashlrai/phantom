import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace

import host_queue

WORKER = str(Path(__file__).with_name('host_queue_worker.py'))


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = str(self.root / 'queue.db')
        self.processes = []
        self.addCleanup(self.cleanup_processes)

    def cleanup_processes(self):
        for proc in self.processes:
            if proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=5)

    def enqueue(self, job, payload):
        path = self.root / ('input-' + job)
        path.write_bytes(payload)
        result = host_queue.run(SimpleNamespace(db=self.db, action='enqueue', job=job, payload=str(path)))
        self.assertTrue(result['ok'])

    def state(self, job):
        return host_queue.run(SimpleNamespace(db=self.db, action='status', job=job))['state']

    def worker(self, host, code, *args, lease=2, runtime=8):
        command = [sys.executable, WORKER, '--db', self.db, '--host', host, '--lease', str(lease),
                   '--runtime', str(runtime), '--', sys.executable, '-c', code, *map(str, args)]
        proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=self.root)
        self.processes.append(proc)
        return proc

    def finish(self, proc, expected=0):
        out, err = proc.communicate(timeout=12)
        self.assertEqual(proc.returncode, expected, (out, err))
        self.assertEqual(err, b'')
        return out

    def wait_file(self, path):
        end = time.monotonic() + 5
        while not path.exists():
            if time.monotonic() > end:
                self.fail('child did not start')
            time.sleep(0.02)

    def test_two_hosts_execute_distinct_jobs_once(self):
        self.enqueue('one', b'alpha')
        self.enqueue('two', b'beta')
        code = "import sys,time,pathlib; d=sys.stdin.buffer.read(); time.sleep(.3); pathlib.Path(sys.argv[1],d.decode()).write_bytes(d)"
        a = self.worker('host-a', code, self.root)
        b = self.worker('host-b', code, self.root)
        self.finish(a)
        self.finish(b)
        self.assertEqual((self.root / 'alpha').read_bytes(), b'alpha')
        self.assertEqual((self.root / 'beta').read_bytes(), b'beta')
        self.assertEqual([self.state(j) for j in ('one', 'two')], ['completed', 'completed'])
        with sqlite3.connect(self.db) as db:
            rows = db.execute('SELECT generation FROM jobs').fetchall()
        self.assertEqual(rows, [(1,), (1,)])

    def test_renewal_prevents_other_host_claim(self):
        self.enqueue('long', b'work')
        marker = self.root / 'started'
        code = "import pathlib,sys,time; pathlib.Path(sys.argv[1]).touch(); time.sleep(2.5)"
        a = self.worker('host-a', code, marker, lease=1)
        self.wait_file(marker)
        time.sleep(1.5)
        b = self.worker('host-b', "raise SystemExit(99)", lease=1)
        self.assertEqual(self.finish(b), b'empty\n')
        self.finish(a)
        self.assertEqual(self.state('long'), 'completed')

    def test_expired_lease_kills_group_and_never_completes(self):
        self.enqueue('lost', b'work')
        marker = self.root / 'started'
        beats = self.root / 'beats'
        grandchild = "import pathlib,sys,time; p=pathlib.Path(sys.argv[1]); exec('while True:\\n p.write_text(str(time.monotonic()))\\n time.sleep(.03)')"
        code = ("import pathlib,subprocess,sys,time; "
                "subprocess.Popen([sys.executable,'-c',sys.argv[3],sys.argv[2]]); "
                "pathlib.Path(sys.argv[1]).touch(); time.sleep(10)")
        proc = self.worker('host-a', code, marker, beats, grandchild, lease=2)
        self.wait_file(marker)
        self.wait_file(beats)
        with sqlite3.connect(self.db) as db:
            db.execute("UPDATE jobs SET expires = 0 WHERE job = 'lost'")
        self.assertEqual(self.finish(proc, 1), b'lease lost\n')
        self.assertEqual(self.state('lost'), 'uncertain')
        time.sleep(.1)
        last = beats.read_bytes()
        time.sleep(.2)
        self.assertEqual(beats.read_bytes(), last)
        self.assertEqual(self.finish(self.worker('host-b', 'raise SystemExit(99)'), 0), b'empty\n')

    def test_failure_and_timeout_remain_uncertain(self):
        for job, code, runtime in [('failure', 'raise SystemExit(3)', 3),
                                   ('timeout', 'import time; time.sleep(5)', 1)]:
            with self.subTest(job=job):
                self.enqueue(job, b'work')
                self.finish(self.worker('host-a', code, lease=1, runtime=runtime), 1)
                time.sleep(1.1)
                self.assertEqual(self.state(job), 'uncertain')
                self.assertEqual(self.finish(self.worker('host-b', 'raise SystemExit(99)')), b'empty\n')

    def test_empty_queue_never_launches(self):
        marker = self.root / 'unexpected'
        code = "import pathlib,sys; pathlib.Path(sys.argv[1]).touch()"
        self.assertEqual(self.finish(self.worker('host-a', code, marker)), b'empty\n')
        self.assertFalse(marker.exists())

    def test_payload_cannot_change_argv_or_cwd_and_output_is_discarded(self):
        malicious = b'$(touch injected); ../../other; --flag\n'
        self.enqueue('opaque', malicious)
        result = self.root / 'result'
        code = ("import json,os,pathlib,sys; data=sys.stdin.buffer.read(); "
                "pathlib.Path(sys.argv[1]).write_text(json.dumps([sys.argv[2:],os.getcwd(),data.decode()])); "
                "sys.stdout.buffer.write(data*10000); sys.stderr.buffer.write(data*10000)")
        self.assertEqual(self.finish(self.worker('host-a', code, result, 'literal')), b'success\n')
        argv, cwd, data = json.loads(result.read_text())
        self.assertEqual((argv, Path(cwd).resolve(), data), (['literal'], self.root.resolve(), malicious.decode()))
        self.assertFalse((self.root / 'injected').exists())

    def test_launch_failure_releases_current_claim(self):
        self.enqueue('launch', b'work')
        proc = subprocess.Popen([sys.executable, WORKER, '--db', self.db, '--host', 'host-a',
                                 '--', str(self.root / 'missing')], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.processes.append(proc)
        self.assertEqual(self.finish(proc, 1), b'launch failed\n')
        self.assertEqual(self.state('launch'), 'queued')
        self.finish(self.worker('host-b', 'pass'))
        self.assertEqual(self.state('launch'), 'completed')


if __name__ == '__main__':
    unittest.main()
