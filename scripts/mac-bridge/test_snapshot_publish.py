import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import state_snapshot  # noqa: E402
import snapshot_publish  # noqa: E402

SCRIPT = HERE / 'snapshot_publish.py'


class SnapshotPublishTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'fleet-state'
        self.dest = self.base / 'snapshots'
        self.dest.mkdir()
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

    def args(self, *extra):
        return ['--root', str(self.root), '--destination', str(self.dest), *extra]

    def pointer(self):
        target = self.dest / 'latest.json'
        return json.loads(target.read_bytes()) if target.exists() else None

    def gens(self):
        return [p.name for p in snapshot_publish.generations(self.dest)]

    def current(self):
        point = self.pointer()
        self.assertIsNotNone(point)
        gen = self.dest / point['generation']
        check = state_snapshot.verify_snapshot(gen)
        self.assertTrue(check['ok'], check['errors'])
        self.assertEqual(point['manifestSha256'],
                         state_snapshot.sha256_file(gen / 'manifest.json'))
        return point, gen

    def test_two_cycles_update_pointer_and_changed_queue(self):
        self.assertEqual(snapshot_publish.main(self.args('--once')), 0)
        first, gen1 = self.current()
        path = self.root / 'queue/ready.tsv'
        path.write_text('job\tlane\njob-fake-2\tlane-new\n')
        self.assertEqual(snapshot_publish.main(self.args('--once')), 0)
        second, gen2 = self.current()
        self.assertNotEqual(first['generation'], second['generation'])
        self.assertEqual((gen2 / 'queue/ready.tsv').read_bytes(), path.read_bytes())
        self.assertTrue(gen1.is_dir())  # prior verified generation retained
        self.assertTrue(state_snapshot.verify_snapshot(gen1)['ok'])

    def test_incomplete_snapshot_never_becomes_latest(self):
        self.assertEqual(snapshot_publish.main(self.args('--once')), 0)
        before = self.pointer()
        (self.root / 'leader/VISION.md').unlink()
        with (self.root / 'metrics/jobs.jsonl').open('wb') as handle:
            handle.truncate(state_snapshot.MAX_FILE_BYTES + 1)
        self.assertEqual(snapshot_publish.main(self.args('--once')), 1)
        self.assertEqual(self.pointer(), before)
        self.assertEqual(len(self.gens()), 1)  # partial generation removed
        # Adopt also refuses a manually created verified-but-incomplete gen.
        name = 'snap-20990101T000001Z-bad0bad0'
        state_snapshot.create(self.root, self.dest / name)
        outcome = snapshot_publish.adopt(self.dest, name)
        self.assertFalse(outcome['ok'])
        self.assertTrue(outcome['skipped'])
        self.assertEqual(self.pointer(), before)

    def test_corrupt_generation_cannot_replace_latest(self):
        self.assertEqual(snapshot_publish.main(self.args('--once')), 0)
        before = self.pointer()
        name = 'snap-20990101T000000Z-bad0bad0'
        state_snapshot.create(self.root, self.dest / name)
        victim = self.dest / name / 'queue/ready.tsv'
        data = bytearray(victim.read_bytes())
        data[0] ^= 0xFF
        victim.write_bytes(bytes(data))
        self.assertFalse(snapshot_publish.adopt(self.dest, name)['ok'])
        self.assertEqual(self.pointer(), before)

    def test_interrupted_publication_preserves_old_pointer(self):
        self.assertEqual(snapshot_publish.main(self.args('--once')), 0)
        before = (self.dest / 'latest.json').read_bytes()
        with mock.patch.object(snapshot_publish, 'commit_pointer',
                               side_effect=OSError('simulated crash')):
            self.assertEqual(snapshot_publish.main(self.args('--once')), 1)
        self.assertEqual((self.dest / 'latest.json').read_bytes(), before)
        self.assertEqual(len(self.gens()), 1)  # unadopted generation cleaned up

    def test_competing_publisher_denied(self):
        fd = os.open(self.dest / 'publisher.lock',
                     os.O_RDWR | os.O_CREAT | state_snapshot.NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(snapshot_publish.main(self.args('--once')), 1)
            self.assertIsNone(self.pointer())
            self.assertEqual(self.gens(), [])
        finally:
            os.close(fd)
        self.assertEqual(snapshot_publish.main(self.args('--once')), 0)

    def test_retention_preserves_unrelated_and_latest(self):
        stray = self.dest / 'unrelated-dir'
        stray.mkdir()
        (stray / 'keep.txt').write_text('FAKE keep\n')
        (self.dest / 'foreign-link').symlink_to(self.root)
        lookalike = self.dest / 'snap-20000101T000000Z-0badf00d'  # no manifest
        lookalike.mkdir()
        for _ in range(3):
            self.assertEqual(
                snapshot_publish.main(self.args('--retain', '1', '--once')), 0)
        point, gen = self.current()
        surviving = self.gens()
        self.assertEqual(len(surviving), 2)  # latest plus one retained prior
        self.assertIn(gen.name, surviving)
        self.assertTrue(stray.is_dir())
        self.assertTrue(lookalike.is_dir())
        self.assertTrue((self.dest / 'foreign-link').is_symlink())
        for name in surviving:
            self.assertTrue(
                state_snapshot.verify_snapshot(self.dest / name)['ok'], name)

    def test_cancellation_leaves_no_partial_pointer(self):
        for sig in (signal.SIGINT, signal.SIGTERM):
            dest = self.base / f'snaps-{sig}'
            dest.mkdir()
            proc = subprocess.Popen(
                [sys.executable, str(SCRIPT), '--root', str(self.root),
                 '--destination', str(dest), '--interval', '60'],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                deadline = time.time() + 15
                while not (dest / 'latest.json').exists() \
                        and time.time() < deadline and proc.poll() is None:
                    time.sleep(0.05)
                proc.send_signal(sig)
                out, err = proc.communicate(timeout=15)
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
            self.assertEqual(proc.returncode, 0, err)
            self.assertNotIn('job-fake-1', out + err)  # never file contents
            leftovers = [p.name for p in dest.iterdir()
                         if '.tmp' in p.name or '.staging-' in p.name]
            self.assertEqual(leftovers, [])
            point = json.loads((dest / 'latest.json').read_bytes())
            check = state_snapshot.verify_snapshot(dest / point['generation'])
            self.assertTrue(check['ok'], check['errors'])

    def test_help_and_destination_validation(self):
        proc = subprocess.run([sys.executable, str(SCRIPT), '--help'],
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0)
        self.assertIn('--destination', proc.stdout)
        self.assertIn('transport', proc.stdout)
        self.assertEqual(snapshot_publish.main(
            self.args('--once', '--destination', str(self.base / 'nope'))), 1)
        inside = self.root / 'snaps'
        inside.mkdir()
        self.assertEqual(snapshot_publish.main(
            ['--root', str(self.root), '--destination', str(inside), '--once']), 1)


if __name__ == '__main__':
    unittest.main()
