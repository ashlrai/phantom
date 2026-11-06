import io
import json
import signal
import threading
import unittest

import recovery_watch


class RecoveryUntilCompleteTests(unittest.TestCase):
    def run_watch(self, replies, flags=(), cancel=False):
        calls, waits = [], []
        stop = threading.Event()
        if cancel:
            stop.set()
        replies = iter(replies)

        def call(args, deps, out):
            calls.append(args)
            report, code = next(replies)
            if isinstance(report, Exception):
                raise report
            out.write(report if isinstance(report, str) else json.dumps(report))
            return code

        def wait(interval):
            waits.append(interval)
            return False

        out = io.StringIO()
        before = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
        status = recovery_watch.main(["--max-passes", "3", *flags],
                                     deps={"call": call, "wait": wait, "stop": stop,
                                           "now": lambda: 123}, out=out)
        self.assertEqual(before, {sig: signal.getsignal(sig) for sig in before})
        records = [json.loads(line) for line in out.getvalue().splitlines()]
        return status, calls, waits, records

    def test_incomplete_then_healthy(self):
        status, calls, waits, records = self.run_watch(
            [({"complete": False}, 0), ({"complete": True, "private": "hidden"}, 0)],
            ["--until-complete"])
        self.assertEqual((status, len(calls), len(waits)), (0, 2, 1))
        self.assertEqual(records[-1]["complete"], True)
        self.assertNotIn("private", records[-1])

    def test_immediately_healthy_and_require_complete(self):
        for flags in (["--until-complete"], ["--until-complete", "--require-complete"]):
            with self.subTest(flags=flags):
                status, calls, waits, records = self.run_watch([({"complete": True}, 0)], flags)
                self.assertEqual((status, len(calls), len(waits), len(records)), (0, 1, 0, 1))

    def test_nonzero_and_boolean_codes_continue(self):
        for code in (1, False, True, None):
            with self.subTest(code=code):
                status, calls, waits, records = self.run_watch(
                    [({"complete": True}, code), ({"complete": True}, 0)], ["--until-complete"])
                self.assertEqual((status, len(calls), len(waits)), (0, 2, 1))
                self.assertEqual(records[0]["exitCode"], code if type(code) is int else None)

    def test_malformed_and_exception_cannot_succeed(self):
        for report in ('not json', [], {}, {"complete": 1}, RuntimeError('private')):
            with self.subTest(report=report):
                status, calls, waits, records = self.run_watch(
                    [(report, 0)] * 3, ["--until-complete"])
                self.assertEqual((status, len(calls), len(waits)), (1, 3, 2))
                self.assertTrue(all(record["outcome"] == "failed" for record in records))
                self.assertNotIn('private', json.dumps(records))

    def test_exhaustion_and_cancellation(self):
        for flags in (["--until-complete"], ["--until-complete", "--require-complete"]):
            with self.subTest(flags=flags):
                status, calls, waits, _ = self.run_watch([({"complete": False}, 0)] * 3, flags)
                self.assertEqual((status, len(calls), len(waits)), (1, 3, 2))
                status, calls, waits, _ = self.run_watch([], flags, cancel=True)
                self.assertEqual((status, len(calls), len(waits)), (1, 0, 0))

    def test_default_monitoring_runs_all_passes(self):
        status, calls, waits, records = self.run_watch([({"complete": True}, 0)] * 3)
        self.assertEqual((status, len(calls), len(waits), len(records)), (0, 3, 2, 3))

    def test_require_complete_rejects_invalid_status(self):
        for code in (False, None, 1):
            with self.subTest(code=code):
                status, _, _, _ = self.run_watch([({"complete": True}, code)] * 3,
                                                  ["--require-complete"])
                self.assertEqual(status, 1)


if __name__ == "__main__":
    unittest.main()
