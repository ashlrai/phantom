import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdUsageResourceLive } from '../src/cli/usage-resource-live.js';
import { loadSensorReport } from '../src/core/observe/read.js';
import { readLaneAllowance } from '../src/core/usage/lane-allowance.js';
import { observedRate, planBurnDown } from '../src/core/usage/resource-live/burn-down.js';
import { ACTIVE_POLL_MS, IDLE_POLL_MS, nextPollState, nextWakeMs, pollDue, readingFingerprint } from '../src/core/usage/resource-live/cadence.js';
import { ResourceLiveBusyError, readActiveLanes, runResourceLiveTick } from '../src/core/usage/resource-live/engine.js';
import { loadResourceLiveFeed, projectResourceLiveFeed } from '../src/core/usage/resource-live/feed.js';
import { EMPTY_RESET_STATE, evaluateResetRule, renderResetDecision } from '../src/core/usage/resource-live/reset-rule.js';
import {
  NEEDS_SIGNIN, type ResourceLiveObservation, type ResourceLiveSource, type ResourceLiveSources,
} from '../src/core/usage/resource-live/source-types.js';
import { defaultResourceLiveSources } from '../src/core/usage/resource-live/sources.js';
import { parseResourceLiveSidecar, resetDecisionDir, resourceLivePath } from '../src/core/usage/resource-live/store.js';
import {
  CODEX_CMP_EXPIRES_AT, RESOURCE_LIVE_ALLOWANCES, RESOURCE_LIVE_SCHEMA,
  type ResourceLiveId, type ResourceLiveReading, type ResourceLiveSidecar,
} from '../src/core/usage/resource-live/types.js';
import { presentUsageSensors } from '../src/core/usage/sensor-reading.js';
import { fleetPaceAdvice } from '../src/core/usage/sensor-pace.js';

// Monday. The weekly reset is Friday 18:00 New York, 4.4 days out.
const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const WEEKLY_RESET = '2026-11-20T23:00:00.000Z';
const HOUR = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const dirs: string[] = [];
const tmp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'resource-live-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

function reading(id: ResourceLiveId, over: Partial<ResourceLiveReading> = {}): ResourceLiveReading {
  const allowance = RESOURCE_LIVE_ALLOWANCES.find(row => row.id === id)!;
  const used = over.used === undefined ? 40 : over.used;
  const limit = over.limit === undefined ? 100 : over.limit;
  const measured = used !== null && limit !== null && limit > 0;
  return {
    id, label: allowance.label, lane: allowance.lane, class: allowance.class, verified: true, confidence: 'high', used, limit, unit: 'percent',
    used_pct: measured ? Math.round(used / limit * 1000) / 10 : null, remaining: measured ? limit - used : null,
    reset_at: WEEKLY_RESET, expires_at: allowance.expires_at, source: 'test-source', source_tier: 'official',
    observed_at: iso(NOW), stale_after: iso(NOW + 15 * 60_000), reason: null, ...over,
  };
}

function unverified(id: ResourceLiveId): ResourceLiveReading {
  return { ...reading(id), verified: false, used: null, limit: null, unit: null, used_pct: null, remaining: null, reset_at: null,
    source: null, source_tier: null, confidence: null, observed_at: null, stale_after: null, reason: 'no-supported-source' };
}

const fixed = (seen: Partial<ResourceLiveObservation> | null, tier: ResourceLiveSource['tier'] = 'official'): ResourceLiveSource => ({
  tier,
  read: (nowMs) => seen === null ? null : { used: 40, limit: 100, unit: 'percent', reset_at: WEEKLY_RESET, source: 'test-source', observed_at: iso(nowMs), ...seen },
});

describe('personal Codex resets', () => {
  it('uses the weekly budget reading and keeps the native five-hour window separate', async () => {
    const runsDir = tmp();
    mkdirSync(join(runsDir, 'queue'));
    writeFileSync(join(runsDir, 'queue', 'budget-overrides.json'), JSON.stringify({
      'codex-personal': { weekly_used_pct: 45, reset_at: WEEKLY_RESET, as_of: iso(NOW),
        source: 'reader-1 codex app-server rateLimits', estimated: false },
    }));
    const readCodex = vi.fn(async () => ({ fetchedAt: iso(NOW), pctUsed: 91, resetAt: iso(NOW + HOUR),
      windows: { '5h': { pctUsed: 91, resetAt: iso(NOW + HOUR) }, weekly: null } }));
    const sources = defaultResourceLiveSources({ runsDir, operatorHome: '/Users/op', codexPersonalHome: '/pools/personal', readCodex });
    await expect(sources['codex-personal'][0]!.read(NOW)).resolves.toBeNull();
    await expect(sources['codex-personal'][1]!.read(NOW)).resolves.toMatchObject({ used: 45, reset_at: WEEKLY_RESET });
    await expect(sources['codex-personal-5h'][0]!.read(NOW)).resolves.toMatchObject({ used: 91, reset_at: iso(NOW + HOUR) });
    expect(readCodex).toHaveBeenCalledTimes(1);
    await expect(sources['codex-personal'][1]!.read(NOW + HOUR)).resolves.toBeNull();
  });

  it('publishes the personal native bank once per poll and leaves newer or unreadable evidence intact', async () => {
    const runsDir = tmp();
    const path = join(runsDir, 'state', 'resource-evidence.json');
    const grant = { count: 1, kind: 'full', expires_at: iso(NOW + HOUR), source: 'codex-app-server' } as const;
    const readCodex = vi.fn(async () => ({ fetchedAt: iso(NOW), pctUsed: null, resetAt: null,
      resetBank: [grant] as (typeof grant)[] | null }));
    const sources = defaultResourceLiveSources({ runsDir, operatorHome: '/Users/op', codexPersonalHome: '/pools/personal', readCodex });
    const poll = (now: number) => Promise.all([
      sources['codex-personal'][0]!.read(now), sources['codex-personal-5h'][0]!.read(now),
    ]);
    await poll(NOW);
    expect(readCodex).toHaveBeenCalledExactlyOnceWith('/pools/personal');
    const observed = JSON.parse(readFileSync(path, 'utf8'));
    expect(observed).toEqual({ schema: 'resource-evidence.v1', readings: {
      'codex-personal-resets': { count: 1, observed_at: iso(NOW), grants: [grant] },
      'codex-personal-reset-status': { observed_at: iso(NOW), unknown_reason: null },
    } });
    readCodex.mockResolvedValueOnce({ fetchedAt: iso(NOW + 1000), pctUsed: null, resetAt: null, resetBank: null });
    await poll(NOW + 1000);
    readCodex.mockResolvedValueOnce({ fetchedAt: iso(NOW - 1000), pctUsed: null, resetAt: null, resetBank: [] });
    await poll(NOW + 2000);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(observed);
  });

  it('reports a fresh old-CLI diagnostic with an unknown count', async () => {
    const runsDir = tmp();
    const reason = 'codex-cli-too-old (<0.172.0)' as const;
    const sources = defaultResourceLiveSources({ runsDir, operatorHome: '/Users/op', codexPersonalHome: '/pools/personal',
      readCodex: async () => ({ fetchedAt: iso(NOW), pctUsed: null, resetAt: null, resetBank: null, resetBankUnknownReason: reason }) });
    const { sidecar } = await runResourceLiveTick({ runsDir, sources: {
      'codex-personal-5h': sources['codex-personal-5h'],
    }, nowMs: NOW });
    expect(sidecar.burn_down.banked_resets).toMatchObject({ count: null, grants: null, unknown_reason: reason });
  });

  it('proposes at most one expiring full reset for queued work before measured exhaustion', async () => {
    const runsDir = tmp();
    mkdirSync(join(runsDir, 'state'));
    mkdirSync(join(runsDir, 'queue'));
    const expires = iso(NOW + HOUR / 2), reset = iso(NOW + 3 * HOUR);
    const grant = { count: 1, kind: 'full', expires_at: expires, source: 'chatgpt-settings-usage' };
    const evidence = { schema: 'resource-evidence.v1', readings: {
      'codex-personal-resets': { observed_at: iso(NOW), count: 2, grants: [grant, { ...grant, expires_at: iso(NOW + 7 * HOUR) }] },
    } };
    const evidencePath = join(runsDir, 'state', 'resource-evidence.json');
    writeFileSync(evidencePath, JSON.stringify(evidence));
    const status = (queued: number) => writeFileSync(join(runsDir, 'queue', 'status.json'), JSON.stringify({
      schema: 'dispatchd.status.v1', last_tick: iso(NOW), lanes: { 'codex-personal': { queued } },
    }));
    const sourcesAt = (used: number) => sourcesOf({
      'codex-personal-5h': [fixed({ used, reset_at: reset, source: 'codex-app-server-5h' })],
      'codex-personal': [fixed({ used: 45, reset_at: WEEKLY_RESET, source: 'codex-budget-overrides-weekly' })],
    });
    await runResourceLiveTick({ runsDir, nowMs: NOW - HOUR, force: true, sources: sourcesAt(90) });
    status(0);
    const tick = () => runResourceLiveTick({ runsDir, nowMs: NOW, force: true, sources: sourcesAt(95) });
    expect((await tick()).sidecar.burn_down.banked_resets).toMatchObject({ count: 2, proposal: null });
    status(3);
    const { sidecar } = await tick();
    expect(sidecar.burn_down.banked_resets).toMatchObject({ count: 2, proposal: {
      action: 'use-reset-now', requires_explicit_request: true, grant, window: '5h',
      used_pct: 95, projected_exhaustion_at: iso(NOW + HOUR), queued_jobs: 3,
    } });
    expect(JSON.parse(readFileSync(evidencePath, 'utf8'))).toEqual(evidence);
    expect((await runResourceLiveTick({ runsDir, nowMs: NOW + HOUR, sources: sourcesAt(96) })).sidecar.burn_down.banked_resets)
      .toMatchObject({ count: null, proposal: null });
  });
});

