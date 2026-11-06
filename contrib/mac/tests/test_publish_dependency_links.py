"""Exercise the actual publisher guard against real staged Git entries."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


PUBLISHER = Path(__file__).resolve().parents[1] / "publish.sh"
SOURCE = PUBLISHER.read_text()
GUARD = SOURCE.split("# >>> DEPENDENCY_LINK_GUARD\n", 1)[1].split(
    "# <<< DEPENDENCY_LINK_GUARD", 1)[0]


class DependencyLinkTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.env = dict(os.environ, HOME=str(self.root),
                        GIT_CONFIG_GLOBAL=os.devnull,
                        GIT_CONFIG_NOSYSTEM="1")
        self.git = shutil.which("git")
        self.assertIsNotNone(self.git)
        self.run_git("init", "--quiet")
        (self.repo / ".gitignore").write_text("node_modules/\n")
        self.run_git("add", ".gitignore")

    def run_git(self, *args):
        return subprocess.run([self.git, *args], cwd=self.repo, env=self.env,
                              check=True, capture_output=True, timeout=10)

    def verify(self, broken_git=False):
        prefix = "git() { return 2; }\n" if broken_git else ""
        return subprocess.run(["/bin/bash", "-c", prefix + GUARD +
                               "\nverify_dependency_links"],
                              cwd=self.repo, env=self.env, capture_output=True,
                              timeout=10).returncode

    def test_ordinary_sources_and_regular_dependency_fixtures_pass(self):
        (self.repo / "README.md").write_text("source\n")
        fixture = self.repo / "tests/fixtures/node_modules/example/index.js"
        fixture.parent.mkdir(parents=True)
        fixture.write_text("export const example = 1;\n")
        self.run_git("add", "README.md")
        self.run_git("add", "-f", "tests/fixtures/node_modules/example/index.js")
        self.assertEqual(self.verify(), 0)

    def test_root_and_nested_dependency_directory_links_are_rejected(self):
        target = self.root / "private dependencies"
        target.mkdir()
        for relative in ("node_modules", "site/node_modules", "space dir/node_modules"):
            with self.subTest(relative=relative):
                link = self.repo / relative
                link.parent.mkdir(parents=True, exist_ok=True)
                link.symlink_to(target, target_is_directory=True)
                self.run_git("add", "-A")
                staged = self.run_git("ls-files", "--stage", "--", relative).stdout
                self.assertTrue(staged.startswith(b"120000 "), staged)
                self.assertNotEqual(self.verify(), 0)
                self.run_git("rm", "--cached", "--", relative)
                link.unlink()

    def test_unrelated_source_symlinks_are_not_blanket_rejected(self):
        (self.repo / "README.md").write_text("source\n")
        (self.repo / "readme-link").symlink_to("README.md")
        self.run_git("add", "-A")
        self.assertEqual(self.verify(), 0)

    def test_git_index_read_failure_is_not_an_empty_clean_result(self):
        self.assertNotEqual(self.verify(broken_git=True), 0)

    def test_actual_publication_checks_after_staging_before_commit_or_push(self):
        call = SOURCE.index("verify_dependency_links ||")
        self.assertGreater(call, SOURCE.index("git add -A"))
        self.assertLess(call, SOURCE.index("commit -q --no-verify"))
        self.assertLess(call, SOURCE.index("push -q --no-verify"))
        self.assertLess(call, SOURCE.index("gh pr create"))


if __name__ == "__main__":
    unittest.main()
