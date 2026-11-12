"""One-tick fixture tests for the fleet controller wiring in contrib/mac/dispatchd.py (RQ-FLEET-LOADBALANCER-1).

Same harness as test_loadgate.py: a synthetic ~/.ashlr-runs in a temp HOME, one tick of the repo copy as a subprocess, load
and memory pinned through the LOADGATE_* test variables. Each class isolates one phase:
  PhaseATick   bus, ledger, single writer lock: nothing about launching changes (shadow, and enforce with phases="a")
  PhaseBTick   graduated shed applied (enforce, phases="b"), fail closed on a missing signal, ramp pause, tighten-only
  PhaseCTick   cross-pool rebalance through the route hysteresis, backpressure advice
"""
import fcntl
import json
from pathlib import Path
import time
import unittest

from test_dispatchd import build, devin_slot, events, held_lanes, slots_of, tick
from test_loadgate import launched

FAR = '2099-01-01T00:00:00Z'


def fixture(jobs, slots=None):
    """jobs: [(job, lane, tier)] ready lines. slots default: only devin unheld (target 6, floor 3, hard_cap 10)."""
    s = held_lanes()
    s['devin'] = devin_slot(target=6, floor=3, ceiling=10, hard_cap=10, last_change=int(1e15))
    s.update(slots or {})
    tmp = build(slots=s)
    home = Path(tmp.name).resolve()
    q = home / '.ashlr-runs' / 'queue'
    for j, _, _ in jobs:
        (q / 'prompts' / f'{j}.md').write_text('fixture prompt')
    (q / 'ready.tsv').write_text(''.join(f'{j}\tphantom\t{lane}\t{tier}\t{q}/prompts/{j}.md\n' for j, lane, tier in jobs))
    (q / 'router-queue.md').write_text(''.join(f'- READY {j} (pool={lane}, tier={tier}, repo=phantom): fixture\n' for j, lane, tier in jobs))
    return tmp, home


def ledger(home):
    p = home / '.ashlr-runs' / 'metrics' / 'fleet-controller.jsonl'
    return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []


def ready(home):
    return [l.split('\t') for l in (home / '.ashlr-runs' / 'queue' / 'ready.tsv').read_text().splitlines() if l]


class TickCase(unittest.TestCase):
    def run_tick(self, jobs, env=None, slots=None, prep=None):
        tmp, home = fixture(jobs, slots)
        self.addCleanup(tmp.cleanup)
        if prep:
            prep(home)
        r = tick(home, env)
        self.assertEqual(r.returncode, 0, r.stderr)
        return home


