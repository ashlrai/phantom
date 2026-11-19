import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HomeSummary } from '../../../../core/fleet/home.js';
import type { ThroughputCounts, ThroughputReport } from '../../../../core/fleet/throughput.js';
import { DeliveryCard } from './DeliveryCard.js';
import { flowSteps, hourBars, laneRows, throughputOf } from './delivery-card-model.js';

const NONE: ThroughputCounts = { launched: null, published: null, merged: null, finished: null, empty: null, empty_rate: null, median_publish_to_merge_s: null, merge_time_unknown: null };
const ZERO: ThroughputCounts = { ...NONE, launched: 0, published: 0, merged: 0, finished: 0, empty: 0, merge_time_unknown: 0 };
const counts = (merged: number | null): ThroughputCounts => merged === null ? NONE : { ...ZERO, merged };
/** Six hours ending at noon UTC, oldest first. */
const hours = (merged: (number | null)[]) => merged.map((value, i) => ({ start: new Date(Date.UTC(2026, 10, 17, 6 + i)).toISOString(), ...counts(value) }));
const lane = (name: string, merged: number | null) => ({ name, totals: counts(merged), buckets: [] });
function report(over: Partial<ThroughputReport> = {}): ThroughputReport {
  return {
    schema: 'throughput.v1', as_of: '2026-11-17T12:00:00.000Z', since: '2026-11-17T06:00:00.000Z', hours: 24, by: 'lane', metrics_path: '/fake/jobs.jsonl', metrics: 'ok', malformed_lines: 0, main: 'green',
    headline: '14 merged in the last 24 hours, median 6m', totals: { ...ZERO, launched: 20, published: 16, merged: 14 }, buckets: hours([1, 0, 9, null, 2, 2]),
    groups: [lane('claude', 9), lane('codex', 4), lane('grok', 1), lane('idle', 0)], ...over,
  };
}
const unknown = (reason: string) => ({ state: 'unknown' as const, reason });
const SUMMARY = { mergedLastHour: { state: 'ok', value: 2 }, merged24h: { state: 'ok', value: 14 }, medianMergeSeconds: { state: 'ok', value: 360 } } as HomeSummary;

const state = vi.hoisted(() => ({ status: 'success', data: undefined as unknown, key: '', enabled: null as boolean | null, fetch: null as null | ((signal: AbortSignal) => unknown) }));
vi.mock('../../../data/hooks.js', () => ({
  useQuery: (def: { key: string; fetch: (signal: AbortSignal) => unknown }, options: { enabled: boolean }) => { state.key = def.key; state.fetch = def.fetch; state.enabled = options.enabled; return state; },
  useRefetch: () => vi.fn(),
}));
const get = vi.hoisted(() => vi.fn());
vi.mock('../../../data/client.js', () => ({ apiGet: get }));
const open = vi.fn();
const show = (data: unknown, summary: HomeSummary = SUMMARY, status = 'success') => {
  state.data = data; state.status = status;
  return render(<DeliveryCard summary={summary} onOpen={open} />);
};
const card = () => within(screen.getByRole('region', { name: 'Merged PRs' }));
beforeEach(() => { state.data = undefined; state.status = 'success'; open.mockClear(); });
afterEach(cleanup);

it('shows the three figures as figures, with the sentence `phm home` prints for a screen reader', () => {
  const view = show(report());
  for (const words of ['Last hour: 2', 'Last 24 hours: 14', 'Median time to merge: 6 minutes']) expect(card().getByText(words).className).toBe('visually-hidden');
  // What is drawn large is hidden from the reader, so no figure is read twice.
  const large = [...view.container.querySelectorAll('p > span[aria-hidden="true"]:first-child')].map(node => node.textContent);
  expect(large).toEqual(['2', '14', '6 min']);
});

