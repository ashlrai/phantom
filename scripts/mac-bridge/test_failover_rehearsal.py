import contextlib
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import failover_rehearsal as fr  # noqa: E402
import host_lease               # noqa: E402

SCRIPT = Path(__file__).with_name('failover_rehearsal.py')
PRIMARY, STANDBY = fr.PRIMARY, fr.STANDBY


class RehearsalTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)
        self.procs = []
        self.addCleanup(self.reap)

    def reap(self):
        for proc in self.procs:
            if proc.poll() is None:
                proc.kill()
                proc.wait()

    def popen(self, *a, **kw):
        proc = subprocess.Popen(*a, **kw)
        self.procs.append(proc)
        return proc

    def kept(self, name):
        base = self.base / name
        base.mkdir()
        return base, lambda: contextlib.nullcontext(str(base))

    def run_main(self, argv=(), **deps):
        out = io.StringIO()
        code = fr.main(list(argv), deps, out)
        text = out.getvalue().strip()
        return code, json.loads(text) if text.startswith('{') else text

    def marker(self, base, host, kind):
        return base / 'markers' / (host + '.' + kind)

    def wait_gone(self, pid):
        end = time.monotonic() + 4
        while time.monotonic() < end:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.02)
        self.fail('pid %d survived cleanup' % pid)

    def all_reaped(self):
        for proc in self.procs:
            self.assertIsNotNone(proc.poll())

    def test_preview_and_help_document_invocation(self):
        code, report = self.run_main(
            ['--preview'], tempdir=lambda: self.fail('tempdir touched'))
        self.assertEqual(code, 0)
        self.assertEqual((report['preview'], report['phases']),
                         (True, list(fr.PHASES)))
        helpout = subprocess.run([sys.executable, str(SCRIPT), '-h'],
                                 capture_output=True, text=True, timeout=15)
        self.assertEqual(helpout.returncode, 0)
        self.assertIn('failover_rehearsal.py', helpout.stdout)
        self.assertIn('--deadline-seconds', helpout.stdout)

    def test_invalid_deadline_rejected_before_spawn(self):
        for bad in ('1', '61', 'nan', 'x'):
            with self.assertRaises(SystemExit):
                fr.main(['--deadline-seconds', bad], {}, io.StringIO())
        self.assertEqual(self.procs, [])

    def test_cli_handoff_succeeds(self):
        done = subprocess.run(
            [sys.executable, str(SCRIPT), '--deadline-seconds', '25'],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr + done.stdout)
        report = json.loads(done.stdout.strip().splitlines()[-1])
        self.assertEqual((report['schema'], report['outcome']),
                         (fr.SCHEMA, 'ok'))
        self.assertEqual([p['ok'] for p in report['phases'].values()],
                         [True] * len(fr.PHASES))
        self.assertIsNotNone(report.get('takeoverMs'))
        self.assertLess(report['elapsedMs'], 45000)

    def test_handoff_markers_and_restored_state(self):
        base, tempdir = self.kept('kept')
        code, report = self.run_main(tempdir=tempdir, popen=self.popen)
        self.assertEqual((code, report['outcome']), (0, 'ok'))
        for host in (PRIMARY, STANDBY):
            self.assertTrue(self.marker(base, host, 'started').exists())
        self.assertTrue(self.marker(base, PRIMARY, 'stopped').exists())
        restored = base / 'roots' / STANDBY
        self.assertEqual((restored / 'leader/VISION.md').read_text(),
                         'fake vision\n')
        self.assertFalse((restored / 'metrics/jobs.jsonl').exists())
        for host in (PRIMARY, STANDBY):
            self.wait_gone(int(self.marker(base, host, 'started').read_text()))
        self.all_reaped()

    def test_held_lease_blocks_and_deadline_bounds(self):
        base, tempdir = self.kept('held')
        lease = host_lease.parser().parse_args(
            ['--db', str(base / 'leases.sqlite'), 'acquire', fr.ROLE,
             '--host', 'other-host', '--ttl', '60', '--primary', PRIMARY,
             '--grace', '0'])
        self.assertTrue(host_lease.run(lease)['ok'])
        start = time.monotonic()
        code, report = self.run_main(['--deadline-seconds', '5'],
                                     tempdir=tempdir, popen=self.popen)
        self.assertNotEqual(code, 0)
        self.assertEqual(report['failedPhase'], 'primaryLeader')
        self.assertIn(report['outcome'], ('deadline', 'failed'))
        self.assertLess(time.monotonic() - start, 15)
        self.all_reaped()

    def test_failing_standby_child_nonzero_and_reaped(self):
        base, tempdir = self.kept('failchild')

        def child_for(markers, host, root):
            if host == STANDBY:
                return [sys.executable, '-c', 'import sys; sys.exit(3)']
            return fr.child_argv(markers, host, root)

        code, report = self.run_main(tempdir=tempdir, popen=self.popen,
                                     child_argv=child_for)
        self.assertNotEqual(code, 0)
        self.assertEqual(report['failedPhase'], 'standbyLeader')
        self.assertFalse(self.marker(base, STANDBY, 'started').exists())
        self.all_reaped()

    def test_overlap_detection_nonzero(self):
        base, tempdir = self.kept('overlap')

        def inject(argv, **kw):
            proc = self.popen(argv, **kw)
            if '--host' in argv and argv[argv.index('--host') + 1] == STANDBY:
                self.marker(base, STANDBY, 'started').write_text('999999')
            return proc

        code, report = self.run_main(tempdir=tempdir, popen=inject)
        self.assertNotEqual(code, 0)
        self.assertEqual(report['outcome'], 'overlap')
        self.all_reaped()

    def test_cli_sigterm_cancelled_and_tempdir_removed(self):
        before = {p.name for p in Path(tempfile.gettempdir()).iterdir()
                  if p.name.startswith('failover-rehearsal-')}
        proc = subprocess.Popen([sys.executable, str(SCRIPT)],
                                stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True)
        self.procs.append(proc)
        end = time.monotonic() + 15
        while proc.poll() is None and time.monotonic() < end \
                and not any(p.name.startswith('failover-rehearsal-')
                            for p in Path(tempfile.gettempdir()).iterdir()):
            time.sleep(0.05)
        proc.send_signal(signal.SIGTERM)
        out, _ = proc.communicate(timeout=20)
        self.assertNotEqual(proc.returncode, 0)
        self.assertTrue(out.strip(), 'rehearsal produced no report')
        report = json.loads(out.strip().splitlines()[-1])
        self.assertEqual(report['outcome'], 'cancelled')
        after = {p.name for p in Path(tempfile.gettempdir()).iterdir()
                 if p.name.startswith('failover-rehearsal-')}
        self.assertEqual(after - before, set())


if __name__ == '__main__':
    unittest.main()
