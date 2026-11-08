"""Tests for contrib/mac/rebase_order.py and its batch wiring (RQ-SWE3-REBASEORDER-1).

Pure-function unit tests cover file-set extraction, the transitive file-overlap
clustering, deterministic ordering and the batcher grouping rules. The fixture
tests reuse the test_batching.py harness — a synthetic ~/.ashlr-runs under a temp
HOME, one dispatchd tick per subprocess — to prove sibling rebase jobs land in
one RQ-BATCH-* session while disjoint ones launch apart.
"""
import json
from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import batcher as b          # noqa: E402
import rebase_order as ro    # noqa: E402

from test_dispatchd import AP_GREEN, build, devin_slot, events, held_lanes, tick   # noqa: E402


def rebase_text(n, files, sha='aaaaaaa', cluster=None):
    """A queuegen REBASE line as prompt_body embeds it: attrs, then the text."""
    clu = f', cluster={cluster}' if cluster else ''
    attrs = f'(P0, pool=devin, tier=work, repo=phantom{clu}, after none, queuegen 09:31)'
    return (f'RQ-REBASE-phantom-{n}-{sha} {attrs}: '
            f'REBASE phantom#{n} branch=bridge/x head={sha} file={files[0]} check="merge-tree" '
            f'acceptance="git merge-tree --write-tree deadbeef0000 {sha}" '
            f'conflicts="{", ".join(files)}": resolve every listed conflict against the base and push. '
            f'https://github.com/ashlrai/phantom/pull/{n}')


def task(job, area='src/core/queue', repo='phantom', tier='work', lane='devin', chars=1000, prompt=''):
    return {'job': job, 'repo': repo, 'tier': tier, 'lane': lane, 'area': area, 'chars': chars, 'prompt': prompt}


class FilesFrom(unittest.TestCase):
    def test_conflicts_list_and_file_token(self):
        text = rebase_text(41, ['src/a.ts', 'src/b.ts'])
        self.assertEqual(ro.files_from(text), {'src/a.ts', 'src/b.ts'})

    def test_truncated_tail_outside_quotes_is_ignored(self):
        text = 'conflicts="src/a.ts, src/b.ts" +3 more'
        self.assertEqual(ro.files_from(text), {'src/a.ts', 'src/b.ts'})

    def test_single_segment_and_rejected_tokens(self):
        # Extensionless basenames (LICENSE, Makefile) count; schemes, parent
        # traversal and empty tokens are rejected (queuegen validPath semantics).
        text = 'conflicts="package.json, ../evil, http://x/y, , src/ok.ts, a" * bad'
        self.assertEqual(ro.files_from(text), {'package.json', 'src/ok.ts', 'a'})
        self.assertEqual(ro.files_from(''), set())
        self.assertEqual(ro.files_from(None), set())


class Clusters(unittest.TestCase):
    def test_transitive_overlap_is_one_cluster_disjoint_is_another(self):
        got = ro.clusters([('A', {'src/a.ts'}), ('B', {'src/a.ts', 'src/b.ts'}),
                           ('C', {'src/b.ts'}), ('D', {'src/c.ts'})])
        self.assertEqual(got, [['A', 'B', 'C'], ['D']])

    def test_empty_file_sets_never_merge(self):
        got = ro.clusters([('A', set()), ('B', set()), ('C', {'x'})])
        self.assertEqual(got, [['A'], ['B'], ['C']])

    def test_deterministic_membership_regardless_of_file_iteration(self):
        items = [('A', {'x', 'y'}), ('B', {'y'}), ('C', {'z'}), ('D', {'x', 'z'})]
        self.assertEqual(ro.clusters(items), [['A', 'B', 'C', 'D']])


class ClusterKey(unittest.TestCase):
    def test_lowest_pr_number(self):
        self.assertEqual(ro.cluster_key(['RQ-REBASE-phantom-41-aaaaaaa',
                                         'RQ-REBASE-phantom-9-bbbbbbb']), 'clu-9')

    def test_non_rebase_ids_fall_back_to_min_job(self):
        self.assertEqual(ro.cluster_key(['RQ-REBASE-phantom-41-aaaaaaa', 'RQ-X-1']),
                         'clu-RQ-REBASE-phantom-41-aaaaaaa')