it('draws one bar per hour with a count: a stub for a quiet hour, a gap for an hour with no count, the current hour marked', () => {
  const view = show(report());
  const chart = card().getByRole('img', { name: /^PRs merged per hour, last 6 hours: busiest 9 in the hour from .+, 2 in the last hour\.$/ });
  const bars = [...chart.querySelectorAll('rect')];
  // Six hours, one of them without a count: five bars, never a sixth at zero.
  expect(bars).toHaveLength(5);
  expect(bars.map(bar => bar.querySelector('title')!.textContent!.replace(/^.+: /, ''))).toEqual(['1 merged', '0 merged', '9 merged', '2 merged', '2 merged']);
  expect(bars.map(bar => bar.hasAttribute('data-quiet'))).toEqual([false, true, false, false, false]);
  expect(bars.map(bar => bar.hasAttribute('data-latest'))).toEqual([false, false, false, false, true]);
  // The busiest hour fills the chart's height and the rest are drawn against it.
  expect(bars.map(bar => Number(bar.getAttribute('height')))).toEqual([40 / 9, 1.5, 40, 80 / 9, 80 / 9]);
  expect(card().getByText(/^Busiest hour: 9 PRs merged from .+\. Hours with no count: 1\.$/)).toBeTruthy();
  expect(view.container.querySelector('p[aria-hidden="true"]')!.lastElementChild!.textContent).toBe('now');
});

it('lists the three window counts in order and the lanes that merged, most first, each with a bar against the top lane', () => {
  show(report());
  expect(within(card().getByRole('list', { name: 'Launched, published and merged in the last 24 hours' })).getAllByRole('listitem').map(item => item.textContent)).toEqual(['20 launched', '16 published', '14 merged']);
  const lanes = within(card().getByRole('list', { name: 'Merged by lane, last 24 hours' })).getAllByRole('listitem');
  // The idle lane merged nothing, so it has no row rather than an empty bar.
  expect(lanes.map(item => item.textContent)).toEqual(['claude9 merged', 'codex4 merged', 'grok1 merged']);
  expect(lanes.map(item => (item.querySelector('[aria-hidden="true"] > span') as HTMLElement).style.width)).toEqual(['100%', '44%', '11%']);
  // Each lane carries the mark of the provider behind it.
  expect(lanes.map(item => item.querySelector('[data-provider-badge]')!.getAttribute('data-provider-badge'))).toEqual(['Anthropic', 'OpenAI', 'xAI']);
});

it('keeps the list to five lanes and counts the rest', () => {
  show(report({ groups: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name, i) => lane(name, 7 - i)) }));
  expect(within(card().getByRole('list', { name: /^Merged by lane/ })).getAllByRole('listitem')).toHaveLength(5);
  expect(card().getByText('and 2 more lanes in Throughput.')).toBeTruthy();
});

it('a quiet day is said in words over a row of stubs, not left blank', () => {
  show(report({ totals: ZERO, buckets: hours([0, 0, 0, 0, 0, 0]), groups: [lane('claude', 0)] }), { ...SUMMARY, mergedLastHour: { state: 'ok', value: 0 }, merged24h: { state: 'ok', value: 0 }, medianMergeSeconds: unknown('No merged PR has a publish time.') } as HomeSummary);
  expect(card().getByText('No PR merged in the last 6 hours.')).toBeTruthy();
  const bars = [...card().getByRole('img', { name: /none merged, 0 in the last hour\.$/ }).querySelectorAll('rect')];
  expect(bars.map(bar => bar.hasAttribute('data-quiet'))).toEqual([true, true, true, true, true, true]);
  expect(card().queryByRole('list', { name: /^Merged by lane/ })).toBeNull();
  expect(card().getByText('Last hour: 0')).toBeTruthy();
  // One figure the summary does not hold says why, beside the two it does.
  expect(card().getByText('Unknown: No merged PR has a publish time.')).toBeTruthy();
});

it('an unreadable metrics file is unknown: one reason for the figures, no drawing, no zero', () => {
  const reason = 'The job metrics file could not be read.';
  show(report({ metrics: 'unreadable', totals: NONE, buckets: hours([null, null, null, null, null, null]), groups: [] }),
    { mergedLastHour: unknown(reason), merged24h: unknown(reason), medianMergeSeconds: unknown(reason) } as HomeSummary);
  expect(card().getAllByText(`Unknown: ${reason}`)).toHaveLength(1);
  expect(card().getByText('Hourly merges: unknown (the job metrics file could not be read).')).toBeTruthy();
  expect(card().queryByRole('img')).toBeNull();
  expect(card().queryByRole('list')).toBeNull();
});

