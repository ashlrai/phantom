"""Tests for load_clear_gate.py (RQ-ELOAD-CLEAR-1).

Regression: incident e cleared at 15:28:36 ET on Nov 16 while load1 was over
100. The required case is above, below once, above again: it must not resolve.
Every test runs in a temp dir and touches no real ~/.ashlr-runs path.
"""
import json
import os
import tempfile
import unittest
from pathlib import Path

from load_clear_gate import CLEAR_SPACING_S, LoadClearGate, load_gate, save_gate

THRESHOLD = 36.0  # 2 x ncpu on an 18-core host
TICK = 300.0  # self_aware.py StartInterval


class ObserveTests(unittest.TestCase):
    def test_above_below_once_above_again_never_resolves(self):
        gate = LoadClearGate(THRESHOLD)
        self.assertFalse(gate.observe(0.0, 150.0))
        self.assertFalse(gate.observe(TICK, 20.0))
        self.assertFalse(gate.observe(2 * TICK, 150.0))
        self.assertFalse(gate.observe(3 * TICK, 20.0))  # a fresh streak of one
        self.assertEqual(gate.count, 1)

    def test_single_below_sample_never_resolves(self):
        gate = LoadClearGate(THRESHOLD)
        self.assertFalse(gate.observe(0.0, 1.0))

    def test_two_below_samples_one_tick_apart_resolve_on_second(self):
        gate = LoadClearGate(THRESHOLD)
        self.assertFalse(gate.observe(0.0, 10.0))
        self.assertTrue(gate.observe(TICK, 10.0))

    def test_two_below_samples_closer_than_60s_do_not_resolve(self):
        gate = LoadClearGate(THRESHOLD)
        self.assertFalse(gate.observe(0.0, 10.0))
        self.assertFalse(gate.observe(30.0, 10.0))  # ignored: under 60 s
        self.assertTrue(gate.observe(CLEAR_SPACING_S, 10.0))  # 60 s after the anchor

    def test_exactly_60s_apart_counts(self):
        gate = LoadClearGate(THRESHOLD)
        gate.observe(100.0, 5.0)
        self.assertTrue(gate.observe(160.0, 5.0))

    def test_load_equal_to_threshold_is_not_below(self):
        gate = LoadClearGate(THRESHOLD)
        self.assertFalse(gate.observe(0.0, 5.0))
        self.assertFalse(gate.observe(TICK, THRESHOLD))  # resets the streak
        self.assertFalse(gate.observe(2 * TICK, 5.0))  # count is 1 again
        self.assertTrue(gate.observe(3 * TICK, 5.0))

    def test_unusable_samples_reset_the_streak(self):
        for bad in (None, float("nan"), float("inf"), True, "12"):
            with self.subTest(bad=bad):
                gate = LoadClearGate(THRESHOLD)
                gate.observe(0.0, 5.0)
                self.assertFalse(gate.observe(TICK, bad))  # type: ignore[arg-type]
                self.assertFalse(gate.observe(2 * TICK, 5.0))

    def test_gap_longer_than_max_gap_is_not_consecutive(self):
        gate = LoadClearGate(THRESHOLD)
        gate.observe(0.0, 5.0)
        self.assertFalse(gate.observe(3600.0, 5.0))  # detector was down for an hour
        self.assertTrue(gate.observe(3600.0 + TICK, 5.0))

    def test_clock_moving_backwards_resets(self):
        gate = LoadClearGate(THRESHOLD)
        gate.observe(1000.0, 5.0)
        self.assertFalse(gate.observe(500.0, 5.0))
        self.assertTrue(gate.observe(500.0 + TICK, 5.0))

    def test_ignored_sample_keeps_anchor_for_consecutive_check(self):
        # 0 anchors, 30 is ignored, 60 counts: the streak is not reset by the ignored one.
        gate = LoadClearGate(THRESHOLD)
        gate.observe(0.0, 5.0)
        gate.observe(30.0, 5.0)
        self.assertTrue(gate.observe(60.0, 5.0))

    def test_invalid_configuration_is_rejected(self):
        with self.assertRaises(ValueError):
            LoadClearGate(0.0)
        with self.assertRaises(ValueError):
            LoadClearGate(float("nan"))
        with self.assertRaises(ValueError):
            LoadClearGate(THRESHOLD, samples=0)
        with self.assertRaises(ValueError):
            LoadClearGate(THRESHOLD, max_gap_s=0)


class PersistenceTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.path = Path(self._dir.name) / "state" / "load-clear.json"

    def tearDown(self):
        self._dir.cleanup()

    def test_streak_survives_separate_processes(self):
        # Each launchd tick is a fresh process: save after one sample, reload for the next.
        first = load_gate(self.path, THRESHOLD)
        self.assertFalse(first.observe(0.0, 5.0))
        save_gate(self.path, first)
        second = load_gate(self.path, THRESHOLD)
        self.assertTrue(second.observe(TICK, 5.0))

    def test_above_sample_persisted_resets_next_process(self):
        gate = load_gate(self.path, THRESHOLD)
        gate.observe(0.0, 5.0)
        save_gate(self.path, gate)
        gate = load_gate(self.path, THRESHOLD)
        gate.observe(TICK, 150.0)
        save_gate(self.path, gate)
        gate = load_gate(self.path, THRESHOLD)
        self.assertFalse(gate.observe(2 * TICK, 5.0))

    def test_missing_state_is_fresh(self):
        self.assertEqual(load_gate(self.path, THRESHOLD).count, 0)

    def test_corrupt_state_fails_closed(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text("{not json", encoding="utf-8")
        gate = load_gate(self.path, THRESHOLD)
        self.assertEqual(gate.count, 0)
        self.assertFalse(gate.observe(0.0, 5.0))

    def test_malformed_state_fails_closed(self):
        self.path.parent.mkdir(parents=True)
        bad_payloads = [
            [],
            {"threshold": THRESHOLD},
            {"threshold": THRESHOLD, "count": "1", "last_counted": 0.0, "last_seen": 0.0},
            {"threshold": THRESHOLD, "count": 1, "last_counted": None, "last_seen": 0.0},
            {"threshold": THRESHOLD, "count": 0, "last_counted": 0.0, "last_seen": 0.0},
            {"threshold": THRESHOLD, "count": 1, "last_counted": "x", "last_seen": 0.0},
        ]
        for payload in bad_payloads:
            with self.subTest(payload=payload):
                self.path.write_text(json.dumps(payload), encoding="utf-8")
                self.assertEqual(load_gate(self.path, THRESHOLD).count, 0)

    def test_threshold_change_discards_state(self):
        gate = load_gate(self.path, THRESHOLD)
        gate.observe(0.0, 5.0)
        save_gate(self.path, gate)
        other = load_gate(self.path, 18.0)
        self.assertEqual(other.count, 0)

    def test_save_is_atomic_and_leaves_no_temp_files(self):
        gate = LoadClearGate(THRESHOLD)
        gate.observe(0.0, 5.0)
        save_gate(self.path, gate)
        save_gate(self.path, gate)
        leftovers = [p for p in self.path.parent.iterdir() if p.suffix == ".tmp"]
        self.assertEqual(leftovers, [])
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8"))["count"], 1)
        # A second save over the same path replaces it; an interrupted write
        # never leaves a half-written file under the real name.
        gate.observe(TICK, 5.0)
        save_gate(self.path, gate)
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8"))["count"], 2)


if __name__ == "__main__":
    unittest.main()
