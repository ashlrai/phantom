"""Fixture tests for batching in contrib/mac/dispatchd.py (RQ-QUEUE-BATCH-1, per-line since RQ-BATCH-SESSIONS-2).

Same harness as test_dispatchd.py (synthetic ~/.ashlr-runs in a temp HOME, one tick per subprocess), with
queue/BATCH_OFF removed and a bin/batch-launch.sh stub so related ready lines launch as one RQ-BATCH-* session.
Covers grouping, per-line leases, the per-line prompt and manifest (worktree and model per line), solo kinds,
the duplicate-line guard, the attempt limit, the off switch, Devin routing, and the reap path: per-line outcome
metrics, done lines handed to their own per-job publish, failed lines requeued alone, and size feedback.
"""
import json
import os
from pathlib import Path
import time
import unittest

from test_dispatchd import AP_GREEN, SCRIPT, build, devin_slot, events, held_lanes, tick


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
        for name in ('launch.sh', 'batch-launch.sh'):   # the wrapper itself is covered in test_batch_sessions.py
            launch = self.r / 'bin' / name
            launch.write_text('#!/bin/bash\necho "launched $@"\ncat > "$HOME/.ashlr-runs/$1.stdin"\n')
            launch.chmod(0o755)
        (self.r / 'bin' / 'autopilot.py').write_text(AP_GREEN)

    def queue(self, job, prompt='Edit src/core/queue/store.ts.', repo='phantom', lane='devin', tier='work', attrs=''):
        (self.home / 'Projects' / 'ashlrai' / repo).mkdir(exist_ok=True)
        pf = self.q / 'prompts' / f'{job}.md'
        pf.write_text(prompt)
        with (self.q / 'ready.tsv').open('a') as f:
            f.write(f'{job}\t{repo}\t{lane}\t{tier}\t{pf}\n')
        with (self.q / 'router-queue.md').open('a') as f:
            f.write(f'- READY {job} (pool={lane}, tier={tier}, repo={repo}{attrs}): fixture\n')

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

    def test_related_tasks_launch_as_one_session_with_per_line_leases(self):
        members = [f'RQ-QQ-{i}' for i in range(6)]
        for j in members:
            self.queue(j, tier='frontier' if j == 'RQ-QQ-5' else 'work')   # tiers may mix inside a bundle
        self.queue('RQ-LAND-7')                                   # solo kind
        self.queue('RQ-LOCUS-1', repo='locus')                    # alone in its repo
        self.run_tick()
        bid, manifest = self.only_batch()
        self.assertRegex(bid, r'^RQ-BATCH-PHANTOM-QUEUE-[0-9a-f]{8}$')
        self.assertEqual(sorted(launched(self.home)), sorted([bid, 'RQ-LAND-7', 'RQ-LOCUS-1']))
        self.assertEqual([m['job'] for m in manifest['members']], members)
        self.assertEqual((manifest['lane'], manifest['area'], manifest['size_target'], manifest['mode']),
                         ('devin', 'src/core/queue', 8, 'per-line'))
        self.assertEqual({m['model'] for m in manifest['members']}, {'swe-2-flash'})
        self.assertEqual(self.ready(), [])
        prompt = (self.q / 'prompts' / f'{bid}.md').read_text()
        self.assertIn(f'<!-- batch-checklist:{bid} -->', prompt)
        self.assertEqual(prompt.count('Edit src/core/queue/store.ts.'), 6)
        wtroot = self.home / 'Projects' / 'ashlrai' / 'wt'
        for j in members:
            self.assertIn(f'Worktree: {wtroot}/{j} (branch codex-bridge/{j})', prompt)
        line = (self.q / 'run' / f'{bid}.line').read_text().split('\t')
        self.assertEqual(line[:4], [bid, 'phantom', 'devin', 'work'])
        deadline = time.monotonic() + 30   # the launcher received the batch prompt on stdin
        while not (self.r / f'{bid}.stdin').exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        time.sleep(0.05)
        self.assertEqual((self.r / f'{bid}.stdin').read_text(), prompt)
        for j in members:
            self.assertEqual((self.q / 'run' / f'{j}.batched').read_text(), bid)
            self.assertEqual((self.q / 'run' / f'{j}.batch-attempts').read_text(), '1')
        self.assertEqual(sorted(m['job'] for m in metrics(self.home, 'batch_claim')), members)
        self.assertEqual([m['batch_size'] for m in metrics(self.home, 'launch') if m['job'] == bid], [6])
        self.assertIn(f'BATCH {bid} 6 tasks repo=phantom area=src/core/queue lane=devin size_target=8', events(self.home))
        status = json.loads((self.q / 'status.json').read_text())
        self.assertEqual(status['batching']['launched_this_tick'], [{'job': bid, 'tasks': 6}])

        # A member line that comes back while its batch runs is dropped, not launched a second time.
        self.queue('RQ-QQ-0')
        self.run_tick()
        self.assertIn(f'SKIP_BATCHED RQ-QQ-0 owned by {bid}', events(self.home))
        self.assertEqual(self.ready(), [])

    def test_a_lone_line_runs_solo_and_the_off_switches(self):
        self.queue('RQ-A-1', prompt='touch docs/a.md')
        self.run_tick()
        self.assertEqual(launched(self.home), ['RQ-A-1'])   # under MIN_BATCH: solo
        (self.r / 'bin' / 'batch-launch.sh').unlink()      # wrapper not installed: no bundles
        for j in ('RQ-C-1', 'RQ-C-2'):
            self.queue(j)
        self.run_tick()
        self.assertEqual(sorted(launched(self.home)), ['RQ-A-1', 'RQ-C-1', 'RQ-C-2'])
        (self.r / 'bin' / 'batch-launch.sh').write_text('#!/bin/bash\n')
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
        bid, manifest = self.only_batch()
        self.assertEqual([m['job'] for m in manifest['members']], ['RQ-T-1', 'RQ-T-2'])
        self.assertEqual(sorted(launched(self.home)), sorted([bid, 'RQ-T-3']))

    def test_a_line_another_bundle_holds_is_skipped_and_never_double_leased(self):
        for j in ('RQ-H-1', 'RQ-H-2', 'RQ-H-3'):
            self.queue(j)
        (self.q / 'batches').mkdir(exist_ok=True)
        (self.q / 'batches' / 'RQ-BATCH-OTHER.json').write_text('{}')   # a live bundle owns RQ-H-1
        (self.q / 'run' / 'RQ-H-1.batched').write_text('RQ-BATCH-OTHER')
        self.run_tick()
        bid, manifest = self.only_batch()
        self.assertEqual([m['job'] for m in manifest['members']], ['RQ-H-2', 'RQ-H-3'])
        self.assertEqual((self.q / 'run' / 'RQ-H-1.batched').read_text(), 'RQ-BATCH-OTHER')
        self.assertIn('SKIP_BATCHED RQ-H-1 owned by RQ-BATCH-OTHER', events(self.home))

    def test_an_orphaned_lease_is_released(self):
        (self.q / 'run' / 'RQ-O-1.batched').write_text('RQ-BATCH-GONE')
        self.run_tick()
        self.assertFalse((self.q / 'run' / 'RQ-O-1.batched').exists())
        self.assertIn('LEASE_ORPHANED RQ-O-1 owner=RQ-BATCH-GONE released', events(self.home))

    def test_devin_keeps_small_eligible_lines_and_routes_the_rest(self):
        (self.r / 'bin' / 'batch-sessions.json').write_text((Path(__file__).resolve().parents[1] / 'batch-sessions.json').read_text())
        slots = json.loads((self.q / 'slots.json').read_text())
        slots['claude'] = dict(slots['devin'])
        (self.q / 'slots.json').write_text(json.dumps(slots))
        (self.q / 'BATCH_OFF').write_text('')
        self.queue('RQ-DV-SMALL', attrs=', size<=40')
        self.queue('RQ-DV-BIG', attrs=', size<=400')
        self.queue('RQ-DV-LOCUS', repo='locus', attrs=', size<=40')
        self.run_tick()
        ev = events(self.home)
        self.assertNotIn('DEVIN_ROUTE RQ-DV-SMALL', ev)
        self.assertIn('DEVIN_ROUTE RQ-DV-BIG size-not-sm -> claude', ev)
        self.assertIn('DEVIN_ROUTE RQ-DV-LOCUS repo-not-eligible -> claude', ev)
        lanes = {ln.split()[3]: ln.split()[5] for ln in ev.splitlines() if ' LAUNCH ' in ln}
        self.assertEqual(lanes, {'RQ-DV-SMALL': 'devin', 'RQ-DV-BIG': 'claude', 'RQ-DV-LOCUS': 'claude'})

    def test_a_batch_that_fails_to_launch_releases_its_members(self):
        launch = self.r / 'bin' / 'batch-launch.sh'
        launch.write_text('#!/bin/bash\necho "worktree add failed"\nexit 1\n')
        for j in ('RQ-F-1', 'RQ-F-2', 'RQ-F-3'):
            self.queue(j)
        self.run_tick()
        bid, _ = self.only_batch()
        deadline = time.monotonic() + 30   # the launcher is a detached child; a loaded host can be slow to run it
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

    def test_reap_hands_done_lines_to_their_own_publish_requeues_the_rest_and_tunes_size(self):
        members = [f'RQ-R-{i}' for i in range(6)]
        for j in members:
            self.queue(j)
        self.run_tick()
        bid, _ = self.only_batch()
        (self.q / 'prompts' / 'RQ-R-5.md').unlink()   # prompt cleaned up meanwhile: restored from the manifest
        old = time.time() - 600
        wtroot = self.home / 'Projects/ashlrai/wt'
        # What batch-launch.sh left behind: a worktree, .base and wrapper marker for RQ-R-0..4 (RQ-R-5 got none).
        for j in members[:5]:
            (wtroot / j).mkdir()
            (self.r / f'{j}.base').write_text(f'deadbeef codex-bridge/{j} {wtroot / j} devin\n')
            (self.q / 'run' / f'{j}.bundle-wt').write_text(bid + '\n')
        (self.q / 'run' / 'RQ-R-5.prep-failed').write_text('worktree add failed\n')
        # A .base left over from an earlier solo attempt is not a prepared worktree (RQ-BATCH-SESSIONS-2).
        (self.r / 'RQ-R-5.base').write_text('cafef00d codex-bridge/RQ-R-5 /elsewhere devin\n')
        # The session finished: its own worktree with the checklist, an old log, the launch acknowledged.
        wt = wtroot / bid
        wt.mkdir()
        (wt / 'BRIDGE_NOTES.md').write_text(
            f'<!-- batch-checklist:{bid} -->\n- [x] RQ-R-0: done: ok\n- [x] RQ-R-1: done: ok\n'
            '- [ ] RQ-R-2: failed: upstream\n- [ ] RQ-R-3: skipped: already fixed\n- [ ] RQ-R-4: pending\n'
            '- [x] RQ-R-5: done: claims done without a worktree\n')
        for path, content in [(self.r / f'{bid}.base', f'deadbeef codex-bridge/{bid} {wt} devin\n'), (self.r / f'{bid}.log', 'done\n')]:
            path.write_text(content)
            os.utime(path, (old, old))
        (self.q / 'run' / f'{bid}.dispatched').unlink(missing_ok=True)
        (self.r / 'HOLD').write_text('devin\n')   # keep the requeued lines visible in ready.tsv
        (self.r / 'phantom-open-prs').write_text(f'{int(time.time())} 0\n')   # under the phantom PR drip limit
        git = self.home / 'stubbin' / 'git'
        git.write_text('#!/bin/sh\necho "git $*" >> "$HOME/git.log"\nexit 0\n')
        git.chmod(0o755)
        (self.q / '.worktree-reap.stamp').unlink(missing_ok=True)   # refresh the 10-minute reap candidate cache now
        out = self.run_tick().stdout
        self.assertIn(f'REAP {bid} (devin) bundle', out)
        got = {m['job']: m['outcome'] for m in metrics(self.home, 'task_outcome')}
        self.assertEqual(got, {'RQ-R-0': 'done', 'RQ-R-1': 'done', 'RQ-R-2': 'failed', 'RQ-R-3': 'skipped',
                               'RQ-R-4': 'unreported', 'RQ-R-5': 'deferred'})
        self.assertTrue(all(m['batch'] == bid and m['lane'] == 'devin' and m['model'] == 'swe-2-flash'
                            for m in metrics(self.home, 'task_outcome')))
        self.assertEqual(sorted(self.ready()), ['RQ-R-2', 'RQ-R-4', 'RQ-R-5'])
        self.assertTrue((self.q / 'prompts' / 'RQ-R-5.md').read_text().startswith('Edit src/core/queue'))
        self.assertFalse(list((self.q / 'run').glob('*.batched')))
        # Done and skipped lines are now ordinary finished jobs; failed ones gave their worktree and .base back.
        for j in ('RQ-R-0', 'RQ-R-1', 'RQ-R-3'):
            self.assertEqual((self.q / 'run' / f'{j}.bundled-in').read_text(), bid)
            self.assertIn(f'bundled in {bid}', (self.r / f'{j}.log').read_text())
            self.assertTrue((self.r / f'{j}.base').exists())
        for j in ('RQ-R-2', 'RQ-R-4'):
            self.assertFalse((self.r / f'{j}.base').exists())
            self.assertFalse((self.q / 'run' / f'{j}.bundle-wt').exists())
        gitlog = (self.home / 'git.log').read_text()
        self.assertIn(f'worktree remove {wtroot}/RQ-R-2', gitlog)
        self.assertIn(f'worktree remove --force {wt}', gitlog)
        self.assertFalse((self.r / f'{bid}.base').exists())
        self.assertEqual((self.q / 'batches' / f'{bid}.notes.md').read_text(), (wt / 'BRIDGE_NOTES.md').read_text())
        finish = [m for m in metrics(self.home, 'finish') if m['job'] == bid]
        self.assertEqual(finish[0]['batch_size'], 6)
        tuning = json.loads((self.q / 'batch-tuning.json').read_text())
        self.assertEqual(tuning['lanes']['devin']['size'], 5)   # 3 of 6 done or skipped: shrink 8 -> 5
        manifest = json.loads((self.q / 'batches' / f'{bid}.json').read_text())
        self.assertIn('reaped', manifest)
        self.assertIn(f'BATCH_REAPED {bid} done=2 skipped=1 failed=1 deferred=1 unreported=1 requeued=3 size[devin] 8->5',
                      events(self.home))
        # Each done line reaps and publishes on its own (one publisher at a time), tagged with its bundle.
        out += self.run_tick().stdout
        self.assertIn('REAP RQ-R-0 (devin)', out)
        row = [m for m in metrics(self.home, 'finish') if m['job'] == 'RQ-R-0']
        self.assertEqual(row[0]['bundle'], bid)


    # ---- RQ-BATCH-SESSIONS-2 regressions: no member line is ever lost, duplicated or left leased ----------------
    def finished_bundle(self, members, notes):
        """Launch members as one bundle, then lay down what a finished session leaves: prepared member worktrees,
        the checklist, an old log. Returns (bid, wt)."""
        for j in members:
            self.queue(j)
        self.run_tick()
        bid, _ = self.only_batch()
        old = time.time() - 600
        wtroot = self.home / 'Projects/ashlrai/wt'
        for j in members:
            (wtroot / j).mkdir()
            (self.r / f'{j}.base').write_text(f'deadbeef codex-bridge/{j} {wtroot / j} devin\n')
            (self.q / 'run' / f'{j}.bundle-wt').write_text(bid + '\n')
        wt = wtroot / bid
        wt.mkdir()
        (wt / 'BRIDGE_NOTES.md').write_text(f'<!-- batch-checklist:{bid} -->\n' + notes)
        for path, content in [(self.r / f'{bid}.base', f'deadbeef codex-bridge/{bid} {wt} devin\n'), (self.r / f'{bid}.log', 'done\n')]:
            path.write_text(content)
            os.utime(path, (old, old))
        (self.q / 'run' / f'{bid}.dispatched').unlink(missing_ok=True)
        (self.r / 'HOLD').write_text('devin\n')
        (self.r / 'phantom-open-prs').write_text(f'{int(time.time())} 0\n')
        (self.q / '.worktree-reap.stamp').unlink(missing_ok=True)
        return bid, wt

    def git_stub(self, body='exit 0'):
        git = self.home / 'stubbin' / 'git'
        git.write_text('#!/bin/sh\necho "git $*" >> "$HOME/git.log"\n' + body + '\n')
        git.chmod(0o755)

    def test_a_bundle_whose_spawn_fails_puts_every_member_back_and_never_queues_the_bundle(self):
        # EAGAIN at fork time, injected only for the wrapper: the solo launch path is untouched.
        (self.home / 'stubbin' / 'sitecustomize.py').write_text(
            'import subprocess\n_P = subprocess.Popen\n'
            'class Popen(_P):\n'
            '    def __init__(self, cmd, *a, **k):\n'
            '        if any(str(c).endswith("batch-launch.sh") for c in cmd): raise BlockingIOError(35, "EAGAIN")\n'
            '        super().__init__(cmd, *a, **k)\n'
            'subprocess.Popen = Popen\n')
        for j in ('RQ-S-1', 'RQ-S-2', 'RQ-S-3'):
            self.queue(j)
        self.run_tick()
        ev = events(self.home)
        bid = [ln.split()[3] for ln in ev.splitlines() if ' BATCH RQ-BATCH-' in ln][0]
        self.assertIn(f'FORK_FAILED {bid} BlockingIOError', ev)
        self.assertIn(f'BATCH_RELEASED {bid} 3 tasks requeued (spawn failed)', ev)
        self.assertEqual(sorted(self.ready()), ['RQ-S-1', 'RQ-S-2', 'RQ-S-3'])   # the bundle id itself never queues
        self.assertFalse(list((self.q / 'run').glob('*.batched')))
        self.assertFalse((self.q / 'run' / f'{bid}.dispatched').exists())
        self.assertEqual((self.q / 'run' / 'RQ-S-1.batch-attempts').read_text(), '0')
        self.assertIn('reaped', json.loads((self.q / 'batches' / f'{bid}.json').read_text()))

    def test_a_member_whose_worktree_cannot_be_retired_still_releases_its_lease_and_requeues(self):
        bid, _ = self.finished_bundle(['RQ-K-1', 'RQ-K-2'], '- [x] RQ-K-1: done: ok\n- [ ] RQ-K-2: failed: flaky\n')
        self.git_stub('case "$*" in *"worktree remove"*RQ-K-2*) exit 1;; esac\nexit 0')
        self.run_tick()
        ev = events(self.home)
        self.assertIn(f'BUNDLE_MEMBER_KEPT {bid} RQ-K-2 kept (remove failed)', ev)
        self.assertEqual(self.ready(), ['RQ-K-2'])
        self.assertFalse((self.q / 'run' / 'RQ-K-2.batched').exists())
        self.assertTrue((self.home / 'Projects/ashlrai/wt/RQ-K-2').is_dir())   # its work stays for the solo retry

    def test_a_reap_interrupted_midway_resumes_without_requeueing_a_member_twice(self):
        bid, _ = self.finished_bundle(['RQ-I-1', 'RQ-I-2'], '- [ ] RQ-I-1: failed: x\n- [ ] RQ-I-2: failed: y\n')
        self.git_stub()
        mp = self.q / 'batches' / f'{bid}.json'
        manifest = json.loads(mp.read_text())
        manifest['handled'] = {'RQ-I-1': 'failed'}   # an earlier pass requeued RQ-I-1, then hit its deadline
        mp.write_text(json.dumps(manifest))
        (self.q / 'run' / 'RQ-I-1.batched').unlink()
        self.run_tick()
        self.assertEqual(self.ready(), ['RQ-I-2'])
        self.assertEqual([m['job'] for m in metrics(self.home, 'task_outcome')], ['RQ-I-2'])
        manifest = json.loads(mp.read_text())
        self.assertEqual(manifest['handled'], {'RQ-I-1': 'failed', 'RQ-I-2': 'failed'})
        self.assertIn('reaped', manifest)

    def test_requeued_lines_survive_a_busy_ready_lock(self):
        # A solo launch came back HELD: its line lives only in memory until ready.tsv is rewritten.
        run = self.q / 'run'
        line = f'RQ-HELD-1\tphantom\tdevin\twork\t{self.q}/prompts/RQ-HELD-1.md'
        (self.q / 'prompts' / 'RQ-HELD-1.md').write_text('x')
        (run / 'RQ-HELD-1.line').write_text(line + '\n')
        (run / 'RQ-HELD-1.dispatched').write_text('0')
        os.utime(run / 'RQ-HELD-1.dispatched', (0, 0))
        (self.r / 'RQ-HELD-1.launch').write_text('HELD: lane cap\n')
        (self.r / 'HOLD').write_text('devin\n')
        busy = self.home / 'stubbin' / 'dispatchd.py'   # the same tick with the end-of-tick write lock busy
        src = SCRIPT.read_text()
        self.assertEqual(src.count('lk = qlock("dispatchd-write", 30)'), 1)
        busy.write_text(src.replace('lk = qlock("dispatchd-write", 30)', 'lk = None'))
        self.assertEqual(tick(self.home, script=busy).returncode, 0)
        self.assertEqual(self.ready(), [])
        self.assertEqual((self.q / 'requeue-pending.tsv').read_text(), line + '\n')
        self.run_tick()   # the next tick picks the carried line up
        self.assertEqual(self.ready(), ['RQ-HELD-1'])
        self.assertFalse((self.q / 'requeue-pending.tsv').exists())


if __name__ == '__main__':
    unittest.main()
