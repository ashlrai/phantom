"""Tests for fleet/sync.py and fleet/manifest.json (RQ-SWE5-MACHINERY-AS-CODE).

Every run targets a temp --bin directory under a temp HOME; the real ~/.ashlr-runs/bin is never read or written.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import unittest

FLEET = Path(__file__).resolve().parents[1]
ROOT = FLEET.parent
SYNC = FLEET / 'sync.py'
MANIFEST = FLEET / 'manifest.json'
MAC = ROOT / 'contrib' / 'mac'
INSTALL_SH = MAC / 'install.sh'
PINNED = ('publish.sh', 'launch.sh', 'scrub.pl')


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def mini_manifest(path, files):
    path.write_text(json.dumps({
        'schema': 'fleet.machinery.v1',
        'roots': {'runs-bin': {'env': 'ASHLR_RUNS_BIN', 'default': '~/.ashlr-runs/bin', 'mustExist': True}},
        'files': files}, indent=2))


class SyncTestBase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name).resolve()
        self.bin = self.home / '.ashlr-runs' / 'bin'
        self.bin.mkdir(parents=True)
        self.srcdir = self.home / 'src'
        self.srcdir.mkdir()
        self.manifest = self.home / 'manifest.json'

    def fixture(self, name, body=None):
        p = self.srcdir / name
        p.write_text(body if body is not None else '# %s\n' % name)
        return p

    def run_sync(self, *args, manifest=None):
        env = {'HOME': str(self.home), 'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'LANG': 'C'}
        return subprocess.run([sys.executable, str(SYNC), '--manifest', str(manifest or self.manifest), '--bin', str(self.bin), *args],
                              env=env, capture_output=True, text=True, timeout=60)


class ManifestTests(SyncTestBase):
    def test_real_manifest_is_valid_and_sources_exist(self):
        m = json.loads(MANIFEST.read_text())
        self.assertEqual(m['schema'], 'fleet.machinery.v1')
        names = set()
        for e in m['files']:
            self.assertIn(e['class'], ('managed', 'manual', 'pinned'), e)
            name = e.get('name') or Path(e['src']).name
            self.assertNotIn(name, names, 'duplicate ' + name)
            names.add(name)
            self.assertEqual(e['root'], 'runs-bin')
            if e.get('src'):
                self.assertTrue((ROOT / e['src']).is_file(), e['src'])
        self.assertEqual(len(names), len(m['files']))

    def test_manifest_covers_install_sh_files(self):
        """install.sh's FILES list must stay a subset of the manifest's managed set so the two installers never disagree."""
        text = INSTALL_SH.read_text()
        files_line = re.search(r'^FILES="([^"]+)"', text, re.M).group(1)
        install_files = set(files_line.split())
        m = json.loads(MANIFEST.read_text())
        managed = {Path(e['src']).name for e in m['files'] if e['class'] == 'managed'}
        self.assertTrue(install_files <= managed, 'install.sh FILES missing from manifest: %s' % sorted(install_files - managed))

    def test_pinned_files_have_no_managed_entries(self):
        m = json.loads(MANIFEST.read_text())
        by = {e.get('name') or Path(e['src']).name: e['class'] for e in m['files']}
        for n in PINNED:
            self.assertEqual(by.get(n), 'pinned', n)


class PlanTests(SyncTestBase):
    def test_plan_reports_new_and_writes_nothing(self):
        self.fixture('a.py')
        self.fixture('b.sh')
        mini_manifest(self.manifest, [
            {'src': str(self.srcdir / 'a.py'), 'root': 'runs-bin', 'class': 'managed'},
            {'src': str(self.srcdir / 'b.sh'), 'root': 'runs-bin', 'class': 'managed'}])
        # src must be repo-relative; absolute paths are rejected by the loader.
        r = self.run_sync('--json')
        self.assertEqual(r.returncode, 2)

    def test_plan_new_changed_unchanged(self):
        with tempfile.TemporaryDirectory() as repo_:
            repo = Path(repo_)
            (repo / '.git').mkdir()
            (repo / 'a.py').write_text('new a\n')
            (repo / 'b.py').write_text('new b\n')
            mpath = repo / 'manifest.json'
            mini_manifest(mpath, [
                {'src': 'a.py', 'root': 'runs-bin', 'class': 'managed'},
                {'src': 'b.py', 'root': 'runs-bin', 'class': 'managed'},
                {'name': 'pinned.sh', 'root': 'runs-bin', 'class': 'pinned'}])
            (self.bin / 'a.py').write_text('old a\n')
            r = self.run_sync('--json', manifest=mpath)
            self.assertEqual(r.returncode, 0, r.stderr)
            out = json.loads(r.stdout)
            self.assertTrue(out['dry_run'])
            by = {f['file']: f for f in out['files']}
            self.assertEqual(by['a.py']['status'], 'changed')
            self.assertEqual(by['b.py']['status'], 'new')
            self.assertEqual(by['pinned.sh']['status'], 'absent')
            self.assertEqual((self.bin / 'a.py').read_text(), 'old a\n')
            self.assertEqual(sorted(p.name for p in self.bin.iterdir()), ['a.py'])

    def test_unmanaged_sweep_lists_unknown_files(self):
        repo = self.srcdir.parent / 'repo'
        repo.mkdir()
        (repo / '.git').mkdir()
        (repo / 'a.py').write_text('x\n')
        m = repo / 'manifest.json'
        mini_manifest(m, [{'src': 'a.py', 'root': 'runs-bin', 'class': 'managed'}])
        (self.bin / 'mystery.sh').write_text('x\n')
        (self.bin / 'a.py.bak-fleet-20200101-000000').write_text('x\n')
        (self.bin / '.hidden').write_text('x\n')
        r = self.run_sync('--json', manifest=m)
        self.assertEqual(json.loads(r.stdout)['unmanaged'], ['mystery.sh'])

    def test_missing_bin_and_bad_args_fail(self):
        m = self.srcdir.parent / 'm.json'
        mini_manifest(m, [])
        self.bin.rmdir()
        self.assertEqual(self.run_sync(manifest=m).returncode, 1)
        self.bin.mkdir()
        self.assertEqual(self.run_sync('--bogus', manifest=m).returncode, 2)

    def test_malformed_manifest_refused(self):
        self.manifest.write_text('{"schema": "nope"}')
        self.assertEqual(self.run_sync().returncode, 2)

    def test_managed_requires_src_and_names_are_checked(self):
        mini_manifest(self.manifest, [{'name': 'x.py', 'root': 'runs-bin', 'class': 'managed'}])
        self.assertEqual(self.run_sync().returncode, 2)
        mini_manifest(self.manifest, [{'name': '../evil', 'root': 'runs-bin', 'class': 'pinned'}])
        self.assertEqual(self.run_sync().returncode, 2)

    def test_symlink_destination_is_refused(self):
        repo = self.home / 'repo'
        repo.mkdir()
        (repo / '.git').mkdir()
        (repo / 'a.py').write_text('new\n')
        m = repo / 'manifest.json'
        mini_manifest(m, [{'src': 'a.py', 'root': 'runs-bin', 'class': 'managed'}])
        target = self.home / 'elsewhere'
        target.write_text('keep\n')
        (self.bin / 'a.py').symlink_to(target)
        r = self.run_sync('--apply', '--json', manifest=m)
        self.assertEqual(r.returncode, 1)
        self.assertEqual(json.loads(r.stdout)['files'][0]['status'], 'error')
        self.assertEqual(target.read_text(), 'keep\n')

    def test_pin_mismatch_is_reported(self):
        repo = self.home / 'repo'
        repo.mkdir()
        (repo / '.git').mkdir()
        m = repo / 'manifest.json'
        mini_manifest(m, [{'name': 'pinned.sh', 'root': 'runs-bin', 'class': 'pinned',
                           'sha256': '0' * 64}])
        (self.bin / 'pinned.sh').write_text('live\n')
        r = self.run_sync('--json', manifest=m)
        self.assertEqual(json.loads(r.stdout)['files'][0]['status'], 'pin-mismatch')


class ApplyTests(SyncTestBase):
    def repo(self):
        repo = self.home / 'repo'
        repo.mkdir(exist_ok=True)
        (repo / '.git').mkdir(exist_ok=True)
        return repo

    def manifest_in(self, repo, files):
        m = repo / 'manifest.json'
        mini_manifest(m, files)
        return m

    def test_apply_installs_with_backup_and_rerun_is_noop(self):
        repo = self.repo()
        (repo / 'a.py').write_text('v2\n')
        m = self.manifest_in(repo, [{'src': 'a.py', 'root': 'runs-bin', 'class': 'managed'}])
        (self.bin / 'a.py').write_text('v1\n')
        r = self.run_sync('--apply', '--json', manifest=m)
        self.assertEqual(r.returncode, 0, r.stderr)
        f = json.loads(r.stdout)['files'][0]
        self.assertEqual(f['status'], 'installed')
        backup = Path(f['backup'])
        self.assertRegex(backup.name, r'^a\.py\.bak-fleet-\d{8}-\d{6}$')
        self.assertEqual(backup.read_text(), 'v1\n')
        self.assertEqual(f['dst_sha256'], hashlib.sha256(b'v1\n').hexdigest())
        self.assertEqual(sha(self.bin / 'a.py'), sha(repo / 'a.py'))
        self.assertEqual(stat.S_IMODE((self.bin / 'a.py').stat().st_mode), 0o755)
        again = json.loads(self.run_sync('--apply', '--json', manifest=m).stdout)
        self.assertEqual(again['files'][0]['status'], 'unchanged')
        self.assertEqual(len(list(self.bin.glob('a.py.bak-*'))), 1)

    def test_apply_never_writes_manual_or_pinned(self):
        repo = self.repo()
        (repo / 'a.py').write_text('repo a\n')
        (repo / 'p.sh').write_text('repo p\n')
        m = self.manifest_in(repo, [
            {'src': 'a.py', 'root': 'runs-bin', 'class': 'manual'},
            {'src': 'p.sh', 'root': 'runs-bin', 'class': 'pinned'}])
        (self.bin / 'a.py').write_text('live a\n')
        r = self.run_sync('--apply', '--json', manifest=m)
        self.assertEqual(r.returncode, 0, r.stderr)
        by = {f['file']: f for f in json.loads(r.stdout)['files']}
        self.assertEqual(by['a.py']['status'], 'drift')
        self.assertEqual(by['p.sh']['status'], 'absent')
        self.assertEqual((self.bin / 'a.py').read_text(), 'live a\n')
        self.assertFalse((self.bin / 'p.sh').exists())

    def test_mode_override_respected(self):
        repo = self.repo()
        (repo / 'a.sh').write_text('x\n')
        m = self.manifest_in(repo, [{'src': 'a.sh', 'root': 'runs-bin', 'class': 'managed', 'mode': '640'}])
        self.run_sync('--apply', manifest=m)
        self.assertEqual(stat.S_IMODE((self.bin / 'a.sh').stat().st_mode), 0o640)

    def test_diff_prints_unified_diff(self):
        repo = self.repo()
        (repo / 'a.py').write_text('new line\n')
        m = self.manifest_in(repo, [{'src': 'a.py', 'root': 'runs-bin', 'class': 'managed'}])
        (self.bin / 'a.py').write_text('old line\n')
        r = self.run_sync('--diff', manifest=m)
        self.assertIn('-old line', r.stdout)
        self.assertIn('+new line', r.stdout)
        self.assertIn('a.py: changed', r.stdout)


class RollbackTests(SyncTestBase):
    def setUp(self):
        super().setUp()
        self.repo = self.home / 'repo'
        self.repo.mkdir()
        (self.repo / '.git').mkdir()
        (self.repo / 'a.py').write_text('v2\n')
        self.m = self.repo / 'manifest.json'
        mini_manifest(self.m, [{'src': 'a.py', 'root': 'runs-bin', 'class': 'managed'},
                               {'name': 'p.sh', 'root': 'runs-bin', 'class': 'pinned'}])
        (self.bin / 'a.py').write_text('v1\n')

    def test_rollback_restores_newest_backup(self):
        self.run_sync('--apply', manifest=self.m)
        r = self.run_sync('--rollback', 'a.py', '--apply', '--json', manifest=self.m)
        self.assertEqual(r.returncode, 0, r.stderr)
        f = json.loads(r.stdout)['files'][0]
        self.assertEqual(f['status'], 'restored')
        self.assertEqual((self.bin / 'a.py').read_text(), 'v1\n')
        self.assertTrue(Path(f['pre_backup']).exists())

    def test_rollback_dry_run_writes_nothing(self):
        self.run_sync('--apply', manifest=self.m)
        r = self.run_sync('--rollback', 'a.py', manifest=self.m)
        self.assertEqual(r.returncode, 0)
        self.assertIn('would-restore', r.stdout)
        self.assertEqual((self.bin / 'a.py').read_text(), 'v2\n')

    def test_rollback_requires_managed_manifest_entry(self):
        self.assertEqual(self.run_sync('--rollback', 'nope.py', manifest=self.m).returncode, 2)
        self.assertEqual(self.run_sync('--rollback', 'p.sh', manifest=self.m).returncode, 2)

    def test_rollback_without_backup_fails(self):
        r = self.run_sync('--rollback', 'a.py', '--apply', manifest=self.m)
        self.assertEqual(r.returncode, 1)
        self.assertIn('no usable backup', r.stderr if r.stderr else r.stdout)

    def test_same_second_rollback_does_not_clobber_backup(self):
        """Install and rollback inside one tick: the pre-rollback copy must not overwrite the .bak it restores."""
        self.run_sync('--apply', manifest=self.m)
        r = self.run_sync('--rollback', 'a.py', '--apply', manifest=self.m)
        self.assertIn('restored', r.stdout)
        baks = sorted(p.name for p in self.bin.glob('a.py.bak-*'))
        self.assertEqual(len(baks), 2)
        bodies = {(self.bin / b).read_text() for b in baks}
        self.assertEqual(bodies, {'v1\n', 'v2\n'})

    def test_repeated_rollback_does_not_redo(self):
        """bak-fleet-pre-* snapshots are audit trail, not candidates: a second rollback stays on the older install backup."""
        self.run_sync('--apply', manifest=self.m)
        self.run_sync('--rollback', 'a.py', '--apply', manifest=self.m)
        self.assertEqual((self.bin / 'a.py').read_text(), 'v1\n')
        r = self.run_sync('--rollback', 'a.py', '--apply', '--json', manifest=self.m)
        self.assertEqual(json.loads(r.stdout)['files'][0]['status'], 'restored')
        self.assertEqual((self.bin / 'a.py').read_text(), 'v1\n')


if __name__ == '__main__':
    unittest.main()
