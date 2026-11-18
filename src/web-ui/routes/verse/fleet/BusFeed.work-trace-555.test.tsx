import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { BusFeed } from './BusFeed.js';
import type { BusFeedData } from './bus-feed-queries.js';

const busPath = '/api/verse/fleet/live/bus';
const tracePath = '/api/verse/fleet/control/work-trace';
const now = Date.parse('2026-11-17T12:02:00Z');
const ev = (id: string, minute: number) => ({ at: `2026-11-17T12:0${minute}:00Z`, kind: 'inbox' as const, text: `INBOX request id=${id} from fake-lane` });
const feed = (): BusFeedData => ({ v: 1, hops: [], hopsDropped: 0, lastHopAt: null, sources: { hops: 'healthy', events: 'healthy' },
  events: [ev('m-recv', 0), ev('m-assigned', 1), ev('m-noreceipt', 2)] });
const item = (id: string, state: string, extra = {}) => ({ id, state, asOf: '2026-11-17T11:00:00.000Z', source: 's', missing: [], owner: null, claimReceipt: null, inbox: 'found', claims: 'available', ...extra });
const trace = () => ({ v: 1, authority: 'none', generatedAt: '2026-11-17T12:02:00.000Z', items: [
  item('m-recv', 'RECEIVED'),
  item('m-assigned', 'ASSIGNED', { owner: 'fake-owner', claimReceipt: 'bus-claim:m-assigned:1:2' }),
  item('m-noreceipt', 'ASSIGNED', { owner: 'fake-owner' })] });
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Bus feed work state (555)', () => {
  it('renders a chip per request row from one batched GET', async () => {
    const { fetchMock, posted } = stubSurfaceFetch({ routes: { [busPath]: feed(), [tracePath]: trace() } });
    render(<BusFeed now={now} />);
    expect(await screen.findByText('RECEIVED')).toBeInTheDocument();
    expect(screen.getByText('ASSIGNED')).toHaveAttribute('title', expect.stringContaining('owner fake-owner'));
    expect(screen.getByText('ASSIGNED')).toHaveAttribute('title', expect.stringContaining('claim bus-claim:m-assigned:1:2'));
    expect(screen.getByText('ASSIGNED')).toHaveAttribute('title', expect.stringContaining('as of 2026-11-17T11:00:00.000Z'));
    const calls = fetchMock.mock.calls.map(c => String(c[0])).filter(u => u.includes(tracePath));
    expect(calls).toHaveLength(1);
    for (const id of ['m-recv', 'm-assigned', 'm-noreceipt']) expect(calls[0]).toContain(`id=${id}`);
    expect(posted).toEqual([]);
  });
  it('does not show ASSIGNED without a claim receipt', async () => {
    stubSurfaceFetch({ routes: { [busPath]: feed(), [tracePath]: trace() } });
    render(<BusFeed now={now} />);
    expect(await screen.findByText('state unknown')).toBeInTheDocument();
    expect(screen.getAllByText('ASSIGNED')).toHaveLength(1);
  });
  it('says state unknown on every request row when the trace fails', async () => {
    stubSurfaceFetch({ routes: { [busPath]: feed(), [tracePath]: null } });
    render(<BusFeed now={now} />);
    expect(await screen.findAllByText('state unknown')).toHaveLength(3);
    expect(screen.queryByText('RECEIVED')).toBeNull();
  });
});
