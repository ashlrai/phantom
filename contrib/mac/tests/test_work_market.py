"""Shared market contracts plus real dispatcher ticks, all in synthetic homes."""
import ast
import json
from pathlib import Path
import sys
import time
import unittest

MAC = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MAC))
import work_market as market
from test_dispatchd import build, tick, queue_job, launch_stubs, held_lanes, dispatched

CAPABILITY_PROMPTS = json.loads((MAC.parents[1] / 'test/fixtures/lane-capabilities/prompts.json').read_text())

node = next(n for n in ast.parse((MAC / 'dispatchd.py').read_text()).body
            if isinstance(n, ast.FunctionDef) and n.name == 'route_decision')
scope = {}
exec(compile(ast.Module(body=[node], type_ignores=[]), 'dispatchd.py', 'exec'), scope)
decide = scope['route_decision']


def view(**overrides):
    slots = {lane: {'target': 2, **overrides.get(lane, {})} for lane in ('codex-personal', 'claude')}
    return market.lane_view(list(slots), slots, dict.fromkeys(slots, 0), dict.fromkeys(slots, 2), set(), {}, {}, [])


class MarketUnit(unittest.TestCase):
    def test_producer_infers_gh_without_losing_declared_requirements(self):
        for job, prompt in CAPABILITY_PROMPTS['c499'].items():
            with self.subTest(job=job):
                spec = market.from_envelope('pool=claude, needs=git, max_cost_class=included', prompt)
                self.assertEqual(spec['needs'], ['git', 'gh'])
                self.assertEqual(spec['preferred_lane'], 'claude')
                self.assertEqual(spec['max_cost_class'], 'included')
        for prompt in [*CAPABILITY_PROMPTS['pureCode'].values(),
                       'Never run gh pr merge. Rename a helper.',
                       'Recut the local patch; inspect fixtures/failed-run.log offline.']:
            with self.subTest(prompt=prompt[:40]):
                self.assertEqual(market.from_envelope('pool=claude', prompt)['needs'], [])
        self.assertEqual(market.from_envelope('needs=gh', 'Run gh pr diff 12')['needs'], ['gh'])

    def test_claude_gh_requires_explicit_host_advertisement(self):
        self.assertNotIn('gh', view()['claude']['capabilities'])
        self.assertIn('gh', view()['codex-personal']['capabilities'])
        lanes = view(claude={'capabilities': ['git', 'gh', 'node']})
        self.assertEqual(self.choose({'preferred_lane': 'claude', 'needs': ['gh']}, lanes)[0]['chosen_lane'], 'claude')

    def test_claude_hashed_account_scope_survives(self):
        self.assertEqual(market._scope_names({'account_id': 'claude:0123456789abcdef'}),
                         {'account_id': 'claude:0123456789abcdef'})

    def test_provenance_only_follows_measured_posture(self):
        provenance = dict(account_id='org-test', model='swe-2-high', window_start='1970-01-01T00:00:00Z', reset_at='1970-01-01T03:46:40Z')
        for reading in ({}, {'used': 80}):
            self.assertEqual(self.devin_view(reading=dict(reading, provenance=provenance))['devin']['provenance'], provenance)
        for kwargs in ({'model': 'swe-2-flash'}, {'posture': 'preserve'}, {'free_until': 20000}):
            self.assertNotIn('provenance', self.devin_view(reading={'provenance': provenance}, **kwargs)['devin'])
        mismatch = self.devin_view(reading={'provenance': provenance}, model='swe-2-max')['devin']['provenance']
        self.assertNotIn('model', mismatch)
        self.assertEqual(mismatch['account_id'], 'org-test')
        self.assertNotIn('provenance', self.devin_view(reading={'used': None, 'provenance': provenance})['devin'])

    def test_budget_scope_normalizes_instants_and_rejects_identifiers(self):
        reading = dict(weekly_used_pct=20, burn_pct_per_hour=0, reset_at=13600, as_of=10000,
                       account_id='account-a', model='claude-opus', window_start='1970-01-01T00:00:00Z')
        def entry():
            return market.lane_view(['claude'], {'claude': {}}, {'claude': 0}, {'claude': 1}, set(), {}, {}, [],
                                    now=10000, allowance={'claude': reading})['claude']['provenance']
        self.assertEqual(entry(), dict(account_id='account-a', model='claude-opus',
                                      window_start='1970-01-01T00:00:00.000Z', reset_at='1970-01-01T03:46:40.000Z'))
        for invalid in ('name@example.com', '', '-invalid', 'a' * 129, 42):
            reading.update(account_id=invalid, model=invalid)
            self.assertNotIn('account_id', entry())
            self.assertNotIn('model', entry())
    def devin_view(self, reading=None, model='swe-2-high', running=0, now=10000, **slot):
        weekly = dict(used=20, limit=100, in_flight=10, reserve=10, session_cap=10,
                      reset_at=13600, as_of=10000, burn_rate_per_hour=0, state='live')
        weekly.update(reading or {})
        return market.lane_view(['devin'], {'devin': slot}, {'devin': running}, {'devin': 4},
                                set(), {'devin': model}, {}, [], now=now,
                                allowance={'devin': {'weekly_acu': weekly}})

    def test_devin_allowance_bounds_and_unknowns(self):
        entry = self.devin_view()['devin']
        self.assertEqual((entry['cost_class'], entry['posture']), ('included', 'burn'))
        self.assertEqual(entry['cost_class_reason'], 'devin_within_allowance')
        for reading, reason in [({'used': 80}, 'devin_allowance_headroom'),
                                ({'used': 71}, 'devin_allowance_headroom'),
                                ({'used': None}, 'devin_usage_unknown'),
                                ({'reset_at': 10000}, 'devin_reset_expired'),
                                ({'reset_at': None}, 'devin_reset_unknown'),
                                ({'limit': None}, 'devin_allowance_unknown'),
                                ({'in_flight': None}, 'devin_reservations_unknown'),
                                ({'as_of': 9000}, 'devin_usage_stale')]:
            with self.subTest(reading=reading):
                entry = self.devin_view(reading, posture='burn', cost_class='included')['devin']
                self.assertEqual((entry['cost_class'], entry['posture']), ('metered', 'balanced'))
                self.assertEqual(entry['cost_class_reason'], reason)
        self.assertEqual(self.devin_view({'used': 70})['devin']['cost_class'], 'included')
        self.assertEqual(self.devin_view({'used': 70}, running=1)['devin']['cost_class'], 'metered')
        self.assertIsNone(self.devin_view({'used': None})['devin']['allowance']['used'])

    def test_devin_preview_is_zero_cost_only_until_expiry(self):
        bound = dict(provenance=dict(account_id='org-test', model='swe-2-flash'))
        for model in ('swe-2-lightning', 'swe-2-flash'):
            entry = self.devin_view(dict({'used': None, 'as_of': 1796101199}, **bound), model=model, now=1796101199)['devin']
            self.assertEqual((entry['cost_class'], entry['posture']), ('included', 'burn'))
            self.assertTrue(entry['zero_cost'])
            self.assertEqual(entry['cost_class_reason'], 'devin_free_preview')
            self.assertEqual(self.choose(lanes={'devin': entry})[0]['ranking_inputs']['devin']['cost_class_reason'],
                             'devin_free_preview')
        expired = market.lane_view(['devin'], {'devin': {'free_until': 1e12, 'posture': 'burn'}},
                                  {'devin': 0}, {'devin': 2}, set(), {'devin': 'swe-2-flash'}, {}, [],
                                  now=1796101200)['devin']
        self.assertEqual((expired['cost_class'], expired['posture']), ('metered', 'balanced'))
        self.assertEqual(expired['cost_class_reason'], 'devin_preview_expired')
        self.assertEqual(self.devin_view(model='swe-2-high')['devin']['zero_cost'], False)

    def test_devin_preview_requires_fresh_account_evidence(self):
        for reading in ({}, {'state': None}, {'state': 'stale'}, {'as_of': 1796100000}):
            entry = self.devin_view(reading, model='swe-2-flash', now=1796101199)['devin']
            self.assertEqual((entry['cost_class'], entry['zero_cost']), ('metered', False))
            self.assertEqual(entry['cost_class_reason'], 'devin_preview_unverified')
        # Fresh and live is not enough: the reading must be bound to the measured
        # account and to a preview-scoped model.
        fresh = {'used': None, 'as_of': 1796101199}
        for provenance in (None, {}, {'account_id': 'org-test'}, {'model': 'swe-2-flash'},
                           {'account_id': 'org-test', 'model': 'swe-2-high'},
                           {'account_id': '', 'model': 'swe-2-flash'}):
            entry = self.devin_view(dict(fresh, provenance=provenance), model='swe-2-flash', now=1796101199)['devin']
            self.assertEqual((entry['cost_class'], entry['zero_cost']), ('metered', False))
            self.assertEqual(entry['cost_class_reason'], 'devin_preview_unverified')
        # Account- and preview-model-bound fresh evidence verifies, across the preview family.
        bound = dict(fresh, provenance=dict(account_id='org-test', model='swe-2-lightning'))
        entry = self.devin_view(bound, model='swe-2-flash', now=1796101199)['devin']
        self.assertEqual((entry['cost_class'], entry['zero_cost'], entry['cost_class_reason']),
                         ('included', True, 'devin_free_preview'))

    def test_metered_api_cannot_burn_from_host_posture(self):
        entry = market.lane_view(['claude-api'], {'claude-api': {'posture': 'burn'}},
                                 {'claude-api': 0}, {'claude-api': 2}, set(), {}, {}, [], now=10000)['claude-api']
        self.assertEqual(entry['posture'], 'balanced')

    def test_spend_down_projection_and_precedence(self):
        reading = dict(weekly_used_pct=20, burn_pct_per_hour=0, reset_at=13600, as_of=10000)
        def lanes(reading, **slot):
            return market.lane_view(['claude'], {'claude': slot}, {'claude': 0}, {'claude': 2},
                                    set(), {}, {}, [], now=10000, allowance={'claude': reading})
        for burn, expected, reason in [(0, 'burn', 'projected_unused'), (75, 'balanced', 'on_pace'),
                                       (91, 'preserve', 'projected_exhaustion')]:
            entry = lanes(dict(reading, burn_pct_per_hour=burn))['claude']
            self.assertEqual(entry['posture'], expected)
            self.assertEqual(entry['posture_reason'], 'spend_down_' + reason)
            self.assertEqual(entry['spend_down']['hours_to_reset'], 1)
        for bad in [None, {}, dict(reading, burn_pct_per_hour=None), dict(reading, as_of=8199),
                    dict(reading, as_of=10061), dict(reading, reset_at=10000),
                    dict(reading, weekly_used_pct=101), dict(reading, burn_pct_per_hour=-1),
                    dict(reading, burn_pct_per_hour=float('nan')), dict(reading, reset_at='bad')]:
            entry = lanes(bad)['claude']
            self.assertEqual(entry['posture'], 'preserve')
            self.assertEqual(entry['posture_reason'], 'spend_down_unknown')
            self.assertIsNone(entry['spend_down']['projected_unused_pct'])
        self.assertEqual(lanes(reading, posture='balanced')['claude']['posture_reason'], 'host_declared')
        free = lanes(reading, posture='preserve', free_until=10001)['claude']
        self.assertEqual((free['posture'], free['posture_reason']), ('burn', 'free_until'))
        metered = lanes(reading, cost_class='metered')['claude']
        self.assertEqual(metered['posture'], 'preserve')
        self.assertEqual(metered['posture_reason'], 'spend_down_not_subscription')
        self.assertIsNone(market.spend_down('claude-api', 'metered', reading, 10000)['posture'])
        iso = dict(reading, reset_at='1970-01-01T03:46:40Z', as_of='1970-01-01T02:46:40Z')
        self.assertEqual(market.spend_down('claude', 'included', iso, 10000)['posture'], 'burn')
        result, _ = self.choose(lanes=lanes(reading))
        self.assertEqual(result['ranking_inputs']['claude']['posture_reason'], 'spend_down_projected_unused')
        self.assertEqual(result['ranking_inputs']['claude']['spend_down']['projected_unused_pct'], 80)

    def choose(self, spec=None, lanes=None, record=None, now=10000):
        req = market.requirements(['j', 'phantom', '', 'work', 'p', json.dumps(spec or {})])
        return market.choose('j', req, 'work', lanes or view(), record, now, decide)

    def test_capability_and_secret_names_fail_closed(self):
        result, _ = self.choose({'needs': ['claude-cli']})
        self.assertEqual(result['chosen_lane'], 'claude')
        self.assertIn('missing_capability', result['rejected_lanes'][0]['reason_codes'])
        self.assertIsNone(self.choose({'needs': ['browser', 'secrets:TEST_KEY']})[0]['chosen_lane'])
        lanes = view(claude={'capabilities': ['browser', 'secrets:TEST_KEY']})
        self.assertEqual(self.choose({'needs': ['browser', 'secrets:TEST_KEY']}, lanes)[0]['chosen_lane'], 'claude')

    def test_quota_and_backoff_exclude_preferred_lane(self):
        for prop in ({'quota': 0}, {'auth_failed': True}, {'backoff': True}, {'held': True}):
            result, _ = self.choose({'preferred_lane': 'codex-personal'}, view(**{'codex-personal': prop}))
            self.assertEqual(result['chosen_lane'], 'claude')
            self.assertIn('preferred_lane_fallback', result['reason_codes'])
        self.assertEqual(self.choose(lanes=view(**{'codex-personal': {'quota': False}}))[0]['chosen_lane'], 'codex-personal')

    def test_capacity_rechecked_and_unknown_hints_are_open(self):
        lanes = view()
        lanes['codex-personal']['running'] = 2
        result, _ = self.choose({'preferred_lane': 'codex-personal'}, lanes)
        self.assertEqual(result['chosen_lane'], 'claude')
        self.assertEqual(self.choose({'preferred_lane': 'retired-lane'})[0]['chosen_lane'], 'codex-personal')

    def test_tier_and_cost_constraints(self):
        lanes = view(**{'codex-personal': {'tiers': ['fast'], 'cost_class': 'local'}, 'claude': {'cost_class': 'metered'}})
        result, _ = self.choose({'max_cost_class': 'included'}, lanes)
        self.assertIsNone(result['chosen_lane'])
        reasons = {r['lane']: r['reason_codes'] for r in result['rejected_lanes']}
        self.assertIn('tier_unavailable', reasons['codex-personal'])
        self.assertIn('cost_class_exceeded', reasons['claude'])

    def test_fresh_quality_and_latency_signals_rank_eligible_executors(self):
        slots = {l: {'target': 2} for l in ('codex-personal', 'claude')}
        adaptive = {'ts': 10000, 'lanes': {'codex-personal': {'empty_rate': 0.9}, 'claude': {'empty_rate': 0.1, 'yield_rate': 0.9, 'model_latency_s': 20}}}
        lanes = market.lane_view(list(slots), slots, dict.fromkeys(slots, 0), dict.fromkeys(slots, 2), set(), {}, {}, [], adaptive, 10000)
        result, _ = self.choose(lanes=lanes)
        self.assertEqual(result['chosen_lane'], 'claude')
        self.assertEqual(result['ranking_inputs']['claude']['latency_s'], 20)
        stale = market.lane_view(list(slots), slots, dict.fromkeys(slots, 0), dict.fromkeys(slots, 2), set(), {}, {}, [], adaptive, 10400)
        self.assertIsNone(stale['claude']['empty_rate'])

    def test_budget_zero_and_model_tier_contract_exclude_an_executor(self):
        slots = {l: {'target': 2} for l in ('codex-personal', 'claude')}
        lanes = market.lane_view(list(slots), slots, dict.fromkeys(slots, 0), dict.fromkeys(slots, 2), set(), {'codex.fast': 'fixture'}, {'claude': {'remaining_pct': 0}}, [])
        result, _ = self.choose(lanes=lanes)
        self.assertIsNone(result['chosen_lane'])
        reasons = {r['lane']: r['reason_codes'] for r in result['rejected_lanes']}
        self.assertIn('tier_unavailable', reasons['codex-personal'])
        self.assertIn('quota_exhausted', reasons['claude'])

    def test_hard_down_evidence(self):
        # RQ-CONSTRAINT-AUDIT-1: provider-attributed (autobackoff) holds are hard-down; manual holds are not.
        for slot, expected in [({}, False), ({'held': True}, False), ({'held': True, 'held_by': 'manual'}, False),
                               ({'held': False, 'held_by': 'autobackoff'}, False), ({'quota': True}, False),
                               ({'held': True, 'held_by': 'autobackoff'}, True), ({'auth_failed': True}, True),
                               ({'quota': 0}, True), ({'quota': 0.0}, True),
                               ({'held': True, 'held_reason': 'auth_failure'}, True),
                               ({'held': True, 'held_reason': 'credits exhausted (RQ-X 2026-11-16)'}, True),
                               ({'held': False, 'held_reason': 'credits exhausted'}, False)]:
            self.assertIs(market.hard_down(slot), expected, slot)
        # The operator HOLD list wins over provider backoff evidence; explicit auth/quota evidence still counts.
        self.assertIs(market.hard_down({'held': True, 'held_by': 'autobackoff'}, True), False)
        self.assertIs(market.hard_down({'held': True, 'held_reason': 'credits exhausted'}, True), False)
        self.assertIs(market.hard_down({'quota': 0}, True), True)

    def test_autobackoff_hold_releases_residency_but_not_move_cap_or_launch(self):
        record = {'pool': 'codex-personal', 'decided_at': 9999, 'moves': []}
        lanes = view(**{'codex-personal': {'held': True, 'held_by': 'autobackoff'}})
        result, moved = self.choose(lanes=lanes, record=record)
        self.assertEqual(result['chosen_lane'], 'claude')
        self.assertIn('hard_down', result['reason_codes'])
        self.assertEqual(moved['moves'], [10000])
        for extra, reason in [({'moves': [9900, 9950]}, 'move_cap'), ({'launched': True}, 'launched')]:
            result, _ = self.choose(lanes=lanes, record={**record, **extra})
            self.assertIsNone(result['chosen_lane'])
            self.assertIn('hysteresis_' + reason, result['reason_codes'])
        manual = view(**{'codex-personal': {'held': True, 'held_by': 'manual'}})
        result, _ = self.choose(lanes=manual, record=record)
        self.assertIsNone(result['chosen_lane'])
        self.assertIn('hysteresis_minimum_residency', result['reason_codes'])

    def test_hysteresis_hard_down_move_cap_and_launch_fence(self):
        record = {'pool': 'codex-personal', 'decided_at': 9999, 'moves': []}
        lanes = view(); lanes['codex-personal']['running'] = 2
        result, _ = self.choose(lanes=lanes, record=record)
        self.assertIsNone(result['chosen_lane'])
        self.assertIn('hysteresis_minimum_residency', result['reason_codes'])
        self.assertEqual(self.choose(lanes=lanes, record=record, now=14000)[0]['chosen_lane'], 'claude')
        lanes['codex-personal']['auth_failed'] = True
        result, moved = self.choose(lanes=lanes, record=record)
        self.assertEqual(result['chosen_lane'], 'claude')
        self.assertEqual(moved['moves'], [10000])
        for extra, reason in [({'moves': [9900, 9950]}, 'move_cap'), ({'launched': True}, 'launched')]:
            result, _ = self.choose(lanes=lanes, record={**record, **extra})
            self.assertIsNone(result['chosen_lane'])
            self.assertIn('hysteresis_' + reason, result['reason_codes'])
        first, _ = decide(None, 'claude', 1, launched=True)
        self.assertEqual(decide(first, 'codex-personal', 9000, True)[1], 'launched')

    def test_invalid_requirements_never_become_open_work(self):
        for spec in ({'needs': 'git'}, {'needs': ['secrets:bad=value']}, {'exclusive': 'true'}, {'min_tier': 'standard'}, {'impact': float('nan')}, {'max_cost_class': 'unknown'}, {'surprise': True}):
            with self.assertRaises((ValueError, TypeError)):
                market.requirements(['j', 'r', '', 'work', 'p', json.dumps(spec)])

    def test_tier_ceiling_and_invalid_new_requirements(self):
        row = lambda tier, spec: market.requirements(['j', 'phantom', '', tier, 'p', json.dumps(spec)])
        for spec in ({'max_tier': 'standard'}, {'min_tier': 'frontier', 'max_tier': 'work'}, {'data_class': 'secret'},
                     {'work_class': 'huge'}, {'repo': 'other'}, {'repo': '../x'}):
            with self.assertRaises(ValueError): row('work', spec)
        self.assertEqual(row('work', {})['repo'], 'phantom')
        self.assertEqual(row('work', {'repo': 'phantom', 'max_tier': 'work'})['max_tier'], 'work')
        # A row asking for more than its own ceiling is never runnable anywhere.
        result, _ = market.choose('j', row('frontier', {'max_tier': 'work'}), 'frontier', view(), None, 10000, decide)
        self.assertIsNone(result['chosen_lane'])
        self.assertTrue(all('tier_ceiling_exceeded' in r['reason_codes'] for r in result['rejected_lanes']))
        spec = market.from_envelope('P1, repo=phantom, tier=mid, max_tier=work, data_class=internal, work_class=bulk')
        self.assertEqual((spec['max_tier'], spec['data_class'], spec['work_class']), ('work', 'internal', 'bulk'))

    def test_data_class_clearance_fails_closed(self):
        self.assertEqual(self.choose({'data_class': 'internal'})[0]['chosen_lane'], 'codex-personal')
        result, _ = self.choose({'data_class': 'confidential'})
        self.assertIsNone(result['chosen_lane'])
        self.assertTrue(all('data_class_exceeded' in r['reason_codes'] for r in result['rejected_lanes']))
        cleared = view(claude={'data_class': 'restricted'})
        self.assertEqual(self.choose({'data_class': 'confidential'}, cleared)[0]['chosen_lane'], 'claude')
        # Garbage clearance and executors without one handle public data only.
        garbage = view(claude={'data_class': ['restricted']}, **{'codex-personal': {'data_class': 'top'}})
        self.assertIsNone(self.choose({'data_class': 'internal'}, garbage)[0]['chosen_lane'])
        self.assertEqual(self.choose({'data_class': 'public'}, garbage)[0]['chosen_lane'], 'codex-personal')
        slots = {'cursor': {'target': 1, 'capabilities': ['git'], 'tiers': ['work'], 'cost_class': 'included'}}
        unknown = market.lane_view(['cursor'], slots, {'cursor': 0}, {'cursor': 1}, set(), {}, {}, [])
        self.assertEqual(unknown['cursor']['data_class'], 'public')

    def test_repo_allowlist_limits_an_executor(self):
        lanes = view(**{'codex-personal': {'repos': ['locus']}})
        result, _ = self.choose({'preferred_lane': 'codex-personal'}, lanes)
        self.assertEqual(result['chosen_lane'], 'claude')
        self.assertEqual(result['override']['preferred_lane_blocked_by'], ['repo_unserved'])
        self.assertEqual(self.choose({'preferred_lane': 'codex-personal'}, view(**{'codex-personal': {'repos': ['phantom']}}))[0]['chosen_lane'], 'codex-personal')
        self.assertEqual(view(claude={'repos': 'phantom'})['claude']['repos'], set())

    def posture_view(self, running=None, **overrides):
        slots = {lane: {'target': 2, **overrides.get(lane, {})} for lane in ('codex-cmp', 'codex-personal', 'claude')}
        return market.lane_view(list(slots), slots, {**dict.fromkeys(slots, 0), **(running or {})}, dict.fromkeys(slots, 2), set(), {}, {}, [], None, 10000)

    def pick(self, tier, spec, lanes):
        return market.choose('j', market.requirements(['j', 'phantom', '', tier, 'p', json.dumps(spec)]), tier, lanes, None, 10000, decide)[0]

    def test_resource_posture_outranks_the_lane_hint(self):
        lanes = self.posture_view()
        self.assertEqual([lanes[l]['posture'] for l in lanes], ['burn', 'preserve', 'preserve'])
        # Bulk and standard work hinted at a preserved window goes to the burnable one, with the reason recorded.
        for tier in ('mid', 'work'):
            result = self.pick(tier, {'preferred_lane': 'codex-personal'}, lanes)
            self.assertEqual(result['chosen_lane'], 'codex-cmp')
            self.assertEqual(result['override'], {'from': 'codex-personal', 'to': 'codex-cmp', 'reason': 'resource_fit', 'preferred_lane_blocked_by': []})
            self.assertIn('resource_fit', result['reason_codes'])
        # Judgment work (frontier tier, P0, or declared) keeps the preserved window, hint first.
        self.assertEqual(self.pick('frontier', {'preferred_lane': 'claude'}, lanes)['chosen_lane'], 'claude')
        self.assertEqual(self.pick('frontier', {'preferred_lane': 'codex-cmp'}, lanes)['chosen_lane'], 'codex-personal')
        self.assertEqual(self.pick('work', {'priority': 'P0'}, lanes)['chosen_lane'], 'codex-personal')
        self.assertEqual(self.pick('work', {'work_class': 'judgment', 'preferred_lane': 'claude'}, lanes)['work_class'], 'judgment')
        self.assertEqual(self.pick('frontier', {'work_class': 'bulk'}, lanes)['chosen_lane'], 'codex-cmp')

    def test_idle_preserved_lane_is_fed_when_the_burnable_one_is_full(self):
        lanes = self.posture_view(running={'codex-cmp': 2})
        result = self.pick('mid', {'preferred_lane': 'codex-cmp'}, lanes)
        self.assertEqual(result['chosen_lane'], 'codex-personal')
        self.assertEqual(result['override']['reason'], 'preferred_lane_fallback')
        self.assertEqual(result['override']['preferred_lane_blocked_by'], ['saturated'])
        self.assertIsNone(self.pick('mid', {}, lanes)['override'])

    def test_posture_is_host_owned_and_never_grants_eligibility(self):
        lanes = self.posture_view(**{'codex-personal': {'posture': 'burn'}, 'codex-cmp': {'posture': 'nonsense'}})
        self.assertEqual((lanes['codex-personal']['posture'], lanes['codex-cmp']['posture']), ('burn', 'burn'))
        # A free window reads as burn until it ends; afterwards the declared or default posture returns.
        for until, expected in (('2099-01-01', 'burn'), (20000, 'burn'), (9999, 'preserve'), ('garbage', 'preserve'), (True, 'preserve')):
            self.assertEqual(self.posture_view(claude={'free_until': until})['claude']['posture'], expected)
        self.assertEqual(market.posture('claude', {'free_until': '2099-01-01'}), 'preserve')
        # Burn posture never overrides cost class, holds or quota.
        metered = self.posture_view(**{'codex-cmp': {'cost_class': 'metered'}})
        self.assertEqual(self.pick('mid', {'max_cost_class': 'included'}, metered)['chosen_lane'], 'codex-personal')
        held = self.posture_view(**{'codex-cmp': {'held': True}})
        self.assertEqual(self.pick('mid', {}, held)['chosen_lane'], 'codex-personal')

    def test_unfed_capacity_counts_headroom_while_rows_wait_elsewhere(self):
        lanes = {'codex-cmp': {'running': 1, 'target': 4, 'held': False}, 'codex-personal': {'running': 2, 'target': 2, 'held': False},
                 'devin': {'running': 0, 'target': 3, 'held': True}, 'claude': {'running': 0, 'target': 0, 'held': False}}
        waiting = [('codex-personal', {'codex-cmp': ['missing_capability'], 'codex-personal': ['saturated']}),
                   ('codex-personal', {}), (None, None), ('codex-cmp', {'codex-cmp': ['provider_backoff']})]
        report = market.unfed_capacity(lanes, waiting)
        self.assertEqual((report['schema'], report['event'], report['waiting']), ('work-market.v1', 'unfed_capacity', 4))
        self.assertEqual(report['unfed_lanes'], ['codex-cmp'])
        self.assertEqual(report['unfed_slots'], 3)
        cmp = report['lanes']['codex-cmp']
        self.assertEqual((cmp['headroom'], cmp['waiting_elsewhere'], cmp['utilization']), (3, 3, 0.25))
        self.assertEqual(cmp['blocked'], {'missing_capability': 1, 'deferred_after_selection': 1, 'not_evaluated': 1})
        # Full, held and zero-target lanes are never unfed.
        for lane in ('codex-personal', 'devin', 'claude'):
            self.assertFalse(report['lanes'][lane]['unfed'])
        self.assertIsNone(report['lanes']['claude']['utilization'])
        stopped = market.unfed_capacity(lanes, waiting, 'admission_stopped')
        self.assertEqual(stopped['lanes']['codex-cmp']['blocked'], {'admission_stopped': 3})
        self.assertEqual(market.unfed_capacity(lanes, [])['unfed_lanes'], [])
        self.assertNotIn('RQ-', json.dumps(report))

    def test_priority_precedes_impact_and_noise(self):
        specs = [{'priority': 'P2', 'impact': 999}, {'priority': 'P0', 'impact': 1}, {'priority': 'P0', 'impact': 9}]
        self.assertEqual(sorted(specs, key=market.priority), [specs[2], specs[1], specs[0]])


