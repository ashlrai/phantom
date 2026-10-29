"""Real Git/filesystem contracts for the trusted bridge disk lifecycle."""

import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("bridge_disk", Path(__file__).with_name("disk.py"))
disk = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(disk)


class DiskLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="bridge-disk-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.source = self.make_repo("source")
        self.worktree = self.make_worktree("job")
        self.state = self.root / "state"
        self.job = "RQ-TEST"
        self.usage = patch.object(disk.shutil, "disk_usage", return_value=SimpleNamespace(
            free=40 * 1024**3, used=100 * 1024**3, total=140 * 1024**3))
        self.usage.start()
        self.addCleanup(self.usage.stop)

    def git(self, path, *args):
        result = subprocess.run(["git", "-C", str(path), *args], check=True,
                                capture_output=True, timeout=30)
        return result.stdout

    def make_repo(self, name):
        repo = self.root / name
        repo.mkdir()
        self.git(repo, "init", "-b", "main")
        self.git(repo, "config", "user.email", "bridge-test@example.invalid")
        self.git(repo, "config", "user.name", "Bridge fixture")
        self.git(repo, "config", "core.hooksPath", str(self.root / "absent-hooks"))
        self.git(repo, "remote", "add", "origin", "https://github.com/ashlrai/phantom.git")
        (repo / "tracked.txt").write_text("tracked\n")
        (repo / ".gitignore").write_text("node_modules/\ntarget/\nignored/\n")
        self.git(repo, "add", ".")
        self.git(repo, "commit", "-m", "fixture")
        return repo

    def make_worktree(self, name, source=None):
        source = source or self.source
        destination = self.root / name
        self.git(source, "worktree", "add", "-b", name, str(destination))
        return destination

    def evidence(self, worktree=None, **overrides):
        return {"url": "https://github.com/ashlrai/phantom/pull/123",
                "head_oid": self.git(worktree or self.worktree, "rev-parse", "HEAD").decode().strip(),
                "observed_at": time.time(), **overrides}

    def launch(self, worktree=None, source=None, command=None, job=None, cap=disk.CAP):
        return disk.launch(source or self.source, worktree or self.worktree, self.state,
                           job or self.job, command or [sys.executable, "-c", "pass"], cap=cap)

    def cache(self, worktree=None):
        _, common = disk.identity(worktree or self.worktree)
        return disk.layout(self.state, common)[1]

    def records(self):
        return [json.loads(line) for line in (self.state / "disk.log").read_text().splitlines()]

    def finish(self, evidence=None, worktree=None, job=None):
        return disk.finish(worktree or self.worktree, self.state, job or self.job,
                           self.evidence(worktree) if evidence is None else evidence)

    def test_launch_shares_target_with_same_repository_and_isolates_other_repository(self):
        script = "import os,pathlib; pathlib.Path('cargo-location').write_text(os.environ['CARGO_TARGET_DIR'])"
        command = [sys.executable, "-c", script]
        second = self.make_worktree("second")
        other_source = self.make_repo("other-source")
        other = self.make_worktree("other-job", other_source)
        self.assertEqual(self.launch(command=command), 0)
        self.assertEqual(self.launch(worktree=second, command=command, job="second"), 0)
        self.assertEqual(self.launch(worktree=other, source=other_source, command=command, job="other"), 0)
        first_target = (self.worktree / "cargo-location").read_text()
        self.assertEqual(first_target, (second / "cargo-location").read_text())
        self.assertNotEqual(first_target, (other / "cargo-location").read_text())
        self.assertEqual(first_target, str(self.cache()))
        self.assertEqual(len([r for r in self.records() if r["event"] == "launch-finished"]), 3)
        self.assertTrue(all(r["free_bytes"] > disk.FLOOR for r in self.records()))

    def test_intermediate_output_override_is_cleared_without_printing_environment(self):
        command = [sys.executable, "-c", "import os,sys; sys.exit(9 if 'CARGO_BUILD_BUILD_DIR' in os.environ else 0)"]
        with patch.dict(os.environ, {"CARGO_BUILD_BUILD_DIR": str(self.root / "unmanaged")}):
            self.assertEqual(self.launch(command=command), 0)
        self.assertFalse((self.root / "unmanaged").exists())

    def test_failed_child_exit_preserves_worktree_and_records_exit(self):
        self.assertEqual(self.launch(command=[sys.executable, "-c", "raise SystemExit(7)"]), 7)
        self.assertTrue(self.worktree.exists())
        self.assertEqual(self.records()[-1]["exit_code"], 7)
        self.assertEqual(self.records()[-1]["event"], "launch-finished")

    def test_low_disk_refuses_before_child_starts_and_logs_free_bytes(self):
        with patch.object(disk.shutil, "disk_usage", return_value=SimpleNamespace(free=disk.FLOOR - 1, used=123)):
            with self.assertRaisesRegex(disk.Refused, "disk-below-20-gib"):
                self.launch(command=[sys.executable, "-c", "open('started','w').close()"])
        self.assertFalse((self.worktree / "started").exists())
        self.assertEqual(self.records()[-1]["free_bytes"], disk.FLOOR - 1)

    def test_over_cap_idle_target_is_cleared_before_launch(self):
        cache = self.cache()
        cache.mkdir()
        (cache / "old-output").write_bytes(b"x" * 8192)
        self.assertEqual(self.launch(cap=4096), 0)
        self.assertFalse((cache / "old-output").exists())

    def test_over_cap_active_target_is_not_evicted(self):
        cache = self.cache()
        cache.mkdir()
        artifact = cache / "active-output"
        artifact.write_bytes(b"x" * 8192)
        with disk.lock(cache.parent / "lease", shared=True):
            with self.assertRaisesRegex(disk.Refused, "active-lease"):
                self.launch(cap=4096)
        self.assertEqual(artifact.read_bytes(), b"x" * 8192)

    def test_target_growth_is_refused_and_owned_child_stopped(self):
        cache = self.cache()
        command = [sys.executable, "-c", "import os,pathlib,time; pathlib.Path('owned-pid').write_text(str(os.getpid())); pathlib.Path(os.environ['CARGO_TARGET_DIR'],'growth').write_bytes(b'x'*16384); time.sleep(60)"]
        started = time.monotonic()
        with self.assertRaisesRegex(disk.Refused, "target-cap-exceeded"):
            self.launch(command=command, cap=4096)
        self.assertLess(time.monotonic() - started, 10)
        self.assertTrue((cache / "growth").exists())
        self.assertEqual(self.records()[-1]["reason"], "target-cap-exceeded")
        with self.assertRaises(ProcessLookupError):
            os.kill(int((self.worktree / "owned-pid").read_text()), 0)

    def test_unknown_du_size_is_not_treated_as_zero(self):
        with patch.object(disk, "du", return_value=None):
            with self.assertRaisesRegex(disk.Refused, "target-size-unknown"):
                self.launch()
        self.assertIsNone(self.records()[-1]["du_bytes"]["shared_target"])

    def test_success_quarantines_ignored_untracked_and_links_then_plain_removal(self):
        self.launch()
        (self.worktree / "notes.txt").write_text("preserve me")
        (self.worktree / "ignored").mkdir()
        (self.worktree / "ignored" / "receipt.json").write_text('{"keep": true}')
        external = self.root / "outside.txt"
        external.write_text("outside")
        (self.worktree / "link").symlink_to(external)
        (self.cache() / "artifact").write_text("generated")
        calls = []
        original_git = disk.git
        def observed_git(path, *args):
            calls.append(args)
            return original_git(path, *args)
        with patch.object(disk, "git", side_effect=observed_git):
            result = self.finish()
        self.assertFalse(self.worktree.exists())
        self.assertEqual(result["event"], "publish-removed")
        self.assertEqual(result["prune"], "ok")
        self.assertEqual(result["target_cleanup"], "removed")
        self.assertIn(("worktree", "remove", str(self.worktree)), calls)
        self.assertIn(("worktree", "prune"), calls)
        self.assertFalse(any("--force" in args for args in calls))
        quarantines = list((self.state / "quarantine").iterdir())
        self.assertEqual(len(quarantines), 1)
        preserved = quarantines[0]
        self.assertEqual((preserved / "notes.txt").read_text(), "preserve me")
        self.assertEqual((preserved / "ignored" / "receipt.json").read_text(), '{"keep": true}')
        self.assertTrue((preserved / "link").is_symlink())
        self.assertEqual(os.readlink(preserved / "link"), str(external))
        self.assertEqual(external.read_text(), "outside")
        self.assertEqual(list((self.state / "runs").iterdir()), [])
        self.assertNotIn(str(self.worktree), self.git(self.source, "worktree", "list", "--porcelain").decode())

    def test_publish_removes_worktree_but_defers_cache_used_by_other_launch(self):
        self.launch()
        cache = self.cache()
        (cache / "active").write_text("keep")
        with disk.lock(cache.parent / "lease", shared=True):
            result = self.finish()
            self.assertEqual(result["target_cleanup"], "deferred-active-lease")
            self.assertEqual((cache / "active").read_text(), "keep")
        self.assertFalse(self.worktree.exists())
        self.assertEqual(disk.trim(cache), "removed")
        self.assertFalse((cache / "active").exists())

    def test_publish_cannot_remove_active_worktree(self):
        self.launch()
        with disk.lock(self.state / "locks" / disk.key(self.worktree)):
            with self.assertRaisesRegex(disk.Refused, "active-lease"):
                self.finish()
        self.assertTrue(self.worktree.exists())

    def test_dirty_tracked_edits_remain_untouched(self):
        self.launch()
        (self.worktree / "tracked.txt").write_text("work in progress")
        (self.worktree / "notes.txt").write_text("notes")
        with self.assertRaisesRegex(disk.Refused, "tracked-changes"):
            self.finish()
        self.assertEqual((self.worktree / "tracked.txt").read_text(), "work in progress")
        self.assertTrue((self.worktree / "notes.txt").exists())
        self.assertEqual(list((self.state / "quarantine").iterdir()), [])

    def test_hidden_index_edits_remain_untouched(self):
        self.launch()
        self.git(self.worktree, "update-index", "--assume-unchanged", "tracked.txt")
        (self.worktree / "tracked.txt").write_text("hidden edit")
        with self.assertRaisesRegex(disk.Refused, "hidden-index-entry"):
            self.finish()
        self.assertEqual((self.worktree / "tracked.txt").read_text(), "hidden edit")

    def test_skip_worktree_entries_are_retained(self):
        self.launch()
        self.git(self.worktree, "update-index", "--skip-worktree", "tracked.txt")
        with self.assertRaisesRegex(disk.Refused, "hidden-index-entry"):
            self.finish()
        self.assertTrue(self.worktree.exists())

    def test_main_checkout_and_locked_worktree_are_refused(self):
        with self.assertRaisesRegex(disk.Refused, "not-unlocked-linked-worktree"):
            disk.identity(self.source)
        self.git(self.source, "worktree", "lock", str(self.worktree))
        with self.assertRaisesRegex(disk.Refused, "not-unlocked-linked-worktree"):
            self.launch()
        self.assertTrue(self.worktree.exists())

    def test_current_worktree_is_retained(self):
        self.launch()
        evidence = self.evidence()
        with patch.object(disk.Path, "cwd", return_value=self.worktree):
            with self.assertRaisesRegex(disk.Refused, "current-worktree"):
                self.finish(evidence)
        self.assertTrue(self.worktree.exists())

    def test_publication_fails_closed_on_missing_stale_future_and_nonfinite_evidence(self):
        self.launch()
        cases = [({}, "publication-url-invalid"),
                 (self.evidence(observed_at=time.time() - 301), "publication-evidence-stale"),
                 (self.evidence(observed_at=time.time() + 60), "publication-evidence-stale"),
                 (self.evidence(observed_at=10**1000), "publication-evidence-stale"),
                 (self.evidence(observed_at=float("nan")), "publication-evidence-stale"),
                 (self.evidence(observed_at=float("inf")), "publication-evidence-stale")]
        for evidence, reason in cases:
            with self.subTest(reason=reason, observed=evidence.get("observed_at")):
                with self.assertRaisesRegex(disk.Refused, reason):
                    self.finish(evidence)
                self.assertTrue(self.worktree.exists())

    def test_publication_head_and_repository_must_match(self):
        self.launch()
        with self.assertRaisesRegex(disk.Refused, "publication-head-mismatch"):
            self.finish(self.evidence(head_oid="0" * 40))
        with self.assertRaisesRegex(disk.Refused, "publication-repository-mismatch"):
            self.finish(self.evidence(url="https://github.com/ashlrai/locus/pull/12"))
        self.assertTrue(self.worktree.exists())

    def test_job_receipt_must_match(self):
        self.launch()
        with self.assertRaisesRegex(disk.Refused, "run-receipt-mismatch"):
            self.finish(job="another-job")
        self.assertTrue(self.worktree.exists())

    def test_unmanaged_modules_are_quarantined(self):
        self.launch()
        modules = self.worktree / "node_modules"
        modules.mkdir()
        (modules / "unknown").write_text("preserve")
        self.finish()
        preserved = list((self.state / "quarantine").iterdir())[0]
        self.assertEqual((preserved / "node_modules" / "unknown").read_text(), "preserve")

    def test_only_exact_managed_modules_identity_is_deleted(self):
        modules = self.worktree / "node_modules"
        modules.mkdir()
        (modules / "output").write_text("generated")
        info = modules.stat()
        disk.remove_modules(self.worktree, {"modules_identity": [info.st_dev, info.st_ino]})
        self.assertFalse(modules.exists())

    def test_replaced_modules_identity_is_retained(self):
        modules = self.worktree / "node_modules"
        modules.mkdir()
        info = modules.stat()
        modules.rename(self.worktree / "saved-modules")
        modules.mkdir()
        (modules / "new").write_text("preserve")
        with self.assertRaisesRegex(disk.Refused, "prepared-dependencies-replaced"):
            disk.remove_modules(self.worktree, {"modules_identity": [info.st_dev, info.st_ino]})
        self.assertEqual((modules / "new").read_text(), "preserve")

    def test_tracked_modules_are_never_deleted(self):
        modules = self.worktree / "node_modules"
        modules.mkdir()
        (modules / "tracked").write_text("source")
        self.git(self.worktree, "add", "--force", "node_modules/tracked")
        info = modules.stat()
        with self.assertRaisesRegex(disk.Refused, "tracked-dependencies"):
            disk.remove_modules(self.worktree, {"modules_identity": [info.st_dev, info.st_ino]})
        self.assertEqual((modules / "tracked").read_text(), "source")

    def test_symlinked_state_and_target_are_refused(self):
        outside = self.root / "outside"
        outside.mkdir()
        self.state.symlink_to(outside)
        with self.assertRaisesRegex(disk.Refused, "symlinked-directory"):
            self.launch()
        self.state.unlink()
        cache = self.cache()
        cache.symlink_to(outside)
        with self.assertRaisesRegex(disk.Refused, "symlinked-target"):
            disk.trim(cache)
        self.assertTrue(outside.is_dir())

    def test_source_must_be_same_git_repository(self):
        other = self.make_repo("other")
        with self.assertRaisesRegex(disk.Refused, "dependency-source-repository-mismatch"):
            self.launch(source=other)
        self.assertTrue(self.worktree.exists())

    def test_duplicate_launch_is_refused(self):
        self.launch()
        with self.assertRaisesRegex(disk.Refused, "run-already-prepared"):
            self.launch()

    def test_prune_failure_is_distinct_from_removal_failure(self):
        self.launch()
        original_git = disk.git
        def failing_prune(path, *args):
            if args == ("worktree", "prune"):
                raise disk.Refused("git-failed")
            return original_git(path, *args)
        with patch.object(disk, "git", side_effect=failing_prune):
            result = self.finish()
        self.assertEqual(result["event"], "publish-removed")
        self.assertEqual(result["prune"], "failed")
        self.assertFalse(self.worktree.exists())

    def test_target_cleanup_failure_never_claims_removed_worktree_is_retained(self):
        self.launch()
        with patch.object(disk, "trim", side_effect=OSError("fixture failure")):
            result = self.finish()
        self.assertFalse(self.worktree.exists())
        self.assertEqual(result["event"], "publish-removed")
        self.assertEqual(result["target_cleanup"], "failed")
        self.assertEqual(self.records()[-1]["event"], "publish-removed")

    def test_idle_reaper_retries_deferred_target_after_lease_released(self):
        self.launch()
        cache = self.cache()
        (cache / "shared-output").write_text("active")
        with disk.lock(cache.parent / "lease", shared=True):
            self.finish()
            self.assertTrue((cache.parent / "cleanup-pending.json").exists())
            disk.reap_pending(self.state, self.worktree, "idle-cycle")
            self.assertTrue((cache / "shared-output").exists())
        disk.reap_pending(self.state, self.worktree, "idle-cycle")
        self.assertFalse((cache / "shared-output").exists())
        self.assertFalse((cache.parent / "cleanup-pending.json").exists())
        self.assertEqual(self.records()[-1]["event"], "reap-target")
        self.assertEqual(self.records()[-1]["target_cleanup"], "removed")

    def test_idle_reaper_refuses_symlinked_repository_cache_ancestor(self):
        cache = self.cache()
        cache.mkdir()
        (cache / "artifact").write_text("preserve")
        (cache.parent / "cleanup-pending.json").write_text("{}")
        outside = self.root / "outside-repos"
        (self.state / "repos").rename(outside)
        (self.state / "repos").symlink_to(outside)
        with self.assertRaisesRegex(disk.Refused, "symlinked-directory"):
            disk.reap_pending(self.state, self.worktree, "idle-cycle")
        self.assertEqual((outside / cache.parent.name / "target" / "artifact").read_text(), "preserve")

    def test_child_keeps_worktree_and_target_leases_after_supervisor_is_killed(self):
        supervisor_script = (
            "import importlib.util,sys; from pathlib import Path; from types import SimpleNamespace; "
            "s=importlib.util.spec_from_file_location('fixture_disk',sys.argv[1]); "
            "d=importlib.util.module_from_spec(s); s.loader.exec_module(d); "
            "d.shutil.disk_usage=lambda p:SimpleNamespace(free=40*1024**3,used=1); "
            "d.launch(Path(sys.argv[2]),Path(sys.argv[3]),Path(sys.argv[4]),'RQ-TEST',"
            "[sys.executable,'-c',\"import os,pathlib,time; pathlib.Path('owned-pid').write_text(str(os.getpid())); time.sleep(60)\"])"
        )
        child_pid = None
        supervisor = subprocess.Popen(
            [sys.executable, "-B", "-c", supervisor_script, str(Path(disk.__file__)),
             str(self.source), str(self.worktree), str(self.state)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 20
            marker = self.worktree / "owned-pid"
            while not marker.exists() and supervisor.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertTrue(marker.exists(), "supervised child did not start")
            child_pid = int(marker.read_text())
            supervisor.kill()
            supervisor.wait(timeout=10)
            os.kill(child_pid, 0)
            for lease in (self.state / "locks" / disk.key(self.worktree), self.cache().parent / "lease"):
                with self.subTest(lease=lease.name):
                    with self.assertRaisesRegex(disk.Refused, "active-lease"):
                        with disk.lock(lease):
                            self.fail("live child's lease was lost")
        finally:
            if supervisor.poll() is None:
                supervisor.kill()
            supervisor.wait(timeout=10)
            if child_pid is not None:
                try:
                    os.killpg(child_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def test_submodule_worktree_is_retained(self):
        self.launch()
        self.git(self.worktree, "-c", "protocol.file.allow=always", "submodule", "add", str(self.source), "nested")
        self.git(self.worktree, "commit", "-m", "fixture gitlink")
        with self.assertRaisesRegex(disk.Refused, "submodule-worktree"):
            self.finish()
        self.assertTrue(self.worktree.exists())

    def test_quarantine_failure_preserves_worktree(self):
        self.launch()
        (self.worktree / "notes.txt").write_text("recoverable")
        with patch.object(disk.os, "rename", side_effect=OSError("fixture quarantine failure")):
            with self.assertRaises(OSError):
                self.finish()
        self.assertTrue(self.worktree.exists())
        self.assertEqual((self.worktree / "notes.txt").read_text(), "recoverable")
        self.assertEqual(self.records()[-1]["event"], "publish-retained")

    def test_failed_du_is_logged_as_unknown(self):
        cache = self.cache()
        cache.mkdir()
        with patch.object(disk.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout=b"")):
            self.assertIsNone(disk.du(cache))

    def test_du_permission_failure_is_unknown_not_absent(self):
        missing = self.root / "missing"
        self.assertEqual(disk.du(missing), 0)
        with patch.object(disk.Path, "lstat", side_effect=PermissionError("fixture denied")):
            self.assertIsNone(disk.du(self.worktree))

    def test_callable_boundaries_reject_invalid_job_before_creating_state(self):
        actions = (
            lambda job: disk.launch(self.source, self.worktree, self.state, job, [sys.executable, "-c", "pass"]),
            lambda job: disk.finish(self.worktree, self.state, job, {}),
            lambda job: disk.reap_pending(self.state, self.worktree, job),
            lambda job: disk.attribute_repository(self.worktree, self.state, job),
        )
        for job in ("../escape", "bad\nname", "", "x" * 129, None):
            for action in actions:
                with self.subTest(job=job, action=actions.index(action)):
                    with self.assertRaisesRegex(disk.Refused, "invalid-job"):
                        action(job)
                    self.assertFalse(self.state.exists())

    def test_cli_accepts_action_followed_by_options(self):
        arguments = [str(Path(disk.__file__)), "measure", "--worktree", str(self.worktree),
                     "--state-dir", str(self.state), "--job", self.job]
        with patch.object(sys, "argv", arguments):
            self.assertEqual(disk.main(), 0)
        self.assertEqual(self.records()[-1]["event"], "measurement")

    def test_repository_attribution_includes_main_and_linked_worktrees_with_unknown_sizes(self):
        second = self.make_worktree("second")
        (self.worktree / "target").mkdir()
        (self.worktree / "target" / "output").write_bytes(b"x" * 8192)
        original_du = disk.du
        def selective_du(path):
            if path == second / "node_modules":
                return None
            return original_du(path)
        with patch.object(disk, "du", side_effect=selective_du):
            result = disk.attribute_repository(self.worktree, self.state, self.job)
        rows = {row["worktree"]: row["du_bytes"] for row in result["worktrees"]}
        self.assertEqual(set(rows), {str(self.source), str(self.worktree), str(second)})
        self.assertGreaterEqual(rows[str(self.worktree)]["target"], 8192)
        self.assertIsNone(rows[str(second)]["node_modules"])
        self.assertEqual(rows[str(second)]["target"], 0)
        logged = self.records()[-1]
        self.assertEqual(logged["event"], "repository-attribution")
        self.assertEqual(logged["worktrees"], result["worktrees"])
        self.assertTrue((self.worktree / "target" / "output").exists())


if __name__ == "__main__":
    unittest.main()
