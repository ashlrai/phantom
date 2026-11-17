"""Unit tests for contrib/mac/lane_placement.py (RQ-LOADGATE-PLACEMENT-1). Pure functions; no subprocesses."""
import math
from datetime import datetime, timezone
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import lane_placement as lp

NOW = 1_800_000_000.0
LANES = ['claude', 'devin', 'codex-local']


def iso(seconds_before_now):
    return datetime.fromtimestamp(NOW - seconds_before_now, timezone.utc).isoformat()


class BusyCoresTests(unittest.TestCase):
    def test_sums_every_process_in_cores_except_the_admitting_pid(self):
        table = {10: (1, 297.0), 11: (10, 50.0), 99: (1, 900.0)}
        self.assertAlmostEqual(lp.busy_cores(table, own=99), 3.47)

    def test_no_cpu_columns_is_unknown_not_idle(self):
        self.assertIsNone(lp.busy_cores(None))

    def test_empty_inventory_is_zero_busy(self):
        self.assertEqual(lp.busy_cores({}), 0.0)

    def test_malformed_percent_is_unknown(self):
        for bad in (-1.0, math.nan, math.inf, True, None, '12.0'):
            with self.subTest(bad=bad):
                self.assertIsNone(lp.busy_cores({10: (1, bad)}))


class ReadPoolTests(unittest.TestCase):
    def _write(self, data):
        handle = tempfile.NamedTemporaryFile('wb', delete=False)
        self.addCleanup(lambda: Path(handle.name).unlink(missing_ok=True))
        handle.write(data)
        handle.close()
        return handle.name

    def test_missing_file_is_none(self):
        self.assertIsNone(lp.read_pool('/nonexistent/resource-pool.json'))

    def test_invalid_json_and_non_object_are_none(self):
        self.assertIsNone(lp.read_pool(self._write(b'{not json')))
        self.assertIsNone(lp.read_pool(self._write(b'[1, 2]')))

    def test_oversized_file_is_none(self):
        self.assertIsNone(lp.read_pool(self._write(b'{"x": "' + b'a' * lp.POOL_MAX_BYTES + b'"}')))

    def test_object_is_returned(self):
        self.assertEqual(lp.read_pool(self._write(b'{"measured_at": "x"}')), {'measured_at': 'x'})


class LaneCostsTests(unittest.TestCase):
    def doc(self, **overrides):
        base = {'measured_at': iso(60), 'lanes': {'claude': {'cores_per_job': 1.5}}}
        base.update(overrides)
        return base

    def test_fresh_measurement_sets_that_lane_only(self):
        costs, sources = lp.lane_costs(LANES, self.doc(), NOW, 12)
        self.assertEqual(costs, {'claude': 1.5, 'devin': 1.0, 'codex-local': 1.0})
        self.assertEqual(sources, {'claude': 'resource-pool', 'devin': 'default', 'codex-local': 'default'})

    def test_utc_z_suffix_is_accepted(self):
        stamp = (datetime.fromtimestamp(NOW - 60, timezone.utc)).strftime('%Y-%m-%dT%H:%M:%SZ')
        costs, sources = lp.lane_costs(LANES, self.doc(measured_at=stamp), NOW, 12)
        self.assertEqual(sources['claude'], 'resource-pool')

    def test_stale_document_uses_defaults_for_every_lane(self):
        costs, sources = lp.lane_costs(LANES, self.doc(measured_at=iso(lp.POOL_MAX_AGE_S + 1)), NOW, 12)
        self.assertEqual(set(sources.values()), {'default'})
        self.assertEqual(costs['claude'], 1.0)

    def test_document_from_the_future_beyond_skew_is_not_trusted(self):
        future = iso(-(lp.POOL_CLOCK_SKEW_S + 5))
        self.assertEqual(lp.lane_costs(LANES, self.doc(measured_at=future), NOW, 12)[1]['claude'], 'default')

    def test_small_clock_skew_is_tolerated(self):
        ahead = iso(-(lp.POOL_CLOCK_SKEW_S - 5))
        self.assertEqual(lp.lane_costs(LANES, self.doc(measured_at=ahead), NOW, 12)[1]['claude'], 'resource-pool')

    def test_missing_or_naive_timestamp_is_not_fresh(self):
        naive = datetime.fromtimestamp(NOW - 60).isoformat()   # no offset: the builder's local clock is unknown
        for stamp in (None, naive, 'yesterday', 7, 'x' * 100):
            with self.subTest(stamp=stamp):
                self.assertEqual(lp.lane_costs(LANES, self.doc(measured_at=stamp), NOW, 12)[1]['claude'], 'default')

    def test_bad_lane_values_fall_back_to_default(self):
        bad_values = [0, -1, 0.0, math.nan, math.inf, True, '2', 13, None]   # 13 > ncpu=12
        for value in bad_values:
            with self.subTest(value=value):
                doc = self.doc(lanes={'claude': {'cores_per_job': value}})
                self.assertEqual(lp.lane_costs(LANES, doc, NOW, 12)[1]['claude'], 'default')

    def test_non_object_lane_entries_and_lanes_are_ignored(self):
        self.assertEqual(lp.lane_costs(LANES, self.doc(lanes=['claude']), NOW, 12)[1]['claude'], 'default')
        self.assertEqual(lp.lane_costs(LANES, self.doc(lanes={'claude': 'fast'}), NOW, 12)[1]['claude'], 'default')

    def test_no_document_uses_the_configured_default(self):
        costs, sources = lp.lane_costs(LANES, None, NOW, 12, default=2.5)
        self.assertEqual(costs, {lane: 2.5 for lane in LANES})
        self.assertEqual(set(sources.values()), {'default'})


