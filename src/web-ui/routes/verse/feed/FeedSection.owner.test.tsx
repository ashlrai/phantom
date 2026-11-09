import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { activitySnapshot } from '../command/fixtures.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { resetActivityForTest } from '../shell/useActivity.js';
import { FeedSection } from './FeedSection.js';

vi.mock('../command/nav.js', () => ({ openChat: vi.fn() }));

const now = Date.now();
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const runs = { inbox: [], mergesLastHour: { count: 1, items: [{ repo: 'ashlrai/phantom', number: 42, title: 'Merged the feed pane', mergedAt: at(2) }] }, events: [] };
const thread = { messages: [msg({ id: 'l1', at: at(1), text: 'Leader memo.' })] };
const line = (over: Record<string, unknown>) => ({ seq: 1, id: 'o1', channel: 'telegram', senderId: '100000001', direction: 'inbound', at: at(3), text: 'Please ship the feed.', ...over });
const ownerBody = (messages: unknown[], status?: unknown) => ({ schema: 'comms.owner-thread.v1', messages, ...(status ? { status } : {}) });
const base = { '/api/verse/leader/thread': thread, '/api/verse/fleet/runs': runs };

function titles(): string[] {
  return within(screen.getByRole('list', { name: 'Feed' })).getAllByRole('heading').map(h => h.textContent ?? '');
}

beforeEach(() => { evictAll(); resetActivityForTest(async () => ({ ...activitySnapshot('live', now), needsYou: [] })); });
afterEach(() => { resetActivityForTest(); vi.unstubAllGlobals(); });

describe('FeedSection owner lines', () => {
  it('renders an owner line with its label chip, and the Channels chip filters to it', async () => {
    stubSurfaceFetch({ routes: { ...base, '/api/verse/comms/owner-thread': ownerBody([line({})]) } });
    render(<FeedSection visible />);
    expect(await screen.findByText('Mason via Telegram')).toBeInTheDocument();
    await waitFor(() => expect(titles()).toEqual(['Leader memo.', 'Merged the feed pane', 'Please ship the feed.']));
    fireEvent.click(within(screen.getByRole('group', { name: 'Filter the feed' })).getByRole('button', { name: 'Channels' }));
    expect(titles()).toEqual(['Please ship the feed.']);
  });

  it('renders the other sources with no note when the owner route is a 404', async () => {
    stubSurfaceFetch({ routes: { ...base, '/api/verse/comms/owner-thread': null } });
    render(<FeedSection visible />);
    await waitFor(() => expect(titles()).toEqual(['Leader memo.', 'Merged the feed pane']));
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
  });

  it('notes a failure when the owner route alone returns a 500', async () => {
    stubSurfaceFetch({ routes: { ...base, '/api/verse/comms/owner-thread': () => new Response('{}', { status: 500 }) } });
    render(<FeedSection visible />);
    expect(await screen.findByText('Some updates could not be loaded.')).toBeInTheDocument();
    await waitFor(() => expect(titles()).toEqual(['Leader memo.', 'Merged the feed pane']));
  });

  it('shows the paused note and no owner lines when the channels are paused', async () => {
    stubSurfaceFetch({ routes: { ...base, '/api/verse/comms/owner-thread': ownerBody([line({})], { paused: true }) } });
    render(<FeedSection visible />);
    expect(await screen.findByText('Owner channels are paused; their messages are hidden.')).toBeInTheDocument();
    await waitFor(() => expect(titles()).toEqual(['Leader memo.', 'Merged the feed pane']));
    expect(screen.queryByText('Please ship the feed.')).toBeNull();
  });
});
