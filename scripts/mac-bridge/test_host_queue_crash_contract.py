import json
import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from host_queue import run

import unittest
from unittest.mock import patch


def mock_time():
    return 1e18


DB = None


class HostQueueCrashContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        global DB
        DB = self.root / 'queue.sqlite'

    def _args(self, action, **kw):
        """Build an argparse.Namespace with the required db path."""
        n = dict(db=str(DB), action=action, ttl=300, **kw)
        return type('Args', (), n)()

    def _expire(self, job):
        """Deterministically expire a job by setting expires=0, matching
        the pattern used in the existing test_host_queue.py suite."""
        with sqlite3.connect(str(DB)) as db:
            db.execute('UPDATE jobs SET expires=0 WHERE job=?', (job,))

    def test_crash_resilience_full_workflow(self):
        """Prove that a job left uncertain by a crashed host cannot be silently
        executed twice: stale receipts fail, explicit recovery is required,
        and a higher generation from a new claim succeeds."""

        with patch('host_queue.time.time', mock_time):
            # Phase 1: enqueue + claim by host-a
            payload = self.root / 'payload.json'
            payload.write_bytes(b'opaque\x00payload')
            result = run(self._args('enqueue', job='job-1',
                                     payload=str(payload)))
            self.assertTrue(result['ok'])

            result = run(self._args('claim', host='host-a'))
            self.assertTrue(result['ok'])
            receipt_a = result['claim']
            gen_1 = receipt_a['generation']
            self.assertEqual(gen_1, 1)

            # Phase 2: deterministically expire the lease (controlled time)
            self._expire('job-1')

            # Phase 3: status now reports uncertain
            result = run(self._args('status', job='job-1'))
            self.assertEqual(result['state'], 'uncertain')

            # Phase 4: host-b normal claim returns nothing
            result = run(self._args('claim', host='host-b'))
            self.assertTrue(result['ok'])
            self.assertIsNone(result['claim'])

            # Phase 5: stale host-a receipts fail on all operations
            receipt_file = self.root / 'receipt_a.json'
            receipt_file.write_text(json.dumps(receipt_a))
            for act in ('renew', 'complete', 'release'):
                extra = {'assert_stopped': True} if act == 'release' else {}
                result = run(self._args(act, receipt=str(receipt_file),
                                         **extra))
                self.assertFalse(result['ok'])
                self.assertEqual(result['error'],
                                 'receipt is not current')

            # Phase 6: host-b recovers matching gen 1
            result = run(self._args('recover', job='job-1',
                                    generation=1, assert_safe=True))
            self.assertTrue(result['ok'])

            # Phase 7: host-b reclaims (higher generation) and completes
            result = run(self._args('claim', host='host-b'))
            self.assertTrue(result['ok'])
            receipt_b = result['claim']
            self.assertGreater(receipt_b['generation'], gen_1)
            receipt_file_b = self.root / 'receipt_b.json'
            receipt_file_b.write_text(json.dumps(receipt_b))
            result = run(self._args('complete',
                                    receipt=str(receipt_file_b)))
            self.assertTrue(result['ok'])
            result = run(self._args('status', job='job-1'))
            self.assertEqual(result['state'], 'completed')

            # No payload or token values leaked into results
            self.assertNotIn('payload_base64', result)
            self.assertNotIn('token', result)
