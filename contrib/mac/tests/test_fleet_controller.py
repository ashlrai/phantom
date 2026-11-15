"""Hermetic unit tests for contrib/mac/fleet_controller.py (RQ-FLEET-LOADBALANCER-1).

Pure functions plus temp files only: no dispatcher tick, no network, no real ~/.ashlr-runs. One class per phase so each
phase is proved on its own, then a safety class that crosses them:
  PhaseABus / PhaseAWriter / PhaseALedger  signal bus, single writer, ledger (no decision logic)
  PhaseBShed                               graduated shed math, hysteresis, fail closed
  PhaseCRebalance / PhaseCOutput           cross-pool rebalance, quality weight, backpressure, objective
  SafetyTightenOnly                        never above a cap or a stored target, never loosen a pin
"""
import itertools
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fleet_controller as fc  # noqa: E402

NOW = 1_800_000_000.0
HEALTHY = dict(load=(4.0, 4.0, 4.0), ncpu=18, mem_free_pct=60, memory_pressure=1, swap_gb=0.0, swap_growth_gb=0.0,
               procs=900, worktrees=30)


def bus(**over):
    kw = dict(HEALTHY)
    kw.update(over)
    return fc.build_readings(NOW, **kw)


def lanes_view(**over):
    base = {'codex-cmp': dict(desired=10, floor=10, bound=32, held=False),
            'codex-personal': dict(desired=32, floor=10, bound=32, held=False),
            'claude': dict(desired=8, floor=0, bound=8, held=False),
            'devin': dict(desired=6, floor=3, bound=10, held=False)}
    for k, v in over.items():
        base[k].update(v)
    return base


def targets(p):
    return {l: x['target'] for l, x in p['lanes'].items()}


def level_for(load1, ncpu=18, prev=0, since=NOW - 10_000, load5=None, **over):
    r = bus(load=(load1, load1 if load5 is None else load5, load1), ncpu=ncpu, **over)
    lvl, st, why = fc.shed_level(r, {'schema': fc.SCHEMA, 'level': prev, 'since': since, 'reasons': []}, NOW)
    return lvl, st, why


