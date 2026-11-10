import ast
from pathlib import Path
import unittest

source = Path(__file__).resolve().parents[1] / 'dispatchd.py'
nodes = [n for n in ast.parse(source.read_text()).body
         if isinstance(n, ast.FunctionDef) and n.name in ('waste_risk', 'waste_boost')]
namespace = {}
exec(compile(ast.Module(body=nodes, type_ignores=[]), str(source), 'exec'), namespace)
boost = namespace['waste_boost']


class WasteBoost(unittest.TestCase):
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
