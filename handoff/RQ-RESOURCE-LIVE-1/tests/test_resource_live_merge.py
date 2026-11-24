import datetime
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import resource_live_merge as m  # noqa: E402

NOW = datetime.datetime(2026, 11, 16, 12, 0, tzinfo=datetime.timezone.utc).timestamp()


def iso(offset_s):
    return datetime.datetime.fromtimestamp(NOW + offset_s, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def reading(rid, lane, observed=-60, **over):
    row = {"id": rid, "lane": lane, "verified": True, "used": 40, "limit": 100, "unit": "percent", "used_pct": 40,
           "remaining": 60, "reset_at": iso(86400), "source": "claude-usage", "source_tier": "official",
           "observed_at": iso(observed), "stale_after": iso(observed + 3600), "reason": None}
    row.update(over)
    return row


def sidecar(generated=-30, readings=None):
    return {"schema": "resource-live.v1", "generated_at": iso(generated),
            "readings": readings if readings is not None else [reading("claude-weekly", "claude")],
            "burn_down": {"lane_order": ["codex-cmp", "claude", 7], "allowances": [{"id": "claude-weekly", "action": "burn"}, "bad"]}}


class MergeTest(unittest.TestCase):
    def test_adds_live_block_and_keeps_everything_else(self):
        pool = {"schema": "resource-pool.v1", "lanes": {"claude": {"target": 4}}}
        merged = m.merge(pool, sidecar(), NOW)
        self.assertEqual(merged["lanes"], {"claude": {"target": 4}})
        self.assertNotIn("live", pool)
        live = merged["live"]
        self.assertTrue(live["current"])
        self.assertEqual(live["lane_order"], ["codex-cmp", "claude"])
        self.assertEqual(live["allowances"], [{"id": "claude-weekly", "action": "burn"}])
        self.assertEqual(live["readings"]["claude-weekly"]["used_pct"], 40)
        self.assertEqual(live["readings"]["claude-weekly"]["source"], "claude-usage")
        self.assertEqual(live["readings"]["claude-weekly"]["observed_at"], iso(-60))

    def test_stale_reading_is_null_not_zero(self):
        merged = m.merge({}, sidecar(readings=[reading("devin", "devin", observed=-3601)]), NOW)
        row = merged["live"]["readings"]["devin"]
        self.assertFalse(row["verified"])
        self.assertEqual(row["reason"], "stale")
        self.assertTrue(row["stale"])
        self.assertTrue(row["stale_over_1h"])
        for key in m.VALUE_KEYS:
            self.assertIsNone(row[key])
        self.assertEqual(row["observed_at"], iso(-3601))

    def test_freshness_flags_distinguish_age_and_explicit_deadline(self):
        rows = [reading("fresh", "a", observed=-3599),
                reading("deadline", "b", observed=-20, stale_after=iso(-1)),
                reading("unknown", "c", observed_at=None)]
        live = m.merge({}, sidecar(readings=rows), NOW)["live"]["readings"]
        self.assertFalse(live["fresh"]["stale"])
        self.assertFalse(live["fresh"]["stale_over_1h"])
        self.assertTrue(live["deadline"]["stale"])
        self.assertFalse(live["deadline"]["stale_over_1h"])
        self.assertIsNone(live["unknown"]["stale_over_1h"])

    def test_unverified_reading_keeps_its_reason(self):
        row = reading("gemini", "gemini", verified=False, used=None, limit=None, unit=None, used_pct=None, remaining=None,
                      reset_at=None, source=None, source_tier=None, observed_at=None, stale_after=None, reason="no-supported-source")
        merged = m.merge({}, sidecar(readings=[row]), NOW)
        self.assertEqual(merged["live"]["readings"]["gemini"]["reason"], "no-supported-source")
        self.assertIsNone(merged["live"]["readings"]["gemini"]["used_pct"])

    def test_old_plan_is_dropped(self):
        merged = m.merge({}, sidecar(generated=-3601), NOW)
        self.assertFalse(merged["live"]["current"])
        self.assertEqual(merged["live"]["lane_order"], [])
        self.assertEqual(m.lane_rank(merged), {})

    def test_future_plan_is_dropped(self):
        self.assertFalse(m.merge({}, sidecar(generated=120), NOW)["live"]["current"])

    def test_missing_or_foreign_sidecar_yields_an_empty_block(self):
        for bad in (None, [], {"schema": "other"}, {"schema": "resource-live.v1", "generated_at": "nope", "readings": "x"}):
            live = m.merge({"keep": 1}, bad, NOW)["live"]
            self.assertFalse(live["current"])
            self.assertEqual(live["readings"], {})

    def test_lane_rank(self):
        self.assertEqual(m.lane_rank(m.merge({}, sidecar(), NOW)), {"codex-cmp": 0, "claude": 1})
        self.assertEqual(m.lane_rank({}), {})


if __name__ == "__main__":
    unittest.main()