function sourcesOf(map: Partial<Record<ResourceLiveId, ResourceLiveSource[]>>): ResourceLiveSources {
  return Object.fromEntries(RESOURCE_LIVE_ALLOWANCES.map(row => [row.id, map[row.id] ?? []])) as unknown as ResourceLiveSources;
}

const stored = (runsDir: string): ResourceLiveSidecar => JSON.parse(readFileSync(resourceLivePath(runsDir), 'utf8')) as ResourceLiveSidecar;
const byId = (sidecar: ResourceLiveSidecar, id: ResourceLiveId): ResourceLiveReading => sidecar.readings.find(row => row.id === id)!;

it('registers, ranks, projects and removes user-defined resources without running their adapters', async () => {
  const runsDir = tmp();
  vi.stubEnv('ASHLR_HOME', runsDir);
  const registry = join(runsDir, 'custom-resources.json');
  const base = { id: 'shell-status', name: 'Studio agents', provider: 'Example AI',
    kind: 'subscription', source: 'cli-status', unit: 'points', limit: 50, window_hours: 5 };
  const register = (resources: unknown[]) => writeFileSync(registry, JSON.stringify({ schema: 'custom-resources.v1', resources }));
  register([base, { ...base, id: 'metered', kind: 'metered', source: 'official-endpoint' },
    { ...base, id: 'local', kind: 'local', source: 'agent-check' }, { ...base, id: 'bad', command: 'not accepted' }]);
  mkdirSync(join(runsDir, 'state'));
  const evidence = (at: number, used: number) => writeFileSync(join(runsDir, 'state', 'resource-evidence.json'),
    JSON.stringify({ schema: 'resource-evidence.v1', readings: {
      'custom:shell-status': { source: 'cli-status', used, observed_at: iso(at), reset_at: iso(NOW + 5 * HOUR) },
      'custom:metered': { source: 'official-endpoint', used: 3, observed_at: iso(at) },
      'custom:local': { source: 'agent-check', used: 4, observed_at: iso(at + HOUR) },
    } }));
  const tick = (nowMs: number) => runResourceLiveTick({ runsDir, nowMs, sources: sourcesOf({}), force: true });
  evidence(NOW, 8);
  await tick(NOW);
  evidence(NOW + HOUR, 10);
  const result = await tick(NOW + HOUR);
  expect(byId(result.sidecar, 'custom:shell-status')).toMatchObject({ remaining: 40, source: 'cli-status', verified: true });
  expect(byId(result.sidecar, 'custom:local')).toMatchObject({ used: null, limit: null, verified: false });
  expect(byId(result.sidecar, 'custom:metered')).toMatchObject({ used: 3, source: 'official-endpoint' });
  expect(result.sidecar.readings.some(row => row.id === 'custom:bad')).toBe(false);
  const plans = result.sidecar.burn_down.allowances;
  expect(plans[0]).toMatchObject({ id: 'custom:shell-status', projected_unused: 32 });
  expect(plans.find(row => row.id === 'custom:metered')?.action).toBe('hold');
  const projected = await readLaneAllowance({ runsDir, nowMs: NOW + HOUR });
  expect(projected.lanes.find(row => row.lane === 'custom:shell-status')).toMatchObject({
    label: 'Studio agents', left: 40, freshness: 'live',
    resource: { provider: 'Example AI', burnPerHour: 2, projectedUnused: 32 },
  });
  const stale = await tick(NOW + HOUR + 16 * 60_000);
  expect(byId(stale.sidecar, 'custom:shell-status').used).toBeNull();
  register([{ ...base, id: 'metered', kind: 'metered', source: 'official-endpoint', metered_opt_in: true }]);
  evidence(NOW + HOUR, 10);
  const changed = await tick(NOW + HOUR);
  expect(changed.sidecar.burn_down.allowances.find(row => row.id === 'custom:metered')?.action).toBe('reserve');
  expect(changed.sidecar.readings.some(row => row.id === 'custom:shell-status')).toBe(false);
});

describe('poll cadence', () => {
  it('derives confidence for new and legacy sidecars and keeps unverified confidence null', () => {
    for (const [source_tier, confidence] of [['official', 'high'], ['own-call', 'medium'], ['visible-window', 'low'], ['operator-entry', 'low']] as const) {
      const row = { ...reading('devin'), source_tier };
      const { confidence: _old, ...legacy } = row;
      expect(parseResourceLiveSidecar({ schema: RESOURCE_LIVE_SCHEMA, readings: [legacy] }).readings[0]?.confidence).toBe(confidence);
    }
    expect(parseResourceLiveSidecar({ schema: RESOURCE_LIVE_SCHEMA, readings: [unverified('devin')] }).readings[0]?.confidence).toBeNull();
  });
  it('polls an active lane every minute and doubles to ten minutes when nothing changes', () => {
    let state = nextPollState(undefined, 'a', true, NOW);
    expect(state.interval_s).toBe(60);
    const waits: number[] = [];
    let at = NOW;
    for (let i = 0; i < 6; i += 1) {
      at = Date.parse(state.next_poll_at);
      state = nextPollState(state, 'a', true, at);
      waits.push(state.interval_s);
    }
    expect(waits).toEqual([120, 240, 480, 600, 600, 600]);
    // A changed reading returns to the active interval.
    expect(nextPollState(state, 'b', true, at).interval_s).toBe(ACTIVE_POLL_MS / 1000);
  });

  it('waits ten minutes on an idle lane and reads within a minute once it becomes active', () => {
    const idle = nextPollState(undefined, 'a', false, NOW);
    expect(idle.interval_s).toBe(IDLE_POLL_MS / 1000);
    expect(pollDue(idle, false, NOW + 5 * 60_000)).toBe(false);
    expect(pollDue(idle, true, NOW + 30_000)).toBe(false);
    expect(pollDue(idle, true, NOW + 61_000)).toBe(true);
    expect(pollDue(idle, false, NOW + IDLE_POLL_MS)).toBe(true);
  });

  it('polls when there is no state, the state is malformed, or the clock moved back', () => {
    expect(pollDue(undefined, false, NOW)).toBe(true);
    expect(pollDue({ ...nextPollState(undefined, 'a', false, NOW), next_poll_at: 'nope' }, false, NOW)).toBe(true);
    expect(pollDue(nextPollState(undefined, 'a', false, NOW), false, NOW - HOUR)).toBe(true);
  });

  it('wakes at the earliest next poll and never in the past', () => {
    const soon = nextPollState(undefined, 'a', true, NOW);
    const late = nextPollState(undefined, 'a', false, NOW);
    expect(nextWakeMs([late, soon, undefined], NOW)).toBe(NOW + ACTIVE_POLL_MS);
    expect(nextWakeMs([soon], NOW + HOUR)).toBe(NOW + HOUR + 1000);
  });

  it('fingerprints an unverified reading as one value', () => {
    expect(readingFingerprint(unverified('dot'))).toBe('unverified');
    expect(readingFingerprint(reading('devin'))).not.toBe(readingFingerprint(reading('devin', { used: 41 })));
  });
});

