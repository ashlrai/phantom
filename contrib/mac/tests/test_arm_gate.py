"""RQ-ARM-CI-GATE-1: arm_gate.py verdicts, bounded deferral and sweep, using a fake gh."""
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
import unittest

MAC = Path(__file__).resolve().parents[1]
GATE = MAC / "arm_gate.py"
PUBLISH = (MAC / "publish.sh").read_text()

FAKE = r'''#!/usr/bin/env python3
import json, os, sys
d = os.environ["FAKE_DIR"]
a = sys.argv[1:]
open(d + "/calls.log", "a").write(" ".join(a) + "\n")
if a[0] == "api":
    if os.path.exists(d + "/api_fail"):
        sys.exit(1)
    sys.stdout.write(open(d + "/rows.tsv").read())
elif a[:2] == ["pr", "view"]:
    sys.stdout.write(open(d + "/pr.json").read())
elif a[:2] == ["pr", "merge"]:
    sys.exit(1 if os.path.exists(d + "/merge_fail") else 0)
'''

ALL_GREEN = [("Merge Gate", "completed", "success"), ("Secret-shape scan", "completed", "success"),
             ("Secret scan (diff)", "completed", "success"), ("Classify PR site lane", "completed", "success"),
             ("Check generated files", "completed", "success"),
             ("Fast gate (typecheck + affected tests)", "completed", "success"),
             ("Quick typecheck", "completed", "success"), ("Check authority drift (hermetic)", "completed", "success"), ("CodeRabbit", "completed", "neutral"),
             ("Perf budget (advisory, non-required)", "in_progress", "")]