class PhaseABus(unittest.TestCase):
    def test_healthy_bus_has_no_missing_and_derives_swap_rate(self):
        r = bus(swap_growth_gb=0.5, swap_window_s=1800)
        self.assertEqual(r['missing'], [])
        self.assertEqual(r['swap_rate_gb_h'], 1.0)
        self.assertEqual(r['load1'], 4.0)

    def test_unreadable_values_become_none_never_zero(self):
        r = bus(load=(float('inf'), float('nan'), 'x'), ncpu=True, mem_free_pct=None, memory_pressure=None, procs=None)
        for k in ('load1', 'load5', 'load15', 'ncpu', 'mem_free_pct', 'memory_pressure', 'procs'):
            self.assertIsNone(r[k], k)
        self.assertEqual(r['missing'], ['load1', 'ncpu', 'procs', 'memory'])

    def test_one_memory_source_is_enough(self):
        self.assertEqual(bus(mem_free_pct=None)['missing'], [])
        self.assertEqual(bus(memory_pressure=None)['missing'], [])

    def test_noncritical_gaps_are_degraded_not_missing(self):
        r = bus(swap_gb=None, swap_growth_gb=None, worktrees=None)
        self.assertEqual(r['missing'], [])
        self.assertTrue({'swap_gb', 'swap_growth_gb', 'worktrees', 'merge'} <= set(r['degraded']))

    def test_concurrency_signals_keep_the_old_contract(self):
        r = bus()
        s = fc.concurrency_signals(r, 2.0, 30.0, 2.0, 2500)
        self.assertEqual(set(s), {'load1', 'ncpu', 'load_per_cpu_max', 'memory_pressure', 'mem_free_pct', 'swap_gb',
                                  'swap_growth_gb', 'swap_growth_max_gb', 'disk_free_gb', 'disk_hard_stop_gb', 'procs', 'procs_max'})
        self.assertEqual(fc.concurrency_signals(bus(load=(None, None, None)), 2.0, 30.0, 2.0, 2500)['load1'], float('inf'))

    def test_lane_quota_reads_overrides(self):
        q = fc.lane_quota({'claude': {'weekly_used_pct': 80, 'burn_pct_per_hour': 1.5}, 'devin': 'junk'}, ['claude', 'devin', 'x'])
        self.assertEqual(q['claude'], {'remaining_pct': 20.0, 'burn_pct_per_hour': 1.5, 'credits_remaining': None})
        self.assertIsNone(q['devin']['remaining_pct'])
        self.assertIsNone(q['x']['burn_pct_per_hour'])

    def test_tier_depth_counts_valid_tiers_only(self):
        lines = ['a\tp\tdevin\twork\tf', 'b\tp\tdevin\twork\tf', 'c\tp\tclaude\tfast\tf', 'd\tp\tclaude\tbogus\tf', 'short']
        self.assertEqual(fc.tier_depth(lines, {'work', 'fast', 'mid', 'frontier'}), {'fast': 1, 'frontier': 0, 'mid': 0, 'work': 2})

    def rows(self):
        def r(kind, job, **kw):
            return dict(event=kind, job=job, **kw)
        out = [r('launch', 'J1', lane='codex-personal'), r('launch', 'J2', lane='codex-personal'), r('launch', 'J3', lane='claude')]
        for j in ('J1', 'J2', 'J3'):
            out.append(r('publish', j, url=f'https://github.com/o/r/pull/{j[1]}'))
        iso = lambda s: fc.datetime.fromtimestamp(NOW - s, fc.timezone.utc).isoformat()
        out += [dict(event='outcome', url='https://github.com/o/r/pull/1', state='MERGED', ts=iso(600)),
                dict(event='outcome', url='https://github.com/o/r/pull/1', state='MERGED', ts=iso(60)),   # re-emitted
                dict(event='outcome', url='https://github.com/o/r/pull/2', state='MERGED', ts=iso(7200)),
                dict(event='outcome', url='https://github.com/o/r/pull/3', state='CLOSED', ts=iso(300), ci='failure')]
        return out

    def test_merge_stats_window_dedupe_and_lane_join(self):
        m = fc.merge_stats(self.rows(), NOW)
        self.assertEqual(m['merged_1h'], 1)            # J1 only; J2 is outside the hour; the re-emitted row is not counted twice
        self.assertEqual(m['resolved'], 3)
        self.assertEqual(m['by_lane']['codex-personal'], {'merged': 2, 'closed': 0})
        self.assertEqual(m['by_lane']['claude'], {'merged': 0, 'closed': 1})
        self.assertEqual(m['closed_unmerged_rate'], 0.333)
        self.assertEqual(m['ci_fail_rate'], 1.0)

    def test_merge_stats_ignores_garbage_rows(self):
        m = fc.merge_stats([None, 5, {'event': 'outcome'}, {'event': 'outcome', 'url': 'u', 'state': 'MERGED', 'ts': 'nope'}], NOW)
        self.assertEqual((m['merged_1h'], m['resolved'], m['ci_fail_rate']), (0, 0, None))


