"""RQ-QUEUERECOVERYQ8: bounded launch retries with fixed machine-readable failure reasons.

Unit cases cover the classifier and the retry ledger (empty results, transient and
permanent errors). Tick cases run the repo dispatchd.py once per step in a temp HOME
and prove retry, give-up and recovery end to end. Nothing touches the real ~/.ashlr-runs.
"""
import json
import os
from pathlib import Path
import sys
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import launch_precheck as lp
from test_dispatchd import build, tick, queue_job, launch_stubs, events, dispatched, ready_lines

JOB = 'RQ-RECOVER'


class Classifier(unittest.TestCase):
    def test_reasons_are_fixed_labels_and_split_transient_from_permanent(self):
        cases = {
            'fork: Resource temporarily unavailable': ('resource_exhausted', True),
            'curl: connection refused 127.0.0.1:8123': ('local_backend_unavailable', True),
            'HTTP 503 overloaded': ('provider_unavailable', True),
            'Error: 401 Unauthorized sk-secret-token': ('authentication', False),
            'worktree add failed': ('launch_script_error', True),
            '': ('launch_interrupted', True),
            None: ('launch_interrupted', True),
        }
        for out, want in cases.items():
            with self.subTest(out=out):
                self.assertEqual(lp.classify_launch_failure(out), want)
        self.assertEqual(lp.classify_launch_failure('anything', 124), ('launch_timeout', True))

    def test_empty_results_only_fail_when_the_agent_did_not_run_cleanly(self):
        self.assertIsNone(lp.classify_empty_failure(False, 1))          # produced work
        self.assertIsNone(lp.classify_empty_failure(True, 0))           # clean no-op is not a failure
        self.assertIsNone(lp.classify_empty_failure(None, None))        # unmeasured
        self.assertEqual(lp.classify_empty_failure(True, 124), 'launch_timeout')
        self.assertEqual(lp.classify_empty_failure(True, 2), 'agent_exit_nonzero')
        self.assertEqual(lp.classify_empty_failure(True, None), 'exit_status_missing')
        self.assertEqual(lp.classify_empty_failure(True, 0, 'rate-limit'), 'provider_rate_limit')


class Ledger(unittest.TestCase):
    def test_transient_failures_retry_with_doubling_backoff_then_give_up(self):
        state = {}
        self.assertIsNone(lp.launch_hold(state, JOB, 'k', 0))
        first = lp.launch_failure(state, JOB, 'k', 1000, 'resource_exhausted', True)
        self.assertEqual((first['action'], first['attempt'], first['class']), ('retry', 1, 'retryable'))
        self.assertEqual(first['retry_at'], 1000 + lp.LAUNCH_BACKOFF_S)
        self.assertEqual(lp.launch_hold(state, JOB, 'k', 1001), 'wait')
        self.assertIsNone(lp.launch_hold(state, JOB, 'k', first['retry_at']))
        second = lp.launch_failure(state, JOB, 'k', 2000, 'resource_exhausted', True)
        self.assertEqual(second['retry_at'], 2000 + 2 * lp.LAUNCH_BACKOFF_S)
        last = lp.launch_failure(state, JOB, 'k', 3000, 'resource_exhausted', True)
        self.assertEqual((last['action'], last['attempt'], last['retry_at']), ('give_up', lp.LAUNCH_MAX_ATTEMPTS, None))
        self.assertEqual(lp.launch_hold(state, JOB, 'k', 10 ** 9), 'gave_up')

    def test_permanent_failure_gives_up_at_once_and_changed_input_resets(self):
        state = {}
        got = lp.launch_failure(state, JOB, 'k', 0, 'authentication', False)
        self.assertEqual((got['action'], got['attempt'], got['class']), ('give_up', 1, 'permanent'))
        self.assertEqual(lp.launch_hold(state, JOB, 'k', 1), 'gave_up')
        self.assertIsNone(lp.launch_hold(state, JOB, 'new-prompt', 1))   # a revised task launches again
        self.assertNotIn(JOB, state)

    def test_recovery_clears_history(self):
        state = {}
        lp.launch_failure(state, JOB, 'k', 0, 'provider_unavailable', True)
        self.assertTrue(lp.launch_ok(state, JOB))
        self.assertFalse(lp.launch_ok(state, JOB))
        self.assertEqual(lp.launch_failure(state, JOB, 'k', 5, 'provider_unavailable', True)['attempt'], 1)