class ArmGateTests(unittest.TestCase):
    def setUp(self):
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup)
        self.root = Path(t.name)
        (self.root / "bin").mkdir()
        gh = self.root / "bin" / "gh"; gh.write_text(FAKE); gh.chmod(gh.stat().st_mode | stat.S_IEXEC)
        self.env = dict(os.environ, PATH=f"{self.root / 'bin'}:{os.environ['PATH']}", FAKE_DIR=str(self.root))

    def rows(self, rows):
        lines = []
        for i, (n, s, c) in enumerate(rows, 1):
            lines.append(f"{i}\t{n}\t{s}\t{c}")
        (self.root / "rows.tsv").write_text("\n".join(lines) + "\n")

    def run_gate(self, *args):
        r = subprocess.run([sys.executable, str(GATE), *args], env=self.env, capture_output=True, text=True, timeout=30)
        return r.returncode, r.stdout.strip()

    def check(self, wait="0"):
        return self.run_gate("check", "--repo", "o/r", "--sha", "a" * 40, "--wait", wait, "--poll", "1")

    def swap(self, rows, name, status, conclusion):
        return [(n, status, conclusion) if n == name else (n, s, c) for n, s, c in rows]

    def test_all_hard_green_is_safe_even_with_advisory_running(self):
        self.rows(ALL_GREEN)
        self.assertEqual(self.check(), (0, "SAFE"))

    def test_failed_scan_and_gate_is_red_and_named(self):
        r = self.swap(self.swap(ALL_GREEN, "Secret scan (diff)", "completed", "failure"), "Merge Gate", "completed", "failure")
        self.rows(r)
        rc, out = self.check()
        self.assertEqual(rc, 1)
        self.assertIn("Secret scan (diff)", out)
        self.assertIn("Merge Gate", out)

    def test_cancelled_timed_out_and_action_required_are_red_not_safe(self):
        for c in ("cancelled", "timed_out", "action_required"):
            self.rows(self.swap(ALL_GREEN, "Fast gate (typecheck + affected tests)", "completed", c))
            self.assertEqual(self.check()[0], 1, c)

    def test_red_quick_blocks_arming(self):
        self.rows(self.swap(ALL_GREEN, "Quick typecheck", "completed", "failure"))
        self.assertEqual(self.check()[0], 1)

    def test_failed_advisory_and_third_party_do_not_block(self):
        r = self.swap(self.swap(ALL_GREEN, "Perf budget (advisory, non-required)", "completed", "failure"), "CodeRabbit", "completed", "failure")
        self.rows(r + [("Vercel Preview Comments", "completed", "failure")])
        self.assertEqual(self.check(), (0, "SAFE"))

    def test_red_authority_drift_blocks_arming(self):
        self.rows(self.swap(ALL_GREEN, "Check authority drift (hermetic)", "completed", "failure"))
        self.assertEqual(self.check()[0], 1)

    def test_skipped_quick_and_drift_are_fine(self):
        self.rows(self.swap(self.swap(ALL_GREEN, "Quick typecheck", "completed", "skipped"), "Check authority drift (hermetic)", "completed", "skipped"))
        self.assertEqual(self.check(), (0, "SAFE"))

    def test_missing_or_running_quick_or_drift_is_pending_not_safe(self):
        for name in ("Quick typecheck", "Check authority drift (hermetic)"):
            self.rows([x for x in ALL_GREEN if x[0] != name])
            self.assertEqual(self.check()[0], 2, name)
            self.rows(self.swap(ALL_GREEN, name, "in_progress", ""))
            self.assertEqual(self.check()[0], 2, name)

    def test_pending_hard_check_is_pending_not_safe(self):
        self.rows(self.swap(ALL_GREEN, "Merge Gate", "in_progress", ""))
        rc, out = self.check()
        self.assertEqual(rc, 2)
        self.assertTrue(out.startswith("PENDING"))

    def test_missing_hard_check_is_pending_not_safe(self):
        self.rows([x for x in ALL_GREEN if x[0] != "Secret scan (diff)"])
        self.assertEqual(self.check()[0], 2)

    def test_unreadable_checks_are_unknown_not_safe(self):
        (self.root / "api_fail").write_text("1")
        self.assertEqual(self.check(), (2, "UNKNOWN"))

    def test_rerun_uses_newest_run_per_name(self):
        rows = [("Secret scan (diff)", "completed", "failure")] + ALL_GREEN  # ids ascend: the later green rerun wins
        self.rows(rows)
        self.assertEqual(self.check(), (0, "SAFE"))

    def test_wait_is_bounded_and_ends_pending(self):
        self.rows(self.swap(ALL_GREEN, "Merge Gate", "in_progress", ""))
        t = time.time(); rc, _ = self.check(wait="2")
        self.assertEqual(rc, 2)
        self.assertLess(time.time() - t, 15)

    def test_red_found_while_waiting_returns_red(self):
        self.rows(self.swap(ALL_GREEN, "Secret scan (diff)", "completed", "failure"))
        self.assertEqual(self.check(wait="5")[0], 1)

    def defer(self, deadline="3600", job="J1"):
        (self.root / "pr.json").write_text(json.dumps({"state": "OPEN", "headRefOid": "a" * 40, "autoMergeRequest": None}))
        return self.run_gate("defer", "--dir", str(self.root / "d"), "--repo", "o/r", "--pr", "https://github.com/o/r/pull/9",
                             "--sha", "a" * 40, "--job", job, "--deadline-s", deadline)

    def sweep(self, apply=True):
        a = ["sweep", "--dir", str(self.root / "d")] + (["--apply"] if apply else [])
        return self.run_gate(*a)

    def merge_calls(self):
        log = (self.root / "calls.log").read_text() if (self.root / "calls.log").exists() else ""
        return [l for l in log.splitlines() if l.startswith("pr merge")]

    def test_sweep_keeps_pending_then_arms_head_pinned_when_safe(self):
        self.defer()
        self.rows(self.swap(ALL_GREEN, "Merge Gate", "in_progress", ""))
        self.assertIn("KEEP J1.json PENDING", self.sweep()[1]); self.assertEqual(self.merge_calls(), [])
        self.rows(ALL_GREEN)
        self.assertIn("ARMED J1.json", self.sweep()[1])
        self.assertEqual(len(self.merge_calls()), 1)
        self.assertIn("--match-head-commit " + "a" * 40, self.merge_calls()[0])
        self.assertFalse((self.root / "d" / "J1.json").exists())

    def test_sweep_drops_red_without_arming(self):
        self.defer(); self.rows(self.swap(ALL_GREEN, "Secret scan (diff)", "completed", "failure"))
        self.assertIn("DROP J1.json red", self.sweep()[1]); self.assertEqual(self.merge_calls(), [])

    def test_sweep_drops_expired_and_changed_head(self):
        self.defer(deadline="-5"); self.rows(ALL_GREEN)
        self.assertIn("expired", self.sweep()[1]); self.assertEqual(self.merge_calls(), [])
        self.defer(job="J2")
        (self.root / "pr.json").write_text(json.dumps({"state": "OPEN", "headRefOid": "b" * 40, "autoMergeRequest": None}))
        self.assertIn("head changed", self.sweep()[1]); self.assertEqual(self.merge_calls(), [])

    def test_sweep_dry_run_and_failed_arm_keep_record(self):
        self.defer(); self.rows(ALL_GREEN)
        self.assertIn("WOULD_ARM", self.sweep(apply=False)[1]); self.assertEqual(self.merge_calls(), [])
        (self.root / "merge_fail").write_text("1")
        self.assertIn("KEEP J1.json arm-failed", self.sweep()[1])
        self.assertTrue((self.root / "d" / "J1.json").exists())

    def test_publish_arms_only_on_safe_verdict(self):
        block = PUBLISH.split('AG=$(python3 -I -B "$R/bin/arm_gate.py" check', 1)[1].split('echo "RESULT PR', 1)[0]
        self.assertLess(block.index('elif [ $AGRC = 1 ]'), block.index('gh pr merge "$URL"'))
        self.assertLess(block.index('elif [ $AGRC != 0 ]'), block.index('gh pr merge "$URL"'))
        self.assertLess(block.index('"$HEAD2" != "$HEADSHA"'), block.index('gh pr merge "$URL"'))

    def test_publish_pins_every_arm_and_never_guesses_head(self):
        self.assertNotIn('IMSHA:-$SHA', PUBLISH.split('RQ-ARM-CI-GATE-1', 1)[1].split('echo "RESULT PR', 1)[0])
        block = PUBLISH.split('RQ-ARM-CI-GATE-1', 1)[1].split('echo "RESULT PR', 1)[0]
        merges = [l for l in block.splitlines() if 'gh pr merge' in l]
        self.assertEqual(len(merges), 2)
        for l in merges:
            self.assertIn('--match-head-commit "$HEADSHA"', l)
        self.assertIn('PR head unknown', block)
        self.assertLess(block.index('final pre-arm re-check'), block.index('gh pr merge "$URL"'))
        final = block.split('final pre-arm re-check', 1)[1].split('gh pr merge "$URL"', 1)[0]
        self.assertIn('[ $AGRC = 1 ]', final)
        self.assertIn('arm_gate.py" defer', final)  # recoverable verdict is deferred, RED refuses