class PhaseAWriter(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, 'fleet-controller.lock')
        self.slots = {'a': {'target': 4, 'floor': 1, 'ceiling': 8, 'hard_cap': 8, 'last_change': 0},
                      'b': {'target': 2, 'floor': 0, 'ceiling': 4, 'hard_cap': 4, 'last_change': 0}}
        self.pins = {'a': 8, 'b': 4}

    def writer(self):
        return fc.SlotWriter.acquire(self.path, self.slots, self.pins, NOW)

    def test_second_writer_is_excluded_until_release(self):
        w1 = self.writer()
        self.assertIsNotNone(w1)
        self.assertIsNone(self.writer())
        w1.release()
        w2 = self.writer()
        self.assertIsNotNone(w2)
        w2.release()

    def test_mutation_without_the_lock_is_refused(self):
        w = self.writer()
        w.release()
        for call in (lambda: w.set_target('a', 1, 's'), lambda: w.hold('a', 's', 'r'), lambda: w.unhold('a', 's', 'r'),
                     lambda: w.annotate('a', x=1), lambda: w.touch('a')):
            with self.assertRaises(fc.WriterNotOwner):
                call()
        self.assertEqual(self.slots['a']['target'], 4)

    def test_target_is_clamped_to_hard_cap_and_pin(self):
        w = self.writer()
        self.assertTrue(w.set_target('a', 99, 'ramp'))
        self.assertEqual(self.slots['a']['target'], 8)
        self.slots['a']['hard_cap'] = 6      # an operator lowered the cap mid-tick
        w.set_target('a', 99, 'ramp')
        self.assertEqual(self.slots['a']['target'], 6)
        self.pins['a'] = 5
        w.pins = self.pins
        w.set_target('a', 99, 'ramp')
        self.assertEqual(self.slots['a']['target'], 5)
        w.set_target('a', -3, 'x')
        self.assertEqual(self.slots['a']['target'], 0)
        w.release()

    def test_mutations_carry_source_and_reason(self):
        seen = []
        w = fc.SlotWriter.acquire(self.path, self.slots, self.pins, NOW, on_event=seen.append)
        w.set_target('a', 2, 'ratelimit', 'halve')
        self.assertEqual(seen[0], {'lane': 'a', 'field': 'target', 'from': 4, 'to': 2, 'source': 'ratelimit', 'reason': 'halve'})
        self.assertFalse(w.set_target('a', 2, 'ratelimit'))   # unchanged value is not a mutation
        self.assertEqual(len(w.mutations), 1)
        self.assertEqual(self.slots['a']['last_change'], NOW)
        w.release()

    def test_manual_hold_is_never_overwritten(self):
        self.slots['a'].update(held=True, held_by='Masbot', held_reason='operator')
        w = self.writer()
        self.assertFalse(w.hold('a', 'autobackoff', 'quota', held_by='autobackoff', until='2026-01-01T00:00:00Z'))
        self.assertEqual(self.slots['a']['held_by'], 'Masbot')
        self.assertTrue(w.hold('b', 'autobackoff', 'quota', held_by='autobackoff', until='x'))
        self.assertEqual(self.slots['b']['held_by'], 'autobackoff')
        w.unhold('b', 'autobackoff', 'expired')
        self.assertNotIn('held', self.slots['b'])
        w.release()

    def test_annotate_cannot_touch_decision_keys(self):
        w = self.writer()
        w.annotate('a', api_pool='x')
        self.assertEqual(self.slots['a']['api_pool'], 'x')
        for k in ('target', 'hard_cap', 'ceiling', 'held', 'effective_target', 'floor', 'held_by'):
            with self.assertRaises(ValueError):
                w.annotate('a', **{k: 1})
        w.release()

    def test_apply_plan_writes_tighten_only_effective_targets(self):
        w = self.writer()
        p = {'level': 1, 'lanes': {'a': {'target': 99, 'reason': 'x', 'quality': 1.0}, 'b': {'target': 1, 'reason': 'x', 'quality': 0.8}}}
        w.apply_plan(p)
        self.assertEqual((self.slots['a']['effective_target'], self.slots['b']['effective_target']), (4, 1))   # a capped at its stored target
        self.assertEqual(self.slots['b']['quality'], 0.8)
        w.release()

    def test_ambiguous_hold_state_is_surfaced_not_rewritten(self):
        self.slots['a'].update(held=False, held_by='Masbot')
        self.assertEqual(fc.ambiguous_holds(self.slots, ['a', 'b']), ['a'])
        self.assertEqual(self.slots['a']['held_by'], 'Masbot')


