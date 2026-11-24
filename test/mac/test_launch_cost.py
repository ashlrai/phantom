import importlib.util
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('launch_cost', pathlib.Path(__file__).resolve().parents[2] / 'contrib/mac/launch_cost.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class LaunchCostTest(unittest.TestCase):
    def sample(self, missing=False, delay=0, lose=False, verify=True, degrade=False):
        clock = [100 + delay]
        claim = {'jobId': 'RQ-1', 'start': format(100, '064x'), 'startSource': 'ps-lstart'}
        row = {'jobId': 'RQ-1', 'state': 'unknown' if missing else 'known', 'processCount': 3, 'cpuPercentOneCore': 125}
        with patch.object(m.runtime, 'read_claims', side_effect=[[claim], [claim], []] if lose else None, return_value=[claim]), patch.object(m.runtime, 'verify_current_claim', return_value=verify), patch.object(m.runtime, 'collect_observation', side_effect=[{'sessions': [row]}] + [{'sessions': []}] * 11 if degrade else None, return_value={'sessions': [row]}):
            return m.measure('/unused', 'RQ-1', 'codex-cmp', now=lambda: clock[0], sleep=lambda seconds: clock.__setitem__(0, clock[0] + seconds), monotonic=lambda: clock[0])

    def test_full_window_and_unknown(self):
        result = self.sample()
        self.assertEqual((result['status'], result['samples'], result['sampledSeconds'], result['peakProcesses'], result['meanCpuPercentOneCore']), ('measured', 12, 60, 3, 125))
        self.assertEqual(self.sample(delay=10)['status'], 'partial')
        result = self.sample(missing=True)
        self.assertEqual((result['status'], result['samples'], result['peakProcesses']), ('unknown', 0, None))
        self.assertEqual(self.sample(delay=61)['status'], 'unknown')
        self.assertEqual((self.sample(verify=False)['status'], self.sample(verify=False)['startedAt']), ('unknown', None))
        self.assertEqual(self.sample(degrade=True)['status'], 'partial')
        result = self.sample(lose=True)
        self.assertEqual((result['status'], result['samples']), ('partial', 1))

    def test_private_append_and_symlink_refusal(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = os.path.realpath(tmp); os.mkdir(root + '/metrics')
            m.append(root, self.sample()); ledger = root + '/metrics/launch-cost.jsonl'
            self.assertEqual(os.stat(ledger).st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(pathlib.Path(ledger).read_text())['status'], 'measured')
            os.unlink(ledger); os.symlink(root + '/target', ledger)
            with self.assertRaises(OSError): m.append(root, self.sample())
