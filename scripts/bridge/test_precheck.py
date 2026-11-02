"""Offline dispatcher transitions; all subprocess fixtures use an isolated HOME."""
import unittest
from precheck import apply_precheck


class PrecheckTests(unittest.TestCase):
    def setUp(self):
        self.job = dict(id="RQ-LOOP-1", status="READY", prompt="repair existing code")

    def apply(self, code, reason, job=None):
        return apply_precheck(job or self.job, code, f"SKIP RQ-LOOP-1 code={code} reason={reason}\n")

    def test_unknown_results_retry_without_consuming_work(self):
        for code, reason in [(13, "files_and_tests_exist"), (13, "symbols_defined"),
                             (12, "PRECHECK_UNSURE_open"), (75, "PRECHECK_UNSURE_merged"),
                             (2, "usage"), (-9, "killed"), (1, "error")]:
            with self.subTest(code=code, reason=reason):
                row, launch = self.apply(code, reason)
                self.assertEqual(row["status"], "READY")
                self.assertEqual(row["prompt"], self.job["prompt"])
                self.assertFalse(launch)
                recovered, launch = apply_precheck(row, 0, "GO RQ-LOOP-1\n")
                self.assertTrue(launch)
                self.assertEqual(recovered["id"], self.job["id"])
        self.assertEqual(self.job["status"], "READY")

    def test_duplicate_is_idempotent_and_can_be_rechecked(self):
        row, launch = self.apply(12, "id_open_pr_954")
        self.assertFalse(launch)
        self.assertEqual(row["status"], "BLOCKED")
        self.assertEqual(self.apply(12, "id_open_pr_954", row)[0], row)
        self.assertTrue(apply_precheck(row, 0, "GO RQ-LOOP-1")[1])
        self.assertEqual(self.apply(10, "id_merged_pr_954", row)[0]["status"], "DONE")

    def test_green_open_pr_is_not_completion(self):
        self.assertEqual(self.apply(11, "pr_954_green_clean")[0]["status"], "BLOCKED")

    def test_permanent_rejection_is_terminal(self):
        row, launch = apply_precheck(self.job, 64, "REJECT code=64 reason=invalid_job\n")
        self.assertEqual(row["status"], "FAILED")
        self.assertFalse(launch)
        self.assertEqual(apply_precheck(row, 0, "GO RQ-LOOP-1"), (row, False))

    def test_unrelated_hold_and_running_work_are_untouched(self):
        for status in ("BLOCKED", "RUNNING", "DONE", "CANCELLED", "FAILED"):
            job = dict(self.job, status=status)
            self.assertEqual(apply_precheck(job, 0, "GO RQ-LOOP-1"), (job, False))

    def test_receipt_mismatch_and_malformed_output_retry(self):
        for code, output in [(0, "GO RQ-OTHER-1"), (10, "SKIP RQ-OTHER-1 code=10 reason=id_merged_pr_1"),
                             (10, "SKIP RQ-LOOP-1 code=10 reason=garbage"), (64, "crash")]:
            row, launch = apply_precheck(self.job, code, output)
            self.assertEqual(row["status"], "READY")
            self.assertFalse(launch)


if __name__ == "__main__":
    unittest.main()
