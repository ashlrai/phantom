import copy
from concurrent.futures import ThreadPoolExecutor
import fcntl
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


class UpstreamOriginal157Tests(unittest.TestCase):
    ORIGINAL = "0837489ab7bb6b8801884108f8932367d10f68b1"

    def setUp(self):
        self.r = dict(schema=2, profile="upstream-original157", job="RQ-ORIGINAL",
                      repo="ashlr-plugin", pr=157, headRepo="ashlrai/ashlr-plugin",
                      headRef="feat/read-range", originalHead=self.ORIGINAL,
                      mainHead="2" * 40, mergeHead="3" * 40, tree="4" * 40,
                      createdAt=1000, expiresAt=1600, evidenceSha256="5" * 64)
        self.repository = dict(full_name="ashlrai/ashlr-plugin", default_branch="main")
        self.pr = dict(number=157, state="open", merged_at=None,
                       head=dict(repo=dict(full_name="ashlrai/ashlr-plugin"),
                                 ref="feat/read-range", sha=self.ORIGINAL),
                       base=dict(repo=dict(full_name="ashlrai/ashlr-plugin"), ref="main"))
        self.default = dict(name="main", protected=True, commit=dict(sha="2" * 40))
        self.feature = dict(name="feat/read-range", protected=False,
                            commit=dict(sha=self.ORIGINAL))

    def receipt(self, r=None, now=1200):
        m.validate_upstream_receipt(r or self.r, "RQ-ORIGINAL", "ashlr-plugin",
                                    "2" * 40, now)

    def remote(self, r=None, repository=None, pr=None, default=None, feature=None, rules=None):
        return m.validate_upstream_remote(r or self.r, repository if repository is not None else self.repository,
            pr if pr is not None else self.pr, default if default is not None else self.default,
            feature if feature is not None else self.feature, rules if rules is not None else [])

    def test_closed_profile_positive_and_legacy_separation(self):
        self.receipt()
        self.remote()
        with self.assertRaises(m.Refused):
            m.validate_receipt(self.r, "RQ-ORIGINAL", "ashlr-plugin", "2" * 40, 1200)

    def test_wrong_profile_tuple_ref_or_head_refused(self):
        for key, value in [("profile", "fork"), ("schema", 1), ("repo", "lexicon"),
                           ("pr", 158), ("headRepo", "other/ashlr-plugin"),
                           ("headRef", "main"), ("headRef", "refs/heads/feat/read-range"),
                           ("originalHead", "1" * 40), ("mainHead", "6" * 40)]:
            with self.subTest(key=key, value=value):
                with self.assertRaises(m.Refused): self.receipt(dict(self.r, **{key: value}))

    def test_ttl_and_receipt_schema_refused(self):
        for changes, now in [(dict(expiresAt=1200), 1200), (dict(createdAt=1201), 1200),
                             (dict(expiresAt=2801), 1200), (dict(extra=True), 1200)]:
            with self.assertRaises(m.Refused): self.receipt(dict(self.r, **changes), now)

    def test_remote_tuple_head_base_and_freshness_refused(self):
        for section, key, value in [("head", "sha", "6" * 40), ("head", "ref", "main"),
                                     ("head", "repo", dict(full_name="other/ashlr-plugin")),
                                     ("base", "ref", "master"),
                                     ("base", "repo", dict(full_name="other/ashlr-plugin"))]:
            pr = copy.deepcopy(self.pr)
            pr[section][key] = value
            with self.subTest(section=section, key=key), self.assertRaises(m.Refused):
                self.remote(pr=pr)
        for pr in [dict(self.pr, number=158), dict(self.pr, state="closed"),
                   dict(self.pr, merged_at="today")]:
            with self.assertRaises(m.Refused): self.remote(pr=pr)
        for repository in [dict(self.repository, full_name="other/ashlr-plugin"),
                           dict(self.repository, default_branch="feat/read-range"),
                           dict(self.repository, default_branch="release"), {}]:
            with self.assertRaises(m.Refused): self.remote(repository=repository)
        for default in [dict(self.default, protected=False), dict(self.default, protected=None),
                        dict(self.default, commit=dict(sha="6" * 40)), {}]:
            with self.assertRaises(m.Refused): self.remote(default=default)

    def test_unknown_protection_rules_and_branch_identity_refused(self):
        for feature in [dict(self.feature, protected=True), dict(self.feature, protected=None),
                        dict(self.feature, name="main"), dict(self.feature, name="master"),
                        dict(self.feature, name="release/x"), dict(self.feature, name="refs/tags/x"),
                        dict(self.feature, commit=dict(sha="6" * 40)), {}]:
            with self.assertRaises(m.Refused): self.remote(feature=feature)
        for rules in [{}, [dict(type="required_status_checks")], "[]", False]:
            with self.assertRaises(m.Refused): self.remote(rules=rules)

    def test_postcondition_requires_both_original_pr_and_feature_at_authored_head(self):
        pr = copy.deepcopy(self.pr)
        feature = copy.deepcopy(self.feature)
        pr["head"]["sha"] = self.r["mergeHead"]
        feature["commit"]["sha"] = self.r["mergeHead"]
        m.validate_upstream_remote(self.r, self.repository, pr, self.default, feature, [], post=True)
        for changed_pr, changed_feature in [(self.pr, feature), (pr, self.feature)]:
            with self.assertRaises(m.Refused):
                m.validate_upstream_remote(self.r, self.repository, changed_pr, self.default,
                                           changed_feature, [], post=True)

    def test_admission_requires_exact_prospective_tree_and_leaves_policy_to_server(self):
        merge = "6" * 40
        pr = dict(mergeable=True, merge_commit_sha=merge)
        candidate = dict(sha=merge, tree=dict(sha=self.r["tree"]),
                         parents=[dict(sha=self.r["mainHead"]), dict(sha=self.r["mergeHead"])])
        for rules in (None, [], [dict(type="future_server_rule")]):
            self.assertEqual(m.validate_admission(self.r, rules, pr, candidate), merge)
        for bad in (dict(candidate, sha="7" * 40), dict(candidate, tree=dict(sha="7" * 40)),
                    dict(candidate, parents=list(reversed(candidate["parents"]))),
                    dict(candidate, parents=candidate["parents"] + [dict(sha="7" * 40)])):
            with self.assertRaises(m.Refused): m.validate_admission(self.r, None, pr, bad)
        for bad in (dict(pr, mergeable=None), dict(pr, merge_commit_sha=None)):
            with self.assertRaises(m.Refused): m.validate_admission(self.r, None, bad, candidate)

    def test_rule_array_parser_keeps_object_only_proof_parser(self):
        self.assertEqual(m.decode_rules(b"[]"), [])
        for raw in [b"{}", b"null", b"[", b"[{\"a\":1,\"a\":2}]"]:
            with self.assertRaises((m.Refused, ValueError)): m.decode_rules(raw)
        with self.assertRaises(m.Refused): m.decode(b"[]")

    def test_existing_git_and_evidence_guards_apply_to_profile(self):
        facts = dict(head=self.r["mergeHead"], parents=[self.ORIGINAL, self.r["mainHead"]],
                     tree=self.r["tree"], mainTree=self.r["tree"], indexTree=self.r["tree"],
                     trackedClean=True, extraFiles=[])
        m.validate_git(self.r, facts)
        for changes in [dict(parents=list(reversed(facts["parents"]))),
                        dict(parents=facts["parents"] + ["6" * 40]),
                        dict(tree="6" * 40), dict(mainTree="6" * 40),
                        dict(indexTree="6" * 40), dict(trackedClean=False),
                        dict(extraFiles=["?? injected"])]:
            with self.assertRaises(m.Refused): m.validate_git(self.r, dict(facts, **changes))


