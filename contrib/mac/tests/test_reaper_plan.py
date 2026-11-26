import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

MAC = Path(__file__).resolve().parents[1]


class ReaperPlanTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name).resolve()
        self.runs = self.home / '.ashlr-runs'
        self.state = self.runs / 'selfrun'
        self.bin = self.runs / 'bin'
        self.state.mkdir(parents=True)
        self.bin.mkdir()
        self.root = self.home / 'Projects/ashlrai/wt'
        self.root.mkdir(parents=True)
        self.checker = self.bin / 'git-safe-env.sh'
        self.calls = self.home / 'checks'
        self.checker.write_text(f'printf "%s\\n" "$2" >> "{self.calls}"\n')
        shutil.copyfile(MAC / 'reaper-plan.py', self.bin / 'reaper-plan.py')
        self.phm = self.home / '.local/bin/phm'
        self.phm.parent.mkdir(parents=True)
        self.phm.write_text('#!/bin/sh\ncat "$HOME/plan.json"\n')
        self.phm.chmod(0o700)

    def tree(self, job):
        wt = self.root / job
        wt.mkdir()
        metadata = self.root.parent / 'phantom/.git/worktrees' / job
        metadata.mkdir(parents=True)
        (wt / '.git').write_text(f'gitdir: {metadata}\n')
        (metadata / 'HEAD').write_text('a' * 40 + '\n')
        (self.runs / f'{job}.base').write_text(f'base branch {wt} pool\n')
        return wt, metadata

    def plan(self, *entries, complete=True):
        report = {'schema': 'disk-maint.v1', 'apply': False, 'classes': [{
            'id': 'worktrees-jobs', 'complete': complete, 'reapable': len(entries),
            'reapReasons': {}, 'protectReasons': {},
            'candidates': [{'path': '~/' + str(path.relative_to(self.home)), 'action': 'worktree-remove'}
                           for path in entries],
        }]}
        (self.home / 'plan.json').write_text(json.dumps(report))

    def run_audit(self):
        source = (MAC / 'selfrun.sh').read_text()
        function = source[source.index('s_gitlink(){'):source.index("\nMSYNC_PY=")]
        shell = f'''
RH=$1; R=$RH/.ashlr-runs; B=$R/bin; S=$R/selfrun
PIN_GITSAFE=fixture; JID='^RQ-'
shaok() {{ return 0; }}
{function}
s_gitlink
'''
        return subprocess.run(['/bin/bash', '-eu', '-c', shell, 'audit', str(self.home)],
                              cwd=self.home, capture_output=True, check=True, text=True)

    def test_terminal_and_unchanged_worktrees_do_not_run_helper(self):
        terminal, _ = self.tree('RQ-TERMINAL')
        current, metadata = self.tree('RQ-CURRENT')
        self.plan(terminal)
        self.run_audit()
        self.assertEqual(self.calls.read_text().splitlines(), [str(current)])
        self.calls.unlink()
        self.assertIn('cached=1,terminal=1', self.run_audit().stdout)
        self.assertFalse(self.calls.exists())
        (metadata / 'HEAD').write_text('b' * 40 + '\n')
        self.run_audit()
        self.assertEqual(self.calls.read_text().splitlines(), [str(current)])
        self.calls.unlink()
        marker = current / '.git'
        marker.unlink()
        marker.write_text(f'gitdir: {metadata}\n')
        self.run_audit()
        self.assertEqual(self.calls.read_text().splitlines(), [str(current)])

    def test_incomplete_classifier_rechecks_every_tree(self):
        first, _ = self.tree('RQ-FIRST')
        second, _ = self.tree('RQ-SECOND')
        self.plan(first)
        self.run_audit()
        self.plan(first, complete=False)
        self.calls.unlink()
        self.assertIn('cached=0,terminal=0', self.run_audit().stdout)
        self.assertEqual(self.calls.read_text().splitlines(), [str(first), str(second)])

    def test_reapers_fail_closed_when_classifier_is_incomplete(self):
        current, _ = self.tree('RQ-PROTECTED')
        self.plan(current, complete=False)
        for script in ('archive-reap.sh', 'reap-merged.sh'):
            result = subprocess.run(['/bin/bash', str(MAC / script)], cwd=self.home,
                                    env={'HOME': str(self.home), 'PATH': '/usr/bin:/bin'},
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 3)
            self.assertIn('REFUSE: disk-maint plan unavailable', result.stdout)
        self.assertTrue(current.is_dir())
        self.assertTrue((self.runs / 'RQ-PROTECTED.base').is_file())

    def test_classifier_remove_refusal_never_enters_quarantine(self):
        wt, _ = self.tree('RQ-DIRTY')
        source = (MAC / 'reap-one.sh').read_text()
        function = source[source.index('remove_wt(){'):source.index('\nif [ ! -e "$R/$J.publish"')]
        shell = f'''
WT=$1; R=$2; J=RQ-DIRTY; REAP_CLASSIFIED_ONLY=1
gs_ready() {{ return 0; }}
g() {{ echo "$R/.git"; }}
gs_git() {{ return 1; }}
ev() {{ printf '%s\\n' "$*"; }}
{function}
remove_wt
'''
        (self.runs / '.git').mkdir()
        result = subprocess.run(['/bin/bash', '-c', shell, 'reap', str(wt), str(self.runs)],
                                cwd=self.home, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('WT_KEPT_REMOVE_REFUSED RQ-DIRTY', result.stdout)
        self.assertTrue(wt.is_dir())
        self.assertFalse((self.runs / 'quarantine').exists())
