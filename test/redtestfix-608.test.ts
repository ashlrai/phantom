import { describe, expect, it } from 'vitest';
import { budgetEntryQuota, estimateLane, refreshLanes, type LaneState } from '../src/core/fabric/lane-usage-self.js';

// Recovers #6351: elapsed reset time is not evidence of renewed allowance.
const reset = Date.parse('2026-11-18T12:00:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const calibration: LaneState = {
  asOf: iso(reset - 3_600_000), pctUsed: 100, resetAt: iso(reset),
  unitsPerPct: 100, limit: 10_000,
};

describe('redtestfix 608: expired calibration cannot renew quota', () => {
  it.each(['claude', 'codex-personal', 'devin'] as const)(
    '%s stays unknown at the reset and across multiple presumed windows', async lane => {
      for (const elapsed of [0, 1, 15 * 86_400_000]) {
        const nowMs = reset + elapsed;
        const rows = [{ event: 'finish', lane, ts: iso(nowMs - 1), tokens_total: 500, acus: 5 }];
        expect(estimateLane(lane, calibration, rows, nowMs)).toBeNull();
        const result = await refreshLanes({
          lanes: [lane], overrides: {}, state: { [lane]: calibration }, rows, nowMs,
          readers: { [lane]: async () => { throw new Error('fake-reader-unavailable'); } },
        });
        expect(result.outcomes).toEqual([{
          lane, action: 'unknown', entry: {
            weekly_used_pct: null, credits_remaining: null, reset_at: null,
            source: 'unknown:no-reading-or-estimate', estimated: false,
            as_of: iso(nowMs), burn_pct_per_hour: null,
          },
        }]);
        expect(budgetEntryQuota(result.overrides[lane], nowMs).value).toBeNull();
        expect(result.state[lane]).toEqual(calibration);
      }
      expect(estimateLane(lane, calibration, [], reset - 1)).toMatchObject({
        weekly_used_pct: 100, reset_at: iso(reset), estimated: true,
      });
    },
  );
});
