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
        call = SOURCE.index("verify_dependency_links ||", SOURCE.index("git add -A"))
        self.assertGreater(call, SOURCE.index("git add -A"))
        self.assertLess(call, SOURCE.index("commit -q --no-verify"))
        self.assertLess(call, SOURCE.index("push -q --no-verify"))
        self.assertLess(call, SOURCE.index("gh pr create"))


class UpstreamPublicationHoldTests(unittest.TestCase):
    def test_exact_mode_exits_before_legacy_mutation_and_uses_closed_argv(self):
        start = SOURCE.index('if [ "$IU" = 1 ]; then\n  verify_dependency_links')
        end = SOURCE.index('\n# >>> G1CLASSIFY', start)
        block = SOURCE[start:end]
        helper = (PUBLISHER.parent / 'integrated-merge.py').read_text()
        self.assertLess(end, SOURCE.index('git add -N'))
        self.assertLess(end, SOURCE.index('git reset -q --soft'))
        self.assertIn('gs_git "$2" push --force-with-lease=refs/heads/feat/read-range:0837489ab7bb6b8801884108f8932367d10f68b1 https://github.com/ashlrai/ashlr-plugin.git "$3:refs/heads/feat/read-range"', helper)
        self.assertIn('gs_git "$2" push --force-with-lease=refs/heads/dependabot/github_actions/actions/download-artifact-8:3b7c93ff552d3fa7a5b835a416c238c37be78cdd https://github.com/ashlrai/lexicon.git "$3:refs/heads/dependabot/github_actions/actions/download-artifact-8"', helper)
        self.assertIn('gs_git "$2" push --force-with-lease=refs/heads/dependabot/github_actions/actions/cache-6:f6975814f2ae2b562c81c57e50c5ecdeb05627d6 https://github.com/ashlrai/lexicon.git "$3:refs/heads/dependabot/github_actions/actions/cache-6"', helper)
        self.assertEqual(helper.count('gs_git "$2" push '), 3)
        self.assertNotIn('upstream-recovery-and-admission-incomplete', block)
        self.assertIn('gs_check "$WT"', block)
        self.assertLess(block.index('gs_check "$WT"'), block.index('--push'))
        self.assertIn('upstream-original157.attempt', helper)
        self.assertIn('--outcome', block)
        self.assertIn('--match-head-commit "$IMSHA"', block)
        self.assertNotIn('--admin', block)
        self.assertIn('  exit 0\nfi', block)

    def test_uncertain_write_creates_fence_and_is_never_retried(self):
        # The behavioral test below runs the real caller and a local Git remote.
        start = SOURCE.index('if [ "$IU" = 1 ]; then\n  verify_dependency_links')
        end = SOURCE.index('\n# >>> G1CLASSIFY', start)
        block = SOURCE[start:end]
        self.assertLess(block.index('--attempt'), block.index('--push'))
        self.assertIn('EXISTING)', block)
        self.assertIn('reconciling without retry', block)
        self.assertEqual(block.count('--push'), 1)
        self.assertIn('--outcome', block)

    def test_upstream_feature_alias_and_tuple_generic_merge_request(self):
        self.assertIn('--integrated-upstream-original157|--integrated-upstream-feature', SOURCE)
        self.assertIn('--upstream-feature --prepare', SOURCE)
        self.assertIn('--upstream-feature "$@"', SOURCE)
        self.assertNotIn('ashlrai/ashlr-plugin/pull/157', SOURCE)
        self.assertIn('gh pr merge "https://github.com/$REPO/pull/$IMPR" --repo "$REPO" "$IMMETHOD" --auto --match-head-commit "$IMSHA"', SOURCE)
        self.assertNotIn('--admin', SOURCE)

    def test_legacy_fork_destination_is_literal_and_unchanged(self):
        self.assertIn('FORK_URL="https://github.com/masonwyatt23/$NAME.git"', SOURCE)
        self.assertIn('push -q --no-verify "$FORK_URL" $SHA:refs/heads/codex-bridge/$J', SOURCE)
        self.assertNotIn('push -q --no-verify origin', SOURCE)
        self.assertEqual(SOURCE.count('push -q --no-verify'), 1)



