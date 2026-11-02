"""Hermetic memory admission contracts and a no-allocation 25-job simulation.

Run with a temporary HOME. The simulation exercises the real filesystem queue
and admission decisions; its memory figures are modeled, not live stress data.
"""

import contextlib
import io
import json
import math
from pathlib import Path
import tempfile
import unittest

from memory_admission import (
    Admission,
    GIB,
    Snapshot,
    classify,
    decision,
    group_rss,
    parse_processes,
    parse_snapshot,
)


VM_STAT = """Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                              131072.
Pages active:                           100000.
Pages inactive:                         200000.
Pages speculative:                       65536.
Pages wired down:                       100000.
Pages occupied by compressor:            50000.
"""


class DecisionTests(unittest.TestCase):
    def test_four_global_slots_and_exact_free_floor(self):
        host = Snapshot(10 * GIB, 7 * GIB, 0)
        self.assertIsNone(decision(host, [GIB] * 3, GIB))
        self.assertIsNotNone(decision(host, [GIB] * 4, GIB))
        self.assertIsNotNone(decision(host, [GIB] * 3, GIB + 1))

    def test_reservations_prevent_simultaneous_optimistic_admission(self):
        host = Snapshot(32 * GIB, 12 * GIB, 0)
        self.assertIsNone(decision(host, [], 2 * GIB))
        self.assertIsNotNone(decision(host, [2 * GIB], 2 * GIB))

    def test_pause_and_swap_threshold_hold_jobs(self):
        host = Snapshot(32 * GIB, 24 * GIB, 8 * GIB - 1)
        self.assertIsNone(decision(host, [], GIB))
        self.assertIsNotNone(decision(host, [], GIB, paused=True))
        self.assertIsNotNone(decision(Snapshot(32 * GIB, 24 * GIB, 8 * GIB), [], GIB))
        self.assertIsNotNone(decision(Snapshot(32 * GIB, 24 * GIB, 9 * GIB), [], GIB))

    def test_invalid_memory_telemetry_never_admits(self):
        for host in (
            Snapshot(0, 0, 0),
            Snapshot(-1, 0, 0),
            Snapshot(32 * GIB, -1, 0),
            Snapshot(32 * GIB, 33 * GIB, 0),
            Snapshot(32 * GIB, 20 * GIB, -1),
            Snapshot(math.nan, 20 * GIB, 0),
            Snapshot(32 * GIB, math.inf, 0),
        ):
            with self.subTest(host=host):
                self.assertIsNotNone(decision(host, [], GIB))


class TelemetryTests(unittest.TestCase):
    def test_only_free_and_speculative_pages_count_as_free(self):
        host = parse_snapshot(str(32 * GIB), VM_STAT,
                              "vm.swapusage: total = 8192.00M  used = 2048.00M  free = 6144.00M  (encrypted)")
        self.assertEqual(host.total, 32 * GIB)
        self.assertEqual(host.free, 3 * GIB)
        self.assertEqual(host.swap, 2 * GIB)

    def test_intel_page_size_and_fractional_swap_units(self):
        host = parse_snapshot(str(8 * GIB), VM_STAT.replace("16384", "4096"),
                              "total = 4.00G used = 1.50G free = 2.50G")
        self.assertEqual(host.free, 768 * 1024**2)
        self.assertEqual(host.swap, 1.5 * GIB)

    def test_missing_or_malformed_telemetry_is_not_zero(self):
        cases = (
            ("unknown", VM_STAT, "used = 1.00G"),
            (str(32 * GIB), "", "used = 1.00G"),
            (str(32 * GIB), VM_STAT.replace("Pages free:", "Missing:"), "used = 1.00G"),
            (str(32 * GIB), VM_STAT, "unavailable"),
            (str(32 * GIB), VM_STAT, "used = -1.00G"),
            (str(32 * GIB), VM_STAT, "used = nanG"),
        )
        for values in cases:
            with self.subTest(values=values):
                with self.assertRaises(ValueError):
                    parse_snapshot(*values)

    def test_process_groups_sum_descendants_without_command_or_environment(self):
        rows = parse_processes(" 101 1 101 1024 S\n 102 101 101 2048 R\n 103 1 103 4096 S\n")
        self.assertEqual(group_rss(rows, 101), 3072 * 1024)
        self.assertEqual(group_rss(rows, 999), 0)
        self.assertEqual(rows[0], (101, 1, 101, 1024 * 1024, "S"))


