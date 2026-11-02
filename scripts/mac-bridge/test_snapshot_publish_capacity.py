"""Free-space admission contracts for the periodic snapshot publisher.

All disk telemetry is injected; no real filesystem space is consumed beyond a
few fixture bytes in a temporary tree.
"""

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import state_snapshot  # noqa: E402
import snapshot_publish  # noqa: E402

GIB = 1 << 30


class Probe:
    """Scripted available-bytes telemetry; set .available between cycles."""

    def __init__(self, available):
        self.available = available
        self.calls = 0

    def __call__(self, path):
        self.calls += 1
        return self.available


class CapacityAdmissionTests(unittest.TestCase):
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

    def publisher(self, probe, reserve=1024):
        return snapshot_publish.Publisher(self.root, self.dest, 60, 3,
                                          reserve=reserve, probe=probe)

    def names(self):
        return sorted(p.name for p in self.dest.iterdir())

    def pointer(self):
        target = self.dest / 'latest.json'
        return target.read_bytes() if target.exists() else None

    def required(self):
        return snapshot_publish.estimate_required_bytes(self.root)

    def test_estimate_bills_regular_sources_at_cap(self):
        cap = state_snapshot.MAX_FILE_BYTES
        expected = len(state_snapshot.ALLOW_LIST) * cap \
            + state_snapshot.MAX_MANIFEST_BYTES \
            + snapshot_publish.STAGING_TMP_BYTES
        self.assertEqual(self.required(), expected)
        (self.root / 'leader/VISION.md').unlink()
        self.assertEqual(self.required(), expected - cap)
        (self.root / 'queue/ready.tsv').write_bytes(b'x' * (cap + 7))
        self.assertEqual(self.required(), expected - cap)  # still billed at cap

    def test_insufficient_space_skips_and_preserves_everything(self):
        probe = Probe(1 << 60)
        pub = self.publisher(probe)
        self.assertTrue(pub.cycle()['ok'])
        pointer, names = self.pointer(), self.names()
        probe.available = 0
        report = pub.cycle()
        self.assertFalse(report['ok'])
        self.assertEqual(report['reason'], 'insufficient-free-space')
        self.assertEqual(report['availableBytes'], 0)
        self.assertEqual(report['requiredBytes'], self.required())
        self.assertEqual(report['reserveBytes'], 1024)
        self.assertEqual(report['cycle'], 2)
        self.assertEqual(self.pointer(), pointer)
        self.assertEqual(self.names(), names)  # no staging, no new generation
        point = json.loads(pointer)
        check = state_snapshot.verify_snapshot(self.dest / point['generation'])
        self.assertTrue(check['ok'], check['errors'])

    def test_exact_boundary_admits_one_byte_less_denies(self):
        required, reserve = self.required(), 4096
        admitted = self.publisher(Probe(required + reserve), reserve).cycle()
        self.assertTrue(admitted['ok'], admitted)
        pointer, names = self.pointer(), self.names()
        denied = self.publisher(Probe(required + reserve - 1), reserve).cycle()
        self.assertFalse(denied['ok'])
        self.assertEqual(denied['reason'], 'insufficient-free-space')
        self.assertEqual(self.pointer(), pointer)
        self.assertEqual(self.names(), names)

    def test_unreadable_or_missing_telemetry_skips(self):
        for bad in (None, -1, 'full', True):
            report = self.publisher(Probe(bad)).cycle()
            self.assertFalse(report['ok'])
            self.assertEqual(report['reason'], 'telemetry-unavailable')
            self.assertNotIn('availableBytes', report)

        def raising(path):
            raise OSError('simulated statvfs failure')

        report = self.publisher(raising).cycle()
        self.assertFalse(report['ok'])
        self.assertEqual(report['reason'], 'telemetry-unavailable')
        self.assertEqual(self.names(), [])
        self.assertIsNone(self.pointer())

    def test_recheck_immediately_before_create(self):
        probe = mock.Mock(side_effect=[1 << 60, 0])
        report = self.publisher(probe).cycle()
        self.assertFalse(report['ok'])
        self.assertEqual(report['reason'], 'insufficient-free-space')
        self.assertEqual(probe.call_count, 2)
        self.assertEqual(self.names(), [])  # denial left no staging remnants
        self.assertIsNone(self.pointer())

    def test_later_cycle_publishes_once_space_returns(self):
        probe = Probe(0)
        pub = self.publisher(probe)
        denied = pub.cycle()
        self.assertFalse(denied['ok'])
        self.assertEqual(denied['reason'], 'insufficient-free-space')
        probe.available = 1 << 60
        report = pub.cycle()
        self.assertTrue(report['ok'], report)
        point = json.loads(self.pointer())
        self.assertEqual(point['generation'], report['generation'])
        check = state_snapshot.verify_snapshot(self.dest / point['generation'])
        self.assertTrue(check['ok'], check['errors'])

    def test_denial_never_prunes_prior_generations(self):
        probe = Probe(1 << 60)
        pub = self.publisher(probe, reserve=1024)
        pub.retain = 1
        self.assertTrue(pub.cycle()['ok'])
        self.assertTrue(pub.cycle()['ok'])
        survivors = self.names()
        probe.available = self.required()  # fits the copy, not the reserve
        report = pub.cycle()
        self.assertFalse(report['ok'])
        self.assertEqual(report['reason'], 'insufficient-free-space')
        self.assertEqual(self.names(), survivors)

    def test_mid_copy_enospc_preserves_pointer(self):
        probe = Probe(1 << 60)
        pub = self.publisher(probe)
        self.assertTrue(pub.cycle()['ok'])
        pointer = self.pointer()
        with mock.patch.object(
                state_snapshot, 'create',
                side_effect=OSError(28, 'No space left on device')):
            report = pub.cycle()
        self.assertFalse(report['ok'])
        self.assertIn('error', report)
        self.assertEqual(self.pointer(), pointer)
        self.assertEqual(len(snapshot_publish.generations(self.dest)), 1)

    def test_main_wires_flag_and_real_tree_restores_after_denial(self):
        args = ['--root', str(self.root), '--destination', str(self.dest)]
        self.assertEqual(snapshot_publish.main(args + ['--once']), 0)
        point = json.loads(self.pointer())
        gen = self.dest / point['generation']
        with mock.patch.object(snapshot_publish, 'available_bytes',
                               return_value=0):
            rc = snapshot_publish.main(args + ['--once', '--reserve-bytes', '1K'])
        self.assertEqual(rc, 1)
        self.assertEqual(json.loads(self.pointer()), point)
        check = state_snapshot.verify_snapshot(gen)
        self.assertTrue(check['ok'], check['errors'])
        target = self.base / 'restored'
        result = state_snapshot.restore(gen, target, apply=True)
        self.assertTrue(result['ok'], result['errors'])
        for entry in check['manifest']['files']:
            self.assertEqual((target / entry['path']).read_bytes(),
                             (gen / entry['path']).read_bytes())

    def test_reserve_flag_parsing_and_validation(self):
        parse = snapshot_publish.parse_reserve
        self.assertEqual(parse('0'), 0)
        self.assertEqual(parse('1048576'), 1 << 20)
        self.assertEqual(parse('512M'), 512 << 20)
        self.assertEqual(parse('1GiB'), GIB)
        self.assertEqual(parse('2t'), 2 << 40)
        for bad in ('-1', '1.5G', 'abc', '', '1P'):
            with self.assertRaises(SystemExit):
                snapshot_publish.main(
                    ['--root', str(self.root), '--destination', str(self.dest),
                     '--reserve-bytes', bad, '--once'])
        with self.assertRaises(snapshot_publish.PublishError):
            self.publisher(Probe(0), reserve=-1)


if __name__ == '__main__':
    unittest.main()