class PhaseATick(TickCase):
    JOBS = [(f'RQ-FC-{i}', 'devin', 'work') for i in range(4)]

    def test_default_mode_is_shadow_and_changes_nothing(self):
        home = self.run_tick(self.JOBS, {'LOADGATE_LOADAVG': '30'})   # 1.67 x ncpu: the shed would be level 2
        self.assertEqual(len(launched(home)), 4)
        rec, = ledger(home)
        self.assertEqual((rec['mode'], rec['shed_level']), ('shadow', 0))
        self.assertEqual(rec['shadow']['shed_level'], 2)
        self.assertEqual(rec['shadow']['targets']['devin'], 3)
        self.assertEqual(slots_of(home)['devin']['effective_target'], 6)

    def test_enforce_with_phase_a_only_also_changes_nothing(self):
        home = self.run_tick(self.JOBS, {'LOADGATE_LOADAVG': '30', 'FLEET_CTL_MODE': 'enforce', 'FLEET_CTL_PHASES': 'a'})
        self.assertEqual(len(launched(home)), 4)
        self.assertEqual(ledger(home)[0]['shed_level'], 0)

    def test_ledger_line_carries_signals_lanes_objective_and_status_points_at_it(self):
        home = self.run_tick(self.JOBS[:1])
        rec, = ledger(home)
        self.assertEqual(rec['schema'], 'fleet-controller.ledger.v1')
        self.assertEqual(rec['signals']['load1'], 1.0)
        self.assertEqual(rec['signals']['ncpu'], 18)
        self.assertEqual(rec['signals']['missing'], [])
        self.assertEqual(rec['lanes']['devin'], {'target': 6, 'desired': 6, 'held': False, 'reason': 'normal', 'quality': 1.0})
        self.assertTrue(rec['lanes']['claude']['held'])
        self.assertIn('objective_score', rec)
        self.assertEqual(rec['signals']['queue_by_lane']['devin'], 1)   # depth as the bus saw it, before this tick's launches
        fc = json.loads((home / '.ashlr-runs' / 'queue' / 'status.json').read_text())['fleet_controller']
        self.assertEqual((fc['mode'], fc['shed_level'], fc['ledger']), ('shadow', 0, 'metrics/fleet-controller.jsonl'))

    def test_two_ticks_append_two_lines(self):
        tmp, home = fixture([])
        self.addCleanup(tmp.cleanup)
        for _ in range(2):
            self.assertEqual(tick(home).returncode, 0)
        self.assertEqual(len(ledger(home)), 2)

    def test_second_controller_is_excluded(self):
        tmp, home = fixture(self.JOBS)
        self.addCleanup(tmp.cleanup)
        with open(home / '.ashlr-runs' / 'queue' / 'fleet-controller.lock', 'a') as other:
            fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
            r = tick(home)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(launched(home), [])
            self.assertEqual(ledger(home), [])
            self.assertEqual(len(ready(home)), 4)   # the queue was not even rewritten
        self.assertEqual(tick(home).returncode, 0)   # released: the next tick runs
        self.assertEqual(len(ledger(home)), 1)

    def test_holds_still_flow_through_the_writer(self):
        # an expired autobackoff hold is cleared (through the writer) and the lane launches again
        slots = {'devin': devin_slot(target=6, floor=3, ceiling=10, hard_cap=10, last_change=int(1e15), held=True,
                                     held_by='autobackoff', held_until='2000-01-01T00:00:00Z', held_reason='x')}
        home = self.run_tick(self.JOBS[:1], slots=slots)
        self.assertEqual(len(launched(home)), 1)
        self.assertNotIn('held', slots_of(home)['devin'])
        self.assertIn('LANE_UNHOLD devin', events(home))
        self.assertTrue(any(m['source'] == 'autobackoff' and m['field'] == 'held' for m in ledger(home)[0]['mutations']))

    def test_ambiguous_hold_state_is_reported_not_rewritten(self):
        slots = {'claude': {'held': False, 'held_by': 'Masbot', 'target': 0, 'floor': 0, 'ceiling': 8, 'hard_cap': 8, 'last_change': 0}}
        home = self.run_tick([], slots=slots)
        self.assertEqual(ledger(home)[0]['ambiguous_holds'], ['claude'])
        self.assertEqual(slots_of(home)['claude']['held_by'], 'Masbot')


