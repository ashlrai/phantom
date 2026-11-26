"""Recut launch decisions use local producer identities, receipts and live owners."""
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from launch_precheck import RecutAdmission, merged_jobs
from test_dispatchd import build, tick, queue_job, launch_stubs, lane_slot, dispatched, ready_lines


def entry(level, head='a' * 40, pr=42):
    return dict(id=f'RECUT{pr}L{level}', pr=pr, headSha=head)


def job(level, pr=42):
    return f'RQ-PHX-RECUT{pr}L{level}'


class RecutAdmissionTests(unittest.TestCase):
    def test_identity_and_receipt_boundaries(self):
        rows = [entry(1), entry(2)]
        receipt = dict(event='outcome', state='MERGED', repo='ashlrai/phantom', job=job(1))
        self.assertEqual(RecutAdmission(rows, merged_jobs([receipt]), set()).decide(job(2), 'phantom'),
                         dict(action='skip', reason='recut-already-merged', repeatOf=job(1), targetPr=42, headSha='a' * 40))
        for change in (dict(state='CLOSED'), dict(event='finish'), dict(launched=False), dict(repo='locus')):
            decision = RecutAdmission(rows, merged_jobs([{**receipt, **change}]), set()).decide(job(2), 'phantom')
            self.assertEqual(decision['action'], 'ready', change)
        for bad in (dict(headSha='bad'), dict(pr=True), dict(pr=43), dict(leaseUntil=123)):
            index = RecutAdmission(rows + [{**entry(2), **bad}], {('phantom', job(1))}, set())
            self.assertIsNone(index.decide(job(2), 'phantom'))
        self.assertIsNone(RecutAdmission(rows, set(), set()).decide(job(2), 'locus'))
        self.assertIsNone(RecutAdmission([None, {}, entry(2)], set(), set()).decide(job(1), 'phantom'))

    def test_stale_merge_and_ownership_do_not_retire_actionable_heads(self):
        index = RecutAdmission([entry(1), entry(2, 'b' * 40), entry(3)], {('phantom', job(1))}, {job(1)})
        self.assertEqual(index.decide(job(2), 'phantom')['reason'], 'recut-no-current-coverage')
        self.assertEqual(index.decide(job(3), 'phantom')['reason'], 'recut-already-merged')
        index = RecutAdmission([entry(1), entry(2)], set(), set())
        self.assertEqual(index.decide(job(2), 'phantom')['action'], 'ready')
        index.launched(job(1), 'phantom')
        self.assertEqual(index.decide(job(2), 'phantom')['repeatOf'], job(1))

    def test_parked_candidate_does_not_reserve_a_head(self):
        with build(slots={'codex-personal': lane_slot()}) as tmp:
            home = Path(tmp).resolve(); env = launch_stubs(home); q = home / '.ashlr-runs/queue'
            (q / 'recut-loop.jsonl').write_text('\n'.join(map(json.dumps, [entry(1), entry(2)])))
            for level in (1, 2):
                queue_job(home, job(level), 'codex-personal')
                (q / f'prompts/{job(level)}.md').write_text(f'{job(level)} (P1): Recut the observed conflict.')
            (home / '.ashlr-runs/bin/precheck.sh').write_text(
                f'case "$1" in {job(1)}*) echo "SKIP {job(1)} code=13 reason=symbols_defined"; exit 13;; esac\n')
            result = tick(home, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(dispatched(home, job(1)))
            self.assertTrue(dispatched(home, job(2)))
            self.assertIn(job(1), '\n'.join(ready_lines(home)))

    def test_existing_live_batch_owns_its_recut_until_it_ends(self):
        with build(slots={'codex-personal': lane_slot()}) as tmp:
            home = Path(tmp).resolve(); env = launch_stubs(home); q = home / '.ashlr-runs/queue'
            (q / 'recut-loop.jsonl').write_text('\n'.join(map(json.dumps, [entry(1), entry(2)])))
            queue_job(home, job(2), 'codex-personal')
            (q / 'batches').mkdir(exist_ok=True)
            (q / 'batches/RQ-BATCH-OWNER.json').write_text(json.dumps(dict(schema='dispatchd.batch.v1', members=[])))
            (q / 'run/RQ-BATCH-OWNER.dispatched').write_text('0')
            (q / f'run/{job(1)}.batched').write_text('RQ-BATCH-OWNER\n')
            result = tick(home, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(dispatched(home, job(2)))
            (q / 'run/RQ-BATCH-OWNER.dispatched').unlink()
            result = tick(home, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(dispatched(home, job(2)))

    def test_dispatch_suppresses_copies_before_launch_and_releases_dead_owners(self):
        with build(slots={'codex-personal': lane_slot()}) as tmp:
            home = Path(tmp).resolve(); env = launch_stubs(home); q = home / '.ashlr-runs/queue'
            # Enable batching: recuts must still cross their individual admission boundary.
            (q / 'BATCH_OFF').unlink()
            entries = [entry(1), entry(2), entry(3, 'b' * 40), entry(4, pr=43), entry(5, pr=43)]
            (q / 'recut-loop.jsonl').write_text('\n'.join(map(json.dumps, entries)) + '\n{torn')
            ledger = home / '.ashlr-runs/metrics/jobs.jsonl'
            ledger.write_text(json.dumps(dict(event='outcome', state='MERGED', job=job(4, 43), repo='phantom')) + '\n')
            candidates = [job(1), job(2), job(3), job(5, 43)]
            for candidate in candidates:
                queue_job(home, candidate, 'codex-personal')
                (q / f'prompts/{candidate}.md').write_text(f'{candidate} (P1): Recut with distinct wording for {candidate}.')
            result = tick(home, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            decisions = {r['job']: r for r in map(json.loads, ledger.read_text().splitlines()) if r.get('event') == 'recut_admission'}
            for candidate, action in zip(candidates, ('ready', 'defer', 'ready', 'skip')):
                self.assertEqual(decisions[candidate]['action'], action)
                self.assertEqual(dispatched(home, candidate), action == 'ready')
            self.assertEqual(decisions[job(2)]['repeatOf'], job(1))
            self.assertEqual(decisions[job(3)]['reason'], 'recut-no-current-coverage')
            self.assertEqual(decisions[job(5, 43)]['reason'], 'recut-already-merged')
            self.assertIn(job(2), '\n'.join(ready_lines(home)))
            self.assertNotIn(job(5, 43), '\n'.join(ready_lines(home)))
            self.assertEqual(tick(home, env).returncode, 0)
            self.assertFalse(dispatched(home, job(2)))
            (q / f'run/{job(1)}.dispatched').unlink()
            self.assertEqual(tick(home, env).returncode, 0)
            self.assertTrue(dispatched(home, job(2)))


if __name__ == '__main__': unittest.main()