describe('burn-down plan', () => {
  it('sets target rate to remaining over time to reset', () => {
    const plan = planBurnDown([reading('codex-personal', { used: 40, reset_at: iso(NOW + 30 * HOUR) })], {}, NOW);
    const row = plan.allowances[0]!;
    expect(row).toMatchObject({ action: 'burn', remaining: 60, hours_to_deadline: 30, target_rate_per_hour: 2, pace: 'unknown' });
  });

  it('measures pace against the target from samples in the same window', () => {
    const reset = iso(NOW + 30 * HOUR);
    const history = { 'codex-personal': [
      { observed_at: iso(NOW - 2 * HOUR), used: 38, reset_at: reset },
      { observed_at: iso(NOW), used: 40, reset_at: reset },
      { observed_at: iso(NOW - 3 * HOUR), used: 90, reset_at: iso(NOW - HOUR) },
    ] };
    const row = planBurnDown([reading('codex-personal', { used: 40, reset_at: reset })], history, NOW).allowances[0]!;
    // 1 %/h observed against a 2 %/h target leaves half of the 60 unspent.
    expect(row).toMatchObject({ observed_rate_per_hour: 1, pace: 'behind', projected_unused: 30 });
    expect(observedRate(history['codex-personal'], iso(NOW - HOUR))).toBeNull();
    expect(observedRate([{ observed_at: iso(NOW - HOUR), used: 5, reset_at: null }, { observed_at: iso(NOW), used: 3, reset_at: null }], null)).toBeNull();
  });

  it('spends free and expiring first, included next, metered credit after, reserve last', () => {
    const plan = planBurnDown([
      reading('grok'), reading('cursor'), reading('claude-api', { unit: 'usd', used: 10, limit: 50, remaining: 40 }),
      reading('claude-weekly'), reading('codex-cmp'), reading('devin-flash'), reading('dot'),
      reading('local', { used: null, limit: 3, unit: 'models', used_pct: null, remaining: null, reset_at: null }),
    ], {}, NOW);
    expect(plan.lane_order).toEqual(['codex-local', 'codex-cmp', 'devin-flash', 'dot', 'claude', 'claude-api', 'grok', 'cursor']);
    expect(plan.allowances.map(row => row.tier)).toEqual([0, 0, 0, 0, 1, 2, 3, 3]);
    expect(plan.allowances.map(row => row.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(plan.allowances.filter(row => row.tier === 3).every(row => row.action === 'reserve')).toBe(true);
  });

  it('uses the expiry as the deadline when it comes before the reset, and drops the priority once expired', () => {
    const before = planBurnDown([reading('codex-cmp', { reset_at: '2026-12-05T00:00:00.000Z' })], {}, NOW).allowances[0]!;
    expect(before).toMatchObject({ tier: 0, deadline_at: CODEX_CMP_EXPIRES_AT });
    const after = Date.parse(CODEX_CMP_EXPIRES_AT) + HOUR;
    const expired = planBurnDown([reading('codex-cmp', { reset_at: '2026-12-05T00:00:00.000Z', observed_at: iso(after), stale_after: iso(after + HOUR) })], {}, after).allowances[0]!;
    expect(expired).toMatchObject({ tier: 1, deadline_at: '2026-12-05T00:00:00.000Z' });
  });

  it('orders included allowances by the share that must be spent per hour', () => {
    const plan = planBurnDown([
      reading('codex-personal', { used: 90, reset_at: iso(NOW + 100 * HOUR) }),
      reading('devin', { used: 10, reset_at: iso(NOW + 10 * HOUR) }),
    ], {}, NOW);
    expect(plan.allowances.map(row => row.id)).toEqual(['devin', 'codex-personal']);
  });

  it('leaves an unverified or stale lane on its existing rules instead of holding it', () => {
    const stale = reading('devin', { observed_at: iso(NOW - HOUR), stale_after: iso(NOW - 45 * 60_000) });
    const plan = planBurnDown([unverified('gemini'), stale], {}, NOW);
    expect(plan.allowances.map(row => row.action)).toEqual(['steady', 'steady']);
    expect(plan.allowances.every(row => row.target_rate_per_hour === null)).toBe(true);
    expect(plan.lane_order).toEqual(['gemini', 'devin']);
  });

  it('holds a spent allowance and holds the metered lane when its credit is spent or unverified', () => {
    const spent = planBurnDown([reading('devin', { used: 100 }), reading('claude-api', { unit: 'usd', used: 50, limit: 50, remaining: 0 })], {}, NOW);
    expect(spent.allowances.map(row => row.action)).toEqual(['hold', 'hold']);
    expect(spent.lane_order).toEqual([]);
    const unknown = planBurnDown([unverified('claude-api')], {}, NOW);
    expect(unknown.allowances[0]).toMatchObject({ action: 'hold', tier: 2 });
    expect(unknown.lane_order).toEqual([]);
  });

  it('keeps the Claude lane out of the order when the weekly allowance is spent, even with Fable share left', () => {
    const plan = planBurnDown([reading('claude-weekly', { used: 100 }), reading('claude-fable', { used: 5, limit: 20 })], {}, NOW);
    expect(plan.lane_order).toEqual([]);
  });
});

describe('reset rule', () => {
  const weekly = (pct: number, over: Partial<ResourceLiveReading> = {}): ResourceLiveReading => reading('claude-weekly', { used: pct, ...over });
  const fable = (pct: number): ResourceLiveReading => reading('claude-fable', { used: pct / 5, limit: 20 });

  it('drafts a Fable reset at 95% of its share with more than 24 h left', () => {
    const result = evaluateResetRule(weekly(60), fable(95), EMPTY_RESET_STATE, NOW);
    expect(result.drafts.map(draft => draft.kind)).toEqual(['fable']);
    expect(result.drafts[0]).toMatchObject({ used_pct: 95, weekly_reset_at: WEEKLY_RESET, hours_to_weekly_reset: 107 });
    expect(evaluateResetRule(weekly(60), fable(94.9), EMPTY_RESET_STATE, NOW).drafts).toEqual([]);
  });

  it('drafts a weekly reset at 95% and nothing with 24 h or less left', () => {
    expect(evaluateResetRule(weekly(95), fable(10), EMPTY_RESET_STATE, NOW).drafts.map(draft => draft.kind)).toEqual(['weekly']);
    const late = Date.parse(WEEKLY_RESET) - 24 * HOUR;
    const lateWeekly = weekly(99, { observed_at: iso(late), stale_after: iso(late + HOUR) });
    expect(evaluateResetRule(lateWeekly, undefined, EMPTY_RESET_STATE, late).drafts).toEqual([]);
  });

  it('drafts only the weekly reset when both cross 95% and are not both exhausted', () => {
    const result = evaluateResetRule(weekly(97), fable(100), EMPTY_RESET_STATE, NOW);
    expect(result.drafts.map(draft => draft.kind)).toEqual(['weekly']);
    expect(result.state.fable).toBeNull();
  });

  it('drafts both in one batch only when both are exhausted', () => {
    expect(evaluateResetRule(weekly(100), fable(100), EMPTY_RESET_STATE, NOW).drafts.map(draft => draft.kind)).toEqual(['weekly', 'fable']);
  });

  it('never drafts the other reset inside the same week unless both are exhausted', () => {
    const first = evaluateResetRule(weekly(60), fable(96), EMPTY_RESET_STATE, NOW);
    // Mason reset Fable; two days later the weekly allowance crosses 95%.
    const later = NOW + 48 * HOUR;
    const at = { observed_at: iso(later), stale_after: iso(later + HOUR) };
    expect(evaluateResetRule(weekly(96, at), { ...fable(20), ...at }, first.state, later).drafts).toEqual([]);
    const both = evaluateResetRule(weekly(100, at), { ...fable(100), ...at }, first.state, later);
    expect(both.drafts.map(draft => draft.kind)).toEqual(['weekly']);
    // Eight days on, in a new window, the week has passed.
    const next = NOW + 8 * 24 * HOUR;
    const fresh = { observed_at: iso(next), stale_after: iso(next + HOUR), reset_at: '2026-11-27T23:00:00.000Z' };
    expect(evaluateResetRule(weekly(96, fresh), undefined, first.state, next).drafts.map(draft => draft.kind)).toEqual(['weekly']);
  });

  it('drafts once per window even when the reset time drifts by minutes', () => {
    const first = evaluateResetRule(weekly(96), undefined, EMPTY_RESET_STATE, NOW);
    const drifted = weekly(97, { reset_at: '2026-11-20T23:04:00.000Z', observed_at: iso(NOW + 60_000), stale_after: iso(NOW + HOUR) });
    expect(evaluateResetRule(drifted, undefined, first.state, NOW + 60_000).drafts).toEqual([]);
  });

  it('drafts nothing from a stale, unverified or reset-less weekly reading', () => {
    const old = weekly(99, { observed_at: iso(NOW - HOUR) });
    expect(evaluateResetRule(old, fable(99), EMPTY_RESET_STATE, NOW).drafts).toEqual([]);
    expect(evaluateResetRule(unverified('claude-weekly'), fable(99), EMPTY_RESET_STATE, NOW).drafts).toEqual([]);
    expect(evaluateResetRule(weekly(99, { reset_at: null }), fable(99), EMPTY_RESET_STATE, NOW).drafts).toEqual([]);
  });

  it('renders one Mason-only draft that no agent may act on', () => {
    const { drafts } = evaluateResetRule(weekly(100), fable(100), EMPTY_RESET_STATE, NOW);
    const decision = renderResetDecision(drafts, NOW);
    expect(decision).toMatchObject({ audience: 'mason-only', status: 'draft', agent_may_act: false, id: 'resource-live-reset-20261120T230000000Z-weekly-fable' });
    expect(decision.question).toContain('Only you can click it');
    expect(JSON.stringify(decision)).not.toContain('\u2014');
  });
});

describe('resource-live tick', () => {
  it('passes measured scope through and normalizes its window', async () => {
    const runsDir = tmp();
    await runResourceLiveTick({ runsDir, nowMs: NOW, activeLanes: () => new Set(), sources: sourcesOf({
      devin: [fixed({ account_id: 'org-test', model: 'swe-2-high', window_start: iso(NOW - HOUR).replace('.000Z', '+00:00') })],
    }) });
    expect(byId(stored(runsDir), 'devin')).toMatchObject({ verified: true, account_id: 'org-test', model: 'swe-2-high', window_start: iso(NOW - HOUR) });
  });
  it('writes every allowance with source and observed time, and nulls for unverified ones', async () => {
    const runsDir = tmp();
    const result = await runResourceLiveTick({ runsDir, nowMs: NOW, activeLanes: () => new Set(), sources: sourcesOf({
      'claude-weekly': [fixed({ used: 62 })],
      devin: [fixed({ used: 120, limit: 500, unit: 'acu' })],
    }) });
    const sidecar = stored(runsDir);
    expect(sidecar.schema).toBe(RESOURCE_LIVE_SCHEMA);
    expect(sidecar.readings.map(row => row.id)).toEqual(RESOURCE_LIVE_ALLOWANCES.map(row => row.id));
    expect(byId(sidecar, 'claude-weekly')).toMatchObject({ verified: true, used_pct: 62, remaining: 38, source: 'test-source',
      source_tier: 'official', observed_at: iso(NOW), reset_at: WEEKLY_RESET });
    expect(byId(sidecar, 'devin')).toMatchObject({ used: 120, limit: 500, used_pct: 24, remaining: 380, unit: 'acu' });
    expect(byId(sidecar, 'gemini')).toEqual({ ...unverified('gemini') });
    expect(JSON.stringify(byId(sidecar, 'gemini'))).not.toContain(':0');
    expect(result.polled).toHaveLength(RESOURCE_LIVE_ALLOWANCES.length);
    expect(statSync(resourceLivePath(runsDir)).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(runsDir, 'state'))).toEqual(['resource-live-history.json', 'resource-live.json']);
  });

  it('falls through the source order and records which tier answered', async () => {
    const runsDir = tmp();
    const failing: ResourceLiveSource = { tier: 'official', read: () => { throw new Error('secret detail'); } };
    await runResourceLiveTick({ runsDir, nowMs: NOW, activeLanes: () => new Set(), sources: sourcesOf({
      'claude-weekly': [failing, fixed({ used: 50, source: 'claude-rate-limit-event' }, 'own-call'), fixed({ used: 1 }, 'visible-window')],
      'codex-personal': [fixed(null), fixed({ used: 70, source: 'browser-visible' }, 'visible-window')],
      gemini: [{ tier: 'visible-window', read: () => NEEDS_SIGNIN }],
      devin: [failing],
      grok: [fixed({ used: 30, tier: 'operator-entry', source: 'grok-ultra-manual' })],
    }) });
    const sidecar = stored(runsDir);
    expect(byId(sidecar, 'claude-weekly')).toMatchObject({ used: 50, source_tier: 'own-call', source: 'claude-rate-limit-event' });
    expect(byId(sidecar, 'codex-personal')).toMatchObject({ used: 70, source_tier: 'visible-window' });
    expect(byId(sidecar, 'gemini')).toMatchObject({ verified: false, reason: 'needs-signin' });
    expect(byId(sidecar, 'devin')).toMatchObject({ verified: false, reason: 'source-error', used: null });
    expect(byId(sidecar, 'grok').source_tier).toBe('operator-entry');
    expect(readFileSync(resourceLivePath(runsDir), 'utf8')).not.toContain('secret detail');
  });

  it('prefers a current lower-tier reading over an old official one, and keeps the old one when it is all there is', async () => {
    const runsDir = tmp();
    const old = fixed({ used: 20, observed_at: iso(NOW - 2 * HOUR), source: 'claude-usage' });
    await runResourceLiveTick({ runsDir, nowMs: NOW, activeLanes: () => new Set(), sources: sourcesOf({
      'claude-weekly': [old, fixed({ used: 33, source: 'claude-rate-limit-event' }, 'own-call')],
      'codex-personal': [old],
    }) });
    const sidecar = stored(runsDir);
    expect(byId(sidecar, 'claude-weekly')).toMatchObject({ used: 33, source_tier: 'own-call' });
    expect(byId(sidecar, 'codex-personal')).toMatchObject({ used: 20, observed_at: iso(NOW - 2 * HOUR), stale_after: iso(NOW - 2 * HOUR + 15 * 60_000) });
    // An old reading is recorded but is not a basis for pacing.
    expect(sidecar.burn_down.allowances.find(row => row.id === 'codex-personal')?.action).toBe('steady');
  });

  it('rejects readings that are impossible, from the future, or from a window that already reset', async () => {
    const runsDir = tmp();
    await runResourceLiveTick({ runsDir, nowMs: NOW, activeLanes: () => new Set(), sources: sourcesOf({
      'claude-weekly': [fixed({ used: 140 })],
      'codex-personal': [fixed({ observed_at: iso(NOW + HOUR) })],
      devin: [fixed({ reset_at: iso(NOW - HOUR) })],
      'glm-lite': [fixed({ used: -1 })],
      gemini: [fixed({ source: 'bad\nsource' })],
    }) });
    const sidecar = stored(runsDir);
    for (const id of ['claude-weekly', 'codex-personal', 'devin', 'glm-lite', 'gemini'] as const) {
      expect(byId(sidecar, id)).toMatchObject({ verified: false, reason: 'invalid-reading', used: null });
    }
  });

  it('times out a slow source without failing the pass', async () => {
    const runsDir = tmp();
    const slow: ResourceLiveSource = { tier: 'official', read: () => new Promise(() => {}) };
    await runResourceLiveTick({ runsDir, nowMs: NOW, deadlineMs: 20, activeLanes: () => new Set(), sources: sourcesOf({ devin: [slow] }) });
    expect(byId(stored(runsDir), 'devin').reason).toBe('source-timeout');
  });

  it('polls on the cadence: active lanes each minute, unchanged ones backing off, idle ones at ten minutes', async () => {
    const runsDir = tmp();
    let calls = { claude: 0, devin: 0 };
    let claudeUsed = 10;
    const sources = sourcesOf({
      'claude-weekly': [{ tier: 'official', read: (nowMs) => { calls.claude += 1; return { used: claudeUsed, limit: 100, unit: 'percent', reset_at: WEEKLY_RESET, source: 's', observed_at: iso(nowMs) }; } }],
      devin: [{ tier: 'official', read: (nowMs) => { calls.devin += 1; return { used: 5, limit: 100, unit: 'acu', reset_at: WEEKLY_RESET, source: 's', observed_at: iso(nowMs) }; } }],
    });
    const activeLanes = () => new Set(['claude']);
    const tick = (at: number) => runResourceLiveTick({ runsDir, nowMs: at, activeLanes, sources });
    const polledClaude = async (at: number): Promise<boolean> => (await tick(at)).polled.includes('claude-weekly');
    await tick(NOW);
    expect((await tick(NOW + 30_000)).polled).toEqual([]);
    claudeUsed = 11;
    expect(await polledClaude(NOW + 60_000)).toBe(true);
    // Changed at +60 s, so the next read is a minute later; unchanged there, so the wait doubles.
    expect(await polledClaude(NOW + 120_000)).toBe(true);
    expect(await polledClaude(NOW + 180_000)).toBe(false);
    expect(await polledClaude(NOW + 240_000)).toBe(true);
    expect(calls).toEqual({ claude: 4, devin: 1 });
    expect((await tick(NOW + 600_000)).polled).toContain('devin');
    const sidecar = stored(runsDir);
    expect(sidecar.poll['devin']?.interval_s).toBe(600);
    expect(Date.parse(sidecar.next_poll_at)).toBeGreaterThan(NOW + 600_000);
    // One sample per poll of the allowance.
    expect(sidecar.history['claude-weekly']?.map(sample => sample.used)).toEqual([10, 11, 11, 11, 11]);
    // --force ignores the cadence.
    expect((await runResourceLiveTick({ runsDir, nowMs: NOW + 601_000, activeLanes, sources, force: true })).polled).toHaveLength(RESOURCE_LIVE_ALLOWANCES.length);
    calls = { claude: 0, devin: 0 };
  });

  it('re-reads an allowance as soon as its window resets and never carries the old numbers across', async () => {
    const runsDir = tmp();
    const reset = iso(NOW + 5 * 60_000);
    await runResourceLiveTick({ runsDir, nowMs: NOW, activeLanes: () => new Set(), sources: sourcesOf({ devin: [fixed({ used: 90, reset_at: reset })] }) });
    const after = await runResourceLiveTick({ runsDir, nowMs: NOW + 6 * 60_000, activeLanes: () => new Set(), sources: sourcesOf({ devin: [fixed(null)] }) });
    expect(after.polled).toContain('devin');
    expect(byId(after.sidecar, 'devin')).toMatchObject({ verified: false, reason: 'window-reset', used: null });
  });

  it('gives Fable the weekly reset time and computes burn across passes', async () => {
    const runsDir = tmp();
    const at = (used: number, fableUsed: number) => sourcesOf({
      'claude-weekly': [fixed({ used })],
      'claude-fable': [fixed({ used: fableUsed, limit: 20, reset_at: null })],
    });
    await runResourceLiveTick({ runsDir, nowMs: NOW, activeLanes: () => new Set(), sources: at(40, 4), force: true });
    const second = await runResourceLiveTick({ runsDir, nowMs: NOW + HOUR, activeLanes: () => new Set(), sources: at(42, 5), force: true });
    expect(byId(second.sidecar, 'claude-fable')).toMatchObject({ reset_at: WEEKLY_RESET, used_pct: 25, remaining: 15 });
    const plan = second.sidecar.burn_down.allowances;
    expect(plan.find(row => row.id === 'claude-weekly')).toMatchObject({ observed_rate_per_hour: 2, remaining: 58 });
    expect(plan.find(row => row.id === 'claude-fable')?.observed_rate_per_hour).toBe(1);
  });

  it('writes one batched Mason-only decision when the reset rule fires, and only once', async () => {
    const runsDir = tmp();
    const sources = sourcesOf({ 'claude-weekly': [fixed({ used: 100 })], 'claude-fable': [fixed({ used: 20, limit: 20, reset_at: null })] });
    const first = await runResourceLiveTick({ runsDir, nowMs: NOW, activeLanes: () => new Set(), sources, force: true });
    expect(first.drafts.map(draft => draft.kind)).toEqual(['weekly', 'fable']);
    const files = readdirSync(resetDecisionDir(runsDir));
    expect(files).toEqual(['resource-live-reset-20261120T230000000Z-weekly-fable.json']);
    const decision = JSON.parse(readFileSync(first.decisionFile!, 'utf8')) as Record<string, unknown>;
    expect(decision).toMatchObject({ audience: 'mason-only', status: 'draft', agent_may_act: false });
    expect(statSync(first.decisionFile!).mode & 0o777).toBe(0o600);
    const second = await runResourceLiveTick({ runsDir, nowMs: NOW + 60_000, activeLanes: () => new Set(), sources, force: true });
    expect(second.drafts).toEqual([]);
    expect(second.decisionFile).toBeNull();
    expect(readdirSync(resetDecisionDir(runsDir))).toEqual(files);
    expect(stored(runsDir).reset_rule.last_decision_file).toBe(first.decisionFile);
  });

  it('writes no decision below the threshold', async () => {
    const runsDir = tmp();
    await runResourceLiveTick({ runsDir, nowMs: NOW, activeLanes: () => new Set(), sources: sourcesOf({ 'claude-weekly': [fixed({ used: 94 })] }) });
    expect(existsSync(resetDecisionDir(runsDir))).toBe(false);
  });

  it('refuses to overlap another pass, recovers a dead lock, and never touches resource-pool.json', async () => {
    const runsDir = tmp();
    mkdirSync(join(runsDir, 'state'), { recursive: true });
    const pool = join(runsDir, 'state', 'resource-pool.json');
    writeFileSync(pool, '{"owner":"eng-ops"}');
    const lock = join(runsDir, 'state', '.resource-live.lock');
    writeFileSync(lock, 'other');
    const options = { runsDir, nowMs: NOW, activeLanes: () => new Set<string>(), sources: sourcesOf({}) };
    await expect(runResourceLiveTick(options)).rejects.toBeInstanceOf(ResourceLiveBusyError);
    expect(existsSync(resourceLivePath(runsDir))).toBe(false);
    const { utimesSync } = await import('node:fs');
    const dead = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, dead, dead);
    await runResourceLiveTick(options);
    expect(existsSync(lock)).toBe(false);
    expect(readFileSync(pool, 'utf8')).toBe('{"owner":"eng-ops"}');
  });

  it('releases the lock when a pass fails', async () => {
    const runsDir = tmp();
    const boom = () => { throw new Error('status unreadable'); };
    await expect(runResourceLiveTick({ runsDir, nowMs: NOW, activeLanes: boom, sources: sourcesOf({}) })).rejects.toThrow('status unreadable');
    await runResourceLiveTick({ runsDir, nowMs: NOW, activeLanes: () => new Set(), sources: sourcesOf({}) });
  });

  it('refuses a runs dir under a Codex home and a relative one', async () => {
    await expect(runResourceLiveTick({ runsDir: '/Users/x/.codex-2/runs', sources: sourcesOf({}) })).rejects.toThrow('refused');
    await expect(runResourceLiveTick({ runsDir: 'relative', sources: sourcesOf({}) })).rejects.toThrow('refused');
  });

  it('treats a damaged sidecar as no prior state', async () => {
    const runsDir = tmp();
    mkdirSync(join(runsDir, 'state'), { recursive: true });
    writeFileSync(resourceLivePath(runsDir), '{"schema":"resource-live.v1","readings":[{"id":"devin","verified":true,"used":"lots"}],"poll":{"devin":{}}');
    const result = await runResourceLiveTick({ runsDir, nowMs: NOW, activeLanes: () => new Set(), sources: sourcesOf({}) });
    expect(result.polled).toHaveLength(RESOURCE_LIVE_ALLOWANCES.length);
    expect(parseResourceLiveSidecar({ schema: 'other', readings: [reading('devin')] }).readings).toEqual([]);
    expect(parseResourceLiveSidecar({ schema: RESOURCE_LIVE_SCHEMA, readings: [reading('devin'), reading('devin'), { id: 'nope' }] }).readings).toHaveLength(1);
  });

  it('reads active lanes from a recent dispatcher status file only', async () => {
    const runsDir = tmp();
    mkdirSync(join(runsDir, 'queue'), { recursive: true });
    const write = (tick: number) => writeFileSync(join(runsDir, 'queue', 'status.json'),
      JSON.stringify({ last_tick: iso(tick), lanes: { claude: { running: 2 }, devin: { running: 0 }, zai: {} } }));
    write(NOW - 30_000);
    expect([...await readActiveLanes(runsDir, NOW)]).toEqual(['claude']);
    write(NOW - 10 * 60_000);
    expect((await readActiveLanes(runsDir, NOW)).size).toBe(0);
    expect((await readActiveLanes(tmp(), NOW)).size).toBe(0);
  });
});

