import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ThroughputBy, ThroughputCounts, ThroughputGroup, ThroughputReport } from '../../../../core/fleet/throughput.js';
import { ThroughputPane } from './ThroughputPane.js';

const NONE: ThroughputCounts = { launched: null, published: null, merged: null, finished: null, empty: null, empty_rate: null, median_publish_to_merge_s: null, merge_time_unknown: null };
const ZERO: ThroughputCounts = { ...NONE, launched: 0, published: 0, merged: 0, finished: 0, empty: 0, merge_time_unknown: 0 };
const hours = (last: ThroughputCounts) => Array.from({ length: 6 }, (_, i) => ({ start: new Date(Date.UTC(2026, 10, 17, 6 + i)).toISOString(), ...(i === 5 ? last : ZERO) }));
const group = (name: string, merged: number): ThroughputGroup => ({ name, totals: { ...ZERO, launched: merged, published: merged, merged }, buckets: hours({ ...ZERO, merged }) });
function report(by: ThroughputBy, groups: ThroughputGroup[]): ThroughputReport {
  const merged = groups.reduce((sum, g) => sum + (g.totals.merged ?? 0), 0);
  const totals: ThroughputCounts = { ...ZERO, launched: merged, published: merged, merged };
  return {
    schema: 'throughput.v1', as_of: '2026-11-17T12:00:00.000Z', since: '2026-11-17T06:00:00.000Z', hours: 6, by, metrics_path: '/fake/jobs.jsonl',
    metrics: 'ok', malformed_lines: 0, main: 'green', headline: `${merged} merged in the last 6 hours, median unknown`, totals, buckets: hours(totals), groups,
  };
}
const state = vi.hoisted(() => ({ status: 'success', data: undefined as unknown, key: '', fetch: null as null | ((signal: AbortSignal) => unknown) }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: (def: { key: string; fetch: (signal: AbortSignal) => unknown }) => { state.key = def.key; state.fetch = def.fetch; return state; }, useRefetch: () => vi.fn() }));
const get = vi.hoisted(() => vi.fn());
vi.mock('../../../data/client.js', () => ({ apiGet: get }));
const show = (data: unknown) => { state.data = data; return render(<ThroughputPane {...({ visible: true } as Parameters<typeof ThroughputPane>[0])} />); };
const asked = () => { state.fetch!(new AbortController().signal); return get.mock.lastCall![0]; };
beforeEach(() => { state.data = undefined; state.status = 'success'; });

it('splits the merged PRs between the lanes in one bar, with every count in its name and under it', () => {
  const view = show(report('lane', [group('claude', 30), group('codex', 8), group('grok', 0)]));
  expect(screen.getByRole('img', { name: '38 merged PRs by lane: claude 30 (79%), codex 8 (21%).' })).toBeTruthy();
  const share = view.container.querySelector('[data-share="lane"]')!;
  // One part per lane that merged, sized by its count; a lane that merged nothing has no part.
  expect([...share.querySelectorAll('[role="img"] > span')].map(part => (part as HTMLElement).style.flexGrow)).toEqual(['30', '8']);
  expect([...share.querySelectorAll('li')].map(item => item.textContent)).toEqual(['claude3079%', 'codex821%']);
  // The lane marks are the provider's; the cards under the bar are still there, the idle lane included.
  expect(share.querySelectorAll('li svg')).toHaveLength(2);
  expect(within(screen.getByRole('list', { name: 'Lanes, most merged first' })).getAllByRole('listitem').map(card => card.getAttribute('data-lane'))).toEqual(['claude', 'codex', 'grok']);
});

it('reads by lane first and asks the same route by repo or by tier when picked', () => {
  show(report('lane', [group('claude', 3)]));
  expect(screen.getByRole('radio', { name: 'Lanes' }).getAttribute('aria-checked')).toBe('true');
  expect([state.key, asked()]).toEqual(['fleet-throughput-24', '/api/verse/fleet/runs/throughput?hours=24&by=lane']);
  fireEvent.click(screen.getByRole('radio', { name: 'Repos' }));
  expect(screen.getByRole('radio', { name: 'Repos' }).getAttribute('aria-checked')).toBe('true');
  expect([state.key, asked()]).toEqual(['fleet-throughput-24-repo', '/api/verse/fleet/runs/throughput?hours=24&by=repo']);
  // The window and the grouping are independent choices.
  fireEvent.click(screen.getByRole('radio', { name: '7 days' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Tiers' }));
  expect([state.key, asked()]).toEqual(['fleet-throughput-168-tier', '/api/verse/fleet/runs/throughput?hours=168&by=tier']);
});

it('words a report by repo as repos, and keeps merges with no repo in the record unknown', () => {
  const view = show(report('repo', [group('phantom', 30), group('unknown', 8), group('atlas', 2)]));
  expect(screen.getByRole('img', { name: '40 merged PRs by repo: phantom 30 (75%), atlas 2 (5%), repo unknown 8 (20%).' })).toBeTruthy();
  expect(view.container.querySelector('[data-share="repo"] [role="img"] [data-kind="unnamed"]')).toBeTruthy();
  const cards = within(screen.getByRole('list', { name: 'Repos, most merged first' })).getAllByRole('listitem');
  expect(cards.map(card => [card.getAttribute('data-group'), card.getAttribute('data-lane')])).toEqual([['phantom', null], ['unknown', null], ['atlas', null]]);
  expect(within(cards[1]!).getByText('repo unknown')).toBeTruthy();
  // A repo is not a provider: no mark is drawn for one, in the bar's legend or on its card.
  expect(view.container.querySelectorAll('[data-share] li svg')).toHaveLength(0);
  expect(within(cards[1]!).getByRole('slider', { name: /^repo unknown jobs launched, a bar per hour/ })).toBeTruthy();
  expect(screen.getByText('Throughput by repo', { ignore: false })).toBeTruthy();
  expect(screen.queryByRole('list', { name: 'Lanes, most merged first' })).toBeNull();
});

it('draws no split for a window in which nothing merged, and says which grouping is quiet', () => {
  const quiet = show(report('tier', []));
  expect(quiet.container.querySelector('[data-share]')).toBeNull();
  expect(screen.getByText('No tier activity in this window.')).toBeTruthy();
  quiet.unmount();
  const idle = show(report('tier', [group('hard', 0)]));
  expect(idle.container.querySelector('[data-share]')).toBeNull();
  expect(screen.getByRole('list', { name: 'Tiers, most merged first' })).toBeTruthy();
});
