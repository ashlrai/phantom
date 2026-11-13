# test_bench_loop_original_4194_277s.py — executable preservation evidence for the
# benchmark/reporting slice of PR #4194 (RQ-SWE5-LOOP-BENCH). Reconciles the synthetic
# outer-loop benchmark report contract only; does not touch dispatchd, restock, disk,
# batcher, or any other PR path. All stage functions are mocked at their boundaries;
# no subprocess, network, real home, or provider is ever invoked.
import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

MAC = Path(__file__).resolve().parent.parent
BENCH = MAC / "bench_loop.py"


def load_bench():
    spec = importlib.util.spec_from_file_location("bench_loop_under_test", str(BENCH))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


BENCH_MOD = load_bench()

# Deterministic synthetic stage outputs: deliberately distinct magnitudes per stage so a
# swapped or omitted stage result fails the assertions.
TICK = [100.0, 200.0, 300.0, 400.0, 500.0]
PREFLIGHT = [10.0, 20.0]
TOTAL = [110.0, 220.0]
PUBLISH = [7.0, 8.0, 9.0]
REAP = [3.5]
PICK = [42.0, 43.0]


def expected_summary(values):
    import statistics
    return {"median_ms": round(statistics.median(values), 2),
            "min_ms": round(min(values), 2), "max_ms": round(max(values), 2),
            "runs": len(values)}


def run_main(argv):
    out = io.StringIO()
    with mock.patch.object(sys, "argv", ["bench_loop.py"] + argv), \
         contextlib.redirect_stdout(out):
        rc = BENCH_MOD.main()
    return rc, out.getvalue()


class StageMocks:
    def __init__(self, fail_stage=None):
        self.mocks = {
            "bench_tick": mock.Mock(return_value=list(TICK)),
            "bench_launch": mock.Mock(return_value={"preflight_ms": list(PREFLIGHT),
                                                    "total_ms": list(TOTAL)}),
            "bench_publish": mock.Mock(return_value=list(PUBLISH)),
            "bench_reap": mock.Mock(return_value=list(REAP)),
            "bench_pick": mock.Mock(return_value=list(PICK)),
            "profile_tick": mock.Mock(return_value="PROFILER-TEXT"),
        }
        if fail_stage:
            self.mocks[fail_stage].side_effect = RuntimeError("synthetic stage failure")

    def __enter__(self):
        self.patches = [mock.patch.object(BENCH_MOD, name, fn)
                        for name, fn in self.mocks.items()]
        for p in self.patches:
            p.start()
        return self.mocks

    def __exit__(self, *exc):
        for p in reversed(self.patches):
            p.stop()
        return False


class SummarizeTest(unittest.TestCase):
    def test_summarize_nontrivial_sample(self):
        got = BENCH_MOD.summarize(TICK)
        self.assertEqual(got, {"median_ms": 300.0, "min_ms": 100.0,
                               "max_ms": 500.0, "runs": 5})

    def test_summarize_even_count_median(self):
        got = BENCH_MOD.summarize([10.0, 20.0, 30.0, 40.0])
        self.assertEqual(got["median_ms"], 25.0)
        self.assertEqual(got["runs"], 4)


class MainReportTest(unittest.TestCase):
    def test_main_report_maps_every_stage(self):
        with StageMocks() as m:
            rc, text = run_main(["--runs", "5"])
        self.assertEqual(rc, 0)
        report = json.loads(text)
        # Fixture metadata echoes the parsed arguments.
        self.assertEqual(report["fixture"], {"jobs_rows": 40000, "ready": 60,
                                             "base_files": 45, "queue_lines": 300,
                                             "cache_files": 3000})
        # Each stage summarized independently; launch split into preflight/total.
        self.assertEqual(report["tick"], expected_summary(TICK))
        self.assertEqual(report["launch_preflight"], expected_summary(PREFLIGHT))
        self.assertEqual(report["launch_total"], expected_summary(TOTAL))
        self.assertEqual(report["publish"], expected_summary(PUBLISH))
        self.assertEqual(report["reap"], expected_summary(REAP))
        self.assertEqual(report["pick"], expected_summary(PICK))
        # Every stage boundary invoked exactly once, with the parsed args object.
        for name in ("bench_tick", "bench_launch", "bench_publish",
                     "bench_reap", "bench_pick"):
            m[name].assert_called_once()
            self.assertIsInstance(m[name].call_args[0][0].runs, int)
        m["profile_tick"].assert_not_called()

    def test_main_fixture_args_propagate(self):
        with StageMocks():
            rc, text = run_main(["--runs", "2", "--ready", "7", "--base", "3",
                                 "--queue-lines", "11", "--cache-files", "5",
                                 "--jobs-rows", "9"])
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(text)["fixture"],
                         {"jobs_rows": 9, "ready": 7, "base_files": 3,
                          "queue_lines": 11, "cache_files": 5})

    def test_out_writes_same_json_with_trailing_newline(self):
        with StageMocks(), tempfile.TemporaryDirectory() as td:
            path = Path(td) / "report.json"
            rc, text = run_main(["--out", str(path)])
            self.assertEqual(rc, 0)
            written = path.read_text()
            # print(text) emits the JSON plus one newline; the file holds the same bytes.
            self.assertTrue(written.endswith("}\n"))
            self.assertEqual(written, text)
            # The file content parses to the identical report object.
            self.assertEqual(json.loads(written), json.loads(text))

    def test_stage_failure_propagates_no_success_artifact(self):
        with StageMocks(fail_stage="bench_reap") as m:
            with tempfile.TemporaryDirectory() as td:
                path = Path(td) / "report.json"
                with self.assertRaises(RuntimeError):
                    run_main(["--out", str(path)])
                # No partial output artifact may be mistaken for success.
                self.assertFalse(path.exists())
        # Stages after the failure never ran; earlier stages did run.
        m["bench_publish"].assert_called_once()
        m["bench_pick"].assert_not_called()

    def test_tick_failure_propagates(self):
        with StageMocks(fail_stage="bench_tick"):
            with self.assertRaises(RuntimeError):
                run_main([])

    def test_profile_flag_calls_profiler_and_keeps_report(self):
        with StageMocks() as m:
            rc, text = run_main(["--profile", "--profile-top", "7"])
        self.assertEqual(rc, 0)
        m["profile_tick"].assert_called_once()
        # Parsed args object carried profile settings through.
        self.assertTrue(m["profile_tick"].call_args[0][0].profile)
        self.assertEqual(m["profile_tick"].call_args[0][0].profile_top, 7)
        # Normal report still present and parseable; profiler text appended.
        head, _, tail = text.partition("\n=== tick profile")
        report = json.loads(head)
        self.assertEqual(report["tick"], expected_summary(TICK))
        self.assertIn("PROFILER-TEXT", tail)
        self.assertIn("top 7", tail)


if __name__ == "__main__":
    unittest.main()
