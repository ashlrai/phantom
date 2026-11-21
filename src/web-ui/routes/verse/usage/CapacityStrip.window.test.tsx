/**
 * The capacity strip's usage window is the shared WindowBar. Where the seat's reset provenance holds the
 * window's start, the full strip marks how far the window's time has run and says so under the bar; a window
 * with no known start, the compact strip, and a reading that is no longer current get no mark and no line.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { startClock } from '../fleet-usage/window-pace-model.js';
import { capacity, nativeSeat, seatWindow } from '../seat-fixtures.test-support.js';
import { CapacityStrip } from './CapacityStrip.js';

const NOW = Date.now();
const DAY = 86_400_000;
const RESET = new Date(NOW + 2 * DAY).toISOString();
const START = new Date(NOW + 2 * DAY - 7 * DAY).toISOString();
const weekly = (at: string) => ({ kind: 'weekly-deadline' as const, at, description: null, source: 'claude-native-usage-report', plan: 'max' as const });

const parts = (meter: HTMLElement) => [...meter.children].map(part => [part.getAttribute('data-part'), (part as HTMLElement).style.width || (part as HTMLElement).style.left]);

function seat(provenanceAt: string, over: { usedPercent?: number | null; quotaExpiresAt?: string } = {}) {
  const week = seatWindow({ id: 'seven_day', usedPercent: over.usedPercent === undefined ? 62 : over.usedPercent, resetsAt: RESET, resetProvenance: weekly(provenanceAt) });
  return nativeSeat(capacity({ planType: 'max', windows: [week], binding: week, usability: 'ready', observedAt: new Date(NOW - 60_000).toISOString(),
    ...(over.quotaExpiresAt ? { quotaExpiresAt: over.quotaExpiresAt } : {}) }), { id: 'claude-week', label: 'Claude week' });
}

const strip = (s: ReturnType<typeof seat>, density: 'full' | 'compact' = 'full') =>
  render(<CapacityStrip seats={[s]} density={density} accounts={{ healthRead: true, now: NOW }} />);

afterEach(cleanup);

describe('CapacityStrip usage window', () => {
  it('marks how far a weekly window has run and says how use sits against an even spend', () => {
    strip(seat(RESET));
    const meter = screen.getByRole('meter', { name: 'Claude week weekly window' });
    expect(parts(meter)).toEqual([['used', '62%'], ['elapsed', '71.4%']]);
    expect(meter).toHaveAttribute('aria-valuenow', '62');
    expect(meter.getAttribute('aria-valuetext')).toMatch(/^62% used, resets .+, 71% of the window gone$/);
    const line = meter.parentElement!.querySelector('[data-pace]')!;
    expect(line).toHaveAttribute('data-pace', 'behind');
    expect(line.textContent).toBe(`71% of the window gone · use is 9 points behind an even spend · began about ${startClock(NOW)(START)}, seven days before its reset`);
    expect(line.querySelector('i')).toHaveAttribute('data-part', 'elapsed');
  });

  it('draws no time mark and no line when the provenance names a different reset than the window', () => {
    strip(seat(new Date(NOW + 3 * DAY).toISOString()));
    const meter = screen.getByRole('meter', { name: 'Claude week weekly window' });
    expect(parts(meter)).toEqual([['used', '62%']]);
    expect(meter.getAttribute('aria-valuetext')).not.toMatch(/window gone/);
    expect(meter.parentElement!.querySelector('[data-pace]')).toBeNull();
  });

  it('keeps the compact strip to the bar alone', () => {
    strip(seat(RESET), 'compact');
    const meter = screen.getByRole('meter', { name: 'Claude week weekly window' });
    expect(parts(meter)).toEqual([['used', '62%']]);
    expect(meter.parentElement!.querySelector('[data-pace]')).toBeNull();
  });

  it('reads nothing against time for a reading that is no longer current', () => {
    strip(seat(RESET, { quotaExpiresAt: new Date(NOW - 1_000).toISOString() }));
    const meter = screen.getByRole('meter', { name: 'Claude week weekly window' });
    expect(meter).toHaveAttribute('data-unread');
    expect(meter).not.toHaveAttribute('aria-valuenow');
    expect(parts(meter)).toEqual([]);
    expect(meter.parentElement!.querySelector('[data-pace]')).toBeNull();
    expect(screen.getByText('62% used · last')).toBeInTheDocument();
  });
});
