/**
 * chooseSpendPool (src/core/resources/pool-choice.ts): the job-shape tier
 * floor gates the spend order, and inside the winning billing class the seat
 * router reorders by headroom, reset spend-down and in-flight spread — never
 * promoting a lower class over the ranked winner's class. Pure; fake clock.
 */

import { describe, expect, it } from 'vitest';

import type { JobShape } from '../src/core/decide/job-shape.js';
import { chooseSpendPool, jobShapeFloor } from '../src/core/resources/pool-choice.js';
import { UNKNOWN_BALANCE_SOFT_CAP_PER_DAY, type SpendPool } from '../src/core/resources/pool-spend.js';
import type { AccountSchedulingView } from '../src/core/routing/scheduling-types.js';

const NOW = Date.parse('2026-10-26T02:00:00.000Z');

function shape(partial: Partial<JobShape> = {}): JobShape {
  return { complexity: 'low', risk: 'low', contextTokens: 2_000, latency: 'batch', source: 'heuristic', ...partial };
}

function pool(partial: Partial<SpendPool> & Pick<SpendPool, 'id' | 'billing'>): SpendPool {
  return {
    balance: null,
    expiresAt: null,
    usedToday: 0,
    softCapPerDay: UNKNOWN_BALANCE_SOFT_CAP_PER_DAY,
    tier: 'frontier',
    headroomPercent: null,
    ...partial,
  };
}

function view(seatId: string, resetAt: string): AccountSchedulingView {
  return {
    seatId,
    observedAt: new Date(NOW).toISOString(),
    admission: 'eligible',
    headroomPercent: 40,
    reset: {
      kind: 'weekly-deadline',
      at: resetAt,
      description: null,
      source: 'codex-native-rate-limits',
      plan: 'plus',
      windowDurationMins: 10080,
      startsAt: null,
    },
    opportunity: { kind: 'before-reset', reason: 'window closes' },
    forecast: {
      taskId: 't',
      durationMs: { p25: 60_000, p50: 90_000, p75: 120_000, samples: 4 },
      tokens: null,
      cohort: { engine: 'codex', model: null, seatId, taskKind: 'code' },
      fit: 'likely-before-reset',
      limitations: [],
    },
  };
}

describe('jobShapeFloor', () => {
  it('lifts the floor with complexity or risk and never drops it below cheap for easy work', () => {
    expect(jobShapeFloor(shape())).toBe('cheap');
    expect(jobShapeFloor(shape({ complexity: 'medium' }))).toBe('workhorse');
    expect(jobShapeFloor(shape({ complexity: 'high' }))).toBe('frontier');
    expect(jobShapeFloor(shape({ risk: 'high' }))).toBe('frontier');
  });
});

