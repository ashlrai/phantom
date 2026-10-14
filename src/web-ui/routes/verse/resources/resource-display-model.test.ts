import { describe, expect, it } from 'vitest';
import type { CapacityRow } from '../usage/capacity-strip-model.js';
import { projectResourceDisplay } from './resource-display-model.js';

const NOW = Date.parse('2026-01-01T12:00:30.000Z');
const OBSERVED = '2026-01-01T12:00:00.000Z';
function row(over: Partial<CapacityRow> = {}): CapacityRow {
  return {
    seatId: 'synthetic-account', label: 'Synthetic account', engine: 'codex', monogram: 'C', kind: 'subscription', plan: null,
    cls: 'ready', word: 'usable', summary: '43% of weekly window used', connection: null,
    windows: [{ id: 'synthetic-week', label: 'weekly window', usedPercent: 43, limitReached: false, resetText: null, resetsAt: null, binding: true }],
    credits: null, reserve: null, notes: [], localCount: 1, checkedAt: '2026-01-01T12:00:20.000Z', resetAt: null,
    usageObservedAt: OBSERVED, quotaExpiresAt: '2026-01-01T12:01:00.000Z', creditObservedAt: OBSERVED, creditsExpiresAt: '2026-01-01T12:01:00.000Z', connectionCheckedAt: '2026-01-01T12:00:20.000Z', signedOut: false, ...over,
  };
}
const view = (value: CapacityRow, maxAgeMs?: number) => projectResourceDisplay(value, { nowMs: NOW, healthRead: true, ...(maxAgeMs === undefined ? {} : { maxAgeMs }) });

