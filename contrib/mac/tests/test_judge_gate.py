"""Tests for contrib/mac/judge_gate.py (RQ-SWE5-FRESH-JUDGE): isolation, verdict parsing, fail-closed gating."""
import contextlib
import io
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import judge_gate as jg  # noqa: E402


def run_main(cmd, contract="ship X", diff="+x", threshold=None):
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        (d / "diff").write_text(diff)
        (d / "contract").write_text(contract)
        (d / "ev").write_text("tests ok")
        argv = ["--diff", str(d / "diff"), "--contract", str(d / "contract"), "--evidence", str(d / "ev"), "--timeout", "5"]
        if threshold is not None:
            argv += ["--threshold", str(threshold)]
        out = io.StringIO()
        old = os.environ.get("PUBLISH_JUDGE_CMD")
        os.environ["PUBLISH_JUDGE_CMD"] = cmd
        try:
            with contextlib.redirect_stdout(out):
                rc = jg.main(argv)
        finally:
            if old is None:
                os.environ.pop("PUBLISH_JUDGE_CMD")
            else:
                os.environ["PUBLISH_JUDGE_CMD"] = old
        return rc, out.getvalue()


def fake_judge(directory, body):
    path = Path(directory) / "judge.py"
    path.write_text(body)
    return f"{sys.executable} {path}"


class PacketTests(unittest.TestCase):
    def test_packet_has_only_contract_evidence_and_diff(self):
        p = jg.build_packet("+line", "do the thing", "42 passed")
        for part in ("do the thing", "42 passed", "+line", "DONE CONTRACT"):
            self.assertIn(part, p)
        self.assertEqual(jg.build_packet.__code__.co_varnames[:3], ("diff", "contract", "evidence"))

    def test_large_inputs_are_truncated(self):
        p = jg.build_packet("d" * (jg.DIFF_CAP + 10), "c", "e" * (jg.EVIDENCE_CAP + 10))
        self.assertEqual(p.count("[...truncated...]"), 2)


class VerdictTests(unittest.TestCase):
    def test_parse_tolerates_prose_around_json(self):
        v = jg.parse_verdict('Sure:\n{"verdict":"pass","confidence":0.9,"reasons":["ok"]}\n')
        self.assertEqual(v, ("pass", 0.9, ["ok"]))

    def test_malformed_is_fail_zero(self):
        for raw in ("", "nope", '{"verdict":"maybe","confidence":1}', '{"verdict":"pass","confidence":7}', "[1]"):
            self.assertEqual(jg.parse_verdict(raw)[:2], ("fail", 0.0), raw)

    def test_decide(self):
        self.assertEqual(jg.decide("pass", 0.8, 0.8), "pass")
        self.assertEqual(jg.decide("pass", 0.5, 0.8), "leader-review")
        self.assertEqual(jg.decide("fail", 0.9, 0.8), "fail")
        self.assertEqual(jg.decide("fail", 0.0, 0.8), "leader-review")


class MainTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def judge(self, verdict, conf=0.95, extra=""):
        body = f"import sys,json\nsys.stdin.read()\n{extra}\nprint(json.dumps({{'verdict':'{verdict}','confidence':{conf},'reasons':['r']}}))\n"
        return fake_judge(self.tmp.name, body)

    def test_pass_exits_zero(self):
        rc, out = run_main(self.judge("pass"))
        self.assertEqual(rc, 0)
        self.assertTrue(out.startswith("JUDGE pass conf=0.95"))

    def test_fail_and_low_confidence_block(self):
        self.assertEqual(run_main(self.judge("fail"))[0], 1)
        rc, out = run_main(self.judge("pass", 0.4))
        self.assertEqual(rc, 1)
        self.assertIn("leader-review", out)

    def test_judge_receives_packet_on_stdin(self):
        marker = Path(self.tmp.name) / "seen"
        cmd = fake_judge(self.tmp.name, f"import sys\nopen({str(marker)!r},'w').write(sys.stdin.read())\nprint('{{\"verdict\":\"pass\",\"confidence\":1}}')\n")
        run_main(cmd, contract="CONTRACT-TEXT", diff="+DIFF-TEXT")
        seen = marker.read_text()
        self.assertIn("CONTRACT-TEXT", seen)
        self.assertIn("+DIFF-TEXT", seen)
        self.assertIn("tests ok", seen)

    def test_fail_closed_on_missing_judge_crash_or_empty_contract(self):
        self.assertEqual(run_main("")[0], 1)
        self.assertEqual(run_main("/nonexistent/judge-binary")[0], 1)
        crash = fake_judge(self.tmp.name, "import sys\nsys.exit(3)\n")
        rc, out = run_main(crash)
        self.assertEqual(rc, 1)
        self.assertIn("leader-review", out)
        rc, out = run_main(self.judge("pass"), contract="  ")
        self.assertEqual(rc, 1)
        self.assertIn("no done-contract", out)


if __name__ == "__main__":
    unittest.main()
