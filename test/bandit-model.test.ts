import { describe, expect, it } from 'vitest';

import { contextCellKeys, laneContextOf, sizeBucketOf } from '../src/core/bandit/context.js';
import {
  banditStateFrom,
  emptyBanditState,
  floorEligibleLanes,
  sampleLanes,
  updateBanditState,
} from '../src/core/bandit/model.js';
import { beta, mulberry32 } from '../src/core/bandit/rng.js';
import {
  DEFAULT_BANDIT_CONFIG,
  type BanditConfig,
  type BanditLane,
  type BanditState,
} from '../src/core/bandit/types.js';

const lanes: BanditLane[] = [
  { id: 'devin', pool: 'devin' },
  { id: 'codex-personal', pool: 'codex-personal' },
];
const ctx = laneContextOf({ sizeLines: 300, repo: 'phantom', tier: 'work', pool: 'devin' }, DEFAULT_BANDIT_CONFIG);
const coldConfig: BanditConfig = { ...DEFAULT_BANDIT_CONFIG, minCellSamples: 2 };

/** State with `n` full-reward observations for lane in the L0 cell. */
function trained(state: BanditState, context: typeof ctx, laneId: string, reward: number, n: number): BanditState {
  let next = state;
  for (let i = 0; i < n; i++) next = updateBanditState(next, context, laneId, reward);
  return next;
}

describe('size buckets', () => {
  it.each([
    [1, 'xs'], [150, 'xs'], [151, 's'], [400, 's'], [1200, 'm'], [1201, 'l'], [3600, 'l'], [3601, 'xl'],
  ])('maps %i lines to %s', (lines, expected) => {
    expect(sizeBucketOf(lines, DEFAULT_BANDIT_CONFIG.sizeEdges)).toBe(expected);
  });

  it('treats missing or non-positive sizes as medium, never as the smallest work', () => {
    expect(sizeBucketOf(undefined, DEFAULT_BANDIT_CONFIG.sizeEdges)).toBe('m');
    expect(sizeBucketOf(0, DEFAULT_BANDIT_CONFIG.sizeEdges)).toBe('m');
    expect(sizeBucketOf(-5, DEFAULT_BANDIT_CONFIG.sizeEdges)).toBe('m');
    expect(sizeBucketOf(Number.NaN, DEFAULT_BANDIT_CONFIG.sizeEdges)).toBe('m');
  });

  it('falls back to default edges for malformed edge lists', () => {
    expect(sizeBucketOf(100, [400])).toBe('xs');
    expect(sizeBucketOf(100, [400, 100, 200, 300])).toBe('xs');
  });
});

describe('context cell keys', () => {
  it('produces four hierarchical levels, most specific first', () => {
    const keys = contextCellKeys(ctx);
    expect(keys).toHaveLength(4);
    expect(keys[0]).toBe(['s', 'phantom', 'work', 'devin'].join('\n'));
    expect(keys[1]).toBe(['s', '*', 'work', 'devin'].join('\n'));
    expect(keys[2]).toBe(['*', '*', 'work', 'devin'].join('\n'));
    expect(keys[3]).toBe(['*', '*', '*', '*'].join('\n'));
  });

  it('escapes the separator inside free-text fields so cells cannot alias', () => {
    const tricky = laneContextOf({ sizeLines: 300, repo: `phan${'\n'}tom`, tier: 'work', pool: 'devin' }, DEFAULT_BANDIT_CONFIG);
    const plain = laneContextOf({ sizeLines: 300, repo: 'phantom', tier: 'work', pool: 'devin' }, DEFAULT_BANDIT_CONFIG);
    expect(contextCellKeys(tricky)[0]).not.toBe(contextCellKeys(plain)[0]);
    expect(contextCellKeys(tricky)[0]).toContain('phan\\ntom');
  });

  it('normalizes blank context fields to the explicit none atom', () => {
    const blank = laneContextOf({ sizeLines: 10, repo: ' ', tier: '', pool: 'devin' }, DEFAULT_BANDIT_CONFIG);
    expect(blank.repo).toBe('none');
    expect(blank.tier).toBe('none');
  });
});

describe('credit floor eligibility', () => {
  it('excludes lanes whose pool is below the floor, including unknown headroom', () => {
    const eligible = floorEligibleLanes(lanes, { remaining: { devin: 10, 'codex-personal': -1 } }, 0);
    expect(eligible.map((lane) => lane.id)).toEqual(['devin']);
    expect(floorEligibleLanes(lanes, { remaining: { devin: 10 } }, 0).map((l) => l.id)).toEqual(['devin']);
  });

  it('treats a missing credit plan as no plan to exceed', () => {
    expect(floorEligibleLanes(lanes, undefined, 5)).toHaveLength(2);
  });

  it('honors a per-call floor override', () => {
    const eligible = floorEligibleLanes(lanes, { remaining: { devin: 3, 'codex-personal': 9 }, floor: 5 }, 0);
    expect(eligible.map((lane) => lane.id)).toEqual(['codex-personal']);
  });
});

