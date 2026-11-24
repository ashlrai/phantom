import { createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ThroughputCounts, ThroughputHour, ThroughputReport } from '../../../../core/fleet/throughput.js';
import { columnWhen } from '../models/model-work-model.js';
import { ThroughputPane } from './ThroughputPane.js';

const NONE: ThroughputCounts = { launched: null, published: null, merged: null, finished: null, empty: null, empty_rate: null, median_publish_to_merge_s: null, merge_time_unknown: null };
const ZERO: ThroughputCounts = { ...NONE, launched: 0, published: 0, merged: 0, finished: 0, empty: 0, merge_time_unknown: 0 };
const hoursOf = (at: Readonly<Record<number, Partial<ThroughputCounts>>>, rest: ThroughputCounts = ZERO): ThroughputHour[] =>
  Array.from({ length: 6 }, (_, i) => ({ start: new Date(Date.UTC(2026, 10, 17, 6 + i)).toISOString(), ...rest, ...at[i] }));
// Plainly made-up counts. Hour 2 has a finished, timed merge; hour 5 is the busiest and finished nothing.
const FLEET = hoursOf({ 2: { launched: 4, published: 3, merged: 2, finished: 4, empty: 1, empty_rate: 0.25, median_publish_to_merge_s: 120 }, 5: { launched: 6, published: 1 } });
const report = (metrics: 'ok' | 'unreadable' = 'ok'): ThroughputReport => ({
  schema: 'throughput.v1', as_of: '2026-11-17T12:00:00.000Z', since: '2026-11-17T06:00:00.000Z', hours: 6, by: 'lane', metrics_path: '/fake/jobs.jsonl',
  metrics, malformed_lines: 0, main: 'green', headline: '2 merged in the last 6 hours, median 2m 0s',
  totals: metrics === 'ok' ? { ...ZERO, launched: 10, published: 4, merged: 2, finished: 4, empty: 1, empty_rate: 0.25, median_publish_to_merge_s: 120 } : NONE,
  buckets: metrics === 'ok' ? FLEET : hoursOf({}, NONE),
  groups: metrics === 'ok' ? [
    { name: 'claude', totals: { ...ZERO, launched: 9, published: 3, merged: 2 }, buckets: hoursOf({ 2: { launched: 3, published: 2, merged: 2 }, 5: { launched: 6, published: 1 } }) },
    { name: 'grok', totals: { ...ZERO, launched: 1, published: 1 }, buckets: hoursOf({ 2: { launched: 1, published: 1 } }) },
    { name: 'lost', totals: NONE, buckets: hoursOf({}, NONE) },
  ] : [],
});
const state = vi.hoisted(() => ({ status: 'success', data: undefined as unknown }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => state, useRefetch: () => () => undefined }));
vi.mock('../../../data/client.js', () => ({ apiGet: vi.fn() }));
const show = (data: unknown) => {
  state.data = data;
  return render(<ThroughputPane {...({ visible: true } as Parameters<typeof ThroughputPane>[0])} />);
};
beforeEach(() => { state.data = undefined; });

const when = (index: number) => columnWhen({ start: FLEET[index]!.start, hours: 1 });
const tiles = () => within(screen.getByRole('list', { name: 'Figures for the last 6 hours' })).getAllByRole('listitem').map(tile => tile.textContent);
const fleetRow = () => screen.getByRole('slider', { name: 'Fleet jobs launched, a bar per hour: most in one bar 6' });
const laneRow = (lane: string, most: number) => screen.getByRole('slider', { name: `${lane} jobs launched, a bar per hour: most in one bar ${most}` });
const column = (row: HTMLElement, index: number) => row.children[index] as HTMLElement;
const heldAt = (row: HTMLElement) => [...row.children].findIndex(child => child.hasAttribute('data-at'));

it('draws the fleet hours and every lane as rows of bars on one scale, and names the busiest bar while none is held', () => {
  const { container } = show(report());
  expect(fleetRow().children).toHaveLength(6);
  expect(container.querySelector('[data-throughput-hours]')!.textContent).toContain(`Busiest: ${when(5)}, 6 launched.`);
  expect(container.querySelector('[data-cursor-line]')).toBeNull();
  // Bars are jobs launched, the mark under a bar is a PR merged.
  expect([...fleetRow().children].map(bar => bar.hasAttribute('data-merged'))).toEqual([false, false, true, false, false, false]);
  expect(column(fleetRow(), 5).querySelector('i')!.style.height).toBe('100%');
  // Lanes share one scale: grok's one launch stands against claude's six.
  expect(column(laneRow('claude', 6), 5).querySelector('i')!.style.height).toBe('100%');
  expect(column(laneRow('grok', 1), 2).querySelector('i')!.style.height).toBe('17%');
  const cards = within(screen.getByRole('list', { name: 'Lanes, most merged first' })).getAllByRole('listitem');
  expect(within(cards[0]!).getByText(`Busiest: ${when(5)}, 6 launched`)).toBeTruthy();
  // A lane the report holds no hours for gets no bars, not a row of empty ones.
  expect(cards[2]!.getAttribute('data-lane')).toBe('lost');
  expect(within(cards[2]!).queryByRole('slider')).toBeNull();
  expect(tiles()[0]).toMatch(/^Launched10Most in one hour: 6, from /);
});

