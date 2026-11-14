"""Shared market contracts plus real dispatcher ticks, all in synthetic homes."""
import ast
import json
from pathlib import Path
import sys
import time
import unittest

MAC = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MAC))
import work_market as market
from test_dispatchd import build, tick, queue_job, launch_stubs, held_lanes, dispatched

node = next(n for n in ast.parse((MAC / 'dispatchd.py').read_text()).body
            if isinstance(n, ast.FunctionDef) and n.name == 'route_decision')
scope = {}
exec(compile(ast.Module(body=[node], type_ignores=[]), 'dispatchd.py', 'exec'), scope)
decide = scope['route_decision']


def view(**overrides):
    slots = {lane: {'target': 2, **overrides.get(lane, {})} for lane in ('codex-personal', 'claude')}
    return market.lane_view(list(slots), slots, dict.fromkeys(slots, 0), dict.fromkeys(slots, 2), set(), {}, {}, [])


class MarketUnit(unittest.TestCase):
    def choose(self, spec=None, lanes=None, record=None, now=10000):
        req = market.requirements(['j', 'phantom', '', 'work', 'p', json.dumps(spec or {})])
        return market.choose('j', req, 'work', lanes or view(), record, now, decide)

    def test_capability_and_secret_names_fail_closed(self):
        result, _ = self.choose({'needs': ['claude-cli']})
        self.assertEqual(result['chosen_lane'], 'claude')
        self.assertIn('missing_capability', result['rejected_lanes'][0]['reason_codes'])
        self.assertIsNone(self.choose({'needs': ['browser', 'secrets:TEST_KEY']})[0]['chosen_lane'])
        lanes = view(claude={'capabilities': ['browser', 'secrets:TEST_KEY']})
        self.assertEqual(self.choose({'needs': ['browser', 'secrets:TEST_KEY']}, lanes)[0]['chosen_lane'], 'claude')

    def test_quota_and_backoff_exclude_preferred_lane(self):
        for prop in ({'quota': 0}, {'auth_failed': True}, {'backoff': True}, {'held': True}):
            result, _ = self.choose({'preferred_lane': 'codex-personal'}, view(**{'codex-personal': prop}))
            self.assertEqual(result['chosen_lane'], 'claude')
            self.assertIn('preferred_lane_fallback', result['reason_codes'])
        self.assertEqual(self.choose(lanes=view(**{'codex-personal': {'quota': False}}))[0]['chosen_lane'], 'codex-personal')

    def test_capacity_rechecked_and_unknown_hints_are_open(self):
        lanes = view()
        lanes['codex-personal']['running'] = 2
        result, _ = self.choose({'preferred_lane': 'codex-personal'}, lanes)
        self.assertEqual(result['chosen_lane'], 'claude')
        self.assertEqual(self.choose({'preferred_lane': 'retired-lane'})[0]['chosen_lane'], 'codex-personal')

    def test_tier_and_cost_constraints(self):
        lanes = view(**{'codex-personal': {'tiers': ['fast'], 'cost_class': 'local'}, 'claude': {'cost_class': 'metered'}})
        result, _ = self.choose({'max_cost_class': 'included'}, lanes)
        self.assertIsNone(result['chosen_lane'])
        reasons = {r['lane']: r['reason_codes'] for r in result['rejected_lanes']}
        self.assertIn('tier_unavailable', reasons['codex-personal'])
        self.assertIn('cost_class_exceeded', reasons['claude'])

    def test_fresh_quality_and_latency_signals_rank_eligible_executors(self):
        slots = {l: {'target': 2} for l in ('codex-personal', 'claude')}
        adaptive = {'ts': 10000, 'lanes': {'codex-personal': {'empty_rate': 0.9}, 'claude': {'empty_rate': 0.1, 'yield_rate': 0.9, 'model_latency_s': 20}}}
        lanes = market.lane_view(list(slots), slots, dict.fromkeys(slots, 0), dict.fromkeys(slots, 2), set(), {}, {}, [], adaptive, 10000)
        result, _ = self.choose(lanes=lanes)
        self.assertEqual(result['chosen_lane'], 'claude')
        self.assertEqual(result['ranking_inputs']['claude']['latency_s'], 20)
        stale = market.lane_view(list(slots), slots, dict.fromkeys(slots, 0), dict.fromkeys(slots, 2), set(), {}, {}, [], adaptive, 10400)
        self.assertIsNone(stale['claude']['empty_rate'])

    def test_budget_zero_and_model_tier_contract_exclude_an_executor(self):
        slots = {l: {'target': 2} for l in ('codex-personal', 'claude')}
        lanes = market.lane_view(list(slots), slots, dict.fromkeys(slots, 0), dict.fromkeys(slots, 2), set(), {'codex.fast': 'fixture'}, {'claude': {'remaining_pct': 0}}, [])
        result, _ = self.choose(lanes=lanes)
        self.assertIsNone(result['chosen_lane'])
        reasons = {r['lane']: r['reason_codes'] for r in result['rejected_lanes']}
        self.assertIn('tier_unavailable', reasons['codex-personal'])
        self.assertIn('quota_exhausted', reasons['claude'])

    def test_hysteresis_hard_down_move_cap_and_launch_fence(self):
        record = {'pool': 'codex-personal', 'decided_at': 9999, 'moves': []}
        lanes = view(); lanes['codex-personal']['running'] = 2
        result, _ = self.choose(lanes=lanes, record=record)
        self.assertIsNone(result['chosen_lane'])
        self.assertIn('hysteresis_minimum_residency', result['reason_codes'])
        self.assertEqual(self.choose(lanes=lanes, record=record, now=14000)[0]['chosen_lane'], 'claude')
        lanes['codex-personal']['auth_failed'] = True
        result, moved = self.choose(lanes=lanes, record=record)
        self.assertEqual(result['chosen_lane'], 'claude')
        self.assertEqual(moved['moves'], [10000])
        for extra, reason in [({'moves': [9900, 9950]}, 'move_cap'), ({'launched': True}, 'launched')]:
            result, _ = self.choose(lanes=lanes, record={**record, **extra})
            self.assertIsNone(result['chosen_lane'])
            self.assertIn('hysteresis_' + reason, result['reason_codes'])
        first, _ = decide(None, 'claude', 1, launched=True)
        self.assertEqual(decide(first, 'codex-personal', 9000, True)[1], 'launched')

    def test_invalid_requirements_never_become_open_work(self):
        for spec in ({'needs': 'git'}, {'needs': ['secrets:bad=value']}, {'exclusive': 'true'}, {'min_tier': 'standard'}, {'impact': float('nan')}, {'max_cost_class': 'unknown'}, {'surprise': True}):
            with self.assertRaises((ValueError, TypeError)):
                market.requirements(['j', 'r', '', 'work', 'p', json.dumps(spec)])

    def test_priority_precedes_impact_and_noise(self):
        specs = [{'priority': 'P2', 'impact': 999}, {'priority': 'P0', 'impact': 1}, {'priority': 'P0', 'impact': 9}]
        self.assertEqual(sorted(specs, key=market.priority), [specs[2], specs[1], specs[0]])


