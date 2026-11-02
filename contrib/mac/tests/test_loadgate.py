"""Fixture tests for the RQ-LOADGATE-1 admission gate in contrib/mac/dispatchd.py.

Same harness as test_dispatchd.py: each case builds a synthetic ~/.ashlr-runs in a temp HOME and runs one tick of the repo
copy as a subprocess. Load and ncpu are pinned through LOADGATE_LOADAVG / LOADGATE_NCPU (honored only while the
LOADGATE_TEST marker exists), `ps` and `ashlr daemon status --json` are stubs. Covers each gate (loadavg, process count,
process count; worktree count and daemon tick age only warn), the global running cap, the hard_cap clamps, the ramp pause, and the autopilot overrides reload.
"""
import json
import os
from pathlib import Path
import unittest

from test_dispatchd import AP_GREEN, build, devin_slot, events, held_lanes, set_daemon_tick, slots_of, tick


def admission(home):
    return json.loads((home / '.ashlr-runs' / 'queue' / 'admission.json').read_text())


def ready_fixture(n=1, slot=None, top=None, extra=None):
    """devin is the only unheld lane; n ready lines wait. Returns (tmp, home)."""
    slots = held_lanes()
    slots['devin'] = slot or devin_slot(last_change=int(1e15))
    slots.update(top or {})
    tmp = build(slots=slots)
    home = Path(tmp.name).resolve()   # launch re-checks realpath(prompt) under the queue; macOS tmp is a /var symlink
    q = home / '.ashlr-runs' / 'queue'
    jobs = [f'RQ-GATE-{i}' for i in range(n)]
    for j in jobs:
        (q / 'prompts' / f'{j}.md').write_text('fixture prompt')
    (q / 'ready.tsv').write_text(''.join(f'{j}\tphantom\tdevin\twork\t{q}/prompts/{j}.md\n' for j in jobs))
    (q / 'router-queue.md').write_text(''.join(f'- READY {j} (pool=devin, tier=work, repo=phantom): fixture\n' for j in jobs))
    return tmp, home


def launched(home):
    return [ln.split()[3] for ln in events(home).splitlines() if ' LAUNCH ' in ln]


def ready_left(home):
    return [ln for ln in (home / '.ashlr-runs' / 'queue' / 'ready.tsv').read_text().splitlines() if ln]


def stub_ps(home, lines):
    ps = home / 'stubbin' / 'ps'
    ps.write_text('#!/bin/bash\n' + ''.join(f'echo "{1000 + i} /usr/bin/idle"\n' for i in range(lines)) + 'exit 0\n')
    ps.chmod(0o755)