class PlanAndRoomTests(unittest.TestCase):
    def test_room_is_per_cpu_ceiling_minus_busy(self):
        report = lp.plan(busy=5.0, ncpu=12, per_cpu=2.0, costs={'claude': 1.0}, sources={'claude': 'default'})
        self.assertEqual(report['source'], 'ps')
        self.assertEqual(report['room_cores'], 19.0)
        self.assertEqual(report['busy_cores'], 5.0)

    def test_unknown_busy_gives_unlimited_room(self):
        report = lp.plan(busy=None, ncpu=12, per_cpu=2.0, costs={}, sources={})
        self.assertEqual(report['source'], 'unknown')
        self.assertIsNone(report['room_cores'])
        room = lp.Room(report)
        self.assertTrue(all(room.fits(lane) for lane in LANES))
        room.take('claude')
        self.assertIsNone(room.report['room_cores'])

    def test_lanes_fit_by_their_own_cost(self):
        # Room 3.0 cores: a 2.5-core lane fits, a 3.5-core lane does not, and claims shrink the room.
        report = lp.plan(busy=21.0, ncpu=12, per_cpu=2.0, costs={'claude': 2.5, 'devin': 3.5}, sources={})
        room = lp.Room(report)
        self.assertTrue(room.fits('claude'))
        self.assertFalse(room.fits('devin'))
        room.take('claude')
        self.assertAlmostEqual(room.report['room_cores'], 0.5)
        self.assertFalse(room.fits('claude'))

    def test_take_keeps_the_report_current_for_admission_json(self):
        room = lp.Room(lp.plan(busy=0.0, ncpu=4, per_cpu=2.0, costs={'claude': 1.0}, sources={}, default=1.0))
        room.take('claude'); room.take('codex-local')
        self.assertEqual(room.report['room_cores'], 6.0)
        self.assertEqual(room.report['job_cores'], {'claude': 1.0})

    def test_unknown_lane_uses_default_cost(self):
        room = lp.Room(lp.plan(busy=7.0, ncpu=4, per_cpu=2.0, costs={}, sources={}, default=1.0))
        self.assertTrue(room.fits('omlx'))
        room.take('omlx')
        self.assertAlmostEqual(room.report['room_cores'], 0.0)

    def test_zero_room_refuses_when_cost_is_positive(self):
        room = lp.Room(lp.plan(busy=8.0, ncpu=4, per_cpu=2.0, costs={}, sources={}, default=1.0))
        self.assertEqual(room.report['room_cores'], 0.0)
        self.assertFalse(room.fits('claude'))


class DayOneRegressionTests(unittest.TestCase):
    """The incident: Devin at ~297% CPU plus other non-dispatchd load held every lane closed under load1."""

    def test_external_cpu_below_the_bar_leaves_room_for_every_lane(self):
        busy = lp.busy_cores({101: (1, 297.0), 102: (1, 120.0), 103: (1, 40.0)}, own=999)   # ~4.6 cores, 18 cores host
        room = lp.Room(lp.plan(busy, 18, 2.0, {}, {}, default=1.0))
        self.assertTrue(all(room.fits(lane) for lane in LANES))

    def test_truly_saturated_node_has_no_room_for_any_lane(self):
        busy = lp.busy_cores({i: (1, 200.0) for i in range(1, 19)}, own=999)   # 36 cores busy on 18
        room = lp.Room(lp.plan(busy, 18, 2.0, {}, {}, default=1.0))
        self.assertFalse(any(room.fits(lane) for lane in LANES))


if __name__ == '__main__':
    unittest.main()