class PhaseBTick(TickCase):
    JOBS = [(f'RQ-FC-{i}', 'devin', 'work') for i in range(4)]
    ENF = {'FLEET_CTL_MODE': 'enforce', 'FLEET_CTL_PHASES': 'b'}

    def test_shed25_cuts_launches_to_the_effective_target(self):
        home = self.run_tick(self.JOBS, dict(self.ENF, LOADGATE_LOADAVG='30'))   # 30 / 18 = 1.67 -> level 2: devin ceil(6/4)=2 -> floor 3
        self.assertEqual(len(launched(home)), 3)
        s = slots_of(home)['devin']
        self.assertEqual((s['target'], s['effective_target'], s['shed_level']), (6, 3, 2))
        rec, = ledger(home)
        self.assertEqual((rec['shed'], rec['mode']), ('shed25', 'enforce'))
        self.assertEqual(rec['lanes']['devin']['target'], 3)
        self.assertEqual(rec['lanes']['devin']['desired'], 6)
        self.assertIn('FLEET_SHED level 0->2', events(home))
        self.assertNotIn('shadow', rec)

    def test_healthy_host_is_untouched_in_enforce(self):
        home = self.run_tick(self.JOBS, self.ENF)
        self.assertEqual(len(launched(home)), 4)
        self.assertEqual(slots_of(home)['devin']['effective_target'], 6)

    def test_shed50_halves(self):
        slots = {'devin': devin_slot(target=10, floor=0, ceiling=10, hard_cap=10, last_change=int(1e15))}
        home = self.run_tick([(f'RQ-FC-{i}', 'devin', 'work') for i in range(8)], dict(self.ENF, LOADGATE_LOADAVG='23'), slots=slots)
        self.assertEqual(slots_of(home)['devin']['effective_target'], 5)
        self.assertEqual(len(launched(home)), 4)   # also capped by MAX_LAUNCH_PER_TICK

    def test_missing_memory_signal_fails_closed_to_floors(self):
        home = self.run_tick(self.JOBS, dict(self.ENF, LOADGATE_PRESSURE='unreadable'))   # no pressure level and no free percentage
        rec, = ledger(home)
        self.assertEqual(rec['shed_level'], 3)
        self.assertEqual(rec['signals']['missing'], ['memory'])
        self.assertTrue(rec['shed_reasons'][0].startswith('fail_closed:missing=memory'))
        self.assertEqual(len(launched(home)), 3)   # devin floor
        self.assertEqual(slots_of(home)['devin']['effective_target'], 3)

    def test_the_same_missing_signal_is_only_recorded_in_shadow(self):
        home = self.run_tick(self.JOBS, {'LOADGATE_PRESSURE': 'unreadable'})
        self.assertEqual(len(launched(home)), 4)
        self.assertEqual(ledger(home)[0]['shadow']['shed_level'], 3)

    def test_corrupt_state_file_fails_closed_then_restores_stepwise(self):
        def prep(home): (home / '.ashlr-runs' / 'queue' / 'fleet-controller.json').write_text('{garbage')
        home = self.run_tick(self.JOBS, self.ENF, prep=prep)
        self.assertEqual(ledger(home)[0]['shed_level'], 3)
        self.assertEqual(len(launched(home)), 3)

    def test_restore_waits_for_the_dwell_then_steps_down_one_level(self):
        def prep(since):
            def go(home):
                (home / '.ashlr-runs' / 'queue' / 'fleet-controller.json').write_text(
                    json.dumps({'schema': 'dispatchd.fleet-controller.v1', 'level': 3, 'since': since, 'reasons': []}))
            return go
        home = self.run_tick(self.JOBS, self.ENF, prep=prep(time.time() - 10))
        self.assertEqual(ledger(home)[0]['shed_level'], 3)
        home = self.run_tick(self.JOBS, self.ENF, prep=prep(time.time() - 500))
        self.assertEqual(ledger(home)[0]['shed_level'], 2)   # one level, not straight to normal

    def test_ramp_is_paused_while_shedding_but_not_otherwise(self):
        def slot(): return {'devin': devin_slot(target=4, floor=3, ceiling=10, hard_cap=10, last_change=0)}
        jobs = [(f'RQ-FC-{i}', 'devin', 'work') for i in range(8)]
        env = {'LOADGATE_LOADAVG': '23'}
        busy = lambda h: None
        ap = lambda h: (h / '.ashlr-runs' / 'bin' / 'autopilot.py').write_text(
            '#!/usr/bin/python3\nimport json,sys\njson.dump({"lane_disk_gate":"green","memory":{"known":True,"raise_ok":True}},sys.stdout)\n')
        calm = self.run_tick(jobs, env=None, slots=slot(), prep=ap)
        shed = self.run_tick(jobs, dict(self.ENF, **env), slots=slot(), prep=ap)
        self.assertEqual(slots_of(shed)['devin']['target'], 4)
        self.assertGreaterEqual(slots_of(calm)['devin']['target'], 4)

    def test_tighten_only_hard_cap_wins_over_a_stored_target(self):
        slots = {'devin': devin_slot(target=10, floor=0, ceiling=10, hard_cap=3, last_change=int(1e15))}
        home = self.run_tick(self.JOBS, self.ENF, slots=slots)
        s = slots_of(home)['devin']
        self.assertEqual((s['hard_cap'], s['target'], s['effective_target']), (3, 3, 3))
        self.assertEqual(len(launched(home)), 3)

    def test_gate_backstop_still_trips_above_the_bands(self):
        home = self.run_tick(self.JOBS, dict(self.ENF, LOADGATE_LOADAVG='64'))
        self.assertEqual(launched(home), [])
        self.assertEqual(ledger(home)[0]['shed_level'], 3)


