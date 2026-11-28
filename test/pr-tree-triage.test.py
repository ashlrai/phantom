import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "pr-tree-triage.py"
SPEC = importlib.util.spec_from_file_location("pr_tree_triage", SCRIPT)
triage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(triage)


class PrTreeTriageTest(unittest.TestCase):
    def git(self, root, *args):
        return subprocess.check_output(["git", "-C", str(root), *args],
                                       stderr=subprocess.DEVNULL, text=True).strip()

    def commit(self, root, path, content):
        (root / path).write_text(content)
        self.git(root, "add", path)
        self.git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "-qm", path + content.strip())
        return self.git(root, "rev-parse", "HEAD")

    def test_mixed_batch_uses_three_way_result_and_does_not_change_source_refs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.git(root, "init", "-q", "--initial-branch=master")
            parent = self.commit(root, "source", "original\n")
            self.commit(root, "source", "same change\n")
            base = self.commit(root, "master-only", "not in any head\n")
            self.git(root, "checkout", "-qb", "duplicate", parent)
            duplicate = self.commit(root, "source", "same change\n")
            self.assertNotEqual(self.git(root, "rev-parse", duplicate + "^{tree}"),
                                self.git(root, "rev-parse", base + "^{tree}"))
            self.git(root, "checkout", "-qb", "conflict", parent)
            conflict = self.commit(root, "source", "conflicting change\n")
            self.git(root, "checkout", "-qb", "clean", parent)
            clean = self.commit(root, "new-file", "new work\n")
            refs_before = self.git(root, "show-ref")
            snapshot = root / "snapshot.json"
            snapshot.write_text(json.dumps([{"number": i, "headSha": sha}
                                           for i, sha in enumerate([duplicate, "0" * 40, conflict, clean], 1)]))
            out = subprocess.check_output([sys.executable, str(SCRIPT), "--repo", str(root),
                                           "--base", base, "--snapshot", str(snapshot)], text=True)
            report = json.loads(out)
            self.assertEqual(report["baseSha"], base)
            self.assertFalse(report["complete"])
            self.assertEqual([(row["number"], row["verdict"], row["conflictPaths"]) for row in report["prs"]],
                             [(1, "no-file-change", 0), (2, "unknown", None),
                              (3, "conflicting", 1), (4, "clean-file-change", 0)])
            self.assertEqual(self.git(root, "show-ref"), refs_before)
            self.assertEqual(self.git(root, "rev-parse", "HEAD"), clean)

    def test_truncated_or_malformed_git_output_cannot_pass(self):
        sha = b"a" * 40
        for bad in (b"1\0" + sha + b"\0", b"1\0" + sha + b"\0path\0\0",
                    b"0\0" + sha + b"\0\0", b"2\0" + sha + b"\0\0"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                triage.parse_records(bad, 1, sha)
        with self.assertRaises(ValueError):
            triage.parse_records(b"1\0" + sha + b"\0\0", 2, sha)

    def test_rejects_duplicate_pr_numbers_and_ref_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            snapshot = Path(tmp) / "snapshot"
            for rows in ([{"number": 1, "headSha": "master"}],
                         [{"number": 1, "headSha": "a" * 40}] * 2):
                snapshot.write_text(json.dumps(rows))
                with self.assertRaises(ValueError):
                    triage.load_snapshot(snapshot)


if __name__ == "__main__":
    unittest.main()