class ClassificationTests(unittest.TestCase):
    def test_heavy_commands(self):
        commands = (
            ("cargo", ["build"]), ("cargo", ["test", "--lib"]),
            ("cargo", ["check"]), ("cargo", ["clippy"]),
            ("npm", ["test"]), ("npm", ["run", "test:ci"]),
            ("npm", ["run", "typecheck:web"]), ("npm", ["run", "build:web"]),
            ("npm", ["run", "lint"]), ("npx", ["tsc", "--noEmit"]),
            ("npx", ["vitest", "run"]), ("tsc", ["--noEmit"]),
        )
        for executable, args in commands:
            with self.subTest(command=[executable, *args]):
                self.assertIsNotNone(classify(executable, args))

    def test_light_commands_are_not_classified_as_heavy(self):
        for executable, args in (("cargo", ["metadata"]), ("npm", ["--version"]),
                                 ("git", ["status"]), ("node", ["script.js"]),
                                 ("npm", ["run", "dev"])):
            with self.subTest(command=[executable, *args]):
                self.assertIsNone(classify(executable, args))


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="memory-admission-test-")
        self.root = Path(self.temp.name)
        self.pause = self.root / "PAUSE"
        self.gates = []

    def tearDown(self):
        for gate in self.gates:
            gate.close()
        self.temp.cleanup()

    def gate(self, name, reserve=GIB):
        gate = Admission(self.root / "state", self.pause, reserve, name, "npm-test")
        self.gates.append(gate)
        gate.enqueue()
        return gate

    def test_fifo_and_global_cap_across_independent_instances(self):
        gates = [self.gate(f"job-{i}") for i in range(6)]
        host = Snapshot(32 * GIB, 24 * GIB, 0)
        self.assertIsNotNone(gates[1].attempt(host))
        for gate in gates[:4]:
            self.assertIsNone(gate.attempt(host))
        self.assertIsNotNone(gates[4].attempt(host))
        gates[0].finish(GIB // 2, 0)
        self.assertIsNotNone(gates[5].attempt(host))
        self.assertIsNone(gates[4].attempt(host))

    def test_pause_retains_ticket_and_resumes_in_order(self):
        gate = self.gate("paused")
        self.pause.touch()
        host = Snapshot(32 * GIB, 24 * GIB, 0)
        self.assertIsNotNone(gate.attempt(host))
        self.assertTrue(gate.path.exists())
        self.pause.unlink()
        self.assertIsNone(gate.attempt(host))
        gate.finish(12345, 7)
        self.assertFalse(gate.path.exists())
        receipt = json.loads((self.root / "state" / "receipts" / gate.path.name).read_text())
        self.assertEqual(receipt["peakRssBytes"], 12345)
        self.assertEqual(receipt["returncode"], 7)
        self.assertEqual(receipt["job"], "paused")

    def test_dangling_pause_sentinel_is_still_a_pause(self):
        gate = self.gate("pause-link")
        self.pause.symlink_to(self.root / "absent-target")
        self.assertIsNotNone(gate.attempt(Snapshot(32 * GIB, 24 * GIB, 0)))
        self.assertTrue(gate.path.exists())

    def test_pressure_and_swap_queue_instead_of_losing_work(self):
        gate = self.gate("pressure", 2 * GIB)
        self.assertIsNotNone(gate.attempt(Snapshot(32 * GIB, 10 * GIB, 0)))
        self.assertTrue(gate.path.exists())
        self.assertIsNotNone(gate.attempt(Snapshot(32 * GIB, 24 * GIB, 8 * GIB)))
        self.assertTrue(gate.path.exists())
        self.assertIsNone(gate.attempt(Snapshot(32 * GIB, 24 * GIB, 0)))

    def test_dead_waiter_is_reclaimed_using_lease_not_pid(self):
        abandoned = self.gate("abandoned")
        follower = self.gate("follower")
        abandoned.close()
        self.assertIsNone(follower.attempt(Snapshot(32 * GIB, 24 * GIB, 0)))
        self.assertFalse(abandoned.path.exists())

    def test_active_reservations_are_shared_between_instances(self):
        first = self.gate("first", 2 * GIB)
        second = self.gate("second", 2 * GIB)
        host = Snapshot(32 * GIB, 12 * GIB, 0)
        self.assertIsNone(first.attempt(host))
        self.assertIsNotNone(second.attempt(host))
        first.finish(GIB, 0)
        self.assertIsNone(second.attempt(host))

    def test_historical_peak_grows_reservation_before_next_admission(self):
        first = self.gate("learn-first", GIB)
        self.assertIsNone(first.attempt(Snapshot(32 * GIB, 24 * GIB, 0)))
        first.finish(4 * GIB, 0)
        second = self.gate("learn-second", GIB)
        # Requested 1 GiB would fit, but the observed 4 GiB peak with 25%
        # headroom cannot leave 30% of this host free.
        self.assertIsNotNone(second.attempt(Snapshot(32 * GIB, 14 * GIB, 0)))
        self.assertEqual(second.record["reserveBytes"], 5 * GIB)
        self.assertIsNone(second.attempt(Snapshot(32 * GIB, 15 * GIB, 0)))

    def test_observed_active_growth_prevents_another_heavy_start(self):
        first = self.gate("growing", GIB)
        second = self.gate("after-growth", GIB)
        host = Snapshot(32 * GIB, 15 * GIB, 0)
        self.assertIsNone(first.attempt(host))
        first.grow_reservation(4 * GIB)
        self.assertIsNotNone(second.attempt(host))
        first.finish(4 * GIB, 0)
        self.assertIsNone(second.attempt(host))

    def test_malformed_queue_or_history_keeps_work_waiting(self):
        gate = self.gate("malformed")
        foreign = self.root / "state" / "queue" / "foreign.json"
        for value in ([], None, {"state": "active"}):
            with self.subTest(queue=value):
                foreign.write_text(json.dumps(value))
                self.assertIsNotNone(gate.attempt(Snapshot(32 * GIB, 24 * GIB, 0)))
                self.assertTrue(gate.path.exists())
        foreign.unlink()
        history = self.root / "state" / "peaks.json"
        for value in ([], None, {"npm-test": "invalid"}):
            with self.subTest(history=value):
                history.write_text(json.dumps(value))
                self.assertIsNotNone(gate.attempt(Snapshot(32 * GIB, 24 * GIB, 0)))
        history.unlink()
        self.assertIsNone(gate.attempt(Snapshot(32 * GIB, 24 * GIB, 0)))


def simulate_batch():
    """Run 25 real queue clients against explicit simulated Mac telemetry."""
    completed = []
    max_active = 0
    min_free_fraction = 1.0
    max_swap = 0
    pause_waits = 0
    swap_waits = 0
    gates = []
    with tempfile.TemporaryDirectory(prefix="memory-admission-batch-") as directory:
        root = Path(directory)
        pause = root / "PAUSE"
        try:
            for number in range(25):
                gate = Admission(root / "state", pause, 2 * GIB, f"batch-{number:02d}", "npm-test")
                gate.enqueue()
                gates.append(gate)
            pending = list(gates)
            pause.touch()
            for gate in pending:
                if gate.attempt(Snapshot(32 * GIB, 18 * GIB, 3 * GIB)) is None:
                    raise AssertionError("admitted while PAUSE exists")
                pause_waits += 1
            pause.unlink()
            for gate in pending:
                if gate.attempt(Snapshot(32 * GIB, 18 * GIB, 8 * GIB)) is None:
                    raise AssertionError("admitted at the swap ceiling")
                swap_waits += 1
            while pending:
                active = []
                for gate in list(pending):
                    if gate.attempt(Snapshot(32 * GIB, 18 * GIB, 3 * GIB)) is None:
                        active.append(gate)
                        pending.remove(gate)
                        max_active = max(max_active, len(active))
                        free_fraction = (18 * GIB - len(active) * 2 * GIB) / (32 * GIB)
                        min_free_fraction = min(min_free_fraction, free_fraction)
                        max_swap = max(max_swap, 3 * GIB)
                        if len(active) > 4 or free_fraction < 0.30:
                            raise AssertionError("admission exceeded the modeled memory budget")
                if not active:
                    raise AssertionError("queue did not make progress after pressure cleared")
                for gate in active:
                    gate.finish(GIB, 0)
                    completed.append(gate.ticket)
            if completed != [gate.ticket for gate in gates]:
                raise AssertionError("batch did not drain in FIFO order")
        finally:
            for gate in gates:
                gate.close()
    return {
        "mode": "simulated-mac-memory-real-filesystem-queue",
        "jobs": 25,
        "completed": len(completed),
        "maxActive": max_active,
        "minFreeFraction": min_free_fraction,
        "maxSwapBytes": max_swap,
        "pauseWaits": pause_waits,
        "swapWaits": swap_waits,
    }


class BatchTests(unittest.TestCase):
    def test_simulated_25_job_batch(self):
        with contextlib.redirect_stderr(io.StringIO()):
            result = simulate_batch()
        self.assertEqual(result["completed"], 25)
        self.assertEqual(result["maxActive"], 4)
        self.assertGreaterEqual(result["minFreeFraction"], 0.30)
        self.assertLess(result["maxSwapBytes"], 8 * GIB)
        self.assertEqual(result["pauseWaits"], 25)
        self.assertEqual(result["swapWaits"], 25)


if __name__ == "__main__":
    import sys

    if sys.argv[1:] == ["--simulate"]:
        with contextlib.redirect_stderr(io.StringIO()):
            result = simulate_batch()
        print(json.dumps(result, sort_keys=True))
    else:
        unittest.main()
