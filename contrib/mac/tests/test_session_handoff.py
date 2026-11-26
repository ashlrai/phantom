"""Hermetic advisory wiring; uses the existing synthetic dispatcher/launcher harness."""
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from session_handoff import handoff_advice
from test_dispatchd import build, dead, held_lanes, lane_slot, launch_stubs, queue_job, tick, USAGE_ACU


class SessionHandoffTests(unittest.TestCase):
    def test_advice_is_only_a_relative_packet_reference(self):
        row = handoff_advice("RQ-A", "codex-personal", "quota-exhausted", "claude")
        self.assertEqual(row["packet"], "handffs/RQ-A.jsonl")
        self.assertTrue(row["advisory"])
        self.assertFalse(row["dispatched"])
        for invalid in ("../outside", "job\nsecret", "", None):
            self.assertIsNone(handoff_advice(invalid, "claude", "quota-exhausted"))

    def test_finished_quota_failure_emits_one_advice_without_replay(self):
        slots = held_lanes(); slots["devin"] = lane_slot()
        with build(slots=slots) as temp:
            home = Path(temp).resolve(); env = launch_stubs(home)
            dead(home, "RQ-LIMIT", "devin", [USAGE_ACU])
            for _ in range(2):
                result = tick(home, env)
                self.assertEqual(result.returncode, 0, result.stderr)
            rows = [json.loads(line) for line in (home / ".ashlr-runs/metrics/jobs.jsonl").read_text().splitlines()]
            advice = [r for r in rows if r.get("event") == "session_handoff_advisory"]
            self.assertEqual(len(advice), 1)
            self.assertEqual(advice[0]["packet"], "handffs/RQ-LIMIT.jsonl")
            self.assertFalse((home / ".ashlr-runs/queue/run/RQ-LIMIT.dispatched").exists())
            self.assertFalse((home / ".ashlr-runs/handffs").exists())

    def test_pending_zero_quota_uses_existing_market_and_adds_advice(self):
        slots = held_lanes(); slots.update({"codex-personal": lane_slot(quota=0), "claude": lane_slot()})
        with build(slots=slots) as temp:
            home = Path(temp).resolve(); env = launch_stubs(home)
            queue_job(home, "RQ-PENDING", "codex-personal")
            result = tick(home, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            rows = [json.loads(line) for line in (home / ".ashlr-runs/metrics/work-market.jsonl").read_text().splitlines()]
            advice = [r for r in rows if r.get("event") == "session_handoff_advisory"]
            self.assertEqual(len(advice), 1)
            self.assertEqual(advice[0]["trigger"], "quota-exhausted")
            self.assertTrue(advice[0]["advisory"])
            self.assertFalse(advice[0]["dispatched"])


if __name__ == "__main__":
    unittest.main()