describe('default sources', () => {
  it('carries the Claude organization scope without inventing a model', async () => {
    const sources = defaultResourceLiveSources({ runsDir: tmp(), readClaudeQuota: async () => ({ ...quota(iso(NOW)), accountId: 'claude:0123456789abcdef' }) });
    const observation = await sources['claude-weekly'][0]!.read(NOW);
    expect(observation).toMatchObject({ account_id: 'claude:0123456789abcdef' });
    expect(observation).not.toHaveProperty('model');
  });
  const quota = (observedAt: string) => ({ v: 1 as const, observedAt, reason: 'ok', fresh: true,
    windows: [{ id: 'seven_day', usedPct: 71, resetAt: WEEKLY_RESET }, { id: 'seven_day_fable', usedPct: 30, resetAt: WEEKLY_RESET }] });

  it('reads the Claude weekly allowance from the CLI usage reading, then the rate-limit event', async () => {
    const sources = defaultResourceLiveSources({ runsDir: tmp(), readClaudeQuota: async () => quota(iso(NOW - 60_000)),
      readClaudeEvent: () => ({ utilization: 0.5, resetsAt: Date.parse(WEEKLY_RESET) / 1000, capturedAt: iso(NOW - 1000) }) });
    expect(sources['claude-weekly'].map(source => source.tier)).toEqual(['official', 'official', 'own-call']);
    expect(await sources['claude-weekly'][0]!.read(NOW)).toEqual({ used: 71, limit: 100, unit: 'percent', reset_at: WEEKLY_RESET,
      source: 'claude-usage', observed_at: iso(NOW - 60_000) });
    const none = defaultResourceLiveSources({ runsDir: tmp(), readClaudeQuota: async () => null, readClaudeEvent: () => null });
    expect(await none['claude-weekly'][0]!.read(NOW)).toBeNull();
    expect(await none['claude-weekly'][1]!.read(NOW)).toBeNull();
  });

  it('reads Fable as points of its share and stays unknown without an overall reading', async () => {
    const plan = { allowed: true, reason: 'ready' as const, sharePercent: 20, observedAtMs: NOW - 5000, reservePercent: 1, targetPercent: 5,
      claudeWeeklyUsedPercent: 60, fableOverallWeeklyUsedPercent: 19 };
    const sources = defaultResourceLiveSources({ runsDir: tmp(), readFable: () => plan });
    expect(await sources['claude-fable'][0]!.read(NOW)).toEqual({ used: 19, limit: 20, unit: 'percent', reset_at: null,
      source: 'fable-weekly-sensor', observed_at: iso(NOW - 5000) });
    const unknown = defaultResourceLiveSources({ runsDir: tmp(), readFable: () => ({ ...plan, fableOverallWeeklyUsedPercent: null, observedAtMs: null }) });
    expect(await unknown['claude-fable'][0]!.read(NOW)).toBeNull();
  });

  it('reads Codex only from an explicit pool home and never from ~/.codex', async () => {
    const readCodex = vi.fn(async () => ({ pctUsed: 44, resetAt: WEEKLY_RESET, fetchedAt: iso(NOW) }));
    const allowed = defaultResourceLiveSources({ runsDir: tmp(), operatorHome: '/Users/op', codexCmpHome: '/pools/cmp', readCodex });
    expect(await allowed['codex-cmp'][0]!.read(NOW)).toMatchObject({ used: 44, source: 'codex-app-server' });
    expect(await allowed['codex-personal'][0]!.read(NOW)).toBeNull();
    for (const home of ['/Users/op', '/Users/op/.codex', '/Users/op/.codex-2/x', 'relative']) {
      const refused = defaultResourceLiveSources({ runsDir: tmp(), operatorHome: '/Users/op', codexCmpHome: home, codexPersonalHome: home, readCodex });
      expect(await refused['codex-cmp'][0]!.read(NOW)).toBeNull();
      expect(await refused['codex-personal'][0]!.read(NOW)).toBeNull();
    }
    expect(readCodex).toHaveBeenCalledTimes(1);
  });

  it('reads Devin, GLM Lite and the Claude API credit through the resource registry', async () => {
    const runsDir = tmp();
    const sources = defaultResourceLiveSources({ runsDir, accountsRoot: '/accounts', resourceReaders: {
      readDevin: async () => ({ pool: 'devin', acuUsed: 100, acuLimit: 400, pctUsed: 25, resetAt: WEEKLY_RESET, source: 'devin-api-v3-org-cycle', fetchedAt: iso(NOW) }),
      readZai: async () => ({ used: 12, limit: 100, unit: 'percent', resetsAt: WEEKLY_RESET, source: 'zai-lane-resources', asOf: iso(NOW) }),
      readGrants: async () => ({ state: 'healthy', rows: [{ state: 'recorded', capturedAt: iso(NOW), remainingUsdMicros: '30000000', totalUsdMicros: '50000000', admissionCutoff: null }] }) as never,
    } });
    expect(await sources.devin[0]!.read(NOW)).toMatchObject({ used: 100, limit: 400, unit: 'acu', source: 'devin-api-v3-org-cycle' });
    expect(await sources['glm-lite'][0]!.read(NOW)).toMatchObject({ used: 12, source: 'zai-lane-resources' });
    expect(sources['glm-lite'][0]!.tier).toBe('own-call');
    expect(await sources['claude-api'][0]!.read(NOW)).toMatchObject({ used: 20, limit: 50, unit: 'usd', source: 'claude-api-grant-store' });
    expect(await defaultResourceLiveSources({ runsDir })['claude-api'][0]!.read(NOW)).toBeNull();
  });

  it('keeps separate, timestamped owner-pool observations and holds a credit past expiry', async () => {
    const runsDir = tmp();
    mkdirSync(join(runsDir, 'state'));
    const pct = { used: 35, limit: 100, observed_at: iso(NOW), reset_at: iso(NOW + 5 * HOUR) };
    const credit = { used: 40, limit: 200, observed_at: iso(NOW), reset_at: null, expires_at: iso(NOW + HOUR) };
    writeFileSync(join(runsDir, 'state/resource-evidence.json'), JSON.stringify({ schema: 'resource-evidence.v1', readings: {
      antigravity: { ...pct, window_start: iso(NOW) }, 'google-workspace': { ...pct, used: 70 }, 'openai-api': credit,
      cursor: { ...pct, observed_at: iso(NOW - HOUR) }, 'grok-bot': { ...pct, observed_at: iso(NOW + HOUR) },
    } }));
    const fetchImpl = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/api/tags') ? { models: [{}] } : { data: [] })));
    const defaults = defaultResourceLiveSources({ runsDir, fetchImpl: fetchImpl as typeof fetch });
    const sources = sourcesOf({});
    Object.assign(sources, { antigravity: defaults.antigravity, 'google-workspace': defaults['google-workspace'],
      'openai-api': defaults['openai-api'], cursor: defaults.cursor, 'grok-bot': defaults['grok-bot'],
      'lm-studio': defaults['lm-studio'], ollama: defaults.ollama });
    const { sidecar } = await runResourceLiveTick({ runsDir, sources, nowMs: NOW });
    expect(byId(sidecar, 'antigravity')).toMatchObject({ lane: 'agy', used: 35, source_tier: 'operator-entry', window_start: iso(NOW) });
    expect(byId(sidecar, 'google-workspace')).toMatchObject({ lane: null, used: 70 });
    expect(byId(sidecar, 'openai-api')).toMatchObject({ remaining: 160, expires_at: credit.expires_at, reset_at: null });
    expect(byId(sidecar, 'cursor')).toMatchObject({ used: null, verified: false });
    expect(byId(sidecar, 'grok-bot')).toMatchObject({ used: null, verified: false });
    expect(byId(sidecar, 'lm-studio')).toMatchObject({ used: null, limit: 0, unit: 'models' });
    expect(byId(sidecar, 'ollama')).toMatchObject({ used: null, limit: 1, unit: 'models' });
    expect(fetchImpl.mock.calls.map(([url]) => url).sort()).toEqual(['http://127.0.0.1:11434/api/tags', 'http://127.0.0.1:1234/v1/models']);
    expect(sidecar.burn_down.allowances.slice(0, 2).map(r => r.id)).toEqual(['openai-api', 'antigravity']);
    const expired = planBurnDown([byId(sidecar, 'openai-api')], {}, NOW + HOUR).allowances[0];
    expect(expired).toMatchObject({ action: 'hold', remaining: null });
  });

  it('marks an operator-entered Grok reading as such and ignores a stale one', async () => {
    const runway = (state: 'current' | 'stale', source: 'manual' | 'app-local') => ({ v: 1 as const, state, checkedAt: iso(NOW), targetAt: WEEKLY_RESET,
      collection: { mode: 'manual' as const, reason: 'safe-local-source-unavailable' as const },
      latest: { source, timestamp: iso(NOW - 1000), remainingPoints: 300, totalPoints: 1000 },
      burnPointsPerHour: { h1: null, h6: null, h24: null }, projectedRemainingPoints: { h1: null, h6: null, h24: null }, idealPointsPerHour: null });
    const manual = defaultResourceLiveSources({ runsDir: tmp(), readGrok: async () => runway('current', 'manual') });
    expect(await manual.grok[0]!.read(NOW)).toMatchObject({ used: 700, limit: 1000, unit: 'points', tier: 'operator-entry', source: 'grok-ultra-manual' });
    const app = defaultResourceLiveSources({ runsDir: tmp(), readGrok: async () => runway('current', 'app-local') });
    expect(await app.grok[0]!.read(NOW)).toMatchObject({ tier: 'official', source: 'grok-ultra-app' });
    const stale = defaultResourceLiveSources({ runsDir: tmp(), readGrok: async () => runway('stale', 'manual') });
    expect(await stale.grok[0]!.read(NOW)).toBeNull();
  });

  it('reads local models from loopback only and reports a count, not a usage window', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{}, {}] }))) as unknown as typeof fetch;
    const sources = defaultResourceLiveSources({ runsDir: tmp(), fetchImpl });
    expect(await sources.local[0]!.read(NOW)).toEqual({ used: null, limit: 2, unit: 'models', reset_at: null, source: 'omlx-loopback-models', observed_at: iso(NOW) });
    expect(vi.mocked(fetchImpl).mock.calls[0]![0]).toBe('http://127.0.0.1:8123/v1/models');
    const empty = defaultResourceLiveSources({ runsDir: tmp(), fetchImpl: (async () => new Response('{"data":[]}')) as unknown as typeof fetch });
    expect(await empty.local[0]!.read(NOW)).toBeNull();
  });

  it('adds the visible-window tier only when a usage browser is supplied', async () => {
    const without = defaultResourceLiveSources({ runsDir: tmp() });
    expect(without.gemini).toEqual([]);
    expect(without['claude-weekly'].some(source => source.tier === 'visible-window')).toBe(false);
    expect(without['devin-flash'].map(source => source.tier)).toEqual(['official']);
    for (const id of ['antigravity', 'dot', 'cursor'] as const) expect(without[id].map(source => source.tier)).toEqual(['operator-entry']);
    expect(without.instinct).toEqual([]);
    const page = (text: string, url?: string) => ({ newPage: async () => ({ goto: async () => {}, url: () => url ?? 'https://claude.ai/settings/usage',
      visibleText: async () => text, close: async () => {} }), close: async () => {} });
    const withBrowser = defaultResourceLiveSources({ runsDir: tmp(), browser: page('Weekly limits\nResets in 3 days\n62% used\n') });
    const visible = withBrowser['claude-weekly'].find(source => source.tier === 'visible-window')!;
    expect(await visible.read(NOW)).toMatchObject({ used: 62, limit: 100, source: 'browser-visible', reset_at: iso(NOW + 72 * HOUR) });
    const signedOut = defaultResourceLiveSources({ runsDir: tmp(), browser: page('Log in to continue', 'https://claude.ai/login') });
    expect(await signedOut['claude-weekly'].find(source => source.tier === 'visible-window')!.read(NOW)).toBe(NEEDS_SIGNIN);
  });
});

