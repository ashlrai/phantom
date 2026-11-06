import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { markCheckComplete } from '../../data/auth-store.js';
import { evictAll } from '../../data/cache.js';
import { RailBusChip } from '../../routes/verse/shell/RailStatus.js';
import { NotificationBell } from './NotificationBell.js';
import { NotificationCenter } from './NotificationCenter.js';
import { __resetNotificationStoreForTests, getNotificationSnapshot } from './notification-store.js';

afterEach(() => { cleanup(); markCheckComplete(false); evictAll(); __resetNotificationStoreForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('shows the rail-poll reply in the bell once across subsequent polls', async () => {
  markCheckComplete(false);
  evictAll();
  __resetNotificationStoreForTests();
  markCheckComplete(true);
  const now = Date.now();
  // The API sends remaining TTL, which can be less than the receipt's age.
  const page = { v: 1, status: 'ok', nextCursor: 1, messages: [{ cursor: 1, receivedAt: now - 60_000,
    envelope: { id: 'fake-reply', from: 'leader', to: 'all', priority: 'P1', ttl: 30_000,
      body: { replyTo: 'mason-desktop-fake', text: 'Acknowledged ping' } } }] };
  const status = { v: 1, source: 'available', retainedCount: 1, retainedBytes: 100, liveCount: 1, expiredCount: 0,
    maxMessages: 1024, maxBytes: 1048576 };
  const fetch = vi.fn(async (path: string) => {
    if (path === '/api/verse/agent-bus/status') return Response.json(status);
    if (path === '/api/verse/agent-bus?after=0&limit=100') return Response.json(page);
    return Response.json(null);
  });
  vi.stubGlobal('fetch', fetch);
  const intervals = vi.spyOn(globalThis, 'setInterval');
  render(<><NotificationBell /><NotificationCenter /><RailBusChip openBus={() => undefined} /></>);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Notifications, 1 open, 0 urgent' })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Notifications, 1 open, 0 urgent' }));
  expect(screen.getByText('leader replied on the bus')).toBeInTheDocument();
  expect(screen.getByText('Acknowledged ping')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open bus' })).toHaveAttribute('href', expect.stringContaining('pane=fleet-bus'));
  const poll = intervals.mock.calls.find(call => call[1] === 15_000)?.[0];
  expect(poll).toBeTypeOf('function');
  await act(async () => { (poll as () => void)(); });
  await waitFor(() => expect(fetch.mock.calls.filter(([path]) => path.includes('/api/verse/agent-bus?'))).toHaveLength(2));
  expect(getNotificationSnapshot().items.filter(item => item.id === 'bus-reply:fake-reply')).toHaveLength(1);
  expect(screen.getAllByText('leader replied on the bus')).toHaveLength(1);
});
