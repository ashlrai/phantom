import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ThroughputCounts, ThroughputReport } from '../../../../core/fleet/throughput.js';
import { ThroughputPane } from './ThroughputPane.js';

const NONE: ThroughputCounts = { launched: null, published: null, merged: null, finished: null, empty: null, empty_rate: null, median_publish_to_merge_s: null, merge_time_unknown: null };
const ZERO: ThroughputCounts = { ...NONE, launched: 0, published: 0, merged: 0, finished: 0, empty: 0, merge_time_unknown: 0 };
const BUSY: ThroughputCounts = { launched: 50, published: 40, merged: 38, finished: 48, empty: 6, empty_rate: 0.125, median_publish_to_merge_s: 170, merge_time_unknown: 2 };
const hours = (last: ThroughputCounts, rest: ThroughputCounts) => Array.from({ length: 6 }, (_, i) => ({ start: new Date(Date.UTC(2026, 10, 17, 6 + i)).toISOString(), ...(i === 5 ? last : rest) }));
function report(kind: 'busy' | 'quiet' | 'unreadable'): ThroughputReport {
  const totals = kind === 'busy' ? BUSY : kind === 'quiet' ? ZERO : NONE, rest = kind === 'unreadable' ? NONE : ZERO;
  return {
    schema: 'throughput.v1', as_of: '2026-11-17T12:00:00.000Z', since: '2026-11-17T06:00:00.000Z', hours: 6, by: 'lane', metrics_path: '/fake/jobs.jsonl',
    metrics: kind === 'unreadable' ? 'unreadable' : 'ok', malformed_lines: kind === 'busy' ? 3 : kind === 'quiet' ? 0 : null, main: kind === 'busy' ? 'green' : 'unknown',
    headline: kind === 'busy' ? '38 merged in the last 6 hours, median 2m 50s' : kind === 'quiet' ? '0 merged in the last 6 hours, median unknown' : 'Merged in the last 6 hours: unknown (cannot read the job metrics file)',
    totals, buckets: hours(totals, rest),
    groups: kind !== 'busy' ? [] : [
      { name: 'claude', totals: { ...BUSY, empty: 1, finished: 40, empty_rate: 0.025 }, buckets: hours(BUSY, ZERO) },
      { name: 'grok', totals: { ...ZERO, launched: 5, finished: 5, empty: 5, empty_rate: 1 }, buckets: hours(ZERO, ZERO) },
      { name: 'idle', totals: ZERO, buckets: hours(ZERO, ZERO) },
    ],
  };
}
const state = vi.hoisted(() => ({ status: 'success', data: undefined as unknown, key: '', fetch: null as null | ((signal: AbortSignal) => unknown) }));
const refetch = vi.hoisted(() => vi.fn());
vi.mock('../../../data/hooks.js', () => ({ useQuery: (def: { key: string; fetch: (signal: AbortSignal) => unknown }) => { state.key = def.key; state.fetch = def.fetch; return state; }, useRefetch: () => refetch }));
const get = vi.hoisted(() => vi.fn());
vi.mock('../../../data/client.js', () => ({ apiGet: get }));
const show = (data: unknown, status = 'success') => {
  state.data = data; state.status = status;
  return render(<ThroughputPane {...({ visible: true } as Parameters<typeof ThroughputPane>[0])} />);
};
beforeEach(() => { state.data = undefined; state.status = 'success'; refetch.mockClear(); });

