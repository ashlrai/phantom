import { describe, expect, it } from 'vitest';
import type { ResourceLaneRow } from '../../routes/verse/usage/fleet-ledger-model.js';
import { projectResetWaste } from './reset-waste-model.js';

const NOW = Date.parse('2026-10-31T19:28:00.000Z');
const inHours = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

function lane(overrides: Partial<ResourceLaneRow> = {}): ResourceLaneRow {
  return {
    lane: 'devin', running: 10, target: 10, held: false,
    window: 'credits', usedPct: 0, creditsRemaining: null,
    resetAt: inHours(9), burnPctPerHour: 0, tokensPerHour6h: null,
    projectedExhaustion: null, source: 'status', deadSignal: null,
    ...overrides,
  };
}

describe('projectResetWaste', () => {
  it('flags a credits lane resetting soon with everything unused', () => {
    const out = projectResetWaste(lane(), NOW);
    expect(out).toEqual({
      state: 'wasting', hoursToReset: 9, unusedPct: 100,
      projectedUnusedPct: 100, idleSlots: 0,
    });
  });

  it('stays on-track when the lane has already spent most of the window', () => {
    const out = projectResetWaste(lane({ usedPct: 90 }), NOW);
    expect(out).toEqual(expect.objectContaining({ state: 'on-track', unusedPct: 10, projectedUnusedPct: 10 }));
  });

  it('stays on-track when the reset is days away', () => {
    const out = projectResetWaste(lane({ resetAt: inHours(72) }), NOW);
    expect(out).toEqual(expect.objectContaining({ state: 'on-track', hoursToReset: 72 }));
  });

  it('is unknown when resetAt is missing or invalid', () => {
    for (const resetAt of [null, 'not-a-date', '2026-13-40T99:99:99Z']) {
      const out = projectResetWaste(lane({ resetAt }), NOW);
      expect(out).toEqual(expect.objectContaining({ state: 'unknown', hoursToReset: null, projectedUnusedPct: null }));
    }
  });

  it('subtracts the burn rate across the hours left before reset', () => {
    const out = projectResetWaste(lane({ window: 'weekly', usedPct: 40, burnPctPerHour: 2 }), NOW);
    expect(out).toEqual(expect.objectContaining({ state: 'wasting', unusedPct: 60, projectedUnusedPct: 42 }));
  });

  it('drops to on-track when the burn will spend the window down in time', () => {
    const out = projectResetWaste(lane({ window: 'weekly', usedPct: 40, burnPctPerHour: 4 }), NOW);
    expect(out).toEqual(expect.objectContaining({ state: 'on-track', projectedUnusedPct: 24 }));
  });

  it('treats a null burn as zero instead of dropping the projection', () => {
    const out = projectResetWaste(lane({ burnPctPerHour: null }), NOW);
    expect(out.projectedUnusedPct).toBe(100);
  });

  it('reads percent-denominated creditsRemaining on credits lanes', () => {
    const out = projectResetWaste(lane({ usedPct: null, creditsRemaining: 95 }), NOW);
    expect(out).toEqual(expect.objectContaining({ state: 'wasting', unusedPct: 95 }));
  });

  it('stays unknown when a credits lane only reports an absolute balance', () => {
    const out = projectResetWaste(lane({ usedPct: null, creditsRemaining: 6000 }), NOW);
    expect(out).toEqual(expect.objectContaining({ state: 'unknown', unusedPct: null }));
  });

  it('stays unknown for windows with no cap tracked', () => {
    const out = projectResetWaste(lane({ window: 'none', usedPct: null }), NOW);
    expect(out.state).toBe('unknown');
  });

  it('uses the lower reading when usedPct and percent credits disagree', () => {
    const out = projectResetWaste(lane({ usedPct: 30, creditsRemaining: 95 }), NOW);
    expect(out.unusedPct).toBe(70);
  });

  it('marks the wasting boundary exactly: 25% projected within 24h', () => {
    expect(projectResetWaste(lane({ window: 'weekly', usedPct: 75 }), NOW).state).toBe('wasting');
    expect(projectResetWaste(lane({ window: 'weekly', usedPct: 76 }), NOW).state).toBe('on-track');
    expect(projectResetWaste(lane({ window: 'weekly', usedPct: 0, resetAt: inHours(24) }), NOW).state).toBe('wasting');
    expect(projectResetWaste(lane({ window: 'weekly', usedPct: 0, resetAt: inHours(24.1) }), NOW).state).toBe('on-track');
  });

  it('counts a reset that has already passed as zero hours, not negative', () => {
    const out = projectResetWaste(lane({ resetAt: inHours(-2) }), NOW);
    expect(out).toEqual(expect.objectContaining({ hoursToReset: 0, projectedUnusedPct: 100, state: 'wasting' }));
  });

  it('reports idle dispatch slots only when both counts exist', () => {
    expect(projectResetWaste(lane({ running: 7, target: 10 }), NOW).idleSlots).toBe(3);
    expect(projectResetWaste(lane({ running: null, target: 10 }), NOW).idleSlots).toBeNull();
    expect(projectResetWaste(lane({ running: 10, target: null }), NOW).idleSlots).toBeNull();
  });
});