class GateTests(unittest.TestCase):
    def _case(self, env=None, n=1, prep=None):
        tmp, home = ready_fixture(n)
        self.addCleanup(tmp.cleanup)
        if prep:
            prep(home)
        r = tick(home, env)
        self.assertEqual(r.returncode, 0, r.stderr)
        return home

    def test_healthy_host_admits(self):
        home = self._case()
        self.assertEqual(launched(home), ['RQ-GATE-0'])
        a = admission(home)
        self.assertTrue(a['admit'])
        self.assertIsNone(a['reason'])
        self.assertNotIn('LOADGATE', events(home))

    def test_loadavg_over_twice_ncpu_blocks_claims(self):
        home = self._case({'LOADGATE_NCPU': '4', 'LOADGATE_LOADAVG': '8.5'})
        self.assertEqual(launched(home), [])
        self.assertEqual(len(ready_left(home)), 1, 'a gated job must stay queued, not be dropped')
        a = admission(home)
        self.assertFalse(a['admit'])
        self.assertIn('loadavg 8.5 > 8.0', a['reason'])
        self.assertIn('LOADGATE tripped: loadavg 8.5 > 8.0', events(home))

    def test_loadavg_at_twice_ncpu_still_admits(self):
        home = self._case({'LOADGATE_NCPU': '4', 'LOADGATE_LOADAVG': '8.0'})
        self.assertEqual(launched(home), ['RQ-GATE-0'])

    def test_loadavg_over_36_blocks_even_on_a_big_machine(self):
        home = self._case({'LOADGATE_NCPU': '64', 'LOADGATE_LOADAVG': '36.5'})
        self.assertEqual(launched(home), [])
        self.assertIn('loadavg 36.5 > 36.0', admission(home)['reason'])
        home = self._case({'LOADGATE_NCPU': '64', 'LOADGATE_LOADAVG': '35.9'})
        self.assertEqual(launched(home), ['RQ-GATE-0'])

    def test_more_than_800_processes_blocks(self):
        home = self._case(prep=lambda h: stub_ps(h, 801))
        self.assertEqual(launched(home), [])
        self.assertIn('procs 801 > 800', admission(home)['reason'])
        home = self._case(prep=lambda h: stub_ps(h, 800))
        self.assertEqual(launched(home), ['RQ-GATE-0'])

    def test_more_than_40_live_worktrees_warns_but_admits(self):
        def prep(home, count=41):
            for i in range(count):
                j = f'RQ-LIVE-{i:02d}'
                (home / 'Projects' / 'ashlrai' / 'wt' / j).mkdir()
                (home / '.ashlr-runs' / f'{j}.base').write_text(f'deadbeef x {home}/Projects/ashlrai/wt/{j} claude\n')
        home = self._case(prep=prep)
        self.assertEqual(launched(home), ['RQ-GATE-0'])
        self.assertEqual(admission(home)['worktrees'], 41)
        self.assertIn('worktrees 41 > 40', admission(home)['warnings'])
        self.assertTrue(admission(home)['admit'])
        self.assertIsNone(admission(home)['reason'])
        self.assertIn('LOADGATE warn (non-tripping): worktrees 41 > 40', events(home))
        # 40 worktrees is the limit, not over it; they sit on the held claude lane so only the gate decides.
        home = self._case(prep=lambda h: prep(h, 40))
        self.assertEqual(admission(home)['worktrees'], 40)
        self.assertEqual(admission(home)['warnings'], [])

    def test_stale_daemon_tick_warns_but_admits(self):
        home = self._case(prep=lambda h: set_daemon_tick(h, '2020-01-01T00:00:00Z'))
        self.assertEqual(launched(home), ['RQ-GATE-0'])
        self.assertRegex(admission(home)['warnings'][0], r'daemon_tick_stale \d+s > 900s')
        self.assertIsNone(admission(home)['reason'])

    def test_missing_null_or_unreadable_daemon_status_warns_but_admits(self):
        for value in (None, 'null', 'not-a-timestamp'):
            home = self._case(prep=lambda h, v=value: set_daemon_tick(h, v))
            self.assertEqual(launched(home), ['RQ-GATE-0'], value)
            self.assertIn('daemon_status_unavailable', admission(home)['warnings'][0], value)
            self.assertIsNone(admission(home)['reason'], value)

    def test_warnings_do_not_mask_a_tripping_gate(self):
        home = self._case({'LOADGATE_LOADAVG': '50'}, prep=lambda h: set_daemon_tick(h, '2020-01-01T00:00:00Z'))
        self.assertEqual(launched(home), [])
        self.assertIn('loadavg', admission(home)['reason'])
        self.assertNotIn('daemon_tick_stale', admission(home)['reason'])
        self.assertRegex(admission(home)['warnings'][0], r'daemon_tick_stale')

    def test_disk_hard_stop_blocks_launches(self):
        def prep(home):
            (home / '.ashlr-runs' / 'DISKGUARD_TEST').write_text('')
        home = self._case({'DISKGUARD_FREE_GB': '20'}, prep=prep)
        self.assertEqual(launched(home), [])
        self.assertIn('DISKGUARD hard_stop 20G < 30G, no launches', events(home))

    def test_fresh_daemon_tick_just_inside_window_admits(self):
        import datetime as dt
        t = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=14)).strftime('%Y-%m-%dT%H:%M:%SZ')
        home = self._case(prep=lambda h: set_daemon_tick(h, t))
        self.assertEqual(launched(home), ['RQ-GATE-0'])

    def test_owner_off_switch_disables_the_gate(self):
        home = self._case({'LOADGATE_LOADAVG': '500'}, prep=lambda h: (h / '.ashlr-runs' / 'queue' / 'LOADGATE_OFF').write_text(''))
        self.assertEqual(launched(home), ['RQ-GATE-0'])
        self.assertTrue(admission(home)['disabled'])

    def test_test_overrides_are_ignored_without_the_marker(self):
        def prep(home):
            (home / '.ashlr-runs' / 'LOADGATE_TEST').unlink()
        home = self._case({'LOADGATE_LOADAVG': '0.1', 'LOADGATE_NCPU': '999'}, prep=prep)
        a = admission(home)
        self.assertEqual(a['ncpu'], os.cpu_count())   # the env pins did not apply

    def test_event_logged_once_per_trip_and_clear_logged(self):
        tmp, home = ready_fixture()
        self.addCleanup(tmp.cleanup)
        for _ in range(2):
            tick(home, {'LOADGATE_LOADAVG': '90'})
        self.assertEqual(events(home).count('LOADGATE tripped'), 1)
        tick(home)
        self.assertIn('LOADGATE clear', events(home))


