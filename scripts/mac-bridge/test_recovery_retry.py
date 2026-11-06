#!/usr/bin/env python3
"""Fixture tests for recovery_retry.py. The real recover_services.main path runs
against FakeRunner output and a fake clock; all state lives in per-test
temporary directories; no live launchctl, service, sentinel or child process
is ever touched."""
import io, json, os, signal, sys, tempfile, threading, time, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import recovery_retry as rr       # noqa: E402
from test_recover_services import FakeRunner as _BaseRunner, ALL_LABELS, SUPPLIED, svc_args  # noqa: E402


class FakeRunner(_BaseRunner):
    """Adds kickstays: kickstart accepted but the service exits at once."""

    def __init__(self, states=None, tele=None, kickstays=()):
        super().__init__(states, tele)
        self.kickstays = set(kickstays)

    def run(self, argv, timeout):
        if argv[:2] == ["launchctl", "kickstart"] \
                and argv[2].rsplit("/", 1)[-1] in self.kickstays:
            self.calls.append(list(argv))
            return 0, "", "", ""
        return super().run(argv, timeout)


def kicks(runner):
    return [c[2] for c in runner.calls if c[:2] == ["launchctl", "kickstart"]]


class RetryTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.home = Path(self._tmp.name)
        self.runs = self.home / ".ashlr-runs"
        self.runs.mkdir()
        self.state = self.runs / rr.STATE_NAME
        self.clock = [1_800_000_000]

    def run_retry(self, runner, argv, default_state=False, **deps):
        args = ["--runs-dir", str(self.runs), "--cooldown-base-seconds", "100"]
        if not default_state:
            args += ["--state-file", str(self.state)]
        merged = {"now": lambda: self.clock[0], "wait": lambda _s: False,
                  "recovery_deps": {"runner": runner, "uid": 501, "home": str(self.home)}}
        merged.update(deps)
        out = io.StringIO()
        code = rr.main(args + argv, merged, out)
        self.output = out.getvalue()
        return code, [json.loads(line) for line in self.output.splitlines()]

    def test_stopped_service_one_kickstart_then_cooldown(self):
        runner = FakeRunner({l: "stopped" for l in ALL_LABELS.values()},
                            kickstays=set(ALL_LABELS.values()))
        code, records = self.run_retry(runner, ["--apply", "--max-passes", "3"] + svc_args())
        self.assertEqual(code, 0)
        self.assertEqual(len(kicks(runner)), 4)          # one attempt each, pass 1 only
        first = records[0]["services"]
        self.assertTrue(all(s["status"] == "kickstarted" for s in first.values()))
        self.assertTrue(all(s["attempts"] == 1 for s in first.values()))
        for record in records[1:]:
            self.assertEqual(record["retryState"], "ok")
            for s in record["services"].values():
                self.assertEqual((s["status"], s["attempts"], s["retryInSeconds"]),
                                 ("cooldown", 1, 100))
        self.assertNotIn("pid =", self.output)           # metadata only, no raw output

    def test_independent_services_track_separate_streaks(self):
        orch, dispatch = ALL_LABELS["orch"], ALL_LABELS["dispatch"]
        runner = FakeRunner({ALL_LABELS["leader"]: "running", SUPPLIED["memguard"]: "running",
                             orch: "stopped", dispatch: "running"}, kickstays={orch})
        def wait(_s):
            runner.states[dispatch] = "stopped"          # dispatch eligible from pass 2
            return False
        code, records = self.run_retry(runner, ["--apply", "--max-passes", "2"] + svc_args(),
                                       wait=wait)
        self.assertEqual(kicks(runner), ["gui/501/" + orch, "gui/501/" + dispatch])
        self.assertEqual(records[1]["services"]["orch"]["status"], "cooldown")
        self.assertEqual(records[1]["services"]["dispatch"]["status"], "started")

    def test_running_observation_clears_streak(self):
        orch = ALL_LABELS["orch"]
        runner = FakeRunner({orch: "stopped"}, kickstays={orch})
        def wait(_s):
            runner.states[orch] = "running"              # service comes up on its own
            return False
        code, records = self.run_retry(runner, ["--apply", "--max-passes", "2"] + svc_args(),
                                       wait=wait)
        self.assertEqual(kicks(runner), ["gui/501/" + orch])
        self.assertEqual(records[1]["services"]["orch"]["status"], "running")
        self.assertTrue(records[1]["services"]["orch"]["cleared"])
        self.assertNotIn(orch, json.loads(self.state.read_text())["services"])

    def test_expiry_permits_retry_and_backoff_grows(self):
        orch = ALL_LABELS["orch"]
        runner = FakeRunner({orch: "stopped"}, kickstays={orch})
        def wait(_s):
            self.clock[0] += 250                          # base 100 → attempt 2; 2^1*100 → attempt 3
            return False
        code, records = self.run_retry(runner, ["--apply", "--max-passes", "3"] + svc_args(),
                                       wait=wait)
        self.assertEqual(kicks(runner), ["gui/501/" + orch] * 3)
        self.assertEqual(records[1]["services"]["orch"]["attempts"], 2)
        state = json.loads(self.state.read_text())["services"][orch]
        self.assertEqual(state["attempts"], 3)

    def test_reopened_state_preserves_cooldown(self):
        orch = ALL_LABELS["orch"]
        runner = FakeRunner({orch: "stopped"}, kickstays={orch})
        self.run_retry(runner, ["--apply", "--max-passes", "1"] + svc_args(), default_state=True)
        runner2 = FakeRunner({orch: "stopped"}, kickstays={orch})
        code, records = self.run_retry(runner2, ["--apply", "--max-passes", "1"] + svc_args(),
                                     default_state=True)
        self.assertEqual(kicks(runner2), [])
        service = records[0]["services"]["orch"]
        self.assertEqual((service["status"], service["attempts"]), ("cooldown", 1))
        self.assertEqual(json.loads(self.state.read_text())["services"][orch]["attempts"], 1)

    def test_preview_never_mutates(self):
        runner = FakeRunner({l: "stopped" for l in ALL_LABELS.values()})
        code, records = self.run_retry(runner, ["--max-passes", "2"] + svc_args())
        self.assertEqual(kicks(runner), [])
        self.assertFalse(self.state.exists())
        self.assertFalse(Path(str(self.state) + ".lock").exists())
        self.assertTrue(all(r["retryState"] == "preview" for r in records))
        self.assertTrue(all(s["status"] == "stopped" for s in records[0]["services"].values()))

    def test_concurrent_invocations_cannot_double_kickstart(self):
        orch = ALL_LABELS["orch"]
        runner = FakeRunner({orch: "stopped"}, kickstays={orch})
        barrier, results = threading.Barrier(3), []
        def worker():
            barrier.wait()
            out = io.StringIO()
            results.append(rr.main(["--apply", "--max-passes", "1", "--runs-dir", str(self.runs),
                                    "--cooldown-base-seconds", "100"] + svc_args(),
                                   {"now": lambda: self.clock[0], "wait": lambda _s: False,
                                    "recovery_deps": {"runner": runner, "uid": 501,
                                                      "home": str(self.home)}}, out))
        threads = [threading.Thread(target=worker) for _ in range(2)]
        for t in threads:
            t.start()
        barrier.wait()
        for t in threads:
            t.join(30)
        self.assertEqual(sorted(results), [0, 0])
        self.assertEqual(kicks(runner), ["gui/501/" + orch])
        self.assertEqual(json.loads(self.state.read_text())["services"][orch]["attempts"], 1)

    def test_sigterm_interrupts_wait(self):
        orch = ALL_LABELS["orch"]
        runner = FakeRunner({orch: "stopped"}, kickstays={orch})
        timer = threading.Timer(0.2, lambda: os.kill(os.getpid(), signal.SIGTERM))
        timer.start()
        self.addCleanup(timer.cancel)
        started = time.monotonic()
        code, records = self.run_retry(runner, ["--apply", "--max-passes", "5",
                                                "--interval-seconds", "30"] + svc_args(),
                                       wait=None)
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(len(records), 1)

    def test_unsafe_or_corrupt_state_fails_closed(self):
        orch = ALL_LABELS["orch"]
        runner = FakeRunner({orch: "stopped"}, kickstays={orch})
        self.state.write_text("{not json")
        os.chmod(self.state, 0o600)
        code, records = self.run_retry(runner, ["--apply", "--max-passes", "1"] + svc_args())
        self.assertEqual(kicks(runner), [])
        self.assertEqual(records[0]["retryState"], "corrupt")
        svc = records[0]["services"]["orch"]
        self.assertEqual((svc["status"], svc["refused"]), ("failed", "corrupt"))
        self.assertEqual(self.state.read_text(), "{not json")   # never rewritten
        self.state.write_text(json.dumps({"schema": rr.STATE_SCHEMA, "maxSeen": self.clock[0],
                                         "services": {orch: {"attempts": 1,
                                                             "lastAttempt": self.clock[0]}}}))
        self.clock[0] -= 3600                               # wall clock moved backwards
        code, records = self.run_retry(runner, ["--apply", "--max-passes", "1"] + svc_args())
        self.assertEqual((kicks(runner), records[0]["retryState"]), ([], "rollback"))
        self.assertEqual(records[0]["services"]["orch"]["refused"], "rollback")
        self.state.unlink()
        self.state.symlink_to(self.home / "elsewhere.json")
        code, records = self.run_retry(runner, ["--apply", "--max-passes", "1"] + svc_args())
        self.assertEqual((kicks(runner), records[0]["retryState"]), ([], "unsafe"))
        self.state.unlink()
        self.state.write_text("{}")
        os.chmod(self.state, 0o644)
        code, records = self.run_retry(runner, ["--apply", "--max-passes", "1"] + svc_args())
        self.assertEqual((kicks(runner), records[0]["retryState"]), ([], "unsafe"))

    def test_gates_pass_through_unchanged(self):
        (self.runs / "PAUSE").write_text("memguard\n")
        mg, orch = SUPPLIED["memguard"], ALL_LABELS["orch"]
        runner = FakeRunner({mg: "stopped", orch: "stopped"}, kickstays={mg, orch})
        code, records = self.run_retry(runner, ["--apply", "--max-passes", "2"] + svc_args())
        first, second = records[0]["services"], records[1]["services"]
        self.assertEqual(first["memguard"]["status"], "kickstarted")   # monitor unaffected
        self.assertEqual(first["orch"]["status"], "blocked")           # compute gate intact
        self.assertEqual(second["memguard"]["status"], "cooldown")
        self.assertEqual(second["orch"]["status"], "blocked")
        self.assertEqual(kicks(runner), ["gui/501/" + mg])

    def test_lock_failure_returns_metadata(self):
        missing = self.home / "no-such-dir"
        runner = FakeRunner({ALL_LABELS["orch"]: "stopped"})
        out = io.StringIO()
        code = rr.main(["--apply", "--runs-dir", str(missing)],
                       {"recovery_deps": {"runner": runner, "uid": 501, "home": str(self.home)},
                        "now": lambda: 1_800_000_000, "wait": lambda _s: False}, out)
        self.assertEqual(code, rr.EXIT_LOCKED)
        self.assertEqual(json.loads(out.getvalue())["outcome"], "lock-failed")
        self.assertEqual(kicks(runner), [])

    def test_invalid_args_never_touch_runner(self):
        runner = FakeRunner()
        for argv in (["--max-passes", "0"], ["--interval-seconds", "0"],
                     ["--cooldown-base-seconds", "0"], ["--cooldown-max-seconds", "nan"],
                     ["--service", "leader=bad"], ["--bogus"]):
            with self.subTest(argv=argv), self.assertRaises(SystemExit):
                self.run_retry(runner, argv)
        self.assertEqual(runner.calls, [])


if __name__ == "__main__":
    unittest.main()