class UpstreamAttemptJournalTests(unittest.TestCase):
    ORIGINAL = UpstreamOriginal157Tests.ORIGINAL

    def setUp(self):
        UpstreamOriginal157Tests.setUp(self)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.directory = self.root / "integrated-merge"
        self.directory.mkdir(mode=0o700)
        self.attempt = self.directory / "upstream-original157.attempt"

    def test_exclusive_journal_fences_other_jobs_and_changed_receipts(self):
        self.assertRegex(m.journal_attempt(self.root, self.r), r"^CREATED [0-9a-f]{64}$")
        self.assertEqual(m.journal_attempt(self.root, self.r), "EXISTING")
        for changed in (dict(self.r, job="RQ-OTHER"),
                        dict(self.r, mergeHead="6" * 40),
                        dict(self.r, evidenceSha256="6" * 64)):
            with self.subTest(changed=changed), self.assertRaises((m.Refused, OSError)):
                m.journal_attempt(self.root, changed)
        self.assertEqual(m.journal_attempt(self.root, self.r), "EXISTING")

    def test_existing_bad_or_unsafe_record_never_grants_a_new_attempt(self):
        for kind in ("bad-json", "symlink", "hardlink", "mode", "oversized"):
            with self.subTest(kind=kind):
                if kind == "symlink":
                    target = self.root / "target"
                    target.write_text("{}")
                    self.attempt.symlink_to(target)
                else:
                    self.attempt.write_text("{" if kind == "bad-json" else "x" * (20000 if kind == "oversized" else 1))
                    self.attempt.chmod(0o600 if kind != "mode" else 0o644)
                    if kind == "hardlink":
                        os.link(self.attempt, self.root / "linked")
                with self.assertRaises((m.Refused, OSError, ValueError)):
                    m.journal_attempt(self.root, self.r)
                self.attempt.unlink()
                linked = self.root / "linked"
                if linked.exists():
                    linked.unlink()

    def test_unsafe_parent_and_tampered_journal_fail_closed(self):
        self.directory.chmod(0o755)
        with self.assertRaises((m.Refused, OSError)):
            m.journal_attempt(self.root, self.r)
        self.directory.chmod(0o700)
        self.assertRegex(m.journal_attempt(self.root, self.r), r"^CREATED [0-9a-f]{64}$")
        record = json.loads(self.attempt.read_text())
        record["mergeHead"] = "9" * 40
        self.attempt.write_text(json.dumps(record))
        with self.assertRaises((m.Refused, OSError, ValueError)):
            m.journal_attempt(self.root, self.r)

    def test_outcome_is_durable_and_does_not_release_fence(self):
        with self.assertRaises((m.Refused, OSError, ValueError)):
            m.record_outcome(self.root, self.r, "MERGED")
        self.assertRegex(m.journal_attempt(self.root, self.r), r"^CREATED [0-9a-f]{64}$")
        for status in ("HELD", "REQUESTED", "QUEUED", "MERGED"):
            m.record_outcome(self.root, self.r, status)
            self.assertEqual(json.loads(self.attempt.read_text())["state"], status)
            self.assertEqual(m.journal_attempt(self.root, self.r), "EXISTING")
        with self.assertRaises((m.Refused, OSError, ValueError)):
            m.record_outcome(self.root, self.r, "SUCCESS")
        with self.assertRaises((m.Refused, OSError, ValueError)):
            m.record_outcome(self.root, dict(self.r, job="RQ-OTHER"), "MERGED")

    def test_concurrent_outcomes_cannot_overwrite_terminal_merge(self):
        m.journal_attempt(self.root, self.r)
        def update(status):
            try:
                m.record_outcome(self.root, self.r, status)
            except (m.Refused, BlockingIOError):
                return False
            return True
        with ThreadPoolExecutor(max_workers=8) as executor:
            list(executor.map(update, ["HELD"] * 16))
        m.record_outcome(self.root, self.r, "MERGED")
        with ThreadPoolExecutor(max_workers=8) as executor:
            list(executor.map(update, ["HELD", "MERGED"] * 16))
        self.assertEqual(json.loads(self.attempt.read_text())["state"], "MERGED")
        with self.assertRaises(m.Refused):
            m.record_outcome(self.root, self.r, "HELD")

    def test_launch_token_is_exact_and_never_reused_after_transport_failure(self):
        token = m.journal_attempt(self.root, self.r).split()[1]
        calls = []
        class FailedRuntime:
            def __init__(self, root, wt):
                self.gs = Path(root) / "bin/git-safe-env.sh"
            def command(self, args):
                calls.append(args)
                raise m.Refused("simulated ambiguous transport")
        with patch.object(m, "verify", return_value=self.r), patch.object(m, "Runtime", FailedRuntime):
            with self.assertRaises((m.Refused, OSError)):
                m.push(self.root, self.r["job"], self.r["mainHead"], "wt", "0" * 64)
            with self.assertRaises(m.Refused):
                m.push(self.root, self.r["job"], self.r["mainHead"], "wt", token)
            with self.assertRaises((m.Refused, OSError)):
                m.push(self.root, self.r["job"], self.r["mainHead"], "wt", token)
        self.assertEqual(len(calls), 1)

    def test_held_outcome_or_concurrent_outcome_lock_prevents_launch(self):
        token = m.journal_attempt(self.root, self.r).split()[1]
        launch = self.directory / "upstream-original157.launch"
        lock_path = self.directory / "upstream-original157.outcome-lock"
        lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(m, "verify", return_value=self.r):
                with self.assertRaises((m.Refused, BlockingIOError)):
                    m.push(self.root, self.r["job"], self.r["mainHead"], "wt", token)
            self.assertFalse(launch.exists())
        finally:
            os.close(lock_fd)
        m.record_outcome(self.root, self.r, "HELD")
        with patch.object(m, "verify", return_value=self.r):
            with self.assertRaises(m.Refused):
                m.push(self.root, self.r["job"], self.r["mainHead"], "wt", token)
        self.assertFalse(launch.exists())

    def test_fresh_outcomes_distinguish_requested_queue_and_merged(self):
        m.journal_attempt(self.root, self.r)
        pr = copy.deepcopy(self.pr)
        pr["auto_merge"] = None
        pr["head"]["sha"] = self.r["mergeHead"]
        pr["base"]["sha"] = self.r["mainHead"]
        feature = dict(self.feature, commit=dict(sha=self.r["mergeHead"]))
        merge_sha = "6" * 40
        main = copy.deepcopy(self.default)
        responses = {
            "repos/ashlrai/ashlr-plugin": self.repository,
            "repos/ashlrai/ashlr-plugin/pulls/157": pr,
            "repos/ashlrai/ashlr-plugin/branches/main": main,
            "repos/ashlrai/ashlr-plugin/branches/feat%2Fread-range": feature,
            "repos/ashlrai/ashlr-plugin/git/commits/" + merge_sha:
                dict(sha=merge_sha, tree=dict(sha=self.r["tree"])),
            "repos/ashlrai/ashlr-plugin/git/commits/" + self.r["mainHead"]:
                dict(sha=self.r["mainHead"], tree=dict(sha=self.r["tree"])),
            "repos/ashlrai/ashlr-plugin/compare/" + merge_sha + "..." + self.r["mainHead"]:
                dict(status="ahead", base_commit=dict(sha=merge_sha),
                     merge_base_commit=dict(sha=merge_sha)),
        }
        node = dict(number=157, headRefOid=self.r["mergeHead"], mergeQueueEntry=None)
        class MockRuntime:
            def __init__(self, root, wt): pass
            def api(self, route): return copy.deepcopy(responses[route])
            def command(self, args):
                return json.dumps(dict(data=dict(repository=dict(pullRequest=node))))
        with patch.object(m, "verify", return_value=self.r), patch.object(m, "admission", return_value=self.r), patch.object(m, "Runtime", MockRuntime):
            self.assertEqual(m.outcome(self.root, self.r["job"], self.r["mainHead"], "wt"), "READY")
            pr["auto_merge"] = {"merge_method": "merge", "enabled_by": {"login": "operator"}}
            self.assertEqual(m.outcome(self.root, self.r["job"], self.r["mainHead"], "wt"), "REQUESTED")
            for invalid in ({}, {"merge_method": "merge"}, {"merge_method": "invalid", "enabled_by": {"login": "operator"}}):
                pr["auto_merge"] = invalid
                with self.assertRaises(m.Refused):
                    m.outcome(self.root, self.r["job"], self.r["mainHead"], "wt")
            del pr["auto_merge"]
            with self.assertRaises(m.Refused):
                m.outcome(self.root, self.r["job"], self.r["mainHead"], "wt")
            pr["auto_merge"] = {"merge_method": "merge", "enabled_by": {"login": "operator"}}
            node["mergeQueueEntry"] = {"id": "queue-entry"}
            self.assertEqual(m.outcome(self.root, self.r["job"], self.r["mainHead"], "wt"), "QUEUED")
            node["headRefOid"] = "9" * 40
            with self.assertRaises(m.Refused):
                m.outcome(self.root, self.r["job"], self.r["mainHead"], "wt")
            pr.update(state="closed", merged_at="2026-11-07T00:00:00Z", merge_commit_sha=merge_sha)
            self.assertEqual(m.outcome(self.root, self.r["job"], self.r["mainHead"], "wt"), "MERGED")
            responses["repos/ashlrai/ashlr-plugin/git/commits/" + merge_sha]["tree"]["sha"] = "9" * 40
            with self.assertRaises(m.Refused):
                m.outcome(self.root, self.r["job"], self.r["mainHead"], "wt")


class IntegratedRealGitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.env = dict(os.environ, HOME=str(self.root), GIT_CONFIG_NOSYSTEM="1",
                        GIT_AUTHOR_NAME="Fixture", GIT_AUTHOR_EMAIL="fixture@example.invalid",
                        GIT_COMMITTER_NAME="Fixture", GIT_COMMITTER_EMAIL="fixture@example.invalid")
        self.git("init", "-q")
        (self.repo / "file").write_text("base\n")
        self.git("add", "file")
        self.git("commit", "-qm", "base")
        self.base = self.git("rev-parse", "HEAD")
        (self.repo / "file").write_text("original\n")
        self.git("commit", "-qam", "original")
        self.original = self.git("rev-parse", "HEAD")
        self.git("checkout", "-q", "--detach", self.base)
        (self.repo / "file").write_text("main\n")
        self.git("commit", "-qam", "main")
        self.main = self.git("rev-parse", "HEAD")
        self.tree = self.git("rev-parse", "HEAD^{tree}")
        self.merge = self.git("commit-tree", self.tree, "-p", self.original, "-p", self.main,
                              "-m", "preserve history")
        self.git("checkout", "-q", "--detach", self.merge)

    def git(self, *args, check=True):
        result = subprocess.run(["git", *args], cwd=self.repo, env=self.env,
                                capture_output=True, text=True, check=check, timeout=10)
        return result.stdout.strip() if check else result

    def facts(self):
        status = self.git("status", "--porcelain", "-uall")
        return dict(head=self.git("rev-parse", "HEAD"),
                    parents=self.git("rev-list", "--parents", "-n", "1", "HEAD").split()[1:],
                    tree=self.git("rev-parse", "HEAD^{tree}"),
                    mainTree=self.git("rev-parse", self.main + "^{tree}"),
                    indexTree=self.git("write-tree"), trackedClean=not status,
                    extraFiles=status.splitlines())

    def test_real_two_parent_equal_tree_and_dirty_index_refusal(self):
        r = dict(originalHead=self.original, mainHead=self.main, mergeHead=self.merge, tree=self.tree)
        m.validate_git(r, self.facts())
        (self.repo / "file").write_text("injected\n")
        with self.assertRaises(m.Refused): m.validate_git(r, self.facts())
        self.git("add", "file")
        with self.assertRaises(m.Refused): m.validate_git(r, self.facts())
        self.git("reset", "--hard", "-q", self.merge)
        (self.repo / "unknown").write_text("x")
        with self.assertRaises(m.Refused): m.validate_git(r, self.facts())

    def test_real_nonforce_fast_forward_and_race_refusal(self):
        bare = self.root / "remote.git"
        subprocess.run(["git", "init", "--bare", "-q", str(bare)], env=self.env,
                       check=True, capture_output=True, timeout=10)
        ref = "refs/heads/feat/read-range"
        self.git("push", "-q", str(bare), self.original + ":" + ref)
        self.git("push", "-q", str(bare), self.merge + ":" + ref)
        self.assertEqual(self.git("ls-remote", str(bare), ref).split()[0], self.merge)
        race = self.git("commit-tree", self.tree, "-p", self.merge, "-m", "racer")
        self.git("push", "-q", str(bare), race + ":" + ref)
        result = self.git("push", str(bare), self.merge + ":" + ref, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.git("ls-remote", str(bare), ref).split()[0], race)


