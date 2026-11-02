import base64
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

import host_queue
import host_queue_ingress as ingress

SCRIPT = Path(__file__).with_name('host_queue_ingress.py')


def payload(lane, tier='work', body=b''):
    """Fake header-only job payload, optionally with a marker body."""
    return f'#job repo=phantom lane={lane} tier={tier}\n'.encode() + body


class LaneTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.drop = self.root / 'drop'
        self.drop.mkdir()
        self.db = self.root / 'queue.sqlite'

    def file(self, name, lane='codex-personal', tier='work', body=b''):
        path = self.drop / name
        path.write_bytes(payload(lane, tier, body))
        return path

    def command(self, *extra, db=None, drop=None):
        return [sys.executable, str(SCRIPT), '--drop-dir', str(drop or self.drop),
                '--db', str(db or self.db), '--once', *extra]

    def call(self, *extra, rc=0, db=None, drop=None):
        proc = subprocess.run(self.command(*extra, db=db, drop=drop), capture_output=True,
                              text=True, timeout=40)
        self.assertEqual(proc.returncode, rc, proc.stderr + proc.stdout)
        return json.loads(proc.stdout) if rc == 0 else proc

    def rows(self, db=None):
        with sqlite3.connect(db or self.db) as handle:
            return handle.execute('SELECT job, payload FROM jobs ORDER BY job').fetchall()

    def test_single_lane_preview_and_apply_agree(self):
        for name, lane in (('RQ-PHX-CLA.md', 'claude'), ('RQ-PHX-DEV.md', 'devin'),
                           ('RQ-PHX-LOC.md', 'codex-local'), ('RQ-PHX-PER.md', 'codex-personal')):
            self.file(name, lane)
        preview = self.call('--lane', 'codex-personal')
        self.assertEqual(preview['eligible'], ['RQ-PHX-PER'])
        self.assertEqual(preview['filtered'], 3)
        self.assertEqual(preview['excluded'], 0)
        applied = self.call('--apply', '--lane', 'codex-personal')
        self.assertEqual(applied['inserted'], preview['eligible'])
        self.assertEqual(applied['filtered'], 3)
        self.assertEqual(self.rows(), [('RQ-PHX-PER', payload('codex-personal'))])
        # Unselected-lane drop files stay untouched for a different ingress.
        for name, lane in (('RQ-PHX-CLA.md', 'claude'), ('RQ-PHX-DEV.md', 'devin'),
                           ('RQ-PHX-LOC.md', 'codex-local')):
            self.assertEqual((self.drop / name).read_bytes(), payload(lane))

    def test_multiple_lanes_preview_and_apply_agree(self):
        for name, lane in (('RQ-PHX-CLA.md', 'claude'), ('RQ-PHX-DEV.md', 'devin'),
                           ('RQ-PHX-LOC.md', 'codex-local'), ('RQ-PHX-PER.md', 'codex-personal')):
            self.file(name, lane)
        lanes = ('--lane', 'devin', '--lane', 'codex-personal')
        preview = self.call(*lanes)
        self.assertEqual(preview['eligible'], ['RQ-PHX-DEV', 'RQ-PHX-PER'])
        self.assertEqual(preview['filtered'], 2)
        applied = self.call('--apply', *lanes)
        self.assertEqual(applied['inserted'], preview['eligible'])
        self.assertEqual(applied['filtered'], 2)
        self.assertEqual([job for job, _ in self.rows()], ['RQ-PHX-DEV', 'RQ-PHX-PER'])

    def test_unknown_lane_rejected_by_argparse(self):
        self.file('RQ-PHX-PER.md')
        proc = self.call('--apply', '--lane', 'bogus', rc=2)
        self.assertIn('invalid choice', proc.stderr)
        self.assertFalse(self.db.exists())
        self.assertTrue((self.drop / 'RQ-PHX-PER.md').exists())
        with self.assertRaises(SystemExit):
            ingress.parse_args(['--drop-dir', str(self.drop), '--db', str(self.db),
                                '--once', '--lane', 'bogus'])

    def test_repeated_lane_flags_deduplicate(self):
        args = ingress.parse_args(['--drop-dir', str(self.drop), '--db', str(self.db),
                                   '--once', '--lane', 'devin', '--lane', 'devin',
                                   '--lane', 'claude', '--lane', 'devin'])
        self.assertEqual(args.lane, ['claude', 'devin'])
        for name, lane in (('RQ-PHX-CLA.md', 'claude'), ('RQ-PHX-DEV.md', 'devin'),
                           ('RQ-PHX-PER.md', 'codex-personal')):
            self.file(name, lane)
        result = self.call('--apply', '--lane', 'devin', '--lane', 'devin',
                           '--lane', 'claude')
        self.assertEqual(result['inserted'], ['RQ-PHX-CLA', 'RQ-PHX-DEV'])
        self.assertEqual(result['filtered'], 1)

    def test_omitted_lane_admits_all_lanes(self):
        for index, lane in enumerate(ingress.LANES):
            self.file(f'RQ-PHX-{index:03}.md', lane)
        preview = self.call()
        self.assertEqual(preview['eligible'], ['RQ-PHX-000', 'RQ-PHX-001',
                                               'RQ-PHX-002', 'RQ-PHX-003'])
        self.assertEqual(preview['filtered'], 0)
        applied = self.call('--apply')
        self.assertEqual(applied['inserted'], preview['eligible'])
        self.assertEqual(applied['filtered'], 0)
        self.assertEqual(len(self.rows()), 4)

    def test_filtered_identity_collision_cannot_block_selected_work(self):
        seed = self.root / 'seed'
        seed.write_bytes(b'existing different payload\n')
        same = self.root / 'same'
        same.write_bytes(payload('devin'))
        for job, path in (('RQ-PHX-AAA', seed), ('RQ-PHX-BBB', same)):
            outcome = host_queue.run(SimpleNamespace(db=str(self.db), action='enqueue',
                                                     job=job, payload=str(path)))
            self.assertTrue(outcome['ok'])
        # RQ-PHX-AAA would conflict and RQ-PHX-BBB would dedupe if ever looked up.
        self.file('RQ-PHX-AAA.md', 'devin')
        self.file('RQ-PHX-BBB.md', 'devin')
        self.file('RQ-PHX-PER.md', 'codex-personal')
        preview = self.call('--lane', 'codex-personal')
        self.assertEqual(preview['eligible'], ['RQ-PHX-PER'])
        self.assertEqual(preview['filtered'], 2)
        # call() asserts exit 0; a conflict on a filtered job would fail the run.
        result = self.call('--apply', '--lane', 'codex-personal')
        self.assertEqual(result['inserted'], ['RQ-PHX-PER'])
        self.assertEqual(result['conflict'], [])
        self.assertEqual(result['duplicate'], [])
        self.assertEqual(result['filtered'], 2)
        rows = dict(self.rows())
        self.assertEqual(rows['RQ-PHX-AAA'], b'existing different payload\n')
        self.assertEqual(rows['RQ-PHX-BBB'], payload('devin'))
        self.assertEqual(rows['RQ-PHX-PER'], payload('codex-personal'))

    def test_repeated_cycles_remain_idempotent(self):
        self.file('RQ-PHX-DEV.md', 'devin')
        self.file('RQ-PHX-PER.md', 'codex-personal')
        proc = subprocess.run(
            [sys.executable, str(SCRIPT), '--drop-dir', str(self.drop), '--db', str(self.db),
             '--cycles', '2', '--interval', '1', '--apply', '--lane', 'codex-personal'],
            capture_output=True, text=True, timeout=40)
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        lines = [json.loads(text) for text in proc.stdout.splitlines()]
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0]['inserted'], ['RQ-PHX-PER'])
        self.assertEqual(lines[1]['inserted'], [])
        self.assertEqual(lines[1]['duplicate'], ['RQ-PHX-PER'])
        self.assertEqual([line['filtered'] for line in lines], [1, 1])
        self.assertEqual(self.rows(), [('RQ-PHX-PER', payload('codex-personal'))])
        self.assertTrue((self.drop / 'RQ-PHX-DEV.md').exists())

    def test_filtered_inputs_never_consume_batch_budget(self):
        for number in range(50):
            self.file(f'RQ-PHX-A{number:02}.md', 'devin')  # sort first, all filtered
        for number in range(ingress.BATCH):
            self.file(f'RQ-PHX-B{number:02}.md', 'codex-personal')
        result = self.call('--apply', '--lane', 'codex-personal')
        self.assertEqual(len(result['inserted']), ingress.BATCH)
        self.assertEqual(result['deferred'], [])
        self.assertEqual(result['filtered'], 50)
        self.assertEqual(len(self.rows()), ingress.BATCH)

    def test_symlink_and_unstable_snapshot_stay_excluded_not_filtered(self):
        target = self.root / 'outside'
        target.write_bytes(payload('codex-personal'))
        (self.drop / 'RQ-PHX-LNK.md').symlink_to(target)  # selected-lane content via link
        self.file('RQ-PHX-DEV.md', 'devin')
        self.file('RQ-PHX-PER.md', 'codex-personal')
        result = self.call('--apply', '--lane', 'codex-personal')
        self.assertEqual(result['inserted'], ['RQ-PHX-PER'])
        self.assertEqual(result['filtered'], 1)
        self.assertEqual(result['excluded'], 1)
        self.assertEqual(self.rows(), [('RQ-PHX-PER', payload('codex-personal'))])

    def test_snapshot_changing_mid_read_is_excluded_even_when_selected(self):
        self.file('RQ-PHX-PER.md')
        original = ingress.os.fstat
        calls = 0
        def changed(fd):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.file('RQ-PHX-PER.md', body=b'modified')
            return original(fd)
        args = SimpleNamespace(drop_dir=str(self.drop), db=str(self.db), apply=False,
                               lane=['codex-personal'])
        with mock.patch.object(ingress.os, 'fstat', side_effect=changed):
            result = ingress.cycle(args)
        self.assertEqual(result['eligible'], [])
        self.assertEqual(result['excluded'], 1)
        self.assertEqual(result['filtered'], 0)

    def test_disjoint_lanes_partition_into_separate_dbs_for_fake_hosts(self):
        for name, lane in (('RQ-PHX-DV1.md', 'devin'), ('RQ-PHX-DV2.md', 'devin'),
                           ('RQ-PHX-PR1.md', 'codex-personal'),
                           ('RQ-PHX-PR2.md', 'codex-personal')):
            self.file(name, lane)
        devin_db = self.root / 'devin.sqlite'
        personal_db = self.root / 'personal.sqlite'
        devin = self.call('--apply', '--lane', 'devin', db=devin_db)
        self.assertEqual(devin['inserted'], ['RQ-PHX-DV1', 'RQ-PHX-DV2'])
        self.assertEqual(devin['filtered'], 2)
        personal = self.call('--apply', '--lane', 'codex-personal', db=personal_db)
        self.assertEqual(personal['inserted'], ['RQ-PHX-PR1', 'RQ-PHX-PR2'])
        self.assertEqual(personal['filtered'], 2)
        self.assertEqual([job for job, _ in self.rows(devin_db)], ['RQ-PHX-DV1', 'RQ-PHX-DV2'])
        self.assertEqual([job for job, _ in self.rows(personal_db)],
                         ['RQ-PHX-PR1', 'RQ-PHX-PR2'])
        # Each fake host drains its own DB through the existing queue runner and
        # receives only its selected lane's jobs; a third claim finds nothing.
        for db, host, jobs, lane in (
                (devin_db, 'fake-devin-host', ('RQ-PHX-DV1', 'RQ-PHX-DV2'), b'lane=devin'),
                (personal_db, 'fake-personal-host', ('RQ-PHX-PR1', 'RQ-PHX-PR2'),
                 b'lane=codex-personal')):
            claimed = []
            for _ in range(2):
                claim = host_queue.run(SimpleNamespace(
                    db=str(db), action='claim', host=host, ttl=60))['claim']
                self.assertEqual(claim['host'], host)
                self.assertIn(lane, base64.b64decode(claim['payload_base64']))
                claimed.append(claim['job'])
            self.assertEqual(sorted(claimed), sorted(jobs))
            self.assertIsNone(host_queue.run(SimpleNamespace(
                db=str(db), action='claim', host=host, ttl=60))['claim'])
        # Both ingresses leave every drop file in place for the other partition.
        self.assertEqual(sorted(path.name for path in self.drop.iterdir()),
                         ['RQ-PHX-DV1.md', 'RQ-PHX-DV2.md', 'RQ-PHX-PR1.md', 'RQ-PHX-PR2.md'])


if __name__ == '__main__':
    unittest.main()