class BatchOrder(unittest.TestCase):
    def test_same_cluster_same_batch_disjoint_spread(self):
        items = [('A', {'x'}), ('B', {'x'}), ('C', {'y'}), ('D', {'z'})]
        groups = ro.clusters(items)
        batches = ro.batch_order(items, 4)
        self.assertEqual(batches, [['A', 'B'], ['C'], ['D']])
        for batch in batches:   # a batch never mixes clusters
            self.assertTrue(any(set(batch) <= set(group) for group in groups), batch)

    def test_biggest_cluster_first_and_size_chunking(self):
        big = [(f'B{i}', {'x'}) for i in range(5)]
        small = [('S1', {'y'}), ('S2', {'y'})]
        batches = ro.batch_order(small + big, 3)
        self.assertEqual(batches, [['B0', 'B1', 'B2'], ['B3', 'B4'], ['S1', 'S2']])

    def test_size_floor_is_one(self):
        self.assertEqual(ro.batch_order([('A', {'x'})], 0), [['A']])


class AssignAreas(unittest.TestCase):
    def test_rebase_tasks_take_cluster_areas_others_untouched(self):
        tasks = [task('RQ-REBASE-phantom-41-aaaaaaa', prompt=rebase_text(41, ['src/a.ts'])),
                 task('RQ-REBASE-phantom-42-bbbbbbb', prompt=rebase_text(42, ['src/a.ts', 'src/b.ts'])),
                 task('RQ-REBASE-phantom-43-ccccccc', prompt=rebase_text(43, ['src/c.ts'])),
                 task('RQ-OTHER-1', prompt='Edit src/core/queue/store.ts.')]
        self.assertEqual(ro.assign_areas(tasks), 3)
        self.assertEqual([t['area'] for t in tasks],
                         ['rebase:clu-41', 'rebase:clu-41', 'rebase:clu-43', 'src/core/queue'])

    def test_stamped_cluster_wins_and_pulls_unstamped_siblings_in(self):
        # #41 and #42 share a generator stamp but no visible file; #43 is
        # unstamped yet shares src/z.ts with #42 — one component, stamp's key.
        tasks = [task('RQ-REBASE-phantom-41-aaaaaaa', prompt=rebase_text(41, ['src/a.ts'], cluster='clu-9')),
                 task('RQ-REBASE-phantom-42-bbbbbbb', prompt=rebase_text(42, ['src/z.ts'], cluster='clu-9')),
                 task('RQ-REBASE-phantom-43-ccccccc', prompt=rebase_text(43, ['src/z.ts'], sha='ccccccc'))]
        self.assertEqual(ro.assign_areas(tasks), 3)
        self.assertEqual({t['area'] for t in tasks}, {'rebase:clu-9'})

    def test_shared_file_unions_distinct_stamps(self):
        tasks = [task('RQ-REBASE-phantom-41-aaaaaaa', prompt=rebase_text(41, ['src/a.ts'], cluster='clu-41')),
                 task('RQ-REBASE-phantom-42-bbbbbbb', prompt=rebase_text(42, ['src/a.ts'], cluster='clu-42'))]
        # Same visible file but different generator keys: the shared file unions
        # them anyway (a stamp merges, never splits), lowest stamp names it.
        ro.assign_areas(tasks)
        self.assertEqual({t['area'] for t in tasks}, {'rebase:clu-41'})


class PickMembersRebase(unittest.TestCase):
    def test_rebase_pair_batches_at_two(self):
        lead = task('RQ-REBASE-phantom-41-aaaaaaa', area='rebase:clu-41')
        pool = [task('RQ-REBASE-phantom-42-bbbbbbb', area='rebase:clu-41')]
        self.assertEqual([c['job'] for c in b.pick_members(lead, pool, 16)],
                         ['RQ-REBASE-phantom-41-aaaaaaa', 'RQ-REBASE-phantom-42-bbbbbbb'])

    def test_rebase_singleton_stays_solo(self):
        lead = task('RQ-REBASE-phantom-41-aaaaaaa', area='rebase:clu-41')
        pool = [task('RQ-REBASE-phantom-42-bbbbbbb', area='rebase:clu-42')]
        self.assertEqual(b.pick_members(lead, pool, 16), [])

    def test_rebase_cluster_never_absorbs_orphans(self):
        lead = task('RQ-REBASE-phantom-41-aaaaaaa', area='rebase:clu-41')
        pool = [task('RQ-REBASE-phantom-42-bbbbbbb', area='rebase:clu-41'),
                task('RQ-X-1', area='src/core/queue'), task('RQ-X-2', area='src/core/queue')]
        got = b.pick_members(lead, pool, 16)
        self.assertEqual(sorted(c['job'] for c in got),
                         ['RQ-REBASE-phantom-41-aaaaaaa', 'RQ-REBASE-phantom-42-bbbbbbb'])

    def test_orphans_never_absorb_a_rebase_member(self):
        lead = task('RQ-L-1', area='docs/x')
        pool = [task('RQ-L-2', area='docs/x'),
                task('RQ-REBASE-phantom-41-aaaaaaa', area='rebase:clu-41'),
                task('RQ-REBASE-phantom-42-bbbbbbb', area='rebase:clu-41'),
                task('RQ-M-1', area='src/core/queue')]
        got = b.pick_members(lead, pool, 16)
        self.assertNotIn('RQ-REBASE-phantom-41-aaaaaaa', [c['job'] for c in got])
        self.assertNotIn('RQ-REBASE-phantom-42-bbbbbbb', [c['job'] for c in got])


