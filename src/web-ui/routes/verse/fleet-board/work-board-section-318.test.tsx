/**
 * work-board-section-318.test.tsx — RQ-PHX-WORKBOARDPANE318. The work board
 * inside the existing Fleet Board pane: counts, rows, the missing list, and
 * the honest unreadable / not-deployed states. Fake ids only.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetBoardPane } from './FleetBoardPane.js';

const PROPS = { visible: true } as PaneProps;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function item(id: string, state: string, missing: string[], channelRef: string | null = 'ref-1') {
  return { id, channel: 'telegram', channelRef, receivedAt: ago(5 * 60_000), state, asOf: ago(0), source: 'bus', missing };
}

const WORK = {
  items: [
    item('wi-fake-blocked-0001', 'BLOCKED', ['named owner'], null),
    item('wi-fake-assigned-0002', 'ASSIGNED', []),
    item('wi-fake-verified-0003', 'VERIFIED', ['should not show']),
  ],
  inbox: 'ok',
  truncated: false,
  asOf: ago(0),
};

function stubFetch(work: () => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/verse/fleet/work-board')) return work();
    return new Response(JSON.stringify({ schema: 'fleet.leader-board.v1', status: 'missing', ageSeconds: null, board: null }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

it('renders state counts and rows, even with no Leader board', async () => {
  const fetchMock = stubFetch(() => new Response(JSON.stringify({ ...WORK, truncated: true }), { status: 200 }));
  render(<FleetBoardPane {...PROPS} />);

  await waitFor(() => expect(screen.getByText('wi-fake-bloc')).toBeInTheDocument());
  expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain('/api/verse/fleet/work-board?limit=20');
  expect(screen.getByText('No Leader board yet')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Work items' })).toBeInTheDocument();

  const counts = Object.fromEntries(
    screen.getAllByRole('listitem')
      .map((li) => li.textContent ?? '')
      .filter((t) => /^(RECEIVED|ASSIGNED|RUNNING|BLOCKED|VERIFIED)\d+$/.test(t))
      .map((t) => [t.replace(/\d+$/, ''), t.replace(/^\D+/, '')]),
  );
  expect(counts).toEqual({ RECEIVED: '0', ASSIGNED: '1', RUNNING: '0', BLOCKED: '1', VERIFIED: '1' });

  const rows = screen.getAllByRole('row');
  const blocked = rows.find((r) => within(r).queryByText('wi-fake-bloc'))!;
  expect(within(blocked).getByText('named owner')).toBeInTheDocument();
  expect(within(blocked).getAllByText('none')).toHaveLength(2);
  expect(within(blocked).getByText('5m')).toBeInTheDocument();
  expect(within(blocked).getByTitle('wi-fake-blocked-0001')).toBeInTheDocument();
  expect(screen.queryByText('should not show')).not.toBeInTheDocument();
  expect(screen.getByText('showing newest 20')).toBeInTheDocument();
});

it('prints the unreadable note and no table when the inbox is unavailable', async () => {
  stubFetch(() => new Response(JSON.stringify({ items: [], inbox: 'unavailable', truncated: false, asOf: ago(0) }), { status: 200 }));
  render(<FleetBoardPane {...PROPS} />);

  await waitFor(() => expect(screen.getByText('Work board unreadable: the bus inbox could not be read.')).toBeInTheDocument());
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(screen.queryByText('RECEIVED')).not.toBeInTheDocument();
});

it('prints the not-available note on a 404 from the route', async () => {
  stubFetch(() => new Response('{}', { status: 404 }));
  render(<FleetBoardPane {...PROPS} />);

  await waitFor(() => expect(screen.getByText('Work board not available on this Phantom build.')).toBeInTheDocument());
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});
