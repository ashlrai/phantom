import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AshlrConfig } from '../src/core/config.js';
import { localEscalationInputFor } from '../src/core/fleet/dispatch-router.js';
import { localFirstBanditContext } from '../src/core/fleet/tick-hooks-live.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';
import type { EscalationInput } from '../src/core/routing/local-escalation.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import { routeSeatWithLocalEscalation, type LocalRouteContext } from '../src/core/routing/local-route.js';
import type { RoutingLedgerEntry } from '../src/core/routing/routing-ledger.js';
import {
  appendMergeOutcome,
  banditStatsFrom,
  chooseLocalFirstLane,
  DEFAULT_LOCAL_FIRST_BANDIT,
  loadBanditStats,
  parseLocalFirstBanditConfig,
  readMergeOutcomes,
  recordMergeOutcome,
  routeSeatWithLocalFirstBandit,
  sampleBeta,
  seededRandom,
  type BanditStats,
  type LocalFirstBanditConfig,
  type MergeOutcome,
} from '../src/core/routing/local-first-bandit.js';

const NOW = Date.parse('2026-10-26T07:30:00Z');
const at = new Date(NOW - 60_000).toISOString();
const claude = {
  seatId: 'claude', engine: 'claude', label: 'Claude', free: false,
  windows: [
    { id: 'five_hour', usedPercent: 5, resetsAt: null, resetDescription: null, limitReached: false },
    { id: 'seven_day', usedPercent: 5, resetsAt: null, resetDescription: null, limitReached: false },
  ],
  signedOut: false, reachable: true, contextWindow: 200_000, observedAt: at, spentTodayUsd: 0,
} as unknown as SeatCapacity;
const local = { ...claude, seatId: 'local', engine: 'local', label: 'Local', free: true, windows: [] } as unknown as SeatCapacity;
const mystery = { ...claude, seatId: 'mystery', engine: 'mystery-engine', label: 'Mystery' } as unknown as SeatCapacity;

const req = { task: 'code', difficulty: 'low', autonomous: true } as const;
const budget = { ...defaultBudgetPolicy(), mode: 'all-in' as const };
const opts = { nowMs: NOW };
const base: EscalationInput = { kind: 'edit', localAvailable: true, localModel: 'qwen3-coder:30b' };
const on: LocalRouteContext = { localInference: { provider: 'ollama' } };
const enabled = { enabled: true, seed: 7, minSamplesPerArm: 3 };

const arm = (pulls: number, merges: number, costUsd: number, hours: number) => ({ pulls, merges, costUsd, hours });
const cold: BanditStats = { local: arm(0, 0, 0, 0), frontier: arm(0, 0, 0, 0) };
// Local merges 2/20 at $0.01 and 2h each; frontier 18/20 at $0.50 and 0.25h each.
const localBad: BanditStats = { local: arm(20, 2, 0.2, 40), frontier: arm(20, 18, 10, 5) };
// Local merges 18/20 cheaply and quickly; frontier 10/20 slowly and expensively.
const localGood: BanditStats = { local: arm(20, 18, 0.2, 5), frontier: arm(20, 10, 20, 20) };

const cfg = (over: Partial<LocalFirstBanditConfig> = {}): LocalFirstBanditConfig => ({ ...parseLocalFirstBanditConfig(enabled), ...over });
const p4Local = { lane: 'local' as const, laneReason: 'local-ok' as const };

const routeB = (input: EscalationInput, stats: BanditStats, config: unknown = enabled, seats: SeatCapacity[] = [claude, local], itemId = 'item-1') =>
  routeSeatWithLocalFirstBandit(req as never, seats, budget, opts, input, on, { config, stats, itemId });

