import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { capacity, nativeSeat, seatWindow } from '../seat-fixtures.test-support.js';
import { CapacityStrip } from './CapacityStrip.js';
import { accountStatus, buildCapacityRows } from './capacity-strip-model.js';

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const RESET = '2026-11-02T12:00:00.000Z';

describe('weekly-only Claude capacity strip', () => {
  it.each([false, true])('renders weekly usage with limitReached=%s and no session row', (limitReached) => {
    const week = seatWindow({ id: 'seven_day', usedPercent: 62, resetsAt: RESET, limitReached });
    const opus = seatWindow({ id: 'seven_day_opus', usedPercent: 20, resetsAt: RESET });
    const seat = nativeSeat(capacity({ windows: [week, opus], usability: limitReached ? 'exhausted' : 'ready' }));
    const row = buildCapacityRows([seat], { now: NOW })[0]!;
    expect(row.summary).toBe(limitReached ? 'weekly window limit reached' : '62% of weekly window used');
    expect(row.resetAt).toBe(RESET);
    expect(row.quotaReadReason).toBeNull();
    expect(row.windows.map((w) => w.id)).toEqual(['seven_day', 'seven_day_opus']);
    expect(accountStatus(row, { now: NOW, checking: false, healthRead: true }).detail)
      .toContain('Anthropic removed the 5-hour limit on this plan. Only the weekly window applies.');
    render(createElement(CapacityStrip, { seats: [seat], accounts: { healthRead: true, now: NOW } }));
    expect(screen.getByText(/Anthropic removed the 5-hour limit/)).toBeInTheDocument();
    expect(screen.queryByText(/5-hour window|rolling 5h/)).toBeNull();
  });

  it.each(['codex', 'grok'] as const)('adds no lifted-limit note to %s', (engine) => {
    const week = seatWindow({ id: 'seven_day', usedPercent: 62, resetsAt: RESET });
    const row = buildCapacityRows([nativeSeat(capacity({ windows: [week], binding: week, usability: 'ready' }), { engine })], { now: NOW })[0]!;
    expect(row.notes).not.toContain('Anthropic removed the 5-hour limit on this plan. Only the weekly window applies.');
    expect(accountStatus(row, { now: NOW, checking: false, healthRead: true }).detail ?? '').not.toContain('5-hour limit');
  });
});
