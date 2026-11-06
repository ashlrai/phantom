import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetChannelsPane } from './FleetChannelsPane.js';

const now = Date.parse('2026-10-31T05:00:00Z');
const inbox = ['telegram', 'telegram', 'telegram', 'desktop', 'desktop', 'desktop'].map(source => ({ at: '2026-10-31T04:59:00Z', source, text: 'fake message' }));
const status = { v: 1, source: 'available', retainedCount: 103, retainedBytes: 1000, liveCount: 103, expiredCount: 0, maxMessages: 1024, maxBytes: 100000 };
const messages = [1, 2].map(cursor => ({ cursor, receivedAt: now - 1000, envelope: { id: `fake-${cursor}`, from: 'mason', to: 'leaders', priority: 'P0', ttl: 10000, body: { kind: 'interjection', channel: 'telegram', text: 'fake message' } } }));
const props = { visible: true, host: { openPane: vi.fn() } } as unknown as PaneProps;
const reply = (value: unknown, code = 200) => Promise.resolve(Response.json(value, { status: code }));
const channel = (name: string) => within(screen.getByRole('list', { name: 'Channels' })).getAllByRole('listitem').find(row => within(row).queryByText(name))!;

beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('shows per-channel mirror counts and warns when none reached the bus', async () => {
  const fetcher = vi.fn((url: string) => url.includes('/fleet/runs') ? reply(fleetRunsFixture({ inbox }))
    : url.endsWith('/status') ? reply(status) : reply({ v: 1, status: 'ok', messages, nextCursor: 103 }));
  vi.stubGlobal('fetch', fetcher);
  render(<FleetChannelsPane {...props} />);
  await screen.findByText('mirrored 2 of 3 in the last hour');
  expect(within(channel('Telegram')).getByText('mirrored 2 of 3 in the last hour')).not.toHaveAttribute('role', 'status');
  expect(within(channel('Desktop app')).getByRole('status')).toHaveTextContent('mirrored 0 of 3 in the last hour · Messages reach the inbox but not the bus: the hub needs --allow-dispatch and a writable bus store');
  expect(within(channel('Mobile')).getByText('mirrored 0 of 0 in the last hour')).toBeInTheDocument();
  expect(screen.getByText('Bus mirror checked against the last 100 envelopes')).toBeInTheDocument();
  expect(fetcher.mock.calls.some(([url]) => url.includes('after=3&limit=100'))).toBe(true);
});

it('polls both bus routes only while visible', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn((url: string) => url.includes('/fleet/runs') ? reply(fleetRunsFixture({ inbox }))
    : url.endsWith('/status') ? reply(status) : reply({ v: 1, status: 'ok', messages, nextCursor: 103 }));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<FleetChannelsPane {...props} />);
  await act(async () => {});
  const before = fetcher.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(fetcher.mock.calls.length - before).toBe(3);
  view.rerender(<FleetChannelsPane {...props} visible={false} />);
  const hidden = fetcher.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetcher).toHaveBeenCalledTimes(hidden);
});

it('does not use a stale page when a bus refresh fails', async () => {
  let failPage = false;
  vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/fleet/runs') ? reply(fleetRunsFixture({ inbox }))
    : url.endsWith('/status') ? reply(status) : failPage ? reply({ error: 'fake' }, 503) : reply({ v: 1, status: 'ok', messages, nextCursor: 103 })));
  render(<FleetChannelsPane {...props} />);
  await screen.findByText('mirrored 2 of 3 in the last hour');
  failPage = true;
  const { agentBusPageQuery } = await import('../fleet-bus/agent-bus-queries.js');
  const { refetchQuery } = await import('../../../data/cache.js');
  const query = agentBusPageQuery(3, 100);
  await act(async () => { await refetchQuery(query.key, () => query.fetch(), true); });
  expect(screen.getByText('Bus unavailable, cannot verify')).toBeInTheDocument();
  expect(channel('Telegram')).toHaveTextContent('Bus mirror unavailable');
  expect(screen.queryByText('mirrored 2 of 3 in the last hour')).toBeNull();
});

it.each([503, 404])('keeps rows visible when the bus returns %i', async code => {
  vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/fleet/runs') ? reply(fleetRunsFixture({ inbox })) : reply({ error: 'fake' }, code)));
  render(<FleetChannelsPane {...props} />);
  await waitFor(() => expect(screen.getByText('Bus unavailable, cannot verify')).toBeInTheDocument());
  expect(within(screen.getByRole('list', { name: 'Channels' })).getAllByRole('listitem')).toHaveLength(7);
  expect(channel('Desktop app')).toHaveTextContent('Bus mirror unavailable');
  expect(screen.queryByText(/hub needs --allow-dispatch/)).toBeNull();
});
