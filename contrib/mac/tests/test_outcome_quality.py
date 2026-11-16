"""Post-merge quality is preference only; all inputs and clocks are synthetic."""
import copy
import ast
import itertools
import json
import shlex
from types import SimpleNamespace
from pathlib import Path
import sys
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fleet_controller as fc

NOW = 1_800_000_000


def report(stable=10, total=20, now=NOW):
    return {"schema": "fleet.eval-report.v1", "generatedAt": now, "window": {"until": now},
            "sources": {"jobs": {"state": "healthy"}, "pullRequests": {"state": "healthy"},
                        "observations": {"state": "missing"}},
            "pullRequests": [{"lane": "x", "url": "https://github.com/a/b/pull/%d" % i,
                              "durability": "stable" if i < stable else "reverted", "checkState": "unknown"}
                             for i in range(total)]}


class OutcomeQuality(unittest.TestCase):
    def evaluate(self, source, previous=None, now=NOW):
        return fc.outcome_quality(source, previous, now, ["x"])

    def test_minimum_samples_and_missing_evidence_are_neutral_null(self):
        for source in (None, {}, report(19, 19), report(0, 0), report(now=NOW - 901), report(now=NOW + 1)):
            weights, _, receipts = self.evaluate(source)
            self.assertEqual(weights, {})
            self.assertIsNone(receipts[0]["score"])
            self.assertIsNone(receipts[0]["to"])

    def test_pending_unobserved_and_duplicate_prs_cannot_qualify(self):
        for kind in ("pending", "unobserved"):
            source = report()
            for p in source["pullRequests"]:
                p["durability"] = kind
            self.assertEqual(self.evaluate(source)[0], {})
        source = report()
        source["pullRequests"][0]["url"] = source["pullRequests"][1]["url"]
        self.assertEqual(self.evaluate(source)[0], {})

    def test_malformed_or_degraded_sources_are_unmeasured(self):
        for key, value in (("window", None), ("sources", []), ("pullRequests", {})):
            source = report()
            source[key] = value
            self.assertEqual(self.evaluate(source)[0], {})
        for channel in ("jobs", "pullRequests", "observations"):
            source = report()
            source["sources"][channel]["state"] = "degraded"
            self.assertEqual(self.evaluate(source)[0], {})

    def test_ci_correlation_is_from_resolved_cohorts_only(self):
        source = report(18)
        for i, p in enumerate(source["pullRequests"]):
            p["checkState"] = "clean" if i < 10 else "failed-checks"
        _, _, receipts = self.evaluate(source)
        self.assertAlmostEqual(receipts[0]["ci_adverse_delta"], 0.2)
        self.assertAlmostEqual(receipts[0]["score"], 0.88)
        source["pullRequests"][0]["checkState"] = "unknown"
        for p in source["pullRequests"][1:7]:
            p["checkState"] = "unknown"
        self.assertIsNone(self.evaluate(source)[2][0]["ci_adverse_delta"])

    def test_deadband_dwell_and_restarts_prevent_flapping(self):
        weights, state, receipts = self.evaluate(report(16))
        self.assertEqual(weights, {"x": 0.75})
        self.assertEqual(receipts[0]["reason"], "quality_adjustment")
        for offset, stable in ((10, 17), (100, 20), (3599, 18)):
            weights, state, receipts = self.evaluate(report(stable, now=NOW + offset), copy.deepcopy(state), NOW + offset)
            self.assertEqual(weights, {"x": 0.75})
            self.assertEqual(state["x"]["decided_at"], NOW)
        weights, state, receipts = self.evaluate(report(18, now=NOW + 3600), state, NOW + 3600)
        self.assertEqual(weights, {"x": 1.0})
        self.assertEqual(receipts[0]["reason"], "quality_adjustment")
        weights, _, receipts = self.evaluate(report(0, now=NOW + 3601), state, NOW + 3601)
        self.assertEqual(weights, {"x": 1.0})
        self.assertEqual(receipts[0]["reason"], "minimum_residency")

    def test_missing_evidence_never_reuses_a_stored_penalty(self):
        _, state, _ = self.evaluate(report())
        weights, _, receipts = self.evaluate(None, state)
        self.assertEqual(weights, {})
        self.assertIsNone(receipts[0]["score"])

    def test_targets_stay_within_desired_floor_caps_and_holds(self):
        weights, _, _ = self.evaluate(report())
        for desired, floor, bound, held, level in itertools.product((0, 8, 32), (0, 10), (0, 6, 32), (False, True), range(4)):
            view = {"x": dict(desired=desired, floor=floor, bound=bound, held=held)}
            baseline = fc.plan({}, view, level)["lanes"]["x"]
            actual = fc.plan({}, view, level, outcome_weights=weights)["lanes"]["x"]
            self.assertLessEqual(actual["target"], min(desired, bound, baseline["target"]))
            self.assertGreaterEqual(actual["target"], min(floor, desired, bound))
            self.assertEqual(actual["held"], held)
        actual = fc.plan({}, {"x": dict(desired=32, floor=10, bound=32, held=False)}, 0, outcome_weights=weights)
        self.assertEqual(actual["lanes"]["x"]["target"], 24)

    def test_probe_requests_existing_report_and_ignores_stale_exports(self):
        # Load only the probe, never execute a dispatcher tick or touch the host.
        tree = ast.parse((Path(__file__).resolve().parents[1] / "dispatchd.py").read_text())
        probe = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "_eval_report")
        calls = []
        def run(cmd, timeout):
            calls.append((cmd, timeout))
            return SimpleNamespace(returncode=0, stdout=json.dumps(report()))
        for age, expected in ((0, True), (900, True), (901, False), (-1, False)):
            scope = dict(R="/synthetic", json=json, _run=run,
                         time=SimpleNamespace(time=lambda: NOW),
                         os=SimpleNamespace(path=SimpleNamespace(exists=lambda _: True),
                                            stat=lambda _: SimpleNamespace(st_mtime=NOW - age)))
            exec(compile(ast.Module(body=[probe], type_ignores=[]), "probe", "exec"), scope)
            self.assertEqual(scope["_eval_report"]()["schema"], "fleet.eval-report.v1")
            self.assertEqual("--prs" in calls[-1][0], expected)
            self.assertEqual(calls[-1][1], 8)
        scope["_run"] = lambda *args, **kw: SimpleNamespace(returncode=1, stdout="bad")
        self.assertIsNone(scope["_eval_report"]())

    def test_dispatcher_tick_applies_only_in_enforce_and_persists_receipts(self):
        from test_dispatchd import build, devin_slot, held_lanes, slots_of, tick
        for mode, expected in (("shadow", 8), ("enforce", 6)):
            slots = held_lanes()
            slots["devin"] = devin_slot(target=8, floor=3, ceiling=10, hard_cap=10)
            with build(slots=slots) as directory:
                home = Path(directory)
                source = report(now=time.time())
                for p in source["pullRequests"]:
                    p["lane"] = "devin"
                stub = home / "stubbin" / "phm"
                stub.write_text("#!/bin/sh\nprintf '%s\\n' " + shlex.quote(json.dumps(source)) + "\n")
                stub.chmod(0o755)
                result = tick(home, {"FLEET_CTL_MODE": mode, "FLEET_CTL_PHASES": "b"})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(slots_of(home)["devin"]["effective_target"], expected)
                self.assertEqual(slots_of(home)["devin"]["target"], 8)
                state = json.loads((home / ".ashlr-runs/queue/fleet-controller.json").read_text())
                receipt = next(r for r in state["quality_receipts"] if r["lane"] == "devin")
                self.assertEqual((receipt["mode"], receipt["target_from"], receipt["target_to"]), (mode, 8, 6))
                ledger = json.loads((home / ".ashlr-runs/metrics/fleet-controller.jsonl").read_text())
                self.assertEqual(ledger["quality_receipts"], state["quality_receipts"])


if __name__ == "__main__":
    unittest.main()