describe('thompson sampling', () => {
  it('samples every eligible lane at the prior on a cold start', () => {
    const selection = sampleLanes(emptyBanditState(), ctx, lanes, DEFAULT_BANDIT_CONFIG, mulberry32(7));
    expect(selection).not.toBeNull();
    expect(selection!.samples).toHaveLength(2);
    expect(selection!.samples.every((sample) => sample.level === -1)).toBe(true);
    for (const sample of selection!.samples) {
      expect(sample.theta).toBeGreaterThan(0);
      expect(sample.theta).toBeLessThan(1);
    }
  });

  it('prefers a lane whose posterior is trained well above the prior', () => {
    const state = trained(emptyBanditState(), ctx, 'devin', 1, 20);
    const picks = new Set<string>();
    for (let seed = 0; seed < 40; seed++) {
      const selection = sampleLanes(state, ctx, lanes, coldConfig, mulberry32(seed));
      picks.add(selection!.lane.id);
    }
    expect(picks).toEqual(new Set(['devin']));
  });

  it('uses a coarser level when the exact cell is thin but the generalized one is trained', () => {
    // Train the OTHER repo's exact cell heavily; this ctx's L0 stays cold so
    // selection must fall to the L1 (repo-generalized) level it fed too.
    const otherRepo = laneContextOf({ sizeLines: 300, repo: 'lexicon', tier: 'work', pool: 'devin' }, DEFAULT_BANDIT_CONFIG);
    const state = trained(emptyBanditState(), otherRepo, 'devin', 1, 12);
    const selection = sampleLanes(state, ctx, lanes, coldConfig, mulberry32(3));
    expect(selection!.lane.id).toBe('devin');
    expect(selection!.sample.level).toBe(1);
  });

  it('is deterministic for a fixed seed', () => {
    const state = trained(emptyBanditState(), ctx, 'devin', 0.8, 6);
    const a = sampleLanes(state, ctx, lanes, coldConfig, mulberry32(42));
    const b = sampleLanes(state, ctx, lanes, coldConfig, mulberry32(42));
    expect(a!.lane.id).toBe(b!.lane.id);
    expect(a!.samples.map((sample) => sample.theta)).toEqual(b!.samples.map((sample) => sample.theta));
  });

  it('returns null with no eligible lanes', () => {
    expect(sampleLanes(emptyBanditState(), ctx, [], DEFAULT_BANDIT_CONFIG, mulberry32(1))).toBeNull();
  });
});

describe('posterior updates', () => {
  it('writes all four context levels for the observed lane only', () => {
    const state = updateBanditState(emptyBanditState(), ctx, 'devin', 0.8);
    const keys = contextCellKeys(ctx);
    for (const key of keys) {
      const posterior = state.cells[key]!['devin']!;
      expect(posterior.a).toBeCloseTo(0.8, 12);
      expect(posterior.b).toBeCloseTo(0.2, 12);
      expect(posterior.n).toBe(1);
      expect(state.cells[key]!['codex-personal']).toBeUndefined();
    }
  });

  it('clips out-of-range rewards into the unit interval and ignores non-finite ones', () => {
    let state = updateBanditState(emptyBanditState(), ctx, 'devin', 1.7);
    const key = contextCellKeys(ctx)[3]!;
    expect(state.cells[key]!['devin']).toEqual({ a: 1, b: 0, n: 1 });
    state = updateBanditState(state, ctx, 'devin', Number.NaN);
    expect(state.cells[key]!['devin']).toEqual({ a: 1, b: 0, n: 1 });
  });
});

describe('state persistence', () => {
  it('round-trips a trained state', () => {
    const state = trained(emptyBanditState(), ctx, 'devin', 0.7, 3);
    const restored = banditStateFrom(JSON.parse(JSON.stringify(state)));
    expect(restored).toEqual(state);
  });

  it('fails closed to a fresh prior on corrupt or foreign state', () => {
    for (const value of [null, 42, 'x', { v: 2 }, { v: 1, cells: [] }, { v: 1, cells: { k: { lane: { a: -1, b: 0, n: 0 } } } }]) {
      expect(banditStateFrom(value)).toEqual({ v: 1, cells: {} });
    }
    const mixed = banditStateFrom({ v: 1, cells: { good: { devin: { a: 1, b: 1, n: 1 } }, bad: { devin: { a: Number.NaN, b: 0, n: 0 } } } });
    expect(mixed.cells['good']!['devin']).toEqual({ a: 1, b: 1, n: 1 });
  });
});

describe('beta sampler', () => {
  it('stays inside the open unit interval across thousands of draws', () => {
    const uniform = mulberry32(99);
    for (let i = 0; i < 5_000; i++) {
      const draw = beta(1 + (i % 7), 1 + (i % 5), uniform);
      expect(draw).toBeGreaterThan(0);
      expect(draw).toBeLessThan(1);
    }
  });

  it('has a mean near alpha/(alpha+beta)', () => {
    const uniform = mulberry32(4);
    const draws = Array.from({ length: 4_000 }, () => beta(8, 2, uniform));
    const mean = draws.reduce((sum, draw) => sum + draw, 0) / draws.length;
    expect(mean).toBeGreaterThan(0.76);
    expect(mean).toBeLessThan(0.84);
  });
});
