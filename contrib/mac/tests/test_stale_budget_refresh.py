import ast
import json
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace

SOURCE = Path(__file__).resolve().parents[1] / 'host-integration' / 'dispatchd.candidate.py'


class StaleBudgetRefresh(unittest.TestCase):
    def test_stale_refresh_and_unavailable_ledger(self):
        tree = ast.parse(SOURCE.read_text())
        function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'refresh_stale_budget')
        calls = []
        def run(command, timeout):
            calls.append(command)
            return SimpleNamespace(returncode=0, stdout=json.dumps({'resources': [{'state': 'current',
                'weekly': {'usedPct': 23, 'resetsAt': '2030-01-01T00:00:00Z'}}]}))
        scope = {'json': json, 'subprocess': subprocess, '_run': run}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(SOURCE), 'exec'), scope)
        refresh = scope['refresh_stale_budget']
        stale = {'known': True, 'stale': True, 'behind': True, 'used_pct': 99}
        refreshed = refresh('codex-personal', stale)
        self.assertEqual(refreshed['used_pct'], 23)
        self.assertTrue(refreshed['known'])
        self.assertFalse(refreshed['behind'])
        self.assertEqual(calls[0], ['phm', 'resources', 'personal', '--refresh', '--json'])
        scope['_run'] = lambda *a, **kw: (_ for _ in ()).throw(subprocess.TimeoutExpired('phm', 12))
        ledger = {'use_it_all': refresh('codex-personal', stale)}
        self.assertEqual(ledger['use_it_all'], {'known': False, 'stale': True, 'behind': False,
                                                 'reason': 'Usage refresh unavailable'})
        self.assertNotIn('ask Mason for a fresh reading', SOURCE.read_text())

    def test_other_pool_rereads_projection_and_fails_closed(self):
        tree = ast.parse(SOURCE.read_text())
        function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'refresh_stale_budget')
        import time
        fresh = {'known': True, 'stale': False, 'behind': True, 'used_pct': 12}
        payload = {'schema': 'use-it-all.v1', 'ts': int(time.time()), 'lanes': {'claude': fresh}}
        scope = {'json': json, 'subprocess': subprocess, 'time': time, 'R': '/tmp',
                 'UIA_KEYS': ('known', 'stale', 'behind', 'used_pct'),
                 '_run': lambda *a, **kw: SimpleNamespace(returncode=0, stdout=json.dumps(payload))}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(SOURCE), 'exec'), scope)
        refresh = scope['refresh_stale_budget']
        self.assertEqual(refresh('claude', {'stale': True}), fresh)
        payload['lanes']['claude']['stale'] = True
        self.assertEqual(refresh('claude', {'stale': True})['known'], False)


if __name__ == '__main__':
    unittest.main()
