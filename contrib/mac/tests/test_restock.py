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


if __name__ == '__main__':
    unittest.main()
