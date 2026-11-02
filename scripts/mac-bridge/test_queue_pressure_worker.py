"""Queue+pressure composition contracts: gate before claim, supervise after.

Temporary SQLite databases and fixture metrics only. Every signalled group
is one this suite spawned; the escaped-session assertions create descendants
under the owned job. No real Mac pressure probes, fleet processes or foreign
process groups are touched.
"""

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

import host_queue
import queue_pressure_worker as qpw

HERE = Path(__file__).resolve().parent
WORKER = str(HERE / 'queue_pressure_worker.py')
HEALTHY = {'freeMemoryPercent': 80, 'swapUsedBytes': 0, 'pressureLevel': 1}
MODERATE = {'freeMemoryPercent': 20, 'swapUsedBytes': 0, 'pressureLevel': 1}
CRITICAL = {'freeMemoryPercent': 3, 'swapUsedBytes': 0, 'pressureLevel': 4}


def ticks(path, seconds=60):
    return (f"import sys,time;from pathlib import Path;p=Path({str(path)!r});"
            f"end=time.time()+{seconds}\n"
            "while time.time()<end: p.open('a').write('x');time.sleep(0.02)\n")


class ArgvTests(unittest.TestCase):
    def test_supervised_argv_is_literal_and_shell_free(self):
        argv = qpw.queue_worker_command('/d/q.db', 'mac-2', 5, 40,
                                        ['/p/job.sh', 'a', '--', '-x'],
                                        '/state', '/pause', 'job9')
        self.assertEqual(argv[0], sys.executable)
        self.assertEqual(argv[2], 'wrap')
        self.assertEqual(argv[3:10], ['--state-dir', '/state', '--pause-file',
                                      '/pause', '--job', 'job9', '--'])
        inner = argv[10:]
        self.assertEqual((inner[0], inner[1]), (sys.executable, str(qpw.QUEUE_WORKER)))
        self.assertEqual(inner[2:11], ['--db', '/d/q.db', '--host', 'mac-2',
                                       '--lease', '5', '--runtime', '40', '--'])
        # Everything after the queue worker's own -- is untouched job argv.
        self.assertEqual(inner[11:], ['/p/job.sh', 'a', '--', '-x'])

    def test_missing_and_invalid_configuration_rejected(self):
        base = ['--db', '/d/q.db', '--host', 'h1', '--lease', '5', '--runtime',
                '30', '--metrics', '/m', '--max-age-seconds', '30',
                '--state-dir', '/s', '--receipt-dir', '/r',
                '--deadline-seconds', '60', '--max-paused-seconds', '10']
        for argv in (base, base + ['--host', 'bad host!'],
                     base + ['--deadline-seconds', 'nan', '--', 'true'],
                     base + ['--max-paused-seconds', '0', '--', 'true'],
                     base + ['--job', 'bad job!', '--', 'true']):
            with self.assertRaises((SystemExit, ValueError), msg=argv):
                qpw.main(argv)


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='queue-pressure-test-')
        self.base = Path(self.temp.name)
        self.db = str(self.base / 'queue.db')
        self.metrics = self.base / 'memguard.json'
        self.receipts = self.base / 'receipts'
        self.state = self.base / 'state'
        self.pause_file = self.base / 'PAUSE'
        self.processes = []
        self.set_metrics(HEALTHY)

    def tearDown(self):
        # Reap recorded groups first so no leaked descendant can hold a
        # captured pipe open during communicate().
        for path in self.receipts.glob('*.json') if self.receipts.exists() else []:
            try:
                record = json.loads(path.read_text())
                for group in [record['pgid'], *record.get('subgroups', [])]:
                    if group:
                        os.killpg(group, signal.SIGKILL)
            except (ProcessLookupError, PermissionError, ValueError, TypeError):
                pass
        for proc in self.processes:
            if proc.poll() is None:
                proc.kill()
            proc.communicate(timeout=10)
        self.temp.cleanup()

    def set_metrics(self, row):
        self.metrics.write_text(json.dumps(row))

    def enqueue(self, job, payload=b'work'):
        path = self.base / ('input-' + job)
        path.write_bytes(payload)
        result = host_queue.run(SimpleNamespace(
            db=self.db, action='enqueue', job=job, payload=str(path)))
        self.assertTrue(result['ok'])

    def status(self, job):
        return host_queue.run(SimpleNamespace(db=self.db, action='status', job=job))

    def worker(self, code, *args, lease=2, runtime=30, deadline=15,
               max_paused=30, poll=0.03, healthy=2, launch_wait=5):
        command = [sys.executable, WORKER, '--db', self.db, '--host', 'host-a',
                   '--lease', str(lease), '--runtime', str(runtime),
                   '--metrics', str(self.metrics), '--max-age-seconds', '30',
                   '--state-dir', str(self.state),
                   '--pause-file', str(self.pause_file),
                   '--receipt-dir', str(self.receipts), '--job', 'testjob',
                   '--poll-seconds', str(poll),
                   '--healthy-samples', str(healthy),
                   '--launch-wait-seconds', str(launch_wait),
                   '--deadline-seconds', str(deadline),
                   '--max-paused-seconds', str(max_paused),
                   '--term-grace-seconds', '0.5',
                   '--', sys.executable, '-c', code, *map(str, args)]
        proc = subprocess.Popen(command, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE)
        self.processes.append(proc)
        return proc

    def finish(self, proc, expected, timeout=15):
        out, err = proc.communicate(timeout=timeout)
        self.assertEqual(proc.returncode, expected, (out, err))
        return out, err

    def receipt(self):
        files = list(self.receipts.glob('*.json'))
        self.assertTrue(files)
        return json.loads(max(files, key=lambda p: p.stat().st_mtime).read_text())

    def wait_state(self, state, timeout=8):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            files = list(self.receipts.glob('*.json'))
            if files:
                record = json.loads(
                    max(files, key=lambda p: p.stat().st_mtime).read_text())
                if record['state'] == state:
                    return record
            time.sleep(0.03)
        self.assertEqual(self.receipt()['state'], state)

    def wait_file(self, path, timeout=8):
        deadline = time.monotonic() + timeout
        while not path.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(path.exists(), f'missing {path}')

    def wait_group_gone(self, pgid, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                os.killpg(pgid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.03)
        self.fail(f'process group {pgid} still alive')

    def ticks_size(self, path):
        return path.stat().st_size if path.exists() else 0

    def wait_ticks(self, path, minimum=1, timeout=8):
        deadline = time.monotonic() + timeout
        while self.ticks_size(path) < minimum and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertGreaterEqual(self.ticks_size(path), minimum)

    def assert_stalled(self, path, window=0.4):
        before = self.ticks_size(path)
        time.sleep(window)
        self.assertEqual(self.ticks_size(path), before)

    def assert_growing(self, path, window=0.4):
        before = self.ticks_size(path)
        time.sleep(window)
        self.assertGreater(self.ticks_size(path), before)

    def test_warning_telemetry_never_consumes_a_claim(self):
        self.enqueue('held', b'alpha')
        marker = self.base / 'should-not-run'
        self.set_metrics(MODERATE)
        code = f"from pathlib import Path; Path({str(marker)!r}).touch()"
        out, err = self.finish(self.worker(code, launch_wait=0.4), 75)
        self.assertFalse(marker.exists())
        self.assertEqual(self.status('held')['state'], 'queued')
        record = self.receipt()
        self.assertEqual((record['state'], record['returncode']), ('blocked', 75))
        self.assertIsNone(record['pgid'])
        self.assertIn(b'launch blocked', err)
        self.assertEqual(out, b'')  # no claim, so the worker never printed one

    def test_healthy_starts_exactly_one_child_and_completes_once(self):
        self.enqueue('once', b'alpha')
        marker = self.base / 'ran.json'
        # Staying alive briefly guarantees the wrapper's tree discovery has
        # observed the job's own session before it exits.
        code = ("import json,os,sys,time;from pathlib import Path;"
                f"Path({str(marker)!r}).write_text(json.dumps({{"
                "'pid':os.getpid(),'pgid':os.getpgrp(),"
                "'payload':sys.stdin.buffer.read().decode()}));time.sleep(.3)")
        out, _err = self.finish(self.worker(code), 0)
        self.assertEqual(out, b'success\n')
        seen = json.loads(marker.read_text())
        self.assertEqual(seen['payload'], 'alpha')
        self.assertEqual(self.status('once')['state'], 'completed')
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute('SELECT generation FROM jobs').fetchall(),
                             [(1,)])
        record = self.receipt()
        self.assertEqual((record['state'], record['returncode']), ('finished', 0))
        # The job ran in its own nested session, discovered under the claim
        # owner's group — not in the wrapper's or the claim owner's group.
        self.assertNotEqual(seen['pgid'], record['pgid'])
        self.assertIn(seen['pgid'], record['subgroups'])
        # The claim was consumed exactly once: the queue is now empty.
        out, _err = self.finish(self.worker('raise SystemExit(9)'), 0)
        self.assertEqual(out, b'empty\n')

    def test_deadline_ends_worker_descendants_without_completing(self):
        self.enqueue('long', b'work')
        job_pg, job_ticks = self.base / 'job.pgid', self.base / 'job.ticks'
        g3_pg, g3_ticks = self.base / 'g3.pgid', self.base / 'g3.ticks'
        inner = ticks(job_ticks)
        escaped = ("import os,sys,time;from pathlib import Path;"
                   f"Path({str(g3_pg)!r}).write_text(str(os.getpgrp()));" +
                   ticks(g3_ticks).split(';', 1)[1])
        code = ("import os,subprocess,sys,time;from pathlib import Path;"
                f"Path({str(job_pg)!r}).write_text(str(os.getpgrp()));"
                f"subprocess.Popen([sys.executable,'-c',{inner!r}]);"
                "subprocess.Popen([sys.executable,'-c',sys.argv[1]],"
                "start_new_session=True);time.sleep(60)")
        # The job creates one plain child (same session) and one grandchild
        # in a third session the queue worker's own killpg cannot reach.
        proc = self.worker(code, escaped, lease=1, deadline=6.0)
        self.wait_file(job_pg)
        self.wait_file(g3_pg)
        self.wait_ticks(job_ticks)
        self.wait_ticks(g3_ticks)
        self.finish(proc, 124)
        record = self.receipt()
        self.assertEqual(record['state'], 'deadline')
        self.assertEqual(record['returncode'], 124)
        for pgid in (record['pgid'], int(job_pg.read_text()),
                     int(g3_pg.read_text())):
            self.wait_group_gone(pgid)
        self.assertIn(int(g3_pg.read_text()), record['subgroups'])
        self.assert_stalled(job_ticks)
        self.assert_stalled(g3_ticks)
        time.sleep(1.1)  # let the dead claim's lease expire
        self.assertEqual(self.status('long')['state'], 'uncertain')

    def test_pause_stops_job_while_claim_owner_keeps_renewing(self):
        self.enqueue('pausable', b'work')
        job_pg, job_ticks = self.base / 'job.pgid', self.base / 'job.ticks'
        code = ("import os,sys,time;from pathlib import Path;"
                f"Path({str(job_pg)!r}).write_text(str(os.getpgrp()));"
                "sys.stdin.buffer.read();" + ticks(job_ticks).split(';', 1)[1])
        proc = self.worker(code, lease=1, deadline=15, max_paused=30)
        self.wait_ticks(job_ticks)
        self.set_metrics(CRITICAL)
        paused = self.wait_state('paused')
        self.assertEqual(paused['reason'], 'critical')
        self.assert_stalled(job_ticks)
        # Paused longer than the lease: the still-running claim owner keeps
        # renewing, so the claim survives and remains 'claimed'.
        time.sleep(1.5)
        status = self.status('pausable')
        self.assertEqual(status['state'], 'claimed')
        self.assertGreater(status['expires'], time.time())
        self.assert_stalled(job_ticks)
        self.set_metrics(HEALTHY)
        self.wait_state('running')
        self.assert_growing(job_ticks)
        proc.send_signal(signal.SIGTERM)
        self.finish(proc, 143)
        self.assertEqual(self.receipt()['state'], 'cancelled')
        self.wait_group_gone(int(job_pg.read_text()))
        time.sleep(1.1)
        self.assertEqual(self.status('pausable')['state'], 'uncertain')

    def test_pause_budget_kills_owned_tree_and_never_completes(self):
        self.enqueue('doomed', b'work')
        job_pg, job_ticks = self.base / 'job.pgid', self.base / 'job.ticks'
        code = ("import os,sys,time;from pathlib import Path;"
                f"Path({str(job_pg)!r}).write_text(str(os.getpgrp()));" +
                ticks(job_ticks).split(';', 1)[1])
        proc = self.worker(code, lease=1, deadline=15, max_paused=0.5)
        self.wait_ticks(job_ticks)
        self.set_metrics(CRITICAL)
        self.wait_state('paused')
        self.finish(proc, 71)
        record = self.receipt()
        self.assertEqual((record['state'], record['reason'], record['returncode']),
                         ('pressure-kill', 'pause-budget-exhausted', 71))
        self.assertGreaterEqual(record['pausedSeconds'], 0.5)
        self.wait_group_gone(record['pgid'])
        self.wait_group_gone(int(job_pg.read_text()))
        self.assert_stalled(job_ticks)
        time.sleep(1.1)
        self.assertEqual(self.status('doomed')['state'], 'uncertain')


if __name__ == '__main__':
    unittest.main()
