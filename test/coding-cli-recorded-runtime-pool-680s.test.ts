import { describe, expect, it } from 'vitest';

import {
  recordedRuntimePool,
  recordedRuntimePools,
  type RecordedRuntimePoolInput,
  type RecordedRuntimePoolRow,
  type RecordedWeeklyProjection,
} from '../src/core/providers/coding-cli/recorded-runtime-pool.js';

const PROV = {
  sourcePr: 5952,
  sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
  sourceFunction: 'runtimePool',
  listFunction: 'buildRuntimePools',
  basis: 'historical-offline',
};
const MARKS = { historicalOnly: true, currentAllowanceEvidence: false, dispatchAuthority: false };

function row(over: Partial<RecordedRuntimePoolRow> = {}): RecordedRuntimePoolRow {
  return {
    id: 'fake-pool-a', billing: 'subscription', tier: 'workhorse', host: 'mac', concurrency: 2,
    preferencePenalty: 0.25, monetaryCost: 3, unlimited: false, live: true, enabled: true,
    softCapPerDay: 7, usedToday: 4, remaining: 12, expiresAt: '2026-01-02T00:00:00.000Z',
    resetAt: '2026-01-01T00:00:00.000Z', headroomPercent: 40, ...over,
  };
}
const weekly = (over: Partial<RecordedWeeklyProjection> = {}): RecordedWeeklyProjection => ({
  remaining: 0.64, resetAtMs: 1_800_000_000_000, resetEveryDays: 7, extraUsageCredits: true,
  label: 'fake weekly label', ...over,
});
const fail = (input: unknown, path: string) =>
  expect(() => recordedRuntimePool(input as RecordedRuntimePoolInput)).toThrow(
    new RangeError(`recorded runtime pool: invalid ${path}`),
  );