it('holds the hour pointed at on the figures, the fleet row and every lane card, and lets go when the pointer leaves', () => {
  const { container } = show(report());
  fireEvent.mouseEnter(column(laneRow('grok', 1), 2));
  expect(tiles()).toEqual([
    'Launched4In this hour', 'Published3In this hour', 'Merged2In this hour',
    'Changed nothing25%1 of 4 finished jobs, in this hour', 'Median to merge2m 0sFrom publish to merge, in this hour',
  ]);
  expect(container.querySelector('[data-cursor-line]')!.textContent).toBe(`${when(2)}: 4 jobs launched, 3 PRs published, 2 PRs merged, 1 of 4 finished jobs changed nothing.`);
  expect([fleetRow(), laneRow('claude', 6), laneRow('grok', 1)].map(heldAt)).toEqual([2, 2, 2]);
  const cards = within(screen.getByRole('list', { name: 'Lanes, most merged first' })).getAllByRole('listitem');
  expect(within(cards[0]!).getByText(`${when(2)}: launched 3, published 2, merged 2`)).toBeTruthy();
  expect(within(cards[1]!).getByText(`${when(2)}: launched 1, published 1, merged 0`)).toBeTruthy();
  // The card's own figures stay the window's.
  expect(within(cards[0]!).getByText('9')).toBeTruthy();
  fireEvent.mouseLeave(laneRow('grok', 1));
  expect(container.querySelector('[data-cursor-line]')).toBeNull();
  expect(tiles()[0]).toMatch(/^Launched10Most in one hour/);
  expect([fleetRow(), laneRow('claude', 6)].map(heldAt)).toEqual([-1, -1]);
});

it('reads from the keyboard: focus holds the newest bar, the arrows step, and Esc lets go once', () => {
  show(report());
  const row = fleetRow();
  expect([row.getAttribute('aria-valuemin'), row.getAttribute('aria-valuemax'), row.getAttribute('aria-valuenow'), row.tabIndex]).toEqual(['1', '6', '6', 0]);
  fireEvent.focus(row);
  expect(heldAt(laneRow('claude', 6))).toBe(5);
  // The busiest hour finished no job and merged no PR: worded, not drawn as a 0% rate or a zero median.
  expect(tiles().slice(3)).toEqual(['Changed nothingno rateNo job finished in this hour.', 'Median to mergeunknownNo PR merged in this hour.']);
  for (let step = 0; step < 3; step += 1) fireEvent.keyDown(row, { key: 'ArrowLeft' });
  expect(row.getAttribute('aria-valuenow')).toBe('3');
  expect(row.getAttribute('aria-valuetext')).toBe(`${when(2)}: 4 jobs launched, 3 PRs published, 2 PRs merged, 1 of 4 finished jobs changed nothing.`);
  expect(laneRow('grok', 1).getAttribute('aria-valuetext')).toBe(`${when(2)}: launched 1, published 1, merged 0`);
  fireEvent.keyDown(row, { key: 'Home' });
  fireEvent.keyDown(row, { key: 'ArrowLeft' });
  expect(heldAt(row)).toBe(0);
  fireEvent.keyDown(row, { key: 'End' });
  expect(heldAt(row)).toBe(5);
  // A modified arrow is somebody else's key.
  fireEvent.keyDown(row, { key: 'ArrowLeft', metaKey: true });
  expect(heldAt(row)).toBe(5);
  const first = createEvent.keyDown(row, { key: 'Escape' });
  fireEvent(row, first);
  expect([first.defaultPrevented, heldAt(row)]).toEqual([true, -1]);
  // With nothing held, Esc is left for whatever closes the pane.
  const second = createEvent.keyDown(row, { key: 'Escape' });
  fireEvent(row, second);
  expect(second.defaultPrevented).toBe(false);
});

it('keeps the bar held while focus moves from one row to another, and lets go when it leaves the rows', () => {
  show(report());
  fireEvent.focus(fleetRow());
  fireEvent.keyDown(fleetRow(), { key: 'Home' });
  fireEvent.blur(fleetRow(), { relatedTarget: laneRow('claude', 6) });
  expect(heldAt(laneRow('claude', 6))).toBe(0);
  fireEvent.blur(laneRow('claude', 6), { relatedTarget: screen.getByRole('radio', { name: '24 hours' }) });
  expect(heldAt(fleetRow())).toBe(-1);
});

it('draws no bars for a metrics file that could not be read', () => {
  const { container } = show(report('unreadable'));
  expect(screen.queryByRole('slider')).toBeNull();
  expect(container.querySelector('[data-throughput-hours]')).toBeNull();
});
