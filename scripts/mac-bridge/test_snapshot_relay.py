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


class SnapshotRelayTests(unittest.TestCase):
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
        self.publisher = snapshot_publish.Publisher(self.root, self.src, 60, 3)

    def publish(self):
        outcome = self.publisher.cycle()
        self.assertTrue(outcome['ok'], outcome)
        return outcome['generation']

    def relay(self, *extra):
        return snapshot_relay.main(
            ['--source', str(self.src), '--destination', str(self.dst), *extra])

    def pointer(self, store):
        target = store / 'latest.json'
        return json.loads(target.read_bytes()) if target.exists() else None

    def assert_verified_destination(self, name=None):
        point = self.pointer(self.dst)
        self.assertIsNotNone(point)
        if name:
            self.assertEqual(point['generation'], name)
        gen = self.dst / point['generation']
        check = state_snapshot.verify_snapshot(gen)
        self.assertTrue(check['ok'], check['errors'])
        self.assertFalse(check['manifest']['skipped'])
        self.assertEqual(point['manifestSha256'],
                         state_snapshot.sha256_file(gen / 'manifest.json'))
        return point, gen

    def leftovers(self):
        return [p.name for p in self.dst.iterdir()
                if '.relay-' in p.name or '.tmp' in p.name]

    def test_relay_publishes_verified_generation(self):
        name = self.publish()
        self.assertEqual(self.relay('--apply'), 0)
        point, gen = self.assert_verified_destination(name)
        for rel in state_snapshot.ALLOW_LIST:
            self.assertEqual((gen / rel).read_bytes(),
                             (self.src / name / rel).read_bytes())
        self.assertEqual(self.leftovers(), [])

    def test_second_identical_relay_is_noop(self):
        self.publish()
        self.assertEqual(self.relay('--apply'), 0)
        before = (self.dst / 'latest.json').read_bytes()
        self.assertEqual(self.relay('--apply'), 0)
        self.assertEqual((self.dst / 'latest.json').read_bytes(), before)

    def test_preview_creates_nothing(self):
        self.publish()
        self.assertEqual(self.relay(), 0)  # no --apply
        self.assertEqual([p.name for p in self.dst.iterdir()], [])
        self.assertIsNone(self.pointer(self.dst))

    def test_tampered_source_generation_preserves_prior_latest(self):
        self.publish()
        self.assertEqual(self.relay('--apply'), 0)
        before = (self.dst / 'latest.json').read_bytes()
        victim = self.src / json.loads(before)['generation'] / 'queue/ready.tsv'
        data = bytearray(victim.read_bytes())
        data[0] ^= 0xFF
        victim.write_bytes(bytes(data))
        self.assertEqual(self.relay('--apply'), 1)
        self.assertEqual((self.dst / 'latest.json').read_bytes(), before)
        self.assert_verified_destination()
        self.assertEqual(self.leftovers(), [])

    def test_interrupted_copy_preserves_prior_latest(self):
        self.publish()
        self.assertEqual(self.relay('--apply'), 0)
        before = (self.dst / 'latest.json').read_bytes()
        (self.root / 'queue/ready.tsv').write_text(
            'job\tlane\njob-fake-2\tlane-new\n')
        self.publish()
        with mock.patch.object(snapshot_relay, 'copy_generation',
                               side_effect=OSError('simulated crash')):
            self.assertEqual(self.relay('--apply'), 1)
        self.assertEqual((self.dst / 'latest.json').read_bytes(), before)
        point, _ = self.assert_verified_destination()
        self.assertEqual(point['generation'], json.loads(before)['generation'])
        self.assertEqual(self.leftovers(), [])

    def test_source_changed_mid_copy_is_refused(self):
        self.publish()
        self.assertEqual(self.relay('--apply'), 0)
        before = (self.dst / 'latest.json').read_bytes()
        self.publish()
        real = snapshot_relay.copy_generation

        def drift(src, dst):
            (src / 'leader/VISION.md').write_text('FAKE drifted vision\n')
            real(src, dst)

        with mock.patch.object(snapshot_relay, 'copy_generation',
                               side_effect=drift):
            self.assertEqual(self.relay('--apply'), 1)
        self.assertEqual((self.dst / 'latest.json').read_bytes(), before)
        self.assert_verified_destination()
        self.assertEqual(self.leftovers(), [])

    def test_competing_relays_cannot_publish_partial_output(self):
        self.publish()
        fd = os.open(self.dst / 'publisher.lock',
                     os.O_RDWR | os.O_CREAT | state_snapshot.NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.relay('--apply'), 1)
            self.assertIsNone(self.pointer(self.dst))
            self.assertEqual([p.name for p in self.dst.iterdir()
                              if p.name != 'publisher.lock'], [])
        finally:
            os.close(fd)
        self.assertEqual(self.relay('--apply'), 0)
        self.assert_verified_destination()

    def test_refusals(self):
        for bad in ('source', 'destination'):
            link = self.base / f'{bad}-link'
            link.symlink_to(self.src if bad == 'source' else self.dst)
            args = ['--source', str(link if bad == 'source' else self.src),
                    '--destination',
                    str(link if bad == 'destination' else self.dst), '--apply']
            self.assertEqual(snapshot_relay.main(args), 1, bad)
        nested = self.src / 'inside'
        nested.mkdir()
        self.assertEqual(snapshot_relay.main(
            ['--source', str(self.src), '--destination', str(nested),
             '--apply']), 1)
        self.assertEqual(snapshot_relay.main(
            ['--source', str(self.src), '--destination', str(self.src),
             '--apply']), 1)
        # Verified but incomplete generation is refused.
        (self.root / 'leader/VISION.md').unlink()
        name = 'snap-20990101T000000Z-bad0bad0'
        state_snapshot.create(self.root, self.src / name)
        digest = state_snapshot.sha256_file(self.src / name / 'manifest.json')
        pointer = {'version': 1, 'tool': 'snapshot_publish', 'generation': name,
                   'manifestSha256': digest, 'files': 5, 'published': 1.0}
        (self.src / 'latest.json').write_text(json.dumps(pointer))
        self.assertEqual(self.relay('--apply'), 1)
        self.assertIsNone(self.pointer(self.dst))

    def test_help_shows_fake_invocation(self):
        proc = subprocess.run([sys.executable, str(SCRIPT), '--help'],
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0)
        self.assertIn('/tmp/fake-snaps', proc.stdout)
        self.assertIn('--apply', proc.stdout)
        self.assertIn('--source', proc.stdout)
        self.assertIn('--destination', proc.stdout)


if __name__ == '__main__':
    unittest.main()