class MarketTick(unittest.TestCase):
    def test_weekly_provenance_and_real_tick_match_shared_receipt(self):
        home, q = self.fixture({'devin': 1})
        root = self.devin_accounting(home)
        fixtures = MAC / 'tests/fixtures/posture-provenance'
        weekly = json.loads((fixtures / 'weekly-capacity.json').read_text())
        (root / 'config.json').write_text(json.dumps({'devin': {'weeklyAcuAllowance': 50, 'weeklyResetAt': weekly['reset_at']}}))
        path = root / 'devin/weekly-capacity.json'
        path.write_text(json.dumps(weekly))
        expected = {k: weekly[k] for k in ('account_id', 'model', 'window_start', 'reset_at')}
        self.assertEqual(market.read_devin_allowance(home)['provenance'], expected)
        wrapper = home / 'fixed_tick.py'
        wrapper.write_text('import time, runpy\ntime.time = lambda: 1794916800.0\nrunpy.run_path(' + repr(str(MAC / 'dispatchd.py')) + ', run_name="__main__")\n')
        result = tick(home, script=wrapper)
        self.assertEqual(result.returncode, 0, result.stderr)
        emitted = next(r for r in self.rows(home) if r['event'] == 'posture')
        committed = json.loads((fixtures / 'work-market-posture.json').read_text())
        self.assertEqual(emitted['lanes']['devin'], committed['lanes']['devin'])
        for invalid in ('name@example.com', '', '-invalid', 42):
            path.write_text(json.dumps(dict(weekly, account_id=invalid, model=invalid)))
            provenance = market.read_devin_allowance(home)['provenance']
            self.assertEqual(provenance, {k: expected[k] for k in ('window_start', 'reset_at')})
        for patch, missing in [({'source': 'other'}, set(expected)), ({'window_start': '2099-01-01'}, {'window_start'}),
                               ({'window_start': 'invalid'}, {'window_start'}), ({'reset_at': '2026-11-17T14:00:00Z'}, {'reset_at'})]:
            path.write_text(json.dumps(dict(weekly, **patch)))
            provenance = market.read_devin_allowance(home)['provenance']
            self.assertEqual(provenance, {k: v for k, v in expected.items() if k not in missing})

    def fixture(self, targets=None):
        slots = held_lanes()
        for lane, target in (targets or {'codex-personal': 1, 'claude': 1}).items():
            slots[lane] = {'target': target, 'floor': 0, 'ceiling': target, 'hard_cap': target, 'last_change': int(1e15)}
        tmp = build(slots=slots); self.addCleanup(tmp.cleanup)
        home = Path(tmp.name).resolve(); launch_stubs(home)
        return home, home / '.ashlr-runs/queue'

    def add(self, home, job, lane='', **spec):
        queue_job(home, job, lane, size=20)
        q = home / '.ashlr-runs/queue'
        rows = (q / 'ready.tsv').read_text().splitlines()
        rows[-1] += '\t' + json.dumps(spec)
        (q / 'ready.tsv').write_text('\n'.join(rows) + '\n')

    def rows(self, home):
        return [json.loads(row) for row in (home / '.ashlr-runs/metrics/work-market.jsonl').read_text().splitlines()]

    def run_tick(self, home):
        result = tick(home)
        self.assertEqual(result.returncode, 0, result.stderr)

    def devin_accounting(self, home, used=20):
        now = time.time()
        root = home / '.ashlr'
        (root / 'devin/tasks').mkdir(parents=True)
        (root / 'config.json').write_text(json.dumps({'devin': {
            'weeklyAcuAllowance': 50, 'weeklyResetAt': now + 3600}}))
        (root / 'devin/budget.json').write_text(json.dumps({
            'acuBudgetTotal': 40, 'reserveAcu': 10, 'maxAcuPerSession': 10}))
        (root / 'devin/weekly-capacity.json').write_text(json.dumps({
            'used': used, 'reset_at': now + 3600, 'observed_at': now, 'state': 'live',
            'source': 'devin-api-v3-sessions', 'burn_rate_per_hour': 0}))
        (home / '.ashlr-runs/models.json').write_text('{"devin":"swe-2-high"}')
        return root

    def test_devin_reader_uses_budget_fallback_and_keeps_missing_usage_null(self):
        home, q = self.fixture({'devin': 3})
        root = self.devin_accounting(home, used=None)
        section = json.loads((root / 'config.json').read_text())
        section['devin'].pop('weeklyAcuAllowance')
        (root / 'config.json').write_text(json.dumps(section))
        reading = market.read_devin_allowance(home)
        self.assertIsNone(reading['used'])
        self.assertEqual((reading['limit'], reading['in_flight']), (40, 0))
        (root / 'devin/tasks/session.json').write_text(json.dumps({
            'maxAcu': 10, 'sessionId': 'session', 'state': 'closed', 'session': {'status': 'suspended'}}))
        self.assertEqual(market.read_devin_allowance(home)['in_flight'], 10)
        (root / 'devin/tasks/broken.json').write_text('{')
        self.assertIsNone(market.read_devin_allowance(home)['in_flight'])
        (root / 'config.json').write_text('{}')
        self.assertIsNone(market.read_devin_allowance(home)['reset_at'])

    def test_devin_reserves_every_claim_before_the_next_cost_decision(self):
        home, q = self.fixture({'devin': 3})
        self.devin_accounting(home, used=30)
        for i in range(2):
            self.add(home, f'RQ-ALLOWANCE-{i}', lane='devin', max_cost_class='included')
        self.run_tick(home)
        routes = [r for r in self.rows(home) if r['event'] == 'route_decision']
        self.assertEqual([r['chosen_lane'] for r in routes], ['devin', None])
        first, second = [r['ranking_inputs']['devin'] for r in routes]
        self.assertEqual((first['cost_class'], first['posture']), ('included', 'burn'))
        self.assertEqual((second['cost_class'], second['posture']), ('metered', 'balanced'))
        self.assertEqual(second['cost_class_reason'], 'devin_allowance_headroom')
        self.assertEqual(second['allowance']['in_flight'], 10)
        self.assertEqual(sum(dispatched(home, f'RQ-ALLOWANCE-{i}') for i in range(2)), 1)
        snapshot = next(r for r in self.rows(home) if r['event'] == 'posture')['lanes']['devin']
        self.assertEqual(snapshot['cost_class_reason'], 'devin_within_allowance')

    def test_devin_reader_uses_relocated_inventory_and_waits_for_settled_usage(self):
        home, q = self.fixture({'devin': 1})
        root = self.devin_accounting(home)
        relocated = home / 'relocated'
        relocated.mkdir()
        (root / 'devin').rename(relocated / 'devin')
        observed = json.loads((relocated / 'devin/weekly-capacity.json').read_text())['observed_at']
        task = relocated / 'devin/tasks/session.json'
        row = {'maxAcu': 10, 'sessionId': 'session', 'state': 'closed',
               'session': {'status': 'exit', 'readAt': observed + 1}}
        task.write_text(json.dumps(row))
        reading = market.read_devin_allowance(home, str(relocated))
        self.assertEqual((reading['limit'], reading['in_flight']), (50, 10))
        row['session']['readAt'] = observed - 1
        task.write_text(json.dumps(row))
        self.assertEqual(market.read_devin_allowance(home, str(relocated))['in_flight'], 0)
        config = json.loads((root / 'config.json').read_text())
        # weeklyResetAt is a recurring anchor, as in the TypeScript weekly reader.
        config['devin']['weeklyResetAt'] -= 604800
        (root / 'config.json').write_text(json.dumps(config))
        self.assertIsNotNone(market.read_devin_allowance(home, str(relocated))['reset_at'])
        config['devin']['weeklyResetAt'] += 100
        (root / 'config.json').write_text(json.dumps(config))
        self.assertIsNone(market.read_devin_allowance(home, str(relocated))['reset_at'])

    def test_devin_metered_cannot_be_promoted_by_waste_risk(self):
        home, q = self.fixture({'devin': 1})
        self.devin_accounting(home, used=None)
        (home / '.ashlr-runs/bin/use-it-all.py').write_text(
            'import json, time\nprint(json.dumps({"schema":"use-it-all.v1", "ts":int(time.time()),'
            '"lanes":{"devin":{"known":True,"stale":False,"waste_risk":"high","behind":True}}}))\n')
        self.add(home, 'RQ-UNKNOWN-USAGE', lane='devin', max_cost_class='included')
        self.run_tick(home)
        route = next(r for r in self.rows(home) if r['event'] == 'route_decision')
        self.assertIsNone(route['chosen_lane'])
        self.assertEqual(route['ranking_inputs']['devin']['posture'], 'balanced')
        self.assertEqual(route['ranking_inputs']['devin']['cost_class_reason'], 'devin_usage_unknown')

    def test_devin_preview_cost_uses_the_actual_job_tier_model(self):
        home, q = self.fixture({'devin': 1})
        self.devin_accounting(home, used=None)
        (home / '.ashlr-runs/models.json').write_text('{"devin":"swe-2-flash","devin.work":"swe-2-high"}')
        self.add(home, 'RQ-PAID-TIER', lane='devin', max_cost_class='included')
        self.run_tick(home)
        route = next(r for r in self.rows(home) if r['event'] == 'route_decision')
        self.assertIsNone(route['chosen_lane'])
        self.assertFalse(route['ranking_inputs']['devin']['zero_cost'])

    def test_measured_allowance_changes_tick_posture_and_receipt(self):
        home, q = self.fixture()
        now = time.time()
        (q / 'budget-overrides.json').write_text(json.dumps({'claude': {
            'weekly_used_pct': 20, 'burn_pct_per_hour': 1, 'reset_at': now + 3600, 'as_of': now}}))
        self.add(home, 'RQ-SPEND-DOWN', lane='codex-personal', preferred_lane='codex-personal')
        self.run_tick(home)
        rows = self.rows(home)
        snapshot = next(r for r in rows if r['event'] == 'posture')['lanes']['claude']
        self.assertEqual(snapshot['posture'], 'burn')
        self.assertEqual(snapshot['posture_reason'], 'spend_down_projected_unused')
        self.assertGreater(snapshot['projected_unused_pct'], 78)
        route = next(r for r in rows if r['event'] == 'route_decision')
        self.assertEqual(route['chosen_lane'], 'claude')
        self.assertEqual(route['ranking_inputs']['claude']['posture_reason'], 'spend_down_projected_unused')

    def test_no_lane_and_saturated_preference_use_both_executors(self):
        home, q = self.fixture()
        self.add(home, 'RQ-MARKET-A', needs=['git', 'node'])
        self.add(home, 'RQ-MARKET-B', lane='codex-personal', preferred_lane='codex-personal')
        self.run_tick(home)
        rows = self.rows(home)
        self.assertEqual([r['chosen_lane'] for r in rows], ['codex-personal', 'claude'])
        self.assertIn('preferred_lane_fallback', rows[1]['reason_codes'])
        for job, lane in [('RQ-MARKET-A', 'codex-personal'), ('RQ-MARKET-B', 'claude')]:
            self.assertTrue(dispatched(home, job))
            state = json.loads((q / 'route-state.json').read_text())[job]
            self.assertEqual(state['pool'], lane)
            self.assertTrue(state['launched'])
        self.assertEqual((q / 'ready.tsv').read_text(), '')
        self.run_tick(home)
        self.assertEqual(len(self.rows(home)), 2)

    def test_legacy_lane_still_launches_and_unknown_lane_is_a_hint(self):
        home, q = self.fixture()
        queue_job(home, 'RQ-LEGACY', 'codex-personal', size=20)
        queue_job(home, 'RQ-UNKNOWN', 'retired-lane', size=20)
        self.run_tick(home)
        self.assertEqual([r['chosen_lane'] for r in self.rows(home)], ['codex-personal', 'claude'])
        self.assertTrue(dispatched(home, 'RQ-LEGACY'))
        self.assertTrue(dispatched(home, 'RQ-UNKNOWN'))

    def test_priority_runs_before_rebase_noise_and_blocked_capability(self):
        home, q = self.fixture({'codex-personal': 1})
        self.add(home, 'LAND-NOISE', priority='P2', impact=500)
        self.add(home, 'RQ-IMPORTANT', priority='P0', impact=10)
        self.add(home, 'RQ-BLOCKED', priority='P0', impact=20, needs=['browser'])
        self.run_tick(home)
        self.assertTrue(dispatched(home, 'RQ-IMPORTANT'))
        self.assertFalse(dispatched(home, 'LAND-NOISE'))
        self.assertFalse(dispatched(home, 'RQ-BLOCKED'))
        self.assertEqual(self.rows(home)[0]['reason_codes'], ['no_runnable_lane'])

    def test_recovered_launch_receipt_cannot_move_to_another_lane(self):
        home, q = self.fixture({'claude': 1})
        self.add(home, 'RQ-LOCKED', preferred_lane='claude')
        (q / 'run/RQ-LOCKED.line').write_text(f'RQ-LOCKED\tphantom\tcodex-personal\twork\t{q}/prompts/RQ-LOCKED.md\n')
        self.run_tick(home)
        self.assertFalse(dispatched(home, 'RQ-LOCKED'))
        self.assertIn('hysteresis_launched', self.rows(home)[0]['reason_codes'])

    def jobs(self, home):
        return [json.loads(row) for row in (home / '.ashlr-runs/metrics/jobs.jsonl').read_text().splitlines()]

    def test_idle_burnable_lane_claims_a_row_hinted_elsewhere_and_ledgers_why(self):
        home, q = self.fixture({'codex-cmp': 1, 'codex-personal': 1})
        self.add(home, 'RQ-HINTED', lane='codex-personal', preferred_lane='codex-personal')
        self.run_tick(home)
        self.assertTrue(dispatched(home, 'RQ-HINTED'))
        claim = next(r for r in self.jobs(home) if r['event'] == 'claim')
        self.assertEqual((claim['lane'], claim['lane_hint'], claim['lane_override'], claim['lane_hint_blocked_by']),
                         ('codex-cmp', 'codex-personal', 'resource_fit', []))
        self.assertEqual(self.rows(home)[0]['override']['reason'], 'resource_fit')
        self.assertIn('FLEET_REBALANCE RQ-HINTED codex-personal->codex-cmp (shared market: resource_fit)',
                      (home / '.ashlr-runs/dispatch-events.log').read_text())
        self.assertEqual(json.loads((q / 'route-state.json').read_text())['RQ-HINTED']['pool'], 'codex-cmp')

    def test_claim_on_the_hinted_lane_carries_no_override(self):
        home, q = self.fixture({'claude': 1})
        self.add(home, 'RQ-HOME', lane='claude', preferred_lane='claude')
        self.run_tick(home)
        claim = next(r for r in self.jobs(home) if r['event'] == 'claim')
        self.assertEqual(claim['lane'], 'claude')
        self.assertNotIn('lane_override', claim)
        self.assertNotIn('lane_hint', claim)

    def test_saturated_hint_overflows_once_and_never_double_claims(self):
        home, q = self.fixture({'codex-personal': 1, 'claude': 1})
        for job in ('RQ-ONE', 'RQ-TWO', 'RQ-THREE'):
            self.add(home, job, lane='codex-personal', preferred_lane='codex-personal')
        self.run_tick(home)
        claims = [r for r in self.jobs(home) if r['event'] == 'claim']
        self.assertEqual(sorted(r['lane'] for r in claims), ['claude', 'codex-personal'])
        self.assertEqual(len({r['job'] for r in claims}), 2)
        moved = next(r for r in claims if r['lane'] == 'claude')
        self.assertEqual((moved['lane_override'], moved['lane_hint_blocked_by']), ('preferred_lane_fallback', ['saturated']))
        # Both lanes are full: the third row waits and nothing is unfed.
        status = json.loads((q / 'status.json').read_text())
        self.assertEqual(status['unfed_capacity']['unfed_lanes'], [])
        self.assertEqual(status['unfed_capacity']['waiting'], 1)
        # Later ticks may launch the waiting row once a slot frees; no job is ever claimed twice.
        self.run_tick(home); self.run_tick(home)
        claimed = [r['job'] for r in self.jobs(home) if r['event'] == 'claim']
        self.assertEqual(len(claimed), len(set(claimed)))

    def test_unfed_capacity_is_reported_with_the_blocking_reason(self):
        home, q = self.fixture({'codex-cmp': 2, 'claude': 1})
        self.add(home, 'RQ-NEEDS-CLAUDE-A', lane='claude', needs=['claude-cli'])
        self.add(home, 'RQ-NEEDS-CLAUDE-B', lane='claude', needs=['claude-cli'])
        self.run_tick(home)
        unfed = json.loads((q / 'status.json').read_text())['unfed_capacity']
        self.assertEqual(unfed['unfed_lanes'], ['codex-cmp'])
        self.assertEqual(unfed['lanes']['codex-cmp']['blocked'], {'missing_capability': 1})
        self.assertEqual((unfed['lanes']['codex-cmp']['headroom'], unfed['lanes']['codex-cmp']['waiting_elsewhere']), (2, 1))
        audit = [r for r in self.rows(home) if r['event'] == 'unfed_capacity']
        self.assertEqual(len(audit), 1)
        self.assertEqual(audit[0]['unfed_slots'], 1)
        self.assertNotIn('RQ-NEEDS', json.dumps(audit[0]))

    def test_data_class_and_tier_ceiling_bind_at_dispatch(self):
        home, q = self.fixture({'codex-cmp': 2})
        self.add(home, 'RQ-CONFIDENTIAL', data_class='confidential')
        self.add(home, 'RQ-INTERNAL', data_class='internal', max_tier='work')
        self.run_tick(home)
        self.assertFalse(dispatched(home, 'RQ-CONFIDENTIAL'))
        self.assertTrue(dispatched(home, 'RQ-INTERNAL'))
        blocked = next(r for r in self.rows(home) if r.get('job') == 'RQ-CONFIDENTIAL')
        self.assertEqual(blocked['reason_codes'], ['no_runnable_lane'])
        self.assertIn('data_class_exceeded', {c for r in blocked['rejected_lanes'] for c in r['reason_codes']})

    def test_restock_carries_requirements_to_dispatch(self):
        from test_restock import restock
        home, q = self.fixture()
        (q / 'admission.json').write_text(json.dumps({'cap': 100}))
        (q / 'router-queue.md').write_text('- READY RQ-RESTOCK (P0, repo=phantom, tier=work, needs=claude-cli, max_cost_class=included, exclusive=true, impact=7): Update docs.\n')
        result = restock(home)
        self.assertEqual(result.returncode, 0, result.stderr)
        fields = (q / 'ready.tsv').read_text().strip().split('\t')
        self.assertEqual(json.loads(fields[5])['needs'], ['claude-cli'])
        self.run_tick(home)
        self.assertEqual(self.rows(home)[0]['chosen_lane'], 'claude')
        self.assertTrue(dispatched(home, 'RQ-RESTOCK'))

    def test_restock_routes_gh_repairs_to_capable_lane_through_dispatch(self):
        from test_restock import restock, line
        for job, prompt in CAPABILITY_PROMPTS['c499'].items():
            with self.subTest(job=job):
                home, q = self.fixture()
                (q / 'admission.json').write_text(json.dumps({'cap': 100}))
                (q / 'router-queue.md').write_text(line(job, pool='claude', tier='frontier', repo='phantom',
                    text=prompt.split('Task from the Ashlr router queue, verbatim:\n\n')[1].split('\n\nRules:')[0]) + '\n')
                result = restock(home)
                self.assertEqual(result.returncode, 0, result.stderr)
                fields = (q / 'ready.tsv').read_text().strip().split('\t')
                self.assertEqual(fields[2], 'codex-personal')
                self.assertEqual(json.loads(fields[5])['needs'], ['gh'])
                self.run_tick(home)
                route = next(r for r in self.rows(home) if r['event'] == 'route_decision')
                self.assertEqual(route['chosen_lane'], 'codex-personal')
                self.assertIn('missing_capability', next(r for r in route['rejected_lanes'] if r['lane'] == 'claude')['reason_codes'])
                self.assertTrue(dispatched(home, job))

    def test_restock_waits_for_gh_capacity_but_keeps_ordinary_claude_work(self):
        from test_restock import restock, line
        home, q = self.fixture({'claude': 2})
        (q / 'admission.json').write_text(json.dumps({'cap': 100}))
        (q / 'router-queue.md').write_text('\n'.join([
            line('RQ-PHX-REDWAIT', pool='claude', tier='frontier', repo='phantom', text='Run gh run view 7 --log-failed.'),
            line('RQ-PHX-ORDINARY', pool='claude', tier='frontier', repo='phantom', text='Rename a helper. Never run gh pr merge.'),
        ]) + '\n')
        result = restock(home)
        self.assertEqual(result.returncode, 0, result.stderr)
        fields = (q / 'ready.tsv').read_text().strip().split('\t')
        self.assertEqual((fields[0], fields[2], json.loads(fields[5])['needs']), ('RQ-PHX-ORDINARY', 'claude', []))
        self.assertIn('- READY RQ-PHX-REDWAIT', (q / 'router-queue.md').read_text())
        self.run_tick(home)
        self.assertTrue(dispatched(home, 'RQ-PHX-ORDINARY'))
        self.assertFalse(dispatched(home, 'RQ-PHX-REDWAIT'))

    def test_deferred_repair_keeps_requirements_when_unparked(self):
        from test_restock import restock
        home, q = self.fixture()
        (q / 'admission.json').write_text(json.dumps({'cap': 100}))
        (q / 'router-queue.md').write_text('- READY RQ-PHX-RECUTDEFER (pool=claude, tier=frontier, repo=phantom, after RQ-UPSTREAM, needs=git, max_cost_class=included): Run gh pr diff 12.\n')
        self.assertEqual(restock(home).returncode, 0)
        self.assertIn('PARKED-DEP.claude', (q / 'ready.tsv').read_text())
        (home / '.ashlr-runs/metrics/jobs.jsonl').write_text(json.dumps({'job': 'RQ-UPSTREAM', 'event': 'outcome', 'state': 'MERGED'}) + '\n')
        self.assertEqual(restock(home).returncode, 0)
        spec = json.loads((q / 'ready.tsv').read_text().strip().split('\t')[5])
        self.assertEqual(spec['needs'], ['git', 'gh'])
        self.assertEqual(spec['max_cost_class'], 'included')
        self.run_tick(home)
        self.assertTrue(dispatched(home, 'RQ-PHX-RECUTDEFER'))
        self.assertEqual(next(r for r in self.jobs(home) if r['event'] == 'claim')['lane'], 'codex-personal')

    def test_advertised_executor_joins_without_a_new_lane_constant(self):
        home, q = self.fixture({'cursor': 1})
        slots = json.loads((q / 'slots.json').read_text())
        slots['cursor'].update(executor_ready=True, capabilities=['git', 'gh', 'node', 'browser'], tiers=['work'], cost_class='included')
        (q / 'slots.json').write_text(json.dumps(slots))
        self.add(home, 'RQ-REGISTERED', needs=['browser'])
        self.run_tick(home)
        self.assertEqual(self.rows(home)[0]['chosen_lane'], 'cursor')
        self.assertTrue(dispatched(home, 'RQ-REGISTERED'))

    def test_retired_executor_receipts_do_not_block_the_rest_of_the_market(self):
        home, q = self.fixture({'claude': 1})
        (q / 'route-state.json').write_text(json.dumps({'RQ-OLD': {'pool': 'retired-executor', 'decided_at': time.time(), 'moves': [], 'launched': True}}))
        self.add(home, 'RQ-NEW', needs=['claude-cli'])
        self.run_tick(home)
        self.assertTrue(dispatched(home, 'RQ-NEW'))
        self.assertTrue(json.loads((q / 'route-state.json').read_text())['RQ-OLD']['launched'])


if __name__ == '__main__':
    unittest.main()
