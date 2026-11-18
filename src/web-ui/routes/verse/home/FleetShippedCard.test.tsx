import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FleetShippedCard, SHIPPED_LIMIT } from './FleetShippedCard.js';
import { hourlyMerges, openFor, repoShares } from './fleet-shipped-model.js';
import { evictAll } from '../../../data/cache.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); evictAll(); });

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const pr = (number: number, minutes: number, extra: Record<string, unknown> = {}) => ({ repo: 'ashlrai/phantom', number, title: `Change ${number}`,
  url: `https://github.com/ashlrai/phantom/pull/${number}`, mergedAt: ago(minutes), jobId: null, lane: null, openToMergeSeconds: null, ...extra });
const report = (items: ReturnType<typeof pr>[], extra: Record<string, unknown> = {}) => ({ schema: 'fleet.shipped.v1', since: ago(1440), generatedAt: ago(0), complete: true, items,
  byRepo: { 'ashlrai/phantom': items.length, 'ashlrai/locus': 0 }, totals: { merged: items.length, mergedPerHour: items.length / 24, medianOpenToMergeSeconds: 600 }, ...extra });
const serve = (body: unknown) => { const fetch = vi.fn(async (_input: RequestInfo | URL) => Response.json(body)); vi.stubGlobal('fetch', fetch); return fetch; };

it('shows newest shipped PRs as links from the shared feed', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL) => Response.json({ schema: 'fleet.shipped.v1', complete: true,
    totals: { merged: 1, mergedPerHour: 1 / 24, medianOpenToMergeSeconds: 600 },
    items: [{ repo: 'ashlrai/phantom', number: 7, title: 'Show shipped work', lane: 'codex-personal' }] }));
  vi.stubGlobal('fetch', fetch); render(<FleetShippedCard />);
  expect((await screen.findByRole('link', { name: 'phantom #7: Show shipped work' })).getAttribute('href')).toBe('https://github.com/ashlrai/phantom/pull/7');
  expect(screen.getByRole('region', { name: 'Shipped today' })).toBeTruthy();
  expect(String(fetch.mock.calls[0]?.[0])).toContain('/api/verse/shipped?since=24h');
  // This payload has no report time or merge times: no chart is drawn and the row says its time is unknown.
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.getByText('time unknown')).toBeTruthy();
});

it('leads with the count and draws the listed merges hour by hour, oldest first', async () => {
  serve(report([pr(3, 10), pr(2, 30), pr(1, 23 * 60 + 30)]));
  render(<FleetShippedCard />);
  expect(await screen.findByText('3 merged')).toBeTruthy();
  expect(screen.getByText(/0\.1 per hour · median open to merge: 10 minutes/)).toBeTruthy();
  const chart = screen.getByRole('img');
  expect(chart.getAttribute('aria-label')).toBe(`Merged per hour over the last 24 hours, oldest first: 1, ${Array(22).fill(0).join(', ')}, 2`);
  expect(chart.querySelectorAll('rect')).toHaveLength(24);
  expect(chart.querySelectorAll('rect[data-empty]')).toHaveLength(22);
  expect(screen.getByText('most in one hour: 2')).toBeTruthy();
  // One repo merged, so there is no split to show.
  expect(screen.queryByRole('list', { name: 'Merged by repo' })).toBeNull();
});

it('splits the day by repo, busiest first, when more than one repo merged', async () => {
  serve(report([pr(1, 5), pr(2, 6, { repo: 'ashlrai/locus' }), pr(3, 7, { repo: 'ashlrai/locus' })], { byRepo: { 'ashlrai/phantom': 1, 'ashlrai/locus': 2, 'ashlrai/lexicon': 0 } }));
  render(<FleetShippedCard />);
  const repos = await screen.findByRole('list', { name: 'Merged by repo' });
  expect(within(repos).getAllByRole('listitem').map(item => item.textContent)).toEqual(['locus 2', 'phantom 1']);
});

