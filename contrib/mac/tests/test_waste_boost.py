import ast
import json
from pathlib import Path
import unittest
from test_work_market import market

source = Path(__file__).resolve().parents[1] / 'dispatchd.py'
nodes = [n for n in ast.parse(source.read_text()).body
         if isinstance(n, ast.FunctionDef) and n.name in
         ('waste_risk', 'waste_boost', 'pace_behind', 'live_allowance', 'antigravity_window', 'promo_window')]
namespace = {'work_market': market}
exec(compile(ast.Module(body=nodes, type_ignores=[]), str(source), 'exec'), namespace)
EXECUTOR = {'cost_class': 'included', 'tiers': ['fast', 'mid', 'work', 'frontier']}


def boost(projection, lane, tier, executor=EXECUTOR):
    return namespace['waste_boost'](projection, lane, tier, executor)


class WasteBoost(unittest.TestCase):
    def test_ultra_short_window_requires_a_matching_fresh_personal_seat(self):
        scope = {'agy': {'account_kind': 'personal', 'plan': 'google-ai-ultra'}}
        row = {'id': 'antigravity', 'verified': True, 'unit': 'percent', 'lane': 'agy',
               'observed_at': 10000, 'stale_after': 10900, 'window_start': 9000, 'reset_at': 27000, 'used_pct': 42}
        read = namespace['antigravity_window']
        payload = {'schema': 'resource-live.v1', 'readings': [row]}
        reading = read(payload, scope, 10001)
        self.assertEqual(market.deadline_priority(reading, 10001, short_window=True), 27000)
        self.assertIsNone(read(payload, {'agy': {'account_kind': 'workspace', 'plan': 'workspace'}}, 10001))
        self.assertIsNone(read(payload, scope, 10900))
        self.assertIsNone(read(dict(payload, readings=[dict(row, reset_at=30000)]), scope, 10001))

    def test_promotional_priority_needs_fresh_unspent_credit_and_an_expiry(self):
        read = namespace['promo_window']
        row = {'id': 'claude-api', 'verified': True, 'unit': 'usd', 'class': 'metered-included',
               'observed_at': 10000, 'stale_after': 10900, 'expires_at': 27000, 'used': 42, 'limit': 200}
        payload = lambda reading: {'schema': 'resource-live.v1', 'readings': [reading]}
        self.assertEqual(market.deadline_priority(read(payload(row), 'claude-api', 10001), 10001, promotional=True), 27000)
        self.assertIsNone(read(payload(dict(row, used=200)), 'claude-api', 10001))
        self.assertIsNone(read(payload(dict(row, expires_at=None)), 'claude-api', 10001))
        self.assertIsNone(read(payload(row), 'claude-api', 10900))

    def test_risk_and_tier_table(self):
        for risk, expected in [('low', None), ('medium', 'work'), ('high', 'work'), ('unknown', None)]:
            for known in (True, False):
                with self.subTest(risk=risk, known=known):
                    result = boost({'known': known, 'stale': False, 'waste_risk': risk}, 'claude', 'mid')
                    self.assertEqual(result[0] if result else None, expected if known else None)
        evidence = {'known': True, 'stale': False, 'waste_risk': 'high'}
        self.assertEqual(boost(evidence, 'claude', 'work')[0], 'frontier')
        for lane, tier in [('devin', 'work'), ('claude', 'fast'), ('claude', 'frontier')]:
            self.assertIsNone(boost(evidence, lane, tier))
        self.assertIsNone(boost({**evidence, 'stale': True}, 'claude', 'work'))

    def test_dispatch_launch_records_reason_once(self):
        import json
        from test_dispatchd import build, launch_stubs, queue_job, tick
        tmp = build()
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name).resolve()
        env = launch_stubs(home)
        queue_job(home, 'RQ-WASTE-1', lane='claude', tier='work')
        script = home / '.ashlr-runs/bin/use-it-all.py'
        script.write_text('import json,time\nprint(json.dumps({"schema":"use-it-all.v1","ts":int(time.time()),"lanes":{"claude":{"known":True,"stale":False,"waste_risk":"high"}}}))\n')
        result = tick(home, env)
        self.assertEqual(result.returncode, 0, result.stderr)
        root = home / '.ashlr-runs'
        rows = [json.loads(line) for line in (root / 'metrics/jobs.jsonl').read_text().splitlines()]
        self.assertTrue(any(row.get('event') == 'launch' and row.get('job') == 'RQ-WASTE-1' and row.get('tier') == 'frontier' for row in rows))
        receipt = json.loads((root / 'queue/route-state.json').read_text())['RQ-WASTE-1']
        self.assertEqual(receipt['waste_reason'], 'use-it-all high waste risk: work -> frontier')
        self.assertEqual((root / 'dispatch-events.log').read_text().count('ROUTE_BOOST RQ-WASTE-1 '), 1)

    def test_behind_requires_fresh_boolean_evidence_and_available_included_tier(self):
        evidence = {'known': True, 'stale': False, 'behind': True}
        for lane in ('claude', 'codex-personal', 'gemini'):
            self.assertEqual(boost(evidence, lane, 'work')[0], 'frontier')
        for patch in ({'behind': False}, {'behind': None}, {'behind': 'true'}, {'known': False}, {'stale': True}):
            self.assertIsNone(boost({**evidence, **patch}, 'claude', 'work'))
        for value in (None, {}, [], {'known': True, 'stale': False}):
            self.assertIsNone(namespace['pace_behind'](value))
            self.assertIsNone(boost(value, 'claude', 'work'))
        self.assertIs(namespace['pace_behind']({**evidence, 'behind': False}), False)
        for patch in ({'held': True}, {'auth_failed': True}, {'backoff': True}, {'quota': 0},
                      {'cost_class': 'metered'}, {'cost_class': None}, {'tiers': ['work']}):
            self.assertIsNone(boost(evidence, 'claude', 'work', {**EXECUTOR, **patch}))
        for tier in ('mid', 'fast', 'frontier'):
            self.assertIsNone(boost(evidence, 'claude', tier))

    def test_behind_tick_preserves_holds_zero_paid_models_and_unknown(self):
        from test_dispatchd import build, held_lanes, lane_slot, launch_stubs, queue_job, tick
        cases = [('behind', True, {}, {}, 0, 'frontier'), ('on-pace', False, {}, {}, 0, 'work'),
                 ('held', True, {'held': True}, {}, 0, None),
                 ('paid', True, {'cost_class': 'metered'}, {}, 0, 'work'),
                 ('no-frontier', True, {}, {'claude.work': 'sonnet'}, 0, 'work'),
                 ('expired', True, {}, {}, -3600, 'work'), ('unknown', None, {}, {}, 0, 'work')]
        for name, behind, slot, models, age, expected in cases:
            with self.subTest(name=name):
                slots = held_lanes(); slots['claude'] = lane_slot(target=2, **slot)
                with build(slots=slots) as tmp:
                    home = Path(tmp).resolve(); root = home / '.ashlr-runs'; env = launch_stubs(home)
                    (root / 'models.json').write_text(json.dumps(models or {'claude.work': 'sonnet', 'claude.frontier': 'opus'}))
                    # Batchable peers must receive the upgraded tier themselves.
                    (root / 'queue/BATCH_OFF').unlink()
                    (root / 'bin/batch-launch.sh').write_text('#!/bin/bash\nexit 0\n')
                    for job in ('RQ-YIELD-A', 'RQ-YIELD-B'):
                        queue_job(home, job, 'claude')
                        (root / f'queue/prompts/{job}.md').write_text('Edit src/core/queue/store.ts.')
                    payload = {'schema': 'use-it-all.v1', 'lanes': {'claude':
                               {'known': True, 'stale': False, 'behind': behind}}}
                    (root / 'bin/use-it-all.py').write_text('import json,time\np=' + repr(payload)
                        + f'\np["ts"]=int(time.time())+{age}\nprint(json.dumps(p))\n')
                    result = tick(home, env); self.assertEqual(result.returncode, 0, result.stderr)
                    status = json.loads((root / 'queue/status.json').read_text())
                    launches = [r for r in map(json.loads, (root / 'metrics/jobs.jsonl').read_text().splitlines())
                                if r.get('event') == 'launch']
                    self.assertEqual({r['tier'] for r in launches}, {expected} if expected else set())
                    self.assertEqual(status['use_it_all_behind']['claude'], None if age else behind)
                    upgrades = status['tier_upgrades_this_tick']
                    self.assertEqual(len(upgrades), 2 if expected == 'frontier' else 0)
                    if upgrades:
                        self.assertEqual({r['job'] for r in launches}, {'RQ-YIELD-A', 'RQ-YIELD-B'})
                        self.assertEqual({r['model'] for r in launches}, {'opus'})
                        for row in upgrades:
                            self.assertEqual((row['lane'], row['from_tier'], row['to_tier']), ('claude', 'work', 'frontier'))
                            self.assertIn('behind pace', row['reason'])
                            receipt = json.loads((root / 'queue/route-state.json').read_text())[row['job']]
                            self.assertEqual(receipt['waste_reason'], row['reason'])