it('shows the headline, the delivery flow, both hourly lines and the empty rate bar by lane', () => {
  show(report('busy'));
  expect(screen.getByText('38 merged in the last 6 hours, median 2m 50s.')).toBeTruthy();
  // The three totals are drawn as one flow: exact counts, and step-to-step shares in words.
  expect(screen.getByRole('img', { name: 'Delivery flow: Launched 50, Published 40 (80% of previous), Merged 38 (95% of previous).' })).toBeTruthy();
  expect(screen.getByText(/not one batch followed through/)).toBeTruthy();
  expect(screen.getByText(/Empty 6 of 48 finished \(13%\)\./)).toBeTruthy();
  expect(screen.getByText('Main is green.').getAttribute('data-main')).toBe('green');
  expect(screen.getByText('Metrics lines skipped because they could not be read: 3.')).toBeTruthy();
  expect(screen.getByText('Merged PRs with no publish time, left out of the median: 2.')).toBeTruthy();
  expect(screen.getByRole('img', { name: 'PRs merged per hour' })).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Median minutes from publish to merge per hour' })).toBeTruthy();
  // One card per lane, the lane that merged most first, each rate in words and as a bar.
  const lanes = within(screen.getByRole('list', { name: 'Lanes, most merged first' })).getAllByRole('listitem');
  expect(lanes.map(lane => lane.getAttribute('data-lane'))).toEqual(['claude', 'grok', 'idle']);
  expect(lanes.every(lane => lane.hasAttribute('data-board-card'))).toBe(true);
  expect(within(lanes[0]!).getByText('38')).toBeTruthy();
  expect(within(lanes[0]!).getByRole('slider', { name: 'claude jobs launched, a bar per hour: most in one bar 50' })).toBeTruthy();
  expect(screen.getByRole('img', { name: 'grok: 5 of 5 finished jobs changed nothing (100%)' })).toBeTruthy();
  expect(screen.getByRole('img', { name: 'claude: 1 of 40 finished jobs changed nothing (3%)' })).toBeTruthy();
  // No job finished on the idle lane: its rate is not drawn as 0%.
  expect(within(lanes[2]!).getByText('none finished')).toBeTruthy();
  expect(screen.queryByRole('img', { name: /^idle: .*changed nothing/ })).toBeNull();
  expect(screen.getAllByRole('row', { hidden: true }).some(row => row.textContent === 'grok5005100%unknown')).toBe(true);
});

it('leads with a figure per count, each over its own hours, and names the busiest hour', () => {
  show(report('busy'));
  const tiles = within(screen.getByRole('list', { name: 'Figures for the last 6 hours' })).getAllByRole('listitem');
  expect(tiles.map(tile => tile.getAttribute('data-figure'))).toEqual(['launched', 'published', 'merged', 'empty', 'median']);
  expect(tiles[2]!.textContent).toMatch(/^Merged38Most in one hour: 38, from /);
  expect(within(tiles[2]!).getByRole('img', { name: 'PRs merged each hour: from 0 to 38, range 0 to 38' })).toBeTruthy();
  expect(tiles[3]!.textContent).toBe('Changed nothing13%6 of 48 finished jobs');
  expect(tiles[4]!.textContent).toBe('Median to merge2m 50sFrom publish to merge');
});

it('writes unknown on every figure of an unreadable file, and words a quiet window as measured', () => {
  const unread = show(report('unreadable'));
  const figure = () => within(screen.getByRole('list', { name: 'Figures for the last 6 hours' })).getAllByRole('listitem').map(tile => tile.textContent);
  expect(figure()).toEqual(['Launchedunknown', 'Publishedunknown', 'Mergedunknown', 'Changed nothingunknown', 'Median to mergeunknown']);
  unread.unmount();
  show(report('quiet'));
  expect(figure()).toEqual(['Launched0', 'Published0', 'Merged0', 'Changed nothingno rateNo job finished in this window.', 'Median to mergeunknownNo PR merged in this window.']);
});