class MarketTick(unittest.TestCase):
    def fixture(self, targets=None):
        slots = held_lanes()
        for lane, target in (targets or {'codex-personal': 1, 'claude': 1}).items():
            slots[lane] = {'target': target, 'floor': 0, 'ceiling': target, 'hard_cap': target, 'last_change': int(1e15)}
        tmp = build(slots=slots); self.addCleanup(tmp.cleanup)
        home = Path(tmp.name).resolve(); launch_stubs(home)
        return home, home / '.ashlr-runs/queue'

    def add(self, home, job, lane='', **spec):
        queue_job(home, job, lane, size=20)
        q = home / '.ashlr-runs/queue'
        rows = (q / 'ready.tsv').read_text().splitlines()
        rows[-1] += '\t' + json.dumps(spec)
        (q / 'ready.tsv').write_text('\n'.join(rows) + '\n')

    def rows(self, home):
        return [json.loads(row) for row in (home / '.ashlr-runs/metrics/work-market.jsonl').read_text().splitlines()]

    def run_tick(self, home):
        result = tick(home)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_no_lane_and_saturated_preference_use_both_executors(self):
        home, q = self.fixture()
        self.add(home, 'RQ-MARKET-A', needs=['git', 'node'])
        self.add(home, 'RQ-MARKET-B', lane='codex-personal', preferred_lane='codex-personal')
        self.run_tick(home)
        rows = self.rows(home)
        self.assertEqual([r['chosen_lane'] for r in rows], ['codex-personal', 'claude'])
        self.assertIn('preferred_lane_fallback', rows[1]['reason_codes'])
        for job, lane in [('RQ-MARKET-A', 'codex-personal'), ('RQ-MARKET-B', 'claude')]:
            self.assertTrue(dispatched(home, job))
            state = json.loads((q / 'route-state.json').read_text())[job]
            self.assertEqual(state['pool'], lane)
            self.assertTrue(state['launched'])
        self.assertEqual((q / 'ready.tsv').read_text(), '')
        self.run_tick(home)
        self.assertEqual(len(self.rows(home)), 2)

    def test_legacy_lane_still_launches_and_unknown_lane_is_a_hint(self):
        home, q = self.fixture()
        queue_job(home, 'RQ-LEGACY', 'codex-personal', size=20)
        queue_job(home, 'RQ-UNKNOWN', 'retired-lane', size=20)
        self.run_tick(home)
        self.assertEqual([r['chosen_lane'] for r in self.rows(home)], ['codex-personal', 'claude'])
        self.assertTrue(dispatched(home, 'RQ-LEGACY'))
        self.assertTrue(dispatched(home, 'RQ-UNKNOWN'))

    def test_priority_runs_before_rebase_noise_and_blocked_capability(self):
        home, q = self.fixture({'codex-personal': 1})
        self.add(home, 'LAND-NOISE', priority='P2', impact=500)
        self.add(home, 'RQ-IMPORTANT', priority='P0', impact=10)
        self.add(home, 'RQ-BLOCKED', priority='P0', impact=20, needs=['browser'])
        self.run_tick(home)
        self.assertTrue(dispatched(home, 'RQ-IMPORTANT'))
        self.assertFalse(dispatched(home, 'LAND-NOISE'))
        self.assertFalse(dispatched(home, 'RQ-BLOCKED'))
        self.assertEqual(self.rows(home)[0]['reason_codes'], ['no_runnable_lane'])

    def test_recovered_launch_receipt_cannot_move_to_another_lane(self):
        home, q = self.fixture({'claude': 1})
        self.add(home, 'RQ-LOCKED', preferred_lane='claude')
        (q / 'run/RQ-LOCKED.line').write_text(f'RQ-LOCKED\tphantom\tcodex-personal\twork\t{q}/prompts/RQ-LOCKED.md\n')
        self.run_tick(home)
        self.assertFalse(dispatched(home, 'RQ-LOCKED'))
        self.assertIn('hysteresis_launched', self.rows(home)[0]['reason_codes'])

    def test_restock_carries_requirements_to_dispatch(self):
        from test_restock import restock
        home, q = self.fixture()
        (q / 'admission.json').write_text(json.dumps({'cap': 100}))
        (q / 'router-queue.md').write_text('- READY RQ-RESTOCK (P0, repo=phantom, tier=work, needs=claude-cli, max_cost_class=included, exclusive=true, impact=7): Update docs.\n')
        result = restock(home)
        self.assertEqual(result.returncode, 0, result.stderr)
        fields = (q / 'ready.tsv').read_text().strip().split('\t')
        self.assertEqual(json.loads(fields[5])['needs'], ['claude-cli'])
        self.run_tick(home)
        self.assertEqual(self.rows(home)[0]['chosen_lane'], 'claude')
        self.assertTrue(dispatched(home, 'RQ-RESTOCK'))

    def test_advertised_executor_joins_without_a_new_lane_constant(self):
        home, q = self.fixture({'cursor': 1})
        slots = json.loads((q / 'slots.json').read_text())
        slots['cursor'].update(executor_ready=True, capabilities=['git', 'gh', 'node', 'browser'], tiers=['work'], cost_class='included')
        (q / 'slots.json').write_text(json.dumps(slots))
        self.add(home, 'RQ-REGISTERED', needs=['browser'])
        self.run_tick(home)
        self.assertEqual(self.rows(home)[0]['chosen_lane'], 'cursor')
        self.assertTrue(dispatched(home, 'RQ-REGISTERED'))

    def test_retired_executor_receipts_do_not_block_the_rest_of_the_market(self):
        home, q = self.fixture({'claude': 1})
        (q / 'route-state.json').write_text(json.dumps({'RQ-OLD': {'pool': 'retired-executor', 'decided_at': time.time(), 'moves': [], 'launched': True}}))
        self.add(home, 'RQ-NEW', needs=['claude-cli'])
        self.run_tick(home)
        self.assertTrue(dispatched(home, 'RQ-NEW'))
        self.assertTrue(json.loads((q / 'route-state.json').read_text())['RQ-OLD']['launched'])


if __name__ == '__main__':
    unittest.main()
