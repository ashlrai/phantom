import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import state_snapshot  # noqa: E402
import snapshot_publish  # noqa: E402
import snapshot_relay  # noqa: E402
import snapshot_relay_watch  # noqa: E402

# Arbitrary exception text a real prune failure could carry; it must never
# reach the watcher's stdout or stderr, only the bounded retention signal.
SENTINEL = 'SENTINEL-arbitrary-prune-text-9f3a2b7d'


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


class SnapshotRelayWatchRetentionHealthTests(unittest.TestCase):
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
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(err):
            code = snapshot_relay_watch.main(
                ['--source', str(self.src), '--destination', str(self.dst),
                 *extra], deps, out)
        lines = [json.loads(line) for line in out.getvalue().splitlines()]
        return code, lines, out.getvalue() + err.getvalue()

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

    def test_completed_copy_with_prune_failure_exits_nonzero(self):
        generation = self.publish()
        with mock.patch.object(snapshot_publish, 'prune',
                               side_effect=OSError(SENTINEL)):
            code, lines, emitted = self.watch(
                '--apply', '--max-cycles', '1',
                deps={'now': lambda: 1, 'wait': lambda s: False})
        cycle, summary = lines
        self.assertEqual(code, 1)
        self.assertEqual(cycle['outcome'], 'completed')
        self.assertEqual(cycle['generation'], generation)
        self.assertIs(cycle['copied'], True)
        self.assertIs(cycle['retentionOk'], False)
        self.assertEqual(summary['completed'], 1)
        self.assertEqual(summary['failed'], 0)
        self.assertEqual(summary['retentionFailed'], 1)
        self.assertEqual(summary['retentionReason'], 'prune')
        self.assertIs(summary['ok'], False)
        self.assertNotIn(SENTINEL, emitted)
        # The committed pointer and copied generation still stand.
        self.assert_verified_destination(generation)

    def test_noop_apply_with_prune_failure_exits_nonzero(self):
        generation = self.publish()
        deps = {'now': lambda: 1, 'wait': lambda s: False}
        code, _, _ = self.watch('--apply', '--max-cycles', '1', deps=deps)
        self.assertEqual(code, 0)
        self.assert_verified_destination(generation)
        before = (self.dst / 'latest.json').read_bytes()
        with mock.patch.object(snapshot_publish, 'prune',
                               side_effect=RuntimeError(SENTINEL)):
            code, lines, emitted = self.watch(
                '--apply', '--max-cycles', '1', deps=deps)
        cycle, summary = lines
        self.assertEqual(code, 1)
        self.assertEqual(cycle['outcome'], 'noop')
        self.assertNotIn('copied', cycle)
        self.assertIs(cycle['retentionOk'], False)
        self.assertEqual(summary['noop'], 1)
        self.assertEqual(summary['failed'], 0)
        self.assertEqual(summary['retentionFailed'], 1)
        self.assertIs(summary['ok'], False)
        self.assertNotIn(SENTINEL, emitted)
        self.assertEqual((self.dst / 'latest.json').read_bytes(), before)

    def test_retention_recovers_next_cycle_without_erasing_count(self):
        self.publish()
        real_prune = snapshot_publish.prune
        clock = FakeClock()
        with mock.patch.object(snapshot_publish, 'prune',
                               side_effect=[OSError(SENTINEL), real_prune]):
            code, lines, emitted = self.watch(
                '--apply', '--interval', '5', '--deadline', '600',
                '--max-cycles', '2',
                deps={'now': clock.now, 'wait': clock.wait})
        first, second, summary = lines
        self.assertEqual(code, 1)
        self.assertEqual(first['outcome'], 'completed')
        self.assertIs(first['retentionOk'], False)
        # A later healthy retention cycle is visible in its own record.
        self.assertEqual(second['outcome'], 'noop')
        self.assertIs(second['retentionOk'], True)
        # The earlier failure count is not erased by recovery.
        self.assertEqual(summary['retentionFailed'], 1)
        self.assertIs(summary['ok'], False)
        self.assertNotIn(SENTINEL, emitted)
        self.assert_verified_destination(second['generation'])

    def test_clean_apply_run_keeps_prior_output_shape(self):
        self.publish()
        results = iter([
            {'tool': 'snapshot_relay', 'ok': True, 'apply': True,
             'noop': False, 'copied': True, 'generation': 'snap-fake-1',
             'files': 3, 'retain': 3, 'pruned': []},
            {'tool': 'snapshot_relay', 'ok': True, 'apply': True,
             'noop': True, 'generation': 'snap-fake-1', 'files': 3,
             'retain': 3, 'pruned': []},
        ])
        code, lines, _ = self.watch(
            '--apply', '--max-cycles', '2',
            deps={'relay': lambda *a: next(results),
                  'now': lambda: 1, 'wait': lambda s: False})
        first, second, summary = lines
        self.assertEqual(code, 0)
        self.assertIs(first['retentionOk'], True)
        self.assertIs(second['retentionOk'], True)
        self.assertEqual(summary, {'tool': 'snapshot_relay_watch',
                                   'ok': True, 'apply': True, 'cycles': 2,
                                   'completed': 1, 'noop': 1, 'failed': 0,
                                   'stopReason': 'max-cycles'})

    def test_failed_transfer_cycles_carry_no_retention_signal(self):
        results = iter([OSError('simulated copy crash'), {'ok': False}])

        def call(*a):
            item = next(results)
            if isinstance(item, Exception):
                raise item
            return item

        code, lines, emitted = self.watch(
            '--apply', '--max-cycles', '2',
            deps={'relay': call, 'now': lambda: 1, 'wait': lambda s: False})
        self.assertEqual(code, 1)
        self.assertEqual([r['outcome'] for r in lines[:2]],
                         ['failed', 'failed'])
        for record in lines[:2]:
            self.assertNotIn('retentionOk', record)
        summary = lines[-1]
        self.assertEqual(summary['failed'], 2)
        self.assertNotIn('retentionFailed', summary)
        self.assertNotIn('simulated copy crash', emitted)

    def test_preview_cycles_have_no_retention_signal_and_write_nothing(self):
        self.publish()
        code, lines, _ = self.watch(
            '--max-cycles', '2',
            deps={'now': lambda: 1, 'wait': lambda s: False})
        self.assertEqual(code, 0)
        self.assertEqual([r['outcome'] for r in lines[:-1]],
                         ['completed', 'completed'])
        for record in lines[:-1]:
            self.assertNotIn('retentionOk', record)
            self.assertNotIn('copied', record)
        summary = lines[-1]
        self.assertEqual(summary['cycles'], 2)
        self.assertNotIn('retentionFailed', summary)
        self.assertIs(summary['ok'], True)
        self.assertEqual([p.name for p in self.dst.iterdir()], [])
        self.assertIsNone(self.pointer())

    def test_retention_error_on_any_result_flags_the_run(self):
        # A result carrying retentionError flags the run nonzero whenever it
        # appears, while its arbitrary text stays out of the output.
        result = {'tool': 'snapshot_relay', 'ok': True, 'apply': False,
                  'noop': False, 'generation': 'snap-fake-1', 'files': 0,
                  'retentionError': SENTINEL}
        code, lines, emitted = self.watch(
            '--max-cycles', '1',
            deps={'relay': lambda *a: dict(result),
                  'now': lambda: 1, 'wait': lambda s: False})
        cycle, summary = lines
        self.assertEqual(code, 1)
        self.assertIs(cycle['retentionOk'], False)
        self.assertEqual(summary['retentionFailed'], 1)
        self.assertEqual(summary['retentionReason'], 'prune')
        self.assertIs(summary['ok'], False)
        self.assertNotIn(SENTINEL, emitted)


if __name__ == '__main__':
    unittest.main()
