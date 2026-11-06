import base64
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('host_queue_stdio.py')
PAYLOAD = b'fake bridge payload\x00\xff\x80'


class StdioQueueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = self.root / 'queue.sqlite'
        self.private_tmp = self.root / 'tmp'
        self.private_tmp.mkdir()
        self.env = dict(os.environ, TMPDIR=str(self.private_tmp))

    def process(self, request=None, raw=None):
        data = raw if raw is not None else json.dumps(request).encode()
        return subprocess.run([sys.executable, str(SCRIPT), '--db', str(self.db)],
                              input=data, capture_output=True, timeout=40, env=self.env)

    def call(self, request=None, raw=None, ok=True):
        proc = self.process(request, raw)
        self.assertEqual(proc.returncode, 0 if ok else 1, proc.stderr)
        self.assertEqual(proc.stderr, b'')
        self.assertLessEqual(len(proc.stdout), 96 * 1024 + 2)
        result = json.loads(proc.stdout)
        self.assertEqual(result['ok'], ok)
        return result

    def enqueue(self, job='one', payload=PAYLOAD, ok=True):
        return self.call({'action': 'enqueue', 'job': job,
                          'payload_base64': base64.b64encode(payload).decode('ascii')}, ok=ok)

    def claim(self, host='first'):
        return self.call({'action': 'claim', 'host': host})['claim']

    def receipt(self, claim):
        return {k: claim[k] for k in ('job', 'host', 'token', 'generation')}

    def status(self, job='one'):
        return self.call({'action': 'status', 'job': job})

    def no_leaked_temps(self):
        self.assertEqual(os.listdir(self.private_tmp), [])

    def test_enqueue_claim_renew_complete_status(self):
        self.call({'action': 'status', 'job': 'one'}, ok=False)
        self.enqueue()
        claim = self.claim()
        self.assertEqual((claim['job'], claim['host'], claim['generation']), ('one', 'first', 1))
        self.assertRegex(claim['token'], r'[0-9a-f]{64}\Z')
        self.assertEqual(base64.b64decode(claim['payload_base64']), PAYLOAD)
        self.assertEqual((self.status()['state'], self.status()['host']), ('claimed', 'first'))
        receipt = self.receipt(claim)
        renewed = self.call({'action': 'renew', 'receipt': receipt, 'ttl': 86400})
        self.assertGreater(renewed['expires'], claim['expires'])
        self.call({'action': 'complete', 'receipt': receipt})
        state = self.status()
        self.assertEqual((state['state'], state['host']), ('completed', None))
        self.assertIsNone(self.claim('second'))
        self.no_leaked_temps()

    def test_two_hosts_cannot_claim_one_job(self):
        self.enqueue()
        children = [subprocess.Popen([sys.executable, str(SCRIPT), '--db', str(self.db)],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, env=self.env)
                    for _ in ('first', 'second')]
        claims = []
        for child, host in zip(children, ('first', 'second')):
            out, err = child.communicate(json.dumps({'action': 'claim', 'host': host}).encode(),
                                         timeout=40)
            self.assertEqual(child.returncode, 0, err)
            self.assertEqual(err, b'')
            claims.append(json.loads(out)['claim'])
        granted = [c for c in claims if c is not None]
        self.assertEqual(len(granted), 1)
        self.assertEqual(self.status()['host'], granted[0]['host'])

    def test_stale_receipt_and_no_recover(self):
        self.enqueue()
        receipt = self.receipt(self.claim())
        with sqlite3.connect(self.db) as db:
            db.execute("UPDATE jobs SET expires=0 WHERE job='one'")
        for request in ({'action': 'renew', 'receipt': receipt},
                        {'action': 'complete', 'receipt': receipt},
                        {'action': 'release', 'receipt': receipt, 'assert-stopped': True}):
            with self.subTest(action=request['action']):
                self.assertEqual(self.call(request, ok=False),
                                 {'ok': False, 'error': 'receipt is not current'})
        self.assertEqual(self.status()['state'], 'uncertain')
        self.assertIsNone(self.claim('second'))
        recover = {'action': 'recover', 'job': 'one', 'generation': 1, 'assert-safe': True}
        self.assertEqual(self.call(recover, ok=False), {'ok': False, 'error': 'unsupported action'})
        self.assertEqual(self.status()['state'], 'uncertain')
        self.no_leaked_temps()

    def test_release_requires_assertion(self):
        self.enqueue()
        receipt = self.receipt(self.claim())
        self.call({'action': 'release', 'receipt': receipt}, ok=False)
        self.call({'action': 'release', 'receipt': receipt, 'assert-stopped': False}, ok=False)
        self.call({'action': 'release', 'receipt': receipt, 'assert-stopped': 'true'}, ok=False)
        self.assertEqual(self.status()['state'], 'claimed')
        self.call({'action': 'release', 'receipt': receipt, 'assert-stopped': True})
        self.assertEqual(self.status()['state'], 'queued')
        second = self.claim('second')
        self.assertEqual(second['generation'], 2)
        self.call({'action': 'renew', 'receipt': receipt}, ok=False)
        self.call({'action': 'complete', 'receipt': self.receipt(second)})
        self.no_leaked_temps()

    def test_malformed_and_oversized_requests_do_not_enqueue(self):
        self.enqueue('kept')
        def j(value):
            return json.dumps(value).encode()
        oversized = base64.b64encode(b'x' * 65537).decode('ascii')
        good = {'job': 'one', 'host': 'h', 'token': 'a' * 64, 'generation': 1}
        cases = [
            b'', b'not json {', b'[1, 2, 3]',
            b' ' * (96 * 1024 + 1),
            j({'action': 'bogus'}),
            j({'action': 'recover', 'job': 'one', 'generation': 1, 'assert-safe': True}),
            j({'action': 'enqueue', 'job': 'one'}),
            j({'action': 'enqueue', 'job': 'one', 'payload_base64': 'aGk!'}),
            j({'action': 'enqueue', 'job': 'one', 'payload_base64': ''}),
            j({'action': 'enqueue', 'job': 'one', 'payload_base64': 123}),
            j({'action': 'enqueue', 'job': 'one', 'payload_base64': oversized}),
            j({'action': 'enqueue', 'job': 'bad job', 'payload_base64': 'aGk='}),
            j({'action': 'claim'}),
            j({'action': 'claim', 'host': 'first', 'ttl': 0}),
            j({'action': 'claim', 'host': 'first', 'ttl': '300'}),
            j({'action': 'claim', 'host': 'first', 'ttl': True}),
            j({'action': 'status', 'job': 'one', 'receipt': {}}),
            j({'action': 'complete', 'receipt': 'x'}),
            j({'action': 'complete', 'receipt': dict(good, extra=1)}),
            j({'action': 'complete', 'receipt': dict(good, token='zz')}),
            j({'action': 'complete', 'receipt': dict(good, generation='1')}),
            j({'action': 'complete', 'receipt': dict(good, generation=True)}),
        ]
        for raw in cases:
            with self.subTest(raw=raw[:50]):
                self.call(raw=raw, ok=False)
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM jobs').fetchone()[0], 1)
        self.assertEqual(self.claim('first')['job'], 'kept')
        self.no_leaked_temps()

    def test_errors_disclose_neither_payload_nor_receipt(self):
        secret = 'PAYLOAD_MUST_NOT_APPEAR'
        encoded = base64.b64encode(secret.encode()).decode('ascii')
        rejections = [self.process({'action': 'enqueue', 'job': 'one',
                                    'payload_base64': encoded, 'extra': 1}),
                      self.process(raw=encoded.encode() * 9000)]
        self.enqueue('one', payload=b'opaque')
        claim = self.claim()
        receipt = self.receipt(claim)
        rejections += [self.process({'action': 'complete', 'receipt': receipt, 'extra': 1}),
                       self.process({'action': 'release', 'receipt': receipt}),
                       self.process(raw=json.dumps({'action': 'renew', 'receipt': receipt}).encode()
                                    + b' trailing'),
                       self.process(raw=b'x' * (96 * 1024 + 1))]
        for proc in rejections:
            self.assertEqual(proc.returncode, 1)
            self.assertEqual(proc.stderr, b'')
            self.assertNotIn(secret.encode(), proc.stdout)
            self.assertNotIn(encoded.encode(), proc.stdout)
            self.assertNotIn(claim['token'].encode(), proc.stdout)
        self.assertEqual(self.status()['state'], 'claimed')
        self.call({'action': 'complete', 'receipt': receipt})
        self.no_leaked_temps()


if __name__ == '__main__':
    unittest.main()