describe('feeds', () => {
  async function seeded(): Promise<string> {
    const runsDir = tmp();
    const sources = (claude: number) => sourcesOf({
      'claude-weekly': [fixed({ used: claude, source: 'claude-usage' })],
      'claude-api': [fixed({ used: 10, limit: 50, unit: 'usd', source: 'claude-api-grant-store', reset_at: null })],
      devin: [fixed({ used: 100, limit: 400, unit: 'acu', source: 'devin-api-v3-org-cycle' })],
      'glm-lite': [fixed({ used: 12, source: 'zai-lane-resources' })],
      grok: [fixed({ used: 700, limit: 1000, unit: 'points', source: 'grok-ultra-manual', tier: 'operator-entry' })],
      local: [fixed({ used: null, limit: 2, unit: 'models', source: 'omlx-loopback-models', reset_at: null })],
      'claude-fable': [fixed({ used: 5, limit: 20, source: 'fable-weekly-sensor', reset_at: null })],
    });
    await runResourceLiveTick({ runsDir, nowMs: NOW - HOUR, activeLanes: () => new Set(), sources: sources(40), force: true });
    await runResourceLiveTick({ runsDir, nowMs: NOW, activeLanes: () => new Set(), sources: sources(42), force: true });
    return runsDir;
  }

  it('projects readings onto sensor lanes in percent or ACU, with the staleness bound', async () => {
    const feed = await loadResourceLiveFeed(NOW, await seeded());
    const lanes = Object.fromEntries(feed.readings.map(row => [row.lane, row]));
    expect(Object.keys(lanes).sort()).toEqual(['claude-api', 'claude-max', 'devin', 'grok-ultra', 'zai']);
    expect(lanes['claude-max']).toEqual({ lane: 'claude-max', observedAt: iso(NOW), source: 'claude-usage', staleAfter: iso(NOW + 15 * 60_000),
      used: 42, limit: 100, unit: 'percent', resetAt: WEEKLY_RESET });
    expect(lanes['devin']).toMatchObject({ used: 100, limit: 400, unit: 'acu' });
    expect(lanes['claude-api']).toMatchObject({ used: 20, limit: 100, unit: 'percent' });
    expect(lanes['grok-ultra']).toMatchObject({ used: 70, limit: 100, source: 'manual' });
  });

  it('carries the burn-down pace in sensor units and drops it once the plan is old', async () => {
    const runsDir = await seeded();
    const feed = await loadResourceLiveFeed(NOW, runsDir);
    const claude = feed.pace.find(row => row.lane === 'claude-max')!;
    const hours = (Date.parse(WEEKLY_RESET) - NOW) / HOUR;
    expect(claude.pacePerHour).toBe(2);
    expect(claude.requiredPacePerHour).toBeCloseTo(58 / hours, 2);
    expect(claude.runwayHours).toBe(29);
    expect((await loadResourceLiveFeed(NOW + 16 * 60_000, runsDir)).pace).toEqual([]);
  });

  it('yields nothing for a missing or malformed sidecar', async () => {
    expect(await loadResourceLiveFeed(NOW, tmp())).toEqual({ readings: [], pace: [], history: {} });
    expect(projectResourceLiveFeed('nope', NOW)).toEqual({ readings: [], pace: [] });
    expect(projectResourceLiveFeed({ schema: RESOURCE_LIVE_SCHEMA, readings: [unverified('devin')] }, NOW)).toEqual({ readings: [], pace: [] });
  });

  it('feeds the world model sensor report that the desktop resource bar renders', async () => {
    const runsDir = await seeded();
    vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
    const report = await loadSensorReport(NOW) as { lanes: Array<Record<string, unknown>> };
    const lane = (name: string) => report.lanes.find(row => row['lane'] === name)!;
    expect(lane('claude-max')).toMatchObject({ status: 'fresh', used: 42, remaining: 58, source: 'claude-usage', observedAt: iso(NOW), pacePerHour: 2, runwayHours: 29 });
    expect(lane('zai')).toMatchObject({ status: 'fresh', used: 12, source: 'zai-lane-resources' });
    expect(lane('gemini')).toMatchObject({ status: 'unknown', used: null, headroom: null });
    expect(lane('gemini')).not.toHaveProperty('pacePerHour');
    // Fifteen minutes on with no new pass, the same numbers are stale and are not headroom.
    const later = await loadSensorReport(NOW + 16 * 60_000) as { lanes: Array<Record<string, unknown>> };
    expect(later.lanes.find(row => row['lane'] === 'claude-max')).toMatchObject({ status: 'unknown', headroom: null, stale: true });
  });

  it('gives the fleet scheduler remaining, reset and burn for a live lane', async () => {
    const feed = await loadResourceLiveFeed(NOW, await seeded());
    const advice = fleetPaceAdvice(presentUsageSensors(feed.readings, NOW));
    expect(advice['claude-cli']).toMatchObject({ remaining: 58, resetAt: WEEKLY_RESET });
  });
});

