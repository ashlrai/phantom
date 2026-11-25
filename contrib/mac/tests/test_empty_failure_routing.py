"""Fixed failure receipts and real dispatch ticks; synthetic homes, no credentials."""
import json
from pathlib import Path
import subprocess
import sys
import time
import unittest
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import launch_precheck as lp
import test_dispatchd as dispatch_tests
from test_dispatchd import tick
import test_work_market as market_tests


class EmptyFailureRouting(unittest.TestCase):
    fixture = market_tests.MarketTick.fixture
    add = market_tests.MarketTick.add
    rows = market_tests.MarketTick.rows

    def test_finish_receipt_records_cause_without_error_text(self):
        fixture = dispatch_tests.DiffMetricsTests()
        self.addCleanup(fixture.doCleanups)
        row = fixture.measure(lambda wt, git: None, lane='codex-personal', rc=1,
                              log='ERROR: failed to refresh access token: invalid_grant private-value\n')
        self.assertEqual((row['empty_class'], row['failure_reason']), ('error', 'provider_authentication'))
        self.assertNotIn('private-value', json.dumps(row))

    def test_redacted_classification_requires_error_evidence(self):
        for text, reason in (
            ('ERROR: refresh_token_reused private-value', 'provider_authentication'),
            ('Error: HTTP 429 private-value', 'provider_rate_limit'),
            ('ERROR: usage_limit_reached private-value', 'provider_usage_limit'),
            ('Error: EPERM private-value', 'sandbox_denied'),
            ('Error: spawn gh ENOENT private-value', 'tool_missing'),
        ):
            with self.subTest(reason=reason):
                self.assertEqual(lp.classify_empty_failure(True, 1, output=text), reason)
                self.assertEqual(lp.classify_empty_failure(True, 1, output='Discuss ' + text), 'agent_exit_nonzero')
                self.assertIsNone(lp.classify_empty_failure(False, 1, output=text))
                self.assertIsNone(lp.classify_empty_failure(True, 0, output=text))
                self.assertEqual(lp.classify_empty_failure(True, 1, output=text + '\nquiet' * 30), 'agent_exit_nonzero')
        for value in ('private-value', 'private_value', ['private-value']):
            self.assertEqual(lp.classify_empty_failure(True, 1, value), 'provider_error')
        self.assertEqual(lp.classify_empty_failure(True, 1, output='Error: test failed at src/example.ts:401'), 'agent_exit_nonzero')

    def test_unknown_stale_other_task_and_live_attempt_never_block(self):
        ident = dict(repo='phantom', task_hash='task')
        claim = dict(ident, event='claim', job='old', lane='codex-personal')
        finish = dict(event='finish', job='old', empty=True, failure_reason='provider_authentication',
                      ts=datetime.fromtimestamp(10000, timezone.utc).isoformat())
        self.assertEqual(lp.empty_retry_blocks(ident, [claim, finish], 10000), {'codex-personal': 'provider_authentication'})
        for patch in ({'failure_reason': 'agent_exit_nonzero'}, {'failure_reason': []}, {'ts': 'bad'},
                      {'ts': '1970-01-01T02:46:40'}, {'empty': False}, {'repo': 'locus'}, {'task_hash': 'other'}):
            self.assertEqual(lp.empty_retry_blocks(ident, [claim, dict(finish, **patch)], 10000), {})
        for now in (9999, 96400):
            self.assertEqual(lp.empty_retry_blocks(ident, [claim, finish], now), {})
        self.assertEqual(lp.empty_retry_blocks(ident, [claim, finish, claim], 10000), {})

    def test_dispatch_reroutes_only_to_eligible_included_capacity(self):
        for mode, expected in (('included', 'claude'), ('held', None), ('metered', None),
                               ('local', None), ('move_cap', None), ('launched', None), ('needs', None), ('sandbox', None)):
            with self.subTest(mode=mode):
                home, q = self.fixture({'codex-personal': 1, 'claude': 1})
                repo = home / 'Projects/ashlrai/phantom'
                for args in (['init', '-q'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                             'commit', '--allow-empty', '-qm', 'base'],
                             ['update-ref', 'refs/remotes/origin/main', 'HEAD'],
                             ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']):
                    subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True)
                self.add(home, 'RQ-RETRY', 'codex-personal', preferred_lane='codex-local' if mode == 'local' else 'codex-personal',
                         needs=['gh'] if mode == 'needs' else [])
                prompt = 'RQ-RETRY (pool=codex-personal): Repair the measured empty routing failure.'
                (q / 'prompts/RQ-RETRY.md').write_text(prompt)
                now = time.time()
                rows = [dict(event='claim', job='old', repo='phantom', lane='codex-personal',
                             task_hash=lp.task_hash('RQ-RETRY', prompt)),
                        dict(event='finish', job='old', empty=True, exit_code=1,
                             failure_reason=lp.classify_empty_failure(True, 1, output='ERROR: refresh_token_reused private-value'),
                             ts=datetime.fromtimestamp(now, timezone.utc).isoformat())]
                if mode == 'sandbox': rows[-1]['failure_reason'] = 'sandbox_denied'
                (q.parent / 'metrics/jobs.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in rows))
                slots = json.loads((q / 'slots.json').read_text())
                if mode == 'held': slots['claude'].update(held=True)
                if mode == 'metered': slots['claude'].update(cost_class='metered')
                (q / 'slots.json').write_text(json.dumps(slots))
                (q / 'route-state.json').write_text(json.dumps({'RQ-RETRY': dict(pool='codex-personal', decided_at=now,
                    moves=[now - 1, now - 2] if mode == 'move_cap' else [], launched=mode == 'launched', assigned=True)}))
                result = tick(home)
                self.assertEqual(result.returncode, 0, result.stderr)
                decision = next(r for r in self.rows(home) if r['event'] == 'route_decision')
                self.assertEqual(decision['chosen_lane'], expected)
                self.assertNotIn('private-value', json.dumps(decision))
                receipts = [json.loads(line) for line in (q.parent / 'metrics/jobs.jsonl').read_text().splitlines()]
                self.assertEqual([r['lane'] for r in receipts if r['event'] == 'launch'], [expected] if expected else [])


if __name__ == '__main__':
    unittest.main()
