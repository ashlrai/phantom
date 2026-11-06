import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

import host_queue
import host_queue_worker

WORKER = str(Path(__file__).with_name('host_queue_worker.py'))


class WorkerCwdTests(unittest.TestCase):
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

    def enqueue(self, job, payload=b'work'):
        path = self.root / ('input-' + job)
        path.write_bytes(payload)
        result = host_queue.run(SimpleNamespace(db=self.db, action='enqueue', job=job, payload=str(path)))
        self.assertTrue(result['ok'])

    def status(self, job):
        return host_queue.run(SimpleNamespace(db=self.db, action='status', job=job))

    def worker(self, code, *args, cwd=None, launch_cwd=None, lease=2, runtime=8):
        command = [sys.executable, WORKER, '--db', self.db, '--host', 'host-a',
                   '--lease', str(lease), '--runtime', str(runtime)]
        if cwd is not None:
            command += ['--cwd', str(cwd)]
        command += ['--', sys.executable, '-c', code, *map(str, args)]
        proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                cwd=launch_cwd or self.root)
        self.processes.append(proc)
        return proc

    def finish(self, proc, expected=0):
        out, err = proc.communicate(timeout=12)
        self.assertEqual(proc.returncode, expected, (out, err))
        self.assertEqual(err, b'')
        return out

    def child_cwd(self, out):
        return Path(out.read_text()).resolve()

    def test_selected_cwd_with_spaces_is_child_working_directory(self):
        checkout = self.root / 'selected checkout'
        checkout.mkdir()
        self.enqueue('selected')
        out = self.root / 'selected-out'
        code = "import os,pathlib,sys; pathlib.Path(sys.argv[1]).write_text(os.getcwd())"
        self.assertEqual(self.finish(self.worker(code, out, cwd=checkout)), b'success\n')
        self.assertEqual(self.child_cwd(out), checkout.resolve())
        self.assertEqual(self.status('selected')['state'], 'completed')

    def test_default_cwd_inherits_worker_directory(self):
        anchor = self.root / 'launch here'
        anchor.mkdir()
        self.enqueue('default')
        out = self.root / 'default-out'
        code = "import os,pathlib,sys; pathlib.Path(sys.argv[1]).write_text(os.getcwd())"
        self.assertEqual(self.finish(self.worker(code, out, launch_cwd=anchor)), b'success\n')
        self.assertEqual(self.child_cwd(out), anchor.resolve())

    def test_relative_cwd_resolves_against_launch_directory(self):
        anchor = self.root / 'anchor'
        (anchor / 'nested checkout').mkdir(parents=True)
        self.enqueue('relative')
        out = self.root / 'relative-out'
        code = "import os,pathlib,sys; pathlib.Path(sys.argv[1]).write_text(os.getcwd())"
        proc = self.worker(code, out, cwd='nested checkout', launch_cwd=anchor)
        self.assertEqual(self.finish(proc), b'success\n')
        self.assertEqual(self.child_cwd(out), (anchor / 'nested checkout').resolve())

    def test_nonexistent_cwd_refuses_before_claim(self):
        self.enqueue('missing')
        proc = self.worker('raise SystemExit(0)', cwd=self.root / 'missing dir')
        self.assertEqual(self.finish(proc, 1), b'invalid cwd\n')
        status = self.status('missing')
        self.assertEqual((status['state'], status['generation']), ('queued', 0))

    def test_regular_file_cwd_refuses_before_claim(self):
        target = self.root / 'regular file'
        target.write_text('not a directory')
        self.enqueue('file')
        proc = self.worker('raise SystemExit(0)', cwd=target)
        self.assertEqual(self.finish(proc, 1), b'invalid cwd\n')
        status = self.status('file')
        self.assertEqual((status['state'], status['generation']), ('queued', 0))

    def test_payload_cannot_override_selected_cwd_or_argv(self):
        checkout = self.root / 'chosen dir'
        checkout.mkdir()
        malicious = b'{"cwd": "/tmp/elsewhere"}\n--cwd=/evil\n$(touch injected)\n'
        self.enqueue('opaque', malicious)
        result = self.root / 'result'
        code = ("import json,os,pathlib,sys; data=sys.stdin.buffer.read(); "
                "pathlib.Path(sys.argv[1]).write_text(json.dumps([sys.argv[2:],os.getcwd(),data.decode()])); "
                "sys.stdout.buffer.write(data*10000); sys.stderr.buffer.write(data*10000)")
        self.assertEqual(self.finish(self.worker(code, result, 'literal', cwd=checkout)), b'success\n')
        argv, cwd, data = json.loads(result.read_text())
        self.assertEqual((argv, Path(cwd).resolve(), data),
                         (['literal'], checkout.resolve(), malicious.decode()))
        self.assertFalse((self.root / 'injected').exists())
        self.assertFalse((checkout / 'injected').exists())

    def test_vanished_cwd_reuses_launch_failure_release(self):
        checkout = self.root / 'gone'
        checkout.mkdir()
        self.enqueue('vanish')
        args = SimpleNamespace(db=self.db, host='host-a', lease=2, runtime=8,
                               cwd=str(checkout), command=[sys.executable, '-c', 'pass'])
        with mock.patch.object(host_queue_worker.subprocess, 'Popen',
                               side_effect=FileNotFoundError('directory vanished')):
            outcome, status = host_queue_worker.run(args)
        self.assertEqual((outcome, status), ('launch failed', 1))
        self.assertEqual(self.status('vanish')['state'], 'queued')

    def test_run_without_cwd_attribute_uses_inherited(self):
        self.enqueue('legacy')
        out = self.root / 'legacy-out'
        code = "import os,pathlib,sys; pathlib.Path(sys.argv[1]).write_text(os.getcwd())"
        args = SimpleNamespace(db=self.db, host='host-a', lease=2, runtime=8,
                               command=[sys.executable, '-c', code, str(out)])
        outcome, status = host_queue_worker.run(args)
        self.assertEqual((outcome, status), ('success', 0))
        self.assertEqual(self.child_cwd(out), Path.cwd().resolve())
        self.assertEqual(self.status('legacy')['state'], 'completed')


if __name__ == '__main__':
    unittest.main()