class TickRecovery(unittest.TestCase):
    def setUp(self):
        self.tmp = build(); self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name).resolve()
        self.env = launch_stubs(self.home)
        self.q = self.home / '.ashlr-runs/queue'
        queue_job(self.home, JOB, lane='devin')
        self.line = (self.q / 'ready.tsv').read_text()

    def fail_launch(self, out):
        """Stand in for a claimed launch whose launcher wrote `out` and exited."""
        (self.q / 'ready.tsv').write_text('')
        (self.q / f'run/{JOB}.line').write_text(self.line)
        (self.q / 'run' / f'{JOB}.dispatched').write_text('0')
        (self.q / f'../{JOB}.launch').write_text(out)
        old = time.time() - 300
        os.utime(self.q / f'run/{JOB}.dispatched', (old, old))
        self.assertEqual(tick(self.home, self.env).returncode, 0)

    def state(self):
        return json.loads((self.q / 'launch-retries.json').read_text())[JOB]

    def metrics(self):
        rows = [json.loads(x) for x in (self.home / '.ashlr-runs/metrics/jobs.jsonl').read_text().splitlines()]
        return [r for r in rows if r.get('event') == 'launch_failed']

    def due(self):
        data = json.loads((self.q / 'launch-retries.json').read_text())
        data[JOB]['retry_at'] = 0
        (self.q / 'launch-retries.json').write_text(json.dumps(data))

    def test_transient_failure_is_held_then_retried_then_given_up(self):
        self.fail_launch('fork: Resource temporarily unavailable\n')
        self.assertEqual(self.state()['attempts'], 1)
        self.assertEqual([x.split('\t')[0] for x in ready_lines(self.home)], [JOB])   # requeued, held for backoff
        self.assertFalse(dispatched(self.home, JOB))
        got = self.metrics()[-1]
        self.assertEqual((got['reason'], got['action'], got['class'], got['attempt']),
                         ('resource_exhausted', 'retry', 'retryable', 1))
        self.assertIn(f'LAUNCH_RETRY {JOB} reason=resource_exhausted attempt=1/3', events(self.home))
        self.assertEqual(tick(self.home, self.env).returncode, 0)       # still backing off
        self.assertFalse(dispatched(self.home, JOB))
        for _ in range(lp.LAUNCH_MAX_ATTEMPTS - 1):
            (self.q / 'ready.tsv').write_text(self.line)
            self.due()
            self.fail_launch('fork: Resource temporarily unavailable\n')
        self.assertEqual(self.metrics()[-1]['action'], 'give_up')
        self.assertIn(f'LAUNCH_GAVE_UP {JOB} reason=resource_exhausted', events(self.home))
        self.assertEqual(ready_lines(self.home), [])
        (self.q / 'ready.tsv').write_text(self.line)                    # the router re-cuts the identical line
        self.assertEqual(tick(self.home, self.env).returncode, 0)
        self.assertFalse(dispatched(self.home, JOB))
        self.assertEqual(ready_lines(self.home), [])                    # dropped, not relaunched

    def test_permanent_failure_stops_on_the_first_attempt(self):
        self.fail_launch('Error: 401 Unauthorized\n')
        got = self.metrics()[-1]
        self.assertEqual((got['reason'], got['class'], got['action'], got['attempt']),
                         ('authentication', 'permanent', 'give_up', 1))
        self.assertEqual(ready_lines(self.home), [])
        self.assertNotIn('401', json.dumps(self.metrics()))   # launcher text is never copied into receipts

    def test_empty_launch_output_is_an_interruption_and_recovers(self):
        self.fail_launch('')
        self.assertEqual(self.state()['reason'], 'launch_interrupted')
        self.due()
        self.assertEqual(tick(self.home, self.env).returncode, 0)
        self.assertTrue(dispatched(self.home, JOB))                     # retried after backoff
        launch = self.home / f'.ashlr-runs/{JOB}.launch'
        deadline = time.monotonic() + 30
        while 'launched' not in (launch.read_text() if launch.exists() else ''):
            self.assertLess(time.monotonic(), deadline); time.sleep(0.01)
        old = time.time() - 300   # past the launch grace window
        os.utime(self.q / f'run/{JOB}.dispatched', (old, old))
        self.assertEqual(tick(self.home, self.env).returncode, 0)
        self.assertNotIn(JOB, json.loads((self.q / 'launch-retries.json').read_text()))


class BatchRetryBoundary(unittest.TestCase):
    def test_batch_members_obey_wait_and_give_up(self):
        from test_batching import Batching
        fixture = Batching(methodName='test_related_tasks_launch_as_one_session_with_per_line_leases')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        for suffix in ('A', 'B', 'C', 'D'):
            fixture.queue('RQ-RECOVERY-' + suffix,
                          f'Edit src/core/queue/store.ts handling case {suffix}.')
        state = {}
        for suffix, retryable in (('B', True), ('C', False)):
            job = 'RQ-RECOVERY-' + suffix
            prompt = (fixture.q / 'prompts' / (job + '.md')).read_text()
            lp.launch_failure(state, job, lp.park_key(job, prompt), time.time() + 600,
                              'provider_unavailable' if retryable else 'authentication', retryable)
        (fixture.q / 'launch-retries.json').write_text(json.dumps(state))
        fixture.run_tick()
        _, manifest = fixture.only_batch()
        self.assertEqual({m['job'] for m in manifest['members']}, {'RQ-RECOVERY-A', 'RQ-RECOVERY-D'})
        self.assertIn('RQ-RECOVERY-B', fixture.ready())
        self.assertNotIn('RQ-RECOVERY-C', fixture.ready())
        for suffix in ('B', 'C'):
            self.assertFalse((fixture.q / 'run' / ('RQ-RECOVERY-' + suffix + '.batched')).exists())


if __name__ == '__main__':
    unittest.main()
