"""Fixture tests for contrib/mac/restock.py (RQ-QUEUEGEN-BOLD-30 / SPEC-AMEND Security #5 / RQ-RESTOCKPOOLRULEQ7).

Every case builds a synthetic ~/.ashlr-runs/queue in a temp HOME and invokes
restock.py as a subprocess; nothing touches the real ~/.ashlr-runs or the live
router queue. Covers: the >=30% bet=bold READY floor and preference, non-fleet
repo exclusion (GS_REPOS), hold-list PR exclusion, HOLD-SECURITY parking
with the [Security pin required] tag, the codex-local per-pool line
eligibility rules (pool-ineligible:<rule> rejections), and the esc=
escalation clause versus real `after <dep>` dependencies.
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


def build(md, repos=('phantom',), running=0, queued=0, slots=None):
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
        {'lanes': {'devin': {'running': running, 'queued': queued}}}))
    slotcfg = {l: {'held': True} for l in LANES}
    slotcfg['claude-api'] = {'target': 0}
    slotcfg['devin'] = {'target': 6}
    slotcfg.update(slots or {})
    (q / 'slots.json').write_text(json.dumps(slotcfg))
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


def sec_ids(out):
    return re.findall(r'HOLD-SECURITY\t(\S+)', out)


def dry_rows(out):
    return [r.split('\t') for r in re.findall(r'^DRY (\S[^\n]*)$', out, re.M)
            if not r.startswith(('HOLD-SECURITY', 'REJECT'))]


def reject_ids(out):
    return [r.split('\t') for r in re.findall(r'^(?:DRY )?REJECT\t(\S[^\n]*)$', out, re.M)]


def line(job, text='routine fix', **attrs):
    p = attrs.pop('P', None)
    toks = ([f'P{p}'] if p is not None else []) + [f'{k}={v}' for k, v in attrs.items()]
    return f'- READY {job} ({", ".join(toks)}): {text}'


def cline(job, size=None, text='routine local fix', **attrs):
    toks = ['P2', 'pool=codex-local', 'tier=work', 'repo=phantom']
    if size is not None:
        toks.append(f'size<={size}')
    toks += [f'{k}={v}' for k, v in attrs.items()]
    return f'- READY {job} ({", ".join(toks)}): {text}'


def arow(job, *extra):
    toks = ['P1', 'pool=devin', 'tier=work', 'repo=phantom', *extra]
    return f'- READY {job} ({", ".join(toks)}): dep test line'


LOCAL = {'codex-local': {'target': 4}}


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


class LocalPoolTests(unittest.TestCase):
    def test_local_accepts_eligible_kinds(self):
        # FIXUP, DAILYFIX, DRAIN, -R2 and REBASE lines all land on codex-local.
        rows = [
            cline('RQ-FIXUP-1', 120, text='typo fixup'),
            cline('RQ-DAILYFIX-1', 100, text='daily fix'),
            cline('RQ-DRAIN-1', 380, text='drain phantom PRs'),
            cline('RQ-GRAPH-1-R2', 350, text='recut round two'),
            cline('RQ-REBASE-1', 140, text='rebase stale PR'),
        ]
        tmp = build('\n'.join(rows) + '\n', slots=LOCAL)
        self.addCleanup(tmp.cleanup)
        r = restock(Path(tmp.name), '--dry-run', '--per-lane', '8')
        self.assertEqual(r.returncode, 0, r.stderr)
        picked = {row[0]: row[2] for row in dry_rows(r.stdout)}
        for j in ('RQ-FIXUP-1', 'RQ-DAILYFIX-1', 'RQ-DRAIN-1', 'RQ-GRAPH-1-R2', 'RQ-REBASE-1'):
            self.assertEqual(picked.get(j), 'codex-local', r.stdout)
        self.assertNotIn('pool-ineligible', r.stdout)

    def test_local_drain_and_r2_size_400_boundary(self):
        rows = [
            cline('RQ-DRAIN-OK', 400),
            cline('RQ-DRAIN-BIG', 401),
            cline('RQ-GRAPH-8-R2', 400),
            cline('RQ-GRAPH-9-R2', 401),
        ]
        tmp = build('\n'.join(rows) + '\n', slots=LOCAL)
        self.addCleanup(tmp.cleanup)
        r = restock(Path(tmp.name), '--dry-run', '--per-lane', '8')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual({row[0] for row in dry_rows(r.stdout)},
                         {'RQ-DRAIN-OK', 'RQ-GRAPH-8-R2'}, r.stdout)
        self.assertEqual(skips(r.stdout).get('pool-ineligible:size'), 2, r.stdout)
        self.assertEqual({row[0] for row in reject_ids(r.stdout)},
                         {'RQ-DRAIN-BIG', 'RQ-GRAPH-9-R2'}, r.stdout)

    def test_local_non_drain_size_150_boundary(self):
        rows = [
            cline('RQ-FIXUP-OK', 150),
            cline('RQ-FIXUP-BIG', 151),
            cline('RQ-DAILYFIX-BIG', 200),
            cline('RQ-REBASE-BIG', 300),
            line('RQ-FIXUP-EQ', P=2, pool='codex-local', tier='work',
                 repo='phantom', size='150', text='eq spelling'),   # size=150 form
        ]
        tmp = build('\n'.join(rows) + '\n', slots=LOCAL)
        self.addCleanup(tmp.cleanup)
        r = restock(Path(tmp.name), '--dry-run', '--per-lane', '8')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual({row[0] for row in dry_rows(r.stdout)},
                         {'RQ-FIXUP-OK', 'RQ-FIXUP-EQ'}, r.stdout)
        self.assertEqual(skips(r.stdout).get('pool-ineligible:size'), 3, r.stdout)

    def test_local_missing_size_fails_closed(self):
        rows = [cline('RQ-FIXUP-NOSIZE')]
        tmp = build('\n'.join(rows) + '\n', slots=LOCAL)
        self.addCleanup(tmp.cleanup)
        r = restock(Path(tmp.name), '--dry-run', '--per-lane', '4')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(skips(r.stdout).get('pool-ineligible:size'), 1, r.stdout)
        self.assertEqual(dry_rows(r.stdout), [], r.stdout)

    def test_local_ineligible_kind_rejected_and_never_moved(self):
        # a bet=bold feature line and a GEN line routed to codex-local are
        # rejected pool-ineligible:kind, never re-pooled to another lane
        rows = [
            cline('RQ-FEAT-BOLD', 100, bet='bold', text='bold feature build'),
            cline('RQ-GEN-1', 100, text='generated feature'),
            cline('RQ-FIXUP-OK', 100),
        ]
        tmp = build('\n'.join(rows) + '\n', slots=LOCAL)
        self.addCleanup(tmp.cleanup)
        r = restock(Path(tmp.name), '--dry-run', '--per-lane', '8')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(skips(r.stdout).get('pool-ineligible:kind'), 2, r.stdout)
        self.assertEqual({row[0]: row[1] for row in reject_ids(r.stdout)},
                         {'RQ-FEAT-BOLD': 'pool-ineligible:kind',
                          'RQ-GEN-1': 'pool-ineligible:kind'}, r.stdout)
        picked = {row[0]: row[2] for row in dry_rows(r.stdout)}
        self.assertEqual(picked, {'RQ-FIXUP-OK': 'codex-local'}, r.stdout)

    def test_local_rejects_logged_and_line_stays_ready(self):
        rows = [
            cline('RQ-GEN-1', 100, text='generated feature'),
            cline('RQ-DRAIN-BIG', 450),
            cline('RQ-FIXUP-1', 100),
        ]
        tmp = build('\n'.join(rows) + '\n', slots=LOCAL)
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        r = restock(home, '--per-lane', '4')
        self.assertEqual(r.returncode, 0, r.stderr)
        ev = (home / '.ashlr-runs' / 'dispatch-events.log').read_text()
        rej = [l for l in ev.splitlines() if 'RESTOCK-SKIP' in l]
        self.assertEqual(len(rej), 2, ev)
        self.assertTrue(rej[0].endswith('RESTOCK-SKIP RQ-GEN-1 pool-ineligible:kind'), rej)
        self.assertTrue(rej[1].endswith('RESTOCK-SKIP RQ-DRAIN-BIG pool-ineligible:size'), rej)
        for l in rej:   # value-free: no key=value pairs, no line payload
            self.assertNotIn('=', l, l)
        self.assertIn(' RESTOCK queued 1 ', ev)
        md = (home / '.ashlr-runs' / 'queue' / 'router-queue.md').read_text()
        self.assertIn('- READY RQ-GEN-1 ', md)      # rejected, never claimed
        self.assertIn('- READY RQ-DRAIN-BIG ', md)
        self.assertIn('- CLAIMED ', [l for l in md.splitlines() if 'RQ-FIXUP-1' in l][0])
        ready = (home / '.ashlr-runs' / 'queue' / 'ready.tsv').read_text()
        self.assertIn('RQ-FIXUP-1\tphantom\tcodex-local\twork', ready)
        self.assertNotIn('RQ-GEN-1', ready)
        self.assertNotIn('RQ-DRAIN-BIG', ready)

    def test_local_dry_run_writes_no_events(self):
        rows = [cline('RQ-GEN-1', 100)]
        tmp = build('\n'.join(rows) + '\n', slots=LOCAL)
        self.addCleanup(tmp.cleanup)
        r = restock(Path(tmp.name), '--dry-run', '--per-lane', '4')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(skips(r.stdout).get('pool-ineligible:kind'), 1, r.stdout)
        ev = Path(tmp.name) / '.ashlr-runs' / 'dispatch-events.log'
        self.assertFalse(ev.exists(), 'dry-run must not append dispatch-events.log')


class EscalationDepTests(unittest.TestCase):
    def test_esc_after_failed_is_escalation_not_dep(self):
        # 'esc=devin after 3 failed' is one escalation clause; it never fed deps.
        rows = [arow('RQ-ESC-1', 'esc=devin after 3 failed'), arow('RQ-OK-1')]
        tmp = build('\n'.join(rows) + '\n')
        self.addCleanup(tmp.cleanup)
        r = restock(Path(tmp.name), '--dry-run', '--per-lane', '4')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(dry_ids(r.stdout), ['RQ-ESC-1', 'RQ-OK-1'], r.stdout)
        self.assertNotIn('after-unlanded', r.stdout)

    def test_esc_at_window_is_escalation_not_dep(self):
        rows = [arow('RQ-ESC-2', 'esc=codex-cmp at T+30m')]
        tmp = build('\n'.join(rows) + '\n')
        self.addCleanup(tmp.cleanup)
        r = restock(Path(tmp.name), '--dry-run', '--per-lane', '4')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(dry_ids(r.stdout), ['RQ-ESC-2'], r.stdout)

    def test_real_after_unlanded_still_skips(self):
        rows = [arow('RQ-DEP-NEED', 'after RQ-GHOST-9')]
        tmp = build('\n'.join(rows) + '\n')
        self.addCleanup(tmp.cleanup)
        r = restock(Path(tmp.name), '--dry-run', '--per-lane', '4')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(skips(r.stdout).get('after-unlanded'), 1, r.stdout)
        self.assertEqual(dry_ids(r.stdout), [], r.stdout)

    def test_real_after_landed_passes(self):
        rows = [
            '- DONE RQ-GHOST-9 (pool=devin, tier=work, repo=phantom): landed earlier',
            arow('RQ-DEP-OK', 'after RQ-GHOST-9'),
        ]
        tmp = build('\n'.join(rows) + '\n')
        self.addCleanup(tmp.cleanup)
        r = restock(Path(tmp.name), '--dry-run', '--per-lane', '4')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(dry_ids(r.stdout), ['RQ-DEP-OK'], r.stdout)

    def test_esc_clause_does_not_hide_a_real_dep(self):
        # esc stripped, but the real 'after RQ-GHOST-9' dep is still enforced
        rows = [arow('RQ-MIX', 'esc=devin after 3 failed', 'after RQ-GHOST-9')]
        tmp = build('\n'.join(rows) + '\n')
        self.addCleanup(tmp.cleanup)
        r = restock(Path(tmp.name), '--dry-run', '--per-lane', '4')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(skips(r.stdout).get('after-unlanded'), 1, r.stdout)
        self.assertEqual(dry_ids(r.stdout), [], r.stdout)


if __name__ == '__main__':
    unittest.main()
