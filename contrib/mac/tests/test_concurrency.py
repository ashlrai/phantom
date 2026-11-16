"""Unit tests for contrib/mac/concurrency.py, the adaptive fleet cap (RQ-QUEUE-BATCH-1).

Pure functions only: no ~/.ashlr-runs, no subprocesses. test_loadgate.AdaptiveConcurrencyTests drives the same
controller through real dispatchd ticks.
"""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import concurrency as c  # noqa: E402

HEALTHY = {"load1": 4.0, "ncpu": 18, "load_per_cpu_max": 3.0, "memory_pressure": 1, "mem_free_pct": 60, "swap_gb": 1.0,
           "swap_growth_gb": 0.0, "swap_growth_max_gb": 2.0, "disk_free_gb": 400, "disk_hard_stop_gb": 30,
           "procs": 900, "procs_max": 2500}


def state(cap=18, **kw):
    s = c.fresh_state(cap, 0)
    s.update(kw)
    return s


class ZoneTests(unittest.TestCase):
    def test_healthy_host_is_all_ok(self):
        self.assertEqual({k: v[0] for k, v in c.zones(HEALTHY).items()}, {k: "ok" for k in c.zones(HEALTHY)})

    def test_danger_thresholds_sit_below_the_gate_trip_points(self):
        cases = [("load1", 44.0, "danger"),          # 44 / 54 = 0.81; the gate only warns at 54
                 ("load1", 30.0, "warn"), ("memory_pressure", 2, "danger"),   # gate trips at 4
                 ("mem_free_pct", 20, "warn"), ("mem_free_pct", 10, "danger"),
                 ("swap_growth_gb", 1.0, "danger"),  # gate trips past 2 GiB
                 ("swap_growth_gb", 0.6, "warn"), ("disk_free_gb", 40, "danger"),   # gate stops at 30
                 ("disk_free_gb", 60, "warn"), ("procs", 2200, "danger"), ("procs", 1800, "warn")]
        names = {"load1": "load", "memory_pressure": "memory_pressure", "mem_free_pct": "mem_free",
                 "swap_growth_gb": "swap", "disk_free_gb": "disk", "procs": "procs"}
        for key, value, zone in cases:
            self.assertEqual(c.zones(dict(HEALTHY, **{key: value}))[names[key]][0], zone, (key, value))

    def test_unknown_signals_are_never_headroom(self):
        z = c.zones(dict(HEALTHY, memory_pressure=None, mem_free_pct=None, swap_gb=None, disk_free_gb=None, procs=None))
        for name in ("memory_pressure", "mem_free", "swap", "disk", "procs"):
            self.assertEqual(z[name][0], "warn", name)
        self.assertEqual(c.zones(dict(HEALTHY, load1=float("inf")))["load"][0], "danger")
        self.assertEqual(c.zones(dict(HEALTHY, load1=float("nan")))["load"][0], "warn")

    def test_load_above_two_cores_per_cpu_backs_off_even_with_relaxed_gate(self):
        for per_cpu in (2.5, 3.0, 100.0):
            signal = dict(HEALTHY, load1=36.0, load_per_cpu_max=per_cpu)
            self.assertEqual(c.zones(signal)["load"][0], "danger")
            self.assertEqual(c.decide(state(32), signal, 1000, True, 4, 64)["to"], 24)

    def test_unknown_swap_growth_cannot_raise_cap(self):
        signal = dict(HEALTHY, swap_growth_gb=None)
        self.assertEqual(c.zones(signal)["swap"], ("warn", "unknown"))
        self.assertIsNone(c.decide(state(18), signal, 1000, True, 4, 64))

    def test_rate_limits_warn_then_danger_and_any_fork_failure_is_danger(self):
        self.assertEqual(c.zones(dict(HEALTHY, rate_limits=1))["rate_limit"][0], "warn")
        self.assertEqual(c.zones(dict(HEALTHY, rate_limits=3))["rate_limit"][0], "danger")
        self.assertEqual(c.zones(dict(HEALTHY, fork_failures=1))["fork"][0], "danger")


