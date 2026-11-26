"""Rebase cycles use durable claims; no live queue, credentials or protected edits."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from launch_precheck import empty_reason, request_hash, with_prompt
from batcher import batchable_id
from test_dispatchd import build, tick, queue_job, launch_stubs, lane_slot, dispatched


def job(n):
    return f'RQ-DRAIN-PHX-REB-{n:02d}'


def prompt(n, head='a' * 40, lane='codex-personal'):
    return (f'Job {job(n)} (pool {lane}, tier work, repo phantom). Task from the Ashlr router queue, verbatim:\n\n'
            f'{job(n)} (P1, pool={lane}, tier=work, repo=phantom): '
            f'Recut https://github.com/ashlrai/phantom/pull/42 at {head}; report {job(n)}.\n\n'
            'Preserve the intended change and run the affected tests.')


def identity(n, **kwargs):
    # Local git being unavailable must not disable retry accounting.
    return with_prompt({}, job(n), prompt(n, **kwargs))


def failed(n, **changes):
    return [dict(identity(n), job=job(n), event='claim'),
            dict(job=job(n), event='finish', empty=True, exit_code=1, **changes)]


class RebaseCycleTests(unittest.TestCase):
    def test_identity_keeps_heads_targets_scope_and_other_jobs_distinct(self):
        self.assertFalse(batchable_id(job(1)))  # A bundle must not bypass per-job claim/retry checks.
        key = request_hash(job(1), 'phantom', prompt(1))
        self.assertEqual(key, request_hash(job(2), 'phantom', prompt(2, lane='devin')))
        for text in (prompt(2, head='b' * 40), prompt(2).replace('/42', '/43'),
                     prompt(2).replace('affected tests', 'backend tests'), prompt(2).replace('P1,', 'P1, after=RQ-X,')):
            self.assertNotEqual(key, request_hash(job(2), 'phantom', text))
        self.assertNotIn('rebase_hash', with_prompt({}, 'RQ-FEATURE', 'unstructured'))
        self.assertNotIn('rebase_hash', with_prompt(dict(repo='locus'), job(1), prompt(1)))

    def test_three_attempts_exhaust_across_ids_lanes_and_base_changes(self):
        rows = failed(1) + failed(2)
        self.assertIsNone(empty_reason(job(4), identity(4), rows, 0))
        rows += failed(3)
        reason = empty_reason(job(4), identity(4), rows, 0)
        self.assertEqual(reason, 'rebase_retry_exhausted_3x_inspect_claims_change_head_or_task')
        self.assertIsNone(empty_reason(job(4), identity(4, head='b' * 40), rows, 0))
        self.assertEqual(empty_reason(job(4), identity(4, lane='devin'), rows, 0), reason)

    def test_same_job_retries_count_but_duplicate_finishes_and_unknown_rows_do_not(self):
        rows = failed(1)
        self.assertIsNone(empty_reason(job(2), identity(2), rows + [rows[-1]] * 9 + [None, {}], 0))
        self.assertIsNotNone(empty_reason(job(2), identity(2), rows * 3, 0))
        self.assertIsNone(empty_reason(job(2), identity(2), [rows[-1]] * 3, 0))
        productive = [dict(rows[0]), dict(job=job(1), event='finish', empty=False, exit_code=0)]
        self.assertIsNone(empty_reason(job(2), identity(2), productive * 3, 0))
        for finish in (dict(event='finish'), dict(event='finish', empty=False, exit_code=None)):
            self.assertIsNone(empty_reason(job(2), identity(2), [rows[0], dict(finish, job=job(1))] * 3, 0))
        failed_nonempty = [rows[0], dict(job=job(1), event='finish', empty=False, exit_code=1)]
        self.assertIsNotNone(empty_reason(job(2), identity(2), failed_nonempty * 3, 0))

    def test_published_recut_resolves_same_work_and_new_head_can_run(self):
        rows = failed(1) + [dict(identity(2), job=job(2), event='claim'),
                           dict(job=job(2), event='finish', empty=False, exit_code=0)]
        publication = dict(job=job(2), event='publish', url='https://github.com/ashlrai/phantom/pull/99')
        for url in ('untrusted', 'https://github.com/ashlrai/locus/pull/99'):
            self.assertIsNone(empty_reason(job(3), identity(3), rows + [dict(publication, url=url)], 0))
        rows.append(publication)
        self.assertEqual(empty_reason(job(3), identity(3), rows, 0), 'rebase_recut_published_inspect_replacement')
        self.assertIsNone(empty_reason(job(3), identity(3, head='b' * 40), rows, 0))

    def test_durable_claim_blocks_a_copy_until_an_explicit_terminal(self):
        claim = dict(identity(1), job=job(1), event='claim')
        self.assertEqual(empty_reason(job(2), identity(2), [claim], 0), 'rebase_claim_in_flight_wait_for_finish')
        self.assertIsNone(empty_reason(job(2), identity(2), [claim, dict(job=job(1), event='launch_terminal')], 0))

    def test_concurrent_dispatchers_claim_one_copy_even_with_batching_enabled(self):
        with build(slots={'codex-personal': lane_slot()}) as tmp:
            home = Path(tmp).resolve(); env = launch_stubs(home)
            q = home / '.ashlr-runs/queue'
            (q / 'BATCH_OFF').unlink()
            for n in (1, 2):
                queue_job(home, job(n), 'codex-personal')
                (q / f'prompts/{job(n)}.md').write_text(prompt(n))
            with ThreadPoolExecutor(max_workers=2) as workers:
                results = list(workers.map(lambda _: tick(home, env), range(2)))
            for result in results: self.assertEqual(result.returncode, 0, result.stderr)
            rows = list(map(json.loads, (home / '.ashlr-runs/metrics/jobs.jsonl').read_text().splitlines()))
            claims = [r for r in rows if r.get('event') == 'claim']
            self.assertEqual(len(claims), 1)
            self.assertEqual(claims[0]['request_hashes'], [identity(1)['rebase_hash']])
            self.assertEqual(sum(dispatched(home, job(n)) for n in (1, 2)), 1)
            # Durable ownership survives missing process/marker evidence.
            (q / f'run/{claims[0]["job"]}.dispatched').unlink()
            result = tick(home, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            rows = list(map(json.loads, (home / '.ashlr-runs/metrics/jobs.jsonl').read_text().splitlines()))
            self.assertEqual(sum(r.get('event') == 'claim' for r in rows), 1)

    def test_dispatch_records_terminal_reason_and_allows_a_changed_head(self):
        for published in (False, True):
            with self.subTest(published=published), build(slots={'codex-personal': lane_slot()}) as tmp:
                home = Path(tmp).resolve(); env = launch_stubs(home)
                rows = failed(1) + failed(2) + failed(3)
                if published:
                    rows.append(dict(job=job(3), event='publish', url='https://github.com/ashlrai/phantom/pull/99'))
                ledger = home / '.ashlr-runs/metrics/jobs.jsonl'
                ledger.write_text(''.join(json.dumps(r) + '\n' for r in rows))
                for n, head in ((4, 'a' * 40), (5, 'b' * 40)):
                    queue_job(home, job(n), 'codex-personal')
                    (home / f'.ashlr-runs/queue/prompts/{job(n)}.md').write_text(prompt(n, head=head))
                result = tick(home, env)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse(dispatched(home, job(4)))
                self.assertTrue(dispatched(home, job(5)))
                receipts = [json.loads(r) for r in ledger.read_text().splitlines()]
                terminal = next(r for r in receipts if r.get('job') == job(4) and r.get('event') == 'skipped_empty')
                self.assertEqual(terminal['reason'], 'rebase_recut_published_inspect_replacement' if published else
                                 'rebase_retry_exhausted_3x_inspect_claims_change_head_or_task')


if __name__ == '__main__': unittest.main()
