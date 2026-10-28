import { describe, expect, it } from 'vitest';
import { assessSeat, type SeatCapacity } from '../src/core/routing/headroom.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import { routeSeat, ROUTER_LAMBDA_MAX, type RouterWeights } from '../src/core/routing/router.js';
import type { BudgetPolicy, RoutingRequest } from '../src/core/routing/types.js';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const POLICY: BudgetPolicy = { ...defaultBudgetPolicy(), mode: 'all-in', seats: {} };
const REQUEST: RoutingRequest = { task: 'code', difficulty: 'medium', autonomous: false };

function seat(id: string, used: number, costBasis?: SeatCapacity['costBasis']): SeatCapacity {
  return {
    seatId: id, label: id, engine: 'grok', free: false, signedOut: false,
    reachable: true, contextWindow: 200_000, observedAt: new Date(NOW).toISOString(),
    spentTodayUsd: null, costBasis,
    windows: [{ id: 'grok_unified_weekly', usedPercent: used, limitReached: false,
      resetsAt: null, resetDescription: null }],
  };
}

// Fixed seeds make every generated case reproducible without host state.
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function candidates(fleet: SeatCapacity[], weights: Partial<RouterWeights>) {
  return routeSeat(REQUEST, fleet, POLICY, { nowMs: NOW, weights }).candidates;
}

describe('routing calibration properties', () => {
  it('keeps assessed percentages within [0, 100] across usage and reserve boundaries', () => {
    const next = random(20261026);
    const percentages = [0, 0.01, 0.49, 0.5, 99.49, 99.5, 99.99, 100,
      ...Array.from({ length: 500 }, () => next() * 100)];
    for (const used of percentages) {
      for (const reservePercent of [0, 10, 50, 100, next() * 100]) {
        const headroom = assessSeat(seat('seat', used), {
          seatId: 'seat', enabled: true, reservePercent,
        }, { nowMs: NOW }).headroom;
        expect(headroom.weeklyUsedPercent).toBe(used);
        expect(headroom.autonomyHeadroomPercent).toBe(Math.max(0, Math.round(100 - reservePercent - used)));
        expect(headroom.autonomyHeadroomPercent).toBeGreaterThanOrEqual(0);
        expect(headroom.autonomyHeadroomPercent).toBeLessThanOrEqual(100);
        expect(headroom.eligibleForAutonomy).toBe(used < 100 - reservePercent);
      }
    }
  });

  it('matches an independent bounded score ordering across funding categories and weights', () => {
    const next = random(41);
    const bases = [undefined, 'subscription', 'credits', 'per-token', 'free'] as const;
    for (let run = 0; run < 300; run += 1) {
      const fleet = Array.from({ length: 2 + Math.floor(next() * 19) }, (_, index) =>
        seat(`seat-${index}`, Math.floor(next() * 100), bases[Math.floor(next() * bases.length)]));
      const weights = { lambdaCost: next() * ROUTER_LAMBDA_MAX, lambdaPressure: next() * ROUTER_LAMBDA_MAX };
      const rows = fleet.map((row, index) => {
        const funding = row.costBasis === undefined ? 0.5
          : row.costBasis === 'credits' || row.costBasis === 'per-token' ? 1 : 0;
        const score = weights.lambdaPressure * 0.5 * row.windows[0]!.usedPercent! / 101
          + weights.lambdaCost * 0.1 * funding;
        expect(Number.isFinite(score)).toBe(true);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(6);
        return { id: row.seatId, score, index };
      });
      rows.sort((a, b) => Math.abs(a.score - b.score) > 1e-9 ? a.score - b.score : a.index - b.index);
      expect(candidates(fleet, weights)).toEqual(rows.map((row) => row.id));
    }
  });

  it('preserves arbitrary caller order for exact ties, including reversed seat ids', () => {
    const next = random(731);
    for (let run = 0; run < 300; run += 1) {
      const used = Math.floor(next() * 100);
      const fleet = Array.from({ length: 2 + Math.floor(next() * 30) }, (_, index) =>
        seat(`seat-${100 - index}`, used, 'subscription'));
      for (let index = fleet.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(next() * (index + 1));
        [fleet[index], fleet[swap]] = [fleet[swap]!, fleet[index]!];
      }
      const weights = { lambdaCost: next() * 10, lambdaPressure: next() * 10 };
      const expected = fleet.map((row) => row.seatId);
      expect(candidates(fleet, weights)).toEqual(expected);
      expect(candidates(fleet, weights)).toEqual(expected);
      expect(candidates([...fleet].reverse(), weights)).toEqual([...expected].reverse());
      expect(candidates(fleet, { lambdaCost: 0, lambdaPressure: 0 })).toEqual(expected);
    }
  });

  it('uses caller order inside epsilon ties and score order outside epsilon', () => {
    const next = random(97);
    for (let run = 0; run < 200; run += 1) {
      const used = 1 + Math.floor(next() * 98);
      const fleet = [seat('z-higher-usage', used + 1), seat('a-lower-usage', used)];
      // A one-point gap contributes lambdaPressure / 202 to the score.
      const below = next() * 1e-9 * 202 * 0.9;
      const above = (1.1 + next()) * 1e-9 * 202;
      expect(candidates(fleet, { lambdaPressure: below })).toEqual(fleet.map((row) => row.seatId));
      expect(candidates(fleet, { lambdaPressure: above })).toEqual([...fleet].reverse().map((row) => row.seatId));
    }
  });

  it('clamps huge weights and defaults malformed weights without changing the decision', () => {
    const next = random(109);
    for (let run = 0; run < 100; run += 1) {
      const fleet = Array.from({ length: 10 }, (_, index) =>
        seat(`seat-${index}`, Math.floor(next() * 100), index % 2 ? 'subscription' : 'credits'));
      for (const key of ['lambdaCost', 'lambdaPressure', 'lambdaLatency'] as const) {
        const decision = (value?: number) => routeSeat(REQUEST, fleet, POLICY, {
          nowMs: NOW, weights: value === undefined ? {} : { [key]: value },
        });
        expect(decision(Number.MAX_VALUE)).toEqual(decision(ROUTER_LAMBDA_MAX));
        for (const value of [NaN, Infinity, -Infinity, -1 - next() * 100]) {
          expect(decision(value)).toEqual(decision());
        }
      }
    }
  });
});
