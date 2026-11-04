"""Fixture tests for contrib/mac/restock.py (RQ-QUEUEGEN-BOLD-30 / SPEC-AMEND Security #5 /
RQ-DEVINROUTEDEFAULTQ7).

Every case builds a synthetic ~/.ashlr-runs/queue in a temp HOME and invokes
restock.py as a subprocess; nothing touches the real ~/.ashlr-runs or the live
router queue. Covers: the >=30% bet=bold READY floor and preference, non-fleet
repo exclusion (GS_REPOS), hold-list PR exclusion, HOLD-SECURITY parking with the
[Security pin required] tag, and the DEVIN-LEVERAGE-20261026 defaults: open-pool
tier=frontier and long-horizon lines route to pool=devin, the devin target
defaults to 10, and its restock need is clamped at the ceiling 16.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'restock.py'
LANES = ['codex-cmp', 'codex-personal', 'devin', 'codex-local', 'claude-api']


def build(md, repos=('phantom',), running=0, queued=0, slots=None, lanes_status=None):
    tmp = tempfile.TemporaryDirectory()
    home = Path(tmp.name)
    q = home / '.ashlr-runs' / 'queue'
    (q / 'prompts').mkdir(parents=True)
    (q / 'run').mkdir()
    (home / '.ashlr-runs' / 'metrics').mkdir()
    (home / '.ashlr-runs' / 'metrics' / 'jobs.jsonl').write_text('')
    for r in repos:
        (home / 'Projects' / 'ashlrai' / r).mkdir(parents=True)
    (q / 'router-queue.md').write_text(md)
    (q / 'status.json').write_text(json.dumps(
        {'lanes': lanes_status if lanes_status is not None else {'devin': {'running': running, 'queued': queued}}}))
    if slots is None:
        slots = {l: {'held': True} for l in LANES}
        slots['claude-api'] = {'target': 0}
        slots['devin'] = {'target': 6}
    (q / 'slots.json').write_text(json.dumps(slots))
    (q / 'claimed.tsv').write_text('')
    (q / 'ready.tsv').write_text('')
    return tmp


def restock(home, *args):
    env = {'HOME': str(home), 'PATH': os.environ.get('PATH', '/usr/bin:/bin')}
    return subprocess.run([sys.executable, '-B', str(SCRIPT), *args],
                          env=env, capture_output=True, text=True, timeout=60)


def summary(out):
    m = re.search(r'bold ready=(\d+)/(\d+)\(([\d.]+)\) picked=(\d+)/(\d+)\(([\d.]+)\)', out)
    assert m, f'no bold summary in output: {out}'
    return {'ready_bold': int(m.group(1)), 'ready_n': int(m.group(2)),
            'ready_frac': float(m.group(3)), 'pick_bold': int(m.group(4)),
            'pick_n': int(m.group(5)), 'pick_frac': float(m.group(6))}


def skips(out):
    m = re.search(r'skips (\{.*\})', out)
    return json.loads(m.group(1)) if m else {}


def dry_ids(out):
    return re.findall(r'^DRY (?!HOLD-SECURITY\t)(\S+)', out, re.M)


def dry_lanes(out):
    """DRY pick lines 'DRY <job>\t<repo>\t<lane>\t<tier>' -> {job: (lane, tier)}."""
    return {m.group(1): (m.group(2), m.group(3))
            for m in re.finditer(r'^DRY (\S+)\t\S+\t(\S+)\t(\S+)$', out, re.M)}


def need_of(out):
    m = re.search(r'^need (\{.*?\})', out, re.M)
    return json.loads(m.group(1)) if m else {}


def sec_ids(out):
    return re.findall(r'HOLD-SECURITY\t(\S+)', out)


def line(job, text='routine fix', **attrs):
    p = attrs.pop('P', None)
    toks = ([f'P{p}'] if p is not None else []) + [f'{k}={v}' for k, v in attrs.items()]
    return f'- READY {job} ({", ".join(toks)}): {text}'


class BoldFloorTests(unittest.TestCase):
    def test_under_floor_prefers_bold_and_reports_share(self):
        # 2 of 8 READY lines are bet=bold (25% < 30% floor): preference lifts the
        # picked share to >=30% even though both bolds sit at P3 behind P1 safes.
        rows = ['# fixture queue', '']
        rows += [line(f'RQ-T1-SAFE-{k}', P=1, pool='devin', tier='mid', repo='phantom',
                      text=f'routine safe fix {k}') for k in range(1, 7)]
        rows += [line(f'RQ-T1-BOLD-{k}', P=3, pool='devin', tier='mid', repo='phantom',
                      bet='bold', text=f'risky bold bet {k}') for k in (1, 2)]
        tmp = build('\n'.join(rows) + '\n')
        self.addCleanup(tmp.cleanup)
        r = restock(Path(tmp.name), '--dry-run', '--per-lane', '4')
        self.assertEqual(r.returncode, 0, r.stderr)
        s = summary(r.stdout)
        self.assertEqual((s['ready_bold'], s['ready_n']), (2, 8))
        self.assertAlmostEqual(s['ready_frac'], 0.25)
        self.assertIn('prefer=bold', r.stdout)
        self.assertGreaterEqual(s['pick_frac'], 0.30, r.stdout)
        picks = dry_ids(r.stdout)
        self.assertIn('RQ-T1-BOLD-1', picks)
        self.assertIn('RQ-T1-BOLD-2', picks)

    def test_at_floor_no_preference(self):
        # 4 of 9 READY lines bold (~44% >= 30%): normal priority order, no prefer flag.
        rows = [line(f'RQ-T2-BOLD-{k}', P=3, pool='devin', tier='mid', repo='phantom',
                     bet='bold', text=f'bold bet {k}') for k in range(1, 5)]
        rows += [line(f'RQ-T2-SAFE-{k}', P=1, pool='devin', tier='mid', repo='phantom',
                      text=f'routine fix {k}') for k in range(1, 6)]
        tmp = build('\n'.join(rows) + '\n')
        self.addCleanup(tmp.cleanup)
        r = restock(Path(tmp.name), '--dry-run', '--per-lane', '5')
        self.assertEqual(r.returncode, 0, r.stderr)
        s = summary(r.stdout)
        self.assertEqual((s['ready_bold'], s['ready_n']), (4, 9))
        self.assertNotIn('prefer=bold', r.stdout)
        self.assertGreaterEqual(s['ready_frac'], 0.30)

    def test_under_floor_no_bold_candidates(self):
        rows = [line(f'RQ-T3-SAFE-{k}', P=1, pool='devin', tier='mid', repo='phantom',
                     text=f'routine fix {k}') for k in range(1, 4)]
        tmp = build('\n'.join(rows) + '\n')
        self.addCleanup(tmp.cleanup)
        r = restock(Path(tmp.name), '--dry-run', '--per-lane', '2')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('prefer=bold', r.stdout)
        self.assertEqual(summary(r.stdout)['pick_frac'], 0.0)


class ExclusionTests(unittest.TestCase):
    def test_non_fleet_repos_never_selected(self):
        # measurably and ashlar-landing exist as local dirs but sit outside GS_REPOS.
        rows = [
            line('RQ-NF-MEAS', P=1, pool='devin', tier='mid', repo='measurably', text='measurably fix'),
            line('RQ-NF-LAND', P=1, pool='devin', tier='mid', repo='ashlar-landing', text='landing fix'),
            line('RQ-NF-GHOST', P=1, pool='devin', tier='mid', repo='ghost-repo', text='missing dir'),
            line('RQ-NF-NONE', P=1, pool='devin', tier='mid', text='no repo attr'),
            line('RQ-NF-FLEET', P=2, pool='devin', tier='mid', repo='phantom', text='fleet fix'),
        ]
        tmp = build('\n'.join(rows) + '\n', repos=('phantom', 'measurably', 'ashlar-landing'))
        self.addCleanup(tmp.cleanup)
        r = restock(Path(tmp.name), '--dry-run', '--per-lane', '4')
        self.assertEqual(r.returncode, 0, r.stderr)
        sk = skips(r.stdout)
        self.assertEqual(sk.get('non-fleet-repo'), 3, r.stdout)
        self.assertEqual(sk.get('no-repo'), 1, r.stdout)
        self.assertEqual(dry_ids(r.stdout), ['RQ-NF-FLEET'])

    def test_hold_list_pr_never_selected(self):
        rows = [
            '- HOLD RQ-OLD (pool=devin, tier=mid, repo=phantom): PR=https://github.com/ashlrai/phantom/pull/124 reason=owner hold',
            line('RQ-HELD-PR', P=1, pool='devin', tier='work', repo='phantom',
                 text='LAND PR=https://github.com/ashlrai/phantom/pull/124'),
            line('RQ-FREE-PR', P=2, pool='devin', tier='work', repo='phantom',
                 text='LAND PR=https://github.com/ashlrai/phantom/pull/125'),
        ]
        tmp = build('\n'.join(rows) + '\n')
        self.addCleanup(tmp.cleanup)
        r = restock(Path(tmp.name), '--dry-run', '--per-lane', '4')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(skips(r.stdout).get('hold-list-pr'), 1, r.stdout)
        self.assertEqual(dry_ids(r.stdout), ['RQ-FREE-PR'])

    def test_security_pinned_line_never_selected(self):
        rows = [
            line('RQ-SEC-DISP', P=1, pool='devin', tier='mid', repo='phantom',
                 bet='bold', text='update dispatchd pacing'),   # bold: must not be promoted
            line('RQ-OK-1', P=3, pool='devin', tier='mid', repo='phantom', text='routine fix'),
        ]
        tmp = build('\n'.join(rows) + '\n')
        self.addCleanup(tmp.cleanup)
        r = restock(Path(tmp.name), '--dry-run', '--per-lane', '4')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('RQ-SEC-DISP', sec_ids(r.stdout))
        self.assertNotIn('RQ-SEC-DISP', dry_ids(r.stdout))
        self.assertEqual(dry_ids(r.stdout), ['RQ-OK-1'])
        self.assertEqual(summary(r.stdout)['pick_frac'], 0.0)   # bold parked, not promoted


class SecurityTagTests(unittest.TestCase):
    def test_all_pinned_surfaces_tagged(self):
        surfaces = [
            ('RQ-SEC-GH', 'update .github/workflows CI yaml'),
            ('RQ-SEC-PUB', 'patch publish.sh flags'),
            ('RQ-SEC-DISP', 'retune dispatchd loop'),
            ('RQ-SEC-GSAFE', 'harden git-safe env checks'),
            ('RQ-SEC-SCRUB', 'scrub runlogs harder'),
            ('RQ-SEC-REAP', 'reap stale worktrees sooner'),
        ]
        rows = [line(j, P=1, pool='devin', tier='mid', repo='phantom', text=t) for j, t in surfaces]
        rows.append(line('RQ-PLAIN', P=3, pool='devin', tier='mid', repo='phantom', text='plain fix'))
        tmp = build('\n'.join(rows) + '\n')
        self.addCleanup(tmp.cleanup)
        r = restock(Path(tmp.name), '--dry-run', '--per-lane', '8')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(sorted(sec_ids(r.stdout)), sorted(j for j, _ in surfaces))
        self.assertEqual(skips(r.stdout).get('hold-security'), len(surfaces))
        self.assertEqual(dry_ids(r.stdout), ['RQ-PLAIN'])

    def test_negated_github_mention_stays_eligible(self):
        rows = [
            line('RQ-NEG', P=1, pool='devin', tier='mid', repo='phantom',
                 text='never touch .github; fix the docs typo only'),
            line('RQ-POS', P=1, pool='devin', tier='mid', repo='phantom',
                 text='edit .github/workflows/build.yml directly'),
        ]
        tmp = build('\n'.join(rows) + '\n')
        self.addCleanup(tmp.cleanup)
        r = restock(Path(tmp.name), '--dry-run', '--per-lane', '4')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(sec_ids(r.stdout), ['RQ-POS'])
        self.assertEqual(dry_ids(r.stdout), ['RQ-NEG'])


class RewriteTests(unittest.TestCase):
    def test_apply_run_claims_parks_and_preserves(self):
        rows = [
            '# header comment',
            '',
            line('RQ-SEC-1', P=1, pool='devin', tier='mid', repo='phantom',
                 text='touch dispatchd internals'),
            line('RQ-PICK-1', P=2, pool='devin', tier='mid', repo='phantom', bet='bold',
                 text='bold pick'),
            'Freeform operator note survives.',
        ]
        tmp = build('\n'.join(rows) + '\n')
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        r = restock(home, '--per-lane', '4')
        self.assertEqual(r.returncode, 0, r.stderr)
        md = (home / '.ashlr-runs' / 'queue' / 'router-queue.md').read_text()
        self.assertIn('- HOLD-SECURITY ', md)
        sec_row = [l for l in md.splitlines() if 'RQ-SEC-1' in l][0]
        self.assertTrue(sec_row.startswith('- HOLD-SECURITY '), sec_row)
        self.assertTrue(sec_row.rstrip().endswith('[Security pin required]'), sec_row)
        pick_row = [l for l in md.splitlines() if 'RQ-PICK-1' in l][0]
        self.assertTrue(pick_row.startswith('- CLAIMED '), pick_row)
        self.assertIn('# header comment', md)
        self.assertIn('Freeform operator note survives.', md)
        ready = (home / '.ashlr-runs' / 'queue' / 'ready.tsv').read_text()
        claimed = (home / '.ashlr-runs' / 'queue' / 'claimed.tsv').read_text()
        self.assertIn('RQ-PICK-1', ready)
        self.assertIn('RQ-PICK-1', claimed)
        self.assertNotIn('RQ-SEC-1', ready)
        self.assertTrue((home / '.ashlr-runs' / 'queue' / 'prompts' / 'RQ-PICK-1.md').exists())

    def test_dry_run_writes_nothing(self):
        rows = [line('RQ-SEC-1', P=1, pool='devin', tier='mid', repo='phantom',
                     text='touch dispatchd internals'),
                line('RQ-PICK-1', P=2, pool='devin', tier='mid', repo='phantom', text='fix')]
        md = '\n'.join(rows) + '\n'
        tmp = build(md)
        self.addCleanup(tmp.cleanup)
        r = restock(Path(tmp.name), '--dry-run', '--per-lane', '4')
        self.assertEqual(r.returncode, 0, r.stderr)
        home = Path(tmp.name)
        self.assertEqual((home / '.ashlr-runs' / 'queue' / 'router-queue.md').read_text(), md)
        self.assertEqual((home / '.ashlr-runs' / 'queue' / 'ready.tsv').read_text(), '')
        self.assertEqual((home / '.ashlr-runs' / 'queue' / 'claimed.tsv').read_text(), '')


class DevinDefaultTests(unittest.TestCase):
    """RQ-DEVINROUTEDEFAULTQ7 / DEVIN-LEVERAGE-20261026: a line that leaves its
    pool open (pool=any or no pool= attr) and is tier=frontier or carries a
    long-horizon marker routes to devin by default. devin's restock need reads
    the slots target (default 10) clamped at the ceiling 16.
    """

    def open_slots(self, **over):
        # codex lanes sit above devin's need so a default pick is never
        # confused with the neediest-GENERAL fallback.
        s = {'codex-cmp': {'target': 10}, 'codex-personal': {'target': 10},
             'devin': {'target': 4}, 'claude-api': {'target': 0}, 'codex-local': {'held': True}}
        s.update(over)
        return s

    def pick(self, rows, *args, slots=None):
        tmp = build('\n'.join(rows) + '\n', slots=slots if slots is not None else self.open_slots())
        self.addCleanup(tmp.cleanup)
        r = restock(Path(tmp.name), '--dry-run', *args)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout

    def test_frontier_open_pool_defaults_to_devin(self):
        out = self.pick([
            line('RQ-D-F1', P=1, pool='any', tier='frontier', repo='phantom', text='frontier probe'),
            line('RQ-D-W1', P=1, pool='any', tier='work', repo='phantom', text='routine fix'),
        ])
        lanes = dry_lanes(out)
        self.assertEqual(lanes['RQ-D-F1'], ('devin', 'frontier'))
        self.assertEqual(lanes['RQ-D-W1'], ('codex-cmp', 'work'))   # work still goes neediest GENERAL
        self.assertEqual(need_of(out)['devin'], 12)               # fixture: devin is not the neediest

    def test_frontier_without_pool_attr_defaults_to_devin(self):
        out = self.pick([
            line('RQ-D-F2', P=1, tier='frontier', repo='phantom', text='frontier probe'),
        ])
        self.assertEqual(dry_lanes(out)['RQ-D-F2'], ('devin', 'frontier'))

    def test_long_horizon_markers_default_to_devin(self):
        out = self.pick([
            line('RQ-D-LH1', P=1, pool='any', tier='work', repo='phantom', horizon='long', text='long sweep'),
            '- READY RQ-D-LH2 (P1, pool=any, tier=work, repo=phantom, long-horizon): long sweep',
            line('RQ-D-SH', P=1, pool='any', tier='work', repo='phantom', horizon='short', text='short fix'),
        ])
        lanes = dry_lanes(out)
        self.assertEqual(lanes['RQ-D-LH1'], ('devin', 'work'))
        self.assertEqual(lanes['RQ-D-LH2'], ('devin', 'work'))
        self.assertEqual(lanes['RQ-D-SH'], ('codex-cmp', 'work'))   # not long-horizon: no default

    def test_explicit_pool_beats_the_default(self):
        out = self.pick([
            line('RQ-D-X1', P=1, pool='codex-personal', tier='frontier', repo='phantom', text='frontier probe'),
        ])
        self.assertEqual(dry_lanes(out)['RQ-D-X1'], ('codex-personal', 'frontier'))

    def test_held_devin_falls_back_to_neediest_general(self):
        out = self.pick([
            line('RQ-D-H1', P=1, pool='any', tier='frontier', repo='phantom', text='frontier probe'),
        ], slots=self.open_slots(devin={'target': 4, 'held': True}))
        self.assertEqual(dry_lanes(out)['RQ-D-H1'], ('codex-cmp', 'frontier'))

    def test_devin_need_exhausted_falls_back(self):
        # per-lane 1 fills devin with the first frontier line; the next open-pool
        # frontier line overflows to the neediest GENERAL lane.
        out = self.pick([
            line('RQ-D-O1', P=1, pool='any', tier='frontier', repo='phantom', text='frontier one'),
            line('RQ-D-O2', P=2, pool='any', tier='frontier', repo='phantom', text='frontier two'),
            line('RQ-D-O3', P=3, pool='any', tier='work', repo='phantom', text='work three'),
        ], '--per-lane', '1')
        lanes = dry_lanes(out)
        self.assertEqual(lanes['RQ-D-O1'], ('devin', 'frontier'))
        self.assertEqual(lanes['RQ-D-O2'], ('codex-cmp', 'frontier'))
        self.assertEqual(lanes['RQ-D-O3'], ('codex-personal', 'work'))   # one slot left on the next GENERAL lane

    def test_devin_need_clamped_at_ceiling_16(self):
        # slots target 30 would ask for 3*30=90 slots; the leverage ceiling 16
        # clamps restock need to 3*16=48 so devin is never overbooked.
        out = self.pick([
            line('RQ-D-C1', P=1, pool='devin', tier='work', repo='phantom', text='routine fix'),
        ], slots=self.open_slots(devin={'target': 30}))
        self.assertEqual(need_of(out)['devin'], 48)

    def test_missing_devin_slot_uses_target_10(self):
        # No devin row in slots.json: the leverage default target 10 asks for 30.
        slots = self.open_slots()
        del slots['devin']
        out = self.pick([
            line('RQ-D-T1', P=1, pool='devin', tier='work', repo='phantom', text='routine fix'),
        ], slots=slots)
        self.assertEqual(need_of(out)['devin'], 30)


class AutoUnparkTests(unittest.TestCase):
    """RQ-QUEUE-AUTOUNPARK-1: PARKED-DEP rows unpark when DEPENDENCY GATE ids are MERGED."""

    def seed_parked(self, home, job, deps, lane='devin', pin_text=False, merged=()):
        q = home / '.ashlr-runs' / 'queue'
        pf = q / 'prompts' / f'{job}.md'
        body = (f'DEPENDENCY GATE: {", ".join(deps)}\n\n{job}: wait for deps\n')
        if pin_text:
            body += 'no merge without Security pin\n'
        pf.write_text(body)
        row = '\t'.join([f'PARKED-DEP.{lane}', job, lane, 'work', 'phantom', str(pf)])
        (q / 'ready.tsv').write_text(row + '\n')
        (home / '.ashlr-runs' / 'metrics' / 'jobs.jsonl').write_text(''.join(
            json.dumps({'event': 'outcome', 'state': 'MERGED', 'job': d}) + '\n' for d in merged))
        return pf

    def test_unparks_when_every_gate_id_is_merged(self):
        tmp = build(line('RQ-OK', P=3, pool='devin', repo='phantom', text='filler') + '\n',
                    slots={**{l: {'held': True} for l in LANES}, 'devin': {'target': 0}, 'claude-api': {'target': 0}})
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        # Hold every lane so restock does not claim the filler; only the unpark path runs.
        pf = self.seed_parked(home, 'RQ-WAIT', ['RQ-DEP-A', 'RQ-DEP-B'],
                              merged=('RQ-DEP-A', 'RQ-DEP-B'))
        before = pf.read_text()
        r = restock(home, '--per-lane', '0', '--json')
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        self.assertEqual(out['unpark'], [{'job': 'RQ-WAIT', 'deps': ['RQ-DEP-A', 'RQ-DEP-B']}])
        ready = (home / '.ashlr-runs' / 'queue' / 'ready.tsv').read_text()
        self.assertIn('RQ-WAIT\tphantom\tdevin\twork\t', ready)
        self.assertNotIn('PARKED-DEP.', ready)
        self.assertEqual(pf.read_text(), before)  # prompt (incl. pin prose) untouched
        ev = (home / '.ashlr-runs' / 'dispatch-events.log').read_text()
        self.assertIn('UNPARK RQ-WAIT deps=RQ-DEP-A,RQ-DEP-B', ev)

    def test_keeps_parked_when_a_gate_id_is_unmerged(self):
        tmp = build('# empty\n', slots={**{l: {'held': True} for l in LANES}, 'claude-api': {'target': 0}})
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        row = self.seed_parked(home, 'RQ-WAIT', ['RQ-DEP-A', 'RQ-DEP-B'], merged=('RQ-DEP-A',))
        ready_before = (home / '.ashlr-runs' / 'queue' / 'ready.tsv').read_text()
        r = restock(home, '--per-lane', '0', '--json')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)['unpark'], [])
        self.assertEqual((home / '.ashlr-runs' / 'queue' / 'ready.tsv').read_text(), ready_before)
        self.assertTrue(row.exists())

    def test_preserves_no_merge_without_security_pin(self):
        tmp = build('# empty\n', slots={**{l: {'held': True} for l in LANES}, 'claude-api': {'target': 0}})
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        pf = self.seed_parked(home, 'RQ-PIN', ['RQ-DEP-A'], merged=('RQ-DEP-A',), pin_text=True)
        restock(home, '--per-lane', '0')
        self.assertIn('no merge without Security pin', pf.read_text())
        self.assertNotIn('PARKED-DEP.', (home / '.ashlr-runs' / 'queue' / 'ready.tsv').read_text())

    def test_dry_run_does_not_unpark(self):
        tmp = build('# empty\n', slots={**{l: {'held': True} for l in LANES}, 'claude-api': {'target': 0}})
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        self.seed_parked(home, 'RQ-WAIT', ['RQ-DEP-A'], merged=('RQ-DEP-A',))
        before = (home / '.ashlr-runs' / 'queue' / 'ready.tsv').read_text()
        r = restock(home, '--dry-run', '--per-lane', '0', '--json')
        self.assertEqual(json.loads(r.stdout)['unpark'][0]['job'], 'RQ-WAIT')
        self.assertEqual((home / '.ashlr-runs' / 'queue' / 'ready.tsv').read_text(), before)

    def test_after_unlanded_parks_with_dependency_gate(self):
        rows = [line('RQ-NEED', P=1, pool='devin', tier='work', repo='phantom',
                     text='after RQ-UPSTREAM: do the follow-up')]
        # Put after= in attrs the way router lines do.
        rows = ['- READY RQ-NEED (P1, pool=devin, tier=work, repo=phantom, after RQ-UPSTREAM): do the follow-up']
        tmp = build('\n'.join(rows) + '\n')
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        r = restock(home, '--per-lane', '4', '--json')
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        self.assertEqual(out['parked_dep'], [{'job': 'RQ-NEED', 'deps': ['RQ-UPSTREAM']}])
        ready = (home / '.ashlr-runs' / 'queue' / 'ready.tsv').read_text()
        self.assertIn('PARKED-DEP.devin\tRQ-NEED\t', ready)
        prompt = (home / '.ashlr-runs' / 'queue' / 'prompts' / 'RQ-NEED.md').read_text()
        self.assertIn('DEPENDENCY GATE: RQ-UPSTREAM', prompt)
        md = (home / '.ashlr-runs' / 'queue' / 'router-queue.md').read_text()
        self.assertIn('CLAIMED', md)
        self.assertIn('RQ-NEED', md)


class NoopCutTests(unittest.TestCase):
    """RQ-PSEL-4-NOOPCUT: PR/file dedupe and the 2-NOOPs-in-24h park."""

    def make(self, rows, precheck_code=None):
        tmp = build('\n'.join(rows) + '\n', slots={
            **{l: {'held': True} for l in LANES}, 'devin': {'target': 6}, 'claude-api': {'target': 0}})
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        if precheck_code is not None:
            b = home / '.ashlr-runs' / 'bin'
            b.mkdir(parents=True)
            (b / 'precheck.sh').write_text(
                f'id=${{1%% *}}\necho "SKIP $id code={precheck_code} reason=id_merged_pr_7"\nexit {precheck_code}\n')
        return home

    def set_md(self, home, rows):
        (home / '.ashlr-runs' / 'queue' / 'router-queue.md').write_text('\n'.join(rows) + '\n')

    def state(self, home):
        return json.loads((home / '.ashlr-runs' / 'queue' / 'noop-streak.json').read_text())

    def test_same_pr_and_same_file_collapse_to_one_pick(self):
        home = self.make([
            line('RQ-A', P=1, pool='devin', repo='phantom', text='FIXUP phantom#7 file=src/a.ts fix'),
            line('RQ-B', P=1, pool='devin', repo='phantom', text='REBASE phantom#7 file=src/b.ts fix'),
            line('RQ-C', P=1, pool='devin', repo='phantom', text='FIXUP phantom#8 file=src/a.ts fix'),
            line('RQ-D', P=1, pool='devin', repo='phantom', text='FIXUP phantom#9 file=src/d.ts fix'),
        ])
        r = restock(home, '--dry-run')
        self.assertEqual(sorted(dry_ids(r.stdout)), ['RQ-A', 'RQ-D'], r.stdout)
        self.assertEqual(skips(r.stdout).get('dup-pr'), 1)
        self.assertEqual(skips(r.stdout).get('dup-file'), 1)

    def test_two_noops_park_the_line_for_24h(self):
        row = line('RQ-N', P=1, pool='devin', repo='phantom', text='stale work')
        home = self.make([row], precheck_code=10)
        for n in (1, 2):
            self.set_md(home, [row])
            r = restock(home, '--per-lane', '4')
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(self.state(home)['RQ-N']['n'], n)
        self.set_md(home, [row])   # third appearance: parked before any precheck runs
        r = restock(home, '--per-lane', '4', '--json')
        out = json.loads(r.stdout)
        self.assertEqual(out['done_noop'], [])
        self.assertEqual(out['skips'], {'noop-streak': 1})
        self.assertEqual(self.state(home)['RQ-N']['n'], 2)
        # the window expires: aged state no longer parks the line
        st = self.state(home)
        st['RQ-N']['at'] -= 24 * 3600 + 5
        (home / '.ashlr-runs' / 'queue' / 'noop-streak.json').write_text(json.dumps(st))
        r = restock(home, '--per-lane', '4', '--json')
        self.assertEqual(json.loads(r.stdout)['done_noop'], ['RQ-N'])

    def test_single_noop_does_not_park_and_a_real_run_clears(self):
        row = line('RQ-N', P=1, pool='devin', repo='phantom', text='stale work')
        home = self.make([row], precheck_code=10)
        restock(home, '--per-lane', '4')
        self.assertEqual(self.state(home)['RQ-N']['n'], 1)
        (home / '.ashlr-runs' / 'bin' / 'precheck.sh').write_text('exit 0\n')   # real work now
        self.set_md(home, [row])
        r = restock(home, '--per-lane', '4', '--json')
        self.assertEqual(json.loads(r.stdout)['queued'], 1, r.stdout)
        self.assertNotIn('RQ-N', self.state(home))

    def test_dry_run_leaves_streak_state_alone(self):
        home = self.make([line('RQ-N', P=1, pool='devin', repo='phantom')], precheck_code=10)
        restock(home, '--dry-run', '--per-lane', '4')
        self.assertFalse((home / '.ashlr-runs' / 'queue' / 'noop-streak.json').exists())

    def test_corrupt_state_fails_open(self):
        home = self.make([line('RQ-N', P=1, pool='devin', repo='phantom')])
        (home / '.ashlr-runs' / 'queue' / 'noop-streak.json').write_text('{not json')
        r = restock(home, '--dry-run', '--per-lane', '4')
        self.assertEqual(dry_ids(r.stdout), ['RQ-N'], r.stdout + r.stderr)


class PrecheckAuthoringTests(unittest.TestCase):
    make = NoopCutTests.make
    set_md = NoopCutTests.set_md
    state = NoopCutTests.state
    def test_repeated_skips_fall_and_each_actionable_job_is_generated(self):
        stale = line('RQ-SATISFIED', P=0, pool='devin', repo='phantom', text='file=src/a.ts old task')
        blocked = line('RQ-UNCERTAIN', P=1, pool='devin', repo='phantom', text='file=src/a.ts fix existing code')
        home = self.make([stale, blocked])
        q = home / '.ashlr-runs/queue'
        binary = home / '.ashlr-runs/bin'
        binary.mkdir()
        check = binary / 'precheck.sh'
        check.write_text('echo "$1" >> "$HOME/checks"\ncase "$1" in RQ-UNCERTAIN*) exit 13;; esac\n')
        (home / '.ashlr-runs/metrics/jobs.jsonl').write_text(
            json.dumps({'event': 'outcome', 'state': 'MERGED', 'job': 'RQ-SATISFIED', 'repo': 'ashlrai/phantom'}) + '\n')
        for n in range(3):
            job = f'RQ-ACTION-{n}'
            self.set_md(home, [stale, blocked, line(job, P=2, pool='devin', repo='phantom',
                                                  text='file=src/a.ts repair behavior')])
            result = restock(home, '--per-lane', '1', '--json')
            self.assertEqual(result.returncode, 0, result.stderr)
            out = json.loads(result.stdout)
            self.assertEqual(out['queued'], 1, out)
            self.assertEqual(out['done_noop'], [])
            self.assertEqual(out['skips'], {'already-merged': 1, 'precheck-parked': 1})
            self.assertIn(f'{job}\tphantom\tdevin\t', (q / 'ready.tsv').read_text())
            self.assertTrue((q / f'prompts/{job}.md').exists())
            self.assertIn(blocked, (q / 'router-queue.md').read_text())
        checks = (home / 'checks').read_text()
        self.assertEqual(checks.count('RQ-UNCERTAIN'), 1)  # One precheck across three fresh processes
        self.assertNotIn('RQ-SATISFIED', checks)
        self.assertEqual(checks.count('RQ-ACTION-'), 3)
        # Due retries retain work, then recover when the precondition clears.
        state_path = q / 'restock-precheck-parked.json'
        state = json.loads(state_path.read_text())
        state['RQ-UNCERTAIN']['retry_at'] = 0
        state_path.write_text(json.dumps(state))
        restock(home, '--per-lane', '1', '--json')
        self.assertEqual(json.loads(state_path.read_text())['RQ-UNCERTAIN']['count'], 2)
        check.write_text('exit 0\n')
        self.set_md(home, [blocked.replace('fix existing code', 'fix revised behavior')])
        result = restock(home, '--per-lane', '1', '--json')
        self.assertEqual(json.loads(result.stdout)['queued'], 1, result.stdout)
        self.assertNotIn('RQ-UNCERTAIN', json.loads(state_path.read_text()))

    def test_only_exact_merged_evidence_suppresses_work(self):
        jobs = ['RQ-MATCH', 'RQ-MATCH-FOLLOWUP', 'RQ-OTHER', 'RQ-OPEN', 'RQ-UNKNOWN']
        home = self.make([line(j, pool='devin', repo='phantom') for j in jobs])
        records = [None, [], {'event': 'outcome', 'state': 'MERGED', 'job': 'RQ-MATCH'},
                   {'event': 'outcome', 'state': 'MERGED', 'job': 'RQ-OTHER', 'repo': 'locus'},
                   {'event': 'outcome', 'state': 'PR_OPEN', 'job': 'RQ-OPEN'},
                   {'event': 'outcome', 'state': 'MERGED', 'job': 'RQ-UNKNOWN', 'repo': ''}]
        (home / '.ashlr-runs/metrics/jobs.jsonl').write_text(
            '{malformed\n' + '\n'.join(json.dumps(r) for r in records))
        result = restock(home, '--dry-run', '--json')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['queued'], 4)
        self.assertEqual(json.loads(result.stdout)['skips'], {'already-merged': 1})
        self.assertFalse((home / '.ashlr-runs/queue/restock-precheck-parked.json').exists())

    def test_changed_task_resets_noop_suppression(self):
        row = line('RQ-N', pool='devin', repo='phantom', text='original task')
        home = self.make([row], precheck_code=10)
        for _ in range(2):
            self.set_md(home, [row])
            restock(home, '--per-lane', '1')
        (home / '.ashlr-runs/bin/precheck.sh').write_text('exit 0\n')
        self.set_md(home, [row.replace('original task', 'fix existing implementation')])
        result = restock(home, '--per-lane', '1', '--json')
        self.assertEqual(json.loads(result.stdout)['queued'], 1, result.stdout)
        self.assertNotIn('RQ-N', self.state(home))

    def test_precheck_budget_defers_then_reaches_actionable_tail(self):
        rows = [line(f'RQ-WAIT-{n}', pool='devin', repo='phantom') for n in range(21)]
        rows.append(line('RQ-ACTION', pool='devin', repo='phantom'))
        home = self.make(rows, precheck_code=13)
        (home / '.ashlr-runs/bin/precheck.sh').write_text(
            'echo "$1" >> "$HOME/checks"\ncase "$1" in RQ-WAIT-*) exit 13;; esac\n')
        q = home / '.ashlr-runs/queue'
        for expected in (0, 1):
            result = restock(home, '--per-lane', '1', '--json')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)['queued'], expected)
            self.assertEqual((q / 'router-queue.md').read_text().count('- READY RQ-WAIT-'), 21)
        self.assertEqual(len((home / 'checks').read_text().splitlines()), 22)
        self.assertIn('RQ-ACTION\tphantom\tdevin\t', (q / 'ready.tsv').read_text())


if __name__ == '__main__':
    unittest.main()
