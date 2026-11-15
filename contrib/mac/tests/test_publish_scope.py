"""RQ-PUBLISH-WORKTREE-SCOPE-1: publish.sh must stage only the job's change set, never ambient worktree state."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SOURCE = (Path(__file__).resolve().parents[1] / "publish.sh").read_text()
BLOCK = SOURCE.split("# >>> SCOPED_STAGE\n", 1)[1].split("# <<< SCOPED_STAGE", 1)[0]


class ScopedStageTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.runs = self.root / "runs"
        self.runs.mkdir()
        self.env = dict(os.environ, HOME=str(self.root), GIT_CONFIG_GLOBAL=os.devnull,
                        GIT_CONFIG_NOSYSTEM="1", GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@e",
                        GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@e", TMPDIR=str(self.root))
        self.git = shutil.which("git")
        self.g("init", "-q")
        self.w("src/a.ts", "a\n"); self.w("src/exec.ts", "exec\n"); self.w("src/fleet.ts", "fleet\n")
        self.g("add", "-A"); self.g("commit", "-qm", "base0")
        self.base0 = self.head()

    def g(self, *a):
        return subprocess.run([self.git, *a], cwd=self.repo, env=self.env, check=True,
                              capture_output=True, text=True, timeout=20).stdout

    def w(self, rel, text):
        p = self.repo / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)

    def head(self):
        return self.g("rev-parse", "HEAD").strip()

    def stage(self, base, mb, manifest=None):
        if manifest is not None:
            (self.runs / "J.files").write_text(manifest)
        script = f'git(){{ command git "$@"; }}\nR={self.runs}; J=J; BASE={base}; MB={mb}\n{BLOCK}\nscoped_stage'
        return subprocess.run(["/bin/bash", "-c", script], cwd=self.repo, env=self.env,
                              capture_output=True, text=True, timeout=30)

    def staged(self):
        return sorted(self.g("diff", "--cached", "--name-only", "HEAD").split())

    def test_only_job_files_staged_amid_ambient_dirt(self):
        self.w("src/a.ts", "job edit\n")           # job's change
        self.w("src/new.ts", "job new\n")          # job's new file
        self.w("src/fleet.ts", "other job leak\n")  # tracked edit — in change set without manifest
        for junk in ("src/a.ts.backup", "fix.patch", "x.orig", "y.rej", "z~", ".DS_Store", "d/n.bak"):
            self.w(junk, "scratch\n")
        r = self.stage(self.base0, self.base0)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.staged(), ["src/a.ts", "src/fleet.ts", "src/new.ts"])
        self.assertIn("SCOPE_EXCLUDED", r.stdout)

    def test_manifest_is_authoritative_over_ambient_state(self):
        self.w("src/a.ts", "job edit\n"); self.w("src/new.ts", "job new\n")
        self.w("src/fleet.ts", "other job leak\n"); self.w("scratch.patch", "p\n")
        (self.repo / "src/exec.ts").unlink()       # ambient deletion must not be committed
        r = self.stage(self.base0, self.base0, manifest="src/a.ts\n./src/new.ts\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.staged(), ["src/a.ts", "src/new.ts"])
        self.assertIn("src/exec.ts", r.stdout)

    def test_manifest_can_include_listed_deletion_and_scratch_shaped_file(self):
        (self.repo / "src/exec.ts").unlink(); self.w("fixtures/x.patch", "keep\n")
        r = self.stage(self.base0, self.base0, manifest="src/exec.ts\nfixtures/x.patch\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.staged(), ["fixtures/x.patch", "src/exec.ts"])

    def test_stale_fork_point_does_not_revert_main(self):
        # job forked at base0; main then advanced (touches exec.ts + adds files) -> BASE = base1
        self.w("src/exec.ts", "exec v2\n"); self.w("src/newmain.ts", "m\n")
        self.g("add", "-A"); self.g("commit", "-qm", "main moves")
        base1 = self.head()
        self.g("checkout", "-q", "-b", "job", self.base0)
        self.w("src/a.ts", "job edit\n"); self.g("commit", "-qam", "job commit")
        self.g("reset", "-q", "--soft", base1)     # what publish.sh does before staging
        r = self.stage(base1, self.base0)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.staged(), ["src/a.ts"])
        self.assertEqual(self.g("show", ":src/exec.ts"), "exec v2\n")
        self.assertTrue(self.g("show", ":src/newmain.ts"))

    def test_stale_index_is_reset(self):
        self.w("src/fleet.ts", "stale staged\n"); self.g("add", "src/fleet.ts")
        self.w("src/a.ts", "job\n")
        r = self.stage(self.base0, self.base0, manifest="src/a.ts\n")
        self.assertEqual(self.staged(), ["src/a.ts"])

    def test_bad_manifest_aborts_and_glob_names_are_literal(self):
        self.w("src/a.ts", "x\n")
        for bad in ("/etc/passwd\n", "../x\n", "a/../b\n"):
            r = self.stage(self.base0, self.base0, manifest=bad)
            self.assertIn("scope-manifest-invalid", r.stdout)
            self.assertNotEqual(r.returncode, 0)
        self.w("*.ts", "star\n"); self.w("src/b.ts", "b\n")
        r = self.stage(self.base0, self.base0, manifest="*.ts\n")
        self.assertEqual(self.staged(), ["*.ts"])

    def test_publisher_wiring(self):
        last_add = SOURCE.index("if [ \"$IM\" = 1 ]; then git add -A; else scoped_stage")
        self.assertLess(last_add, SOURCE.index("verify_dependency_links ||", last_add))
        self.assertLess(SOURCE.index("MB=$(git merge-base"), SOURCE.index("git reset --soft \"$BASE\""))
        # no unscoped whole-worktree staging outside the closed integrated-merge mode
        self.assertNotIn("\ngit add -A\n", SOURCE)


if __name__ == "__main__":
    unittest.main()