describe('phm usage resource-live', () => {
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => { out.push(String(line)); });
    vi.spyOn(console, 'error').mockImplementation((line: string) => { err.push(String(line)); });
    return { out, err };
  };
  afterEach(() => { vi.restoreAllMocks(); });

  it('runs one pass, prints each allowance, and writes the sidecar', async () => {
    const runsDir = tmp();
    const io = capture();
    const code = await cmdUsageResourceLive(['--runs-dir', runsDir], { now: () => NOW, home: tmp(),
      sources: sourcesOf({ 'claude-weekly': [fixed({ used: 62, source: 'claude-usage' })] }) });
    expect(code).toBe(0);
    expect(io.out.find(line => line.startsWith('claude-weekly'))).toContain('used=62% reset=2026-11-20T23:00:00.000Z source=claude-usage (official)');
    expect(io.out.find(line => line.startsWith('gemini'))).toBe('gemini unverified (no-supported-source) confidence=null plan=steady');
    expect(io.out.find(line => line.startsWith('claude-weekly'))).toContain('confidence=high');
    expect(io.out.at(-1)).toMatch(/^spend order: /);
    expect(existsSync(resourceLivePath(runsDir))).toBe(true);
  });

  it('prints JSON, and --show reads the stored sidecar without polling', async () => {
    const runsDir = tmp();
    const io = capture();
    const read = vi.fn(() => null);
    const sources = sourcesOf({ devin: [{ tier: 'official', read }] });
    expect(await cmdUsageResourceLive(['--runs-dir', runsDir, '--show'], { now: () => NOW, home: tmp(), sources })).toBe(1);
    expect(await cmdUsageResourceLive(['--runs-dir', runsDir, '--json'], { now: () => NOW, home: tmp(), sources })).toBe(0);
    const printed = JSON.parse(io.out[0]!) as Record<string, unknown>;
    expect(printed).toMatchObject({ generated_at: iso(NOW), decision_file: null, reset_drafts: [] });
    expect(read).toHaveBeenCalledTimes(1);
    expect(await cmdUsageResourceLive(['--runs-dir', runsDir, '--show', '--json'], { now: () => NOW, home: tmp(), sources })).toBe(0);
    expect((JSON.parse(io.out[1]!) as ResourceLiveSidecar).schema).toBe(RESOURCE_LIVE_SCHEMA);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('repeats under --watch, sleeping until the next poll', async () => {
    const runsDir = tmp();
    capture();
    let clock = NOW;
    const sleeps: number[] = [];
    let passes = 0;
    const code = await cmdUsageResourceLive(['--runs-dir', runsDir, '--watch'], {
      now: () => clock, home: tmp(), sources: sourcesOf({}),
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
      shouldStop: () => (passes += 1) >= 3,
    });
    expect(code).toBe(0);
    expect(sleeps).toEqual([600_000]);
  });

  it('rejects bad flags and prints help without acting', async () => {
    const io = capture();
    expect(await cmdUsageResourceLive(['--help'])).toBe(0);
    expect(io.out[0]).toContain('phm usage resource-live');
    for (const args of [['--nope'], ['--headed'], ['--runs-dir'], ['--runs-dir', 'relative'], ['--runs-dir', '/Users/x/.codex/runs'], ['--show', '--watch']]) {
      expect(await cmdUsageResourceLive(args, { home: tmp() })).toBe(2);
    }
  });
});