describe('parseLocalFirstBanditConfig', () => {
  it('is off by default and for anything malformed', () => {
    for (const raw of [undefined, null, 1, 'on', [], {}, { enabled: 'true' }, { enabled: 1 }]) {
      expect(parseLocalFirstBanditConfig(raw)).toEqual({ ...DEFAULT_LOCAL_FIRST_BANDIT });
    }
  });
  it('accepts valid fields and drops out-of-range ones to defaults', () => {
    const c = parseLocalFirstBanditConfig({ enabled: true, strategy: 'epsilon', epsilon: 0.9, seed: 42, minSamplesPerArm: 0, costWeight: 2, costFloorUsd: -1, hourFloor: 'x' });
    expect(c).toEqual({ ...DEFAULT_LOCAL_FIRST_BANDIT, enabled: true, strategy: 'epsilon', seed: 42 });
  });
});

describe('banditStatsFrom', () => {
  const e = (itemId: string, engineClass: RoutingLedgerEntry['engineClass']): RoutingLedgerEntry =>
    ({ at, itemId, seatId: null, engine: 'x', engineClass, lane: 'local', reason: 'local-ok' });
  it('joins ledger and outcomes by item id; unclassified and unmatched items earn nothing', () => {
    const entries = [e('a', 'local'), e('b', 'frontier'), e('c', 'unclassified'), e('d', 'local'), e('d', 'unclassified')];
    const outcomes: MergeOutcome[] = [
      { itemId: 'a', merged: true, costUsd: 0.02, wallMs: 1_800_000 },
      { itemId: 'b', merged: false, costUsd: 1.5, wallMs: 3_600_000 },
      { itemId: 'c', merged: true, costUsd: 9 },
      { itemId: 'd', merged: true },
      { itemId: 'zz', merged: true },
      { itemId: 'a', merged: false },
      { itemId: 'b', merged: true, costUsd: -5, wallMs: Number.NaN },
    ];
    expect(banditStatsFrom(entries, outcomes)).toEqual({ local: arm(1, 1, 0.02, 0.5), frontier: arm(1, 0, 1.5, 1) });
  });
});

describe('seeded randomness', () => {
  it('is deterministic per (seed, key) and differs across keys', () => {
    const a = seededRandom(7, 'x'); const b = seededRandom(7, 'x'); const c = seededRandom(7, 'y');
    const sa = [a(), a(), a()]; expect([b(), b(), b()]).toEqual(sa);
    expect([c(), c(), c()]).not.toEqual(sa);
    for (const v of sa) expect(v >= 0 && v < 1).toBe(true);
  });
  it('Beta samples have the right mean', () => {
    const rng = seededRandom(1, 'beta');
    let sum = 0; const n = 4000;
    for (let i = 0; i < n; i++) sum += sampleBeta(9, 3, rng);
    expect(Math.abs(sum / n - 0.75)).toBeLessThan(0.02);
  });
});