class PhaseALedger(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, 'fleet-controller.jsonl')

    def record(self, **over):
        r = bus(**over)
        p = fc.plan(r, lanes_view(), 0)
        return fc.ledger_record(NOW, r, p, 'shadow', mutations=[{'lane': 'a'}], reroutes=[('J', 'codex-cmp', 'claude')])

    def test_line_shape_is_what_the_renderers_need(self):
        rec = self.record()
        for k in ('schema', 'ts', 'mode', 'shed_level', 'signals', 'lanes', 'objective_score', 'mutations', 'reroutes'):
            self.assertIn(k, rec)
        for lane in rec['lanes'].values():
            self.assertEqual({'target', 'desired', 'held', 'reason', 'quality'}, set(lane))
        for k in ('load1', 'load5', 'load15', 'mem_free_pct', 'swap_rate_gb_h', 'procs', 'worktrees', 'queue_by_tier', 'quota',
                  'merge_rate_1h', 'ci_fail_rate'):
            self.assertIn(k, rec['signals'])
        self.assertEqual(rec['reroutes'], [{'job': 'J', 'from': 'codex-cmp', 'to': 'claude'}])
        json.dumps(rec, allow_nan=False)

    def test_append_tail_roundtrip_and_garbage_lines_skipped(self):
        for i in range(3):
            self.assertTrue(fc.append_ledger(self.path, dict(self.record(), ts=i)))
        with open(self.path, 'a') as f:
            f.write('not json\n{"schema": "other"}\n')
        self.assertEqual([d['ts'] for d in fc.tail_ledger(self.path, 2)], [1, 2])
        self.assertEqual(fc.tail_ledger(self.path + '.none'), [])

    def test_rotates_once_at_the_size_cap(self):
        fc.append_ledger(self.path, self.record(), max_bytes=10)
        fc.append_ledger(self.path, self.record(), max_bytes=10)
        self.assertTrue(os.path.exists(self.path + '.1'))
        self.assertEqual(len(Path(self.path).read_text().splitlines()), 1)

    def test_append_never_raises(self):
        self.assertFalse(fc.append_ledger('/nonexistent-dir/x/y.jsonl', self.record()))
        self.assertFalse(fc.append_ledger(self.path, {'bad': float('nan')}))


