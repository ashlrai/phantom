"""Hermetic full ticks: maintenance stalls cannot stand ahead of ready claims."""
import json
from pathlib import Path
import re
import unittest
from test_dispatchd import build, held_lanes, lane_slot, queue_job, launch_stubs, tick, SCRIPT


class TickBudget(unittest.TestCase):
    def test_restock_claim_is_launched_without_another_tick(self):
        with build() as tmp:
            home = Path(tmp).resolve(); runs = home/'.ashlr-runs'; q = runs/'queue'
            env = launch_stubs(home)
            (home/'stubbin/process_snapshot.py').write_text(
                'import subprocess\ndef capture(timeout=5): return subprocess.CompletedProcess([], 0, \"1000 idle\\n\", \"\")\n')
            (q/'admission.json').write_text(json.dumps({'cap': 30}))
            queue_job(home, 'RQ-restocked', 'devin')
            (q/'incoming.tsv').write_text((q/'ready.tsv').read_text())
            (q/'ready.tsv').write_text('')
            (runs/'bin/restock.sh').write_text(
                '#!/bin/bash\ncat "$HOME/.ashlr-runs/queue/incoming.tsv" >> "$HOME/.ashlr-runs/queue/ready.tsv"\n'
                'echo RQ-restocked >> "$HOME/.ashlr-runs/queue/claimed.tsv"\n')
            result = tick(home, env)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('RQ-restocked', (q/'claimed.tsv').read_text())
            self.assertIn('RQ-restocked', json.loads((q/'status.json').read_text())['launched_this_tick'])

    def test_slow_scan_yields_after_same_tick_claim_and_launch(self):
        slots = held_lanes(); slots['devin'] = lane_slot(target=1)
        with build(slots=slots) as tmp:
            home = Path(tmp).resolve(); runs = home/'.ashlr-runs'; q = runs/'queue'
            queue_job(home, 'RQ-ready-claim', 'devin')
            (q/'claimed.tsv').write_text('RQ-ready-claim\tfixture\n')
            env = launch_stubs(home)
            (home/'stubbin/process_snapshot.py').write_text(
                'import subprocess\ndef capture(timeout=5): return subprocess.CompletedProcess([], 0, \"1000 idle\\n\", \"\")\n')
            (q/'admission.json').write_text(json.dumps({'cap': 30}))
            # A stale finished tree forces the real maintenance sorting path.
            job = 'RQ-old-tree'; wt = home/'Projects/ashlrai/wt'/job; wt.mkdir()
            (runs/(job+'.base')).write_text(f'deadbeef x {wt} devin\n')
            (runs/(job+'.log')).write_text('finished\n')
            import os
            os.utime(runs/(job+'.base'), (1, 1)); os.utime(runs/(job+'.log'), (1, 1))
            # Substitute only the slow scan transport; run the actual complete tick.
            candidate = home/'dispatchd.py'
            source = SCRIPT.read_text().replace('def _prio(bp):', 'def _prio(bp):\n    time.sleep(3)')
            candidate.write_text(source)
            env['WORKTREE_REAP_BUDGET_S'] = '0.1'
            result = tick(home, env, candidate)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            rows = [json.loads(row) for row in (runs/'metrics/jobs.jsonl').read_text().splitlines()]
            events = [r['event'] for r in rows if r.get('job') == 'RQ-ready-claim']
            self.assertIn('claim', events, result.stdout)
            self.assertIn('launch', events)
            self.assertLess(events.index('claim'), events.index('launch'))
            self.assertIn('worktree maintenance budget exhausted', result.stdout)
            summary = next(l for l in result.stdout.splitlines() if ' TICK total_s=' in l)
            for phase in ('queue_parse', 'budget_read', 'adapt', 'launch', 'worktree_reap'):
                self.assertRegex(summary, phase + r'_s=\d+\.\d{3}')
            measured = dict((k, float(v)) for k, v in re.findall(r'(\w+)_s=([\d.]+)', summary))
            self.assertLess(measured['worktree_reap'], .5)
            self.assertLess(measured['launch'], 3)
            # A second tick must not enter the stalled scan within ten minutes.
            again = tick(home, env, candidate)
            self.assertEqual(again.returncode, 0, again.stderr)
            self.assertNotIn('worktree maintenance budget exhausted', again.stdout)
            print(summary)


if __name__ == '__main__': unittest.main()
