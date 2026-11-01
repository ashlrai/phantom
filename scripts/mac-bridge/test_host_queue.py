import base64
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('host_queue.py')


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = self.root / 'queue.sqlite'
        self.payload = self.root / 'payload'
        self.payload.write_bytes(b'opaque\x00payload')

    def process(self, *args, receipt=None):
        return subprocess.run([sys.executable, str(SCRIPT), '--db', str(self.db), *args],
                              input=json.dumps(receipt) if receipt is not None else None,
                              text=True, capture_output=True, timeout=40)

    def call(self, *args, receipt=None, ok=True):
        proc = self.process(*args, receipt=receipt)
        self.assertEqual(proc.returncode, 0 if ok else 1, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result['ok'], ok)
        return result

    def enqueue(self, job):
        self.call('enqueue', job, str(self.payload))

    def claim(self, host):
        return self.call('claim', '--host', host)['claim']

    def expire(self, job):
        with sqlite3.connect(self.db) as db:
            db.execute('UPDATE jobs SET expires=0 WHERE job=?', (job,))

    def test_concurrent_processes_claim_single_job_once(self):
        self.enqueue('one')
        commands = [[sys.executable, str(SCRIPT), '--db', str(self.db), 'claim', '--host', host]
                    for host in ('first', 'second')]
        children = [subprocess.Popen(c, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                    for c in commands]
        results = []
        for child in children:
            stdout, stderr = child.communicate(timeout=40)
            self.assertEqual(child.returncode, 0, stderr)
            results.append(json.loads(stdout)['claim'])
        claims = [r for r in results if r is not None]
        self.assertEqual(len(claims), 1)
        self.assertEqual(base64.b64decode(claims[0]['payload_base64']), self.payload.read_bytes())

    def test_two_jobs_and_reopen(self):
        self.enqueue('one')
        self.enqueue('two')
        commands = [[sys.executable, str(SCRIPT), '--db', str(self.db), 'claim', '--host', host]
                    for host in ('first', 'second')]
        children = [subprocess.Popen(c, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                    for c in commands]
        claims = []
        for child in children:
            stdout, stderr = child.communicate(timeout=40)
            self.assertEqual(child.returncode, 0, stderr)
            claims.append(json.loads(stdout)['claim'])
        a, b = claims
        self.assertEqual({a['job'], b['job']}, {'one', 'two'})
        self.assertEqual({a['host'], b['host']}, {'first', 'second'})
        self.assertNotEqual(a['token'], b['token'])
        self.assertIsNone(self.claim('third'))
        self.assertEqual(self.call('status', 'one')['state'], 'claimed')
        self.call('complete', '--receipt', '-', receipt=a)
        self.assertEqual(self.call('status', a['job'])['state'], 'completed')
        self.call('enqueue', 'one', str(self.payload), ok=False)

    def test_expiry_recovery_and_stale_receipts(self):
        self.enqueue('one')
        old = self.claim('first')
        self.expire('one')
        self.call('renew', '--receipt', '-', receipt=old, ok=False)
        self.call('complete', '--receipt', '-', receipt=old, ok=False)
        self.call('release', '--receipt', '-', '--assert-stopped', receipt=old, ok=False)
        self.assertIsNone(self.claim('second'))
        self.assertEqual(self.call('status', 'one')['state'], 'uncertain')
        self.assertNotEqual(self.process('recover', 'one', '--generation', '1').returncode, 0)
        self.call('recover', 'one', '--generation', '2', '--assert-safe', ok=False)
        self.call('recover', 'one', '--generation', '1', '--assert-safe')
        new = self.claim('second')
        self.assertEqual(new['generation'], old['generation'] + 1)
        self.call('complete', '--receipt', '-', receipt=old, ok=False)
        self.call('renew', '--receipt', '-', receipt=new)
        self.call('complete', '--receipt', '-', receipt=new)
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute('SELECT job, old_generation FROM recoveries').fetchall(), [('one', 1)])

    def test_release_requires_assertion_and_invalidates_receipt(self):
        self.enqueue('one')
        old = self.claim('first')
        proc = self.process('release', '--receipt', '-', receipt=old)
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(self.call('status', 'one')['state'], 'claimed')
        self.call('release', '--receipt', '-', '--assert-stopped', receipt=old)
        new = self.claim('second')
        self.assertEqual(new['generation'], 2)
        self.call('renew', '--receipt', '-', receipt=old, ok=False)
        self.call('complete', '--receipt', '-', receipt=new)

    def test_invalid_inputs_do_not_disclose_payload(self):
        secret = 'PAYLOAD_MUST_NOT_APPEAR'
        self.payload.write_text(secret)
        for args in [('enqueue', 'bad/identity', str(self.payload)), ('claim', '--host', 'bad host')]:
            proc = self.process(*args)
            self.assertNotEqual(proc.returncode, 0)
            self.assertNotIn(secret, proc.stdout + proc.stderr)
        self.payload.write_bytes(b'')
        self.call('enqueue', 'empty', str(self.payload), ok=False)
        self.payload.write_bytes(b'x' * 65537)
        proc = self.process('enqueue', 'large', str(self.payload))
        self.assertNotEqual(proc.returncode, 0)
        self.assertNotIn('x' * 100, proc.stdout + proc.stderr)
        self.assertIsNone(self.claim('first'))
        self.assertEqual(os.stat(self.db).st_mode & 0o777, 0o600)

    def test_malformed_receipts_do_not_change_state(self):
        self.enqueue('one')
        claim = self.claim('first')
        for field, value in [('host', 'bad host'), ('generation', True), ('token', 'bad'),
                             ('host', 'other'), ('generation', 2), ('token', 'a' * 64)]:
            altered = dict(claim, **{field: value})
            self.call('complete', '--receipt', '-', receipt=altered, ok=False)
        self.assertEqual(self.call('status', 'one')['state'], 'claimed')
        self.call('complete', '--receipt', '-', receipt=claim)


if __name__ == '__main__':
    unittest.main()