class PhaseBShed(unittest.TestCase):
    def test_bands_on_18_cores(self):
        # entry bands 1.25 / 1.5 / 1.8 x ncpu = 22.5 / 27 / 32.4 load
        cases = [(10, 0), (22.4, 0), (22.5, 1), (26.9, 1), (27, 2), (32.3, 2), (32.4, 3), (200, 3)]
        for load, want in cases:
            self.assertEqual(level_for(load)[0], want, load)

    def test_bands_scale_with_ncpu(self):
        self.assertEqual(level_for(12.5, ncpu=10)[0], 1)
        self.assertEqual(level_for(12.4, ncpu=10)[0], 0)
        self.assertEqual(level_for(22.5, ncpu=36)[0], 0)

    def test_every_band_sits_below_the_admission_gate_trip(self):
        self.assertTrue(all(b < 2.0 for b in fc.LOAD_BANDS))

    def test_target_math_per_level(self):
        lv = lanes_view()
        for level, want in [(0, {'codex-cmp': 10, 'codex-personal': 32, 'claude': 8, 'devin': 6}),
                            (1, {'codex-cmp': 10, 'codex-personal': 16, 'claude': 4, 'devin': 3}),
                            (2, {'codex-cmp': 10, 'codex-personal': 10, 'claude': 2, 'devin': 3}),
                            (3, {'codex-cmp': 10, 'codex-personal': 10, 'claude': 0, 'devin': 3})]:
            self.assertEqual(targets(fc.plan(bus(), lv, level)), want, level)

    def test_small_targets_round_up_not_to_zero_and_never_exceed_desired(self):
        lv = {'x': dict(desired=1, floor=0, bound=5, held=False), 'y': dict(desired=0, floor=0, bound=5, held=False)}
        self.assertEqual(targets(fc.plan(bus(), lv, 2)), {'x': 1, 'y': 0})
        self.assertEqual(targets(fc.plan(bus(), lv, 3)), {'x': 0, 'y': 0})

    def test_every_other_signal_sheds(self):
        for over, want in [(dict(mem_free_pct=24), 1), (dict(mem_free_pct=14), 2), (dict(mem_free_pct=7), 3),
                           (dict(memory_pressure=2), 2), (dict(memory_pressure=4), 3),
                           (dict(swap_growth_gb=0.5), 1), (dict(swap_growth_gb=1.0), 2), (dict(swap_growth_gb=1.5), 3),
                           (dict(procs=1750), 1), (dict(procs=2125), 2), (dict(procs=2500), 3),
                           (dict(worktrees=60), 1), (dict(worktrees=80), 2), (dict(worktrees=120), 3)]:
            self.assertEqual(level_for(4.0, **over)[0], want, over)

    def test_worst_signal_wins_and_reasons_name_it(self):
        lvl, _, why = level_for(23, mem_free_pct=10, memory_pressure=1)
        self.assertEqual(lvl, 2)
        self.assertEqual(why, ['mem_free=2'])

    def test_escalation_is_immediate_and_can_skip_levels(self):
        self.assertEqual(level_for(40, prev=0)[0], 3)

    def test_restore_waits_for_the_dwell(self):
        lvl, st, why = level_for(4, prev=2, since=NOW - (fc.RESTORE_DWELL_S - 1))
        self.assertEqual(lvl, 2)
        self.assertIn('hold 2', why[0])

    def test_restore_steps_down_one_level_per_dwell(self):
        lvl, st, _ = level_for(4, prev=3, since=NOW - fc.RESTORE_DWELL_S)
        self.assertEqual(lvl, 2)
        self.assertEqual(st['since'], NOW)
        lvl2, _, _ = level_for(4, prev=2, since=st['since'])            # no dwell yet at level 2
        self.assertEqual(lvl2, 2)
        lvl3, st3, _ = level_for(4, prev=2, since=NOW - fc.RESTORE_DWELL_S)
        self.assertEqual(lvl3, 1)
        self.assertEqual(level_for(4, prev=1, since=NOW - fc.RESTORE_DWELL_S)[0], 0)

    def test_hysteresis_band_prevents_flapping_at_the_edge(self):
        # at level 1 (entered at 22.5) a load of 21 is under entry but above the 90% restore line (20.25): stay
        self.assertEqual(level_for(21, prev=1)[0], 1)
        self.assertEqual(level_for(20.2, prev=1)[0], 0)

    def test_restore_also_needs_load5_to_fall(self):
        self.assertEqual(level_for(10, prev=1, load5=25)[0], 1)
        self.assertEqual(level_for(10, prev=1, load5=10)[0], 0)

    def test_memory_restore_needs_margin(self):
        self.assertEqual(level_for(4, prev=1, mem_free_pct=27)[0], 1)    # 25 + 5 margin
        self.assertEqual(level_for(4, prev=1, mem_free_pct=31)[0], 0)

    def test_symmetric_auto_restore_after_a_spike(self):
        state = {'schema': fc.SCHEMA, 'level': 0, 'since': NOW, 'reasons': []}
        seq = []
        t = NOW
        for load in [4, 30, 30, 4, 4, 4, 4, 4, 4, 4, 4, 4]:
            t += 60
            r = fc.build_readings(t, **dict(HEALTHY, load=(load, load, load)))
            lvl, state, _ = fc.shed_level(r, state, t)
            seq.append(lvl)
        self.assertEqual(seq, [0, 2, 2, 2, 1, 1, 0, 0, 0, 0, 0, 0])

    def test_fail_closed_on_each_critical_signal(self):
        for over in (dict(load=(None, None, None)), dict(ncpu=None), dict(procs=None),
                     dict(mem_free_pct=None, memory_pressure=None), dict(load=(float('inf'),) * 3)):
            r = bus(**over)
            lvl, _, why = fc.shed_level(r, fc.fresh_state(NOW), NOW)
            self.assertEqual(lvl, 3, over)
            self.assertTrue(why[0].startswith('fail_closed:missing='))

    def test_noncritical_gaps_do_not_freeze(self):
        r = bus(swap_gb=None, swap_growth_gb=None, worktrees=None, load=(4.0, None, None))
        self.assertEqual(fc.shed_level(r, fc.fresh_state(NOW), NOW)[0], 0)

    def test_unreadable_state_file_freezes_but_absent_is_first_run(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, 's.json')
            st, note = fc.load_state(p, NOW)
            self.assertEqual((st['level'], note), (0, 'first_run'))
            for junk in ('{', '[]', json.dumps({'schema': fc.SCHEMA, 'level': 9, 'since': 1}),
                         json.dumps({'schema': 'other', 'level': 0, 'since': 1})):
                Path(p).write_text(junk)
                st, note = fc.load_state(p, NOW)
                self.assertEqual((st['level'], note), (3, 'state_unreadable'), junk)
            fc.save_json(p, {'schema': fc.SCHEMA, 'level': 2, 'since': 5, 'reasons': []})
            self.assertEqual(fc.load_state(p, NOW), ({'schema': fc.SCHEMA, 'level': 2, 'since': 5, 'reasons': []}, None))

    def test_disabled_shed_reports_level_zero_but_keeps_state(self):
        r = bus(load=(40, 40, 40))
        lvl, st, _ = fc.shed_level(r, fc.fresh_state(NOW), NOW, enabled=False)
        self.assertEqual((lvl, st['level']), (0, 3))

    def test_frozen_plan_is_floors_and_keeps_holds(self):
        lv = lanes_view(claude=dict(held=True, held_by='autobackoff'))
        p = fc.frozen_plan(lv, 'controller_error:KeyError')
        self.assertEqual(targets(p), {'codex-cmp': 10, 'codex-personal': 10, 'claude': 0, 'devin': 3})
        self.assertTrue(p['lanes']['claude']['held'])
        self.assertEqual(p['level'], 3)

    def test_quality_weight_sheds_weak_lanes_harder_only_under_pressure(self):
        lv = lanes_view()
        q = {'codex-personal': 0.75}
        self.assertEqual(targets(fc.plan(bus(), lv, 0, q))['codex-personal'], 32)   # healthy host: no effect
        self.assertEqual(targets(fc.plan(bus(), lv, 1, q))['codex-personal'], 12)   # ceil(32 x 0.5 x 0.75)
        self.assertEqual(targets(fc.plan(bus(), lv, 1))['codex-personal'], 16)
        self.assertEqual(targets(fc.plan(bus(), lv, 3, q))['codex-personal'], 10)   # freeze is floors regardless

    def test_held_lanes_report_their_attribution(self):
        p = fc.plan(bus(), lanes_view(claude=dict(held=True, held_by='autobackoff')), 1)
        self.assertEqual(p['lanes']['claude']['reason'], 'held:autobackoff')


