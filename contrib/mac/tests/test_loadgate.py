"""Fixture tests for the RQ-LOADGATE-1 admission gate in contrib/mac/dispatchd.py.

Same harness as test_dispatchd.py: each case builds a synthetic ~/.ashlr-runs in a temp HOME and runs one tick of the repo
copy as a subprocess. Load and ncpu are pinned through LOADGATE_LOADAVG / LOADGATE_NCPU (honored only while the
LOADGATE_TEST marker exists), `ps` and `ashlr daemon status --json` are stubs. Covers each hard gate (memory pressure, swap growth and disk; load, processes, worktrees and tick age warn), the global running cap, the hard_cap clamps, the ramp pause, and the autopilot overrides reload.
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
    def _case(self, env=None, n=1, prep=None, **kwargs):
        tmp, home = ready_fixture(n, **kwargs)
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

    def test_loadavg_soft_limit_halves_claims(self):
        home = self._case({'LOADGATE_NCPU': '18', 'LOADGATE_LOADAVG': '64'}, n=4,
                          prep=lambda h: stub_ps(h, 962))
        self.assertEqual(len(launched(home)), 2)
        self.assertTrue(admission(home)['admit'])
        self.assertEqual(admission(home)['decision'], 'halve_claims')
        self.assertEqual(len(ready_left(home)), 2)

    def test_loadavg_at_three_times_ncpu_admits_full_batch(self):
        home = self._case({'LOADGATE_LOADAVG': '54'}, n=4)
        self.assertEqual(len(launched(home)), 4)

    def test_pressure_critical_blocks_and_warning_admits(self):
        for pressure, expected in [('4', 0), ('8', 0), ('2', 1), ('1', 1)]:
            home = self._case({'LOADGATE_PRESSURE': pressure})
            self.assertEqual(len(launched(home)), expected)
            self.assertEqual(admission(home)['admit'], bool(expected))

    def test_swap_growth_window_and_boundary(self):
        import time
        def prep(home, age):
            (home / '.ashlr-runs' / 'queue' / 'admission.json').write_text(
                json.dumps({'swap_samples': [[time.time() - age, 1]]}))
        for used, age, expected in [('3.1', 299, 0), ('3', 299, 1), ('9', 301, 1)]:
            home = self._case({'LOADGATE_SWAP_GB': used}, prep=lambda h: prep(h, age))
            self.assertEqual(len(launched(home)), expected)
            self.assertEqual(admission(home)['admit'], bool(expected))

    def test_more_than_2500_processes_warns(self):
        for count in (2500, 2501):
            home = self._case(prep=lambda h: stub_ps(h, count))
            self.assertEqual(len(launched(home)), 1)
            self.assertEqual(any('procs' in w for w in admission(home)['warnings']), count > 2500)

    def test_more_than_40_live_worktrees_warns_but_admits(self):
        def prep(home, count=41):
            for i in range(count):
                j = f'RQ-LIVE-{i:02d}'
                (home / 'Projects' / 'ashlrai' / 'wt' / j).mkdir()
                (home / '.ashlr-runs' / f'{j}.base').write_text(f'deadbeef x {home}/Projects/ashlrai/wt/{j} claude\n')
            (home / 'stubbin' / 'ps').write_text('#!/bin/bash\n' + ''.join(f'echo \"{1000+i} launch.sh RQ-LIVE-{i:02d} fixture\"\n' for i in range(count)))
            seed_cap(home, 64)   # an earlier tick already raised the adaptive cap past the 41 live sessions
        capacity = {'slot': devin_slot(target=64, ceiling=64, hard_cap=64, last_change=int(1e15)),
                    'top': {'hard_cap': 64}}
        home = self._case({'LOADGATE_NCPU': '64'}, prep=prep, **capacity)
        self.assertEqual(launched(home), ['RQ-GATE-0'])
        self.assertEqual(admission(home)['worktrees'], 41)
        self.assertIn('worktrees 41 > 40', admission(home)['warnings'])
        self.assertTrue(admission(home)['admit'])
        self.assertIsNone(admission(home)['reason'])
        self.assertIn('LOADGATE warn (non-tripping): worktrees 41 > 40', events(home))
        # 40 worktrees is the limit, not over it; they sit on the held claude lane so only the gate decides.
        home = self._case({'LOADGATE_NCPU': '64'}, prep=lambda h: prep(h, 40), **capacity)
        self.assertEqual(admission(home)['worktrees'], 40)
        self.assertEqual(admission(home)['warnings'], [])

    def test_dead_worktrees_do_not_count(self):
        def prep(home):
            w = home / 'Projects' / 'ashlrai' / 'wt' / 'RQ-DEAD'
            w.mkdir()
            (home / '.ashlr-runs' / 'RQ-DEAD.base').write_text(f'deadbeef x {w} claude\n')
        home = self._case(prep=prep)
        self.assertEqual(admission(home)['worktrees'], 0)

    def test_threshold_overrides(self):
        home = self._case({'GATE_PRESSURE_MIN': '8', 'LOADGATE_PRESSURE': '4',
                           'GATE_LOAD_PER_CPU': '4', 'LOADGATE_LOADAVG': '64'})
        self.assertTrue(admission(home)['admit'])
        self.assertFalse(admission(home)['soft_load'])

    def test_stale_daemon_tick_warns_but_admits(self):
        home = self._case(prep=lambda h: set_daemon_tick(h, '2020-01-01T00:00:00Z'))
        self.assertEqual(launched(home), ['RQ-GATE-0'])
        self.assertRegex(admission(home)['warnings'][0], r'daemon_tick_stale \d+s > 900s')
        self.assertIn('Phantom daemon last tick: 2020-01-01T00:00:00Z', admission(home)['warnings'][0])
        self.assertEqual(admission(home)['daemon_last_tick_at'], '2020-01-01T00:00:00Z')
        self.assertIsNone(admission(home)['reason'])

    def test_missing_null_or_unreadable_daemon_status_warns_but_admits(self):
        for value in (None, 'null', 'not-a-timestamp'):
            home = self._case(prep=lambda h, v=value: set_daemon_tick(h, v))
            self.assertEqual(launched(home), ['RQ-GATE-0'], value)
            self.assertIn('daemon_status_unavailable', admission(home)['warnings'][0], value)
            self.assertIsNone(admission(home)['reason'], value)

    def test_warnings_do_not_mask_a_tripping_gate(self):
        home = self._case({'LOADGATE_PRESSURE': '4'}, prep=lambda h: set_daemon_tick(h, '2020-01-01T00:00:00Z'))
        self.assertEqual(launched(home), [])
        self.assertIn('memory_pressure', admission(home)['reason'])
        self.assertNotIn('daemon_tick_stale', admission(home)['reason'])
        self.assertRegex(admission(home)['warnings'][0], r'daemon_tick_stale')

    def test_disk_hard_stop_blocks_launches(self):
        def prep(home):
            (home / '.ashlr-runs' / 'DISKGUARD_TEST').write_text('')
        home = self._case({'DISKGUARD_FREE_GB': '20'}, prep=prep)
        self.assertEqual(launched(home), [])
        self.assertFalse(admission(home)['admit'])
        self.assertIn('disk_free', admission(home)['reason'])
        self.assertIn('DISKGUARD hard_stop 20G < 30G, no launches', events(home))

    def test_disk_at_hard_stop_threshold_does_not_trip(self):
        home = self._case({'DISKGUARD_FREE_GB': '30'}, prep=lambda h:
                          (h / '.ashlr-runs' / 'DISKGUARD_TEST').write_text(''))
        self.assertTrue(admission(home)['admit'])
        self.assertIsNone(admission(home)['gate_reason'])

    def test_fresh_daemon_tick_just_inside_window_admits(self):
        import datetime as dt
        t = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=14)).strftime('%Y-%m-%dT%H:%M:%SZ')
        home = self._case(prep=lambda h: set_daemon_tick(h, t))
        self.assertEqual(launched(home), ['RQ-GATE-0'])

    def test_owner_off_switch_disables_the_gate(self):
        home = self._case({'LOADGATE_PRESSURE': '4'}, prep=lambda h: (h / '.ashlr-runs' / 'queue' / 'LOADGATE_OFF').write_text(''))
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
            tick(home, {'LOADGATE_PRESSURE': '4'})
        self.assertEqual(events(home).count('LOADGATE tripped'), 1)
        tick(home)
        self.assertIn('LOADGATE clear', events(home))


def seed_cap(home, cap, **state):
    """Persist adaptive-controller state (RQ-QUEUE-BATCH-1), as an earlier tick would have."""
    row = {'schema': 'dispatchd.concurrency.v1', 'cap': cap, 'last_change': 0, 'last_backoff': 0, 'trouble_cap': None,
           'trouble_at': None, 'fork_failures': [], 'rate_limits': [], 'history': [], **state}
    (home / '.ashlr-runs' / 'queue' / 'concurrency.json').write_text(json.dumps(row))


def conc(home):
    return json.loads((home / '.ashlr-runs' / 'queue' / 'concurrency.json').read_text())


class GlobalCapTests(unittest.TestCase):
    def test_cap_is_min_of_target_sum_and_adaptive_cap(self):
        tmp, home = ready_fixture(3)
        self.addCleanup(tmp.cleanup)
        seed_cap(home, 2)
        tick(home, {'LOADGATE_NCPU': '2', 'ASHLR_CONCURRENCY_MIN': '1'})   # the floor (default 4) is tunable
        self.assertEqual(admission(home)['cap'], 2)   # min(sum targets 10, adaptive cap 2)
        self.assertEqual(len(launched(home)), 2)
        self.assertEqual(len(ready_left(home)), 1)

    def test_first_tick_seeds_the_controller_from_the_legacy_bound(self):
        # min(18, ncpu) as before, never under the floor of 4; ncpu no longer bounds later ticks.
        for ncpu, expected in (('2', 4), ('8', 8), ('64', 18)):
            tmp, home = ready_fixture(0, slot=devin_slot(target=32, ceiling=32, hard_cap=32, last_change=int(1e15)))
            self.addCleanup(tmp.cleanup)
            tick(home, {'LOADGATE_NCPU': ncpu})
            self.assertEqual((conc(home)['cap'], admission(home)['cap']), (expected, expected), ncpu)

    def test_cap_counts_running_jobs_from_every_lane(self):
        tmp, home = ready_fixture(2)
        self.addCleanup(tmp.cleanup)
        j = 'RQ-OTHER'   # one fresh claude job counts against the cap of 2 even though claude is held
        (home / 'Projects' / 'ashlrai' / 'wt' / j).mkdir()
        (home / '.ashlr-runs' / f'{j}.base').write_text(f'deadbeef x {home}/Projects/ashlrai/wt/{j} claude\n')
        seed_cap(home, 2)
        tick(home, {'LOADGATE_NCPU': '2', 'ASHLR_CONCURRENCY_MIN': '1'})   # the floor (default 4) is tunable
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

    def test_global_hard_cap_is_an_optional_operator_ceiling(self):
        tmp, home = ready_fixture(0)
        self.addCleanup(tmp.cleanup)
        tick(home)
        self.assertNotIn('hard_cap', slots_of(home))   # nothing seeded any more
        self.assertIsNone(admission(home)['hard_cap'])
        def write(value):
            slots = slots_of(home)
            slots['hard_cap'] = value
            (home / '.ashlr-runs' / 'queue' / 'slots.json').write_text(json.dumps(slots))
        for bad in (-3, 'ten', True, None, 2.5):   # malformed fails closed to the legacy 18, never to "no ceiling"
            write(bad)
            tick(home)
            self.assertEqual(slots_of(home)['hard_cap'], 18, bad)
        write(18)   # once the controller runs, an explicit 18 is the operator's and stays
        tick(home)
        self.assertEqual(slots_of(home)['hard_cap'], 18)
        write(40)
        tick(home)
        self.assertEqual((slots_of(home)['hard_cap'], admission(home)['concurrency_ceiling']), (40, 40))

    def test_legacy_seeded_hard_cap_is_retired_once_when_the_controller_starts(self):
        tmp, home = ready_fixture(0, top={'hard_cap': 18})
        self.addCleanup(tmp.cleanup)
        tick(home)
        self.assertNotIn('hard_cap', slots_of(home))
        self.assertIn('CONCURRENCY legacy hard_cap 18 seed retired', events(home))
        tmp, home = ready_fixture(0, top={'hard_cap': 12})   # any other value is an operator choice
        self.addCleanup(tmp.cleanup)
        tick(home)
        self.assertEqual(slots_of(home)['hard_cap'], 12)


class AdaptiveConcurrencyTests(unittest.TestCase):
    """The controller end to end through a real tick: raise on headroom, back off on danger, log every change."""
    def _saturated(self, cap=4, env=None, prep=None, **state):
        # cap sessions already running on devin (target 32) with more queued: the adaptive cap is the binding limit.
        tmp, home = ready_fixture(3, slot=devin_slot(target=32, ceiling=32, hard_cap=32, last_change=int(1e15)))
        self.addCleanup(tmp.cleanup)
        ps = []
        for i in range(cap):
            j = f'RQ-RUN-{i}'
            (home / 'Projects' / 'ashlrai' / 'wt' / j).mkdir()
            (home / '.ashlr-runs' / f'{j}.base').write_text(f'deadbeef x {home}/Projects/ashlrai/wt/{j} devin\n')
            ps.append(f'echo "{2000 + i} launch.sh {j} fixture"\n')
        (home / 'stubbin' / 'ps').write_text('#!/bin/bash\n' + ''.join(ps))
        seed_cap(home, cap, **state)
        if prep:
            prep(home)
        r = tick(home, env)
        self.assertEqual(r.returncode, 0, r.stderr)
        return home

    def test_raises_while_every_signal_has_headroom(self):
        home = self._saturated()
        self.assertEqual(conc(home)['cap'], 6)
        self.assertIn('CONCURRENCY 4->6 raise headroom', events(home))
        self.assertEqual(len(launched(home)), 2)   # the two new sessions launch in the same tick
        rows = [json.loads(l) for l in (home / '.ashlr-runs' / 'metrics' / 'jobs.jsonl').read_text().splitlines()]
        self.assertIn({'from': 4, 'to': 6, 'reason': 'raise headroom'},
                      [{k: r[k] for k in ('from', 'to', 'reason')} for r in rows if r.get('event') == 'concurrency'])

    def test_memory_pressure_warning_backs_off_before_the_gate_trips(self):
        home = self._saturated(cap=8, env={'LOADGATE_PRESSURE': '2'})
        self.assertTrue(admission(home)['admit'] is False)   # at cap: 8 running >= cap 6
        self.assertEqual(conc(home)['cap'], 6)
        self.assertIn('CONCURRENCY 8->6 backoff memory_pressure', events(home))
        self.assertNotIn('LOADGATE tripped', events(home))
        self.assertEqual(launched(home), [])

    def test_swap_growth_and_high_load_back_off(self):
        import time
        home = self._saturated(cap=8, env={'LOADGATE_SWAP_GB': '2'}, prep=lambda h: (h / '.ashlr-runs' / 'queue' / 'admission.json')
                               .write_text(json.dumps({'swap_samples': [[time.time() - 60, 0.5]]})))
        self.assertIn('CONCURRENCY 8->6 backoff swap', events(home))
        home = self._saturated(cap=8, env={'LOADGATE_LOADAVG': '45'})   # 45 / (18 x 3) = 0.83 >= 0.8
        self.assertIn('CONCURRENCY 8->6 backoff load', events(home))

    def test_rate_limit_hits_hold_then_back_off(self):
        now = __import__('time').time()
        home = self._saturated(rate_limits=[now - 30])
        self.assertEqual(conc(home)['cap'], 4)   # one recent 429: hold, no raise
        self.assertNotIn('CONCURRENCY', events(home))
        home = self._saturated(cap=8, rate_limits=[now - 30, now - 20, now - 10])
        self.assertIn('CONCURRENCY 8->6 backoff rate_limit', events(home))

    def test_fork_failure_in_a_launch_log_backs_off(self):
        def prep(home):
            run = home / '.ashlr-runs' / 'queue' / 'run'
            (run / 'RQ-FORKED.dispatched').write_text('0')
            os.utime(run / 'RQ-FORKED.dispatched', (0, 0))
            (home / '.ashlr-runs' / 'RQ-FORKED.launch').write_text('launch.sh: fork: retry: Resource temporarily unavailable\n')
        home = self._saturated(cap=8, prep=prep)
        self.assertIn('FORK_FAILED RQ-FORKED', events(home))
        self.assertIn('CONCURRENCY 8->6 backoff fork', events(home))

    def test_no_raise_past_the_trouble_point_until_settled(self):
        import time
        home = self._saturated(cap=4, trouble_cap=5, trouble_at=time.time() - 60)
        self.assertEqual(conc(home)['cap'], 4)   # 4 + 2 would reach 5 within the settle window: hold
        home = self._saturated(cap=4, trouble_cap=5, trouble_at=time.time() - 3600)
        self.assertEqual(conc(home)['cap'], 5)   # settled: probe one session at a time


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
        tmp = build()  # No explicit hard_cap from devin_slot: exercise production defaults.
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        self.assertEqual(tick(home).returncode, 0)
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
        home = self._devin({'target': 6, 'floor': 3, 'ceiling': 16, 'hard_cap': 16}, running=6, env={'LOADGATE_PRESSURE': '4'})
        self.assertEqual(slots_of(home)['devin']['target'], 6)
        self.assertNotIn('SLOTS devin 6->', events(home))

    def test_ramp_resumes_when_gate_clears(self):
        home = self._devin({'target': 6, 'floor': 3, 'ceiling': 16, 'hard_cap': 16}, running=6, env={'LOADGATE_PRESSURE': '4'})
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
    def test_local_mid_cap_load_bands_and_override(self):
        tmp, home = ready_fixture(0)
        self.addCleanup(tmp.cleanup)
        for load, expected in [('3.9', 4), ('4', 2), ('8', 2), ('8.1', 2)]:
            with self.subTest(load=load):
                r = tick(home, {'LOADGATE_NCPU': '4', 'LOADGATE_LOADAVG': load})
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertEqual(admission(home)['local_mid_cap'], expected)
        tick(home, {'LOADGATE_NCPU': '4', 'LOADGATE_LOADAVG': '9', 'LOCAL_MID_CAP': '3'})
        self.assertEqual(admission(home)['local_mid_cap'], 3)
        tick(home, {'LOADGATE_NCPU': '4', 'LOADGATE_LOADAVG': '1', 'LOCAL_MID_CAP': 'invalid'})
        self.assertEqual(admission(home)['local_mid_cap'], 4)

    def test_local_mid_cap_limits_launches(self):
        for load, expected in [('1', 4), ('4', 2), ('9', 2)]:
            with self.subTest(load=load):
                slots = held_lanes()
                slots['codex-local'] = {'target': 6, 'floor': 0, 'ceiling': 6, 'hard_cap': 6, 'last_change': int(1e15)}
                tmp = build(slots=slots)
                self.addCleanup(tmp.cleanup)
                home = Path(tmp.name).resolve()
                q = home / '.ashlr-runs' / 'queue'
                for i in range(5):
                    job = f'RQ-MID-{i}'
                    (q / 'prompts' / f'{job}.md').write_text('fixture')
                    with (q / 'ready.tsv').open('a') as f:
                        f.write(f'{job}\tphantom\tcodex-local\tmid\t{q}/prompts/{job}.md\n')
                # Stub only the loopback health probe in the child process.
                (home / 'sitecustomize.py').write_text(
                    'import urllib.request\n'
                    'class Response:\n status = 200\n def __enter__(self): return self\n def __exit__(self, *args): pass\n'
                    'class Opener:\n def open(self, *args, **kwargs): return Response()\n'
                    'urllib.request.build_opener = lambda *args: Opener()\n')
                r = tick(home, {'LOADGATE_NCPU': '4', 'LOADGATE_LOADAVG': load, 'PYTHONPATH': str(home)})
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertEqual(len(launched(home)), expected)
                self.assertEqual(len(ready_left(home)), 5 - expected)

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
        self.assertEqual((a['load1'], a['ncpu'], a['load_max'], a['procs'], a['worktrees']), (3.5, 10, 30.0, 1, 0))
        self.assertEqual(a['schema'], 'dispatchd.admission.v2')
        self.assertEqual(json.loads((home / '.ashlr-runs' / 'queue' / 'status.json').read_text())['admission']['cap'], a['cap'])


if __name__ == '__main__':
    unittest.main()
