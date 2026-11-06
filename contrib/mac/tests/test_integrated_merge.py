import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import subprocess
import sys
import time
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "integrated_merge", Path(__file__).resolve().parents[1] / "integrated-merge.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class IntegratedProofTests(unittest.TestCase):
    def setUp(self):
        self.r = dict(schema=1, job="RQ-ORIGINAL", repo="lexicon", pr=123,
                      originalHead="1" * 40, mainHead="2" * 40,
                      mergeHead="3" * 40, tree="4" * 40,
                      createdAt=1000, expiresAt=1600, evidenceSha256="5" * 64)
        self.facts = dict(head="3" * 40, parents=["1" * 40, "2" * 40],
                          tree="4" * 40, mainTree="4" * 40,
                          indexTree="4" * 40, trackedClean=True, extraFiles=[])
        self.e = dict(schema=1, repo="lexicon", pr=123,
                      originalHead="1" * 40, mainHead="2" * 40,
                      mergeHead="3" * 40, reviewedTree="4" * 40,
                      outcome="already-integrated", reviewer="root/reviewer",
                      paths=[dict(path="src/example.ts", originalChange="adds operation",
                                  mainEvidence="main src/example.ts operation, merged PR100",
                                  verification="operation contract passes")])
        self.repository = dict(full_name="ashlrai/lexicon", default_branch="main")
        self.fork = dict(full_name="masonwyatt23/lexicon", fork=True,
                         parent=dict(full_name="ashlrai/lexicon"))
        self.pr = dict(number=123, state="open", merged_at=None,
                       head=dict(repo=dict(full_name="masonwyatt23/lexicon"),
                                 ref="codex-bridge/RQ-ORIGINAL", sha="1" * 40),
                       base=dict(repo=dict(full_name="ashlrai/lexicon"), ref="main"))

    def receipt(self, r=None, now=1200):
        m.validate_receipt(r or self.r, "RQ-ORIGINAL", "lexicon", "2" * 40, now)

    def remote(self, pr=None, fork=None, repository=None):
        return m.validate_remote(self.r, repository or self.repository,
                                 fork or self.fork, pr or self.pr)

    def test_complete_pinned_proof_passes(self):
        self.receipt()
        m.validate_git(self.r, self.facts)
        m.validate_evidence(self.e, self.r, ["src/example.ts"])
        self.assertEqual(self.remote(), "main")

    def test_expired_future_and_excessive_windows_refused(self):
        for created, expires, now in [(1000, 1200, 1200), (1201, 1600, 1200),
                                       (1000, 2801, 1200), (1000, 999, 1200)]:
            with self.subTest(created=created, expires=expires, now=now):
                r = dict(self.r, createdAt=created, expiresAt=expires)
                with self.assertRaises(m.Refused): self.receipt(r, now)

    def test_unknown_fields_and_boolean_schema_refused(self):
        for r in [dict(self.r, allowForce=True), dict(self.r, schema=True)]:
            with self.assertRaises(m.Refused): self.receipt(r)

    def test_wrong_job_repo_or_base_refused(self):
        for key, value in [("job", "RQ-OTHER"), ("repo", "other"),
                           ("mainHead", "6" * 40), ("pr", True)]:
            with self.subTest(key=key):
                with self.assertRaises(m.Refused): self.receipt(dict(self.r, **{key: value}))

    def test_single_octopus_and_reversed_parents_refused(self):
        for parents in [["1" * 40], ["1" * 40, "2" * 40, "6" * 40],
                        ["2" * 40, "1" * 40]]:
            with self.subTest(parents=parents):
                with self.assertRaises(m.Refused):
                    m.validate_git(self.r, dict(self.facts, parents=parents))

    def test_different_head_tree_main_tree_and_index_refused(self):
        for key in ("head", "tree", "mainTree", "indexTree"):
            with self.subTest(key=key):
                with self.assertRaises(m.Refused):
                    m.validate_git(self.r, dict(self.facts, **{key: "6" * 40}))

    def test_new_worktree_or_index_changes_refused(self):
        for f in [dict(self.facts, trackedClean=False),
                  dict(self.facts, extraFiles=["?? injected.ts"])]:
            with self.assertRaises(m.Refused): m.validate_git(self.r, f)

    def test_semantic_evidence_required_even_for_equal_tree(self):
        m.validate_git(self.r, self.facts)
        with self.assertRaises(m.Refused):
            m.validate_evidence(dict(self.e, paths=[]), self.r, ["src/example.ts"])

    def test_every_original_path_must_be_accounted_for(self):
        with self.assertRaises(m.Refused):
            m.validate_evidence(self.e, self.r, ["src/example.ts", "src/missing.ts"])
        with self.assertRaises(m.Refused):
            m.validate_evidence(self.e, self.r, ["src/different.ts"])

    def test_duplicate_and_empty_path_evidence_refused(self):
        for paths in [self.e["paths"] * 2,
                      [dict(self.e["paths"][0], mainEvidence="")],
                      [dict(self.e["paths"][0], verification=" ")]]:
            with self.assertRaises(m.Refused):
                m.validate_evidence(dict(self.e, paths=paths), self.r, ["src/example.ts"])

    def test_stale_review_pins_and_tree_refused(self):
        for key in ("originalHead", "mainHead", "mergeHead", "reviewedTree"):
            with self.assertRaises(m.Refused):
                m.validate_evidence(dict(self.e, **{key: "6" * 40}), self.r,
                                    ["src/example.ts"])

    def test_closed_merged_or_different_original_pr_refused(self):
        for pr in [dict(self.pr, state="closed"), dict(self.pr, merged_at="today"),
                   dict(self.pr, number=999)]:
            with self.assertRaises(m.Refused): self.remote(pr=pr)

    def test_head_race_refused_on_second_validation(self):
        self.remote()
        changed = copy.deepcopy(self.pr)
        changed["head"]["sha"] = "6" * 40
        with self.assertRaises(m.Refused): self.remote(pr=changed)

    def test_other_job_fork_or_base_refused(self):
        for section, key, value in [("head", "ref", "codex-bridge/RQ-OTHER"),
                                    ("head", "repo", dict(full_name="intruder/lexicon")),
                                    ("base", "ref", "release"),
                                    ("base", "repo", dict(full_name="other/lexicon"))]:
            pr = copy.deepcopy(self.pr)
            pr[section][key] = value
            with self.assertRaises(m.Refused): self.remote(pr=pr)

    def test_fork_redirect_and_nonfork_refused(self):
        for fork in [dict(self.fork, full_name="renamed/lexicon"),
                     dict(self.fork, fork=False),
                     dict(self.fork, parent=dict(full_name="other/lexicon"))]:
            with self.assertRaises(m.Refused): self.remote(fork=fork)
        with self.assertRaises(m.Refused):
            self.remote(repository=dict(self.repository, full_name="other/lexicon"))

    def test_duplicate_json_keys_refused(self):
        with self.assertRaises(m.Refused): m.decode(b'{"schema":1,"schema":1}')

    def test_private_custody_regular_file(self):
        with tempfile.TemporaryDirectory() as td:
            parent = Path(td)
            parent.chmod(0o700)
            p = parent / "proof.json"
            p.write_bytes(b"safe")
            p.chmod(0o600)
            self.assertEqual(m.private_file(p, parent, 8), b"safe")

    def test_symlink_hardlink_and_public_custody_refused(self):
        with tempfile.TemporaryDirectory() as td:
            parent = Path(td)
            parent.chmod(0o700)
            p = parent / "proof.json"
            p.write_bytes(b"safe")
            p.chmod(0o600)
            link = parent / "link.json"
            link.symlink_to(p)
            with self.assertRaises(m.Refused): m.private_file(link, parent, 8)
            link.unlink()
            os.link(p, link)
            with self.assertRaises(m.Refused): m.private_file(p, parent, 8)
            link.unlink()
            p.chmod(0o644)
            with self.assertRaises(m.Refused): m.private_file(p, parent, 8)
            p.chmod(0o600)
            parent.chmod(0o755)
            with self.assertRaises(m.Refused): m.private_file(p, parent, 8)

    def test_oversized_and_wrong_directory_refused(self):
        with tempfile.TemporaryDirectory() as td:
            parent = Path(td)
            parent.chmod(0o700)
            p = parent / "proof.json"
            p.write_bytes(b"too large")
            p.chmod(0o600)
            with self.assertRaises(m.Refused): m.private_file(p, parent, 3)
            with self.assertRaises(m.Refused): m.private_file(p, parent / "other", 100)

    def test_publisher_rejects_path_job_before_log_or_metadata_access(self):
        publisher = Path(__file__).resolve().parents[1] / "publish.sh"
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / ".ashlr-runs").mkdir()
            result = subprocess.run(
                ["/bin/bash", str(publisher), "../escaped", "--integrated-merge"],
                env={"HOME": td, "PATH": "/usr/bin:/bin"}, capture_output=True,
                text=True, timeout=5)
            self.assertEqual(result.returncode, 1)
            self.assertIn("bad-job-id", result.stdout)
            self.assertFalse((root / "escaped.publish").exists())
            self.assertEqual(list((root / ".ashlr-runs").iterdir()), [])

    def test_hung_grandchild_pipe_has_bounded_own_group_cleanup(self):
        with tempfile.TemporaryDirectory() as td:
            pidfile = Path(td) / "grandchild.pid"
            grandchild = ("import os,signal,time,pathlib; "
                          "signal.signal(signal.SIGTERM,signal.SIG_IGN); "
                          "pathlib.Path(" + repr(str(pidfile)) + ").write_text(str(os.getpid())); "
                          "time.sleep(20)")
            parent = ("import subprocess,sys; subprocess.Popen([sys.executable,'-c',"
                      + repr(grandchild) + "]); print('parent exited',flush=True)")
            # A separate fixture process stands in for unrelated fleet work.
            sentinel = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(20)"],
                                        start_new_session=True)
            try:
                runtime = m.Runtime.__new__(m.Runtime)
                started = time.monotonic()
                with patch.object(m, "PROBE_SECONDS", 0.8), \
                     patch.object(m.os, "killpg", wraps=os.killpg) as killed:
                    with self.assertRaisesRegex(m.Refused, "timed out"):
                        runtime.command([sys.executable, "-c", parent])
                self.assertLess(time.monotonic() - started, 3)
                self.assertTrue(pidfile.exists(), "grandchild actually inherited the pipe")
                self.assertEqual(killed.call_count, 1)
                self.assertNotIn(killed.call_args.args[0], (os.getpgrp(), sentinel.pid))
                self.assertIsNone(sentinel.poll(), "unrelated process must survive")
                state = subprocess.run(["/bin/ps", "-p", pidfile.read_text(), "-o", "stat="],
                                       capture_output=True, text=True, timeout=1)
                self.assertTrue(state.returncode != 0 or state.stdout.strip().startswith("Z"),
                                "own pipe-holding grandchild was not stopped")
            finally:
                sentinel.terminate()
                sentinel.wait(timeout=2)


if __name__ == "__main__":
    unittest.main()
