/**
 * An account card's usage window is the shared WindowBar: used so far, the reserve as a band at the window's
 * end, and a mark for the time gone only where the seat's reset provenance holds the window's start. A flagged
 * limit is a full bar with no percentage; no reading, or one that is no longer current, is a hatched track.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { startClock } from '../fleet-usage/window-pace-model.js';
import { capacity, nativeSeat, seatWindow } from '../seat-fixtures.test-support.js';
import { accountStatus, buildCapacityRows, type CapacityRow, type CapacityWindowRow } from '../usage/capacity-strip-model.js';
import { ResourceCard } from './ResourceCard.js';

const NOW = Date.now();
const DAY = 86_400_000;
const RESET = new Date(NOW + 2 * DAY).toISOString();
const START = new Date(NOW + 2 * DAY - 7 * DAY).toISOString();
const weekly = (at: string) => ({ kind: 'weekly-deadline' as const, at, description: null, source: 'claude-native-usage-report', plan: 'max' as const });

const parts = (meter: HTMLElement) => [...meter.children].map(part => [part.getAttribute('data-part'), (part as HTMLElement).style.width || (part as HTMLElement).style.left]);

function seatRow(provenanceAt: string): CapacityRow {
  const week = seatWindow({ id: 'seven_day', usedPercent: 62, resetsAt: RESET, resetProvenance: weekly(provenanceAt) });
  const seat = nativeSeat(capacity({ planType: 'max', windows: [week], binding: week, usability: 'ready', observedAt: new Date(NOW - 60_000).toISOString() }), { id: 'claude-week', label: 'Claude week' });
  return buildCapacityRows([seat], { now: NOW })[0]!;
}

const window_ = (over: Partial<CapacityWindowRow> = {}): CapacityWindowRow => ({
  id: 'weekly', label: 'weekly window', usedPercent: 62, limitReached: false, resetText: 'resets Sat 11:46 PM', resetsAt: RESET, binding: true,
  period: { startsAt: START, basis: 'weekly' }, ...over,
});
const literal = (w: CapacityWindowRow, over: Partial<CapacityRow> = {}): CapacityRow => ({
  seatId: 'seat-a', label: 'Account A', engine: 'claude', monogram: 'C', kind: 'subscription', plan: null,
  cls: 'ready' as CapacityRow['cls'], word: 'ready', summary: '', connection: null, credits: null, windows: [w],
  reserve: null, notes: [], localCount: 1, checkedAt: null, resetAt: null, signedOut: false, ...over,
});

function card(row: CapacityRow) {
  const status = accountStatus(row, { now: NOW, healthRead: true, checking: false });
  render(<ResourceCard row={row} status={status} settled={status} mode={null} busy={null} onAction={() => {}} resetNowMs={NOW} />);
}

afterEach(cleanup);

describe('ResourceCard usage window', () => {
  it('marks how far a weekly window has run from the start the seat reports, and says how use sits against an even spend', () => {
    const row = seatRow(RESET);
    expect(row.windows[0]!.period).toEqual({ startsAt: START, basis: 'weekly' });
    card(row);
    const meter = screen.getByRole('meter', { name: 'Claude week weekly window' });
    expect(parts(meter)).toEqual([['used', '62%'], ['elapsed', '71.4%']]);
    expect(meter).toHaveAttribute('aria-valuenow', '62');
    expect(meter.getAttribute('aria-valuetext')).toMatch(/^62% used, resets .+, 71% of the window gone$/);
    const line = meter.parentElement!.querySelector('[data-pace]')!;
    expect(line).toHaveAttribute('data-pace', 'behind');
    expect(line.textContent).toBe(`71% of the window gone · use is 9 points behind an even spend · began about ${startClock(NOW)(START)}, seven days before its reset`);
    expect(line.querySelector('i')).toHaveAttribute('data-part', 'elapsed');
    expect(screen.getByText('62%')).toBeInTheDocument();
  });

  it('draws no time mark and no pace line when the provenance names a different reset than the window', () => {
    const row = seatRow(new Date(NOW + 3 * DAY).toISOString());
    expect(row.windows[0]!.period).toBeUndefined();
    card(row);
    const meter = screen.getByRole('meter', { name: 'Claude week weekly window' });
    expect(parts(meter)).toEqual([['used', '62%']]);
    expect(meter.getAttribute('aria-valuetext')).not.toMatch(/window gone/);
    expect(meter.parentElement!.querySelector('[data-pace], [data-kept]')).toBeNull();
  });

  it('hatches the reserve at the end of the binding window and names it beside its mark', () => {
    card(literal(window_({ period: null }), { reserve: { percent: 40, label: 'Reserved for you 40%' } as CapacityRow['reserve'] }));
    const meter = screen.getByRole('meter', { name: 'Account A weekly window' });
    expect(parts(meter)).toEqual([['used', '62%'], ['kept', '40%']]);
    expect((meter.querySelector('[data-part="kept"]') as HTMLElement).style.left).toBe('60%');
    expect(meter.getAttribute('aria-valuetext')).toBe('62% used; 40% kept for you, resets Sat 11:46 PM');
    const kept = screen.getByText('40% kept for you');
    expect(kept.querySelector('i')).toHaveAttribute('data-part', 'kept');
    expect(kept.parentElement).not.toHaveAttribute('data-pace');
  });

  it('fills a flagged limit in full with no percentage, and still marks the time gone', () => {
    card(literal(window_({ usedPercent: null, limitReached: true })));
    const meter = screen.getByRole('meter', { name: 'Account A weekly window' });
    expect(parts(meter)).toEqual([['used', '100%'], ['elapsed', '71.4%']]);
    expect(meter).toHaveAttribute('data-ending', 'spent');
    expect(meter).not.toHaveAttribute('aria-valuenow');
    expect(meter.getAttribute('aria-valuetext')).toBe('limit reached, resets Sat 11:46 PM, 71% of the window gone');
    expect(screen.getByText('limit reached')).toBeInTheDocument();
    const line = meter.parentElement!.querySelector('[data-pace]')!;
    expect(line).toHaveAttribute('data-pace', 'unread');
    expect(line.textContent).not.toMatch(/even spend/);
  });

  it('hatches a window with no reading: time gone is still said, with no mark to point at', () => {
    card(literal(window_({ usedPercent: null }), { reserve: { percent: 40, label: 'Reserved for you 40%' } as CapacityRow['reserve'] }));
    const meter = screen.getByRole('meter', { name: 'Account A weekly window' });
    expect(meter).toHaveAttribute('data-unread');
    expect(meter.children).toHaveLength(0);
    expect(meter).not.toHaveAttribute('aria-valuenow');
    expect(screen.getByText('no reading')).toBeInTheDocument();
    const line = meter.parentElement!.querySelector('[data-pace]')!;
    expect(line.textContent).toMatch(/^71% of the window gone · began about /);
    expect(line.querySelector('i')).toBeNull();
    expect(screen.queryByText(/kept for you/)).toBeNull();
  });

  it('hatches a reading that is no longer current and reads nothing against time', () => {
    card(literal(window_(), { quotaCurrent: false, reserve: { percent: 40, label: 'Reserved for you 40%' } as CapacityRow['reserve'] }));
    const meter = screen.getByRole('meter', { name: 'Account A weekly window' });
    expect(meter).toHaveAttribute('data-unread');
    expect(meter.children).toHaveLength(0);
    expect(meter.getAttribute('aria-valuetext')).toMatch(/62% used · last reading; current usage and resets unconfirmed/);
    expect(meter.parentElement!.querySelector('[data-pace], [data-kept]')).toBeNull();
    expect(screen.getByText('62% · last')).toBeInTheDocument();
  });
});
