"""Hermetic oMLX admission, completion/reap and endpoint security fixtures."""
import ast
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest
import time
from unittest.mock import patch
from test_dispatchd import build, tick, queue_job, launch_stubs, slots_of, SCRIPT


class OmlxTests(unittest.TestCase):
    def test_endpoint_refuses_remote_and_redirect_without_contact(self):
        tree = ast.parse(SCRIPT.read_text())
        fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'loopback_health')
        scope = {}
        exec(compile(ast.Module(body=[fn], type_ignores=[]), str(SCRIPT), 'exec'), scope)
        with patch('urllib.request.OpenerDirector.open') as request:
            for url in ('http://192.0.2.1:8000/v1/models', 'http://localhost:8000/v1/models',
                        'http://127.0.0.1.evil.invalid/models', 'http://user@127.0.0.1/models'):
                self.assertFalse(scope['loopback_health'](url))
            request.assert_not_called()
        import urllib.request
        with patch('urllib.request.OpenerDirector.open', side_effect=OSError('offline')):
            self.assertFalse(scope['loopback_health']('http://127.0.0.1:8000/models'))
        with patch('urllib.request.build_opener', wraps=urllib.request.build_opener) as build_opener:
            with patch('urllib.request.OpenerDirector.open', side_effect=OSError('offline')):
                scope['loopback_health']('http://127.0.0.1:8000/models')
            handler = build_opener.call_args.args[1]
            self.assertIsNone(handler.redirect_request(None, None, None, None, 'http://192.0.2.1'))

    def test_router_omlx_pool_restocks_without_fallback(self):
        import test_restock
        slots = {lane: {'held': True} for lane in test_restock.LANES}
        slots['omlx'] = {'target': 1}
        with test_restock.build('- READY RQ-OMLX-ROUTE (repo=phantom, pool=omlx): fixture\n', slots=slots) as tmp:
            result = test_restock.restock(Path(tmp))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('\tomlx\t', (Path(tmp) / '.ashlr-runs/queue/ready.tsv').read_text())

    def test_memory_cap_is_bounded_and_unknown_disables(self):
        fn = next(n for n in ast.parse(SCRIPT.read_text()).body if isinstance(n, ast.FunctionDef) and n.name == 'omlx_memory_cap')
        scope = {'subprocess': subprocess}
        exec(compile(ast.Module(body=[fn], type_ignores=[]), str(SCRIPT), 'exec'), scope)
        for memory, cap in ((16, 0), (64, 2), (1024, 6)):
            with patch('subprocess.check_output', return_value=str(memory * 1024**3).encode()):
                self.assertEqual(scope['omlx_memory_cap'](), cap)
        with patch('subprocess.check_output', side_effect=OSError()): self.assertEqual(scope['omlx_memory_cap'](), 0)

    def test_launch_complete_and_reap(self):
        with build() as tmp:
            home = Path(tmp).resolve(); root = home / '.ashlr-runs'; job = 'RQ-PHX-OMLX-FIXTURE'
            # This host denies socket connects. Mock only the HTTP transport in the
            # tick child; production URL validation and every lifecycle stage run.
            wrapper = home / 'tick.py'
            wrapper.write_text('import sys, runpy, urllib.request\n'
                'from unittest.mock import patch, MagicMock\n'
                f'sys.path.insert(0, {str(SCRIPT.parent)!r})\n'
                'response = MagicMock(); response.__enter__.return_value.status = 200\n'
                "with patch('urllib.request.OpenerDirector.open', return_value=response):\n"
                f'    runpy.run_path({str(SCRIPT)!r})\n')
            with patch('test_dispatchd.SCRIPT', wrapper):
                env = launch_stubs(home)
                env['OMLX_URL'] = 'http://127.0.0.1:8000/v1'
                (home / 'stubbin/sysctl').write_text('#!/bin/sh\necho 68719476736\n')
                shutil.copy(SCRIPT.parent / 'local_job.py', root / 'bin/local_job.py')
                queue_job(home, job, 'omlx')
                result = tick(home, env); self.assertEqual(result.returncode, 0, result.stderr)
                status = json.loads((root / 'queue/status.json').read_text())
                self.assertEqual(status['launched_this_tick'], [job], (status, result.stdout))
                self.assertTrue(status['lanes']['omlx']['healthy'])
                self.assertEqual(slots_of(home)['omlx']['hard_cap'], 2)
                wt = home / 'Projects/ashlrai/wt' / job; wt.mkdir()
                subprocess.run(['git', 'init', '-q', str(wt)], check=True, capture_output=True)
                (root / f'{job}.base').write_text(f'HEAD x {wt} omlx\n')
                (root / f'{job}.log').write_text('completed\n')
                os.utime(root / f'queue/run/{job}.dispatched', (1, 1))
                for suffix in ('base', 'log'): os.utime(root / f'{job}.{suffix}', (1, 1))
                (root / 'bin/reap-one.sh').write_text('#!/bin/sh\ntouch "$HOME/.ashlr-runs/queue/run/$1.reaped"\nrmdir "$HOME/.ashlr-runs/queue/run/$1.reaping"\n')
                result = tick(home, env); self.assertEqual(result.returncode, 0, result.stderr)
                deadline = time.monotonic() + 2
                while not (root / f'queue/run/{job}.reaped').exists() and time.monotonic() < deadline: time.sleep(.01)
                self.assertTrue((root / f'queue/run/{job}.reaped').exists())
                rows = [json.loads(l) for l in (root / 'metrics/jobs.jsonl').read_text().splitlines()]
                self.assertEqual([r['event'] for r in rows if r.get('lane') == 'omlx'], ['enqueue', 'claim', 'launch', 'finish'])
                env['OMLX_URL'] = 'http://192.0.2.1:8000/v1'
                queue_job(home, 'RQ-OMLX-REMOTE', 'omlx')
                result = tick(home, env); self.assertEqual(result.returncode, 0, result.stderr)
                status = json.loads((root / 'queue/status.json').read_text())
                self.assertFalse(status['lanes']['omlx']['healthy'])
                self.assertEqual(status['launched_this_tick'], [])