it('shows the figure row as placeholders while reading, and offers another read when the report cannot be read', () => {
  const reading = show(undefined, 'loading');
  expect(reading.container.querySelectorAll('[data-stat-tile-skeleton]')).toHaveLength(5);
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  reading.unmount();
  const failed = show(undefined, 'error');
  expect(failed.container.querySelector('[data-stat-tile-skeleton]')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(refetch).toHaveBeenCalledTimes(1);
});

it('shows a readable but quiet window as an empty state, not as missing data', () => {
  show(report('quiet'));
  expect(screen.getByText('0 merged in the last 6 hours, median unknown.')).toBeTruthy();
  expect(screen.getByText(/No jobs or PRs were recorded in the last 6 hours\./)).toBeTruthy();
  expect(screen.getByText('Main is unknown.').getAttribute('data-main')).toBe('unknown');
  // Zero launched is an empty flow in words, never three full or three missing bars.
  expect(screen.getByText('Nothing was launched, published or merged in this window.')).toBeTruthy();
  expect(screen.queryByRole('img', { name: /Delivery flow/ })).toBeNull();
  expect(screen.getByRole('img', { name: 'PRs merged per hour' })).toBeTruthy();
  expect(screen.getByText('No merged PR with a known publish time in this window.')).toBeTruthy();
  expect(screen.getByText('No lane activity in this window.')).toBeTruthy();
  expect(screen.queryByRole('img', { name: 'Empty rate by lane' })).toBeNull();
});

it('keeps an unreadable metrics file unknown and draws nothing', () => {
  show(report('unreadable'));
  expect(screen.getByText('Merged in the last 6 hours: unknown (cannot read the job metrics file).')).toBeTruthy();
  expect(screen.getByText(/Empty unknown of unknown finished \(unknown\)\./)).toBeTruthy();
  expect(screen.getByText('Main is unknown.').getAttribute('data-main')).toBe('unknown');
  expect(screen.getByRole('note').textContent).toBe('Unknown — the job metrics file could not be read. Nothing is shown rather than a guess.');
  expect(screen.getAllByText('Unknown: the job metrics file could not be read.')).toHaveLength(3);
  expect(screen.queryByRole('img')).toBeNull();
});

it('says so while reading, and when the answer is not a throughput report', () => {
  show(undefined, 'loading').unmount();
  expect(screen.queryByText('Reading throughput…')).toBeNull();
  show(undefined, 'loading');
  expect(screen.getByText('Reading throughput…')).toBeTruthy();
  show({ v: 1 });
  expect(screen.getByText('Throughput: unknown (the report could not be read).')).toBeTruthy();
});

it('draws merges in a window with no launches as a flow, with no invented share', () => {
  const merged: ThroughputCounts = { ...ZERO, merged: 4 };
  show({ ...report('quiet'), totals: merged, buckets: hours(merged, ZERO) });
  expect(screen.getByRole('img', { name: 'Delivery flow: Launched 0, Published 0 (— of previous), Merged 4 (— of previous).' })).toBeTruthy();
});

it('reads 24 hours first and asks the same route for the window picked', () => {
  show(report('busy'));
  expect(screen.getByRole('radio', { name: '24 hours' }).getAttribute('aria-checked')).toBe('true');
  state.fetch!(new AbortController().signal);
  expect(get.mock.lastCall![0]).toBe('/api/verse/fleet/runs/throughput?hours=24&by=lane');
  fireEvent.click(screen.getByRole('radio', { name: '7 days' }));
  expect(screen.getByRole('radio', { name: '7 days' }).getAttribute('aria-checked')).toBe('true');
  expect(state.key).toBe('fleet-throughput-168');
  state.fetch!(new AbortController().signal);
  expect(get.mock.lastCall![0]).toBe('/api/verse/fleet/runs/throughput?hours=168&by=lane');
});

it('keeps the window switch while reading and marks a failed refresh as an old reading', () => {
  const reading = show(undefined, 'loading');
  expect(screen.getByRole('radiogroup', { name: 'Window' })).toBeTruthy();
  expect(screen.queryByText('Could not refresh. Showing the last reading.')).toBeNull();
  reading.unmount();
  show(report('busy'), 'error');
  expect(screen.getByText('Could not refresh. Showing the last reading.')).toBeTruthy();
  expect(screen.getByText('38 merged in the last 6 hours, median 2m 50s.')).toBeTruthy();
});
