"""RQ-ARM-CI-GATE-1: publish.sh must not arm auto-merge on a head whose CI already failed."""
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest

SOURCE = (Path(__file__).resolve().parents[1] / "publish.sh").read_text()
BLOCK = SOURCE.split("# >>> ARM_CI_GATE", 1)[1].split("\n", 1)[1].split("# <<< ARM_CI_GATE", 1)[0]


class ArmCiGateTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()

    def fake_gh(self, tsv, exit_code=0):
        (self.root / "rows.tsv").write_text(tsv)
        gh = self.bin / "gh"
        gh.write_text(f'#!/bin/sh\ncat "{self.root}/rows.tsv"\nexit {exit_code}\n')
        gh.chmod(gh.stat().st_mode | stat.S_IEXEC)

    def gate(self, wait="0"):
        env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}", ARM_GATE_WAIT=wait, ARM_GATE_POLL="1")
        script = f'REPO=o/r\n{BLOCK}\narm_ci_gate abc123; rc=$?; echo "rc=$rc why=[$ARM_GATE_WHY]"'
        return subprocess.run(["/bin/bash", "-c", script], env=env, capture_output=True, text=True, timeout=30).stdout.strip()

    def test_failed_secret_scan_blocks_arming(self):
        self.fake_gh("Secret scan (diff)\tcompleted\tfailure\nMerge Gate\tcompleted\tfailure\nQuick typecheck\tcompleted\tsuccess\n")
        out = self.gate()
        self.assertIn("rc=1", out)
        self.assertIn("Secret scan (diff)", out)
        self.assertIn("Merge Gate", out)

    def test_all_green_arms(self):
        self.fake_gh("Secret scan (diff)\tcompleted\tsuccess\nQuick typecheck\tcompleted\tsuccess\nCodeRabbit\tcompleted\tneutral\n")
        self.assertIn("rc=0", self.gate())

    def test_pending_checks_do_not_block_arming(self):
        self.fake_gh("Secret scan (diff)\tin_progress\t\nQuick typecheck\tqueued\t\n")
        self.assertIn("rc=0", self.gate(wait="0"))

    def test_other_completed_failure_blocks_even_with_scan_green(self):
        self.fake_gh("Secret scan (diff)\tcompleted\tsuccess\nCheck generated files\tcompleted\tfailure\n")
        out = self.gate()
        self.assertIn("rc=1", out)
        self.assertIn("Check generated files", out)

    def test_advisory_and_cancelled_do_not_block(self):
        self.fake_gh("Secret scan (diff)\tcompleted\tsuccess\nPerf budget (advisory, non-required)\tcompleted\tfailure\nFast gate\tcompleted\tcancelled\n")
        self.assertIn("rc=0", self.gate())

    def test_api_error_fails_open_to_github_required_checks(self):
        self.fake_gh("", exit_code=1)
        self.assertIn("rc=0", self.gate())

    def test_scan_wait_is_bounded(self):
        self.fake_gh("Quick typecheck\tqueued\t\n")
        self.assertIn("rc=0", self.gate(wait="2"))


if __name__ == "__main__":
    unittest.main()
