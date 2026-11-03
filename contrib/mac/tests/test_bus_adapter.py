"""Agent bus adapter (RQ-BUS-NEUTRAL-1): dispatchd-launched jobs of every vendor get PHM_BUS_* identity env,
`phm` on PATH and a two-line usage note ahead of their prompt. Fixture only; no real engines run."""
import json
import os
from pathlib import Path
import sys
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_dispatchd as td  # noqa: E402

DUMP_STUB = ('#!/bin/bash\n'
             'mkdir -p "$HOME/dump"\n'
             'cat > "$HOME/dump/$1.stdin"\n'
             'printf "%s|%s|%s|%s\\n" "$PHM_BUS_AGENT" "$PHM_BUS_VENDOR" "$PHM_BUS_NODE" "$PATH" > "$HOME/dump/$1.env"\n')

VENDORS = {'codex-personal': 'codex', 'claude': 'claude', 'devin': 'devin', 'codex-local': 'local'}


def fixture(lanes):
    slots = td.held_lanes()
    for lane in lanes:
        slots[lane] = td.lane_slot(target=1)
    tmp = td.build(slots=slots)
    home = Path(tmp.name).resolve()   # /var -> /private/var so the prompt realpath check passes
    env = td.launch_stubs(home)
    (home / '.ashlr-runs' / 'bin' / 'launch.sh').write_text(DUMP_STUB)
    return tmp, home, env


class BusAdapterTests(unittest.TestCase):
    def test_every_vendor_gets_identity_env_path_and_preamble(self):
        tmp, home, env = fixture(VENDORS)
        self.addCleanup(tmp.cleanup)
        shim = home / '.local' / 'bin'
        shim.mkdir(parents=True)
        (shim / 'phm').write_text('#!/bin/sh\n')
        (shim / 'phm').chmod(0o755)
        for lane in VENDORS:
            td.queue_job(home, 'RQ-BUS-' + lane.upper().replace('-', ''), lane)
        td.tick(home, env)
        deadline = time.time() + 10
        dump = home / 'dump'
        while time.time() < deadline and len(list(dump.glob('*.env'))) < len(VENDORS):
            time.sleep(0.1)
        for lane, vendor in VENDORS.items():
            job = 'RQ-BUS-' + lane.upper().replace('-', '')
            agent, got_vendor, node, path = (dump / (job + '.env')).read_text().strip().split('|', 3)
            self.assertEqual((agent, got_vendor), (job, vendor))
            self.assertRegex(node, r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$')
            self.assertIn(str(shim), path.split(':'))
            lines = (dump / (job + '.stdin')).read_text().split('\n')
            self.assertTrue(lines[0].startswith('Agent bus: send with `phm bus send'))
            self.assertTrue(lines[1].startswith('Read with `phm bus read'))
            self.assertEqual(lines[2:4], ['', 'fixture prompt'])

    def test_missing_prompt_file_fails_open(self):
        src = td.SCRIPT.read_text()
        ns = {'os': os, 're': __import__('re'), 'socket': __import__('socket'), 'RUN': '/nonexistent', 'H': '/nonexistent'}
        start = src.index('BUS_VENDOR = ')
        end = src.index("    except Exception: return pf\n") + len("    except Exception: return pf\n")
        exec(src[start:end], ns)
        self.assertEqual(ns['bus_prompt']('/nonexistent/p.md', 'RQ-X'), '/nonexistent/p.md')
        self.assertEqual(ns['bus_vendor']('grok-lane'), 'grok')


if __name__ == '__main__':
    unittest.main()