class ShippedIntegratedHelperPinTests(unittest.TestCase):
    """Exercise the exact shipped helper/publisher guard without editing its pin."""

    def guard(self, mutate=False):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); (root / "bin").mkdir()
            helper = root / "bin/integrated-merge.py"
            helper.write_bytes((PUBLISHER.parent / "integrated-merge.py").read_bytes()
                               + (b"\n# changed fixture\n" if mutate else b""))
            start = SOURCE.index('  IMHELP="$R/bin/integrated-merge.py"; IMHELP_SHA=')
            end = SOURCE.index('\n  if [ "$IU" = 0 ]; then', start)
            # These exact source lines include the shipped literal pin and real shell guard.
            script = 'R="$1"\n' + SOURCE[start:end] + '\nprintf "PAIR-PIN-PASS\n"\n'
            return subprocess.run(["/bin/bash", "-c", script, "fixture", str(root)],
                                  capture_output=True, text=True, timeout=5)

    def test_actual_shipped_pair_passes_without_pin_rewrite(self):
        result = self.guard()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("PAIR-PIN-PASS", result.stdout)

    def test_modified_helper_fails_the_unchanged_shipped_guard(self):
        result = self.guard(mutate=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("integrated-helper-pin", result.stdout)
        self.assertNotIn("PAIR-PIN-PASS", result.stdout)

    def test_actual_merge_request_argv_uses_only_the_two_literal_squash_tuples(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); gh = root / "gh"
            gh.write_text('#!/bin/bash\nprintf "%s\\n" "$@" > "$CAPTURE"\n')
            gh.chmod(0o700)
            lines = SOURCE.splitlines(); start = lines.index('  IMMETHOD=--merge')
            script = "\n".join(lines[start:start+3])
            for repo, number, method in [("ashlrai/lexicon", "479", "--squash"),
                                         ("ashlrai/lexicon", "480", "--squash"),
                                         ("ashlrai/ashlr-plugin", "157", "--merge")]:
                env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'],
                           CAPTURE=str(root / "args"), REPO=repo, IMPR=number, IMSHA="a" * 40)
                result = subprocess.run(["/bin/bash", "-c", script], env=env,
                                        capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual((root / "args").read_text().splitlines(), ["pr", "merge",
                    "https://github.com/"+repo+"/pull/"+number, "--repo", repo,
                    method, "--auto", "--match-head-commit", "a" * 40])


class UpstreamCallerLocalGitTests(unittest.TestCase):
    """Run the publisher and helper against a local bare remote and fake API.

    Copies substitute the fixed object ID, URL, and API executable solely so
    fixtures cannot contact GitHub; the caller and proof code are otherwise real.
    Subclasses rebind the closed tuple identities for other reviewed profiles.
    """
    REPO = 'ashlr-plugin'
    HEAD_REPO = 'ashlrai/ashlr-plugin'
    HEAD_REF = 'feat/read-range'
    HEAD_REF_API = 'feat%2Fread-range'
    PR = 157
    PROFILE = 'upstream-original157'
    ORIGINAL_TOKEN = '0837489ab7bb6b8801884108f8932367d10f68b1'
    MODE = '--integrated-upstream-original157'
    HELP_FLAG = '--upstream-original157'

    def setUp(self):
        import hashlib
        import json
        import time
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.runs = self.home / '.ashlr-runs'
        self.bin = self.runs / 'bin'
        self.proofs = self.runs / 'integrated-merge'
        (self.proofs / 'evidence').mkdir(parents=True, mode=0o700)
        self.proofs.chmod(0o700)
        self.bin.mkdir()
        (self.runs / 'queue/run').mkdir(parents=True)
        self.repo = self.home / 'Projects/ashlrai' / self.REPO
        self.repo.mkdir(parents=True)
        self.env = dict(os.environ, HOME=str(self.home),
                        GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
                        GIT_AUTHOR_NAME='Fixture', GIT_AUTHOR_EMAIL='fixture@example.invalid',
                        GIT_COMMITTER_NAME='Fixture', GIT_COMMITTER_EMAIL='fixture@example.invalid')
        self.git('init', '-q')
        (self.repo / 'file').write_text('base\n')
        self.git('add', 'file')
        self.git('commit', '-qm', 'base')
        base = self.git('rev-parse', 'HEAD')
        (self.repo / 'file').write_text('integrated\n')
        self.git('commit', '-qam', 'original')
        self.original = self.git('rev-parse', 'HEAD')
        self.git('checkout', '-q', '--detach', base)
        (self.repo / 'file').write_text('integrated\n')
        self.git('commit', '-qam', 'main')
        self.main = self.git('rev-parse', 'HEAD')
        self.tree = self.git('rev-parse', 'HEAD^{tree}')
        self.merge = self.git('commit-tree', self.tree, '-p', self.original, '-p', self.main,
                              '-m', 'integrated merge')
        self.wt = self.home / 'job-wt'
        self.git('worktree', 'add', '--detach', '-q', str(self.wt), self.merge)
        self.bare = self.home / 'remote.git'
        subprocess.run(['git', 'init', '--bare', '-q', str(self.bare)], env=self.env,
                       check=True, capture_output=True, timeout=10)
        self.feature_ref = 'refs/heads/' + self.HEAD_REF
        self.git('push', '-q', str(self.bare), self.original + ':' + self.feature_ref)
        self.job = 'FIXTURE'
        (self.runs / (self.job + '.base')).write_text(f'{self.main} branch {self.wt} work\n')
        (self.runs / 'queue/run' / (self.job + '.line')).write_text(self.job + '\t' + self.REPO + '\twork\twork\n')
        evidence = dict(schema=1, repo=self.REPO, pr=self.PR, originalHead=self.original,
                        mainHead=self.main, mergeHead=self.merge, reviewedTree=self.tree,
                        outcome='already-integrated', reviewer='fixture',
                        paths=[dict(path='file', originalChange='change', mainEvidence='present', verification='checked')])
        raw = json.dumps(evidence).encode()
        p = self.proofs / 'evidence' / (self.job + '.json')
        p.write_bytes(raw); p.chmod(0o600)
        now = int(time.time())
        receipt = dict(schema=2, profile=self.PROFILE, job=self.job, repo=self.REPO,
                       pr=self.PR, headRepo=self.HEAD_REPO, headRef=self.HEAD_REF,
                       originalHead=self.original, mainHead=self.main, mergeHead=self.merge,
                       tree=self.tree, createdAt=now, expiresAt=now+1200,
                       evidenceSha256=hashlib.sha256(raw).hexdigest())
        p = self.proofs / (self.job + '.json')
        p.write_text(json.dumps(receipt)); p.chmod(0o600)
        # Test-only GitSafe replacement, never installed: record attempted pushes
        # and redirect only the exact canonical destination to the fixture remote.
        gs = self.bin / 'git-safe-env.sh'
        gs.write_text(('''#!/bin/bash
GS_GIT=/usr/bin/git
gs_init() { GS_GIT=/usr/bin/git; }
gs_check() { return 0; }
gs_git() {
  local wt=$1; shift
  if [ "$1" = push ]; then printf 'push\\n' >> "$HOME/pushes"; fi
  local arg; local -a args=()
  for arg in "$@"; do
    if [ "$arg" = https://github.com/ashlrai/ashlr-plugin.git ]; then arg="$HOME/remote.git"; fi
    args+=("$arg")
  done
  /usr/bin/git -C "$wt" "${args[@]}" || return $?
  if [ "$1" = push ] && [ -f "$HOME/ambiguous" ]; then return 1; fi
}
''').replace('https://github.com/ashlrai/ashlr-plugin.git',
              'https://github.com/' + self.HEAD_REPO + '.git'))
        # The scrub fixture accepts checks and copies the run log at exit.
        (self.bin / 'scrub.pl').write_text('while (<STDIN>) { print unless @ARGV; }\n')
        self.gs_sha = hashlib.sha256(gs.read_bytes()).hexdigest()
        self.api = self.home / 'gh'
        self.api.chmod(0o755) if self.api.exists() else None
        self.env['PATH'] = str(self.home) + os.pathsep + os.environ['PATH']

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.repo, env=self.env,
                              check=True, capture_output=True, text=True, timeout=10).stdout.strip()

    def mock_api_substitutions(self):
        # The fixture script is authored for the plugin157 tuple; rebind its
        # literals to this class's closed tuple. Identity pairs are no-ops.
        return (('ashlrai/ashlr-plugin', self.HEAD_REPO),
                ('feat%2Fread-range', self.HEAD_REF_API),
                ('feat/read-range', self.HEAD_REF),
                ('/pulls/157', '/pulls/' + str(self.PR)),
                ("'number':157", "'number':" + str(self.PR)))

    def write_fixture_programs(self):
        import hashlib
        import json
        # Isolated copies substitute only the inaccessible external dependencies.
        helper = (PUBLISHER.parent / 'integrated-merge.py').read_text()
        helper = helper.replace(self.ORIGINAL_TOKEN, self.original)
        helper = helper.replace('234fb12a57a51fdfed81da8702a0b452c183f2726582608b81b7e811a65ce1a2', self.gs_sha)
        helper = helper.replace('/opt/homebrew/bin/gh', str(self.api))
        hp = self.bin / 'integrated-merge.py'
        hp.write_text(helper)
        pub = PUBLISHER.read_text().replace(self.ORIGINAL_TOKEN, self.original)
        pub = pub.replace('234fb12a57a51fdfed81da8702a0b452c183f2726582608b81b7e811a65ce1a2', self.gs_sha)
        import re
        pub = re.sub(r'IMHELP_SHA=[0-9a-f]{64}', 'IMHELP_SHA=' + hashlib.sha256(hp.read_bytes()).hexdigest(), pub)
        self.publisher = self.home / 'publisher.sh'
        self.publisher.write_text(pub)
        state = dict(original=self.original, main=self.main, merge=self.merge, tree=self.tree,
                     bare=str(self.bare), status='REQUESTED')
        (self.home / 'api-state.json').write_text(json.dumps(state))

    def run_publisher(self):
        result = subprocess.run(['/bin/bash', str(self.publisher), self.job, self.MODE],
                                cwd=self.home, env=self.env, capture_output=True, text=True, timeout=60)
        output = (self.runs / (self.job + '.publish')).read_text()
        return result.returncode, output

    def install_mock_api(self):
        self.api.write_text('''#!/usr/bin/python3
import json, os, subprocess, sys
from pathlib import Path
home = Path(os.environ['HOME'])
path = home / 'api-state.json'
s = json.loads(path.read_text())
a = sys.argv[1:]
if a[:2] == ['pr', 'merge']:
    with (home / 'merges').open('a') as f: f.write('merge\\n')
    s['requested'] = True
    s['observed'] = s.get('goal', 'REQUESTED')
    path.write_text(json.dumps(s))
    sys.exit(0)
if not a or a[0] != 'api': sys.exit(1)
route = a[-1]
head = subprocess.check_output(['/usr/bin/git', '--git-dir', s['bare'], 'rev-parse', 'refs/heads/feat/read-range'], text=True).strip()
repo = {'full_name':'ashlrai/ashlr-plugin'}
if 'graphql' in a:
    print(json.dumps({'data':{'repository':{'pullRequest':{'number':157, 'headRefOid':head, 'mergeQueueEntry':{'id':'entry'} if s.get('observed') == 'QUEUED' else None}}}}))
    sys.exit(0)
if route == 'repos/ashlrai/ashlr-plugin':
    result = dict(repo, default_branch='main')
elif route.endswith('/branches/main'):
    result = {'name':'main', 'protected':True, 'commit':{'sha':('9'*40 if s.get('observed') == 'MERGED' else s['main'])}}
elif route.endswith('/rules/branches/feat%2Fread-range'):
    result = []
elif route.endswith('/branches/feat%2Fread-range'):
    result = {'name':'feat/read-range', 'protected':s.get('protected', False), 'commit':{'sha':head}}
elif route.endswith('/pulls/157'):
    result = {'number':157, 'state':('closed' if s.get('observed') == 'MERGED' else 'open'), 'merged_at':('2026-11-07T00:00:00Z' if s.get('observed') == 'MERGED' else None),
              'head':{'repo':repo,'ref':'feat/read-range','sha':s.get('pr_head',head)},
              'base':{'repo':repo,'ref':'main','sha':s['main']},
              'mergeable':True,'merge_commit_sha':'9'*40,
              'auto_merge':{'merge_method':'merge', 'enabled_by':{'login':'fixture'}} if s.get('requested') else None}
elif '/compare/' in route:
    result = {'status':'identical','base_commit':{'sha':'9'*40},'merge_base_commit':{'sha':'9'*40}}
elif '/git/commits/' in route:
    result = {'sha':route.rsplit('/', 1)[-1],'tree':{'sha':s['tree']},
              'parents':[{'sha':s['main']},{'sha':s['merge']}]}
else:
    sys.exit(1)
print(json.dumps(result))
''')
        text = self.api.read_text()
        for old, new in self.mock_api_substitutions():
            text = text.replace(old, new)
        if self.REPO == 'lexicon':
            # Lex's actual identity and retained-join server proof need valid fixtures.
            text = text.replace("repo = {'full_name':'ashlrai/lexicon'}",
                                "repo = {'id':1376859455,'full_name':'ashlrai/lexicon'}")
            text = text.replace("if a[:2] == ['pr', 'merge']:\n",
                                "if a[:2] == ['pr', 'merge']:\n    assert '--squash' in a\n")
            text = text.replace("elif '/git/commits/' in route:\n",
                                "elif route.endswith('/git/commits/' + s['merge']):\n"
                                "    result = {'sha':s['merge'],'tree':{'sha':s['tree']},'parents':[{'sha':s['original']},{'sha':s['main']}]}\n"
                                "elif '/git/commits/' in route:\n")
            text = text.replace("'parents':[{'sha':s['main']},{'sha':s['merge']}]}",
                                "'parents':([{'sha':s['main']}] if s.get('observed') == 'MERGED' else [{'sha':s['main']},{'sha':s['merge']}])}")
        self.api.write_text(text)
        self.api.chmod(0o755)

    def prepare_caller(self):
        self.install_mock_api()
        self.write_fixture_programs()

    def test_real_caller_push_then_requested_is_held_and_never_retries(self):
        self.prepare_caller()
        rc, output = self.run_publisher()
        self.assertNotEqual(rc, 0, output)
        self.assertIn('upstream-auto-requested', output)
        self.assertEqual(self.git('ls-remote', str(self.bare), self.feature_ref).split()[0], self.merge)
        self.assertEqual((self.home / 'pushes').read_text().splitlines(), ['push'])
        self.assertEqual((self.home / 'merges').read_text().splitlines(), ['merge'])
        rc, output = self.run_publisher()
        self.assertNotEqual(rc, 0, output)
        self.assertIn('upstream-auto-requested', output)
        self.assertEqual((self.home / 'pushes').read_text().splitlines(), ['push'])
        self.assertEqual((self.home / 'merges').read_text().splitlines(), ['merge'])

    def test_changed_index_and_protected_feature_prevent_attempt(self):
        import json
        self.prepare_caller()
        (self.wt / 'file').write_text('dirty\n')
        subprocess.run(['git', '-C', str(self.wt), 'add', 'file'], env=self.env, check=True)
        rc, _ = self.run_publisher()
        self.assertNotEqual(rc, 0)
        self.assertFalse((self.home / 'pushes').exists())
        subprocess.run(['git', '-C', str(self.wt), 'reset', '--hard', '-q', self.merge], env=self.env, check=True)
        p = self.home / 'api-state.json'
        state = json.loads(p.read_text()); state['protected'] = True; p.write_text(json.dumps(state))
        rc, _ = self.run_publisher()
        self.assertNotEqual(rc, 0)
        self.assertFalse((self.home / 'pushes').exists())
        self.assertFalse((self.proofs / (self.PROFILE + '.attempt')).exists())

    def test_remote_rewind_after_attempt_never_causes_second_push(self):
        self.prepare_caller()
        self.run_publisher()
        self.assertTrue((self.proofs / (self.PROFILE + '.attempt')).exists())
        subprocess.run(['git', '--git-dir', str(self.bare), 'update-ref',
                        self.feature_ref, self.original], env=self.env, check=True)
        rc, _ = self.run_publisher()
        self.assertNotEqual(rc, 0)
        self.assertEqual((self.home / 'pushes').read_text().splitlines(), ['push'])
        self.assertEqual(self.git('ls-remote', str(self.bare), self.feature_ref).split()[0], self.original)

    def test_uncertain_push_reconciles_remote_without_second_attempt(self):
        self.prepare_caller()
        (self.home / 'ambiguous').touch()
        rc, output = self.run_publisher()
        self.assertNotEqual(rc, 0, output)
        self.assertIn('upstream-auto-requested', output)
        self.assertEqual((self.home / 'pushes').read_text().splitlines(), ['push'])
        self.run_publisher()
        self.assertEqual((self.home / 'pushes').read_text().splitlines(), ['push'])

    def test_interruption_after_fence_never_starts_push(self):
        self.prepare_caller()
        result = subprocess.run(['/usr/bin/python3', '-I', '-B', str(self.bin / 'integrated-merge.py'),
                                 '--job', self.job, '--base', self.main, '--worktree', str(self.wt),
                                 self.HELP_FLAG, '--attempt'], env=self.env,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout.startswith('CREATED'))
        rc, _ = self.run_publisher()
        self.assertNotEqual(rc, 0)
        self.assertFalse((self.home / 'pushes').exists())

    def test_killed_publisher_after_attempt_never_retries(self):
        self.prepare_caller()
        original = self.publisher.read_text()
        anchor = '  read ATTEMPT_KIND ATTEMPT_TOKEN ATTEMPT_EXTRA <<< "$ATTEMPT"'
        self.assertEqual(original.count(anchor), 1)
        # Instrument only the temporary publisher copy: kill the actual caller
        # after its journal subprocess returns, before any push can launch.
        self.publisher.write_text(original.replace(anchor, '  kill -KILL $$\n' + anchor))
        rc, _ = self.run_publisher()
        self.assertEqual(rc, -9)
        self.assertTrue((self.proofs / (self.PROFILE + '.attempt')).is_file())
        self.assertFalse((self.home / 'pushes').exists())
        self.publisher.write_text(original)
        rc, _ = self.run_publisher()
        self.assertNotEqual(rc, 0)
        self.assertFalse((self.home / 'pushes').exists())
        self.assertEqual(self.git('ls-remote', str(self.bare), self.feature_ref).split()[0],
                         self.original)

    def test_ref_disagreement_and_bad_attempt_custody_hold(self):
        import json
        self.prepare_caller()
        p = self.home / 'api-state.json'
        state = json.loads(p.read_text()); state['pr_head'] = '6' * 40; p.write_text(json.dumps(state))
        self.assertNotEqual(self.run_publisher()[0], 0)
        self.assertFalse((self.home / 'pushes').exists())
        del state['pr_head']; p.write_text(json.dumps(state))
        marker = self.proofs / (self.PROFILE + '.attempt')
        marker.write_text('foreign'); marker.chmod(0o600)
        self.assertNotEqual(self.run_publisher()[0], 0)
        self.assertFalse((self.home / 'pushes').exists())

    def assert_observed_result(self, goal):
        import json
        self.prepare_caller()
        p = self.home / 'api-state.json'
        state = json.loads(p.read_text()); state['goal'] = goal; p.write_text(json.dumps(state))
        rc, output = self.run_publisher()
        self.assertEqual(rc, 0, output)
        self.assertIn('RESULT ' + goal, output)
        self.assertEqual((self.home / 'pushes').read_text().splitlines(), ['push'])

    def test_fresh_queue_is_observed(self):
        self.assert_observed_result('QUEUED')

    def test_fresh_merge_is_observed(self):
        self.assert_observed_result('MERGED')


