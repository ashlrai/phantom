import { describe, expect, it } from 'vitest';
import { resetsTimeline } from './resets-timeline.js';

const now = Date.parse('2026-11-10T12:00:00.000Z');
const reading = (label: string, hours: number | null, usedPercent: number | null) => ({
  label, windows: hours === null ? [] : [{ resetsAt: new Date(now + hours * 3_600_000).toISOString(), usedPercent }],
});

describe('resetsTimeline', () => {
  it('sorts future resets, keeps unknown usage, and collects missing or stale resets', () => {
    const result = resetsTimeline([reading('Later', 20, 70), reading('Unknown', 2, null), reading('Missing', null, null), reading('Stale', -1, 10)], now);
    expect(result.rows.map(row => row.label)).toEqual(['Unknown', 'Later']);
    expect(result.rows[0].percentLeft).toBeNull();
    expect(result.noReading).toEqual(['Missing', 'Stale']);
  });
  it('tags only resets under 12 hours with at least 25 percent left', () => {
    const result = resetsTimeline([reading('Edge time', 12, 75), reading('Edge percent', 11.99, 75), reading('Below percent', 1, 75.01), reading('Unknown', 1, null)], now);
    expect(Object.fromEntries(result.rows.map(row => [row.label, row.useIt]))).toEqual({ 'Edge time': false, 'Edge percent': true, 'Below percent': false, Unknown: false });
  });
});
