"""Offline replay of reported incident counts; no claim to raw host events."""
import ast
from pathlib import Path
import unittest

source = Path(__file__).resolve().parents[1] / 'dispatchd.py'
node = next(n for n in ast.parse(source.read_text()).body
            if isinstance(n, ast.FunctionDef) and n.name == 'route_decision')
namespace = {}
exec(compile(ast.Module(body=[node], type_ignores=[]), str(source), 'exec'), namespace)
decide = namespace['route_decision']


class RouteHysteresis(unittest.TestCase):
    def test_incident_count_replay(self):
        for job, count in [('RQ-TEAM-IDENTITY-1', 16),
                           ('RQ-DRAIN-phantom-697-R2', 12),
                           ('RQ-LOCAL-EVAL-BENCH', 11)]:
            for down in (False, True):
                record = None
                moves = 0
                for i in range(count):
                    proposed = 'claude' if i % 2 else 'codex-cmp'
                    previous = record
                    record, reason = decide(record, proposed, i * 3599 / count, down)
                    moves += bool(previous and previous['pool'] != record['pool'])
                self.assertLessEqual(moves, 2, job)
                print(f'{job}: {count} proposals, hard_down={down}, {moves} moves')

    def test_boundaries_cap_and_launch(self):
        r, _ = decide(None, 'a', 0)
        self.assertEqual(decide(r, 'b', 3599)[1], 'minimum_residency')
        r, why = decide(r, 'b', 3600)
        self.assertIsNone(why)
        r, _ = decide(r, 'a', 3601, True)
        self.assertEqual(decide(r, 'b', 7201, True)[1], 'move_cap')
        self.assertIsNone(decide(r, 'b', 25200, True)[1])
        locked, why = decide(r, 'b', 99999, True, True)
        self.assertEqual(why, 'launched')
        self.assertEqual(decide(locked, 'b', 100000, True)[1], 'launched')
        self.assertEqual(decide(r, 'a', 99999)[0]['decided_at'], 3601)

    def test_dispatcher_persists_holds_and_launch_lock(self):
        from test_dispatchd import build, tick
        import json
        import time
        tmp = build(ready=['job\tphantom\tcodex-cmp\twork\tunused'])
        self.addCleanup(tmp.cleanup)
        q = Path(tmp.name) / '.ashlr-runs/queue'
        (q.parent / 'PAUSE').write_text('fixture pause')
        tick(tmp.name).check_returncode()
        def propose(pool):
            (q / 'ready.tsv').write_text(f'job\tphantom\t{pool}\twork\tunused\n')
            tick(tmp.name).check_returncode()
            return json.loads((q / 'route-state.json').read_text())['job']
        self.assertEqual(propose('claude')['pool'], 'codex-cmp')
        state = {'job': {'pool': 'codex-cmp', 'decided_at': time.time() - 3700,
                         'moves': [time.time() - 500, time.time() - 400]}}
        (q / 'route-state.json').write_text(json.dumps(state))
        self.assertEqual(propose('claude')['pool'], 'codex-cmp')
        events = (q.parent / 'dispatch-events.log').read_text()
        self.assertIn('ROUTE_HOLD job codex-cmp->claude reason=move_cap', events)
        state['job']['moves'] = []
        (q / 'route-state.json').write_text(json.dumps(state))
        (q / 'run/job.line').write_text('job\tphantom\tcodex-cmp\twork\tunused\n')
        self.assertEqual(propose('claude')['pool'], 'codex-cmp')
        self.assertIn('reason=launched', (q.parent / 'dispatch-events.log').read_text())

    def test_hard_down_evidence_and_corrupt_history(self):
        from test_dispatchd import build, tick
        import json
        import time
        tmp = build()
        self.addCleanup(tmp.cleanup)
        q = Path(tmp.name) / '.ashlr-runs/queue'
        (q.parent / 'PAUSE').write_text('fixture pause')
        for evidence, expected in [({'quota': False}, 'codex-cmp'),
                                   ({'held': True}, 'codex-cmp'),
                                   ({'quota': 0}, 'claude'),
                                   ({'auth_failed': True}, 'claude')]:
            state = {'job': {'pool': 'codex-cmp', 'decided_at': time.time(), 'moves': []}}
            (q / 'route-state.json').write_text(json.dumps(state))
            (q / 'slots.json').write_text(json.dumps({'codex-cmp': evidence}))
            (q / 'ready.tsv').write_text('job\tphantom\tclaude\twork\tunused\n')
            tick(tmp.name).check_returncode()
            self.assertEqual(json.loads((q / 'route-state.json').read_text())['job']['pool'], expected)
        (q / 'route-state.json').write_text('{broken')
        self.assertEqual(tick(tmp.name).returncode, 1)
        self.assertEqual((q / 'route-state.json').read_text(), '{broken')