class PhaseCRebalance(unittest.TestCase):
    def setUp(self):
        self.plan = fc.plan(bus(), lanes_view(**{'codex-cmp': dict(held=True, held_by='autobackoff')}), 0)
        self.cands = [('J1', 'codex-cmp', 'work'), ('J2', 'codex-cmp', 'frontier'), ('J3', 'codex-cmp', 'mid'), ('N1', 'codex-personal', 'work')]
        self.ok = lambda d, t: True

    def run_rb(self, running=None, quality=None, tier_ok=None, route_ok=None, limit=4, sources=('codex-cmp',), plan=None, hold=()):
        return fc.rebalance(self.cands, set(sources), (plan or self.plan)['lanes'], running or {}, quality or {}, tier_ok or self.ok,
                            route_ok or (lambda j, d: True), limit, hold)

    def test_sources_are_backoff_or_credit_holds_only(self):
        slots = {'a': {'held': True, 'held_by': 'autobackoff'}, 'b': {'held': True, 'held_by': 'Masbot'},
                 'c': {'held': True, 'held_reason': 'credits exhausted (J 2026)'}, 'd': {'held': False, 'held_by': 'autobackoff'},
                 'e': {'held': True, 'held_by': 'autobackoff'}}
        self.assertEqual(fc.reroute_sources(slots, list(slots), {'e'}), {'a', 'c'})

    def test_prefers_same_family_then_quality(self):
        moves = self.run_rb(running={'codex-personal': 31}, quality={'claude': 1.0})
        # personal has 32 - 31 - 1 native queued = 0 headroom, so everything lands on claude
        self.assertEqual({m[2] for m in moves}, {'claude'})
        moves = self.run_rb(running={'codex-personal': 20})
        self.assertEqual(moves[0], ('J1', 'codex-cmp', 'codex-personal'))

    def test_headroom_is_target_minus_running_minus_own_queue(self):
        # personal 32, running 28, 1 native queued -> room 3; claude 8 running 8 -> none; devin/local never targets
        moves = self.run_rb(running={'codex-personal': 28, 'claude': 8, 'devin': 0}, limit=10)
        self.assertEqual([m[2] for m in moves], ['codex-personal'] * 3)

    def test_native_work_goes_first(self):
        moves = self.run_rb(running={'codex-personal': 31, 'claude': 8})
        self.assertEqual(moves, [])

    def test_never_targets_held_hold_listed_metered_devin_or_local(self):
        view = fc.plan(bus(), lanes_view(**{'codex-cmp': dict(held=True, held_by='autobackoff'),
                                            'codex-personal': dict(held=True, held_by='autobackoff')}), 0)
        self.assertEqual({m[2] for m in self.run_rb(plan=view, sources=('codex-cmp', 'codex-personal'))}, {'claude'})
        self.assertEqual(self.run_rb(plan=view, sources=('codex-cmp', 'codex-personal'), hold=('claude',)), [])
        view['lanes']['claude-api'] = dict(view['lanes']['claude'], held=False, target=8)
        view['lanes']['codex-local'] = dict(view['lanes']['claude'], held=False, target=8)
        self.assertEqual(self.run_rb(plan=view, sources=('codex-cmp', 'codex-personal'), hold=('claude',)), [])

    def test_tier_fit_is_respected(self):
        moves = self.run_rb(tier_ok=lambda d, t: not (d == 'codex-personal' and t == 'frontier'))
        self.assertEqual(dict((m[0], m[2]) for m in moves)['J2'], 'claude')
        self.assertEqual(self.run_rb(tier_ok=lambda d, t: False), [])

    def test_route_hysteresis_veto_keeps_the_job(self):
        moves = self.run_rb(route_ok=lambda j, d: j != 'J1')
        self.assertNotIn('J1', [m[0] for m in moves])
        self.assertIn('J2', [m[0] for m in moves])

    def test_move_limit_and_no_sources(self):
        self.assertEqual(len(self.run_rb(limit=2)), 2)
        self.assertEqual(self.run_rb(limit=0), [])
        self.assertEqual(self.run_rb(sources=()), [])

    def test_shed_reduces_headroom(self):
        lv = lanes_view(**{'codex-cmp': dict(held=True, held_by='autobackoff')})
        lvl1 = fc.plan(bus(), lv, 1)                                   # personal 16, claude 4
        moves = self.run_rb(plan=lvl1, running={'codex-personal': 16, 'claude': 0}, limit=10)
        self.assertEqual([m[2] for m in moves], ['claude'] * 3)
        frozen = fc.plan(bus(), lv, 3)                                 # personal at its floor, claude at 0
        self.assertEqual(self.run_rb(plan=frozen, running={'codex-personal': 10}, limit=10), [])


