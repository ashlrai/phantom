import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetChannelsPane } from './FleetChannelsPane.js';

const now = Date.parse('2026-11-10T12:00:00Z');
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const line = (over: Record<string, unknown>) => ({
  seq: 1, id: 'm1', idempotencyKey: 'fake-owner-key-0001', channel: 'slack', senderId: '100000001',
  direction: 'inbound', at: at(15), text: 'Phantom status', ...over,
});
const ownerBody = (messages: unknown[]) => ({ schema: 'comms.owner-thread.v1', threadId: 'owner', messages });
const props = { visible: true, host: { openPane: vi.fn() } } as unknown as PaneProps;

beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('flags a Slack row whose "Phantom status" went unanswered 15 minutes, with a header count of 1', async () => {
  stubSurfaceFetch({ now, routes: {
    '/api/verse/fleet/runs': fleetRunsFixture({ inbox: [{ at: at(15), source: 'Slack', text: 'Phantom status' }] }),
    '/api/verse/comms/owner-thread': ownerBody([line({})]),
  } });
  render(<FleetChannelsPane {...props} />);
  expect(await screen.findByText('1 channel waiting on the Leader')).toBeInTheDocument();
  const slackRow = within(screen.getByRole('list', { name: 'Channels' })).getAllByRole('listitem')
    .find(row => row.textContent?.includes('Other'));
  expect(slackRow).toHaveTextContent('Slack · Last from Mason 15m ago · Phantom status');
  expect(slackRow).toHaveTextContent('Leader reply unanswered');
  expect(slackRow).toHaveTextContent('waiting 15m');
});

it('shows the Leader reply age and no waiting count once the channel was answered', async () => {
  stubSurfaceFetch({ now, routes: {
    '/api/verse/fleet/runs': fleetRunsFixture({ inbox: [{ at: at(20), source: 'Telegram', text: 'fake telegram order' }] }),
    '/api/verse/comms/owner-thread': ownerBody([
      line({ channel: 'telegram', at: at(20), text: 'fake telegram order' }),
      line({ seq: 2, id: 'm2', channel: 'telegram', direction: 'outbound', senderId: 'leader', at: at(5), text: 'fake leader answer' }),
    ]),
  } });
  render(<FleetChannelsPane {...props} />);
  const rows = within(await screen.findByRole('list', { name: 'Channels' })).getAllByRole('listitem');
  const telegramRow = rows.find(row => row.textContent?.includes('Telegram'));
  expect(telegramRow).toHaveTextContent('Last from Mason 20m ago · fake telegram order');
  expect(telegramRow).toHaveTextContent('Leader reply 5m ago');
  expect(telegramRow).not.toHaveTextContent('Leader reply unanswered');
  expect(within(telegramRow!).queryByText(/waiting \d+m/)).toBeNull();
  expect(screen.queryByText(/channel[s]? waiting on the Leader/)).toBeNull();
});

it('renders no reply lines when the owner-thread route is missing', async () => {
  stubSurfaceFetch({ now, routes: {
    '/api/verse/fleet/runs': fleetRunsFixture({ inbox: [{ at: at(5), source: 'Telegram', text: 'fake telegram order' }] }),
    '/api/verse/comms/owner-thread': null,
  } });
  render(<FleetChannelsPane {...props} />);
  const rows = within(await screen.findByRole('list', { name: 'Channels' })).getAllByRole('listitem');
  expect(rows.find(row => row.textContent?.includes('Telegram'))).not.toHaveTextContent('Last from Mason');
  expect(screen.queryByText(/channel[s]? waiting on the Leader/)).toBeNull();
});