describe('chooseLocalFirstLane', () => {
  const rng = () => seededRandom(7, 'item');
  it('disabled follows P4 exactly', () => {
    expect(chooseLocalFirstLane({ p4: p4Local, authority: false }, localBad, cfg({ enabled: false }), rng())).toEqual({ lane: 'local', reason: 'disabled' });
  });
  it('cold start defaults to the P4 local lane', () => {
    expect(chooseLocalFirstLane({ p4: p4Local, authority: false }, cold, cfg(), rng())).toEqual({ lane: 'local', reason: 'cold-start-p4' });
  });
  it('never overrides a P4 frontier escalation', () => {
    for (const laneReason of ['protected-path', 'verify-failures', 'complex-task-kind', 'policy-off'] as const) {
      expect(chooseLocalFirstLane({ p4: { lane: 'frontier', laneReason }, authority: false }, localGood, cfg(), rng())).toEqual({ lane: 'frontier', reason: 'p4-veto' });
    }
  });
  it('authority roles are frontier-only even when local scores best', () => {
    expect(chooseLocalFirstLane({ p4: p4Local, authority: true }, localGood, cfg(), rng())).toEqual({ lane: 'frontier', reason: 'authority-frontier-only' });
  });
  it('Thompson exploits the better arm on merged PRs per $ and per hour', () => {
    const pick = (stats: BanditStats) => Array.from({ length: 200 }, (_, i) => chooseLocalFirstLane({ p4: p4Local, authority: false }, stats, cfg(), seededRandom(7, `i${i}`)).lane);
    const bad = pick(localBad); const good = pick(localGood);
    expect(bad.filter((l) => l === 'frontier').length).toBeGreaterThan(150);
    expect(good.filter((l) => l === 'local').length).toBe(200);
  });
  it('costWeight 1 scores per $ only: cheap local wins even with a lower merge rate', () => {
    const c = chooseLocalFirstLane({ p4: p4Local, authority: false }, localBad, cfg({ costWeight: 1 }), rng());
    expect(c.lane).toBe('local');
    expect(c.scores!.local.perDollar).toBeGreaterThan(c.scores!.frontier.perDollar);
  });
  it('epsilon greedy exploits the posterior mean and explores at about epsilon', () => {
    const e = cfg({ strategy: 'epsilon', epsilon: 0.2 });
    const picks = Array.from({ length: 1000 }, (_, i) => chooseLocalFirstLane({ p4: p4Local, authority: false }, localBad, e, seededRandom(3, `i${i}`)));
    const explore = picks.filter((p) => p.reason === 'explore').length;
    expect(explore).toBeGreaterThan(150); expect(explore).toBeLessThan(250);
    expect(picks.filter((p) => p.reason === 'exploit').every((p) => p.lane === 'frontier')).toBe(true);
  });
  it('is deterministic: same seed and item give the same lane', () => {
    const a = chooseLocalFirstLane({ p4: p4Local, authority: false }, localBad, cfg(), seededRandom(9, 'same'));
    const b = chooseLocalFirstLane({ p4: p4Local, authority: false }, localBad, cfg(), seededRandom(9, 'same'));
    expect(a).toEqual(b);
  });
});

describe('routeSeatWithLocalFirstBandit', () => {
  it('disabled (default) routes exactly like the P4 policy', () => {
    for (const config of [undefined, null, {}, { enabled: false }]) {
      const p4 = routeSeatWithLocalEscalation(req as never, [claude, local], budget, opts, base, on);
      const d = routeSeatWithLocalFirstBandit(req as never, [claude, local], budget, opts, base, on, { config, stats: localBad, itemId: 'item-1' });
      expect({ ...d, bandit: undefined }).toEqual({ ...p4, bandit: undefined });
      expect(d.bandit.reason).toBe('disabled');
    }
    const p4 = routeSeatWithLocalEscalation(req as never, [claude, local], budget, opts, base, on);
    expect(routeSeatWithLocalFirstBandit(req as never, [claude, local], budget, opts, base, on, null)).toMatchObject({ seatId: p4.seatId, lane: p4.lane });
  });
  it('cold start keeps the P4 local seat', () => {
    expect(routeB(base, cold)).toMatchObject({ lane: 'local', seatId: 'local', laneReason: 'local-ok', bandit: { reason: 'cold-start-p4' } });
  });
  it('moves a local-ok item to a frontier seat when local scores worse', () => {
    expect(routeB(base, localBad)).toMatchObject({ lane: 'frontier', seatId: 'claude', laneReason: 'bandit-frontier', bandit: { lane: 'frontier', reason: 'exploit' } });
  });
  it('keeps local when local scores better', () => {
    expect(routeB(base, localGood)).toMatchObject({ lane: 'local', seatId: 'local', bandit: { lane: 'local', reason: 'exploit' } });
  });
  it('never routes merge, merge-rights or publish work to a local or unclassified seat', () => {
    for (const input of [{ ...base, mergesToMain: true }, { ...base, holdsMergeRights: true }, { ...base, publishes: true }] as EscalationInput[]) {
      const d = routeB(input, localGood, enabled, [local, mystery, claude]);
      expect(d).toMatchObject({ lane: 'frontier', seatId: 'claude', bandit: { reason: 'authority-frontier-only' } });
      expect(d.candidates).toEqual(['claude']);
      const none = routeB(input, localGood, enabled, [local, mystery]);
      expect(none.seatId).toBeNull();
      expect(none.lane).toBe('frontier');
    }
  });
  it('credentialed steps route to no seat', () => {
    const d = routeB({ ...base, needsCredentials: true }, localGood, enabled, [claude, local, mystery]);
    expect(d.seatId).toBeNull();
    expect(d.bandit.reason).toBe('authority-frontier-only');
  });
  it('unknown engine ids are never a bandit frontier target', () => {
    const d = routeB(base, localBad, enabled, [local, mystery]);
    expect(d).toMatchObject({ lane: 'local', seatId: 'local', bandit: { reason: 'no-frontier-seat' } });
  });
  it('P4 escalations pass through untouched', () => {
    const d = routeB({ ...base, touchesProtectedPath: true }, localGood);
    expect(d).toMatchObject({ lane: 'frontier', laneReason: 'protected-path', bandit: { reason: 'p4-veto' } });
  });
  it('replays deterministically across items', () => {
    const run = () => Array.from({ length: 50 }, (_, i) => routeB(base, localBad, enabled, [claude, local], `it-${i}`).seatId);
    expect(run()).toEqual(run());
  });
});

