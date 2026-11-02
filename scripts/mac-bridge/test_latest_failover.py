import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import latest_failover  # noqa: E402
import snapshot_publish  # noqa: E402
import state_snapshot  # noqa: E402

FAKE_FILES = {'queue/router-queue.md': 'Q\n', 'queue/ready.tsv': 'F\n',
              'queue/slots.json': '{}\n', 'leader/VISION.md': 'FAKE vision\n',
              'leader/ORCHESTRATION.md': 'O\n', 'metrics/jobs.jsonl': '{}\n'}


class LatestFailoverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'fleet-state'
        self.store = self.base / 'snapshots'
        self.store.mkdir()
        (self.base / 'restore').mkdir()
        for rel, text in FAKE_FILES.items():
            path = self.root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        self.calls, self.pinned, self.kept, self.run_result = [], [], [], 0

    def publish(self):
        self.assertEqual(snapshot_publish.main(
            ['--root', str(self.root), '--destination', str(self.store),
             '--once']), 0)
        return json.loads((self.store / 'latest.json').read_bytes())

    def repoint(self, point):
        snapshot_publish.commit_pointer(self.store, json.dumps({
            'version': 1, 'tool': 'snapshot_publish', 'files': point['files'],
            'generation': point['generation'], 'published': 0,
            'manifestSha256': point['manifestSha256']}).encode())

    def argv(self, *extra):
        return ['--snapshot-store', str(self.store), '--db',
                str(self.base / 'leases.sqlite'), '--host', 'standby',
                '--primary', 'primary', '--role', 'leader', '--restore-root',
                str(self.base / 'restore'), *extra, '--', sys.executable,
                '-c', 'pass']

    def capture(self, argv):
        # The pin is reaped when main returns; read it at the boundary.
        self.calls.append(argv)
        snap = Path(argv[argv.index('--snapshot') + 1])
        self.pinned.append(snap)
        self.kept.append(((snap / 'leader/VISION.md').read_bytes(),
                          state_snapshot.sha256_file(snap / 'manifest.json')))
        return self.run_result

    def run_main(self, *extra):
        with mock.patch.object(latest_failover, 'run_supervisor',
                               side_effect=self.capture):
            return latest_failover.main(self.argv(*extra))

    def reject(self):
        self.assertNotEqual(self.run_main(), 0)
        self.assertEqual(self.calls, [])

    def test_resolves_latest_and_pinned_bytes_reach_supervisor(self):
        point1 = self.publish()
        self.assertEqual(self.run_main(), 0)
        argv = self.calls[-1]
        self.assertEqual(argv[:2],
                         [sys.executable, str(latest_failover.SUPERVISOR)])
        self.assertNotIn('--apply', argv)
        self.assertEqual(self.kept[-1],
                         (b'FAKE vision\n', point1['manifestSha256']))
        # A second generation with new bytes is selected on the next call.
        (self.root / 'leader/VISION.md').write_text('FAKE vision two\n')
        point2 = self.publish()
        self.assertEqual(self.run_main(), 0)
        self.assertNotEqual(point1['generation'], point2['generation'])
        self.assertEqual(self.kept[-1],
                         (b'FAKE vision two\n', point2['manifestSha256']))
        self.assertFalse(any(snap.exists() for snap in self.pinned))

    def test_forwarding_preview_apply_and_child_argv(self):
        self.publish()
        done = []

        def real(argv):
            done.append(subprocess.run(argv, capture_output=True, text=True))
            return done[-1].returncode

        extra = ['--ttl', '9', '--grace', '3', '--duration', '8',
                 '--attempts', '2', '--retry-interval', '2']
        with mock.patch.object(latest_failover, 'run_supervisor',
                               side_effect=real):
            self.assertEqual(latest_failover.main(self.argv(*extra)), 0)
        argv = done[-1].args
        self.assertEqual([f for f in extra[::2] if f in argv], extra[::2])
        self.assertNotIn('--apply', argv[:argv.index('--')])
        self.assertEqual(done[-1].stdout.strip(), 'preview')
        self.assertEqual(self.run_main('--apply'), 0)
        argv = self.calls[-1]
        self.assertIn('--apply', argv[:argv.index('--')])
        # '--apply' after '--' belongs to the child, not the supervisor.
        child = ['--', sys.executable, '-c', 'pass', '--apply']
        with mock.patch.object(latest_failover, 'run_supervisor',
                               side_effect=self.capture):
            self.assertEqual(latest_failover.main(self.argv()[:-4] + child), 0)
        argv = self.calls[-1]
        self.assertNotIn('--apply', argv[:argv.index('--')])
        self.assertEqual(argv[argv.index('--') + 1:], child[1:])

    def test_pointer_rejections(self):
        self.reject()  # no latest.json at all
        base = {'version': 1, 'tool': 'snapshot_publish', 'files': 6,
                'generation': 'snap-20000101T000000Z-0badf00d',
                'manifestSha256': '0' * 64}
        for payload in ['not json', '{}', {**base, 'version': 2},
                        {**base, 'tool': 'x'}, {**base, 'generation': '../x'},
                        {**base, 'manifestSha256': 'x'},
                        'x' * (latest_failover.MAX_POINTER_BYTES + 1)]:
            if not isinstance(payload, str):
                payload = json.dumps(payload)
            (self.store / 'latest.json').write_text(payload)
            self.reject()
        self.publish()
        (self.store / 'latest.json').rename(self.base / 'real-pointer.json')
        (self.store / 'latest.json').symlink_to(self.base / 'real-pointer.json')
        self.reject()  # the pointer itself must be a regular file

    def test_generation_rejections(self):
        point = self.publish()
        other = state_snapshot.sha256_file(self.root / 'leader/VISION.md')
        for bad in ('0' * 64, other):
            self.repoint({**point, 'manifestSha256': bad})
            self.reject()
        # A generation dir replaced by a symlink resolves outside the store.
        self.repoint(point)
        outside = self.base / 'outside'
        shutil.move(self.store / point['generation'], outside)
        (self.store / point['generation']).symlink_to(outside)
        self.reject()
        # An incomplete generation verifies yet never launches.
        (self.store / point['generation']).unlink()
        (self.root / 'leader/VISION.md').unlink()
        name = 'snap-20990101T000000Z-bad0bad0'
        state_snapshot.create(self.root, self.store / name)
        self.assertTrue(state_snapshot.verify_snapshot(self.store / name)['ok'])
        digest = state_snapshot.sha256_file(self.store / name / 'manifest.json')
        self.repoint({'generation': name, 'files': 5, 'manifestSha256': digest})
        self.reject()

    def test_store_and_flag_rejections(self):
        (self.base / 'link').symlink_to(self.store)
        with mock.patch.object(latest_failover, 'run_supervisor',
                               side_effect=self.capture):
            for bad in (str(self.base / 'link'), str(self.base / 'nope')):
                args = self.argv()
                args[args.index('--snapshot-store') + 1] = bad
                self.assertNotEqual(latest_failover.main(args), 0)
        self.assertEqual(self.calls, [])
        for bad in ('--snapshot', '--snapshot=x'):
            with self.assertRaises(SystemExit):
                latest_failover.main(self.argv(bad))

    def test_rotation_and_prune_during_selection(self):
        point1 = self.publish()
        (self.root / 'leader/VISION.md').write_text('FAKE vision two\n')
        point2 = self.publish()
        self.repoint(point1)  # latest.json back on generation one
        real_copy = latest_failover.copy_generation

        def rotate(src, dst):
            self.repoint(point2)  # pointer flips; the pin keeps gen one's bytes
            real_copy(src, dst)

        def prune(src, dst):
            shutil.rmtree(src)      # reaped before the pin: fail closed
            real_copy(src, dst)

        def prune_after(src, dst):
            real_copy(src, dst)
            shutil.rmtree(src)      # reaped after the pin: bytes survive

        with mock.patch.object(latest_failover, 'copy_generation') as mcopy:
            mcopy.side_effect = rotate
            self.assertEqual(self.run_main(), 0)
            self.assertEqual(self.kept[-1], (b'FAKE vision\n',
                                             point1['manifestSha256']))
            mcopy.side_effect = prune
            self.assertNotEqual(self.run_main(), 0)
            self.assertEqual(len(self.calls), 1)
            point3 = self.publish()
            mcopy.side_effect = prune_after
            self.assertEqual(self.run_main(), 0)
        self.assertEqual(self.kept[-1], (b'FAKE vision two\n',
                                         point3['manifestSha256']))

    def test_failure_propagates_and_pin_is_reaped(self):
        self.publish()
        self.run_result = 7
        self.assertEqual(self.run_main(), 7)
        self.assertFalse(self.pinned[-1].exists())
        with mock.patch.object(latest_failover, 'run_supervisor',
                               side_effect=RuntimeError('boom')):
            with self.assertRaises(RuntimeError):
                latest_failover.main(self.argv())
        leftovers = [p for p in Path(tempfile.gettempdir()).iterdir()
                     if p.name.startswith('latest-failover-')]
        self.assertEqual(leftovers, [])


if __name__ == '__main__':
    unittest.main()
