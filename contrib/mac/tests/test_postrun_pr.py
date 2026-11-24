"""RQ-DISPATCHD-POSTRUN-PR-1: dispatchd publishes lane commits that ended RESULT EMPTY with no PR.

Hermetic: temp HOME, stub gh and publish.sh, a fixture git-safe helper whose sha the candidate dispatchd is patched to
pin. Nothing touches the real ~/.ashlr-runs, the network or gh.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import postrun_pr
from test_dispatchd import SCRIPT, build, held_lanes, tick, queue_job

PR = 'https://github.com/ashlrai/phantom/pull/9001'
HELPER = '#!/bin/bash\n[ "$1" = run ] || exit 2\nwt=$2; shift 2; exec git -C "$wt" "$@"\n'


def completed(code=0, out=''):
    return subprocess.CompletedProcess([], code, out, '')


class Unit(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.home = str(Path(self.tmp.name).resolve())
        self.runs = self.home + '/.ashlr-runs'
        os.makedirs(self.runs + '/queue/run')
        Path(self.runs + '/queue/run/RQ-J.line').write_text('RQ-J\tphantom\tcodex-personal\tt\n')
        self.calls = []

    def fake(self, lookup='', publish_result=None, lookup_code=0):
        def run(cmd, **kw):
            self.calls.append(cmd)
            if cmd[0] == 'gh': return completed(lookup_code, lookup + '\n')
            if publish_result is not None: Path(self.runs + '/RQ-J.publish').write_text('NOTE x\n' + publish_result + '\n')
            return completed()
        return run

    def log(self):
        return Path(self.runs + '/dispatchd.log').read_text()

    def sidecar(self):
        return json.loads(Path(self.runs + '/queue/run/RQ-J.postrun.json').read_text())

    def test_eligible_only_for_empty(self):
        self.assertTrue(postrun_pr.eligible('RESULT EMPTY'))
        for res in (None, '', 'RESULT PR https://x', 'RESULT ABORT push', 'RESULT DENIED x'):
            self.assertFalse(postrun_pr.eligible(res))

    def test_publishes_and_records_pr(self):
        run = self.fake(publish_result='RESULT PR %s SENS=[]' % PR)
        self.assertEqual(postrun_pr.main(['RQ-J'], self.home, run), 0)
        self.assertEqual(self.sidecar()['pr'], PR); self.assertEqual(self.sidecar()['action'], 'published')
        pub = [c for c in self.calls if c[0] != 'gh']
        self.assertEqual(pub, [['/bin/bash', self.runs + '/bin/publish.sh', 'RQ-J']])   # no other mutating command
        self.assertIn('published RQ-J ' + PR, self.log())

    def test_existing_pr_is_not_republished(self):
        run = self.fake(lookup=PR)
        self.assertEqual(postrun_pr.main(['RQ-J'], self.home, run), 0)
        self.assertEqual([c[0] for c in self.calls], ['gh'])
        self.assertEqual(self.sidecar(), {**self.sidecar(), 'action': 'exists', 'pr': PR})
        self.assertIn('not republished', self.log())

    def test_lookup_failure_fails_closed(self):
        self.assertEqual(postrun_pr.main(['RQ-J'], self.home, self.fake(lookup_code=1)), 3)
        self.assertEqual([c[0] for c in self.calls], ['gh'])
        self.assertFalse(Path(self.runs + '/queue/run/RQ-J.postrun.json').exists())

    def test_foreign_lookup_output_is_not_trusted(self):
        self.assertEqual(postrun_pr.main(['RQ-J'], self.home, self.fake(lookup='https://evil.example/pull/1')), 3)
        self.assertEqual([c[0] for c in self.calls], ['gh'])

    def test_publish_without_pr_is_recorded_not_retried(self):
        self.assertEqual(postrun_pr.main(['RQ-J'], self.home, self.fake(publish_result='RESULT EMPTY')), 1)
        self.assertEqual(self.sidecar()['action'], 'no-pr')
        self.assertIn('no-pr RQ-J RESULT EMPTY', self.log())

    def test_foreign_pr_url_in_result_is_rejected(self):
        self.assertEqual(postrun_pr.main(['RQ-J'], self.home, self.fake(publish_result='RESULT PR https://evil.example/pull/1')), 1)
        self.assertNotIn('pr', self.sidecar())

    def test_gates(self):
        self.assertEqual(postrun_pr.main(['../x'], self.home, self.fake()), 2)
        Path(self.runs + '/queue/run/RQ-J.line').write_text('RQ-J\tunlisted\tx\n')
        self.assertEqual(postrun_pr.main(['RQ-J'], self.home, self.fake()), 1)
        Path(self.runs + '/queue/run/RQ-J.line').write_text('RQ-J\tphantom\tx\n')
        Path(self.runs + '/POSTRUN_PR_OFF').write_text('')
        self.assertEqual(postrun_pr.main(['RQ-J'], self.home, self.fake()), 0)
        self.assertEqual(self.calls, [])

    def test_child_env_forwards_only_publish_policy(self):
        parent = {
            'HOME': '/parent/home',
            'PATH': '/parent/bin',
            'PUBLISH_FULL_TESTS': '1',
            'PUBLISH_JUDGE_CMD': 'python3 judge.py --threshold 0.95',
            'PUBLISH_JUDGE_THRESHOLD': '0.91',
            'PUBLISH_JUDGE_TIMEOUT': '37',
            'PUBLISH_UNRELATED': 'not-forwarded',
            'GH_TOKEN': 'sentinel',
        }
        child = postrun_pr.child_env(self.home, parent)
        self.assertEqual(child['PUBLISH_FULL_TESTS'], '1')
        self.assertEqual(child['PUBLISH_JUDGE_CMD'], 'python3 judge.py --threshold 0.95')
        self.assertEqual(child['PUBLISH_JUDGE_THRESHOLD'], '0.91')
        self.assertEqual(child['PUBLISH_JUDGE_TIMEOUT'], '37')
        self.assertEqual({name for name in child if name.startswith('PUBLISH_')}, set(postrun_pr.PUBLISH_POLICY_ENV))
        self.assertNotIn('PUBLISH_UNRELATED', child)
        self.assertNotIn('GH_TOKEN', child)
        self.assertEqual(child['HOME'], self.home)
        self.assertEqual(child['PATH'], '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin')


class Tick(unittest.TestCase):
    """Full dispatchd tick against a real throwaway git worktree."""

    def git(self, wt, *a):
        return subprocess.run(['git', '-C', str(wt), *a], check=True, capture_output=True, text=True).stdout.strip()

    def fixture(self, commits=1, res='RESULT EMPTY', gh_out='', switch_off=False):
        tmp = build(slots=held_lanes()); self.addCleanup(tmp.cleanup)
        home = Path(tmp.name).resolve(); r = home / '.ashlr-runs'; job = 'RQ-PR-LOST'
        queue_job(home, job, 'codex-personal')
        line = (r / 'queue/ready.tsv').read_text().splitlines()[-1]
        (r / 'queue/ready.tsv').write_text(''); (r / 'queue/run' / f'{job}.line').write_text(line + '\n')
        wt = home / 'Projects/ashlrai/wt' / job; wt.mkdir()
        self.git(wt, 'init', '-q'); self.git(wt, 'config', 'user.name', 'F'); self.git(wt, 'config', 'user.email', 'f@example.invalid')
        (wt / 'a').write_text('a\n'); self.git(wt, 'add', '.'); self.git(wt, 'commit', '-qm', 'base')
        base = self.git(wt, 'rev-parse', 'HEAD')
        for i in range(commits):
            (wt / f'c{i}').write_text('c\n'); self.git(wt, 'add', '.'); self.git(wt, 'commit', '-qm', f'c{i}')
        for path, text in [(r / f'{job}.base', f'{base} codex-bridge/{job} {wt} codex-personal\n'), (r / f'{job}.log', 'done\n')]:
            path.write_text(text); os.utime(path, (time.time() - 600,) * 2)
        (r / 'queue/run' / f'{job}.rc').write_text('0\n')
        if res: (r / f'{job}.publish').write_text(res + '\n')
        (r / 'phantom-open-prs').write_text(f'{int(time.time())} 0\n')
        (r / 'bin/reap-one.sh').write_text('#!/bin/sh\necho reaped >> "$HOME/.ashlr-runs/reap-calls"\nrmdir "$HOME/.ashlr-runs/queue/run/$1.reaping"\n')
        (r / 'bin/git-safe-env.sh').write_text(HELPER)
        # the child's PATH is fixed in production; the fixture swaps only that string so the stub gh is found
        child = (SCRIPT.parent / 'postrun_pr.py').read_text().replace('/opt/homebrew/bin:/usr/bin', f'{home}/stubbin:/usr/bin', 1)
        self.assertIn('stubbin', child); (r / 'bin/postrun_pr.py').write_text(child)
        (r / 'bin/publish.sh').write_text('#!/bin/bash\necho "$1" >> "$HOME/.ashlr-runs/publish-calls"\n'
                                          f'echo "RESULT PR {PR} SENS=[]" > "$HOME/.ashlr-runs/$1.publish"\n')
        gh = home / 'stubbin/gh'; gh.write_text(f'#!/bin/sh\necho "{gh_out}"\n'); gh.chmod(0o755)
        if switch_off: (r / 'POSTRUN_PR_OFF').write_text('')
        sha = hashlib.sha256(HELPER.encode()).hexdigest()
        src = SCRIPT.read_text()
        import re
        src = re.sub(r'GITSAFE_SHA = "[0-9a-f]{64}"', f'GITSAFE_SHA = "{sha}"', src, count=1)
        cand = home / 'dispatchd.py'; cand.write_text(src)
        return home, r, job, cand

    def run_tick(self, home, cand):
        res = tick(home, {'PYTHONPATH': str(SCRIPT.parent)}, cand)
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        return res

    def wait_for(self, path, secs=10):
        end = time.monotonic() + secs
        while time.monotonic() < end:
            if path.exists(): return True
            time.sleep(0.05)
        return False

    def test_committed_empty_lane_is_published_and_recorded(self):
        home, r, job, cand = self.fixture()
        self.run_tick(home, cand)
        side = r / f'queue/run/{job}.postrun.json'
        self.assertTrue(self.wait_for(side), 'sidecar not written')
        self.assertEqual(json.loads(side.read_text())['pr'], PR)
        self.assertEqual((r / 'publish-calls').read_text().split(), [job])
        self.assertIn('POSTRUN_PR start %s ahead=1' % job, (r / 'dispatch-events.log').read_text())
        self.assertIn('published %s %s' % (job, PR), (r / 'dispatchd.log').read_text())
        self.assertFalse((r / 'reap-calls').exists())   # reap-one.sh waits a tick for the child

    def test_second_tick_is_idempotent(self):
        home, r, job, cand = self.fixture()
        self.run_tick(home, cand); self.assertTrue(self.wait_for(r / f'queue/run/{job}.postrun.json'))
        (r / f'{job}.publish').write_text(f'RESULT PR {PR} SENS=[]\n')
        self.run_tick(home, cand)
        self.assertEqual((r / 'publish-calls').read_text().split(), [job])

    def test_in_flight_child_is_not_respawned(self):
        home, r, job, cand = self.fixture()
        (r / f'queue/run/{job}.postrun').write_text('1')
        self.run_tick(home, cand); time.sleep(0.5)
        self.assertFalse((r / 'publish-calls').exists())
        self.assertFalse((r / 'reap-calls').exists())

    def test_existing_pr_skips_publish(self):
        home, r, job, cand = self.fixture(gh_out=PR)
        self.run_tick(home, cand)
        side = r / f'queue/run/{job}.postrun.json'
        self.assertTrue(self.wait_for(side))
        self.assertEqual(json.loads(side.read_text())['action'], 'exists')
        self.assertFalse((r / 'publish-calls').exists())

    def test_no_commits_ahead_does_nothing(self):
        home, r, job, cand = self.fixture(commits=0)
        self.run_tick(home, cand); time.sleep(0.5)
        self.assertFalse((r / f'queue/run/{job}.postrun').exists())
        self.assertFalse((r / 'publish-calls').exists())

    def test_only_empty_results_qualify(self):
        home, r, job, cand = self.fixture(res='RESULT PR https://github.com/ashlrai/phantom/pull/1 SENS=[]')
        self.run_tick(home, cand); time.sleep(0.5)
        self.assertFalse((r / f'queue/run/{job}.postrun').exists())

    def test_off_switch(self):
        home, r, job, cand = self.fixture(switch_off=True)
        self.run_tick(home, cand); time.sleep(0.5)
        self.assertFalse((r / f'queue/run/{job}.postrun').exists())


if __name__ == '__main__':
    unittest.main()
