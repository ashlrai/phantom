"""Typed router shadow integration: isolated HOME, fake CLI, no model/network calls."""
import json
from pathlib import Path
import unittest

from test_dispatchd import events, tick
from test_loadgate import ready_fixture


class TypedRouteObservation(unittest.TestCase):
    def fixture(self, response=None, exit_code=0):
        tmp, home = ready_fixture(n=2)
        self.addCleanup(tmp.cleanup)
        binary = home / '.local' / 'bin' / 'phm'
        binary.parent.mkdir(parents=True)
        binary.write_text('#!/usr/bin/env python3\nimport json, pathlib, sys\n'
                          'request = json.load(sys.stdin)\n'
                          f'pathlib.Path({str(home / "observed-request.json")!r}).write_text(json.dumps(request))\n'
                          f'print({json.dumps(response)!r})\nsys.exit({exit_code})\n')
        binary.chmod(0o755)
        return home

    @staticmethod
    def records(home):
        return [json.loads(line) for line in (home / '.ashlr-runs' / 'metrics' / 'route.explain.jsonl').read_text().splitlines()]

    def test_successful_advice_never_changes_launch_lane_or_tier(self):
        home = self.fixture({'schema': 'route.decision.v1', 'advisory': True,
                             'lane': 'claude', 'model': 'claude-opus-5', 'effort': 'xhigh',
                             'speed_tier': 'premium', 'reason_codes': ['local-fast'], 'duration_ms': 20})
        result = tick(home)
        self.assertEqual(result.returncode, 0, result.stderr)
        launched = [line for line in events(home).splitlines() if ' LAUNCH ' in line]
        self.assertEqual(len(launched), 2)
        self.assertTrue(all('phantom devin work' in line for line in launched), launched)
        records = self.records(home)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['status'], 'observed')
        self.assertEqual(records[0]['decision']['lane'], 'claude')
        self.assertEqual(records[0]['duration_ms'], 20)
        request = json.loads((home / 'observed-request.json').read_text())
        self.assertEqual(request['task_class'], 'other')
        self.assertNotIn('prompt', json.dumps(request))

    def test_unavailable_cli_does_not_hold_launches(self):
        home = self.fixture(exit_code=1)
        result = tick(home)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sum(' LAUNCH ' in line for line in events(home).splitlines()), 2)
        self.assertEqual(self.records(home)[0]['status'], 'unavailable')

    def test_invalid_output_is_not_persisted_and_blocked_admission_stays_blocked(self):
        home = self.fixture({'schema': 'route.decision.v1', 'advisory': True,
                             'lane': 'do not persist untrusted text', 'model': None,
                             'reason_codes': ['untrusted content']})
        result = tick(home, {'LOADGATE_LOADAVG': '999'})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(' LAUNCH ', events(home))
        records = self.records(home)
        self.assertEqual(records[0]['status'], 'unavailable')
        self.assertNotIn('untrusted', json.dumps(records))
        self.assertFalse(json.loads((home / 'observed-request.json').read_text())['machine_state']['admit'])


if __name__ == '__main__':
    unittest.main()