class ExactLeaseLocalGitTests(IntegratedRealGitTests):
    def test_exact_lease_accepts_original_and_rejects_advance_and_rewind(self):
        bare = self.root / "remote.git"
        subprocess.run(["git", "init", "--bare", "-q", str(bare)], env=self.env,
                       check=True, capture_output=True, timeout=10)
        ref = "refs/heads/feat/read-range"
        def set_remote(sha):
            subprocess.run(["git", "--git-dir", str(bare), "update-ref", ref, sha],
                           env=self.env, check=True, capture_output=True, timeout=10)
        # Populate the bare object database before setting fixture-only refs.
        self.git("push", "-q", str(bare), self.original + ":" + ref)
        result = self.git("push", "--force-with-lease=" + ref + ":" + self.original,
                          str(bare), self.merge + ":" + ref, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git("ls-remote", str(bare), ref).split()[0], self.merge)
        self.assertEqual(self.git("merge-base", self.original, self.merge), self.original)
        # An advance and a rewind both invalidate the exact expected old value.
        advance = self.git("commit-tree", self.tree, "-p", self.merge, "-m", "advance")
        self.git("push", "-q", str(bare), advance + ":refs/heads/fixture")
        for actual in (advance, self.base):
            with self.subTest(actual=actual):
                set_remote(actual)
                result = self.git("push", "--force-with-lease=" + ref + ":" + self.original,
                                  str(bare), self.merge + ":" + ref, check=False)
                self.assertNotEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.git("ls-remote", str(bare), ref).split()[0], actual)

    def test_pinned_wrapper_checks_worktree_then_forwards_closed_argv(self):
        helper = Path(__file__).resolve().parent / "fixtures/git-safe-env-exact-pinned.sh"
        self.assertEqual(hashlib.sha256(helper.read_bytes()).hexdigest(),
                         "234fb12a57a51fdfed81da8702a0b452c183f2726582608b81b7e811a65ce1a2")
        # gs_check requires a real linked worktree under an allowlisted repository.
        root = self.root.resolve() / "projects"
        root.mkdir()
        repo = root / "ashlr-plugin"
        subprocess.run(["git", "init", "-q", str(repo)], env=self.env, check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "--allow-empty", "-qm", "base"],
                       env=self.env, check=True)
        wt = self.root.resolve() / "linked"
        subprocess.run(["git", "-C", str(repo), "worktree", "add", "-q", "--detach", str(wt)],
                       env=self.env, check=True)
        fake = self.root / "git-capture"
        fake.write_text('#!/bin/bash\nprintf "%s\\n" "$@"\n')
        fake.chmod(0o700)
        script = """source "$1"
GS_REPO_ROOT_DIR="$2"; gs_init || exit 10
why=$(gs_check "$3") || { printf "unsafe: %s\n" "$why" >&2; exit 11; }
GS_GIT="$4"
gs_git "$3" push --force-with-lease=refs/heads/feat/read-range:0837489ab7bb6b8801884108f8932367d10f68b1 https://github.com/ashlrai/ashlr-plugin.git "$5:refs/heads/feat/read-range"
"""
        sha = "a" * 40
        result = subprocess.run(["/bin/bash", "-c", script, "fixture", str(helper), str(root),
                                 str(wt), str(fake), sha], env=self.env, capture_output=True,
                                text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        args = result.stdout.splitlines()
        self.assertEqual(args[-6:], ["-C", str(wt), "push",
                         "--force-with-lease=refs/heads/feat/read-range:0837489ab7bb6b8801884108f8932367d10f68b1",
                         "https://github.com/ashlrai/ashlr-plugin.git",
                         sha + ":refs/heads/feat/read-range"])


class UpstreamLexiconTupleTests(unittest.TestCase):
    """The same closed upstream route now binds exactly two Lexicon tuples."""

    TUPLES = {
        "upstream-lexicon479": dict(pr=479, head="3b7c93ff552d3fa7a5b835a416c238c37be78cdd",
                                    ref="dependabot/github_actions/actions/download-artifact-8",
                                    api="dependabot%2Fgithub_actions%2Factions%2Fdownload-artifact-8"),
        "upstream-lexicon480": dict(pr=480, head="f6975814f2ae2b562c81c57e50c5ecdeb05627d6",
                                    ref="dependabot/github_actions/actions/cache-6",
                                    api="dependabot%2Fgithub_actions%2Factions%2Fcache-6"),
    }

    def setUp(self):
        self.profile = "upstream-lexicon479"
        t = self.TUPLES[self.profile]
        self.t = t
        self.r = dict(schema=2, profile=self.profile, job="RQ-LEX",
                      repo="lexicon", pr=t["pr"], headRepo="ashlrai/lexicon",
                      headRef=t["ref"], originalHead=t["head"],
                      mainHead="2" * 40, mergeHead="3" * 40, tree="4" * 40,
                      createdAt=1000, expiresAt=1600, evidenceSha256="5" * 64)
        self.repository = dict(id=1376859455, full_name="ashlrai/lexicon", default_branch="main")
        self.pr = dict(number=t["pr"], state="open", merged_at=None,
                       head=dict(repo=dict(id=1376859455, full_name="ashlrai/lexicon"),
                                 ref=t["ref"], sha=t["head"]),
                       base=dict(repo=dict(id=1376859455, full_name="ashlrai/lexicon"), ref="main"))
        self.default = dict(name="main", protected=True, commit=dict(sha="2" * 40))
        self.feature = dict(name=t["ref"], protected=False,
                            commit=dict(sha=t["head"]))

    def receipt(self, r=None, now=1200):
        m.validate_upstream_receipt(r or self.r, "RQ-LEX", "lexicon", "2" * 40, now)

    def remote(self, r=None, repository=None, pr=None, default=None, feature=None, rules=None):
        return m.validate_upstream_remote(r or self.r,
            repository if repository is not None else self.repository,
            pr if pr is not None else self.pr,
            default if default is not None else self.default,
            feature if feature is not None else self.feature,
            rules if rules is not None else [])

    def test_both_closed_lexicon_tuples_accepted(self):
        for profile, t in self.TUPLES.items():
            with self.subTest(profile=profile):
                r = dict(self.r, profile=profile, pr=t["pr"], headRef=t["ref"],
                         originalHead=t["head"])
                m.validate_upstream_receipt(r, "RQ-LEX", "lexicon", "2" * 40, 1200)
                pr = dict(self.pr, number=t["pr"],
                          head=dict(repo=dict(id=1376859455, full_name="ashlrai/lexicon"),
                                    ref=t["ref"], sha=t["head"]))
                feature = dict(self.feature, name=t["ref"], commit=dict(sha=t["head"]))
                m.validate_upstream_remote(r, self.repository, pr, self.default, feature, [])

    def test_immutable_repository_id_is_required_in_all_observations(self):
        for profile, t in self.TUPLES.items():
            r = dict(self.r, profile=profile, pr=t["pr"], headRef=t["ref"], originalHead=t["head"])
            original_pr = copy.deepcopy(self.pr)
            original_pr.update(number=t["pr"])
            original_pr["head"].update(ref=t["ref"], sha=t["head"])
            feature = dict(self.feature, name=t["ref"], commit=dict(sha=t["head"]))
            m.validate_upstream_remote(r, self.repository, original_pr, self.default, feature, [])
            for location in ("repository", "head", "base"):
                for wrong in (None, True, False, 1, 1376859455.0, "1376859455"):
                    repo, pr = copy.deepcopy(self.repository), copy.deepcopy(original_pr)
                    target = repo if location == "repository" else pr[location]["repo"]
                    if wrong is None: target.pop("id")
                    else: target["id"] = wrong
                    with self.subTest(profile=profile, location=location, wrong=wrong), self.assertRaises(m.Refused):
                        m.validate_upstream_remote(r, repo, pr, self.default, feature, [])

    def test_cross_tuple_and_wrong_identity_refused(self):
        other = self.TUPLES["upstream-lexicon480"]
        for key, value in [
                ("profile", "upstream-lexicon480"), ("profile", "fork"), ("profile", "upstream-original157"),
                ("repo", "ashlr-plugin"), ("pr", 480), ("pr", 157),
                ("headRepo", "ashlrai/ashlr-plugin"), ("headRef", "feat/read-range"),
                ("headRef", "main"), ("headRef", "refs/heads/" + self.t["ref"]),
                ("originalHead", other["head"]), ("originalHead", "1" * 40),
                ("mainHead", "6" * 40), ("schema", 1)]:
            with self.subTest(key=key, value=value):
                with self.assertRaises(m.Refused):
                    self.receipt(dict(self.r, **{key: value}))
        # A lexicon480 receipt cannot borrow the 479 head fields.
        mixed = dict(self.r, profile="upstream-lexicon480", pr=480,
                     headRef=self.t["ref"], originalHead=self.t["head"])
        with self.assertRaises(m.Refused): self.receipt(mixed)

    def test_remote_tuple_and_freshness_guards(self):
        self.remote()
        for section, key, value in [
                ("head", "sha", "6" * 40), ("head", "ref", "main"),
                ("head", "repo", dict(full_name="other/lexicon")),
                ("head", "repo", None),
                ("base", "ref", "master"), ("base", "repo", dict(full_name="other/lexicon"))]:
            pr = copy.deepcopy(self.pr)
            pr[section][key] = value
            with self.subTest(section=section, key=key), self.assertRaises(m.Refused):
                self.remote(pr=pr)
        for pr in [dict(self.pr, number=480), dict(self.pr, state="closed"),
                   dict(self.pr, merged_at="today")]:
            with self.assertRaises(m.Refused): self.remote(pr=pr)
        for repository in [dict(self.repository, full_name="other/lexicon"),
                           dict(self.repository, default_branch="release"), {}]:
            with self.assertRaises(m.Refused): self.remote(repository=repository)
        for default in [dict(self.default, protected=False),
                        dict(self.default, commit=dict(sha="6" * 40)), {}]:
            with self.assertRaises(m.Refused): self.remote(default=default)
        for feature in [dict(self.feature, protected=True),
                        dict(self.feature, name="main"),
                        dict(self.feature, name="release/x"),
                        dict(self.feature, commit=dict(sha="6" * 40)), {}]:
            with self.assertRaises(m.Refused): self.remote(feature=feature)
        for rules in [{}, [dict(type="required_status_checks")], "[]", False]:
            with self.assertRaises(m.Refused): self.remote(rules=rules)

    def test_postcondition_requires_authored_head_on_pr_and_feature(self):
        pr = copy.deepcopy(self.pr)
        feature = copy.deepcopy(self.feature)
        pr["head"]["sha"] = self.r["mergeHead"]
        feature["commit"]["sha"] = self.r["mergeHead"]
        m.validate_upstream_remote(self.r, self.repository, pr, self.default, feature, [], post=True)
        for changed_pr, changed_feature in [(self.pr, feature), (pr, self.feature)]:
            with self.assertRaises(m.Refused):
                m.validate_upstream_remote(self.r, self.repository, changed_pr, self.default,
                                           changed_feature, [], post=True)

    def test_existing_git_guards_apply_to_lexicon_merge(self):
        facts = dict(head=self.r["mergeHead"],
                     parents=[self.t["head"], self.r["mainHead"]],
                     tree=self.r["tree"], mainTree=self.r["tree"], indexTree=self.r["tree"],
                     trackedClean=True, extraFiles=[])
        m.validate_git(self.r, facts)
        for changes in [dict(parents=list(reversed(facts["parents"]))),
                        dict(parents=facts["parents"] + ["6" * 40]),
                        dict(tree="6" * 40), dict(trackedClean=False),
                        dict(extraFiles=["?? injected"])]:
            with self.assertRaises(m.Refused):
                m.validate_git(self.r, dict(facts, **changes))


class UpstreamLexiconJournalTests(unittest.TestCase):
    """Per-profile journals: lexicon tuples never share the plugin157 fence."""

    TUPLES = UpstreamLexiconTupleTests.TUPLES
    profile = "upstream-lexicon479"

    def setUp(self):
        UpstreamLexiconTupleTests.setUp(self)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.directory = self.root / "integrated-merge"
        self.directory.mkdir(mode=0o700)

    def plugin_receipt(self):
        return dict(schema=2, profile="upstream-original157", job="RQ-PLUGIN",
                    repo="ashlr-plugin", pr=157, headRepo="ashlrai/ashlr-plugin",
                    headRef="feat/read-range",
                    originalHead="0837489ab7bb6b8801884108f8932367d10f68b1",
                    mainHead="2" * 40, mergeHead="3" * 40, tree="4" * 40,
                    createdAt=1000, expiresAt=1600, evidenceSha256="5" * 64)

    def test_each_profile_gets_an_independent_attempt_file(self):
        for profile in ("upstream-lexicon479", "upstream-lexicon480"):
            t = UpstreamLexiconTupleTests.TUPLES[profile]
            r = dict(self.r, profile=profile, pr=t["pr"], headRef=t["ref"],
                     originalHead=t["head"])
            with self.subTest(profile=profile):
                self.assertRegex(m.journal_attempt(self.root, r), r"^CREATED [0-9a-f]{64}$")
                self.assertTrue((self.directory / (profile + ".attempt")).exists())
                self.assertEqual(m.journal_attempt(self.root, r), "EXISTING")
        plugin = self.plugin_receipt()
        self.assertRegex(m.journal_attempt(self.root, plugin), r"^CREATED [0-9a-f]{64}$")
        self.assertTrue((self.directory / "upstream-original157.attempt").exists())
        self.assertEqual(sorted(p.name for p in self.directory.iterdir() if p.suffix == ".attempt"),
                         ["upstream-lexicon479.attempt", "upstream-lexicon480.attempt",
                          "upstream-original157.attempt"])

    def test_lexicon_journal_rejects_foreign_or_changed_binding(self):
        m.journal_attempt(self.root, self.r)
        # Receipts that fail the closed tuple check never reach the journal.
        for changed in (dict(self.r, repo="ashlr-plugin"),
                        dict(self.r, headRef="feat/read-range"),
                        dict(self.r, profile="fork"),
                        dict(self.r, pr=480)):
            with self.subTest(changed=changed), self.assertRaises(m.Refused):
                m.journal_attempt(self.root, changed)
        # A valid second profile gets its own independent fence, not a collision.
        t480 = self.TUPLES["upstream-lexicon480"]
        other = dict(self.r, profile="upstream-lexicon480", pr=480,
                     headRef=t480["ref"], originalHead=t480["head"])
        self.assertRegex(m.journal_attempt(self.root, other), r"^CREATED ")
        self.assertTrue((self.directory / "upstream-lexicon480.attempt").exists())
        # A well-formed but tampered binding never grants another attempt.
        record = json.loads((self.directory / "upstream-lexicon479.attempt").read_text())
        record["originalHead"] = "9" * 40
        (self.directory / "upstream-lexicon479.attempt").write_text(json.dumps(record))
        with self.assertRaises((m.Refused, OSError, ValueError)):
            m.journal_attempt(self.root, self.r)


class UpstreamLexiconOutcomeTests(unittest.TestCase):
    """Queued/requested/merged observation for a lexicon tuple, mocked API only."""

    TUPLES = UpstreamLexiconTupleTests.TUPLES
    profile = "upstream-lexicon479"

    def setUp(self):
        UpstreamLexiconTupleTests.setUp(self)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.directory = self.root / "integrated-merge"
        self.directory.mkdir(mode=0o700)
        m.journal_attempt(self.root, self.r)

    def _fixtures(self):
        t = self.t
        pr = dict(mergeable=True, merge_commit_sha="6" * 40,
                  state="open", merged_at=None, number=t["pr"],
                  head=dict(repo=dict(id=1376859455, full_name="ashlrai/lexicon"),
                            ref=t["ref"], sha=self.r["mergeHead"]),
                  base=dict(repo=dict(id=1376859455, full_name="ashlrai/lexicon"), ref="main",
                            sha=self.r["mainHead"]),
                  auto_merge=None)
        feature = dict(name=t["ref"], protected=False,
                       commit=dict(sha=self.r["mergeHead"]))
        main = dict(name="main", protected=True, commit=dict(sha=self.r["mainHead"]))
        merge_sha = "6" * 40
        responses = {
            "repos/ashlrai/lexicon": self.repository,
            "repos/ashlrai/lexicon/pulls/" + str(t["pr"]): pr,
            "repos/ashlrai/lexicon/branches/main": main,
            "repos/ashlrai/lexicon/branches/" + t["api"]: feature,
            "repos/ashlrai/lexicon/git/commits/" + merge_sha:
                dict(sha=merge_sha, tree=dict(sha=self.r["tree"]),
                     parents=[dict(sha=self.r["mainHead"])]),
            "repos/ashlrai/lexicon/git/commits/" + self.r["mainHead"]:
                dict(sha=self.r["mainHead"], tree=dict(sha=self.r["tree"])),
            "repos/ashlrai/lexicon/compare/" + merge_sha + "..." + self.r["mainHead"]:
                dict(status="identical", base_commit=dict(sha=merge_sha),
                     merge_base_commit=dict(sha=merge_sha)),
        }
        responses["repos/ashlrai/lexicon/git/commits/" + self.r["mergeHead"]] = dict(
            sha=self.r["mergeHead"], tree=dict(sha=self.r["tree"]),
            parents=[dict(sha=self.r["originalHead"]), dict(sha=self.r["mainHead"])])
        node = dict(number=t["pr"], headRefOid=self.r["mergeHead"], mergeQueueEntry=None)

        class MockRuntime:
            def __init__(self, root, wt): pass
            def api(self, route): return copy.deepcopy(responses[route])
            def rules(self, route): return []
            def command(self, args):
                return json.dumps(dict(data=dict(repository=dict(pullRequest=node))))
        MockRuntime.responses = responses
        return pr, feature, main, merge_sha, node, MockRuntime

    def test_expected_head_queued_requested_held_merged(self):
        pr, feature, main, merge_sha, node, MockRuntime = self._fixtures()
        t = self.t
        with patch.object(m, "verify", return_value=self.r), \
             patch.object(m, "admission", return_value=self.r), \
             patch.object(m, "Runtime", MockRuntime):
            self.assertEqual(m.outcome(self.root, self.r["job"], self.r["mainHead"], "wt"), "READY")
            pr["auto_merge"] = {"merge_method": "merge", "enabled_by": {"login": "operator"}}
            self.assertEqual(m.outcome(self.root, self.r["job"], self.r["mainHead"], "wt"), "REQUESTED")
            node["mergeQueueEntry"] = {"id": "queue-entry"}
            self.assertEqual(m.outcome(self.root, self.r["job"], self.r["mainHead"], "wt"), "QUEUED")
            node["headRefOid"] = "9" * 40
            with self.assertRaises(m.Refused):
                m.outcome(self.root, self.r["job"], self.r["mainHead"], "wt")
            node["headRefOid"] = self.r["mergeHead"]
            pr.update(state="closed", merged_at="2026-11-07T00:00:00Z",
                      merge_commit_sha=merge_sha)
            main["commit"]["sha"] = merge_sha
            MockRuntime.responses["repos/ashlrai/lexicon/compare/" + merge_sha + "..." + merge_sha] = dict(
                status="identical", base_commit=dict(sha=merge_sha), merge_base_commit=dict(sha=merge_sha))
            self.assertEqual(m.outcome(self.root, self.r["job"], self.r["mainHead"], "wt"), "MERGED")

    def test_lexicon_push_uses_closed_lease_argv(self):
        # The launch token is only returned at attempt time; use a fresh root.
        self.temp2 = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp2.cleanup)
        root2 = Path(self.temp2.name)
        (root2 / "integrated-merge").mkdir(mode=0o700)
        token = m.journal_attempt(root2, self.r).split()[1]
        calls = []

        class CaptureRuntime:
            def __init__(self, root, wt):
                self.gs = Path(root) / "bin/git-safe-env.sh"
            def command(self, args):
                calls.append(args)
                return ""
        with patch.object(m, "verify", return_value=self.r), \
             patch.object(m, "Runtime", CaptureRuntime):
            m.push(root2, self.r["job"], self.r["mainHead"], "wt", token)
        script = calls[0][calls[0].index("-c") + 1]
        self.assertIn('push --force-with-lease=refs/heads/' + self.t["ref"] + ":" + self.t["head"]
                      + " https://github.com/ashlrai/lexicon.git", script)
        self.assertIn('"$3:refs/heads/' + self.t["ref"] + '"', script)
        self.assertEqual(script.count("gs_git"), 1)

    def test_outcome_rejects_replaced_repository_identity(self):
        pr, feature, main, merge_sha, node, MockRuntime = self._fixtures()
        for location in ("repository", "head", "base"):
            target = self.repository if location == "repository" else pr[location]["repo"]
            target["id"] = 1
            with self.subTest(location=location), patch.object(m, "verify", return_value=self.r), \
                 patch.object(m, "Runtime", MockRuntime), self.assertRaises(m.Refused):
                m.outcome(self.root, self.r["job"], self.r["mainHead"], "wt")
            target["id"] = 1376859455

    def test_terminal_squash_requires_ordered_join_and_exact_reviewed_parent(self):
        pr, feature, main, merge_sha, node, MockRuntime = self._fixtures()
        runtime = MockRuntime(None, None)
        responses = MockRuntime.responses
        joined_route = "repos/ashlrai/lexicon/git/commits/" + self.r["mergeHead"]
        merged_route = "repos/ashlrai/lexicon/git/commits/" + merge_sha
        saved = copy.deepcopy(responses)
        check = lambda: m.validate_terminal_lexicon_join(runtime, "repos/ashlrai/lexicon", self.r,
                                m.UPSTREAM_TUPLES[self.profile], responses[merged_route])
        check()
        variants = [
            (merged_route, "parents", []),
            (merged_route, "parents", [dict(sha=self.r["mainHead"]), dict(sha=self.r["mergeHead"])]),
            (merged_route, "parents", [dict(sha="9" * 40)]),
            (joined_route, "parents", list(reversed(saved[joined_route]["parents"]))),
            (joined_route, "parents", [dict(sha=self.r["mainHead"])]),
            (joined_route, "tree", dict(sha="9" * 40)),
            (joined_route, "sha", "9" * 40),
        ]
        for route, field, value in variants:
            responses.clear(); responses.update(copy.deepcopy(saved)); responses[route][field] = value
            with self.subTest(route=route, field=field), self.assertRaises(m.Refused): check()
        responses.clear(); responses.update(saved)
        check()

    def test_squash_terminal_outer_observations_remain_bound(self):
        pr, feature, main, merge_sha, node, MockRuntime = self._fixtures()
        pr.update(state="closed", merged_at="2026-11-07T00:00:00Z", merge_commit_sha=merge_sha)
        main["commit"]["sha"] = merge_sha
        responses = MockRuntime.responses
        comparison = "repos/ashlrai/lexicon/compare/" + merge_sha + "..." + merge_sha
        responses[comparison] = dict(status="identical", base_commit=dict(sha=merge_sha),
                                     merge_base_commit=dict(sha=merge_sha))
        saved = copy.deepcopy(responses)
        with patch.object(m, "verify", return_value=self.r), patch.object(m, "Runtime", MockRuntime):
            check = lambda: m.outcome(self.root, self.r["job"], self.r["mainHead"], "wt")
            self.assertEqual(check(), "MERGED")
            variants = [
                ("repos/ashlrai/lexicon", "id", True),
                ("repos/ashlrai/lexicon", "id", 1376859455.0),
                ("repos/ashlrai/lexicon/pulls/479", "number", 480),
                ("repos/ashlrai/lexicon/pulls/479", "merged_at", None),
                ("repos/ashlrai/lexicon/pulls/479", "head", dict(repo=self.repository, ref=self.t["ref"], sha="9"*40)),
                ("repos/ashlrai/lexicon/branches/" + self.t["api"], "commit", dict(sha="9"*40)),
                ("repos/ashlrai/lexicon/branches/main", "protected", False),
                ("repos/ashlrai/lexicon/git/commits/" + merge_sha, "sha", "9"*40),
                ("repos/ashlrai/lexicon/git/commits/" + merge_sha, "tree", dict(sha="9"*40)),
                (comparison, "status", "diverged"),
                (comparison, "base_commit", dict(sha="9"*40)),
                (comparison, "merge_base_commit", dict(sha="9"*40)),
            ]
            for route, field, value in variants:
                responses.clear(); responses.update(copy.deepcopy(saved)); responses[route][field] = value
                with self.subTest(route=route, field=field), self.assertRaises(m.Refused): check()
            responses.clear(); responses.update(copy.deepcopy(saved))
            # A later same-tree main is allowed only with the existing S→main proof.
            later = "7"*40
            responses["repos/ashlrai/lexicon/branches/main"]["commit"]["sha"] = later
            responses["repos/ashlrai/lexicon/git/commits/"+later] = dict(sha=later, tree=dict(sha=self.r["tree"]))
            responses["repos/ashlrai/lexicon/compare/"+merge_sha+"..."+later] = dict(
                status="ahead", base_commit=dict(sha=merge_sha), merge_base_commit=dict(sha=merge_sha))
            self.assertEqual(check(), "MERGED")


