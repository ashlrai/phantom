/**
 * Pool spend order (src/core/resources/pool-spend.ts): expiring credits
 * first, then the codex accounts, other subscriptions, Devin, a grok
 * subscription login, local models, then metered APIs. Unknown balance stays
 * spendable to a per-day soft cap. Pure module; fake clock only.
 */

import { describe, expect, it } from 'vitest';

import {
  poolNeedsFigures,
  rankSpendPools,
  spendablePool,
  UNKNOWN_BALANCE_SOFT_CAP_PER_DAY,
  type SpendPool,
} from '../src/core/resources/pool-spend.js';

const NOW = Date.parse('2026-10-26T02:00:00.000Z');

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

describe('pool spend order', () => {
  const rank = { nowMs: NOW, floor: 'frontier' as const, meteredEnabled: true };

  it('spends a known expiry, then an unknown credit, then a subscription, then local, then metered', () => {
    const order = rankSpendPools([
      pool({ id: 'meter', billing: 'metered', tier: 'frontier', meteredOptIn: true, headroomPercent: 99 }),
      pool({ id: 'local', billing: 'local', tier: 'cheap', headroomPercent: 100 }),
      pool({ id: 'sub', billing: 'subscription', headroomPercent: 90 }),
      pool({ id: 'unknown-credit', billing: 'credit', headroomPercent: 10 }),
      pool({ id: 'soon', billing: 'credit', expiresAt: '2026-10-26T06:00:00.000Z', balance: 5, headroomPercent: 5 }),
      pool({ id: 'later', billing: 'credit', expiresAt: '2026-11-01T00:00:00.000Z', balance: 5, headroomPercent: 80 }),
    ], rank).map((row) => row.id);
    expect(order).toEqual(['soon', 'later', 'unknown-credit', 'sub', 'meter']);
  });

  it('spends codex primary hard, then secondary, Devin, a grok subscription, local, then metered', () => {
    const order = rankSpendPools([
      pool({ id: 'grok-api', billing: 'metered', meteredOptIn: true, headroomPercent: 100 }),
      pool({ id: 'ollama:ollama', billing: 'local', tier: 'frontier', lane: 'local-fallback', headroomPercent: 100 }),
      pool({ id: 'omlx:omlx', billing: 'local', tier: 'frontier', lane: 'local-omlx', headroomPercent: 10 }),
      pool({ id: 'grok:subscription', billing: 'subscription', lane: 'grok-subscription', headroomPercent: 1 }),
      pool({ id: 'devin-acu', billing: 'metered', lane: 'devin', spendFully: true, meteredOptIn: true, usedToday: 5, headroomPercent: 0 }),
      pool({ id: 'claude:claude', billing: 'subscription', headroomPercent: 99 }),
      pool({ id: 'codex:codex-secondary', billing: 'subscription', headroomPercent: 95 }),
      pool({ id: 'codex:codex-primary', billing: 'subscription', spendFully: true, headroomPercent: 5 }),
      pool({ id: 'soon', billing: 'credit', expiresAt: '2026-10-26T06:00:00.000Z', balance: 5, headroomPercent: 1 }),
    ], rank).map((row) => row.id);
    expect(order).toEqual([
      'soon',
      'codex:codex-primary',
      'codex:codex-secondary',
      'claude:claude',
      'devin-acu',
      'grok:subscription',
      'omlx:omlx',
      'ollama:ollama',
      'grok-api',
    ]);
  });

  it('keeps an unknown balance spendable until the soft cap, and a spend-fully pool ignores the cap', () => {
    const unknown = pool({ id: 'cloud-credits', billing: 'credit' });
    expect(poolNeedsFigures(unknown)).toBe(true);
    expect(rankSpendPools([unknown], rank).map((row) => row.id)).toEqual(['cloud-credits']);
    expect(rankSpendPools([{ ...unknown, usedToday: UNKNOWN_BALANCE_SOFT_CAP_PER_DAY }], rank)).toEqual([]);
    const spentFully = { ...unknown, usedToday: 9, spendFully: true };
    expect(rankSpendPools([spentFully], rank).map((row) => row.id)).toEqual(['cloud-credits']);
  });

  it('drops local models under a frontier floor and holds metered work until it is enabled', () => {
    const rows = [
      pool({ id: 'local', billing: 'local', tier: 'cheap', headroomPercent: 100 }),
      pool({ id: 'grok', billing: 'metered', tier: 'workhorse', headroomPercent: 100 }),
      pool({ id: 'codex', billing: 'subscription', headroomPercent: 20 }),
    ];
    expect(rankSpendPools(rows, { nowMs: NOW, floor: 'frontier', meteredEnabled: false }).map((row) => row.id)).toEqual(['codex']);
    expect(rankSpendPools(rows, { nowMs: NOW, floor: 'cheap', meteredEnabled: true }).map((row) => row.id)).toEqual(['codex', 'local', 'grok']);
  });
});

describe('spendablePool', () => {
  const input = { nowMs: NOW, floor: 'local' as const, meteredEnabled: true };

  it('refuses an expired credit, a spent balance, and a pool still in cooldown', () => {
    expect(spendablePool(pool({ id: 'expired', billing: 'credit', expiresAt: '2026-10-25T00:00:00.000Z' }), input)).toBe(false);
    expect(spendablePool(pool({ id: 'empty', billing: 'subscription', balance: 0 }), input)).toBe(false);
    expect(spendablePool(pool({ id: 'cool', billing: 'subscription', cooledUntilMs: NOW + 60_000 }), input)).toBe(false);
    expect(spendablePool(pool({ id: 'warm', billing: 'subscription', cooledUntilMs: NOW - 60_000 }), input)).toBe(true);
  });

  it('lets a metered pool through on its own opt-in without the global switch', () => {
    const metered = pool({ id: 'api', billing: 'metered', meteredOptIn: true, headroomPercent: 50 });
    expect(spendablePool(metered, { ...input, meteredEnabled: false })).toBe(true);
    expect(spendablePool({ ...metered, meteredOptIn: false }, { ...input, meteredEnabled: false })).toBe(false);
  });

  it('flags a known credit balance without an expiry as needing figures', () => {
    expect(poolNeedsFigures(pool({ id: 'c', billing: 'credit', balance: 5 }))).toBe(true);
    expect(poolNeedsFigures(pool({ id: 'c', billing: 'credit', balance: 5, expiresAt: '2026-10-30T00:00:00.000Z' }))).toBe(false);
    expect(poolNeedsFigures(pool({ id: 's', billing: 'subscription', balance: 5 }))).toBe(false);
  });
});
