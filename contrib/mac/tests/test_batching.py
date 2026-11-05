"""Fixture tests for RQ-QUEUE-BATCH-1 batching in contrib/mac/dispatchd.py.

Same harness as test_dispatchd.py (synthetic ~/.ashlr-runs in a temp HOME, one tick per subprocess), with
queue/BATCH_OFF removed so related ready tasks launch as one RQ-BATCH-* session. Covers grouping, the
checklist prompt and manifest, solo kinds, the duplicate-line guard, the batch-attempt limit, the off switch,
and the reap path: per-task outcome metrics, re-queue of tasks not done, and batch-size feedback.
"""
import json
import os
from pathlib import Path
import time
import unittest

from test_dispatchd import AP_GREEN, build, devin_slot, events, held_lanes, tick


def launched(home):
    return [ln.split()[3] for ln in events(home).splitlines() if ' LAUNCH ' in ln]


def metrics(home, event):
    path = home / '.ashlr-runs' / 'metrics' / 'jobs.jsonl'
    return [r for r in map(json.loads, path.read_text().splitlines()) if r.get('event') == event]


class Batching(unittest.TestCase):
    def setUp(self):
        slots = held_lanes()
        slots['devin'] = devin_slot(target=10, last_change=int(1e15))
        tmp = build(slots=slots)
        self.addCleanup(tmp.cleanup)
        self.home = home = Path(tmp.name).resolve()
        self.r = home / '.ashlr-runs'
        self.q = self.r / 'queue'
        (self.q / 'BATCH_OFF').unlink()
        launch = self.r / 'bin' / 'launch.sh'
        launch.write_text('#!/bin/bash\necho "launched $@"\ncat > "$HOME/.ashlr-runs/$1.stdin"\n')
        launch.chmod(0o755)
        (self.r / 'bin' / 'autopilot.py').write_text(AP_GREEN)

    def queue(self, job, prompt='Edit src/core/queue/store.ts.', repo='phantom', lane='devin', tier='work'):
        (self.home / 'Projects' / 'ashlrai' / repo).mkdir(exist_ok=True)
        pf = self.q / 'prompts' / f'{job}.md'
        pf.write_text(prompt)
        with (self.q / 'ready.tsv').open('a') as f:
            f.write(f'{job}\t{repo}\t{lane}\t{tier}\t{pf}\n')
        with (self.q / 'router-queue.md').open('a') as f:
            f.write(f'- READY {job} (pool={lane}, tier={tier}, repo={repo}): fixture\n')

    def ready(self):
        return [ln.split('\t')[0] for ln in (self.q / 'ready.tsv').read_text().splitlines() if ln]

    def run_tick(self, env=None):
        r = tick(self.home, env)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r

    def only_batch(self):
        batches = [j for j in launched(self.home) if j.startswith('RQ-BATCH-')]
        self.assertEqual(len(batches), 1, events(self.home))
        return batches[0], json.loads((self.q / 'batches' / f'{batches[0]}.json').read_text())

    def test_related_tasks_launch_as_one_session_with_a_checklist(self):
        members = [f'RQ-QQ-{i}' for i in range(6)]
        for j in members:
            self.queue(j)
        self.queue('RQ-LAND-7')                                   # solo kind
        self.queue('RQ-LOCUS-1', repo='locus')                    # alone in its repo
        self.run_tick()
        bid, manifest = self.only_batch()
        self.assertRegex(bid, r'^RQ-BATCH-PHANTOM-QUEUE-[0-9a-f]{8}$')
        self.assertEqual(sorted(launched(self.home)), sorted([bid, 'RQ-LAND-7', 'RQ-LOCUS-1']))
        self.assertEqual([m['job'] for m in manifest['members']], members)
        self.assertEqual((manifest['lane'], manifest['area'], manifest['size_target']), ('devin', 'src/core/queue', 16))
        self.assertEqual(self.ready(), [])
        prompt = (self.q / 'prompts' / f'{bid}.md').read_text()
        self.assertIn(f'<!-- batch-checklist:{bid} -->', prompt)
        self.assertEqual(prompt.count('Edit src/core/queue/store.ts.'), 6)
        line = (self.q / 'run' / f'{bid}.line').read_text().split('\t')
        self.assertEqual(line[:4], [bid, 'phantom', 'devin', 'work'])
        deadline = time.monotonic() + 3   # the launcher received the batch prompt on stdin
        while not (self.r / f'{bid}.stdin').exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        time.sleep(0.05)
        self.assertEqual((self.r / f'{bid}.stdin').read_text(), prompt)
        for j in members:
            self.assertEqual((self.q / 'run' / f'{j}.batched').read_text(), bid)
            self.assertEqual((self.q / 'run' / f'{j}.batch-attempts').read_text(), '1')
        self.assertEqual(sorted(m['job'] for m in metrics(self.home, 'batch_claim')), members)
        self.assertEqual([m['batch_size'] for m in metrics(self.home, 'launch') if m['job'] == bid], [6])
        self.assertIn(f'BATCH {bid} 6 tasks repo=phantom area=src/core/queue lane=devin size_target=16', events(self.home))
        status = json.loads((self.q / 'status.json').read_text())
        self.assertEqual(status['batching']['launched_this_tick'], [{'job': bid, 'tasks': 6}])

        # A member line that comes back while its batch runs is dropped, not launched a second time.
        self.queue('RQ-QQ-0')
        self.run_tick()
        self.assertIn(f'SKIP_BATCHED RQ-QQ-0 owned by {bid}', events(self.home))
        self.assertEqual(self.ready(), [])

    def test_two_small_groups_and_the_off_switch(self):
        for j in ('RQ-A-1', 'RQ-A-2'):
            self.queue(j, prompt='touch docs/a.md')
        self.run_tick()
        self.assertEqual(sorted(launched(self.home)), ['RQ-A-1', 'RQ-A-2'])   # under MIN_BATCH: one each
        (self.q / 'BATCH_OFF').write_text('')
        for j in ('RQ-B-1', 'RQ-B-2', 'RQ-B-3'):
            self.queue(j)
        self.run_tick()
        self.assertFalse([j for j in launched(self.home) if j.startswith('RQ-BATCH-')])

    def test_tasks_at_the_attempt_limit_only_run_solo(self):
        for j in ('RQ-T-1', 'RQ-T-2', 'RQ-T-3'):
            self.queue(j)
        (self.q / 'run' / 'RQ-T-3.batch-attempts').write_text('2')
        self.run_tick()
        self.assertEqual(sorted(launched(self.home)), ['RQ-T-1', 'RQ-T-2', 'RQ-T-3'])

    def test_a_batch_that_fails_to_launch_releases_its_members(self):
        launch = self.r / 'bin' / 'launch.sh'
        launch.write_text('#!/bin/bash\necho "worktree add failed"\nexit 1\n')
        for j in ('RQ-F-1', 'RQ-F-2', 'RQ-F-3'):
            self.queue(j)
        self.run_tick()
        bid, _ = self.only_batch()
        deadline = time.monotonic() + 3
        while 'failed' not in ((self.r / f'{bid}.launch').read_text() if (self.r / f'{bid}.launch').exists() else ''):
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.01)
        old = time.time() - 600   # past the launch grace window
        os.utime(self.q / 'run' / f'{bid}.dispatched', (old, old))
        (self.r / 'HOLD').write_text('devin\n')
        self.run_tick()
        self.assertIn(f'LAUNCH_FAILED {bid}', events(self.home))
        self.assertIn(f'BATCH_RELEASED {bid} 3 tasks requeued (launch failed)', events(self.home))
        self.assertEqual(sorted(self.ready()), ['RQ-F-1', 'RQ-F-2', 'RQ-F-3'])
        self.assertFalse(list((self.q / 'run').glob('*.batched')))
        self.assertEqual((self.q / 'run' / 'RQ-F-1.batch-attempts').read_text(), '0')

    def test_reap_logs_each_task_requeues_the_rest_and_tunes_size(self):
        members = [f'RQ-R-{i}' for i in range(6)]
        for j in members:
            self.queue(j)
        self.run_tick()
        bid, _ = self.only_batch()
        (self.q / 'prompts' / 'RQ-R-5.md').unlink()   # prompt cleaned up meanwhile: restored from the manifest
        # The session finished: worktree with its checklist, an old log, the launch acknowledged.
        wt = self.home / 'Projects/ashlrai/wt' / bid
        wt.mkdir()
        (wt / 'BRIDGE_NOTES.md').write_text(
            f'<!-- batch-checklist:{bid} -->\n- [x] RQ-R-0 — done: ok\n- [x] RQ-R-1 — done: ok\n'
            '- [ ] RQ-R-2 — failed: upstream\n- [ ] RQ-R-3 — skipped: already fixed\n- [ ] RQ-R-4 — pending\n')
        old = time.time() - 600
        for path, content in [(self.r / f'{bid}.base', f'deadbeef phantom {wt} devin\n'), (self.r / f'{bid}.log', 'done\n')]:
            path.write_text(content)
            os.utime(path, (old, old))
        (self.q / 'run' / f'{bid}.dispatched').unlink(missing_ok=True)
        (self.r / 'HOLD').write_text('devin\n')   # keep the requeued lines visible in ready.tsv
        (self.r / 'phantom-open-prs').write_text(f'{int(time.time())} 0\n')   # under the phantom PR drip limit
        git = self.home / 'stubbin' / 'git'
        git.write_text('#!/bin/sh\nexit 0\n')
        git.chmod(0o755)
        self.assertIn(f'REAP {bid} (devin)', self.run_tick().stdout)
        got = {m['job']: m['outcome'] for m in metrics(self.home, 'task_outcome')}
        self.assertEqual(got, {'RQ-R-0': 'done', 'RQ-R-1': 'done', 'RQ-R-2': 'failed', 'RQ-R-3': 'skipped',
                               'RQ-R-4': 'unreported', 'RQ-R-5': 'unreported'})
        self.assertTrue(all(m['batch'] == bid and m['lane'] == 'devin' for m in metrics(self.home, 'task_outcome')))
        self.assertEqual(sorted(self.ready()), ['RQ-R-2', 'RQ-R-4', 'RQ-R-5'])
        self.assertTrue((self.q / 'prompts' / 'RQ-R-5.md').read_text().startswith('Edit src/core/queue'))
        self.assertFalse(list((self.q / 'run').glob('*.batched')))
        finish = [m for m in metrics(self.home, 'finish') if m['job'] == bid]
        self.assertEqual(finish[0]['batch_size'], 6)
        tuning = json.loads((self.q / 'batch-tuning.json').read_text())
        self.assertEqual(tuning['lanes']['devin']['size'], 11)   # 3 of 6 done or skipped: shrink 16 -> 11
        manifest = json.loads((self.q / 'batches' / f'{bid}.json').read_text())
        self.assertIn('reaped', manifest)
        self.assertIn(f'BATCH_REAPED {bid} done=2 skipped=1 failed=1 deferred=0 unreported=2 requeued=3 size[devin] 16->11',
                      events(self.home))


if __name__ == '__main__':
    unittest.main()
