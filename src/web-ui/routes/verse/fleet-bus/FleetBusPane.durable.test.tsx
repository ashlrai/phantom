import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetBusPane } from './FleetBusPane.js';

const now = Date.now();
const row = (cursor: number, body: unknown, from = 'agent', ttl = 1_000_000) => ({ cursor, receivedAt: now - 1000,
  envelope: { id: `fake-${cursor}`, from, to: 'all', priority: 'P2', ttl, body } });
const fixture = [row(99, { text: 'expired' }, 'agent', 1), row(100, { note: 'fake JSON' }),
  row(101, { kind: 'interjection', channel: 'telegram', text: 'fake order' }, 'mason')];
const status = { v: 1, source: 'available', retainedCount: 101, retainedBytes: 31744, liveCount: 100, expiredCount: 1, maxMessages: 1024, maxBytes: 1048576 };
const dispatch = { v: 1, hops: [], hopsDropped: 0, lastHopAt: null, events: [], sources: { hops: 'healthy', events: 'healthy' } };
const reply = (data: unknown, code = 200) => Promise.resolve(new Response(JSON.stringify(data), { status: code, headers: { 'Content-Type': 'application/json' } }));
const props = { visible: true } as PaneProps;
const open = async () => { render(<FleetBusPane {...props} />); fireEvent.click(screen.getByRole('button', { name: 'Durable bus' })); };
beforeEach(() => { evictAll(); vi.stubGlobal('fetch', vi.fn((path: string) => {
  if (path.includes('/fleet/live/bus')) return reply(dispatch);
  if (path.endsWith('/status')) return reply(status);
  if (path.includes('after=1&')) return reply({ v: 1, status: 'ok', messages: [row(50, { text: 'older' }), fixture[0]], nextCursor: 101 });
  return reply({ v: 1, status: 'ok', messages: fixture, nextCursor: 101 });
})); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('toggles, displays envelopes and merges older pages without duplicates', async () => {
  await open();
  const list = await screen.findByRole('list', { name: 'Durable bus envelopes' });
  let rows = within(list).getAllByRole('listitem');
  expect(rows).toHaveLength(3);
  expect(rows[0]).toHaveTextContent('via Telegram');
  expect(rows[0]).toHaveTextContent('fake order');
  expect(rows[1]).toHaveTextContent('message');
  expect(rows[1]).toHaveTextContent('{"note":"fake JSON"}');
  expect(rows[2]).toHaveTextContent('expired');
  fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
  await screen.findByText('older');
  rows = within(list).getAllByRole('listitem');
  expect(rows).toHaveLength(4);
  expect(rows[3]).toHaveTextContent('older');
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('after=1&limit=50'))).toBe(true);
  fireEvent.change(screen.getByRole('searchbox', { name: 'Filter bus events' }), { target: { value: 'telegram' } });
  expect(within(list).getAllByRole('listitem')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Dispatch feed' }));
  expect(screen.getByRole('button', { name: 'Dispatch feed' })).toHaveAttribute('aria-pressed', 'true');
});

it('does not refetch either route when switching back within its cadence', async () => {
  await open();
  await screen.findByText('fake order');
  const calls = vi.mocked(fetch).mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Dispatch feed' }));
  fireEvent.click(screen.getByRole('button', { name: 'Durable bus' }));
  await act(async () => {});
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(calls);
});

it.each([[401, 'Read session expired. Reopen the console.'], [503, 'Durable bus storage unavailable.'],
  [404, 'This hub has no durable bus route yet (update the hub).']])('shows the HTTP %i error', async (code, text) => {
  vi.mocked(fetch).mockImplementation((path) => String(path).includes('/fleet/live/bus') ? reply(dispatch) : reply({ error: 'fake' }, code));
  await open();
  await waitFor(() => expect(screen.getByText(text)).toBeInTheDocument());
});
