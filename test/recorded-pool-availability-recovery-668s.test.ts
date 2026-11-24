import { describe, expect, it } from 'vitest';
import {
  RECORDED_POOL_AVAILABILITY_PROVENANCE as P,
  explainRecordedPoolAvailability as explain,
  type RecordedPoolEvidence,
} from '../src/core/providers/coding-cli/recorded-pool-availability.js';

const NOW = 1_800_000_000_000;
const ok: RecordedPoolEvidence = {
  enabled: true,
  concurrency: 2,
  expiresAtMs: NOW + 1000,
  unlimited: false,
  remaining: 10,
  usedToday: 3,
  softCapPerDay: 50,
  nowMs: NOW,
};

describe('recorded pool availability (PR #5952 poolOpen)', () => {
  it('reports provenance and historical-only basis on every result', () => {
    for (const result of [explain(ok), explain({ ...ok, enabled: false }), explain({ ...ok, enabled: undefined })]) {
      expect(result).toMatchObject({ historicalOnly: true, provenance: { sourcePr: 5952, sourceFunction: 'poolOpen' } });
    }
    expect(P.sourceSha).toBe('3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886');
  });

  it('closes independently on disabled, zero concurrency, expiry, zero balance and daily cap', () => {
    expect(explain({ ...ok, enabled: false })).toMatchObject({ status: 'closed', reasons: ['disabled'] });
    expect(explain({ ...ok, concurrency: 0 })).toMatchObject({ status: 'closed', reasons: ['no-concurrency'] });
    expect(explain({ ...ok, expiresAtMs: NOW - 1 })).toMatchObject({ status: 'closed', reasons: ['expired'] });
    expect(explain({ ...ok, remaining: 0 })).toMatchObject({ status: 'closed', reasons: ['balance-exhausted'] });
    expect(explain({ ...ok, remaining: null, usedToday: 50 })).toMatchObject({ status: 'closed', reasons: ['daily-cap-reached'] });
  });

  it('expiry equal to now closes; one millisecond later is open', () => {
    expect(explain({ ...ok, expiresAtMs: NOW })).toMatchObject({ status: 'closed', reasons: ['expired'] });
    expect(explain({ ...ok, expiresAtMs: NOW + 1 })).toMatchObject({ status: 'open' });
  });

  it('zero balance closes; a tiny positive balance is open', () => {
    expect(explain({ ...ok, remaining: 0 }).status).toBe('closed');
    expect(explain({ ...ok, remaining: 0.000001 })).toMatchObject({ status: 'open', basis: 'positive-balance' });
  });

  it('daily cap equality closes an unknown balance; below cap stays unknown, never open', () => {
    expect(explain({ ...ok, remaining: null, usedToday: 50, softCapPerDay: 50 })).toMatchObject({ status: 'closed' });
    expect(explain({ ...ok, remaining: null, usedToday: 49.9, softCapPerDay: 50 })).toEqual(
      expect.objectContaining({ status: 'unknown', missing: ['remaining'] }),
    );
  });

  it('known positive balance ignores the daily cap, as the source did', () => {
    expect(explain({ ...ok, remaining: 5, usedToday: 60, softCapPerDay: 50 })).toMatchObject({ status: 'open', basis: 'positive-balance' });
  });

  it('unlimited bypasses balance and cap evidence but still needs enabled, concurrency and expiry', () => {
    expect(explain({ ...ok, unlimited: true, remaining: 0, usedToday: 99, softCapPerDay: 1 })).toMatchObject({ status: 'open', basis: 'unlimited' });
    expect(explain({ ...ok, unlimited: true, remaining: null, usedToday: undefined, softCapPerDay: undefined })).toMatchObject({ status: 'open' });
    expect(explain({ ...ok, unlimited: true, enabled: undefined })).toMatchObject({ status: 'unknown', missing: ['enabled'] });
    expect(explain({ ...ok, unlimited: true, concurrency: null })).toMatchObject({ status: 'unknown', missing: ['concurrency'] });
    expect(explain({ ...ok, unlimited: true, expiresAtMs: undefined })).toMatchObject({ status: 'unknown', missing: ['expiresAtMs'] });
  });

  it('recorded null expiry means no expiry, not missing evidence', () => {
    expect(explain({ ...ok, expiresAtMs: null })).toMatchObject({ status: 'open' });
  });

  it('missing balance and missing cap are unknown, not invented', () => {
    expect(explain({ ...ok, remaining: undefined })).toMatchObject({ status: 'unknown', missing: ['remaining'] });
    expect(explain({ ...ok, remaining: null, usedToday: undefined })).toMatchObject({
      status: 'unknown',
      missing: ['remaining', 'usedToday'],
    });
    expect(explain({ ...ok, remaining: null, softCapPerDay: null })).toMatchObject({
      status: 'unknown',
      missing: ['remaining', 'softCapPerDay'],
    });
  });

  it('missing enabled, concurrency, expiry and unlimited are unknown with the exact fields', () => {
    expect(explain({ ...ok, enabled: null })).toMatchObject({ status: 'unknown', missing: ['enabled'] });
    expect(explain({ ...ok, concurrency: undefined })).toMatchObject({ status: 'unknown', missing: ['concurrency'] });
    expect(explain({ ...ok, expiresAtMs: undefined })).toMatchObject({ status: 'unknown', missing: ['expiresAtMs'] });
    expect(explain({ ...ok, unlimited: undefined, remaining: 0 })).toMatchObject({ status: 'unknown', missing: ['unlimited'] });
  });

  it('a decisive closure wins over unrelated missing fields', () => {
    expect(explain({ ...ok, enabled: false, concurrency: undefined, remaining: undefined })).toEqual(
      expect.objectContaining({ status: 'closed', reasons: ['disabled'] }),
    );
    expect(explain({ ...ok, expiresAtMs: NOW - 5, unlimited: undefined })).toEqual(
      expect.objectContaining({ status: 'closed', reasons: ['expired'] }),
    );
  });

  it('lists every known closure reason', () => {
    expect(explain({ ...ok, enabled: false, concurrency: 0 })).toMatchObject({ status: 'closed', reasons: ['disabled', 'no-concurrency'] });
  });

  it('rejects invalid numbers and timestamps instead of comparing NaN', () => {
    expect(() => explain({ ...ok, remaining: Number.NaN })).toThrow(RangeError);
    expect(() => explain({ ...ok, remaining: -1 })).toThrow(RangeError);
    expect(() => explain({ ...ok, usedToday: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(() => explain({ ...ok, softCapPerDay: -0.5 })).toThrow(RangeError);
    expect(() => explain({ ...ok, concurrency: 1.5 })).toThrow(RangeError);
    expect(() => explain({ ...ok, concurrency: -1 })).toThrow(RangeError);
    expect(() => explain({ ...ok, expiresAtMs: Number.NaN })).toThrow(RangeError);
    expect(() => explain({ ...ok, expiresAtMs: '2030-01-01' as unknown as number })).toThrow(RangeError);
    expect(() => explain({ ...ok, nowMs: Number.NaN })).toThrow(RangeError);
    expect(() => explain({ ...ok, nowMs: -1 })).toThrow(RangeError);
    expect(() => explain({ ...ok, enabled: 'yes' as unknown as boolean })).toThrow(RangeError);
  });

  it('does not mutate caller evidence and returns no shared mutable state', () => {
    const evidence = Object.freeze({ ...ok }) as RecordedPoolEvidence;
    const before = JSON.stringify(evidence);
    const first = explain(evidence);
    expect(JSON.stringify(evidence)).toBe(before);
    expect(explain(evidence)).toEqual(first);
  });
});
