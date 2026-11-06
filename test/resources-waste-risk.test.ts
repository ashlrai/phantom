import { describe, expect, it, vi } from 'vitest';
import { projectWasteRisk, type WasteRiskInput } from '../src/core/resources/waste-risk.js';
import { notifyWasteRiskTransition } from '../src/core/resources/waste-risk-notify.js';
import type { AshlrConfig } from '../src/core/types.js';
import { desktopNotify } from '../src/core/integrations/desktop-notify.js';
vi.mock('../src/core/integrations/desktop-notify.js', () => ({ desktopNotify: vi.fn().mockResolvedValue(true) }));
const base: WasteRiskInput = {
  lane: 'codex-personal', used: 50, limit: 100,
  window_start: '2026-11-01T00:00:00Z', reset_at: '2026-11-04T00:00:00Z',
  now: '2026-11-03T12:00:00Z', burn_per_hour: 1, running: 2,
  per_job_cost: 2, ceiling: 20,
};
describe('included usage waste projection', () => {
  it.each([
    ['late unused', {}, 'high', 8, 62, 38],
    ['unknown reset', { reset_at: null }, 'unknown', null, null, null],
    ['held lane', { held: true }, 'high', 0, 62, 38],
    ['zero burn', { burn_per_hour: 0 }, 'high', null, 50, 50],
    ['bootstrap duration', { burn_per_hour: 0, job_duration_hours: 1 }, 'high', 2, 50, 50],
    ['exhausted', { used: 100 }, 'low', 0, 100, 0],
    ['overdrawn', { used: 110 }, 'low', 0, 100, 0],
    ['ceiling', { ceiling: 3 }, 'high', 3, 62, 38],
    ['medium', { used: 80 }, 'medium', 3, 92, 8],
    ['low', { used: 85 }, 'low', 2, 97, 3],
    ['expired reset', { now: base.reset_at! }, 'unknown', null, null, null],
    ['unknown burn', { burn_per_hour: null }, 'unknown', null, null, null],
    ['invalid limit', { limit: NaN }, 'unknown', null, null, null],
    ['paid missing guard', { lane: 'claude-api' }, 'high', 0, 62, 38],
    ['paid guarded', { lane: 'claude-api', credit_guard: 3 }, 'high', 0, 62, 38],
    ['paid affordable', { lane: 'claude-api', credit_guard: 12 }, 'high', 2, 62, 38],
    ['paid depleted', { lane: 'claude-api', credit_guard: 0 }, 'high', 0, 62, 38],
    ['no job cost', { per_job_cost: null }, 'high', null, 62, 38],
    ['idle unknown throughput', { running: 0 }, 'high', null, 62, 38],
  ] as const)('%s', (_name, patch, risk, target, used, unused) => {
    const result = projectWasteRisk({ ...base, ...patch });
    expect(result).toMatchObject({ waste_risk: risk, recommended_target: target,
      projected_used_at_reset: used, projected_unused_at_reset: unused });
  });
  it('uses strict risk thresholds and window cutoff', () => {
    expect(projectWasteRisk({ ...base, used: 73 }).waste_risk).toBe('medium');
    expect(projectWasteRisk({ ...base, used: 83 }).waste_risk).toBe('low');
    expect(projectWasteRisk({ ...base, now: '2026-11-02T00:00:00Z', burn_per_hour: 0 }).waste_risk).toBe('medium');
  });
  it('does not mutate the input', () => {
    expect(() => projectWasteRisk(Object.freeze({ ...base }))).not.toThrow();
  });
});
describe('waste desktop transition hook', () => {
  it('notifies once on entry, including entry into the final 24 hours', async () => {
    vi.mocked(desktopNotify).mockClear();
    const high = projectWasteRisk(base);
    const cfg = {} as AshlrConfig;
    expect(await notifyWasteRiskTransition(undefined, high, cfg)).toBe(true);
    expect(await notifyWasteRiskTransition(high, high, cfg)).toBe(false);
    expect(await notifyWasteRiskTransition({ ...high, hours_to_reset: 24 }, high, cfg)).toBe(true);
    expect(await notifyWasteRiskTransition(high, { ...high, reset_at: 'new-window' }, cfg)).toBe(true);
    expect(desktopNotify).toHaveBeenCalledTimes(3);
  });
  it('ignores non-high, expired and distant projections', async () => {
    for (const patch of [{ waste_risk: 'medium' as const }, { hours_to_reset: 24 }, { hours_to_reset: null }, { hours_to_reset: 0 }]) {
      expect(await notifyWasteRiskTransition(undefined, { ...projectWasteRisk(base), ...patch }, {} as AshlrConfig)).toBe(false);
    }
  });
});