def launched(home):
    return [ln.split()[3] for ln in events(home).splitlines() if ' LAUNCH ' in ln]


class RebaseBatchTicks(unittest.TestCase):
    """dispatchd ticks over ready rebase jobs (the test_batching.py harness)."""

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
        launch.write_text('#!/bin/bash\necho "launched $@"\n')
        launch.chmod(0o755)
        (self.r / 'bin' / 'autopilot.py').write_text(AP_GREEN)

    def queue(self, job, prompt, repo='phantom', lane='devin', tier='work'):
        (self.home / 'Projects' / 'ashlrai' / repo).mkdir(exist_ok=True)
        pf = self.q / 'prompts' / f'{job}.md'
        pf.write_text(prompt)
        with (self.q / 'ready.tsv').open('a') as f:
            f.write(f'{job}\t{repo}\t{lane}\t{tier}\t{pf}\n')
        with (self.q / 'router-queue.md').open('a') as f:
            f.write(f'- READY {job} (pool={lane}, tier={tier}, repo={repo}): fixture\n')

    def run_tick(self):
        r = tick(self.home)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r

    def batches(self):
        out = []
        for j in launched(self.home):
            if j.startswith('RQ-BATCH-'):
                m = json.loads((self.q / 'batches' / f'{j}.json').read_text())
                out.append((j, sorted(x['job'] for x in m['members'])))
        return out

    def test_siblings_share_one_batch_and_disjoint_launches_solo(self):
        self.queue('RQ-REBASE-phantom-41-aaaaaaa', rebase_text(41, ['src/x.ts', 'src/y.ts']))
        self.queue('RQ-REBASE-phantom-42-bbbbbbb', rebase_text(42, ['src/y.ts', 'src/z.ts'], sha='bbbbbbb'))
        self.queue('RQ-REBASE-phantom-43-ccccccc', rebase_text(43, ['docs/d.md'], sha='ccccccc'))
        self.run_tick()
        batches = self.batches()
        self.assertEqual(len(batches), 1, events(self.home))
        bid, members = batches[0]
        self.assertRegex(bid, r'^RQ-BATCH-PHANTOM-CLU-41-[0-9a-f]{8}$')
        self.assertEqual(members, ['RQ-REBASE-phantom-41-aaaaaaa', 'RQ-REBASE-phantom-42-bbbbbbb'])
        self.assertIn('RQ-REBASE-phantom-43-ccccccc', launched(self.home))   # disjoint: its own session
        self.assertIn(f'area=rebase:clu-41', events(self.home))

    def test_transitive_cluster_forms_one_batch(self):
        self.queue('RQ-REBASE-phantom-41-aaaaaaa', rebase_text(41, ['src/a.ts']))
        self.queue('RQ-REBASE-phantom-42-bbbbbbb', rebase_text(42, ['src/a.ts', 'src/b.ts'], sha='bbbbbbb'))
        self.queue('RQ-REBASE-phantom-43-ccccccc', rebase_text(43, ['src/b.ts'], sha='ccccccc'))
        self.run_tick()
        batches = self.batches()
        self.assertEqual(len(batches), 1, events(self.home))
        self.assertEqual(batches[0][1], ['RQ-REBASE-phantom-41-aaaaaaa',
                                         'RQ-REBASE-phantom-42-bbbbbbb', 'RQ-REBASE-phantom-43-ccccccc'])

    def test_stamped_siblings_batch_without_a_shared_visible_file(self):
        # The generator stamped the same cluster key over the full touched-file
        # list; the prompts' visible conflicts share nothing and still co-batch.
        self.queue('RQ-REBASE-phantom-41-aaaaaaa', rebase_text(41, ['src/a.ts'], cluster='clu-9'))
        self.queue('RQ-REBASE-phantom-42-bbbbbbb', rebase_text(42, ['src/z.ts'], cluster='clu-9', sha='bbbbbbb'))
        self.run_tick()
        batches = self.batches()
        self.assertEqual(len(batches), 1, events(self.home))
        self.assertEqual(batches[0][1], ['RQ-REBASE-phantom-41-aaaaaaa', 'RQ-REBASE-phantom-42-bbbbbbb'])

    def test_two_disjoint_clusters_form_two_batches(self):
        self.queue('RQ-REBASE-phantom-41-aaaaaaa', rebase_text(41, ['src/a.ts']))
        self.queue('RQ-REBASE-phantom-42-bbbbbbb', rebase_text(42, ['src/a.ts'], sha='bbbbbbb'))
        self.queue('RQ-REBASE-phantom-50-ddddddd', rebase_text(50, ['docs/z.md'], sha='ddddddd'))
        self.queue('RQ-REBASE-phantom-51-eeeeeee', rebase_text(51, ['docs/z.md'], sha='eeeeeee'))
        self.run_tick()
        batches = self.batches()
        self.assertEqual(len(batches), 2, events(self.home))
        members = sorted(tuple(m) for _bid, m in batches)
        self.assertEqual(members, [('RQ-REBASE-phantom-41-aaaaaaa', 'RQ-REBASE-phantom-42-bbbbbbb'),
                                   ('RQ-REBASE-phantom-50-ddddddd', 'RQ-REBASE-phantom-51-eeeeeee')])
        areas = sorted(re.search(r'area=(\S+)', ln).group(1)
                       for ln in events(self.home).splitlines() if ' BATCH ' in ln)
        self.assertEqual(areas, ['rebase:clu-41', 'rebase:clu-50'])

    def test_rebase_member_is_not_absorbed_into_an_unrelated_batch(self):
        # The lead's own area is below MIN_BATCH, so it fills from small-area
        # orphans; a rebase cluster member must never be that orphan.
        self.queue('RQ-M-1', 'Edit src/other/x.ts.')
        self.queue('RQ-N-1', 'Edit src/core/queue/store.ts.')
        self.queue('RQ-N-2', 'Edit src/core/queue/store.ts.')
        self.queue('RQ-REBASE-phantom-41-aaaaaaa', rebase_text(41, ['src/x.ts']))
        self.run_tick()
        batches = self.batches()
        self.assertEqual(len(batches), 1, events(self.home))
        self.assertEqual(batches[0][1], ['RQ-M-1', 'RQ-N-1', 'RQ-N-2'])
        self.assertIn('RQ-REBASE-phantom-41-aaaaaaa', launched(self.home))   # solo, not absorbed

    def test_rebase_job_with_no_parseable_files_stays_solo(self):
        self.queue('RQ-REBASE-phantom-41-aaaaaaa', 'REBASE phantom#41 branch=b head=aaaaaaa: resolve conflicts')
        self.queue('RQ-REBASE-phantom-42-bbbbbbb', 'REBASE phantom#42 branch=b head=bbbbbbb: resolve conflicts')
        self.run_tick()
        self.assertEqual(self.batches(), [])
        self.assertIn('RQ-REBASE-phantom-41-aaaaaaa', launched(self.home))
        self.assertIn('RQ-REBASE-phantom-42-bbbbbbb', launched(self.home))