class GlobalCapTests(unittest.TestCase):
    def test_cap_is_min_of_target_sum_and_ncpu(self):
        tmp, home = ready_fixture(3)
        self.addCleanup(tmp.cleanup)
        tick(home, {'LOADGATE_NCPU': '2'})
        self.assertEqual(admission(home)['cap'], 2)   # min(sum targets 10, ncpu 2)
        self.assertEqual(len(launched(home)), 2)
        self.assertEqual(len(ready_left(home)), 1)

    def test_cap_counts_running_jobs_from_every_lane(self):
        tmp, home = ready_fixture(2)
        self.addCleanup(tmp.cleanup)
        j = 'RQ-OTHER'   # one fresh claude job counts against the cap of 2 even though claude is held
        (home / 'Projects' / 'ashlrai' / 'wt' / j).mkdir()
        (home / '.ashlr-runs' / f'{j}.base').write_text(f'deadbeef x {home}/Projects/ashlrai/wt/{j} claude\n')
        tick(home, {'LOADGATE_NCPU': '2'})
        a = admission(home)
        self.assertEqual((a['cap'], a['running'] if len(launched(home)) == 0 else None), (2, None))
        self.assertEqual(len(launched(home)), 1)

    def test_cap_is_sum_of_unheld_targets_when_that_is_smaller(self):
        tmp, home = ready_fixture(3, slot=devin_slot(target=1, floor=0, last_change=int(1e15)))
        self.addCleanup(tmp.cleanup)
        tick(home)
        self.assertEqual(admission(home)['cap'], 1)
        self.assertEqual(len(launched(home)), 1)

    def test_global_hard_cap_bounds_the_cap(self):
        tmp, home = ready_fixture(3, top={'hard_cap': 1})
        self.addCleanup(tmp.cleanup)
        tick(home)
        a = admission(home)
        self.assertEqual((a['cap'], a['hard_cap']), (1, 1))
        self.assertEqual(len(launched(home)), 1)

    def test_global_hard_cap_seeded_and_bad_values_reset(self):
        tmp, home = ready_fixture(0)
        self.addCleanup(tmp.cleanup)
        tick(home)
        self.assertEqual(slots_of(home)['hard_cap'], 18)
        for bad in (-3, 'ten', True, None, 2.5):
            slots = slots_of(home)
            slots['hard_cap'] = bad
            (home / '.ashlr-runs' / 'queue' / 'slots.json').write_text(json.dumps(slots))
            tick(home)
            self.assertEqual(slots_of(home)['hard_cap'], 18, bad)