class PhaseCOutput(unittest.TestCase):
    def test_quality_neutral_below_min_samples_then_scaled(self):
        stats = {'by_lane': {'a': {'merged': 1, 'closed': 3}, 'b': {'merged': 5, 'closed': 0}, 'c': {'merged': 0, 'closed': 5},
                             'd': {'merged': 3, 'closed': 3}}}
        self.assertEqual(fc.lane_quality(stats), {'a': 1.0, 'b': 1.0, 'c': 0.75, 'd': 0.875})
        self.assertEqual(fc.lane_quality(None), {})

    def test_objective_prefers_ci_rate_then_closed_rate_and_never_invents(self):
        self.assertIsNone(fc.objective(bus())['score'])
        self.assertEqual(fc.objective(bus(merge={'merged_1h': 10, 'ci_fail_rate': 0.2, 'closed_unmerged_rate': 0.5}))['score'], 8.0)
        self.assertEqual(fc.objective(bus(merge={'merged_1h': 10, 'ci_fail_rate': None, 'closed_unmerged_rate': 0.1}))['score'], 9.0)
        o = fc.objective(bus(merge={'merged_1h': 4, 'ci_fail_rate': None, 'closed_unmerged_rate': None}))
        self.assertEqual((o['score'], o['fail_source']), (4.0, 'none'))

    def test_backpressure_scales_with_shed_and_saturation(self):
        lv = lanes_view()
        tiers = {'work': 10, 'fast': 0}
        cap = {'work': 10, 'fast': 5}
        healthy = fc.backpressure(fc.plan(bus(), lv, 0), {'work': 20, 'fast': 0}, cap, NOW)
        self.assertEqual((healthy['tiers']['work']['factor'], healthy['tiers']['fast']['factor']), (1.0, 1.0))   # 2x queue: ok
        sat = fc.backpressure(fc.plan(bus(), lv, 0), {'work': 60, 'fast': 0}, cap, NOW)
        self.assertEqual(sat['tiers']['work']['factor'], 0.5)                                                # 6x queue: 3/6
        shed = fc.backpressure(fc.plan(bus(), lv, 2), tiers, cap, NOW)
        self.assertEqual(shed['tiers']['work']['factor'], 0.25)
        self.assertEqual(shed['lanes']['devin']['factor'], 0.25)
        frozen = fc.backpressure(fc.plan(bus(), lv, 3), tiers, cap, NOW)
        self.assertEqual(frozen['tiers']['work']['factor'], 0.0)
        self.assertEqual(frozen['expires'], NOW + fc.BACKPRESSURE_TTL_S)

    def test_held_lane_producers_pause(self):
        p = fc.plan(bus(), lanes_view(devin=dict(held=True, held_by='autobackoff')), 0)
        self.assertEqual(fc.backpressure(p, {}, {}, NOW)['lanes']['devin']['factor'], 0.0)

    def test_tier_capacity_counts_unheld_fit_lanes(self):
        p = fc.plan(bus(), lanes_view(devin=dict(held=True, held_by='autobackoff')), 0)
        cap = fc.tier_capacity(p, lambda lane, t: lane != 'claude' or t != 'fast', ['work', 'fast'])
        self.assertEqual(cap, {'work': 10 + 32 + 8, 'fast': 10 + 32})


