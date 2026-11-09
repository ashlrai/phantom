"""Fixture tests for contrib/mac/report-export.sh (RQ-REPORTS-NO-GROK-1).

Runs the wrapper against a synthetic HOME with a stub `phm` on PATH; nothing
touches the real ~/.ashlr-runs. Covers: argument shape handed to
`phm fleet report-export`, the no-CLI degrade, failure propagation and log
appending.
"""
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'report-export.sh'

STUB_PHM = ('#!/bin/bash\n'
            'printf \'%s\\n\' "$@" > "$HOME/phm-argv.txt"\n'
            'printf \'{"schema":"ashlr.report-export/v1","day":"x","entries":[]}\\n\'\n'
            'exit "${PHM_EXIT:-0}"\n')


def fixture(stub=True):
    tmp = tempfile.TemporaryDirectory()
    home = Path(tmp.name)
    bin_dir = home / 'stubbin'
    runs_bin = home / '.ashlr-runs' / 'bin'
    runs_bin.mkdir(parents=True)
    bin_dir.mkdir()
    if stub:
        phm = bin_dir / 'phm'
        phm.write_text(STUB_PHM)
        phm.chmod(0o755)
    return tmp, home


def run_wrapper(home, *args, extra_env=None):
    env = {'HOME': str(home), 'PATH': str(home / 'stubbin') + ':/usr/bin:/bin', 'LANG': 'C'}
    if extra_env:
        env.update(extra_env)
    return subprocess.run(['/bin/bash', str(SCRIPT), *args], env=env,
                          capture_output=True, text=True, timeout=30)


class ReportExportWrapperTests(unittest.TestCase):
    def test_invokes_phm_with_slot_runs_dir_and_json(self):
        tmp, home = fixture()
        self.addCleanup(tmp.cleanup)
        result = run_wrapper(home, '0730')
        self.assertEqual(result.returncode, 0, result.stderr)
        argv = (home / 'phm-argv.txt').read_text().splitlines()
        self.assertEqual(argv, ['fleet', 'report-export', '--slot', '0730',
                                '--runs-dir', str(home / '.ashlr-runs'), '--json'])
        log = home / '.ashlr-runs' / 'export' / 'report-export.log'
        self.assertTrue(log.exists())
        self.assertIn('ashlr.report-export/v1', log.read_text())

    def test_defaults_to_auto_slot(self):
        tmp, home = fixture()
        self.addCleanup(tmp.cleanup)
        result = run_wrapper(home)
        self.assertEqual(result.returncode, 0, result.stderr)
        argv = (home / 'phm-argv.txt').read_text().splitlines()
        self.assertEqual(argv[3], 'auto')

    def test_no_cli_logs_and_exits_zero(self):
        tmp, home = fixture(stub=False)
        self.addCleanup(tmp.cleanup)
        result = run_wrapper(home, '0730')
        self.assertEqual(result.returncode, 0)
        log = home / '.ashlr-runs' / 'export' / 'report-export.log'
        self.assertIn('no phm/ashlr binary on PATH', log.read_text())

    def test_cli_failure_propagates_and_logs(self):
        tmp, home = fixture()
        self.addCleanup(tmp.cleanup)
        result = run_wrapper(home, '2000', extra_env={'PHM_EXIT': '7'})
        self.assertEqual(result.returncode, 7)
        log = home / '.ashlr-runs' / 'export' / 'report-export.log'
        self.assertIn('exited 7', log.read_text())

    def test_ashlr_fallback_when_phm_absent(self):
        tmp, home = fixture(stub=False)
        self.addCleanup(tmp.cleanup)
        ashlr = home / 'stubbin' / 'ashlr'
        ashlr.write_text(STUB_PHM)
        ashlr.chmod(0o755)
        result = run_wrapper(home, '2000')
        self.assertEqual(result.returncode, 0, result.stderr)
        argv = (home / 'phm-argv.txt').read_text().splitlines()
        self.assertEqual(argv[:2], ['fleet', 'report-export'])


if __name__ == '__main__':
    unittest.main()