describe('canonical resource display evidence', () => {
  it('does not restamp usage from a later connection sweep', () => {
    const before = view(row());
    const after = view(row({ checkedAt: '2026-01-01T12:00:30.000Z', connectionCheckedAt: '2026-01-01T12:00:30.000Z' }));
    expect(after.usage).toEqual(before.usage);
    expect(after.usage.observedAt).toBe(OBSERVED);
    expect(after.connection.checkedAt).not.toBe(before.connection.checkedAt);
  });
  it.each([null, undefined, 'not-an-instant', '2026-01-01T12:06:00.000Z'])('keeps untimed or future usage unconfirmed: %s', usageObservedAt => {
    const result = view(row({ usageObservedAt }));
    expect(result.usage.current).toBe(false);
    expect(result.usage.state).toBe('retained');
    expect(result.usage.observedAt).toBeNull();
  });
  it('retains usage as historical after a check failure without granting current availability', () => {
    const result = view(row({ lastReading: true }));
    expect(result.usage).toMatchObject({ state: 'retained', current: false, observedAt: OBSERVED });
    expect(result.usage.summary).toContain('latest check failed');
  });
  it('applies the same explicit freshness boundary without substituting a fresh connection timestamp', () => {
    expect(view(row(), 30_000).usage.current).toBe(true);
    expect(view(row(), 29_999).usage.current).toBe(false);
    expect(view(row(), Number.NaN).usage.current).toBe(false);
    expect(view(row(), 0).usage.current).toBe(false);
  });
  it('keeps a sentinel limit flag as a current observation without inventing a percentage', () => {
    const input = row({ windows: [{ id: 'synthetic-limit', label: 'weekly window', usedPercent: null, limitReached: true, resetText: null, resetsAt: null, binding: true }] });
    expect(view(input).usage.current).toBe(true);
    expect(input.windows[0]?.usedPercent).toBeNull();
  });
  it('does not make a signed-out or local resource a current subscription reading', () => {
    expect(view(row({ signedOut: true })).usage).toMatchObject({ state: 'signed-out', current: false, observedAt: null });
    expect(view(row({ kind: 'local', engine: 'local' })).usage).toMatchObject({ state: 'not-applicable', current: false, observedAt: null });
  });
  it('keeps funding fields independent of the usage projection', () => {
    const before = view(row()).usage;
    expect(view(row({ credits: 'Synthetic credit reading', creditState: 'held', creditBalance: '7' })).usage).toEqual(before);
  });
  it('uses the shared conservative default when source policy is absent', () => {
    const result = view(row({ usageObservedAt: '2025-01-01T12:00:00.000Z' }));
    expect(result.usage).toMatchObject({ state: 'retained', current: false, freshness: 'stale' });
  });
  it('rejects calendar-normalized and noncanonical timestamps rather than presenting them as current', () => {
    const result = projectResourceDisplay(row({ usageObservedAt: '2026-02-30T12:00:00.000Z' }), {
      nowMs: Date.parse('2026-03-02T12:00:00.000Z'), healthRead: true,
    });
    expect(result.usage.current).toBe(false);
    expect(result.usage.observedAt).toBeNull();
    expect(view(row({ usageObservedAt: '2026-01-01 12:00:00' })).usage.observedAt).toBeNull();
  });
  it('does not promote an ended window to current capacity or reset its percentage', () => {
    const input = row({ windows: [{ id: 'synthetic-week', label: 'weekly window', usedPercent: 43, limitReached: false, resetText: null,
      resetsAt: '2026-01-01T12:00:25.000Z', binding: true }] });
    expect(view(input).usage).toMatchObject({ state: 'retained', current: false, freshness: 'stale', observedAt: OBSERVED });
    expect(input.windows[0]?.usedPercent).toBe(43);
    expect(view(input).status.kind).toBe('not-checked');
  });
  it('keeps current connection evidence while removing usability inferred from stale quota', () => {
    const result = view(row({ usageObservedAt: '2025-01-01T12:00:00.000Z',
      connection: { connection: 'connected', word: 'Connected', tone: 'success', reasons: [], fixKind: 'none', fixCommand: null } }));
    expect(result.usage.current).toBe(false);
    expect(result.status).toMatchObject({ kind: 'not-checked', label: 'Connected', usableAgain: null });
    expect(result.status.detail).toContain('unconfirmed');
    expect(result.status.detail).not.toContain('usable now');
    expect(view(row({ usageObservedAt: null })).status.label).not.toBe('Usable now');
  });
  it('preserves independently qualified credits while quota remains unconfirmed', () => {
    const input = row({ usageObservedAt: '2025-01-01T12:00:00.000Z', credits: 'Synthetic current credit units',
      creditState: 'available', creditBalance: '7', creditSpendControlReached: false });
    expect(view(input)).toMatchObject({ usage: { current: false, freshness: 'stale' },
      status: { label: 'Credits available', usableAgain: null } });
    expect(view(input).status.detail).toContain('current usage unconfirmed');
    expect(view({ ...input, creditSpendControlReached: true }).status.label).toBe('Credits held');
    expect(view({ ...input, lastReading: true }).status.label).not.toBe('Credits available');
  });
  it('never extends the original source expiry through a display-age policy or a captured current flag', () => {
    const captured = row({ quotaCurrent: true });
    const at = (elapsedMs: number) => projectResourceDisplay(captured, {
      nowMs: Date.parse(OBSERVED) + elapsedMs, healthRead: true, maxAgeMs: 24 * 60 * 60_000,
    });
    expect(at(59_999).usage.current).toBe(true);
    for (const elapsedMs of [60_000, 60_001, 300_000]) {
      expect(at(elapsedMs).usage).toMatchObject({ current: false, state: 'retained', freshness: 'stale', observedAt: OBSERVED });
      expect(at(elapsedMs).status.label).not.toBe('Usable now');
    }
  });
  it.each([null, undefined, 'invalid', OBSERVED, '2026-01-01T11:59:59.000Z'])('keeps absent or invalid native expiry unconfirmed: %s', quotaExpiresAt => {
    expect(view(row({ quotaExpiresAt })).usage.current).toBe(false);
  });
  it('rechecks a captured credit fact at its own original deadline without holding fresh quota', () => {
    const captured = row({ credits: 'Synthetic credit units', creditState: 'available', creditBalance: '7',
      creditsExpiresAt: '2026-01-01T12:00:30.000Z' });
    expect(view(captured).usage.current).toBe(true);
    expect(view(captured).credit.current).toBe(false);
    expect(view(captured).status.label).not.toBe('Credits available');
    const quotaExpired = { ...captured, quotaExpiresAt: '2026-01-01T12:00:25.000Z', creditsExpiresAt: '2026-01-01T12:01:00.000Z' };
    expect(view(quotaExpired)).toMatchObject({ usage: { current: false }, credit: { current: true }, status: { label: 'Credits available' } });
    expect(view({ ...captured, creditState: 'unknown', creditsExpiresAt: '2026-01-01T12:01:00.000Z' }).credit.current).toBe(false);
  });
});
