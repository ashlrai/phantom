"""Exercise the commissioned candidate's sample expressions with inert OS ports."""
import ast
from pathlib import Path
import re
import types
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'host-integration' / 'dispatchd.candidate.py'


class HostMachineSampleTests(unittest.TestCase):
    def test_stale_budget_message_does_not_request_a_person(self):
        source = SOURCE.read_text()
        self.assertIn('STALE_BUDGET %s reset passed; fresh reading unavailable', source)
        self.assertNotIn('ask Mason for a fresh reading', source)

    def test_sample_starts_before_os_reads_and_preserves_existing_values(self):
        tree = ast.parse(SOURCE.read_text())
        nodes = tree.body
        mem = next(node for node in nodes if isinstance(node, ast.FunctionDef) and node.name == 'mem')
        index = next(i for i, node in enumerate(nodes) if isinstance(node, ast.Assign) and
                     any(isinstance(target, ast.Name) and target.id == 'machine_sample_started_ms' for target in node.targets))
        self.assertIsInstance(nodes[index + 1], ast.Assign)
        self.assertIsInstance(nodes[index + 1].value, ast.Call)
        self.assertEqual(nodes[index + 1].value.func.id, 'mem')
        clock = types.SimpleNamespace(now=100.0)
        def now():
            clock.now += 1
            return clock.now
        calls = []
        def run(argv, **_kwargs):
            calls.append((argv, int(now() * 1000)))
            return types.SimpleNamespace(stdout='System-wide memory free percentage: 46%' if argv == ['memory_pressure']
                                         else 'total = 2048M used = 1024M free = 1024M')
        env = {'time': types.SimpleNamespace(time=now), 'subprocess': types.SimpleNamespace(run=run), 're': re}
        module = ast.fix_missing_locations(ast.Module(body=[mem, nodes[index], nodes[index + 1]], type_ignores=[]))
        exec(compile(module, str(SOURCE), 'exec'), env)
        status = next(node.value for node in nodes if isinstance(node, ast.Assign) and
                      any(isinstance(target, ast.Name) and target.id == 'st' for target in node.targets))
        pairs = {key.value: value for key, value in zip(status.keys, status.values) if isinstance(key, ast.Constant)}
        evaluate = lambda node: eval(compile(ast.fix_missing_locations(ast.Expression(node)), str(SOURCE), 'eval'), env)
        self.assertEqual(evaluate(pairs['mem_free_pct']), 46)
        self.assertEqual(evaluate(pairs['swap_gb']), 1.0)
        self.assertEqual(evaluate(pairs['machine_sample']), {'schema': 'dispatchd.machine-sample.v1',
            'startedAtMs': 101000, 'memoryPressureFreePct': 46, 'swapUsedGiB': 1.0})
        self.assertEqual([call[0] for call in calls], [['memory_pressure'], ['sysctl', '-n', 'vm.swapusage']])
        self.assertLess(env['machine_sample_started_ms'], calls[0][1])


if __name__ == '__main__':
    unittest.main()
