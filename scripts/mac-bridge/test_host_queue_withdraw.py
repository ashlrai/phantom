import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('host_queue.py')


class WithdrawTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = self.root / 'queue.sqlite'
        self.payload = self.root / 'payload'
        self.payload.write_bytes(b'opaque\x00payload')

    def process(self, *args, db=None, receipt=None):
        return subprocess.run([sys.executable, str(SCRIPT), '--db', str(db or self.db), *args],
                              input=json.dumps(receipt) if receipt is not None else None,
                              text=True, capture_output=True, timeout=40)

    def call(self, *args, ok=True, **kwargs):
        proc = self.process(*args, **kwargs)
        self.assertEqual(proc.returncode, 0 if ok else 1, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result['ok'], ok)
        return result

    def enqueue(self, job, **kwargs):
        self.call('enqueue', job, str(self.payload), **kwargs)

    def claim(self, host, **kwargs):
        return self.call('claim', '--host', host, **kwargs)['claim']

    def state(self, job):
        return self.call('status', job)['state']

    def row(self, job):
        with sqlite3.connect(self.db) as db:
            return db.execute(
                'SELECT state, host, token, generation, expires FROM jobs WHERE job=?',
                (job,)).fetchone()

    def test_withdraw_queued_job_then_claim_gets_next(self):
        self.enqueue('a')
        self.enqueue('b')
        result = self.call('withdraw', 'a')
        self.assertEqual(result, {'ok': True, 'state': 'withdrawn', 'generation': 0})
        self.assertEqual(self.state('a'), 'withdrawn')
        claim = self.claim('first')
        self.assertEqual(claim['job'], 'b')
        self.assertIsNone(self.claim('second'))
        self.assertEqual(self.row('a'), ('withdrawn', None, None, 0, None))
        with sqlite3.connect(self.db) as db:
            retained = db.execute('SELECT payload FROM jobs WHERE job=?', ('a',)).fetchone()[0]
        self.assertEqual(retained, self.payload.read_bytes())

    def test_withdraw_repeat_is_idempotent_and_stable(self):
        self.enqueue('a')
        first = self.call('withdraw', 'a')
        second = self.call('withdraw', 'a')
        self.assertEqual(first, second)
        self.assertEqual(set(second), {'ok', 'state', 'generation'})
        self.assertEqual(self.row('a'), ('withdrawn', None, None, 0, None))

    def test_withdraw_rejects_missing_claimed_completed_uncertain(self):
        self.call('withdraw', 'missing', ok=False)
        self.enqueue('a')
        claim = self.claim('first')
        before = self.row('a')
        self.call('withdraw', 'a', ok=False)
        self.assertEqual(self.row('a'), before)
        # The failed withdraw did not release or disturb the live claim.
        self.call('renew', '--receipt', '-', receipt=claim)
        self.call('complete', '--receipt', '-', receipt=claim)
        self.assertEqual(self.state('a'), 'completed')
        self.call('withdraw', 'a', ok=False)
        self.assertEqual(self.state('a'), 'completed')
        self.enqueue('u')
        self.claim('first')
        with sqlite3.connect(self.db) as db:
            db.execute("UPDATE jobs SET expires=0 WHERE job='u'")
        self.assertEqual(self.state('u'), 'uncertain')
        before = self.row('u')
        self.call('withdraw', 'u', ok=False)
        self.assertEqual(self.row('u'), before)
        # Recovery still works after the refused withdraw.
        self.call('recover', 'u', '--generation', str(before[3]), '--assert-safe')
        self.assertEqual(self.state('u'), 'queued')

    def test_enqueue_cannot_revive_withdrawn(self):
        self.enqueue('a')
        self.call('withdraw', 'a')
        result = self.call('enqueue', 'a', str(self.payload), ok=False)
        self.assertEqual(result['error'], 'job already exists')
        self.assertEqual(self.state('a'), 'withdrawn')
        self.assertIsNone(self.claim('first'))

    def test_withdraw_claim_race_only_one_wins(self):
        for index in range(4):
            db = self.root / f'race{index}.sqlite'
            self.enqueue('a', db=db)
            commands = [
                [sys.executable, str(SCRIPT), '--db', str(db), 'withdraw', 'a'],
                [sys.executable, str(SCRIPT), '--db', str(db), 'claim', '--host', 'racer'],
            ]
            children = [subprocess.Popen(c, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                         text=True) for c in commands]
            outputs = []
            for child in children:
                stdout, stderr = child.communicate(timeout=40)
                self.assertEqual(stderr, '')
                outputs.append(json.loads(stdout))
            withdraw, claimed = outputs
            for child, out in zip(children, outputs):
                self.assertEqual(child.returncode, 0 if out['ok'] else 1)
            with sqlite3.connect(db) as conn:
                state = conn.execute("SELECT state FROM jobs WHERE job='a'").fetchone()[0]
            if claimed['claim'] is not None:
                # Claim won: withdraw must have failed and the claim stays usable.
                self.assertEqual(claimed['claim']['job'], 'a')
                self.assertEqual(state, 'claimed')
                self.assertFalse(withdraw['ok'])
                self.call('renew', '--receipt', '-', receipt=claimed['claim'], db=db)
            else:
                # Withdraw won: claim found nothing and the job is withdrawn.
                self.assertTrue(withdraw['ok'])
                self.assertEqual(state, 'withdrawn')

    def test_withdraw_errors_never_disclose_payload_or_receipt(self):
        secret = 'PAYLOAD_MUST_NOT_APPEAR'
        self.payload.write_text(secret)
        self.enqueue('a')
        claim = self.claim('first')
        outputs = []
        for args in [('withdraw', 'a'), ('withdraw', 'missing'), ('withdraw', 'bad/identity')]:
            proc = self.process(*args)
            self.assertNotEqual(proc.returncode, 0)
            outputs.append(proc.stdout + proc.stderr)
        self.call('complete', '--receipt', '-', receipt=claim)
        self.enqueue('b')
        proc = self.process('withdraw', 'b')
        self.assertEqual(proc.returncode, 0)
        outputs.append(proc.stdout + proc.stderr)
        for out in outputs:
            self.assertNotIn(secret, out)
            self.assertNotIn(claim['token'], out)
            self.assertNotIn('payload_base64', out)


if __name__ == '__main__':
    unittest.main()
