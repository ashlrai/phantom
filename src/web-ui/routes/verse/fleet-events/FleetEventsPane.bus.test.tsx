import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { evictAll, getQuerySnapshot, refetchQuery } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetEventsPane } from './FleetEventsPane.js';
import { agentBusFeedQuery } from './agent-bus-feed-query.js';

const props = { visible: true } as PaneProps;
const runs = { events: [
  { at: '2026-01-01T00:00:00Z', kind: 'launch', text: 'launch one' },
  { at: '2026-01-03T00:00:00Z', kind: 'hold', text: 'hold two' },
  { at: '2026-01-05T00:00:00Z', kind: 'merge', text: 'merge three' },
], leaders: [], drop: { pending: [] }, sources: { runsDir: 'healthy' } };
const message = (id: string, at: string, text: string) => ({ cursor: Number(id), receivedAt: 1_767_225_600_000,
  envelope: { id, from: 'alpha', to: 'beta', priority: 'P1', ttl: 5000, body: { kind: 'interjection', receivedAt: at, text } } });
const bus = { v: 1, status: 'ok', nextCursor: 2, messages: [
  message('1', '2026-01-02T00:00:00Z', 'hello team'),
  message('2', '2026-01-04T00:00:00Z', 'ready to go'),
] };
const rows = () => within(screen.getByRole('list', { name: 'Fleet event feed' })).getAllByRole('listitem');
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('merges both feeds and applies kind and text filters', async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).includes('/agent-bus?') ? bus : runs));
  vi.stubGlobal('fetch', fetcher);
  render(<FleetEventsPane {...props} />);
  await screen.findByText('alpha -> beta [P1] ready to go');
  expect(fetcher.mock.calls.some(([input]) => String(input) === '/api/verse/agent-bus?after=0&limit=100')).toBe(true);
  expect(rows().map(row => row.textContent)).toEqual([
    expect.stringContaining('merge three'), expect.stringContaining('ready to go'), expect.stringContaining('hold two'),
    expect.stringContaining('hello team'), expect.stringContaining('launch one'),
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'bus' }));
  expect(rows()).toHaveLength(2);
  fireEvent.change(screen.getByRole('textbox', { name: 'Filter events' }), { target: { value: 'HELLO' } });
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toHaveTextContent('hello team');
});

it('counts bus arrivals while paused and preserves them on resume', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).includes('/agent-bus?') ? bus : runs)));
  render(<FleetEventsPane {...props} />);
  await screen.findByText('alpha -> beta [P1] ready to go');
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  const newer = { ...bus, nextCursor: 3, messages: [...bus.messages, message('3', '2026-01-06T00:00:00Z', 'new arrival')] };
  await act(async () => { await refetchQuery(agentBusFeedQuery.key, async () => newer, true); });
  expect(rows()).toHaveLength(5);
  expect(screen.getByRole('button', { name: 'Resume · 1 new' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Resume · 1 new' }));
  expect(rows()).toHaveLength(6);
  expect(rows()[0]).toHaveTextContent('new arrival');
});

it('keeps fleet events visible and remembers a missing bus route', async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).includes('/agent-bus?')
    ? Response.json({}, { status: 404 }) : Response.json(runs));
  vi.stubGlobal('fetch', fetcher);
  render(<FleetEventsPane {...props} />);
  await screen.findByText('merge three');
  await waitFor(() => expect(getQuerySnapshot(agentBusFeedQuery.key).status).toBe('error'));
  await act(async () => { await expect(agentBusFeedQuery.fetch()).rejects.toMatchObject({ status: 404 }); });
  expect(rows()).toHaveLength(3);
  expect(screen.queryByRole('button', { name: 'bus' })).toBeNull();
  expect(screen.queryByText(/unavailable|could not refresh/i)).toBeNull();
  expect(fetcher.mock.calls.filter(([input]) => String(input).includes('/agent-bus?'))).toHaveLength(1);
});