class PublishBlockBehavior(unittest.TestCase):
    """Runs the real arming block of publish.sh with a fake gh and a scripted arm_gate.py."""
    HEAD = "c" * 40

    def run_block(self, check_rcs, heads=None, pr_view_fail=False):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d); (d / "bin").mkdir(); (d / "fakebin").mkdir()
            (d / "rcs").write_text("\n".join(map(str, check_rcs)))
            (d / "heads").write_text("\n".join(heads or [self.HEAD, self.HEAD]))
            (d / "bin" / "arm_gate.py").write_text(
                "import sys,os\nd=os.environ['T']\nif sys.argv[1]=='check':\n"
                " l=open(d+'/rcs').read().split();v=l.pop(0) if l else '0';open(d+'/rcs','w').write(' '.join(l));print('V'+v);sys.exit(int(v))\n"
                "open(d+'/defer','a').write(' '.join(sys.argv[1:])+'\\n')\n")
            gh = d / "fakebin" / "gh"
            gh.write_text("#!/bin/bash\nd=$T\nif [ \"$1 $2\" = 'pr view' ]; then [ -e $d/viewfail ] && exit 1; l=($(cat $d/heads)); echo ${l[0]}; printf '%s ' ${l[@]:1} > $d/heads; exit 0; fi\n"
                          "echo \"$*\" >> $d/merge\n")
            gh.chmod(0o755)
            if pr_view_fail:
                (d / "viewfail").write_text("1")
            start = PUBLISH.index('elif [ -z "$SENS" ] && [ -z "$G1T" ]; then')
            end = PUBLISH.index('echo "RESULT PR', start)
            script = 'JUDGE_OK=1; SENS=""; G1T=""; J=job1; URL=u; REPO=o/r; R=%s\nif false; then :\n%s\nfi\n' % (d, PUBLISH[start:end])
            r = subprocess.run(["bash", "-c", script], env=dict(os.environ, PATH=f"{d / 'fakebin'}:{os.environ['PATH']}", T=str(d), ARM_GATE_WAIT="0"),
                               capture_output=True, text=True, timeout=30)
            rd = lambda n: (d / n).read_text() if (d / n).exists() else ""
            return r.stdout + r.stderr, rd("merge"), rd("defer")

    def test_safe_arms_with_pin(self):
        out, merge, defer = self.run_block([0, 0])
        self.assertIn("AUTO_MERGE on", out); self.assertIn("--match-head-commit " + self.HEAD, merge); self.assertEqual(defer, "")

    def test_final_recheck_pending_defers_and_does_not_arm(self):
        out, merge, defer = self.run_block([0, 2])
        self.assertIn("deferred after final re-check", out); self.assertEqual(merge, ""); self.assertIn("defer", defer)

    def test_final_recheck_red_refuses_without_deferral(self):
        out, merge, defer = self.run_block([0, 1])
        self.assertIn("final re-check", out); self.assertEqual(merge, ""); self.assertEqual(defer, "")

    def test_first_check_pending_defers(self):
        out, merge, defer = self.run_block([2])
        self.assertEqual(merge, ""); self.assertIn("defer", defer)

    def test_head_change_refuses_and_unknown_head_refuses(self):
        out, merge, defer = self.run_block([0, 0], heads=[self.HEAD, "d" * 40])
        self.assertIn("head changed", out); self.assertEqual((merge, defer), ("", ""))
        out, merge, defer = self.run_block([0, 0], pr_view_fail=True)
        self.assertIn("head unknown", out); self.assertEqual((merge, defer), ("", ""))


if __name__ == "__main__":
    unittest.main()
