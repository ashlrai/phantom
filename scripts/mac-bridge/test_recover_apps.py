#!/usr/bin/env python3
"""Fixture tests for recover_apps.py and the recovery_watch --recover-apps flag.

Fake runner and fake system, per-test temporary runs directories; no live
launchctl, osascript, service or GUI application is ever touched.
"""
import io, json, stat, sys, tempfile, unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import app_control          # noqa: E402
import recover_apps         # noqa: E402
import recover_services     # noqa: E402
import recovery_watch       # noqa: E402
from test_recover_services import FakeRunner, ALL_LABELS, svc_args   # noqa: E402

NOW = 1_800_000_000
SOURCE = Path(recover_apps.__file__).read_text("utf-8")
STALE_HOLD = json.dumps({"schema": recover_services.HOLD_SCHEMA,
                         "kind": recover_services.HOLD_KIND, "expires": NOW - 60})
ACTIVE_HOLD = json.dumps({"schema": recover_services.HOLD_SCHEMA,
                          "kind": recover_services.HOLD_KIND, "expires": NOW + 600})


class FakeSystem:
    """app_control system double. An open is recorded but the app stays stopped,
    so repeat passes exercise the receipt bound rather than the running check."""

    def __init__(self, state=False, error=None, available=True):
        self.state, self.error, self.available = state, error, available
        self.events = []

    def resolve(self, filename):
        self.events.append(("resolve", filename))
        return ("/known/Phantom.app", "com.example.phantom") if self.available else None

    def running(self, bundle):
        self.events.append(("running", bundle))
        if self.error:
            raise app_control.ControlError(self.error)
        return self.state

    def launch(self, path):
        self.events.append(("launch", path))


def launches(system):
    return [e for e in system.events if e[0] == "launch"]


class RecoverAppsTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.home = Path(self._tmp.name)
        self.runs = self.home / ".ashlr-runs"
        self.runs.mkdir()
        self.receipt = self.runs / "recovery-receipts" / "app-launch-phantom.json"

    def run_apps(self, argv, runner=None, system=None, now=NOW):
        out = io.StringIO()
        code = recover_apps.main(["--runs-dir", str(self.runs)] + argv,
                                 deps={"runner": runner or FakeRunner(), "system": system,
                                       "uid": 501, "home": str(self.home), "now": now}, out=out)
        return code, json.loads(out.getvalue())

    def test_healthy_stopped_opens_once_automatic_with_receipt(self):
        system = FakeSystem(False)
        calls, real = [], app_control.handle
        def spy(action, name, automatic, output_dir, system=None):
            calls.append((action, name, automatic))
            return real(action, name, automatic, output_dir, system)
        with mock.patch.object(app_control, "handle", spy):
            code, rep = self.run_apps(["--apply"], system=system)
        self.assertEqual(code, 0)
        self.assertEqual((rep["schema"], rep["apply"], rep["telemetry"]["healthy"]),
                         (recover_apps.SCHEMA, True, True))
        (app,) = rep["apps"]
        self.assertEqual((app["app"], app["status"]), ("phantom", "launched"))
        self.assertEqual(calls, [("status", "phantom", True), ("launch", "phantom", True)])
        self.assertEqual(launches(system), [("launch", "/known/Phantom.app")])
        self.assertEqual(stat.S_IMODE(self.receipt.lstat().st_mode), 0o600)
        doc = json.loads(self.receipt.read_text())
        self.assertEqual((doc["schema"], doc["app"], doc["launchedAt"]),
                         (recover_apps.RECEIPT_SCHEMA, "phantom", NOW))

    def test_window_bounds_repeat_and_expiry_allows(self):
        system = FakeSystem(False)
        self.run_apps(["--apply"], system=system, now=NOW)
        code, rep = self.run_apps(["--apply"], system=system, now=NOW + 60)
        self.assertEqual(rep["apps"][0]["status"], "skipped")
        self.assertIn("bounded", rep["apps"][0]["detail"])
        self.assertEqual(len(launches(system)), 1)
        code, rep = self.run_apps(["--apply"], system=system,
                                  now=NOW + recover_apps.LAUNCH_WINDOW_SECONDS + 1)
        self.assertEqual((rep["apps"][0]["status"], code), ("launched", 0))
        self.assertEqual(len(launches(system)), 2)

    def test_unsafe_or_unknown_telemetry_skips_with_reason(self):
        for tele in ({"freePct": None, "pressureLevel": None, "swapGib": None},
                     {"freePct": 10, "pressureLevel": 1, "swapGib": 1.0},
                     {"freePct": 60, "pressureLevel": 2, "swapGib": 1.0},
                     {"freePct": 60, "pressureLevel": 1, "swapGib": 9.0}):
            system = FakeSystem(False)
            code, rep = self.run_apps(["--apply"], runner=FakeRunner(tele=tele), system=system)
            self.assertEqual(rep["apps"][0]["status"], "skipped", tele)
            self.assertIn("telemetry", rep["apps"][0]["detail"], tele)
            self.assertEqual(launches(system), [], tele)
            self.assertEqual(code, 0, tele)
            self.assertFalse(self.receipt.exists(), tele)

    def test_pause_and_hold_gates_skip_or_allow(self):
        (self.runs / "PAUSE").write_text("memguard\n")
        system = FakeSystem(False)
        code, rep = self.run_apps(["--apply"], system=system)
        self.assertEqual(rep["apps"][0]["status"], "skipped")
        self.assertIn("PAUSE", rep["apps"][0]["detail"])
        self.assertEqual(launches(system), [])
        self.assertEqual(code, 0)
        (self.runs / "PAUSE").unlink()
        for text, want in (("codex-cmp claude\n", "deliberate"), (ACTIVE_HOLD, "active")):
            (self.runs / "HOLD").write_text(text)
            code, rep = self.run_apps(["--apply"], system=system)
            self.assertEqual(rep["apps"][0]["status"], "skipped", want)
            self.assertIn(want, rep["apps"][0]["detail"], want)
            self.assertEqual(launches(system), [], want)
            self.assertEqual(code, 0, want)
        (self.runs / "HOLD").write_text(STALE_HOLD)
        code, rep = self.run_apps(["--apply"], system=system)
        self.assertEqual((rep["apps"][0]["status"], code), ("launched", 0))
        self.assertEqual(len(launches(system)), 1)

    def test_already_running_never_opens(self):
        system = FakeSystem(True)
        code, rep = self.run_apps(["--apply"], system=system)
        self.assertEqual((rep["apps"][0]["status"], code), ("running", 0))
        self.assertEqual(launches(system), [])
        self.assertFalse(self.receipt.exists())

    def test_default_mode_reports_status_only(self):
        system = FakeSystem(False)
        code, rep = self.run_apps([], system=system)
        self.assertEqual((rep["apply"], rep["apps"][0]["status"], code),
                         (False, "stopped", 0))
        self.assertEqual(launches(system), [])
        self.assertFalse(self.receipt.exists())

    def test_unknown_status_and_failed_open_never_succeed(self):
        system = FakeSystem(False, error="status_unknown")
        code, rep = self.run_apps(["--apply"], system=system)
        self.assertEqual((rep["apps"][0]["status"], code), ("unknown", 0))
        self.assertEqual(launches(system), [])
        self.assertFalse(self.receipt.exists())
        system = FakeSystem(False)
        system.launch = mock.Mock(side_effect=app_control.ControlError("request_refused"))
        code, rep = self.run_apps(["--apply"], system=system)
        self.assertEqual((rep["apps"][0]["status"], code), ("failed", 2))
        self.assertIn("request_refused", rep["apps"][0]["detail"])

    def test_allowlist_is_fixed_and_source_has_no_termination_path(self):
        self.assertEqual(recover_apps.RECOVER_APPS, ("phantom",))
        for bad in ("subprocess", "osascript", "Popen", "os.system",
                    "check_output", "quit", "restart"):
            self.assertNotIn(bad, SOURCE)
        for args in (["safari"], ["--service", "x=y"], ["--apps", "safari"]):
            with self.subTest(args=args), self.assertRaises(SystemExit):
                self.run_apps(args)


class WatchFlagTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.runs = Path(self._tmp.name)

    def watch(self, runner, argv, app_calls):
        def call(args, **kwargs):
            return recover_services.main(args, **kwargs)
        def app_call(args, deps=None, out=None):
            app_calls.append(list(args))
            print('{"schema":"ashlr.app-recovery.v1"}', file=out)
            return 0
        out = io.StringIO()
        code = recovery_watch.main(
            ["--max-passes", "1", "--runs-dir", str(self.runs)] + argv,
            {"call": call, "app_call": app_call, "now": lambda: NOW,
             "recovery_deps": {"runner": runner, "uid": 501,
                               "home": str(self.runs), "now": NOW}}, out)
        return code, [json.loads(line) for line in out.getvalue().splitlines()]

    def test_flag_runs_app_recovery_after_complete_pass(self):
        runner = FakeRunner({label: "running" for label in ALL_LABELS.values()})
        calls = []
        code, records = self.watch(runner, ["--recover-apps"] + svc_args(), calls)
        self.assertEqual(len(calls), 1)
        self.assertIn("--apply", calls[0])
        self.assertIn(str(self.runs), calls[0])
        self.assertTrue(records[0]["complete"])
        self.assertEqual(records[0]["appRecovery"], {"exitCode": 0})

    def test_flag_does_not_run_after_incomplete_pass(self):
        runner = FakeRunner({label: "stopped" for label in ALL_LABELS.values()})
        calls = []
        code, records = self.watch(runner, ["--recover-apps"] + svc_args(), calls)
        self.assertFalse(records[0]["complete"])
        self.assertEqual(calls, [])
        self.assertNotIn("appRecovery", records[0])

    def test_absent_flag_never_runs_app_recovery(self):
        runner = FakeRunner({label: "running" for label in ALL_LABELS.values()})
        calls = []
        code, records = self.watch(runner, svc_args(), calls)
        self.assertTrue(records[0]["complete"])
        self.assertEqual(calls, [])
        self.assertNotIn("appRecovery", records[0])


if __name__ == "__main__":
    unittest.main()