class DecideTests(unittest.TestCase):
    def test_additive_raise_needs_demand_headroom_and_the_raise_gap(self):
        s = state(18)
        adj = c.decide(s, HEALTHY, 1000, True, 4, 64)
        self.assertEqual((adj["from"], adj["to"], adj["reason"]), (18, 20, "raise headroom"))
        self.assertIsNone(c.decide(s, HEALTHY, 1000 + c.RAISE_GAP_S - 1, True, 4, 64))
        self.assertEqual(c.decide(s, HEALTHY, 1000 + c.RAISE_GAP_S, True, 4, 64)["to"], 22)
        self.assertIsNone(c.decide(state(18), HEALTHY, 1000, False, 4, 64))   # no demand: the cap is not binding
        self.assertIsNone(c.decide(state(18), dict(HEALTHY, load1=30.0), 1000, True, 4, 64))   # warn holds

    def test_raise_stops_at_the_ceiling_and_bounds_are_reapplied(self):
        self.assertEqual(c.decide(state(63), HEALTHY, 1000, True, 4, 64)["to"], 64)
        self.assertIsNone(c.decide(state(64), HEALTHY, 2000, True, 4, 64))
        adj = c.decide(state(30), HEALTHY, 1000, True, 4, 12)   # operator lowered hard_cap under the cap
        self.assertEqual((adj["to"], adj["reason"]), (12, "bounds"))

    def test_multiplicative_backoff_with_gap_floor_and_trouble_point(self):
        s = state(32)
        adj = c.decide(s, dict(HEALTHY, memory_pressure=2), 1000, False, 4, 64)
        self.assertEqual((adj["from"], adj["to"], adj["reason"]), (32, 24, "backoff memory_pressure"))
        self.assertEqual((s["trouble_cap"], s["trouble_at"]), (32, 1000))
        self.assertIsNone(c.decide(s, dict(HEALTHY, memory_pressure=2), 1030, False, 4, 64))   # let the cut land
        self.assertEqual(c.decide(s, dict(HEALTHY, memory_pressure=2), 1060, False, 4, 64)["to"], 18)
        small = state(5)
        self.assertEqual(c.decide(small, dict(HEALTHY, memory_pressure=4), 1000, False, 4, 64)["to"], 4)   # at least -1
        self.assertIsNone(c.decide(small, dict(HEALTHY, memory_pressure=4), 2000, False, 4, 64))           # floor

    def test_settles_under_the_trouble_point_then_probes_one_at_a_time(self):
        s = state(20, trouble_cap=24, trouble_at=1000, last_change=1000)
        t = 1000 + c.RAISE_GAP_S
        self.assertEqual(c.decide(s, HEALTHY, t, True, 4, 64)["to"], 22)
        self.assertEqual(c.decide(s, HEALTHY, t + c.RAISE_GAP_S, True, 4, 64)["to"], 23)   # creeps to trouble - 1
        self.assertIsNone(c.decide(s, HEALTHY, t + 2 * c.RAISE_GAP_S, True, 4, 64))
        late = 1000 + c.SETTLE_GAP_S
        self.assertEqual(c.decide(s, HEALTHY, late, True, 4, 64)["to"], 24)
        self.assertEqual(c.decide(s, HEALTHY, late + c.RAISE_GAP_S, True, 4, 64)["to"], 25)
        self.assertIsNone(s["trouble_cap"])   # passed cleanly: forgotten

    def test_fresh_fork_failure_backs_off_immediately(self):
        s = state(20, last_backoff=990, fork_failures=[995])
        self.assertEqual(c.decide(s, HEALTHY, 1000, False, 4, 64)["to"], 15)
        self.assertIsNone(c.decide(s, HEALTHY, 1010, False, 4, 64))   # same failure, inside the backoff gap

    def test_signal_windows_expire(self):
        s = state(18, rate_limits=[0, 10, 20], fork_failures=[5])
        adj = c.decide(s, HEALTHY, 10 + c.WINDOW_S + 100, True, 4, 64)
        self.assertEqual(adj["to"], 20)
        self.assertEqual((s["rate_limits"], s["fork_failures"]), ([], []))

    def test_describe_lists_only_signals_outside_ok(self):
        s = state(32)
        adj = c.decide(s, dict(HEALTHY, memory_pressure=2, mem_free_pct=20), 1000, False, 4, 64)
        self.assertEqual(c.describe(adj), "CONCURRENCY 32->24 backoff memory_pressure (mem_free=20, memory_pressure=2)")

    def test_history_is_bounded(self):
        s = state(4)
        for i in range(c.HISTORY + 10):
            c.decide(s, HEALTHY, 1000 + i * c.RAISE_GAP_S, True, 4, 10_000)
        self.assertEqual(len(s["history"]), c.HISTORY)


class StateTests(unittest.TestCase):
    def test_round_trip_and_malformed_state_restarts_from_the_seed(self):
        with tempfile.TemporaryDirectory() as d:
            path = str(Path(d) / "concurrency.json")
            s, fresh = c.load(path, 12, 5)
            self.assertTrue(fresh)
            self.assertEqual(s["cap"], 12)
            s["cap"] = 30
            c.save(path, s)
            self.assertEqual(c.load(path, 12, 6), (s, False))
            for bad in ("{", json.dumps({"schema": "x", "cap": 3}), json.dumps({"schema": c.SCHEMA, "cap": True}), "[]"):
                Path(path).write_text(bad)
                self.assertEqual(c.load(path, 12, 7)[0]["cap"], 12, bad)

    def test_bounds_take_env_and_operator_ceiling(self):
        self.assertEqual(c.bounds(None, {}), (4, 64))
        self.assertEqual(c.bounds(10, {}), (4, 10))
        self.assertEqual(c.bounds(2, {}), (2, 2))
        self.assertEqual(c.bounds(None, {"ASHLR_CONCURRENCY_MAX": "96", "ASHLR_CONCURRENCY_MIN": "6"}), (6, 96))
        self.assertEqual(c.bounds(None, {"ASHLR_CONCURRENCY_MAX": "-1", "ASHLR_CONCURRENCY_MIN": "x"}), (4, 64))

    def test_settled_is_the_time_weighted_cap(self):
        s = state(30, history=[{"ts": 0, "from": 18, "to": 20}, {"ts": 3600, "from": 20, "to": 30}])
        self.assertEqual(c.settled(s, 7200, horizon_s=7200), 25.0)
        self.assertEqual(c.settled(state(18), 7200), 18.0)


if __name__ == "__main__":
    unittest.main()