class UpstreamLexicon479CallerLocalGitTests(UpstreamCallerLocalGitTests):
    """The same real caller run bound to the closed Lexicon479 tuple."""
    REPO = 'lexicon'
    HEAD_REPO = 'ashlrai/lexicon'
    HEAD_REF = 'dependabot/github_actions/actions/download-artifact-8'
    HEAD_REF_API = 'dependabot%2Fgithub_actions%2Factions%2Fdownload-artifact-8'
    PR = 479
    PROFILE = 'upstream-lexicon479'
    ORIGINAL_TOKEN = '3b7c93ff552d3fa7a5b835a416c238c37be78cdd'
    MODE = '--integrated-upstream-feature'
    HELP_FLAG = '--upstream-feature'


class UpstreamLexicon480CallerLocalGitTests(UpstreamCallerLocalGitTests):
    """The same real caller run bound to the closed Lexicon480 tuple."""
    REPO = 'lexicon'
    HEAD_REPO = 'ashlrai/lexicon'
    HEAD_REF = 'dependabot/github_actions/actions/cache-6'
    HEAD_REF_API = 'dependabot%2Fgithub_actions%2Factions%2Fcache-6'
    PR = 480
    PROFILE = 'upstream-lexicon480'
    ORIGINAL_TOKEN = 'f6975814f2ae2b562c81c57e50c5ecdeb05627d6'
    MODE = '--integrated-upstream-feature'
    HELP_FLAG = '--upstream-feature'


if __name__ == "__main__":
    unittest.main()