class PhaseCTick(TickCase):
    ENF = {'FLEET_CTL_MODE': 'enforce', 'FLEET_CTL_PHASES': 'c'}

    def slots(self, **extra):
        s = {'codex-cmp': {'held': True, 'held_by': 'autobackoff', 'held_until': FAR, 'held_reason': 'usage limit', 'target': 10, 'floor': 0,
                           'ceiling': 32, 'hard_cap': 32, 'last_change': 0},
             'codex-personal': {'target': 4, 'floor': 0, 'ceiling': 32, 'hard_cap': 32, 'last_change': int(1e15)}}
        s.update(extra)
        return s

    JOBS = [('RQ-FC-A', 'codex-cmp', 'work'), ('RQ-FC-B', 'codex-cmp', 'mid')]

    def test_backed_off_pool_hands_its_queue_to_a_pool_with_headroom(self):
        home = self.run_tick(self.JOBS, self.ENF, slots=self.slots())
        self.assertEqual(sorted(launched(home)), ['RQ-FC-A', 'RQ-FC-B'])
        self.assertIn('FLEET_REBALANCE RQ-FC-A codex-cmp->codex-personal', events(home))
        route = json.loads((home / '.ashlr-runs' / 'queue' / 'route-state.json').read_text())
        self.assertEqual(route['RQ-FC-A']['pool'], 'codex-personal')
        self.assertEqual(route['RQ-FC-A']['moves'] and len(route['RQ-FC-A']['moves']), 1)
        rec, = ledger(home)
        self.assertEqual([(m['job'], m['from'], m['to']) for m in rec['reroutes']],
                         [('RQ-FC-A', 'codex-cmp', 'codex-personal'), ('RQ-FC-B', 'codex-cmp', 'codex-personal')])

    def test_shadow_mode_moves_nothing(self):
        home = self.run_tick(self.JOBS, slots=self.slots())
        self.assertEqual(launched(home), [])
        self.assertEqual({r[2] for r in ready(home)}, {'codex-cmp'})

    def test_phase_b_alone_does_not_reroute(self):
        home = self.run_tick(self.JOBS, {'FLEET_CTL_MODE': 'enforce', 'FLEET_CTL_PHASES': 'b'}, slots=self.slots())
        self.assertEqual(launched(home), [])

    def test_headroom_is_respected(self):
        slots = self.slots(**{'codex-personal': {'target': 1, 'floor': 0, 'ceiling': 32, 'hard_cap': 32, 'last_change': int(1e15)}})
        home = self.run_tick(self.JOBS, self.ENF, slots=slots)
        self.assertEqual(len(launched(home)), 1)
        self.assertEqual([r[2] for r in ready(home)], ['codex-cmp'])   # the second line waits where it was

    def test_manual_hold_pool_is_not_routed_around(self):
        slots = self.slots(**{'codex-cmp': {'held': True, 'held_by': 'Masbot', 'held_reason': 'operator', 'target': 10, 'floor': 0,
                                            'ceiling': 32, 'hard_cap': 32, 'last_change': 0}})
        home = self.run_tick(self.JOBS, self.ENF, slots=slots)
        self.assertEqual(launched(home), [])
        self.assertEqual({r[2] for r in ready(home)}, {'codex-cmp'})

    def test_route_hysteresis_move_cap_and_launch_lock_still_bind(self):
        now = time.time()
        def prep(home):
            rs = {'RQ-FC-A': {'pool': 'codex-cmp', 'decided_at': now - 7000, 'moves': [now - 300, now - 200]},     # move cap
                  'RQ-FC-B': {'pool': 'codex-cmp', 'decided_at': now - 7000, 'moves': [], 'launched': True}}      # launch lock
            (home / '.ashlr-runs' / 'queue' / 'route-state.json').write_text(json.dumps(rs))
        home = self.run_tick(self.JOBS, self.ENF, slots=self.slots(), prep=prep)
        self.assertEqual(launched(home), [])
        self.assertEqual({r[2] for r in ready(home)}, {'codex-cmp'})

    def test_backpressure_advice_is_written_and_marked_enforced(self):
        home = self.run_tick(self.JOBS, dict(self.ENF, FLEET_CTL_PHASES='bc', LOADGATE_LOADAVG='30'), slots=self.slots())
        bp = json.loads((home / '.ashlr-runs' / 'queue' / 'backpressure.json').read_text())
        self.assertEqual((bp['schema'], bp['enforced'], bp['shed_level']), ('fleet-controller.backpressure.v1', True, 2))
        self.assertEqual(bp['lanes']['codex-cmp']['factor'], 0.0)     # held pool
        self.assertGreater(bp['expires'], bp['ts'])
        shadow = self.run_tick(self.JOBS, slots=self.slots())
        self.assertFalse(json.loads((shadow / '.ashlr-runs' / 'queue' / 'backpressure.json').read_text())['enforced'])


if __name__ == '__main__':
    unittest.main()
