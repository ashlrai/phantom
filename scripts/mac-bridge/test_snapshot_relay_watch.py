import fcntl
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import state_snapshot  # noqa: E402
import snapshot_publish  # noqa: E402
import snapshot_relay  # noqa: E402
import snapshot_relay_watch  # noqa: E402

SCRIPT = HERE / 'snapshot_relay_watch.py'


class FakeClock:
    def __init__(self, start=1000.0):
        self.t = start
        self.waits = []

    def now(self):
        return self.t

    def wait(self, seconds):
        self.waits.append(seconds)
        self.t += seconds
        return False


class SnapshotRelayWatchTests(unittest.TestCase):
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

    def watch(self, *extra, deps=None):
        out = io.StringIO()
        code = snapshot_relay_watch.main(
            ['--source', str(self.src), '--destination', str(self.dst),
             *extra], deps, out)
        lines = [json.loads(line) for line in out.getvalue().splitlines()]
        return code, lines

    def pointer(self):
        target = self.dst / 'latest.json'
        return json.loads(target.read_bytes()) if target.exists() else None

    def assert_verified_destination(self, name):
        point = self.pointer()
        self.assertIsNotNone(point)
        self.assertEqual(point['generation'], name)
        check = state_snapshot.verify_snapshot(self.dst / name)
        self.assertTrue(check['ok'], check['errors'])
        self.assertFalse(check['manifest']['skipped'])
        self.assertEqual(point['manifestSha256'], state_snapshot.sha256_file(
            self.dst / name / 'manifest.json'))

    def test_two_publications_relayed_then_unchanged_poll_is_noop(self):
        first = self.publish()
        clock = FakeClock()
        calls = []

        def call(*argv):
            calls.append(argv)
            return snapshot_relay.relay(*argv)

        advanced = {'done': False}

        def wait(seconds):
            clock.waits.append(seconds)
            clock.t += seconds
            if not advanced['done']:
                advanced['done'] = True
                (self.root / 'queue/ready.tsv').write_text(
                    'job\tlane\njob-fake-2\tlane-new\n')
                self.publish()
            return False

        code, lines = self.watch(
            '--apply', '--interval', '5', '--deadline', '3600',
            '--max-cycles', '3',
            deps={'relay': call, 'now': clock.now, 'wait': wait})
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 3)
        cycles, summary = lines[:-1], lines[-1]
        self.assertEqual([r['outcome'] for r in cycles],
                         ['completed', 'completed', 'noop'])
        self.assertEqual(cycles[0]['generation'], first)
        second = cycles[1]['generation']
        self.assertNotEqual(second, first)
        self.assertEqual(summary, {'tool': 'snapshot_relay_watch', 'ok': True,
                                   'apply': True, 'cycles': 3, 'completed': 2,
                                   'noop': 1, 'failed': 0,
                                   'stopReason': 'max-cycles'})
        self.assert_verified_destination(second)
        for name in (first, second):
            check = state_snapshot.verify_snapshot(self.dst / name)
            self.assertTrue(check['ok'], check['errors'])
        self.assertEqual([p.name for p in self.dst.iterdir()
                          if '.relay-' in p.name or '.tmp' in p.name], [])

    def test_corrupt_source_preserves_pointer_and_repair_recovers(self):
        self.publish()
        clock = FakeClock()
        deps = {'now': clock.now, 'wait': clock.wait}
        code, _ = self.watch('--apply', '--max-cycles', '1', deps=deps)
        self.assertEqual(code, 0)
        before = (self.dst / 'latest.json').read_bytes()
        second = self.publish()
        victim = self.src / second / 'queue/ready.tsv'
        original = victim.read_bytes()
        data = bytearray(original)
        data[0] ^= 0xFF
        victim.write_bytes(bytes(data))
        code, lines = self.watch('--apply', '--max-cycles', '1', deps=deps)
        self.assertEqual(code, 1)
        self.assertEqual(lines[-1]['failed'], 1)
        self.assertEqual(lines[-1]['stopReason'], 'max-cycles')
        self.assertEqual((self.dst / 'latest.json').read_bytes(), before)
        victim.write_bytes(original)
        code, lines = self.watch('--apply', '--max-cycles', '1', deps=deps)
        self.assertEqual(code, 0)
        self.assert_verified_destination(second)

    def test_held_destination_lock_fails_cycle_then_recovers(self):
        self.publish()
        fd = os.open(self.dst / 'publisher.lock',
                     os.O_RDWR | os.O_CREAT | state_snapshot.NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            code, lines = self.watch(
                '--apply', '--max-cycles', '1',
                deps={'now': lambda: 1, 'wait': lambda s: False})
            self.assertEqual(code, 1)
            self.assertEqual(lines[-1]['failed'], 1)
            self.assertIsNone(self.pointer())
        finally:
            os.close(fd)
        code, _ = self.watch('--apply', '--max-cycles', '1',
                             deps={'now': lambda: 1, 'wait': lambda s: False})
        self.assertEqual(code, 0)
        self.assert_verified_destination(self.pointer()['generation'])

    def test_preview_cycles_write_nothing(self):
        self.publish()
        code, lines = self.watch(
            '--max-cycles', '2',
            deps={'now': lambda: 1, 'wait': lambda s: False})
        self.assertEqual(code, 0)
        self.assertEqual(lines[-1]['cycles'], 2)
        self.assertEqual([p.name for p in self.dst.iterdir()], [])
        self.assertIsNone(self.pointer())

    def test_deadline_bounds_lifetime_and_sleep(self):
        self.publish()
        clock = FakeClock()
        calls = []

        def call(*argv):
            calls.append(argv)
            return snapshot_relay.relay(*argv)

        code, lines = self.watch(
            '--apply', '--interval', '60', '--deadline', '10',
            deps={'relay': call, 'now': clock.now, 'wait': clock.wait})
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(clock.waits, [10])  # sleep capped at remaining lifetime
        self.assertEqual(lines[-1]['stopReason'], 'deadline')
        self.assertEqual(lines[-1]['cycles'], 1)

    def test_sigint_during_idle_stops_and_restores_handler(self):
        self.publish()
        stop = threading.Event()
        calls = []

        def call(*argv):
            calls.append(argv)
            return snapshot_relay.relay(*argv)

        prior = signal.getsignal(signal.SIGINT)

        def wait(seconds):
            os.kill(os.getpid(), signal.SIGINT)
            return stop.wait(seconds)

        code, lines = self.watch(
            '--apply', '--max-cycles', '5',
            deps={'relay': call, 'stop': stop, 'now': lambda: 1, 'wait': wait})
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(lines[-1]['stopReason'], 'stopped')
        self.assertIs(signal.getsignal(signal.SIGINT), prior)

    def test_interrupted_cycle_fails_and_stops_without_touching_pointer(self):
        self.publish()
        calls = []

        def call(*argv):
            calls.append(argv)
            raise KeyboardInterrupt

        code, lines = self.watch(
            '--apply', '--max-cycles', '5',
            deps={'relay': call, 'now': lambda: 1, 'wait': lambda s: False})
        self.assertEqual(code, 1)
        self.assertEqual(len(calls), 1)
        self.assertEqual(lines[-1]['cycles'], 1)
        self.assertEqual(lines[-1]['failed'], 1)
        self.assertEqual(lines[-1]['stopReason'], 'stopped')
        self.assertEqual([p.name for p in self.dst.iterdir()], [])

    def test_invalid_arguments_never_invoke_relay(self):
        calls = []
        deps = {'relay': lambda *a: calls.append(a),
                'now': lambda: 1, 'wait': lambda s: False}
        for extra in (['--interval', '0'], ['--interval', 'nan'],
                      ['--interval', 'inf'], ['--interval', '3601'],
                      ['--deadline', '0'], ['--deadline', '-5'],
                      ['--deadline', 'nan'], ['--deadline', '86401'],
                      ['--max-cycles', '0'], ['--max-cycles', '-1'],
                      ['--max-cycles', '10001'], ['--max-cycles', '1.5']):
            with self.subTest(extra=extra), self.assertRaises(SystemExit):
                self.watch(*extra, deps=deps)
        self.assertEqual(calls, [])

    def test_help_shows_fake_invocation(self):
        proc = subprocess.run([sys.executable, str(SCRIPT), '--help'],
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0)
        self.assertIn('/tmp/fake-standby', proc.stdout)
        for flag in ('--source', '--destination', '--apply', '--interval',
                     '--deadline', '--max-cycles'):
            self.assertIn(flag, proc.stdout)


if __name__ == '__main__':
    unittest.main()
