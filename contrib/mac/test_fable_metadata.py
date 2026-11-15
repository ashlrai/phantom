"""Exercise the actual dispatcher metric writer without starting the dispatcher."""
import ast
import json
import pathlib
import re
import tempfile
import time
import unittest


class FableMetadataTest(unittest.TestCase):
    def test_sublane_survives_in_metrics_without_changing_the_claude_pool(self):
        source = pathlib.Path(__file__).with_name('dispatchd.py').read_text()
        tree = ast.parse(source)
        metric = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'metric')
        with tempfile.TemporaryDirectory() as root:
            def rd(path):
                try:
                    return pathlib.Path(path).read_text()
                except FileNotFoundError:
                    return ''
            scope = dict(R=root, Q=root, MD=root, re=re, json=json, time=time, rd=rd, _JOBS_LIVE=False)
            exec(compile(ast.Module(body=[metric], type_ignores=[]), 'dispatchd.metric', 'exec'), scope)
            pathlib.Path(root, 'J1.base.meta').write_text('MODEL claude frontier claude-fable-5-2\nSUBLANE claude:fable\n')
            for event in ('launch', 'finish'):
                scope['metric']({'event': event, 'job': 'J1', 'lane': 'claude'})
            scope['metric']({'event': 'finish', 'job': 'J1', 'lane': 'codex-personal'})
            pathlib.Path(root, 'J2.base.meta').write_text('NOT SUBLANE claude:fable\n')
            scope['metric']({'event': 'finish', 'job': 'J2', 'lane': 'claude'})
            rows = [json.loads(line) for line in pathlib.Path(root, 'jobs.jsonl').read_text().splitlines()]
            self.assertEqual([row.get('sublane') for row in rows], ['fable', 'fable', None, None])
            self.assertEqual([row['lane'] for row in rows], ['claude', 'claude', 'codex-personal', 'claude'])


if __name__ == '__main__':
    unittest.main()