class CliPlan(unittest.TestCase):
    def test_stdin_tsv_and_json(self):
        import subprocess
        script = Path(__file__).resolve().parents[1] / 'rebase_order.py'
        rows = ('RQ-REBASE-phantom-41-aaaaaaa\t' + rebase_text(41, ['src/a.ts']) + '\n'
                'RQ-REBASE-phantom-42-bbbbbbb\t' + rebase_text(42, ['src/a.ts'], sha='bbbbbbb') + '\n'
                'RQ-REBASE-phantom-50-ddddddd\t' + rebase_text(50, ['docs/z.md'], sha='ddddddd') + '\n')
        r = subprocess.run([sys.executable, '-B', str(script), '--size', '4'],
                           input=rows, capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        self.assertEqual(out['batches'], [['RQ-REBASE-phantom-41-aaaaaaa', 'RQ-REBASE-phantom-42-bbbbbbb'],
                                          ['RQ-REBASE-phantom-50-ddddddd']])
        self.assertEqual(out['areas']['RQ-REBASE-phantom-41-aaaaaaa'], 'rebase:clu-41')
        r = subprocess.run([sys.executable, '-B', str(script)],
                           input=json.dumps([{'job': 'RQ-REBASE-phantom-7-aaaaaaa', 'files': ['a/b.ts']}]),
                           capture_output=True, text=True, timeout=30)
        self.assertEqual(json.loads(r.stdout)['areas'], {'RQ-REBASE-phantom-7-aaaaaaa': 'rebase:clu-7'})


if __name__ == '__main__':
    unittest.main()
