import base64
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('host_queue.py')


class QueueStdinTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = self.root / 'queue.sqlite'

    def call(self, *args, payload=None, ok=True):
        proc = subprocess.run([sys.executable, str(SCRIPT), '--db', str(self.db), *args],
                              input=payload, capture_output=True, timeout=40)
        self.assertEqual(proc.returncode, 0 if ok else 1, proc.stderr)
        self.assertEqual(proc.stderr, b'')
        result = json.loads(proc.stdout)
        self.assertEqual(result['ok'], ok)
        return result

    def test_binary_stdin_and_duplicate_id(self):
        payload = b'fake opaque payload\x00\xff\x80'
        self.assertEqual(self.call('enqueue', 'one', '-', payload=payload), {'ok': True})
        self.assertEqual(self.call('enqueue', 'one', '-', payload=b'different', ok=False),
                         {'ok': False, 'error': 'job already exists'})
        claim = self.call('claim', '--host', 'fake-host')['claim']
        self.assertEqual(base64.b64decode(claim['payload_base64']), payload)
        self.assertIsNone(self.call('claim', '--host', 'fake-host')['claim'])

    def test_invalid_stdin_does_not_insert(self):
        for job, payload in [('empty', b''), ('large', b'x' * 65537)]:
            with self.subTest(job=job):
                self.assertEqual(self.call('enqueue', job, '-', payload=payload, ok=False),
                                 {'ok': False, 'error': 'invalid input or coordinator failure'})
        self.assertIsNone(self.call('claim', '--host', 'fake-host')['claim'])
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM jobs').fetchone()[0], 0)

    def test_file_payload_still_works(self):
        payload = b'fake file\x00\xfe'
        path = self.root / 'payload'
        path.write_bytes(payload)
        self.assertEqual(self.call('enqueue', 'file', str(path)), {'ok': True})
        claim = self.call('claim', '--host', 'fake-host')['claim']
        self.assertEqual(base64.b64decode(claim['payload_base64']), payload)

    def test_help_describes_stdin(self):
        proc = subprocess.run([sys.executable, str(SCRIPT), '--db', str(self.db),
                               'enqueue', '--help'], capture_output=True, text=True, timeout=40)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn('- for stdin', proc.stdout)


if __name__ == '__main__':
    unittest.main()