class RefRecoveryProfiles:
    """Shared fixtures for the CREATE-only Lexicon ref recovery operator."""

    @staticmethod
    def sha_for(pr):
        return {479: "3b7c93ff552d3fa7a5b835a416c238c37be78cdd",
                480: "f6975814f2ae2b562c81c57e50c5ecdeb05627d6"}[pr]

    @staticmethod
    def ref_for(pr):
        return {479: "dependabot/github_actions/actions/download-artifact-8",
                480: "dependabot/github_actions/actions/cache-6"}[pr]


class RecoveryRuntime:
    """Fully fake GitHub for recovery tests; every call is local state."""

    def __init__(self, root, wt=None):
        self.calls = []
        self.posts = []
        self.repo = dict(id=1376859455, node_id="R_kgDOUhE1Pw",
                         full_name="ashlrai/lexicon", default_branch="main",
                         archived=False, disabled=False,
                         permissions={"admin": True, "push": True})
        self.prs = {}
        for pr in (479, 480):
            self.prs[pr] = dict(
                number=pr, state="closed", merged_at=None,
                head=dict(repo=dict(id=1376859455, full_name="ashlrai/lexicon"),
                          ref=RefRecoveryProfiles.ref_for(pr),
                          sha=RefRecoveryProfiles.sha_for(pr)),
                base=dict(repo=dict(id=1376859455, full_name="ashlrai/lexicon"), ref="main"))
        self.commits = {sha: dict(sha=sha, tree=dict(sha="e" * 40),
                                  parents=[dict(sha="1" * 40)])
                        for sha in (RefRecoveryProfiles.sha_for(479),
                                    RefRecoveryProfiles.sha_for(480))}
        self.refs = {}
        self.rulesets = [dict(id=25861611, name="Release tags require Mason",
                              target="tag", source_type="Repository",
                              enforcement="disabled"),
                         dict(id=26000075, name="ashlr-fleet: default branch merge queue",
                              target="branch", source_type="Repository",
                              enforcement="active")]
        self.branch_rules = {}
        self.post_status = 201
        self.post_body = None
        self.post_raise = False
        self.post_effect = None
        self.graphql_repo = dict(
            defaultBranchRef=dict(name="main"),
            branchProtectionRules=dict(nodes=[dict(pattern="main")],
                                       pageInfo=dict(hasNextPage=False)))
        self.graphql_errors = None
        self.status_overrides = {}
        self.raise_routes = set()

    def api_http(self, route, fields=None):
        self.calls.append(route)
        if route in self.raise_routes:
            raise m.Refused("simulated transport loss")
        if route in self.status_overrides:
            return 0, self.status_overrides[route], None
        if fields is not None:
            self.posts.append((route, fields))
            if self.post_raise:
                raise m.Refused("simulated ambiguous transport")
            status = self.post_status
            body = self.post_body
            if status == 201:
                ref = dict(fields)["ref"]
                sha = dict(fields)["sha"]
                self.refs[ref] = {"ref": ref,
                                  "object": {"sha": sha, "type": "commit"}}
                if body is None:
                    body = {"ref": ref, "object": {"sha": sha, "type": "commit"}}
            if self.post_effect is not None:
                self.post_effect(status)
            return 0, status, copy.deepcopy(body)
        api = "repos/ashlrai/lexicon"
        if route == api:
            return 0, 200, copy.deepcopy(self.repo)
        if route.startswith(api + "/pulls/"):
            pr = self.prs.get(int(route.rsplit("/", 1)[-1]))
            return (0, 200, copy.deepcopy(pr)) if pr else (0, 404, {"message": "Not Found"})
        if route.startswith(api + "/git/commits/"):
            sha = route.rsplit("/", 1)[-1]
            commit = self.commits.get(sha)
            return (0, 200, copy.deepcopy(commit)) if commit else (0, 404, {})
        if route.startswith(api + "/git/ref/"):
            ref = "refs/" + route.rsplit("git/ref/", 1)[-1]
            body = self.refs.get(ref)
            return (0, 200, copy.deepcopy(body)) if body else (0, 404, {"message": "Not Found"})
        if route == api + "/rulesets":
            return 0, 200, copy.deepcopy(self.rulesets)
        if route.startswith(api + "/rules/branches/"):
            encoded = route.rsplit("/", 1)[-1]
            rules = self.branch_rules.get(encoded, [])
            return 0, 200, copy.deepcopy(rules)
        return 0, 404, {"message": "unmocked route"}

    def command(self, args):
        if self.graphql_errors is not None:
            return json.dumps({"errors": self.graphql_errors})
        return json.dumps({"data": {"repository": copy.deepcopy(self.graphql_repo)}})


class RefRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.directory = self.root / "integrated-merge"
        self.directory.mkdir(mode=0o700)
        self.runtime = RecoveryRuntime(self.root)
        self.patcher = patch.object(m, "Runtime", lambda *a, **k: self.runtime)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def recover(self, name="lexicon-ref-479"):
        return m.recover_ref(self.root, name)

    def test_only_two_closed_profiles_accepted(self):
        self.assertEqual(set(m.REF_RECOVERY_PROFILES), {"lexicon-ref-479", "lexicon-ref-480"})
        for name in ("lexicon-ref-481", "upstream-original157", "lexicon-ref-479 ", "", "LEXICON-REF-479"):
            with self.subTest(name=name), self.assertRaises(m.Refused):
                self.recover(name)
        self.assertFalse((self.directory / "lexicon-ref-479.attempt").exists())
        self.assertEqual(self.runtime.posts, [])

    def test_recovery_requires_primitive_repository_ids_before_write_and_on_reconcile(self):
        for name in ("lexicon-ref-479", "lexicon-ref-480"):
            p = m.REF_RECOVERY_PROFILES[name]
            for location in ("repository", "head", "base"):
                for wrong in (None, True, False, 1, 1376859455.0, "1376859455"):
                    runtime = RecoveryRuntime(self.root)
                    target = runtime.repo if location == "repository" else runtime.prs[p["pr"]][location]["repo"]
                    if wrong is None: target.pop("id")
                    else: target["id"] = wrong
                    with self.subTest(name=name, location=location, wrong=wrong), self.assertRaises(m.Refused):
                        m.recover_preflight(runtime, p)
                    runtime.refs[p["gitRef"]] = p["sha"]
                    self.assertTrue(m._recover_observe(runtime, p).startswith("HELD"))
                    self.assertEqual(runtime.posts, [])
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_created_verified_then_observed_never_second_post(self):
        result = self.recover()
        self.assertTrue(result.startswith("RESTORED "), result)
        self.assertIn("refs/heads/dependabot/github_actions/actions/download-artifact-8", result)
        self.assertIn("3b7c93ff552d3fa7a5b835a416c238c37be78cdd", result)
        self.assertEqual(len(self.runtime.posts), 1)
        route, fields = self.runtime.posts[0]
        self.assertEqual(route, "repos/ashlrai/lexicon/git/refs")
        self.assertEqual(fields, (("ref", "refs/heads/dependabot/github_actions/actions/download-artifact-8"),
                                  ("sha", "3b7c93ff552d3fa7a5b835a416c238c37be78cdd")))
        record = json.loads((self.directory / "lexicon-ref-479.attempt").read_text())
        self.assertEqual(record["state"], "RESTORED")
        self.assertEqual(record["repoId"], 1376859455)
        self.assertEqual(record["pr"], 479)
        again = self.recover()
        self.assertTrue(again.startswith("OBSERVED "), again)
        self.assertEqual(len(self.runtime.posts), 1)

    def test_both_profiles_write_their_exact_tuple(self):
        self.assertTrue(self.recover("lexicon-ref-480").startswith("RESTORED "))
        self.assertTrue(self.recover("lexicon-ref-479").startswith("RESTORED "))
        self.assertEqual(len(self.runtime.posts), 2)
        refs = sorted(dict(fields)["ref"] for _, fields in self.runtime.posts)
        self.assertEqual(refs, ["refs/heads/dependabot/github_actions/actions/cache-6",
                                "refs/heads/dependabot/github_actions/actions/download-artifact-8"])

    def test_preflight_refusals_leave_no_journal_and_no_post(self):
        cases = []
        # repository identity
        for mutate in (lambda r: r.update(id=1), lambda r: r.update(full_name="other/lexicon"),
                       lambda r: r.update(default_branch="trunk"),
                       lambda r: r.update(archived=True), lambda r: r.update(disabled=True),
                       lambda r: r.pop("id")):
            cases.append(("repo", mutate))
        # PR tuple
        for mutate in (lambda p: p.update(state="open"), lambda p: p.update(merged_at="today"),
                       lambda p: p.update(number=480),
                       lambda p: p["head"].update(ref="main"),
                       lambda p: p["head"].update(sha="1" * 40),
                       lambda p: p["head"].update(repo=dict(full_name="other/lexicon")),
                       lambda p: p["head"].update(repo=None),
                       lambda p: p["base"].update(ref="release"),
                       lambda p: p["base"].update(repo=dict(full_name="other/lexicon"))):
            cases.append(("pr", mutate))
        # commit proof
        cases += [("commit", lambda c: c.update(sha="1" * 40)),
                  ("commit", lambda c: c.pop("tree")),
                  ("commit", lambda c: c.update(parents="x")),
                  ("commit", "missing")]
        # protection proofs
        cases += [("graphql", "hasNextPage"), ("graphql", "two-nodes"),
                  ("graphql", "wildcard"), ("graphql", "errors"),
                  ("graphql", "default-ref"), ("rulesets", "denied"),
                  ("rulesets", "not-list"), ("rules", "denied"),
                  ("rules", "nonempty"), ("rules", "not-list")]
        # ref absence
        cases += [("ref", "exists-same"), ("ref", "exists-other"), ("ref", "denied"), ("ref", "error")]
        for kind, mutate in cases:
            with self.subTest(kind=kind, mutate=mutate):
                saved = self._snapshot()
                self._apply(kind, mutate)
                with self.assertRaises(m.Refused):
                    self.recover()
                self._restore(saved)
                self.assertFalse((self.directory / "lexicon-ref-479.attempt").exists())
                self.assertEqual(self.runtime.posts, [])

    def _snapshot(self):
        import copy as _c
        return _c.deepcopy((self.runtime.repo, self.runtime.prs, self.runtime.commits,
                            self.runtime.refs, self.runtime.rulesets,
                            self.runtime.branch_rules, self.runtime.graphql_repo,
                            self.runtime.graphql_errors, self.runtime.status_overrides,
                            self.runtime.raise_routes))

    def _restore(self, saved):
        (self.runtime.repo, self.runtime.prs, self.runtime.commits, self.runtime.refs,
         self.runtime.rulesets, self.runtime.branch_rules, self.runtime.graphql_repo,
         self.runtime.graphql_errors, self.runtime.status_overrides,
         self.runtime.raise_routes) = saved

    def _apply(self, kind, mutate):
        rt = self.runtime
        p = m.REF_RECOVERY_PROFILES["lexicon-ref-479"]
        if kind == "repo":
            mutate(rt.repo)
        elif kind == "pr":
            mutate(rt.prs[479])
        elif kind == "commit":
            if mutate == "missing":
                rt.commits.pop(p["sha"], None)
            else:
                mutate(rt.commits[p["sha"]])
        elif kind == "graphql":
            if mutate == "hasNextPage":
                rt.graphql_repo["branchProtectionRules"]["pageInfo"]["hasNextPage"] = True
            elif mutate == "two-nodes":
                rt.graphql_repo["branchProtectionRules"]["nodes"].append(dict(pattern="main"))
            elif mutate == "wildcard":
                rt.graphql_repo["branchProtectionRules"]["nodes"] = [dict(pattern="dependabot/*")]
            elif mutate == "errors":
                rt.graphql_errors = [{"message": "denied"}]
            elif mutate == "default-ref":
                rt.graphql_repo["defaultBranchRef"] = dict(name="trunk")
        elif kind == "rulesets":
            route = "repos/ashlrai/lexicon/rulesets"
            if mutate == "denied":
                rt.status_overrides[route] = 403
            else:
                rt.rulesets = {"not": "a list"}
        elif kind == "rules":
            route = "repos/ashlrai/lexicon/rules/branches/" + p["branchApi"]
            if mutate == "denied":
                rt.status_overrides[route] = 403
            elif mutate == "nonempty":
                rt.branch_rules[p["branchApi"]] = [dict(type="deletion")]
            else:
                rt.branch_rules[p["branchApi"]] = "not-a-list"
        elif kind == "ref":
            route = "repos/ashlrai/lexicon/git/ref/" + p["gitRef"][len("refs/"):]
            if mutate == "exists-same":
                rt.refs[p["gitRef"]] = {"ref": p["gitRef"],
                                        "object": {"sha": p["sha"], "type": "commit"}}
            elif mutate == "exists-other":
                rt.refs[p["gitRef"]] = {"ref": p["gitRef"],
                                        "object": {"sha": "9" * 40, "type": "commit"}}
            elif mutate == "denied":
                rt.status_overrides[route] = 403
            else:
                rt.status_overrides[route] = 500

    def test_post_conflicts_reconcile_without_overwrite_or_retry(self):
        p = m.REF_RECOVERY_PROFILES["lexicon-ref-479"]
        attempt = self.directory / "lexicon-ref-479.attempt"
        for status, ref_state, want in [
                (409, "same", "OBSERVED"), (409, "other", "HELD ref-conflict"),
                (422, "absent", "HELD attempt-unconfirmed"),
                (403, "absent", "HELD attempt-unconfirmed")]:
            with self.subTest(status=status, ref_state=ref_state):
                rt = self.runtime
                rt.post_status = status
                rt.post_body = {"message": "conflict"}
                rt.refs.clear()
                rt.posts.clear()
                rt.post_effect = None
                for f in self.directory.iterdir():
                    f.unlink()
                if ref_state == "same":
                    # A racing creator lands the exact ref after our POST fails.
                    rt.post_effect = lambda s: rt.refs.__setitem__(
                        p["gitRef"], {"ref": p["gitRef"],
                                      "object": {"sha": p["sha"], "type": "commit"}})
                elif ref_state == "other":
                    rt.post_effect = lambda s: rt.refs.__setitem__(
                        p["gitRef"], {"ref": p["gitRef"],
                                      "object": {"sha": "9" * 40, "type": "commit"}})
                result = self.recover()
                self.assertTrue(result.startswith(want), (status, ref_state, result))
                self.assertEqual(len(rt.posts), 1)
                record = json.loads(attempt.read_text())
                self.assertEqual(record["state"], "OBSERVED" if want == "OBSERVED" else "HELD")
                # ABA: the ref disappears again; reconciliation stays read-only.
                rt.refs.pop(p["gitRef"], None)
                rt.post_effect = None
                again = self.recover()
                self.assertTrue(again.startswith("HELD"), again)
                self.assertEqual(len(rt.posts), 1)

    def test_ambiguous_transport_reconciles_and_never_retries(self):
        p = m.REF_RECOVERY_PROFILES["lexicon-ref-479"]
        rt = self.runtime
        original = rt.api_http

        def lossy(route, fields=None):
            if fields is not None:
                rt.posts.append((route, fields))
                # The write landed server-side despite the lost response.
                rt.refs[p["gitRef"]] = {"ref": p["gitRef"],
                                        "object": {"sha": p["sha"], "type": "commit"}}
                raise m.Refused("simulated ambiguous transport")
            return original(route, fields)
        rt.api_http = lossy
        result = self.recover()
        self.assertTrue(result.startswith("OBSERVED "), result)
        self.assertEqual(len(rt.posts), 1)
        record = json.loads((self.directory / "lexicon-ref-479.attempt").read_text())
        self.assertEqual(record["state"], "OBSERVED")
        self.assertTrue(self.recover().startswith("OBSERVED "))
        self.assertEqual(len(rt.posts), 1)

    def test_crash_after_journal_before_write_is_readonly_forever(self):
        p = m.REF_RECOVERY_PROFILES["lexicon-ref-479"]
        proof = m.recover_preflight(self.runtime, p)
        proof_sha = hashlib.sha256(json.dumps(proof, sort_keys=True,
                            separators=(",", ":")).encode()).hexdigest()
        self.assertRegex(m.recover_journal_attempt(self.root, p, proof_sha), r"^CREATED ")
        # Process "died" here: journal exists, no POST ever sent.
        result = self.recover()
        self.assertTrue(result.startswith("HELD attempt-unconfirmed"), result)
        self.assertEqual(self.runtime.posts, [])
        record = json.loads((self.directory / "lexicon-ref-479.attempt").read_text())
        self.assertEqual(record["state"], "HELD")
        # Even with the ref absent again, no second attempt is ever issued.
        self.assertTrue(self.recover().startswith("HELD"))
        self.assertEqual(self.runtime.posts, [])

    def test_aba_removal_after_attempt_never_retries(self):
        result = self.recover()
        self.assertTrue(result.startswith("RESTORED "), result)
        p = m.REF_RECOVERY_PROFILES["lexicon-ref-479"]
        self.runtime.refs.pop(p["gitRef"])
        again = self.recover()
        self.assertTrue(again.startswith("HELD attempt-unconfirmed"), again)
        self.assertEqual(len(self.runtime.posts), 1)

    def test_unsafe_foreign_duplicate_and_changed_journal_refused(self):
        p = m.REF_RECOVERY_PROFILES["lexicon-ref-479"]
        proof = m.recover_preflight(self.runtime, p)
        proof_sha = hashlib.sha256(json.dumps(proof, sort_keys=True,
                            separators=(",", ":")).encode()).hexdigest()
        attempt = self.directory / "lexicon-ref-479.attempt"
        for kind in ("bad-json", "symlink", "hardlink", "mode", "oversized", "foreign"):
            with self.subTest(kind=kind):
                if kind == "symlink":
                    target = self.root / "target"
                    target.write_text("{}")
                    attempt.symlink_to(target)
                else:
                    if kind == "bad-json":
                        attempt.write_text("{")
                    elif kind == "oversized":
                        attempt.write_text("x" * 20000)
                    elif kind == "foreign":
                        attempt.write_text(json.dumps({"state": "ATTEMPTED"}))
                    else:
                        attempt.write_text("x")
                    attempt.chmod(0o644 if kind == "mode" else 0o600)
                    if kind == "hardlink":
                        os.link(attempt, self.root / "linked")
                with self.assertRaises((m.Refused, OSError, ValueError)):
                    self.recover()
                self.assertEqual(self.runtime.posts, [])
                for f in (attempt, self.root / "linked", self.root / "target"):
                    if f.exists() or f.is_symlink():
                        f.unlink()
        # A well-formed but tampered binding never grants another write.
        m.recover_journal_attempt(self.root, p, proof_sha)
        record = json.loads(attempt.read_text())
        record["sha"] = "9" * 40
        attempt.write_text(json.dumps(record))
        with self.assertRaises((m.Refused, OSError, ValueError)):
            self.recover()
        self.assertEqual(self.runtime.posts, [])

    def test_inexact_201_response_is_not_restored(self):
        p = m.REF_RECOVERY_PROFILES["lexicon-ref-479"]
        bodies = ({"ref": "refs/heads/other",
                   "object": {"sha": p["sha"], "type": "commit"}},
                  {"ref": p["gitRef"], "object": {"sha": "9" * 40, "type": "commit"}},
                  {"ref": p["gitRef"], "object": {"sha": p["sha"], "type": "tag"}},
                  ["not", "a", "dict"], "")
        for body in bodies:
            with self.subTest(body=body):
                # Fresh journal and remote state per case; the fake still lands
                # the ref, so reconciliation can only report OBSERVED, never RESTORED.
                for f in self.directory.iterdir():
                    f.unlink()
                self.runtime.post_status = 201
                self.runtime.post_body = body
                self.runtime.refs.clear()
                self.runtime.posts.clear()
                result = self.recover()
                self.assertFalse(result.startswith("RESTORED"), (body, result))
                record = json.loads(
                    (self.directory / "lexicon-ref-479.attempt").read_text())
                self.assertIn(record["state"], ("OBSERVED", "HELD"))
                self.assertEqual(len(self.runtime.posts), 1)

    def test_second_profile_does_not_disturb_first_journal(self):
        self.assertTrue(self.recover("lexicon-ref-479").startswith("RESTORED "))
        self.assertTrue(self.recover("lexicon-ref-480").startswith("RESTORED "))
        r479 = json.loads((self.directory / "lexicon-ref-479.attempt").read_text())
        r480 = json.loads((self.directory / "lexicon-ref-480.attempt").read_text())
        self.assertEqual((r479["state"], r479["pr"]), ("RESTORED", 479))
        self.assertEqual((r480["state"], r480["pr"]), ("RESTORED", 480))
        self.assertNotEqual(r479["requestSha256"], r480["requestSha256"])


