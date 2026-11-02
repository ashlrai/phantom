import io
import json
import tempfile
import threading
import unittest
from pathlib import Path

import recovery_watch
import recover_services


class FakeRunner:
    def __init__(self):
        self.healthy = False
        self.kicks = []

    def run(self, argv, timeout):
        if argv[0] == "memory_pressure":
            return 0, "System-wide memory free percentage: %d%%" % (60 if self.healthy else 10), "", ""
        if argv[0] == "/usr/sbin/sysctl":
            return 0, "1" if "pressure" in argv[-1] else "used = 0M", "", ""
        if argv[1] == "kickstart":
            self.kicks.append(argv[-1])
            return 0, "", "", ""
        return 0, "state = stopped", "", ""


class WatchTests(unittest.TestCase):
    def test_real_recovery_retries_after_pressure_clears(self):
        runner = FakeRunner()
        calls = []
        with tempfile.TemporaryDirectory() as directory:
            def call(argv, **kwargs):
                calls.append(argv)
                return recover_services.main(argv, **kwargs)
            def wait(_seconds):
                runner.healthy = True
                return False
            output = io.StringIO()
            recovery_watch.main(["--apply", "--max-passes", "2", "--runs-dir", directory],
                                {"call": call, "wait": wait, "now": lambda: 1,
                                 "recovery_deps": {"runner": runner, "uid": 123,
                                                   "home": directory, "now": 1}}, output)
            self.assertEqual(len(calls), 2)
            self.assertTrue(all("--apply" in args for args in calls))
            self.assertEqual(len(runner.kicks), 2)
            records = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual([r["pass"] for r in records], [1, 2])
            self.assertNotIn(directory, output.getvalue())

    def test_dry_run_and_bounded_failures(self):
        calls, waits = [], []
        def call(argv, **_kwargs):
            calls.append(argv)
            raise RuntimeError("private detail")
        output = io.StringIO()
        recovery_watch.main(["--max-passes", "3", "--service", "memguard=ai.ashlr.guard"],
                            {"call": call, "wait": lambda seconds: waits.append(seconds),
                             "now": lambda: 1}, output)
        self.assertEqual(len(calls), 3)
        self.assertEqual(len(waits), 2)
        self.assertTrue(all("--apply" not in args for args in calls))
        self.assertIn("memguard=ai.ashlr.guard", calls[0])
        self.assertNotIn("private detail", output.getvalue())
        self.assertTrue(all(json.loads(line)["outcome"] == "failed" for line in output.getvalue().splitlines()))

    def test_invalid_arguments_never_call_recovery(self):
        calls = []
        for args in (["--max-passes", "0"], ["--max-passes", "10001"],
                     ["--interval-seconds", "nan"], ["--interval-seconds", "0"],
                     ["--service", "leader=bad"], ["--unknown"]):
            with self.subTest(args=args), self.assertRaises(SystemExit):
                recovery_watch.main(args, {"call": lambda *a, **k: calls.append(a)})
        self.assertEqual(calls, [])

    def test_cancellation_during_wait_prevents_next_pass(self):
        stop = threading.Event()
        calls = []
        def call(argv, **kwargs):
            calls.append(argv)
            print('{"complete": false}', file=kwargs["out"])
            return 2
        def wait(_seconds):
            stop.set()
            return True
        recovery_watch.main(["--max-passes", "3"],
                            {"call": call, "stop": stop, "wait": wait, "now": lambda: 1}, io.StringIO())
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