it('opens the session that shipped a PR and states what a PR does not record', async () => {
  const onOpenJob = vi.fn();
  serve(report([pr(2, 5, { jobId: 'RQ-DESK-12', lane: 'claude', openToMergeSeconds: 7200 }), pr(1, 50, { jobId: 'not a job id' })]));
  render(<FleetShippedCard onOpenJob={onOpenJob} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open messages for RQ-DESK-12' }));
  expect(onOpenJob).toHaveBeenCalledWith('RQ-DESK-12');
  const rows = within(screen.getByRole('list', { name: 'Merged PRs, newest first' })).getAllByRole('listitem');
  expect(rows[0]?.textContent).toContain('open 2 hours');
  expect(rows[0]?.querySelector('time')?.getAttribute('datetime')).toBe(ago(5));
  // An id the server would refuse is shown, not offered as a way in.
  expect(rows[1]?.textContent).toContain('not a job id');
  expect(within(rows[1]!).queryByRole('button')).toBeNull();
  expect(rows[1]?.textContent).toContain('Unknown lane');
  expect(rows[1]?.textContent).toContain('Open time unknown');
});

it('shows the newest few and expands to the whole day on request', async () => {
  serve(report(Array.from({ length: SHIPPED_LIMIT + 3 }, (_, i) => pr(100 - i, i * 20))));
  render(<FleetShippedCard />);
  const more = await screen.findByRole('button', { name: `Show all ${SHIPPED_LIMIT + 3}` });
  const list = screen.getByRole('list', { name: 'Merged PRs, newest first' });
  expect(within(list).getAllByRole('link')).toHaveLength(SHIPPED_LIMIT);
  expect(more.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(more);
  expect(within(list).getAllByRole('link')).toHaveLength(SHIPPED_LIMIT + 3);
  expect(screen.getByRole('button', { name: `Show the newest ${SHIPPED_LIMIT}` }).getAttribute('aria-expanded')).toBe('true');
});

it('gives an incomplete report no total and no repo split, and says the chart is only the listed PRs', async () => {
  serve(report([pr(1, 5), pr(2, 6, { repo: 'ashlrai/locus' })], { complete: false, byRepo: { 'ashlrai/phantom': 1, 'ashlrai/locus': 1 }, totals: { merged: null, mergedPerHour: null, medianOpenToMergeSeconds: null } }));
  render(<FleetShippedCard />);
  expect((await screen.findByRole('status')).textContent).toBe('Some results are unavailable. Totals are unknown.');
  expect(screen.queryByText(/merged$/)).toBeNull();
  expect(screen.queryByRole('list', { name: 'Merged by repo' })).toBeNull();
  expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/^Listed PRs merged per hour/);
  expect(screen.getByText('Only the PRs listed below are drawn.')).toBeTruthy();
});

it('says nothing merged on a quiet day without drawing an empty chart', async () => {
  serve(report([]));
  render(<FleetShippedCard />);
  expect(await screen.findByText('Nothing merged in the last 24 hours.')).toBeTruthy();
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.queryByRole('list')).toBeNull();
});

it('reads unknown when the report cannot be read, and hides for a payload that is not a report', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 500 })));
  render(<FleetShippedCard />);
  expect((await screen.findByRole('status')).textContent).toBe('Unknown: what shipped could not be read.');
  cleanup(); evictAll();
  serve({ schema: 'something.else' });
  const { container } = render(<FleetShippedCard />);
  await vi.waitFor(() => expect(container.textContent).toBe(''));
});

it('places merges in the report\'s own hours and counts the ones it cannot place', () => {
  const hourly = hourlyMerges([{ mergedAt: ago(0) }, { mergedAt: ago(59) }, { mergedAt: ago(60) }, { mergedAt: ago(24 * 60) }, { mergedAt: ago(25 * 60) }, { mergedAt: ago(-5) }, { mergedAt: 'never' }], ago(0));
  expect(hourly?.counts.at(-1)).toBe(2);
  expect(hourly?.counts.at(-2)).toBe(1);
  expect(hourly?.counts[0]).toBe(1);
  expect(hourly?.counts.reduce((sum, n) => sum + n, 0)).toBe(4);
  expect(hourly?.unplaced).toBe(3);
  // No readable report time is no chart, never 24 empty hours.
  expect(hourlyMerges([{ mergedAt: ago(5) }], 'not a time')).toBeNull();
  expect(hourlyMerges([{ mergedAt: ago(5) }], undefined)).toBeNull();
});

it('orders repos by merges and words open time in the largest readable unit', () => {
  expect(repoShares({ 'ashlrai/a': 0, 'ashlrai/b': 2, 'ashlrai/c': 5 })).toEqual([{ repo: 'c', count: 5 }, { repo: 'b', count: 2 }]);
  expect(repoShares(undefined)).toEqual([]);
  expect([45, 1, 600, 7200, 172_800].map(openFor)).toEqual(['45 seconds', '1 second', '10 minutes', '2 hours', '2 days']);
});
