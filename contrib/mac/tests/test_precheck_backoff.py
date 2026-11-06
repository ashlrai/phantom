"""Persistent parking and a measured 48 hour dispatch fixture."""
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from launch_precheck import park, parked, park_key
from test_dispatchd import build, tick, queue_job, launch_stubs, lane_slot, dispatched, ready_lines


class PrecheckBackoff(unittest.TestCase):
    def test_48_hour_metrics_and_runnable_throughput(self):
        state = {}
        checks = parked_events = 0
        key = park_key('job routing', 'prompt')
        for now in range(0, 48 * 3600, 60):
            if not parked(state, 'blocked', key, now):
                checks += 1
                parked_events += park(state, 'blocked', key, now)
                state = json.loads(json.dumps(state))  # separate ticks reload disk
        self.assertLess(checks, 150)
        self.assertEqual(checks, 53)
        self.assertEqual(parked_events, 1)
        self.assertLessEqual(state['blocked']['retry_at'] - now, 3600)
        self.assertFalse(parked(state, 'other', key, now))
        self.assertFalse(parked(state, 'blocked', park_key('job routing', 'changed'), now))
        self.assertTrue(park(state, 'blocked', 'new-key', now))
        self.assertEqual(state['blocked']['retry_at'], now + 60)

    def test_real_ticks_keep_blocked_and_launch_runnable(self):
        with build(slots={'codex-cmp': lane_slot()}) as tmp:
            home = Path(tmp).resolve()
            env = launch_stubs(home)
            q = home / '.ashlr-runs/queue'
            for job in ('BLOCKED', 'RUNNABLE'):
                queue_job(home, job, 'codex-cmp')
                (q / f'prompts/{job}.md').write_text(f'{job} (P0): task')
            script = home / '.ashlr-runs/bin/precheck.sh'
            script.write_text('echo "$1" >> "$HOME/checks"\ncase "$1" in BLOCKED*) exit 13;; esac\n')
            for _ in range(2):
                result = tick(home, env)
                self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(dispatched(home, 'RUNNABLE'))
            self.assertFalse(dispatched(home, 'BLOCKED'))
            self.assertEqual(len(ready_lines(home)), 1)
            self.assertEqual((home / 'checks').read_text().count('BLOCKED'), 1)
            metrics = [json.loads(x) for x in (home / '.ashlr-runs/metrics/jobs.jsonl').read_text().splitlines()]
            self.assertEqual(sum(m['event'] == 'precheck_parked' for m in metrics), 1)
            self.assertEqual(sum(m['event'] == 'precheck_skip' for m in metrics), 0)
            # A due retry is held when the optional budget is exhausted.
            state_path = q / 'precheck-parked.json'
            state = json.loads(state_path.read_text())
            state['BLOCKED']['retry_at'] = 0
            state_path.write_text(json.dumps(state))
            result = tick(home, dict(env, TICK_BUDGET_S='-1'))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(dispatched(home, 'BLOCKED'))
            self.assertEqual((home / 'checks').read_text().count('BLOCKED'), 1)
            result = tick(home, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((home / 'checks').read_text().count('BLOCKED'), 2)
            self.assertEqual(json.loads(state_path.read_text())['BLOCKED']['count'], 2)
            metrics = [json.loads(x) for x in (home / '.ashlr-runs/metrics/jobs.jsonl').read_text().splitlines()]
            self.assertEqual(sum(m['event'] == 'precheck_parked' for m in metrics), 1)
            # A changed precondition can launch immediately, without waiting an hour.
            (q / 'prompts/BLOCKED.md').write_text('BLOCKED (P0): revised task')
            script.write_text('exit 0\n')
            result = tick(home, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(dispatched(home, 'BLOCKED'))


if __name__ == '__main__':
    unittest.main()
