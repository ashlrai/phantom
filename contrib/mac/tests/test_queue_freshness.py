"""Freshness gates run before solo claims and batch leases; lookups are hermetic."""
import json
from pathlib import Path
import subprocess
import time
import unittest
from datetime import datetime, timezone

from test_dispatchd import build, tick, queue_job, launch_stubs, lane_slot, dispatched
from launch_precheck import admission_history, lookup_pr_state, queue_freshness


class QueueFreshness(unittest.TestCase):
    def test_lookup_validates_identity_state_and_never_retains_error_output(self):
        url = 'https://github.com/ashlrai/phantom/pull/42'
        for code, output, expected in [
            (0, json.dumps(dict(url=url, state='OPEN')), 'OPEN'),
            (0, json.dumps(dict(url=url, state='CLOSED')), 'CLOSED'),
            (0, json.dumps(dict(url=url, state='MERGED')), 'MERGED'),
            (1, 'private error text', None), (0, '{', None), (0, '[]', None),
            (0, json.dumps(dict(url=url + '0', state='MERGED')), None),
            (0, json.dumps(dict(url=url, state='unknown')), None),
        ]:
            with self.subTest(output=output):
                def runner(cmd, timeout):
                    self.assertEqual(cmd, ['gh', 'pr', 'view', url, '--json', 'url,state'])
                    self.assertEqual(timeout, 2)
                    return subprocess.CompletedProcess(cmd, code, output, '')
                self.assertEqual(lookup_pr_state(url, runner), expected)
        def timeout(*args): raise subprocess.TimeoutExpired('gh', 2)
        self.assertIsNone(lookup_pr_state(url, timeout))

    def test_only_exact_targets_or_repo_scoped_merged_jobs_retire(self):
        now = time.time()
        _, states = admission_history([dict(event='outcome', state='MERGED', repo='phantom', job='J',
            ts=datetime.fromtimestamp(now - 86400, timezone.utc).isoformat())], now)
        self.assertEqual(queue_freshness('J', 'phantom', '', states, None), ('DONE-NOOP', 'job_already_merged'))
        self.assertEqual(queue_freshness('J', 'locus', 'J (P1): mentions PR #42', states, None), ('ready', None))
        _, stale = admission_history([dict(event='outcome', state='CLOSED', repo='phantom', job='old',
            url='https://github.com/ashlrai/phantom/pull/42',
            ts=datetime.fromtimestamp(now - 301, timezone.utc).isoformat())], now)
        self.assertEqual(queue_freshness('K', 'phantom', 'K (pr=42): repair', stale, lambda _: 'OPEN'), ('ready', None))
        self.assertEqual(queue_freshness('K', 'phantom', 'K (pr=42): repair', stale, lambda _: None),
                         ('deferred', 'target_pr_lookup_unavailable'))
        for field in ('pr', 'parent_pr', 'parent-pr'):
            prompt = f'K ({field}=42): repair'
            self.assertEqual(queue_freshness('K', 'phantom', prompt, {}, lambda _: 'CLOSED'),
                             ('DONE-NOOP', 'target_pr_closed'))
        self.assertEqual(queue_freshness('K', 'phantom', 'K (pr=42): repair',
            {'https://github.com/ashlrai/phantom/pull/42': 'OPEN'}, lambda _: 'CLOSED'), ('DONE-NOOP', 'target_pr_closed'))

    def test_lookup_budget_defers_unchecked_targets_without_claiming_them(self):
        with build(slots={'codex-cmp': lane_slot()}) as tmp:
            home = Path(tmp).resolve(); q = home / '.ashlr-runs/queue'
            for n in range(9):
                job = f'RQ-Q-{n}'
                queue_job(home, job, 'codex-cmp')
                (q / f'prompts/{job}.md').write_text(f'{job} (pr={n + 1}): repair')
            gh = home / 'stubbin/gh'
            gh.write_text('#!/bin/sh\necho called >> "$HOME/lookups"\nexit 1\n'); gh.chmod(0o755)
            result = tick(home, launch_stubs(home)); self.assertEqual(result.returncode, 0, result.stderr)
            decisions = json.loads((q / 'ranking.json').read_text())['decisions']
            self.assertEqual(len(decisions), 9)
            self.assertEqual(len((home / 'lookups').read_text().splitlines()), 8)
            self.assertTrue(all(r['outcome'] == 'deferred' for r in decisions))
            self.assertEqual(len((q / 'ready.tsv').read_text().splitlines()), 9)
            self.assertFalse(any(dispatched(home, r['job']) for r in decisions))

    def test_stale_live_failure_retry_and_batch_paths(self):
        with build(slots={'codex-cmp': lane_slot()}) as tmp:
            home = Path(tmp).resolve(); env = launch_stubs(home)
            q = home / '.ashlr-runs/queue'
            jobs = ['RQ-Q-CLOSED', 'RQ-Q-MERGED', 'RQ-Q-LIVE', 'RQ-Q-RETRY', 'RQ-Q-INCIDENTAL']
            for n, job in enumerate(jobs, 1):
                queue_job(home, job, 'codex-cmp')
                (q / f'prompts/{job}.md').write_text(f'{job} (parent_pr={n}): edit src/core/queue/store.ts'
                    if n < 5 else f'{job} (P1): mentions PR #1; edit src/core/queue/store.ts')
            gh = home / 'stubbin/gh'
            gh.write_text('#!/usr/bin/python3\nimport json, sys\nurl=sys.argv[3]\n'
                          'n=url.rsplit("/",1)[1]\n'
                          'if n=="4": sys.exit(1)\n'
                          'print(json.dumps(dict(url=url,state={"1":"CLOSED","2":"MERGED"}.get(n,"OPEN"))))\n')
            gh.chmod(0o755)
            (q / 'BATCH_OFF').unlink()
            batch = home / '.ashlr-runs/bin/batch-launch.sh'
            batch.write_text('#!/bin/sh\ncat > "$HOME/batch-input"\n'); batch.chmod(0o755)
            result = tick(home, env); self.assertEqual(result.returncode, 0, result.stderr)
            decisions = {r['job']: r for r in json.loads((q / 'ranking.json').read_text())['decisions']}
            self.assertEqual(decisions[jobs[0]]['reason'], 'target_pr_closed')
            self.assertEqual(decisions[jobs[1]]['reason'], 'target_pr_merged')
            self.assertEqual(decisions[jobs[3]]['outcome'], 'deferred')
            self.assertEqual(decisions[jobs[3]]['reason'], 'target_pr_lookup_unavailable')
            manifest = json.loads(next((q / 'batches').glob('*.json')).read_text())
            self.assertEqual({m['job'] for m in manifest['members']}, {jobs[2], jobs[4]})
            self.assertIn(jobs[3], (q / 'ready.tsv').read_text())
            gh.write_text(gh.read_text().replace('if n=="4": sys.exit(1)', 'if False: sys.exit(1)'))
            (q / 'BATCH_OFF').touch()
            result = tick(home, env); self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(dispatched(home, jobs[3]))


if __name__ == '__main__':
    unittest.main()
