import { describe, expect, it } from 'vitest';
import { paceTarget, projectUsagePace } from '../src/core/usage/pace.js';

const now = Date.parse('2026-11-09T16:00:00Z');
const fixture = { schema: 'dispatchd.status.v1', last_tick: '2026-11-09T16:00:00Z', budget: {
  'codex-personal': { use_it_all: { known: true, stale: false, used_pct: 17, hours_to_reset: 123.6, burn_pct_per_hour: 0.38, projected_used_pct: 64 } },
  claude: { use_it_all: { known: true, stale: true, hours_to_reset: 10, projected_used_pct: 80 } },
}, lanes: { 'codex-personal': { running: 10, hard_cap: 32 } }, admission: { load1: 10, ncpu: 16, load_max: 48 } };
describe('usage pace', () => {
  it('reports only fresh known forecasts and leaves stale and missing pools unknown', () => {
    const { pools } = projectUsagePace(fixture, now);
    expect(pools.find(row => row.pool === 'codex-personal')).toEqual({ pool: 'codex-personal', projectedPercent: 64, hoursLeft: 123.6, recommendedSlots: 18 });
    expect(pools.find(row => row.pool === 'claude')?.projectedPercent).toBeNull();
    expect(pools.find(row => row.pool === 'zai')?.projectedPercent).toBeNull();
  });
  it('recommends slots behind, on and ahead of pace, within both ceilings', () => {
    const lane = { usedPercent: 50, hoursLeft: 10, burnPerHour: 5, running: 10, hardCap: 30, load1: 10, ncpu: 8, loadMax: 24 };
    expect(paceTarget({ ...lane, burnPerHour: 2.5 })).toBe(20);
    expect(paceTarget(lane)).toBe(10);
    expect(paceTarget({ ...lane, burnPerHour: 10 })).toBe(5);
    expect(paceTarget({ ...lane, burnPerHour: 1, hardCap: 12 })).toBe(12);
    expect(paceTarget({ ...lane, burnPerHour: 1, load1: 22 })).toBe(12);
  });
  it('keeps missing, stale, zero-burn and idle evidence unknown', () => {
    const lane = { usedPercent: 50, hoursLeft: 10, burnPerHour: 5, running: 10, hardCap: 30, load1: 10, ncpu: 8, loadMax: 24 };
    expect(paceTarget({ ...lane, burnPerHour: 0 })).toBeNull();
    expect(paceTarget({ ...lane, running: 0 })).toBeNull();
    expect(paceTarget({ ...lane, loadMax: NaN })).toBeNull();
    expect(projectUsagePace(fixture, now + 120_001).pools.every(row => row.recommendedSlots === null)).toBe(true);
  });
  it('expires a whole status and rejects malformed evidence', () => {
    expect(projectUsagePace(fixture, now + 120_001).pools.every(row => row.projectedPercent === null)).toBe(true);
    expect(projectUsagePace(null, now).pools.every(row => row.hoursLeft === null)).toBe(true);
  });
});