class SafetyTightenOnly(unittest.TestCase):
    def test_effective_target_never_exceeds_desired_or_bound_for_any_input(self):
        for desired, floor, bound, level, w in itertools.product((0, 1, 5, 40), (0, 3, 50), (0, 4, 32), range(4), (0.75, 1.0)):
            lv = {'x': dict(desired=desired, floor=floor, bound=bound, held=False)}
            t = fc.plan(bus(), lv, level, {'x': w})['lanes']['x']['target']
            self.assertLessEqual(t, min(desired, bound), (desired, floor, bound, level, w))
            self.assertGreaterEqual(t, 0)
            f = fc.frozen_plan(lv, 'x')['lanes']['x']['target']
            self.assertLessEqual(f, min(desired, bound))

    def test_pin_wins_over_a_raised_stored_target(self):
        lv = {'x': dict(desired=40, floor=0, bound=32, held=False)}
        self.assertEqual(fc.plan(bus(), lv, 0)['lanes']['x']['target'], 32)

    def test_effective_target_is_monotone_in_shed_level(self):
        lv = lanes_view()
        for lane in lv:
            seq = [fc.plan(bus(), lv, lvl)['lanes'][lane]['target'] for lvl in range(4)]
            self.assertEqual(seq, sorted(seq, reverse=True), lane)

    def test_verify_tighten_only(self):
        slots = {'a': {'hard_cap': 8, 'ceiling': 8, 'target': 4, 'effective_target': 2}}
        before = fc.caps_snapshot(slots, ['a'])
        self.assertEqual(fc.verify_tighten_only(before, slots, ['a']), [])
        slots['a']['hard_cap'] = 9
        self.assertTrue(fc.verify_tighten_only(before, slots, ['a']))
        slots['a'].update(hard_cap=6, ceiling=6, target=7)
        self.assertEqual(len(fc.verify_tighten_only(before, slots, ['a'])), 1)
        slots['a'].update(target=4, effective_target=5)
        self.assertTrue(any('effective_target' in v for v in fc.verify_tighten_only(before, slots, ['a'])))
        slots['a']['hard_cap'] = None
        self.assertTrue(fc.verify_tighten_only(before, slots, ['a']))

    def test_the_writer_exposes_no_cap_setter(self):
        public = {n for n in dir(fc.SlotWriter) if not n.startswith('_')}
        self.assertFalse({n for n in public if 'cap' in n or 'ceiling' in n or 'floor' in n} - {'pins'})

    def test_nothing_in_the_module_touches_the_hold_list_or_protected_files(self):
        src = Path(fc.__file__).read_text()
        for needle in ('/HOLD', 'PINNED_MAX', 'scrub.pl', 'publish.sh', 'sandbox', 'import subprocess', 'import urllib', 'import socket', 'ASHLR_HOME'):
            self.assertNotIn(needle, src, needle)


if __name__ == '__main__':
    unittest.main()
