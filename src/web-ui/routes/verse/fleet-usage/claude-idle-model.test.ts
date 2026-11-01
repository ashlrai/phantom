import { describe, expect, it } from 'vitest';
import { claudeIdle } from './claude-idle-model.js';

const hour = 3_600_000;
const start = new Date(2026, 9, 29, 12, 0, 0).getTime();
const base = {
  claudeLane: 'down token rejected 2026-10-29 12:00:00',
  lanes: [{ lane: 'claude', running: 0, target: 12 }],
  usedPercent: 3,
  resetsAt: new Date(2026, 9, 29, 15, 16).toISOString(),
  nowMs: start + 2.4 * hour,
};

describe('claudeIdle', () => {
  it('describes the down time, idle capacity, unused quota, and local reset', () => {
    expect(claudeIdle(base)).toEqual({
      downSinceMs: start, downHours: 2.4, idleSlots: 12, windowLeftPercent: 97,
      hoursToReset: (new Date(base.resetsAt).getTime() - base.nowMs) / hour,
      text: 'Lane down 2.4 h · 12 slots idle · 97% of the weekly window unused · resets Thu 15:16', tone: 'danger',
    });
  });

  it('omits unavailable facts and accepts down text without a timestamp', () => {
    expect(claudeIdle({ ...base, claudeLane: 'DOWN token rejected', usedPercent: null, resetsAt: null })).toEqual({
      downSinceMs: null, downHours: null, idleSlots: 12, windowLeftPercent: null, hoursToReset: null,
      text: 'Lane down · 12 slots idle', tone: 'warn',
    });
  });

  it('returns null for a healthy lane or a zero target', () => {
    expect(claudeIdle({ ...base, claudeLane: 'healthy' })).toBeNull();
    expect(claudeIdle({ ...base, lanes: [{ lane: 'claude', running: 0, target: 0 }] })).toBeNull();
  });

  it('uses the exact one-hour and 24-hour / 50-percent boundaries', () => {
    const check = (downHours: number, hoursToReset: number, usedPercent: number) => claudeIdle({
      ...base, claudeLane: `down ${new Date(start).toISOString()}`, nowMs: start + downHours * hour,
      resetsAt: new Date(start + (downHours + hoursToReset) * hour).toISOString(), usedPercent,
    })?.tone;
    expect(check(0.999, 25, 3)).toBe('warn');
    expect(check(1, 25, 3)).toBe('danger');
    expect(check(0.5, 24, 50)).toBe('danger');
    expect(check(0.5, 24.001, 50)).toBe('warn');
    expect(check(0.5, 24, 50.001)).toBe('warn');
  });
});
