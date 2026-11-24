import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { FleetShippedCard, shippedTime } from './FleetShippedCard.js';

const SINCE = '2026-11-19T12:00:00.000Z', NOW = '2026-11-20T12:00:00.000Z';
const ITEMS = [
  { repo: 'ashlrai/phantom', number: 12, title: 'Draw the day', url: 'https://example.invalid/x', mergedAt: '2026-11-20T06:00:00.000Z', jobId: 'RQ-DRAW-12', lane: 'claude', openToMergeSeconds: 6 * 3600 },
  { repo: 'ashlrai/locus', number: 4, title: 'Pin check', url: '', mergedAt: '2026-11-19T18:00:00.000Z', jobId: null, lane: null, openToMergeSeconds: 48 * 3600 },
  { repo: 'ashlrai/phantom', number: 11, title: 'No open time', url: '', mergedAt: '2026-11-19T15:00:00.000Z', jobId: 'no', lane: 'codex-personal', openToMergeSeconds: null },
];
const FEED = { schema: 'fleet.shipped.v1', since: SINCE, generatedAt: NOW, complete: true, items: ITEMS, byRepo: {}, totals: { merged: 3, mergedPerHour: 3 / 24, medianOpenToMergeSeconds: 27 * 3600 } };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); evictAll(); });
const serve = (body: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status })));
const card = () => screen.findByRole('region', { name: 'Shipped today' });
const list = () => screen.getByRole('list', { name: /^Merged pull requests, newest first/ });

it('leads with the totals and lists every merge with its time, lane and time open', async () => {
  serve(FEED); render(<FleetShippedCard />);
  const region = await card();
  await within(region).findByText('3 merged across 2 repositories, 0.1 per hour.');
  expect(within(region).getByText('Median open to merge: 1 d 3 h. Longest open: locus #4, 2 d.')).toBeTruthy();
  const rows = within(list()).getAllByRole('listitem');
  expect(rows).toHaveLength(3);
  expect(within(rows[0]!).getByText(shippedTime(Date.parse(ITEMS[0]!.mergedAt)))).toBeTruthy();
  expect(within(rows[0]!).getByText('claude')).toBeTruthy();
  expect(within(rows[0]!).getByText('open 6 h')).toBeTruthy();
  expect(within(rows[1]!).getByText('lane unknown')).toBeTruthy();
  expect(within(rows[2]!).getByText('open time unknown')).toBeTruthy();
  expect(within(region).getByText('phm shipped --since 24h')).toBeTruthy();
});

it('draws the time open as a line ending at the merge, clipped or missing where the feed says so', async () => {
  serve(FEED); render(<FleetShippedCard />);
  await card();
  const tracks = await screen.findAllByTestId('shipped-track');
  expect(tracks).toHaveLength(3);
  const [line, dot] = [...tracks[0]!.children] as HTMLElement[];
  expect(tracks[0]!.getAttribute('aria-hidden')).toBe('true');
  expect([line!.style.left, line!.style.width, dot!.style.left]).toEqual(['50%', '25%', '75%']);
  expect(line!.hasAttribute('data-clipped')).toBe(false);
  // Opened two days ago: the line starts at the window's edge and is marked as cut there.
  const clipped = tracks[1]!.children[0] as HTMLElement;
  expect([clipped.style.left, clipped.style.width, clipped.hasAttribute('data-clipped')]).toEqual(['0%', '25%', true]);
  // No time open: a hollow dot and no line.
  expect(tracks[2]!.children).toHaveLength(1);
  expect(tracks[2]!.children[0]!.getAttribute('data-open')).toBe('unknown');
});

it('narrows the list to one repository and back', async () => {
  serve(FEED); render(<FleetShippedCard />);
  await card();
  const group = await screen.findByRole('group', { name: 'Show one repository' });
  const all = within(group).getByRole('button', { name: 'All 3' });
  const phantom = within(group).getByRole('button', { name: 'phantom 2' });
  expect(all.getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(within(group).getByRole('button', { name: 'locus 1' }));
  expect(within(list()).getAllByRole('listitem')).toHaveLength(1);
  expect(screen.getByRole('list', { name: 'Merged pull requests, newest first, locus only' })).toBeTruthy();
  expect(all.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(phantom);
  expect(within(list()).getAllByRole('link').map(link => link.textContent)).toEqual(['phantom #12: Draw the day', 'phantom #11: No open time']);
  // The chosen button lets go again.
  fireEvent.click(phantom);
  expect(within(list()).getAllByRole('listitem')).toHaveLength(3);
});

it('opens the job that made a pull request in the worker log, and offers no button for an id it cannot open', async () => {
  const onOpenJob = vi.fn();
  serve(FEED); render(<FleetShippedCard onOpenJob={onOpenJob} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open the worker log for RQ-DRAW-12' }));
  expect(onOpenJob).toHaveBeenCalledWith('RQ-DRAW-12');
  expect(screen.queryByRole('button', { name: /worker log for no$/ })).toBeNull();
  expect(screen.getByText('no')).toBeTruthy();
});

it('names the job without a button when nothing can open it', async () => {
  serve(FEED); render(<FleetShippedCard />);
  expect(await screen.findByText('RQ-DRAW-12')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /worker log/ })).toBeNull();
});

it('keeps totals unknown for an incomplete feed and offers no repository switch for one repository', async () => {
  serve({ ...FEED, complete: false, items: [ITEMS[0]], totals: { merged: null, mergedPerHour: null, medianOpenToMergeSeconds: null } });
  render(<FleetShippedCard />);
  expect(await screen.findByText('1 merged pull request listed. Some results are unavailable, so totals are unknown.')).toBeTruthy();
  expect(screen.queryByText(/Median open to merge/)).toBeNull();
  expect(screen.queryByRole('group', { name: 'Show one repository' })).toBeNull();
});

it('says nothing merged and draws no list for a complete, empty day', async () => {
  serve({ ...FEED, items: [], totals: { merged: 0, mergedPerHour: 0, medianOpenToMergeSeconds: null } });
  render(<FleetShippedCard />);
  expect(await screen.findByText('Nothing merged in the last 24 hours.')).toBeTruthy();
  expect(screen.queryByRole('list')).toBeNull();
});

it('draws no line when the feed does not give its window', async () => {
  serve({ ...FEED, since: undefined });
  render(<FleetShippedCard />);
  await screen.findByText('3 merged across 2 repositories, 0.1 per hour.');
  expect(screen.queryByTestId('shipped-track')).toBeNull();
  expect(screen.queryByText(/^Read at/)).toBeNull();
});

it('says the feed is unavailable when the first read fails, with a way to ask again', async () => {
  serve({ error: 'down' }, 500);
  render(<FleetShippedCard />);
  const status = (await screen.findByText(/Refresh failed\. Shipped is unavailable\./)).closest('[role="status"]') as HTMLElement;
  expect(status).not.toBeNull();
  expect(within(status).getByRole('button', { name: 'Try again' })).toBeTruthy();
  expect(screen.queryByRole('list')).toBeNull();
});

it('stays hidden for a payload that is not the fleet feed', async () => {
  const fetch = vi.fn(async () => Response.json({ schema: 'shipped.v1', areas: [] }));
  vi.stubGlobal('fetch', fetch);
  render(<FleetShippedCard />);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  await vi.waitFor(() => expect(screen.queryByRole('region', { name: 'Shipped today' })).toBeNull());
});