class LexiconExactLeaseLocalGitTests(IntegratedRealGitTests):
    """Real local Git lease races for the two nested Lexicon dependabot refs."""

    REFS = {
        "upstream-lexicon479": ("dependabot/github_actions/actions/download-artifact-8",
                                "3b7c93ff552d3fa7a5b835a416c238c37be78cdd"),
        "upstream-lexicon480": ("dependabot/github_actions/actions/cache-6",
                                "f6975814f2ae2b562c81c57e50c5ecdeb05627d6"),
    }

    def test_exact_lease_accepts_original_and_rejects_advance_and_rewind(self):
        for profile, (refname, original) in self.REFS.items():
            with self.subTest(profile=profile):
                bare = self.root / ("remote-" + profile + ".git")
                subprocess.run(["git", "init", "--bare", "-q", str(bare)], env=self.env,
                               check=True, capture_output=True, timeout=10)
                ref = "refs/heads/" + refname
                def set_remote(sha):
                    subprocess.run(["git", "--git-dir", str(bare), "update-ref", ref, sha],
                                   env=self.env, check=True, capture_output=True, timeout=10)
                # Populate objects, then hold the remote at the profile original.
                self.git("push", "-q", str(bare), self.original + ":" + ref)
                set_remote(self.original)
                lease = "--force-with-lease=" + ref + ":" + self.original
                # The compiled profile SHA is not the remote's value: exact CAS refuses.
                compiled = "--force-with-lease=" + ref + ":" + original
                result = self.git("push", compiled, str(bare), self.merge + ":" + ref,
                                  check=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.git("ls-remote", str(bare), ref).split()[0],
                                 self.original)
                result = self.git("push", lease, str(bare), self.merge + ":" + ref,
                                  check=False)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.git("ls-remote", str(bare), ref).split()[0], self.merge)
                self.assertEqual(self.git("merge-base", self.original, self.merge),
                                 self.original)
                advance = self.git("commit-tree", self.tree, "-p", self.merge,
                                   "-m", "advance")
                self.git("push", "-q", str(bare), advance + ":refs/heads/fixture")
                for actual in (advance, self.base):
                    with self.subTest(actual=actual):
                        set_remote(actual)
                        result = self.git("push", lease, str(bare), self.merge + ":" + ref,
                                          check=False)
                        self.assertNotEqual(result.returncode, 0, result.stderr)
                        self.assertEqual(self.git("ls-remote", str(bare), ref).split()[0],
                                         actual)

    def test_nested_ref_name_round_trips_and_cannot_be_extended(self):
        for profile, (refname, _) in self.REFS.items():
            with self.subTest(profile=profile):
                bare = self.root / ("remote-nested-" + profile + ".git")
                subprocess.run(["git", "init", "--bare", "-q", str(bare)], env=self.env,
                               check=True, capture_output=True, timeout=10)
                ref = "refs/heads/" + refname
                self.git("push", "-q", str(bare), self.original + ":" + ref)
                self.assertEqual(
                    self.git("ls-remote", str(bare), ref).split()[0], self.original)
                # Git ref D/F rules: nothing can be created beneath the exact ref.
                result = self.git("push", "-q", str(bare),
                                  self.merge + ":" + ref + "/extra", check=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.git("ls-remote", str(bare), ref).split()[0],
                                 self.original)
                # A sibling prefix-similar name is a different ref entirely.
                sibling = "refs/heads/" + refname + "-x"
                self.git("push", "-q", str(bare), self.merge + ":" + sibling)
                self.assertEqual(self.git("ls-remote", str(bare), ref).split()[0],
                                 self.original)
                self.assertEqual(self.git("ls-remote", str(bare), sibling).split()[0],
                                 self.merge)


if __name__ == "__main__":
    unittest.main()
