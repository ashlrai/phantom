"""Offline authoring/dispatch fixtures; real queues and model calls are never used."""
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from launch_precheck import merged_jobs, request_hash
from test_dispatchd import build, tick, queue_job, launch_stubs, lane_slot, dispatched, ready_lines
from test_restock import build as author_queue, restock, line


def prompt(job, attrs='P1, pool=devin', text='Fix src/core/queue/store.ts retry handling.'):
    return f'{job} ({attrs}): {text}'


class EmptyJobAdmission(unittest.TestCase):
    def test_reserved_requests_dedupe_without_process_evidence_until_terminal(self):
        for family in ('FLEETCORE', 'CONSOLE'):
            for terminal in (None, 'finish', 'launch_terminal'):
                with self.subTest(family=family, terminal=terminal), build(
                        slots={'codex-cmp': lane_slot()}) as tmp:
                    home = Path(tmp).resolve(); env = launch_stubs(home)
                    q = home / '.ashlr-runs/queue'
                    owner, copy, distinct = (f'RQ-PHX-{family}{n}' for n in (1, 2, 3))
                    digest = request_hash(owner, 'phantom', prompt(owner))
                    rows = [dict(event='claim', job=owner, repo='phantom',
                                 request_hashes=[digest], launch_dedupe=True)]
                    if terminal:
                        rows.append(dict(event=terminal, job=owner))
                    ledger = home / '.ashlr-runs/metrics/jobs.jsonl'
                    ledger.write_text(''.join(json.dumps(row) + '\n' for row in rows))
                    for job in (copy, distinct):
                        queue_job(home, job, 'codex-cmp')
                        text = 'Fix src/core/queue/store.ts timeout handling.' if job == distinct else None
                        (q / f'prompts/{job}.md').write_text(prompt(job, **({'text': text} if text else {})))
                    result = tick(home, env)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertTrue(dispatched(home, distinct))
                    self.assertEqual(dispatched(home, copy), terminal is not None)
                    if terminal is None:
                        self.assertIn(copy, '\n'.join(ready_lines(home)))
                        receipts = list(map(json.loads, ledger.read_text().splitlines()))
                        self.assertTrue(any(row.get('job') == copy and row.get('event') == 'dispatch_deferred'
                                            and row.get('reason') == 'duplicate-request'
                                            and row.get('repeatOf') == owner for row in receipts))
                        self.assertEqual(tick(home, env).returncode, 0)
                        self.assertFalse(dispatched(home, copy))

    def test_repair_jobs_for_different_prs_are_different_requests(self):
        a, b = 'RQ-FIXUP-phantom-41-aaaaaaa', 'RQ-FIXUP-phantom-42-aaaaaaa'
        self.assertNotEqual(request_hash(a, 'phantom', prompt(a)), request_hash(b, 'phantom', prompt(b)))
        c = 'RQ-REBASE-phantom-41-aaaaaaa'
        self.assertNotEqual(request_hash(a, 'phantom', prompt(a)), request_hash(c, 'phantom', prompt(c)))
        d = 'RQ-FIXUP-phantom-41-bbbbbbb'   # same PR and kind: still the same request
        self.assertEqual(request_hash(a, 'phantom', prompt(a)), request_hash(d, 'phantom', prompt(d)))

    def test_identity_keeps_actionable_differences(self):
        key = request_hash('A', 'phantom', prompt('A'))
        self.assertEqual(key, request_hash('B', 'phantom', prompt('B', 'pool=codex-cmp, P0')))
        variants = [prompt('B', 'pr=42'), prompt('B', 'after=DEP'), prompt('B', 'size<=80'),
                    prompt('B', text='Fix src/core/queue/Store.ts retry handling.'),
                    prompt('B') + '\nAlso fix the timeout.', 'Context changed\n' + prompt('B')]
        for variant in variants:
            self.assertNotEqual(key, request_hash('B', 'phantom', variant))
        self.assertNotEqual(key, request_hash('A', 'locus', prompt('A')))
        header = 'Job A (pool devin, tier work, repo phantom). Task from the Ashlr router queue, verbatim:\n\n'
        self.assertEqual(key, request_hash('A', 'phantom', header + prompt('A')))
        self.assertNotEqual(request_hash('A', 'phantom', prompt('A', 'pr=42')),
                            request_hash('B', 'phantom', prompt('B', 'pr=43')))
        for unknown in ('free text', 'A (P1): short', prompt('A') + '\n' + prompt('A')):
            self.assertIsNone(request_hash('A', 'phantom', unknown))

    def test_completion_needs_exact_merge_evidence(self):
        merged = dict(event='outcome', state='MERGED', job='A', repo='ashlrai/phantom')
        rows = [merged, dict(merged, job='B', repo=None), dict(merged, job='C', state='CLOSED'),
                dict(merged, job='D', launched=False), dict(merged, job='E', repo=[]),
                dict(merged, job='F', event='finish', empty=False), None]
        self.assertEqual(merged_jobs(rows), {('phantom', 'A'), (None, 'B')})

    def test_authoring_reports_stale_and_duplicate_without_losing_work(self):
        rows = [line(job, pool='devin', tier='work', repo='phantom', text=text) for job, text in (
            ('RQ-STALE', 'Remove src/queue.ts obsolete archive format parsing.'),
            ('RQ-A', 'Fix src/store.ts retry handling with a bounded delay.'),
            ('RQ-B', 'Fix src/store.ts retry handling with a bounded delay.'),
            ('RQ-WORK', 'Report src/queue.ts latency histogram measurements.'))]
        with author_queue('\n'.join(rows)) as tmp:
            home = Path(tmp)
            (home / '.ashlr-runs/metrics/jobs.jsonl').write_text(json.dumps(
                dict(event='outcome', state='MERGED', job='RQ-STALE', repo='phantom')) + '\n')
            result = restock(home, '--dry-run', '--per-lane', '4', '--json')
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual({j['job'] for j in report['jobs']}, {'RQ-A', 'RQ-WORK'})
            self.assertEqual(report['skips'], {'already-merged': 1, 'semantic-goal-overlap': 1})
            self.assertEqual((home / '.ashlr-runs/queue/router-queue.md').read_text(), '\n'.join(rows))

    def test_stale_duplicate_and_actionable_jobs(self):
        for blocked in (False, True):
            with self.subTest(blocked=blocked), build(slots={'codex-cmp': lane_slot()}) as tmp:
                home = Path(tmp).resolve(); env = launch_stubs(home)
                q = home / '.ashlr-runs/queue'
                rows = [dict(event='outcome', state='MERGED', job='RQ-STALE', repo='ashlrai/phantom')]
                ledger = home / '.ashlr-runs/metrics/jobs.jsonl'
                ledger.write_text(json.dumps(rows[0]) + '\n')
                for job in ('RQ-STALE', 'RQ-A', 'RQ-B', 'RQ-WORK'):
                    queue_job(home, job, 'codex-cmp')
                    text = 'Fix src/core/queue/store.ts timeout handling.' if job == 'RQ-WORK' else None
                    (q / f'prompts/{job}.md').write_text(prompt(job, **({'text': text} if text else {})))
                if blocked:
                    (home / '.ashlr-runs/bin/precheck.sh').write_text(
                        'case "$1" in RQ-A*) echo "SKIP RQ-A code=13 reason=symbols_defined"; exit 13;; esac\n')
                result = tick(home, env)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse(dispatched(home, 'RQ-STALE'))
                self.assertTrue(dispatched(home, 'RQ-WORK'))
                self.assertEqual(dispatched(home, 'RQ-A'), not blocked)
                self.assertEqual(dispatched(home, 'RQ-B'), blocked)
                self.assertIn('RQ-A' if blocked else 'RQ-B', '\n'.join(ready_lines(home)))
                rows = list(map(json.loads, ledger.read_text().splitlines()))
                self.assertTrue(any(r.get('job') == 'RQ-STALE' and r.get('reason') == 'already-merged' for r in rows))
                if not blocked:
                    self.assertTrue(any(r.get('job') == 'RQ-B' and r.get('reason') == 'duplicate-request' for r in rows))
                    # A live claim still defers its copy on the next tick.
                    self.assertEqual(tick(home, env).returncode, 0)
                    self.assertFalse(dispatched(home, 'RQ-B'))
                    # Once ownership ends, the retained request can retry.
                    (q / 'run/RQ-A.dispatched').unlink(missing_ok=True)
                    with ledger.open('a') as out:
                        out.write(json.dumps(dict(event='finish', job='RQ-A')) + '\n')
                    self.assertEqual(tick(home, env).returncode, 0)
                    self.assertTrue(dispatched(home, 'RQ-B'))


if __name__ == '__main__': unittest.main()