describe('chooseSpendPool', () => {
  const easy = shape();

  it('returns null when nothing is spendable and stands a lone winner without a seat pass', () => {
    expect(chooseSpendPool({ pools: [], shape: easy, nowMs: NOW })).toBeNull();
    const only = pool({ id: 'sub', billing: 'subscription', headroomPercent: 30 });
    const choice = chooseSpendPool({ pools: [only], shape: easy, nowMs: NOW });
    expect(choice?.pool.id).toBe('sub');
    expect(choice?.decision).toBeNull();
  });

  it('spends an expiring credit before a fuller subscription, and a drained credit frees the rest', () => {
    const pools = [
      pool({ id: 'sub', billing: 'subscription', headroomPercent: 90 }),
      pool({ id: 'credit', billing: 'credit', expiresAt: '2026-10-26T06:00:00.000Z', balance: 5, headroomPercent: 10 }),
    ];
    expect(chooseSpendPool({ pools, shape: easy, nowMs: NOW })?.pool.id).toBe('credit');
    const drained = pools.map((row) => (row.id === 'credit' ? { ...row, expiresAt: '2026-10-25T00:00:00.000Z' } : row));
    expect(chooseSpendPool({ pools: drained, shape: easy, nowMs: NOW })?.pool.id).toBe('sub');
  });

  it('reorders inside the winning class by seat-router spend-down, not across classes', () => {
    const later = pool({ id: 'sub-later', billing: 'subscription', headroomPercent: 80 });
    const sooner = pool({ id: 'sub-sooner', billing: 'subscription', headroomPercent: 80 });
    const choice = chooseSpendPool({
      pools: [later, sooner],
      shape: easy,
      nowMs: NOW,
      scheduling: {
        'sub-later': view('sub-later', '2026-10-28T00:00:00.000Z'),
        'sub-sooner': view('sub-sooner', '2026-10-26T06:00:00.000Z'),
      },
    });
    expect(choice?.pool.id).toBe('sub-sooner');
    expect(choice?.decision?.seatId).toBe('sub-sooner');
    // A lower class still cannot beat the winner's class on a sooner reset.
    const metered = chooseSpendPool({
      pools: [later, pool({ id: 'api', billing: 'metered', meteredOptIn: true, headroomPercent: 99 })],
      shape: easy,
      nowMs: NOW,
    });
    expect(metered?.pool.id).toBe('sub-later');
  });

  it('lets a headroom-known metered pool beat a metered pool whose usage is unread', () => {
    const choice = chooseSpendPool({
      pools: [
        pool({ id: 'devin-acu', billing: 'metered', lane: 'devin', spendFully: true, meteredOptIn: true }),
        pool({ id: 'grok-api', billing: 'metered', meteredOptIn: true, headroomPercent: 90 }),
      ],
      shape: easy,
      nowMs: NOW,
    });
    expect(choice?.pool.id).toBe('grok-api');
  });

  it('honours the tier floor: a frontier job skips local and cheap pools entirely', () => {
    const choice = chooseSpendPool({
      pools: [
        pool({ id: 'local', billing: 'local', tier: 'cheap', headroomPercent: 100 }),
        pool({ id: 'workhorse', billing: 'subscription', tier: 'workhorse', headroomPercent: 60 }),
        pool({ id: 'frontier', billing: 'subscription', tier: 'frontier', headroomPercent: 20 }),
      ],
      shape: shape({ complexity: 'high' }),
      nowMs: NOW,
    });
    expect(choice?.pool.id).toBe('frontier');
    const none = chooseSpendPool({
      pools: [pool({ id: 'local', billing: 'local', tier: 'cheap', headroomPercent: 100 })],
      shape: shape({ complexity: 'high' }),
      nowMs: NOW,
    });
    expect(none).toBeNull();
  });

  it('holds a metered pool out until the pool or the operator opts in', () => {
    const closed = pool({ id: 'api-a', billing: 'metered', headroomPercent: 90 });
    const open = pool({ id: 'api-b', billing: 'metered', meteredOptIn: true, headroomPercent: 50 });
    // The closed pool is unspendable without any enable, so the opted one stands alone.
    expect(chooseSpendPool({ pools: [closed, open], shape: easy, nowMs: NOW, meteredEnabled: false })?.pool.id).toBe('api-b');
    expect(chooseSpendPool({ pools: [closed], shape: easy, nowMs: NOW, meteredEnabled: false })).toBeNull();
    // The global switch admits both; the headroom-known order then wins the seat pass.
    const enabled = chooseSpendPool({ pools: [closed, open], shape: easy, nowMs: NOW, meteredEnabled: true });
    expect(enabled?.pool.id).toBe('api-a');
  });

  it('spreads an in-flight tie inside the winning class', () => {
    const choice = chooseSpendPool({
      pools: [
        pool({ id: 'a', billing: 'subscription', headroomPercent: 80 }),
        pool({ id: 'b', billing: 'subscription', headroomPercent: 80 }),
      ],
      shape: easy,
      nowMs: NOW,
      inFlight: { a: 3, b: 0 },
    });
    expect(choice?.pool.id).toBe('b');
  });

  it('does not route autonomous work into the Devin seat lane', () => {
    const choice = chooseSpendPool({
      pools: [
        pool({ id: 'devin-acu', billing: 'metered', lane: 'devin', spendFully: true, meteredOptIn: true, headroomPercent: 90 }),
        pool({ id: 'grok-api', billing: 'metered', meteredOptIn: true, headroomPercent: 50 }),
      ],
      shape: easy,
      nowMs: NOW,
    });
    expect(choice?.decision?.seatId).toBe('grok-api');
    expect(choice?.pool.id).toBe('grok-api');
  });
});