it('says so while the report is read, and when the answer is not a throughput report', () => {
  show(undefined, SUMMARY, 'loading');
  expect(card().getByRole('status').textContent).toBe('Reading the hourly record…');
  // The figures come from the summary and do not wait on the drawing.
  expect(card().getByText('Last 24 hours: 14')).toBeTruthy();
  cleanup();
  show({ schema: 'home.v1' });
  expect(card().getByText('Hourly merges: unknown (the throughput report could not be read).')).toBeTruthy();
  cleanup();
  show(undefined, SUMMARY, 'error');
  expect(card().getByText('Hourly merges: unknown (the throughput report could not be read).')).toBeTruthy();
  expect(card().queryByRole('img')).toBeNull();
});

it('a failed refresh keeps the last drawing and says when it was read', () => {
  show(report(), SUMMARY, 'error');
  expect(card().getByRole('status').textContent).toMatch(/^Could not refresh the hourly record\. Showing the reading from .+\.$/);
  expect(card().getByRole('img', { name: /^PRs merged per hour/ })).toBeTruthy();
});

it('reads the 24 hour report the Throughput pane reads, only while visible, and its one action opens that pane', () => {
  show(report());
  expect([state.key, state.enabled]).toEqual(['fleet-throughput-24', true]);
  state.fetch!(new AbortController().signal);
  expect(get.mock.lastCall![0]).toBe('/api/verse/fleet/runs/throughput?hours=24&by=lane');
  expect(card().getAllByRole('button')).toHaveLength(1);
  fireEvent.click(card().getByRole('button', { name: 'Open Throughput' }));
  expect(open).toHaveBeenCalledTimes(1);
  cleanup();
  render(<DeliveryCard summary={SUMMARY} visible={false} onOpen={open} />);
  expect(state.enabled).toBe(false);
});

it('model: bars scale to the busiest hour, the latest on a tie, and an hour with no count stays null', () => {
  const { bars, peak, known } = hourBars(report({ buckets: hours([3, null, 6, 6, 0, 1]) }));
  expect(bars.map(bar => [bar.merged, bar.share])).toEqual([[3, 0.5], [null, 0], [6, 1], [6, 1], [0, 0], [1, 1 / 6]]);
  expect([peak, known]).toEqual([bars[3], 5]);
  expect(hourBars(report({ buckets: hours([0, 0]) })).peak).toBeNull();
  expect(hourBars(report({ buckets: hours([null, null]) })).known).toBe(0);
});

it('model: lanes sort by merged then name, and a missing total gives no flow rather than a zero', () => {
  expect(laneRows(report({ groups: [lane('b', 2), lane('a', 2), lane('z', 8), lane('n', null)] }))).toEqual({ rows: [{ name: 'z', merged: 8, share: 1 }, { name: 'a', merged: 2, share: 0.25 }, { name: 'b', merged: 2, share: 0.25 }], more: 0 });
  expect(flowSteps(report({ totals: { ...ZERO, launched: null } }))).toBeNull();
  expect(flowSteps(report({ totals: ZERO }))?.map(step => step.value)).toEqual([0, 0, 0]);
  for (const body of [null, 'text', { schema: 'home.v1' }, { schema: 'throughput.v1' }, { schema: 'throughput.v1', buckets: [], groups: [] }]) expect(throughputOf(body)).toBeNull();
  expect(throughputOf(report())).not.toBeNull();
});

it('every color and size the card styles name is a real design token', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), 'src/web-ui', path), 'utf8');
  const defined = new Set((read('design/tokens.css') + read('design/global.css')).match(/--[\w-]+(?=\s*:)/g));
  const css = read('routes/verse/home/delivery-card.module.css');
  expect([...new Set(css.match(/(?<=var\()--[\w-]+/g))].filter(name => !defined.has(name))).toEqual([]);
  expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|font-size:\s*\d+px/i);
});
