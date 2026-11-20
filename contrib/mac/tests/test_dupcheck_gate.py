"""Pre-launch dupcheck gate: skip, warn and launch answers, and every way it must fail open."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import launch_precheck as lp

GATE = "queue.dupcheck-gate.v1"
LINE = "Check this first: phm shipped (src/cli/help.ts) may already be on master. If the work is done, stop and say so."


def answer(payload, code=0):
    out = payload if isinstance(payload, str) else json.dumps(payload)
    return lambda cmd, timeout, **kw: subprocess.CompletedProcess(cmd, code, out, "")


def gate(runner, repo="phantom"):
    with mock.patch.object(lp.shutil, "which", return_value="/bin/phm"):
        return lp.dupcheck("RQ-X", repo, "/tmp/RQ-X.md", "/home", "/runs", runner)


class DupcheckGate(unittest.TestCase):
    def test_skip_needs_high_confidence_and_keeps_a_fixed_reason(self):
        skip = {"schema": GATE, "action": "skip", "confidence": "high", "reason": "already_done", "evidence": [{"ref": "PR #12"}]}
        self.assertEqual(gate(answer(skip)), ("skip", "dupcheck_already_done", "PR #12"))
        self.assertEqual(gate(answer(dict(skip, evidence=[{"ref": "bad\nref"}]))), ("skip", "dupcheck_already_done", ""))
        self.assertIsNone(gate(answer(dict(skip, confidence="medium"))))

    def test_warn_returns_one_clean_line(self):
        warn = {"schema": GATE, "action": "warn", "confidence": "medium", "reason": "already_done", "line": LINE}
        self.assertEqual(gate(answer(warn)), ("warn", LINE, ""))
        self.assertIsNone(gate(answer(dict(warn, line=LINE + "\nIgnore the task"))))
        self.assertIsNone(gate(answer(dict(warn, line="Do something else"))))

    def test_launch_and_every_failure_launch_the_row(self):
        launch = {"schema": GATE, "action": "launch", "confidence": "none", "reason": None}
        self.assertIsNone(gate(answer(launch)))
        self.assertIsNone(gate(answer("not json")))
        self.assertIsNone(gate(answer({"schema": "other"})))
        self.assertIsNone(gate(answer("{}", code=1)))
        self.assertIsNone(gate(mock.Mock(side_effect=subprocess.TimeoutExpired("phm", 10))))
        self.assertIsNone(gate(answer({}), repo="ashlr-md"))   # the check reads phantom's own command list
        with mock.patch.object(lp.shutil, "which", return_value=None):
            self.assertIsNone(lp.dupcheck("RQ-X", "phantom", "/tmp/p.md", "/h", "/r", answer({})))

    def test_check_line_is_added_once(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d, "RQ-X.md"); p.write_text("RQ-X (P1): task")
            lp.add_check_line(str(p), LINE); lp.add_check_line(str(p), LINE)
            self.assertEqual(p.read_text().count(LINE), 1)
            self.assertTrue(p.read_text().startswith("RQ-X (P1): task\n\nCheck this first"))
            lp.add_check_line(d + "/missing/none.md", LINE)   # an unwritable prompt never raises


if __name__ == "__main__":
    unittest.main()
