"""Exercise the dispatcher's pure pacing policy without running a host tick."""
import ast
from pathlib import Path
import unittest

module = ast.parse((Path(__file__).parents[1] / 'dispatchd.py').read_text())
namespace = {}
exec(compile(ast.Module(body=[n for n in module.body if isinstance(n, ast.FunctionDef) and n.name == 'usage_verdict'], type_ignores=[]), '<pacing>', 'exec'), namespace)
verdict = namespace['usage_verdict']


class PacingTests(unittest.TestCase):
    def test_window_boundaries(self):
        now = 1800000000
        for elapsed, used, admit in [(0, 10, True), (0, 11, False), (.5, 60, True), (.5, 69, False), (.999999, 69, True)]:
            with self.subTest(elapsed=elapsed, used=used):
                self.assertEqual(verdict({'weekly_used_pct': used, 'reset_at': now + (1-elapsed)*604800}, now)['admit'], admit)

    def test_reserve_and_unknown_reset(self):
        for used, admit in [(69, True), (95, True), (96, False)]:
            self.assertEqual(verdict({'weekly_used_pct': used}, 1800000000, True)['admit'], admit)
        for reset in [None, 'bad', 1700000000]:
            self.assertFalse(verdict({'weekly_used_pct': 69, 'reset_at': reset}, 1800000000)['admit'])
        self.assertTrue(verdict({'weekly_used_pct': 60}, 1800000000)['admit'])

    def test_iso_and_missing_usage(self):
        self.assertTrue(verdict({'weekly_used_pct': 69, 'reset_at': '2027-01-15T09:00:01Z'}, 1800000000)['admit'])
        self.assertEqual(verdict({}, 1800000000)['reason'], 'usage unknown')

    def test_tick_defers_routine_but_admits_p0(self):
        import json
        from test_loadgate import ready_fixture, launched, admission
        from test_dispatchd import tick
        for priority, expected in [("", []), ("P0, ", ["RQ-GATE-0"]), ("critical, ", ["RQ-GATE-0"])]:
            with self.subTest(priority=priority):
                tmp, home = ready_fixture()
                self.addCleanup(tmp.cleanup)
                q = home / '.ashlr-runs' / 'queue'
                (q / 'budget-overrides.json').write_text(json.dumps({'devin': {'weekly_used_pct': 69}}))
                router = q / 'router-queue.md'
                router.write_text(router.read_text().replace('(pool=', '(' + priority + 'pool='))
                result = tick(home)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(launched(home), expected)
                self.assertFalse(admission(home)['lanes']['devin']['routine']['admit'])
                self.assertTrue(admission(home)['lanes']['devin']['critical']['admit'])
