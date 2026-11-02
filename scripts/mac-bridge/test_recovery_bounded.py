#!/usr/bin/env python3
"""Tests for recovery_bounded.py. Children are injected via deps['child_argv'];
no live launchctl or service is touched."""
import io, json, os, subprocess, sys, tempfile, threading, time, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import recovery_bounded as rb   # noqa: E402

HERE = Path(__file__).resolve().parent
# Hung probe + SIGTERM-ignoring descendant in one group; only SIGKILL reaps it.
HUNG_GROUP = '''import os, signal, subprocess, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
open(sys.argv[1] + ".pid", "w").write(str(os.getpid()))
d = subprocess.Popen([sys.executable, "-c",
    "import signal,time\\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\\nwhile True:time.sleep(0.2)"])
open(sys.argv[1] + ".desc", "w").write(str(d.pid))
while True: time.sleep(0.2)
'''
SLEEPER = 'import os,sys,time\nopen(sys.argv[1]+".pid","w").write(str(os.getpid()))\nwhile True:time.sleep(0.2)'
ECHO = 'import json,sys\nprint(json.dumps({"schema":"ashlr.service-recovery.v1","complete":True,"argv":sys.argv[1:]}))'
BAD = 'print("definitely not a report")'
FLOOD = 'import sys\nsys.stdout.write("x" * 65536)\nsys.stdout.flush()'
# Real recover_services.main in-child with a fake runner (deps seam; no launchctl).
STUB = '''import sys
sys.path.insert(0, @DIR@)
import recover_services
class Runner:
    def run(self, argv, timeout):
        if argv[0] == "memory_pressure":
            return 0, "System-wide memory free percentage: 60%", "", ""
        if argv[0] == "/usr/sbin/sysctl":
            return 0, "1" if "pressure" in argv[-1] else "used = 0M", "", ""
        if argv[:2] == ["launchctl", "print"]:
            pid = "\\n\\tpid = 4242" if @RUNNING@ else ""
            state = "running" if @RUNNING@ else "not running"
            return 0, "state = " + state + pid, "", ""
        return (0, "", "", "") if argv[:2] == ["launchctl", "kickstart"] else (1, "", "", "")
sys.exit(recover_services.main(sys.argv[1:],
    deps={"runner": Runner(), "uid": 501, "home": @HOME@, "now": 1}))
'''

def stub(running):
    return (STUB.replace("@DIR@", repr(str(HERE))).replace("@HOME@", repr(tempfile.gettempdir()))
                .replace("@RUNNING@", repr(running)))


class BoundedTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)
        self.runs = self.base / "runs"; self.runs.mkdir()

    def run_main(self, args, child_argv=None, **deps):
        if child_argv is not None:
            deps["child_argv"] = child_argv
        out = io.StringIO()
        code = rb.main(["--runs-dir", str(self.runs)] + args, deps, out)
        return code, out.getvalue()

    def wait_for(self, pred, msg):
        end = time.monotonic() + 5
        while time.monotonic() < end:
            value = pred()
            if value:
                return value
            time.sleep(0.05)
        self.fail(msg)

    def wait_gone(self, pid):
        def gone():
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return True
        self.wait_for(gone, "pid %d survived group cleanup" % pid)

    def wait_file(self, path):
        return self.wait_for(lambda: path.exists() and path.read_text() or None,
                             "no content in %s" % path)

    def test_timeout_stops_and_reaps_only_owned_group(self):
        marker = str(self.base / "hung")
        survivor = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"],
                                    start_new_session=True)
        self.addCleanup(lambda: (survivor.poll() is None and survivor.kill(), survivor.wait()))
        start = time.monotonic()
        code, text = self.run_main(["--pass-timeout-seconds", "3"],
                                   [sys.executable, "-c", HUNG_GROUP, marker], grace=0.3)
        self.assertLess(time.monotonic() - start, 10)
        record = json.loads(text)
        self.assertEqual((code, record["schema"], record["outcome"], record["exitCode"]),
                         (rb.EXIT_FAILED, rb.SCHEMA, "timeout", None))
        for suffix in (".pid", ".desc"):
            self.wait_gone(int(self.wait_file(Path(marker + suffix))))
        self.assertIsNone(survivor.poll())   # unrelated process never signalled

    def test_real_recover_services_report_propagates(self):
        svc = ["--service", "memguard=ai.ashlr.guard", "--service", "dispatch=ai.ashlr.dispatch"]
        code, text = self.run_main(["--apply", "--pass-timeout-seconds", "20"] + svc,
                                   [sys.executable, "-c", stub(True)])
        report = json.loads(text)
        self.assertEqual((code, report["schema"], report["complete"], report["apply"]),
                         (0, "ashlr.service-recovery.v1", True, True))
        self.assertEqual((report["runsDir"], len(report["services"])), (str(self.runs), 4))
        code, text = self.run_main(["--pass-timeout-seconds", "20"] + svc,
                                   [sys.executable, "-c", stub(False)])
        report = json.loads(text)
        self.assertEqual((code, report["complete"], report["apply"]), (2, False, False))

    def test_malformed_and_oversized_output_rejected_bounded(self):
        code, text = self.run_main(["--pass-timeout-seconds", "10"], [sys.executable, "-c", BAD])
        self.assertEqual((code, json.loads(text)["outcome"]), (rb.EXIT_FAILED, "invalid-output"))
        self.assertNotIn("definitely", text)
        code, text = self.run_main(["--pass-timeout-seconds", "10"],
                                   [sys.executable, "-c", FLOOD], max_output=4096)
        self.assertEqual((code, json.loads(text)["outcome"]), (rb.EXIT_FAILED, "invalid-output"))
        self.assertLess(len(text), 2000)   # metadata only; the flood is never copied

    def test_preview_apply_and_forwarding(self):
        for extra, want in (([], False), (["--apply"], True)):
            code, text = self.run_main(["--service", "memguard=ai.ashlr.guard",
                                        "--pass-timeout-seconds", "10"] + extra,
                                       [sys.executable, "-c", ECHO])
            argv = json.loads(text)["argv"]
            self.assertEqual((code, argv[0], "--apply" in argv), (0, "--json", want))
            self.assertIn(str(self.runs), argv)
            self.assertIn("memguard=ai.ashlr.guard", argv)

    def test_default_argv_is_interpreter_plus_fixed_sibling(self):
        argv = rb.child_argv(rb.parse_args(["--apply", "--runs-dir", "/tmp/x"]), {})
        self.assertEqual(argv[:3], [sys.executable, str(rb.SCRIPT), "--json"])
        self.assertEqual((rb.SCRIPT.name, rb.SCRIPT.exists()), ("recover_services.py", True))

    def test_cancel_pre_cancel_and_spawn_failure(self):
        marker = str(self.base / "sleeper")
        stop = threading.Event()
        threading.Thread(target=lambda: (self.wait_file(Path(marker + ".pid")), stop.set()),
                         daemon=True).start()
        code, text = self.run_main(["--pass-timeout-seconds", "30"],
                                   [sys.executable, "-c", SLEEPER, marker],
                                   stop=stop, grace=0.3)
        self.assertEqual((code, json.loads(text)["outcome"]), (rb.EXIT_FAILED, "cancelled"))
        self.wait_gone(int(Path(marker + ".pid").read_text()))
        spawned, stop2 = [], threading.Event(); stop2.set()
        code, text = self.run_main([], [sys.executable, "-c", "pass"], stop=stop2,
                                   popen=lambda *a, **k: spawned.append(a) or None)
        self.assertEqual((json.loads(text)["outcome"], spawned), ("cancelled", []))
        def boom(*a, **k):
            raise OSError("nope")
        code, text = self.run_main([], [sys.executable, "-c", "pass"], popen=boom)
        record = json.loads(text)
        self.assertEqual((code, record["outcome"], record["detail"]),
                         (rb.EXIT_FAILED, "failed", "spawn:OSError"))

    def test_invalid_args_exit_before_any_spawn(self):
        spawned, deps = [], {"popen": lambda *a, **k: spawned.append(a)}
        for args in (["--pass-timeout-seconds", "0"], ["--pass-timeout-seconds", "nan"],
                     ["--pass-timeout-seconds", "99999"], ["--service", "leader=bad"], ["--bogus"]):
            with self.subTest(args=args), self.assertRaises(SystemExit):
                rb.main(args, dict(deps), io.StringIO())
        self.assertEqual(spawned, [])

if __name__ == "__main__":
    unittest.main()
