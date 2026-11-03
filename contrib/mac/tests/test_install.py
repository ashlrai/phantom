"""Tests for contrib/mac/install.sh and launch-gate.sh (RQ-MACDISPATCH-RECONCILE).

install.sh always targets a temp --bin directory under a temp HOME; the real ~/.ashlr-runs/bin is never read or written.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

MAC = Path(__file__).resolve().parents[1]
INSTALL = MAC / 'install.sh'
FILES = ('dispatchd.py', 'local_job.py', 'restock.py', 'launch_precheck.py', 'install-gate.py', 'launch-gate.sh')


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


class InstallTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name).resolve()
        self.bin = self.home / '.ashlr-runs' / 'bin'
        self.bin.mkdir(parents=True)

    def run_install(self, *args):
        env = {'HOME': str(self.home), 'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'LANG': 'C'}
        return subprocess.run(['/bin/bash', str(INSTALL), '--bin', str(self.bin), *args], env=env,
                              capture_output=True, text=True, timeout=60)

    def test_installs_new_files_equal_to_repo(self):
        r = self.run_install('--json')
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        self.assertTrue(out['ok'])
        self.assertEqual([f['status'] for f in out['files']], ['installed'] * len(FILES))
        for f in FILES:
            self.assertEqual(sha(self.bin / f), sha(MAC / f), f)
        self.assertFalse([p for p in self.bin.iterdir() if '.bak-' in p.name or '.tmp.' in p.name])

    def test_dry_run_writes_nothing(self):
        (self.bin / 'dispatchd.py').write_text('old\n')
        r = self.run_install('--dry-run', '--json')
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        self.assertTrue(out['dry_run'])
        by = {f['file']: f for f in out['files']}
        self.assertEqual(by['dispatchd.py']['status'], 'changed')
        self.assertEqual(by['install-gate.py']['status'], 'new')
        self.assertEqual((self.bin / 'dispatchd.py').read_text(), 'old\n')
        self.assertEqual(sorted(p.name for p in self.bin.iterdir()), ['dispatchd.py'])

    def test_changed_file_is_backed_up_then_replaced_and_rerun_is_a_no_op(self):
        (self.bin / 'dispatchd.py').write_text('old live copy\n')
        r = self.run_install('--json')
        self.assertEqual(r.returncode, 0, r.stderr)
        by = {f['file']: f for f in json.loads(r.stdout)['files']}
        backup = Path(by['dispatchd.py']['backup'])
        self.assertRegex(backup.name, r'^dispatchd\.py\.bak-macdispatch-\d{8}-\d{6}$')
        self.assertEqual(backup.read_text(), 'old live copy\n')
        self.assertEqual(by['dispatchd.py']['old_sha256'], hashlib.sha256(b'old live copy\n').hexdigest())
        self.assertEqual(sha(self.bin / 'dispatchd.py'), sha(MAC / 'dispatchd.py'))
        again = json.loads(self.run_install('--json').stdout)
        self.assertEqual({f['status'] for f in again['files']}, {'unchanged'})
        self.assertEqual(len(list(self.bin.glob('dispatchd.py.bak-*'))), 1)

    def test_human_output_shows_a_diff(self):
        (self.bin / 'dispatchd.py').write_text('old live copy\n')
        r = self.run_install('--dry-run')
        self.assertIn('-old live copy', r.stdout)
        self.assertIn('dispatchd.py: changed', r.stdout)

    def test_missing_bin_dir_and_bad_args_fail(self):
        self.bin.rmdir()
        self.assertEqual(self.run_install().returncode, 1)
        self.bin.mkdir()
        self.assertEqual(self.run_install('--bogus').returncode, 2)

    def test_symlink_destination_is_refused(self):
        target = self.home / 'elsewhere'
        target.write_text('keep\n')
        (self.bin / 'dispatchd.py').symlink_to(target)
        r = self.run_install('--json')
        self.assertEqual(r.returncode, 1)
        self.assertEqual({f['file']: f['status'] for f in json.loads(r.stdout)['files']}['dispatchd.py'], 'error')
        self.assertEqual(target.read_text(), 'keep\n')


class LaunchGateTests(unittest.TestCase):
    def test_sourcing_prefixes_path_with_working_shims(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d).resolve()
            bin_ = home / 'bin'
            bin_.mkdir()
            for f in ('install-gate.py', 'launch-gate.sh'):
                (bin_ / f).write_bytes((MAC / f).read_bytes())
            env = {'HOME': str(home), 'PATH': '/usr/bin:/bin', 'ASHLR_RUNS_BIN': str(bin_), 'ASHLR_RUNS_DIR': str(home / 'runs')}
            r = subprocess.run(['/bin/bash', '-c', f'. "{bin_}/launch-gate.sh"; echo "$PATH"; ls "{home}/runs/install-shims"'],
                               env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(r.returncode, 0, r.stderr)
            path, shims = r.stdout.splitlines()[0], r.stdout.splitlines()[1:]
            self.assertTrue(path.startswith(f'{home}/runs/install-shims:'), path)
            self.assertEqual(sorted(shims), ['bun', 'npm', 'pnpm'])

    def test_missing_gate_fails_open(self):
        with tempfile.TemporaryDirectory() as d:
            env = {'HOME': d, 'PATH': '/usr/bin:/bin', 'ASHLR_RUNS_BIN': d + '/none', 'ASHLR_RUNS_DIR': d + '/runs'}
            r = subprocess.run(['/bin/bash', '-c', f'. "{MAC}/launch-gate.sh"; echo "$PATH"'], env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual((r.returncode, r.stdout.strip()), (0, '/usr/bin:/bin'))


if __name__ == '__main__':
    unittest.main()