describe('merge outcome store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bandit-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it('records, dedupes by item, sanitizes and bounds', () => {
    const path = join(dir, 'routing', 'merge-outcomes.json');
    recordMergeOutcome({ itemId: 'a', merged: true, costUsd: 0.5, wallMs: 1000 }, path);
    recordMergeOutcome({ itemId: 'a', merged: false, costUsd: -1, wallMs: Number.NaN }, path);
    recordMergeOutcome({ itemId: 'b', merged: 'yes' as never, costUsd: 2 }, path);
    expect(readMergeOutcomes(path)).toEqual([{ itemId: 'a', merged: false }, { itemId: 'b', merged: false, costUsd: 2 }]);
    let list: MergeOutcome[] = [];
    for (let i = 0; i < 600; i++) list = appendMergeOutcome(list, { itemId: `i${i}`, merged: true });
    expect(list).toHaveLength(500);
    expect(list[0]!.itemId).toBe('i100');
  });
  it('reads missing or malformed files as empty and loads stats from disk', () => {
    expect(readMergeOutcomes(join(dir, 'nope.json'))).toEqual([]);
    const bad = join(dir, 'bad.json'); writeFileSync(bad, '{not json');
    expect(readMergeOutcomes(bad)).toEqual([]);
    const ledger = join(dir, 'ledger.json');
    writeFileSync(ledger, JSON.stringify({ schemaVersion: 1, counts: {}, entries: [{ at, itemId: 'a', seatId: 'local', engine: 'local', engineClass: 'local', lane: 'local', reason: 'local-ok' }] }));
    const outcomes = join(dir, 'routing', 'merge-outcomes.json');
    expect(JSON.parse(readFileSync(outcomes, 'utf8')).schemaVersion).toBe(1);
    expect(loadBanditStats(ledger, outcomes).local.pulls).toBe(1);
    expect(loadBanditStats(join(dir, 'none.json'), outcomes)).toEqual(cold);
  });
});

describe('dispatch wiring', () => {
  it('localFirstBanditContext is empty unless enabled and never throws', () => {
    for (const raw of [undefined, null, 'on', { enabled: false }, { enabled: 'true' }]) {
      expect(localFirstBanditContext({ localFirstBandit: raw } as unknown as AshlrConfig)).toEqual({});
    }
    expect(localFirstBanditContext('garbage' as unknown as AshlrConfig)).toEqual({});
    const ctx = localFirstBanditContext({ localFirstBandit: { enabled: true } } as unknown as AshlrConfig);
    expect(ctx.bandit?.config).toEqual({ enabled: true });
    expect(Object.keys(ctx.bandit?.stats ?? {})).toEqual(['local', 'frontier']);
  });
  it('the escalation input never carries the bandit context', () => {
    const input = localEscalationInputFor({ effort: 'small', source: 'issue', tags: [], title: 't', detail: '' } as never,
      { localAvailable: true, route: { localInference: undefined }, bandit: { config: { enabled: true }, stats: cold } });
    expect('bandit' in input).toBe(false);
    expect('route' in input).toBe(false);
  });
});
