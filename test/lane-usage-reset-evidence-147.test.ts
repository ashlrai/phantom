import { describe, expect, it } from 'vitest';
import { budgetEntryQuota, refreshLanes, type LaneState, type SelfLane } from '../src/core/fabric/lane-usage-self.js';
import { quotaEvidence, type QuotaMeasurement } from '../src/core/fleet/resource-reset-evidence.js';

const now = Date.parse('2026-11-11T12:00:00Z');
const at = (offset: number): string => new Date(now + offset).toISOString();
const state = (resetAt: string): LaneState => ({
  asOf: at(-3_600_000), pctUsed: 100, resetAt, unitsPerPct: 100, limit: 10_000,
});

describe('usage reset evidence', () => {
  it.each([
    { captured: -2001, reason: 'quota-recovered', conflict: 'recovered-quota-while-held' },
    { captured: -2000, reason: 'measured-quota', conflict: null },
    { captured: -1999, reason: 'measured-quota', conflict: null },
  ])('qualifies dispatcher exhaustion captured at offset $captured', ({ captured, reason, conflict }) => {
    const status: QuotaMeasurement = { lane: 'claude', window: 'weekly', usedPct: 100,
      resetAt: at(-2000), source: 'dispatcher', observedAt: at(captured) };
    const measured: QuotaMeasurement = { ...status, usedPct: 10, resetAt: at(3_600_000),
      source: 'claude-native-usage', observedAt: at(-1000) };
    expect(quotaEvidence(status, measured, true, now)).toMatchObject({
      state: 'observed-headroom', reason, holdConflict: conflict, statusQuota: status, measuredQuota: measured,
    });
  });

  it.each(['claude', 'codex-personal'] as const)('%s does not infer renewal from a passed reset', async lane => {
    const previous = { weekly_used_pct: 100, reset_at: at(-1), as_of: at(-3_600_000), estimated: false };
    const result = await refreshLanes({ lanes: [lane], overrides: { [lane]: previous },
      state: { [lane]: state(at(-1)) }, rows: [], nowMs: now,
      readers: { [lane]: async () => { throw new Error('unavailable'); } } });
    expect(result.outcomes[0]).toMatchObject({ action: 'unknown', entry: { weekly_used_pct: null, reset_at: null } });
    expect(budgetEntryQuota(result.overrides[lane], now).value).toBeNull();
  });

  it('accepts a fresh sanctioned zero after the old reset', async () => {
    const lane: SelfLane = 'claude';
    const result = await refreshLanes({ lanes: [lane], overrides: {}, state: { claude: state(at(-1)) }, rows: [], nowMs: now,
      readers: { claude: async () => ({ pctUsed: 0, resetAt: at(3_600_000), source: 'sanctioned' }) } });
    expect(result.outcomes[0]).toMatchObject({ action: 'read', entry: { weekly_used_pct: 0, estimated: false } });
    expect(budgetEntryQuota(result.overrides[lane], now).value).toEqual({ usedPercent: 0 });
  });

  it('does not retain an old reading merely because its reset is in the future', async () => {
    const result = await refreshLanes({ lanes: ['claude'], overrides: { claude: {
      weekly_used_pct: 25, reset_at: at(3_600_000), as_of: at(-1001), estimated: false,
    } }, state: {}, rows: [], nowMs: now, maxAgeMs: 1000, readers: { claude: async () => null } });
    expect(result.outcomes[0]).toMatchObject({ action: 'unknown', entry: { weekly_used_pct: null } });
  });

  it('keeps pre-reset accounting estimates actionable', async () => {
    const result = await refreshLanes({ lanes: ['claude'], overrides: {}, state: { claude: {
      ...state(at(3_600_000)), pctUsed: 40,
    } }, rows: [{ event: 'finish', lane: 'claude', ts: at(-1000), tokens_total: 1000 }], nowMs: now, readers: {} });
    expect(result.outcomes[0]).toMatchObject({ action: 'estimated', entry: { weekly_used_pct: 50, estimated: true, reset_at: at(3_600_000) } });
    expect(budgetEntryQuota(result.overrides['claude'], now).value).toEqual({ usedPercent: 50 });
  });

  it('rejects a recently written entry at and after its reset boundary', () => {
    const entry = { weekly_used_pct: 0, as_of: at(0), reset_at: at(0) };
    expect(budgetEntryQuota(entry, now).value).toBeNull();
    expect(budgetEntryQuota({ ...entry, reset_at: at(-1) }, now).value).toBeNull();
    expect(budgetEntryQuota({ ...entry, reset_at: at(1) }, now).value).toEqual({ usedPercent: 0 });
  });
});
