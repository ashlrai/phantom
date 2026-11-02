import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import state_snapshot  # noqa: E402
import snapshot_publish  # noqa: E402
import snapshot_relay  # noqa: E402

SCRIPT = HERE / 'snapshot_relay.py'
KEEP_ALL = str(snapshot_publish.MAX_RETAIN)


class SnapshotRelayRetentionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'fleet-state'
        self.src = self.base / 'published'
        self.dst = self.base / 'standby'
        self.src.mkdir()
        self.dst.mkdir()
        for rel, text in {
            'queue/router-queue.md': 'FAKE router queue row\n',
            'queue/ready.tsv': 'job\tlane\njob-fake-1\tlane-fake\n',
            'queue/slots.json': '{"lane-fake": {"open": 1}}\n',
            'leader/VISION.md': 'FAKE vision\n',
            'leader/ORCHESTRATION.md': 'FAKE orchestration\n',
            'metrics/jobs.jsonl': '{"job": "job-fake-1"}\n',
        }.items():
            path = self.root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        self.publisher = snapshot_publish.Publisher(
            self.root, self.src, 60, snapshot_publish.MAX_RETAIN)

    def publish(self):
        outcome = self.publisher.cycle()
        self.assertTrue(outcome['ok'], outcome)
        return outcome['generation']

    def relay(self, *extra):
        return snapshot_relay.main(
            ['--source', str(self.src), '--destination', str(self.dst), *extra])

    def apply(self, retain=KEEP_ALL):
        self.assertEqual(
            self.relay('--apply', '--retain', str(retain)), 0)

    def pointer(self, store):
        target = store / 'latest.json'
        return json.loads(target.read_bytes()) if target.exists() else None

    def gens(self, store):
        return [g.name for g in snapshot_publish.generations(store)]

    def assert_verified_destination(self):
        point = self.pointer(self.dst)
        self.assertIsNotNone(point)
        gen = self.dst / point['generation']
        check = state_snapshot.verify_snapshot(gen)
        self.assertTrue(check['ok'], check['errors'])
        self.assertFalse(check['manifest']['skipped'])
        self.assertEqual(point['manifestSha256'],
                         state_snapshot.sha256_file(gen / 'manifest.json'))
        return point

    def test_relay_retains_only_requested_priors(self):
        for _ in range(5):  # more generations than the retain limit
            self.publish()
            self.apply(retain=1)
        point = self.assert_verified_destination()
        surviving = self.gens(self.dst)
        self.assertEqual(len(surviving), 2)  # current plus one prior
        self.assertIn(point['generation'], surviving)
        self.assertEqual(len(self.gens(self.src)), 5)  # source store intact

    def test_pruned_names_reported_as_bounded_metadata(self):
        for _ in range(3):
            self.publish()
            result = snapshot_relay.relay(self.src, self.dst, True, retain=1)
        self.assertTrue(result['ok'])
        self.assertTrue(result['copied'])
        self.assertEqual(result['retain'], 1)
        self.assertEqual(len(result['pruned']), 1)
        victim = result['pruned'][0]
        self.assertTrue(snapshot_publish.GENERATION.fullmatch(victim))
        self.assertFalse((self.dst / victim).exists())

    def test_noop_apply_converges_retention_without_copying(self):
        for _ in range(4):
            self.publish()
            self.apply()  # keep every prior
        self.assertGreater(len(self.gens(self.dst)), 2)
        before_pointer = (self.dst / 'latest.json').read_bytes()
        surplus = len(self.gens(self.dst)) - 2
        result = snapshot_relay.relay(self.src, self.dst, True, retain=1)
        self.assertTrue(result['ok'])
        self.assertTrue(result['noop'])
        self.assertNotIn('copied', result)
        self.assertEqual(len(result['pruned']), surplus)
        for victim in result['pruned']:
            self.assertFalse((self.dst / victim).exists())
        self.assertEqual(len(self.gens(self.dst)), 2)
        self.assertEqual((self.dst / 'latest.json').read_bytes(), before_pointer)
        self.assert_verified_destination()

    def test_preview_never_prunes(self):
        for _ in range(4):
            self.publish()
            self.apply()
        before = sorted(self.gens(self.dst))
        self.assertGreater(len(before), 2)
        self.assertEqual(self.relay(), 0)  # preview, default retain
        self.assertEqual(self.relay('--retain', '1'), 0)  # still a preview
        self.assertEqual(sorted(self.gens(self.dst)), before)
        self.assert_verified_destination()

    def test_retain_bounds_rejected_without_mutation(self):
        self.publish()
        self.apply()
        before_pointer = (self.dst / 'latest.json').read_bytes()
        before = sorted(self.gens(self.dst))
        for bad in ('0', '-1', str(snapshot_publish.MAX_RETAIN + 1), 'abc'):
            with self.assertRaises(SystemExit):
                self.relay('--apply', '--retain', bad)
        for bad in (0, -5, snapshot_publish.MAX_RETAIN + 1, True, 'x'):
            with self.assertRaises(snapshot_relay.RelayError):
                snapshot_relay.relay(self.src, self.dst, True, bad)
        self.assertEqual((self.dst / 'latest.json').read_bytes(), before_pointer)
        self.assertEqual(sorted(self.gens(self.dst)), before)
        self.assert_verified_destination()

    def test_copy_failure_leaves_every_prior_intact(self):
        for _ in range(3):
            self.publish()
            self.apply()
        before_pointer = (self.dst / 'latest.json').read_bytes()
        before = sorted(self.gens(self.dst))
        self.publish()
        with mock.patch.object(snapshot_relay, 'copy_generation',
                               side_effect=OSError('simulated crash')):
            self.assertEqual(self.relay('--apply', '--retain', '1'), 1)
        self.assertEqual((self.dst / 'latest.json').read_bytes(), before_pointer)
        self.assertEqual(sorted(self.gens(self.dst)), before)
        self.assert_verified_destination()

    def test_commit_failure_leaves_every_prior_intact(self):
        for _ in range(3):
            self.publish()
            self.apply()
        before_pointer = (self.dst / 'latest.json').read_bytes()
        before = set(self.gens(self.dst))
        self.publish()
        with mock.patch.object(snapshot_publish, 'commit_pointer',
                               side_effect=OSError('simulated crash')):
            self.assertEqual(self.relay('--apply', '--retain', '1'), 1)
        self.assertEqual((self.dst / 'latest.json').read_bytes(), before_pointer)
        after = self.gens(self.dst)
        self.assertTrue(before.issubset(after))  # no prior was pruned
        self.assert_verified_destination()
        self.apply(retain=1)  # verified remnant is adopted, then pruned
        self.assertEqual(len(self.gens(self.dst)), 2)
        self.assert_verified_destination()

    def test_lock_contention_skips_pruning(self):
        for _ in range(3):
            self.publish()
            self.apply()
        before = sorted(self.gens(self.dst))
        fd = os.open(self.dst / 'publisher.lock',
                     os.O_RDWR | os.O_CREAT | state_snapshot.NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.relay('--apply', '--retain', '1'), 1)
            self.assertEqual(sorted(self.gens(self.dst)), before)
        finally:
            os.close(fd)
        self.apply(retain=1)
        self.assertEqual(len(self.gens(self.dst)), 2)
        self.assert_verified_destination()

    def test_unrelated_entries_and_symlink_targets_survive(self):
        stray = self.dst / 'unrelated-dir'
        stray.mkdir()
        (stray / 'keep.txt').write_text('FAKE keep\n')
        lookalike = self.dst / 'snap-20000101T000000Z-0badf00d'  # no manifest
        lookalike.mkdir()
        elsewhere = self.base / 'elsewhere'
        elsewhere.mkdir()
        (elsewhere / 'precious.txt').write_text('FAKE precious\n')
        (self.dst / 'snap-20010101T000000Z-1badf00d').symlink_to(elsewhere)
        (self.dst / 'foreign-link').symlink_to(self.src)
        for _ in range(4):
            self.publish()
            self.apply(retain=1)
        self.assertEqual(len(self.gens(self.dst)), 2)
        self.assertTrue(stray.is_dir())
        self.assertEqual((stray / 'keep.txt').read_text(), 'FAKE keep\n')
        self.assertTrue(lookalike.is_dir())
        self.assertTrue((self.dst / 'foreign-link').is_symlink())
        self.assertEqual((elsewhere / 'precious.txt').read_text(),
                         'FAKE precious\n')
        self.assert_verified_destination()

    def test_prune_failure_after_commit_is_reported_distinctly(self):
        for _ in range(2):
            self.publish()
            self.apply()
        before = set(self.gens(self.dst))
        self.publish()
        with mock.patch.object(snapshot_publish, 'prune',
                               side_effect=OSError('simulated prune crash')):
            result = snapshot_relay.relay(self.src, self.dst, True, retain=1)
        self.assertTrue(result['ok'])  # transfer and commit truthfully stand
        self.assertTrue(result['copied'])
        self.assertFalse(result['noop'])
        self.assertIn('simulated prune crash', result['retentionError'])
        self.assertNotIn('pruned', result)
        point = self.assert_verified_destination()
        self.assertEqual(point['generation'], result['generation'])
        self.assertEqual(set(self.gens(self.dst)),
                         before | {result['generation']})
        self.apply(retain=1)  # a later relay converges retention
        self.assertEqual(len(self.gens(self.dst)), 2)

    def test_help_mentions_retain(self):
        proc = subprocess.run([sys.executable, str(SCRIPT), '--help'],
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0)
        self.assertIn('--retain', proc.stdout)


if __name__ == '__main__':
    unittest.main()