describe('recordedRuntimePool', () => {
  it('maps an ordinary known-balance row to a hand-derived object', () => {
    expect(recordedRuntimePool({ row: row() })).toEqual({
      id: 'fake-pool-a', billing: 'subscription', tier: 'workhorse', host: 'mac', concurrency: 2,
      monetaryCost: 3, preferencePenalty: 0.25, unlimited: false, remaining: 12, usedToday: 4,
      softCapPerDay: 7, expiresAtMs: 1_767_312_000_000, resetAtMs: 1_767_225_600_000,
      resetEveryMs: null, carryover: true, headroomPercent: 40, enabled: true,
      estimate: false, estimateSource: null, provenance: PROV, ...MARKS,
    });
  });

  it('keeps null balance as unknown estimate and null dates null', () => {
    const r = recordedRuntimePool({ row: row({ remaining: null, expiresAt: null, resetAt: null, headroomPercent: null }) });
    expect(r).toMatchObject({
      remaining: null, estimate: true, estimateSource: 'balance unknown',
      expiresAtMs: null, resetAtMs: null, headroomPercent: null,
    });
  });

  it('enabled is enabled && live', () => {
    for (const [enabled, live, want] of [[true, true, true], [true, false, false], [false, true, false], [false, false, false]] as const) {
      expect(recordedRuntimePool({ row: row({ enabled, live }) }).enabled).toBe(want);
    }
  });

  it('maps a supplied weekly projection and ignores the row balance fields', () => {
    const r = recordedRuntimePool({
      row: row({ id: 'fake-weekly', unlimited: true, remaining: null, usedToday: 9, headroomPercent: 15 }),
      weekly: weekly(),
    });
    expect(r).toMatchObject({
      unlimited: false, remaining: 0.64, usedToday: 0, expiresAtMs: null, resetAtMs: 1_800_000_000_000,
      resetEveryMs: 604_800_000, carryover: true, headroomPercent: 15, enabled: true,
      estimate: true, estimateSource: 'fake weekly label', provenance: PROV, ...MARKS,
    });
  });

  it('falls back to rounded remaining percent when headroom is null; zero headroom is kept', () => {
    expect(recordedRuntimePool({ row: row({ headroomPercent: null }), weekly: weekly({ remaining: 0.645 }) }).headroomPercent).toBe(65);
    expect(recordedRuntimePool({ row: row({ headroomPercent: 0 }), weekly: weekly() }).headroomPercent).toBe(0);
    expect(recordedRuntimePool({ row: row({ headroomPercent: null }), weekly: weekly({ remaining: 0 }) }).headroomPercent).toBe(0);
  });

  it('weekly extraUsageCredits false means no carryover; row live gate still applies', () => {
    const r = recordedRuntimePool({ row: row({ live: false }), weekly: weekly({ extraUsageCredits: false }) });
    expect(r.carryover).toBe(false);
    expect(r.enabled).toBe(false);
  });

  it('absent weekly evidence never fabricates remaining or reset', () => {
    const r = recordedRuntimePool({ row: row({ remaining: null, resetAt: null, headroomPercent: null }) });
    expect(r.remaining).toBeNull();
    expect(r.resetAtMs).toBeNull();
    expect(r.resetEveryMs).toBeNull();
    expect(r.headroomPercent).toBeNull();
  });

  it('rejects missing evidence rather than defaulting', () => {
    for (const k of ['remaining', 'expiresAt', 'resetAt', 'headroomPercent', 'concurrency', 'enabled', 'live', 'unlimited', 'usedToday'] as const) {
      const r: Record<string, unknown> = { ...row() };
      delete r[k];
      fail({ row: r }, `input.row.${k}`);
    }
    fail({}, 'input.row');
  });

  it('rejects malformed numbers, dates, enums with fixed paths and no value echo', () => {
    fail({ row: row({ concurrency: Number.NaN }) }, 'input.row.concurrency');
    fail({ row: row({ concurrency: 1.5 }) }, 'input.row.concurrency');
    fail({ row: row({ monetaryCost: -1 }) }, 'input.row.monetaryCost');
    fail({ row: row({ preferencePenalty: Infinity }) }, 'input.row.preferencePenalty');
    fail({ row: row({ remaining: -5 }) }, 'input.row.remaining');
    fail({ row: row({ headroomPercent: Number.NaN }) }, 'input.row.headroomPercent');
    fail({ row: row({ expiresAt: 'SECRET-not-a-date' }) }, 'input.row.expiresAt');
    fail({ row: row({ resetAt: 5 as unknown as string }) }, 'input.row.resetAt');
    fail({ row: row({ billing: 'SECRET' as never }) }, 'input.row.billing');
    fail({ row: row({ enabled: 1 as unknown as boolean }) }, 'input.row.enabled');
    fail({ row: row(), weekly: weekly({ remaining: 1.5 }) }, 'input.weekly.remaining');
    fail({ row: row(), weekly: weekly({ resetAtMs: Number.NaN }) }, 'input.weekly.resetAtMs');
    fail({ row: row(), weekly: weekly({ resetEveryDays: 0 }) }, 'input.weekly.resetEveryDays');
    fail({ row: row(), weekly: weekly({ label: '  ' }) }, 'input.weekly.label');
    fail({ row: row(), weekly: weekly({ extraUsageCredits: undefined as never }) }, 'input.weekly.extraUsageCredits');
    try {
      recordedRuntimePool({ row: row({ expiresAt: 'SECRET-not-a-date' }) });
    } catch (e) {
      expect(String(e)).not.toContain('SECRET');
    }
  });

  it('does not mutate caller objects', () => {
    const input = { row: Object.freeze(row({ remaining: null })), weekly: Object.freeze(weekly()) };
    const before = JSON.stringify(input);
    recordedRuntimePool(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('recordedRuntimePools', () => {
  it('preserves caller order, with labels not tied to a fixed id set', () => {
    const out = recordedRuntimePools([
      { row: row({ id: 'zzz-fake' }) },
      { row: row({ id: 'aaa-fake' }), weekly: weekly() },
      { row: row({ id: 'mmm-fake', remaining: null }) },
    ]);
    expect(out.map((p) => p.id)).toEqual(['zzz-fake', 'aaa-fake', 'mmm-fake']);
    expect(out.map((p) => p.estimate)).toEqual([false, true, true]);
    expect(recordedRuntimePools([])).toEqual([]);
  });

  it('rejects duplicate ids without echoing them, and reports item paths', () => {
    expect(() => recordedRuntimePools([{ row: row({ id: 'dup-fake' }) }, { row: row({ id: 'dup-fake' }) }])).toThrow(
      new RangeError('recorded runtime pool: invalid inputs[1].row.id'),
    );
    expect(() => recordedRuntimePools([{ row: row() }, { row: row({ id: 'b', concurrency: -1 }) }])).toThrow(
      new RangeError('recorded runtime pool: invalid inputs[1].row.concurrency'),
    );
    expect(() => recordedRuntimePools(null as never)).toThrow(new RangeError('recorded runtime pool: invalid inputs'));
  });
});
