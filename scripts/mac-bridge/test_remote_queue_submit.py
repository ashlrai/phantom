import base64
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

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import host_queue_stdio  # noqa: E402

SCRIPT = HERE / 'remote_queue_submit.py'
STDIO = HERE / 'host_queue_stdio.py'
HEADER = b'#job repo=phantom lane=codex-personal tier=work\n\n'
DROP = 'RQ-PHX-ABC'
SECRET = 'PRIVATE-PROMPT-MARKER'


class RemoteSubmitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.drop = self.root / 'drop'
        self.drop.mkdir()
        self.db = self.root / 'queue.sqlite'
        self.real = self.argv_file('real.json',
                                   [sys.executable, str(STDIO), '--db', str(self.db)])

    def file(self, name=DROP + '.md', data=HEADER + b'Harmless prompt\n'):
        path = self.drop / name
        path.write_bytes(data)
        return path

    def argv_file(self, name, argv):
        path = self.root / name
        path.write_text(json.dumps(argv))
        return path

    def marker_argv(self):
        marker = self.root / 'transport-ran'
        code = f'open({str(marker)!r}, "w").write("ran")'
        return self.argv_file('marked.json', [sys.executable, '-c', code]), marker

    def command(self, argv_path, *extra, job=DROP, timeout='15'):
        return [sys.executable, str(SCRIPT), '--drop-dir', str(self.drop),
                '--job', job, '--coordinator-argv', str(argv_path),
                '--request-timeout', timeout, *extra]

    def call(self, argv_path, *extra, code=0, **kwargs):
        proc = subprocess.run(self.command(argv_path, *extra, **kwargs),
                              capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, code, proc.stderr + proc.stdout)
        return json.loads(proc.stdout), proc

    def rows(self):
        with sqlite3.connect(self.db) as db:
            return db.execute('SELECT job, payload FROM jobs ORDER BY job').fetchall()

    def test_preview_spawns_nothing_then_apply_stores_exact_bytes(self):
        data = HEADER + b'Harmless prompt\n\x00opaque\xff'
        source = self.file(data=data)
        before = source.stat().st_mtime_ns
        fake, marker = self.marker_argv()
        result, _ = self.call(fake)
        self.assertEqual((result['ok'], result['result'], result['bytes']),
                         (True, 'preview', len(data)))
        self.assertFalse(marker.exists())
        result, _ = self.call(self.real)
        self.assertEqual(result['result'], 'preview')
        self.assertFalse(self.db.exists())
        result, proc = self.call(self.real, '--apply')
        self.assertEqual((result['ok'], result['result']), (True, 'submitted'))
        self.assertEqual(proc.stderr, '')
        self.assertEqual(self.rows(), [(DROP, data)])
        self.assertEqual(source.read_bytes(), data)
        self.assertEqual(source.stat().st_mtime_ns, before)

    def test_resubmit_and_rewrite_report_existing_unverified_one_row(self):
        first = HEADER + b'first harmless prompt'
        self.file(data=first)
        self.call(self.real, '--apply')
        result, _ = self.call(self.real, '--apply', code=2)
        self.assertEqual((result['ok'], result['result']),
                         (False, 'existing-unverified'))
        self.assertEqual(len(self.rows()), 1)
        source = self.file(data=HEADER + b'second harmless prompt')
        result, _ = self.call(self.real, '--apply', code=2)
        self.assertFalse(result['ok'])
        self.assertEqual(result['result'], 'existing-unverified')
        self.assertEqual(self.rows(), [(DROP, first)])
        self.assertEqual(source.read_bytes(), HEADER + b'second harmless prompt')

    def test_request_reaches_stdin_and_never_argv(self):
        data = HEADER + SECRET.encode()
        self.file(data=data)
        captured, seen_argv = self.root / 'stdin.json', self.root / 'argv.json.out'
        code = ('import json,sys;'
                f'open({str(captured)!r},"wb").write(sys.stdin.buffer.read());'
                f'open({str(seen_argv)!r},"w").write(json.dumps(sys.argv));'
                'print(json.dumps({"ok":True}))')
        argvf = self.argv_file('echo.json', [sys.executable, '-c', code])
        result, _ = self.call(argvf, '--apply')
        self.assertEqual(result['result'], 'submitted')
        request = json.loads(captured.read_bytes())
        self.assertEqual(request, {'action': 'enqueue', 'job': DROP,
                                   'payload_base64': base64.b64encode(data).decode('ascii')})
        seen = seen_argv.read_text()
        self.assertNotIn('payload_base64', seen)
        self.assertNotIn('enqueue', seen)

    def test_invalid_or_symlinked_drops_never_spawn_transport(self):
        fake, marker = self.marker_argv()
        link = self.root / 'link'
        link.symlink_to(self.drop, target_is_directory=True)
        proc = subprocess.run([sys.executable, str(SCRIPT), '--drop-dir', str(link),
                               '--job', DROP, '--coordinator-argv', str(fake),
                               '--request-timeout', '5', '--apply'],
                              capture_output=True, text=True, timeout=60)
        self.assertEqual(json.loads(proc.stdout)['error'], 'invalid drop directory')
        (self.drop / (DROP + '.md')).symlink_to(self.root / 'outside')
        (self.root / 'outside').write_bytes(HEADER + b'outside')
        result, _ = self.call(fake, '--apply', code=1)
        self.assertEqual(result['error'], 'invalid or unstable drop')
        (self.drop / (DROP + '.md')).unlink()
        self.file(data=b'#job repo=other lane=claude tier=work\nhello')
        result, _ = self.call(fake, '--apply', code=1)
        self.assertEqual(result['error'], 'invalid or unstable drop')
        result, _ = self.call(fake, '--apply', code=1, job='RQ-PHX-XYZ')
        self.assertEqual(result['error'], 'invalid or unstable drop')
        for bad in ('bogus', 'RQ-PHX-abc', 'RQ-PHX-ABC.md', 'RQ-PHX-AB'):
            result, _ = self.call(fake, '--apply', code=1, job=bad)
            self.assertEqual(result['error'], 'invalid job name', bad)
        self.assertFalse(marker.exists())
        self.assertFalse(self.db.exists())

    def test_argv_file_violations_are_fixed_errors(self):
        self.file()
        (self.root / 'notjson.json').write_text('not json {')
        cases = [self.root / 'missing.json', self.drop, self.root / 'notjson.json']
        for name, content in (('obj.json', {}), ('empty.json', []),
                              ('emptystr.json', ['']), ('nonstr.json', [1]),
                              ('nul.json', ['a\x00b']), ('big.json', ['x' * 5000])):
            path = self.root / name
            path.write_text(json.dumps(content))
            cases.append(path)
        link = self.root / 'argv-link.json'
        link.symlink_to(self.real)
        cases.append(link)
        for path in cases:
            result, _ = self.call(path, '--apply', code=1)
            self.assertEqual(result['error'], 'invalid coordinator argv', path)
        self.assertFalse(self.db.exists())
        self.assertTrue((self.drop / (DROP + '.md')).exists())

    def test_transport_failures_are_bounded_fixed_and_silent(self):
        data = HEADER + SECRET.encode()
        self.file(data=data)
        cases = [
            ('exit1', 'import sys;sys.exit(1)', 'transport or coordinator failed'),
            ('garbage', 'print("not json at all")', 'invalid response'),
            ('nondict', 'print("[1,2,3]")', 'invalid response'),
            ('nook', 'import json;print(json.dumps({"error":"x"}))', 'invalid response'),
            ('reject', 'import json;print(json.dumps({"ok":False,"error":"weird"}))',
             'request rejected'),
            ('leak', 'import json,sys;r=sys.stdin.buffer.read().decode();'
                     'print(json.dumps({"ok":False,"error":r}))', 'request rejected'),
            ('oversize', 'import sys;sys.stdout.write("x"*%d)'
             % (host_queue_stdio.MAX_RESPONSE + 2), 'response exceeds limit'),
        ]
        for name, code, want in cases:
            with self.subTest(name=name):
                argvf = self.argv_file(name + '.json', [sys.executable, '-c', code])
                result, proc = self.call(argvf, '--apply', code=1)
                self.assertEqual(result['error'], want)
                combined = proc.stdout + proc.stderr
                self.assertNotIn(SECRET, combined)
                self.assertNotIn(base64.b64encode(data).decode(), combined)
        argvf = self.argv_file('sleep.json',
                               [sys.executable, '-c', 'import time;time.sleep(60)'])
        start = time.monotonic()
        result, _ = self.call(argvf, '--apply', code=1, timeout='1')
        self.assertLess(time.monotonic() - start, 30)
        self.assertEqual(result['error'], 'request timed out')
        self.assertFalse(self.db.exists())

    def test_sigterm_cleans_fake_transport_descendants(self):
        self.file()
        marker = self.root / 'transport.pid'
        code = ('import os,subprocess,sys,time;'
                f'open({str(marker)!r},"w").write(str(os.getpid()));'
                'subprocess.Popen([sys.executable,"-c","import time;time.sleep(300)"]);'
                'time.sleep(300)')
        argvf = self.argv_file('spawn.json', [sys.executable, '-c', code])
        proc = subprocess.Popen(self.command(argvf, '--apply'),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True)
        try:
            end = time.monotonic() + 20
            while not marker.exists() and time.monotonic() < end:
                self.assertIsNone(proc.poll())
                time.sleep(0.05)
            self.assertTrue(marker.exists(), 'transport never started')
            pgid = int(marker.read_text())
            proc.send_signal(signal.SIGTERM)
            out, _ = proc.communicate(timeout=20)
            self.assertEqual(json.loads(out)['error'], 'interrupted')
            self.assertNotEqual(proc.returncode, 0)
            end = time.monotonic() + 5
            while True:
                try:
                    os.killpg(pgid, 0)
                except ProcessLookupError:
                    break
                self.assertLess(time.monotonic(), end, 'transport group survived')
                time.sleep(0.05)
        finally:
            proc.kill()
            proc.stdout.close()
            proc.stderr.close()
        self.assertFalse(self.db.exists())


if __name__ == '__main__':
    unittest.main()
