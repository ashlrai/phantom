#!/usr/bin/env python3
"""Fixture tests for recover_services.py (RQ-PHX-FLEETREBOOTRECOVERY01SOLB4).

All launchctl/sysctl/memory_pressure inputs are injected through FakeRunner and
all filesystem state lives in a per-test temporary directory; no live service,
sentinel or child process is ever touched.
"""
import io, json, sys, tempfile, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import recover_services as rc   # noqa: E402

NOW = 1_800_000_000
HEALTHY = {"freePct": 60, "pressureLevel": 1, "swapGib": 1.0}
SUPPLIED = {"memguard": "ai.ashlr.memguard", "dispatch": "ai.ashlr.dispatch"}
ALL_LABELS = {**rc.TRACKED_LABELS, **SUPPLIED}
STALE_HOLD = json.dumps({"schema": rc.HOLD_SCHEMA, "kind": rc.HOLD_KIND, "expires": NOW - 60})


class FakeRunner:
    """Injectable command double; never spawns a child process."""

    def __init__(self, states=None, tele=None, kickfail=()):
        self.states = dict(states or {})      # label -> "running" | "stopped" (absent otherwise)
        self.kickfail = set(kickfail)
        self.tele = HEALTHY if tele is None else tele
        self.calls = []

    def run(self, argv, timeout):
        self.calls.append(list(argv))
        if argv[:2] == ["launchctl", "print"]:
            label = argv[2].rsplit("/", 1)[-1]
            st = self.states.get(label)
            if st is None:
                return 113, "", "Could not find specified service", ""
            body = "state = running\n\tpid = 4242" if st == "running" else "state = not running"
            return 0, "gui/501/%s = {\n\t%s\n}\n" % (label, body), "", ""
        if argv[:2] == ["launchctl", "kickstart"]:
            label = argv[2].rsplit("/", 1)[-1]
            if label in self.kickfail:
                return 5, "", "", ""
            self.states[label] = "running"
            return 0, "", "", ""
        if argv[0] == "memory_pressure":
            fp = self.tele.get("freePct")
            return (0, "free percentage: %d\n" % fp, "", "") if fp is not None else (-1, "", "", "timeout")
        if argv[-1] == "kern.memorystatus_vm_pressure_level":
            pl = self.tele.get("pressureLevel")
            return (0, "%d\n" % pl, "", "") if pl is not None else (1, "", "", "")
        if argv[-1] == "vm.swapusage":
            sg = self.tele.get("swapGib")
            return (0, "total = 8192.00M  used = %.2fM  free = 0.00M\n" % (sg * 1024), "", "") \
                if sg is not None else (-1, "", "", "spawn:OSError")
        return 1, "", "", ""


def svc_args():
    return sum((["--service", "%s=%s" % (r, l)] for r, l in SUPPLIED.items()), [])


def statuses(report):
    return {s["role"]: s["status"] for s in report["services"]}


class RecoverServicesTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.runs = Path(self._tmp.name) / ".ashlr-runs"
        self.runs.mkdir()

    def run_cli(self, runner, argv, now=NOW):
        out = io.StringIO()
        code = rc.main(["--json", "--runs-dir", str(self.runs)] + argv,
                       deps={"runner": runner, "uid": 501, "now": now}, out=out)
        return code, json.loads(out.getvalue())

    def test_memguard_recovers_before_compute(self):
        runner = FakeRunner({l: "stopped" for l in ALL_LABELS.values()})
        code, rep = self.run_cli(runner, ["--apply"] + svc_args())
        kicks = [c[2] for c in runner.calls if c[:2] == ["launchctl", "kickstart"]]
        self.assertEqual(kicks, ["gui/501/" + ALL_LABELS[r] for r in rc.ROLES])
        self.assertEqual(code, 0)
        self.assertTrue(all(s["status"] == "started" for s in rep["services"]))

    def test_running_services_untouched_and_status_never_mutates(self):
        runner = FakeRunner({l: "running" for l in ALL_LABELS.values()})
        code, rep = self.run_cli(runner, ["--apply"] + svc_args())
        self.assertFalse([c for c in runner.calls if "kickstart" in c])
        self.assertEqual(code, 0)
        self.assertEqual(set(statuses(rep).values()), {"running"})
        runner = FakeRunner({l: "stopped" for l in ALL_LABELS.values()})
        code, rep = self.run_cli(runner, svc_args())          # status mode: no --apply
        self.assertFalse([c for c in runner.calls if "kickstart" in c])
        self.assertEqual(code, 2)
        self.assertEqual(set(statuses(rep).values()), {"stopped"})

    def test_deliberate_hold_preserved(self):
        (self.runs / "HOLD").write_text("codex-cmp claude\n")
        runner = FakeRunner({l: "running" for l in ALL_LABELS.values()})
        code, rep = self.run_cli(runner, ["--apply"] + svc_args())
        self.assertEqual(rep["hold"]["status"], "deliberate")
        self.assertEqual(rep["hold"]["action"], "preserved")
        self.assertEqual((self.runs / "HOLD").read_text(), "codex-cmp claude\n")
        self.assertEqual(code, 0)

    def test_stale_recovery_hold_release_gated_and_receipted(self):
        (self.runs / "HOLD").write_text(STALE_HOLD)
        runner = FakeRunner({l: "running" for l in ALL_LABELS.values()})
        code, rep = self.run_cli(runner, svc_args())          # status mode: preserved, not released
        self.assertEqual(rep["hold"]["status"], "stale")
        self.assertEqual(rep["hold"]["action"], "preserved")
        runner = FakeRunner({l: "running" for l in ALL_LABELS.values()},
                            tele={"freePct": 10, "pressureLevel": 4, "swapGib": 20.0})
        code, rep = self.run_cli(runner, ["--apply"] + svc_args())
        self.assertEqual(rep["hold"]["action"], "preserved")  # unhealthy telemetry: still preserved
        self.assertTrue((self.runs / "HOLD").exists())
        runner = FakeRunner({l: "running" for l in ALL_LABELS.values()})
        code, rep = self.run_cli(runner, ["--apply"] + svc_args())
        self.assertEqual(rep["hold"]["action"], "released")
        self.assertFalse((self.runs / "HOLD").exists())
        archived = self.runs / ("HOLD.released-%d" % NOW)
        self.assertEqual(archived.read_text(), STALE_HOLD)
        receipt = json.loads(Path(rep["hold"]["receipt"]).read_text())
        self.assertEqual(receipt["schema"], "ashlr.hold-release.v1")
        self.assertEqual(receipt["telemetry"]["freePct"], 60)
        self.assertEqual(code, 0)

    def test_pause_blocks_compute_not_memguard(self):
        (self.runs / "PAUSE").write_text("memguard\n")
        runner = FakeRunner({l: "stopped" for l in ALL_LABELS.values()})
        code, rep = self.run_cli(runner, ["--apply"] + svc_args())
        st = statuses(rep)
        self.assertEqual(st["memguard"], "started")
        self.assertEqual(st["leader"], "blocked")
        self.assertEqual(st["orch"], "blocked")
        self.assertEqual(st["dispatch"], "blocked")
        self.assertEqual(code, 2)

    def test_unsafe_or_unknown_pressure_blocks_compute(self):
        for tele in ({"freePct": None, "pressureLevel": None, "swapGib": None},
                     {"freePct": 20, "pressureLevel": 1, "swapGib": 1.0},
                     {"freePct": 60, "pressureLevel": 2, "swapGib": 1.0},
                     {"freePct": 60, "pressureLevel": 1, "swapGib": 9.0}):
            runner = FakeRunner({l: "stopped" for l in ALL_LABELS.values()}, tele=tele)
            code, rep = self.run_cli(runner, ["--apply"] + svc_args())
            self.assertFalse(rep["telemetry"]["healthy"], tele)
            self.assertEqual(statuses(rep)["orch"], "blocked", tele)
            self.assertEqual(statuses(rep)["memguard"], "started", tele)
            self.assertEqual(code, 2, tele)

    def test_not_registered_never_bootstrapped(self):
        runner = FakeRunner({ALL_LABELS["leader"]: "running", ALL_LABELS["orch"]: "running"})
        code, rep = self.run_cli(runner, ["--apply"] + svc_args())
        self.assertEqual(statuses(rep)["memguard"], "not-registered")
        self.assertEqual(statuses(rep)["dispatch"], "not-registered")
        verbs = {c[1] for c in runner.calls if c[0] == "launchctl"}
        self.assertNotIn("bootstrap", verbs)
        self.assertNotIn("kickstart", verbs)
        self.assertEqual(code, 2)

    def test_one_failure_does_not_hide_other_status(self):
        orch, leader = ALL_LABELS["orch"], ALL_LABELS["leader"]
        runner = FakeRunner({orch: "stopped", leader: "running"}, kickfail={orch})
        code, rep = self.run_cli(runner, ["--apply", "orch", "leader"])
        self.assertEqual(statuses(rep), {"leader": "running", "orch": "failed"})
        self.assertEqual(code, 2)

    def test_rejects_arbitrary_labels_and_paths(self):
        for bad in ("memguard=com.evil.miner", "dispatch=/tmp/evil.plist", "foo=ai.ashlr.x"):
            runner = FakeRunner()
            code = rc.main(["--runs-dir", str(self.runs), "--service", bad],
                           deps={"runner": runner, "uid": 501, "now": NOW}, out=io.StringIO())
            self.assertEqual(code, 2, bad)
            self.assertEqual(runner.calls, [], bad)

    def test_untracked_roles_report_limitation_not_invented(self):
        runner = FakeRunner({l: "running" for l in rc.TRACKED_LABELS.values()})
        code, rep = self.run_cli(runner, ["--apply"])
        st = statuses(rep)
        self.assertEqual(st["memguard"], "unconfigured")
        self.assertEqual(st["dispatch"], "unconfigured")
        self.assertEqual(st["leader"], "running")
        self.assertEqual(st["orch"], "running")
        probed = {c[2] for c in runner.calls if c[:2] == ["launchctl", "print"]}
        self.assertEqual(probed, {"gui/501/" + l for l in rc.TRACKED_LABELS.values()})
        self.assertIn("--service", rep["services"][0]["detail"])
        self.assertEqual(code, 2)

    def test_active_and_ambiguous_holds_preserved(self):
        for text, want in (
            (json.dumps({"schema": rc.HOLD_SCHEMA, "kind": rc.HOLD_KIND, "expires": NOW + 600}), "active"),
            ("reboot-recovery", "ambiguous"),
            ("", "ambiguous"),
        ):
            (self.runs / "HOLD").write_text(text)
            runner = FakeRunner({l: "running" for l in ALL_LABELS.values()})
            code, rep = self.run_cli(runner, ["--apply"] + svc_args())
            self.assertEqual(rep["hold"]["status"], want, repr(text))
            self.assertEqual(rep["hold"]["action"], "preserved")
            self.assertTrue((self.runs / "HOLD").exists())
            self.assertEqual(code, 0)

if __name__ == "__main__":
    unittest.main()