class HardCapTests(unittest.TestCase):
    def _devin(self, slot, ap=None, env=None, ticks=1, running=0):
        slots = held_lanes()
        slots['devin'] = devin_slot(last_change=0, **slot)
        tmp = build(slots=slots)
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        q = home / '.ashlr-runs' / 'queue'
        (home / '.ashlr-runs' / 'bin' / 'autopilot.py').write_text(ap or AP_GREEN)
        pf = q / 'prompts' / 'RQ-HC-1.md'
        pf.write_text('fixture prompt')
        (q / 'ready.tsv').write_text(f'RQ-HC-1\tphantom\tdevin\twork\t{pf}\n')
        (q / 'router-queue.md').write_text('- READY RQ-HC-1 (pool=devin, tier=work, repo=phantom): fixture\n')
        for i in range(running):
            j = f'RQ-RUN-{i:02d}'
            (home / 'Projects' / 'ashlrai' / 'wt' / j).mkdir()
            (home / '.ashlr-runs' / f'{j}.base').write_text(f'deadbeef x {home}/Projects/ashlrai/wt/{j} devin\n')
        for _ in range(ticks):
            r = tick(home, env)
            self.assertEqual(r.returncode, 0, r.stderr)
        return home

    def test_hard_cap_seeded_per_pool(self):
        home = self._devin({})
        s = slots_of(home)
        self.assertEqual({k: v['hard_cap'] for k, v in s.items() if isinstance(v, dict)},
                         {'codex-cmp': 32, 'codex-personal': 32, 'claude': 8, 'devin': 10, 'claude-api': 8, 'codex-local': 6})

    def test_hard_cap_clamps_stored_target_ceiling_and_floor(self):
        home = self._devin({'target': 14, 'floor': 12, 'ceiling': 16, 'hard_cap': 8})
        d = slots_of(home)['devin']
        self.assertEqual((d['target'], d['floor'], d['ceiling'], d['hard_cap']), (8, 8, 8, 8))

    def test_floor_raise_never_exceeds_hard_cap(self):
        # A supervisor raising the floor above hard_cap is pulled back on the next tick.
        home = self._devin({'target': 2, 'floor': 3, 'ceiling': 16, 'hard_cap': 5})
        s = slots_of(home)
        s['devin']['floor'] = 9
        (home / '.ashlr-runs' / 'queue' / 'slots.json').write_text(json.dumps(s))
        tick(home)
        d = slots_of(home)['devin']
        self.assertLessEqual(d['floor'], 5)
        self.assertLessEqual(d['target'], 5)

    def test_ramp_stops_at_hard_cap_below_ceiling(self):
        # target 6 of hard_cap 7, ceiling 16, 6 running with queue depth: +2 would be 8, clamps to 7.
        home = self._devin({'target': 6, 'floor': 3, 'ceiling': 16, 'hard_cap': 7}, running=6)
        d = slots_of(home)['devin']
        self.assertEqual(d['target'], 7)
        self.assertIn('SLOTS devin 6->7', events(home))
        # and at the cap it stays put
        tick(home, None)
        self.assertEqual(slots_of(home)['devin']['target'], 7)

    def test_ramp_pauses_while_gate_tripped(self):
        home = self._devin({'target': 6, 'floor': 3, 'ceiling': 16, 'hard_cap': 16}, running=6, env={'LOADGATE_LOADAVG': '90'})
        self.assertEqual(slots_of(home)['devin']['target'], 6)
        self.assertNotIn('SLOTS devin 6->', events(home))

    def test_ramp_resumes_when_gate_clears(self):
        home = self._devin({'target': 6, 'floor': 3, 'ceiling': 16, 'hard_cap': 16}, running=6, env={'LOADGATE_LOADAVG': '90'})
        tick(home)
        self.assertEqual(slots_of(home)['devin']['target'], 8)

    def test_autopilot_overrides_reload_cannot_lift_devin_over_hard_cap(self):
        # budget-overrides.json via autopilot.py reapplies devin floor 12 / ceiling 30 every tick (dispatchd L224-227
        # in the pre-change numbering). With hard_cap 8, devin must stay at or under 8 on every tick of the reload.
        ap = ('#!/usr/bin/python3\nimport json, sys\n'
              'json.dump({"lane_disk_gate": "green", "memory": {"known": True, "raise_ok": True},'
              ' "devin": {"limits": {"floor": 12, "ceiling": 30}}}, sys.stdout)\n')
        slots = held_lanes()
        slots['devin'] = devin_slot(target=10, hard_cap=8, last_change=0)
        tmp = build(slots=slots)
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        (home / '.ashlr-runs' / 'bin' / 'autopilot.py').write_text(ap)
        for _ in range(3):
            r = tick(home)
            self.assertEqual(r.returncode, 0, r.stderr)
            d = slots_of(home)['devin']
            self.assertLessEqual(d['target'], 8, d)
            self.assertLessEqual(d['floor'], 8, d)
            self.assertLessEqual(d['ceiling'], 8, d)
            self.assertEqual(d['hard_cap'], 8)

    def test_overrides_reload_without_hard_cap_still_applies_below_it(self):
        ap = ('#!/usr/bin/python3\nimport json, sys\n'
              'json.dump({"lane_disk_gate": "green", "memory": {"known": True, "raise_ok": True},'
              ' "devin": {"limits": {"floor": 4, "ceiling": 12}}}, sys.stdout)\n')
        home = self._devin({'target': 10, 'hard_cap': 16}, ap=ap)
        d = slots_of(home)['devin']
        self.assertEqual((d['floor'], d['ceiling']), (4, 12))


class AdmissionSnapshotTests(unittest.TestCase):
    def test_install_lock_holder_reported_only_while_pid_alive(self):
        tmp, home = ready_fixture(0)
        self.addCleanup(tmp.cleanup)
        lock = home / '.ashlr-runs' / 'queue' / 'install.lock'
        lock.write_text(json.dumps({'pid': os.getpid(), 'job': 'RQ-X', 'command': 'npm ci', 'since': 1}))
        tick(home)
        self.assertEqual(admission(home)['install_lock_holder']['job'], 'RQ-X')
        lock.write_text(json.dumps({'pid': 2 ** 22 + 12345, 'job': 'RQ-DEAD'}))
        tick(home)
        self.assertIsNone(admission(home)['install_lock_holder'])
        lock.write_text('')
        tick(home)
        self.assertIsNone(admission(home)['install_lock_holder'])

    def test_snapshot_carries_gate_inputs(self):
        tmp, home = ready_fixture(0)
        self.addCleanup(tmp.cleanup)
        tick(home, {'LOADGATE_LOADAVG': '3.5', 'LOADGATE_NCPU': '10'})
        a = admission(home)
        self.assertEqual((a['load1'], a['ncpu'], a['load_max'], a['procs'], a['worktrees']), (3.5, 10, 20.0, 0, 0))
        self.assertEqual(a['schema'], 'dispatchd.admission.v1')
        self.assertEqual(json.loads((home / '.ashlr-runs' / 'queue' / 'status.json').read_text())['admission']['cap'], a['cap'])


if __name__ == '__main__':
    unittest.main()
