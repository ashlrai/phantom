import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDesktopUpdatesForTests } from '../../../app/desktop-updates.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { activitySnapshot } from '../command/fixtures.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { resetActivityForTest } from '../shell/useActivity.js';
import { FeedSection } from './FeedSection.js';

vi.mock('../command/nav.js', () => ({ openChat: vi.fn() }));

const now = Date.now();
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const runs = { inbox: [], mergesLastHour: { count: 0, items: [] }, events: [] };
const thread = { messages: [msg({ id: 'l1', at: at(1), text: 'Leader memo.' })] };
const base = { '/api/verse/leader/thread': thread, '/api/verse/fleet/runs': runs, '/api/verse/comms/owner-thread': null, '/api/verse/ops/self-update': null };
const row = (cursor: number, priority: string, text: string) =>
  ({ cursor, receivedAt: now - cursor * 60_000, envelope: { id: `env-${cursor}`, from: 'claude-1', to: 'leader', priority, ttl: 3_600_000, body: { text } } });
const busPage = { v: 1, status: 'ok', nextCursor: 2, messages: [row(1, 'P0', 'Main is red'), row(2, 'P2', 'Routine chatter')] };

function titles(): string[] {
  return within(screen.getByRole('list', { name: 'Feed' })).getAllByRole('heading').map(h => h.textContent ?? '');
}

beforeEach(() => { evictAll(); resetDesktopUpdatesForTests(); resetActivityForTest(async () => ({ ...activitySnapshot('live', now), needsYou: [] })); });
afterEach(() => { resetDesktopUpdatesForTests(); resetActivityForTest(); vi.unstubAllGlobals(); });

describe('FeedSection bus messages', () => {
  it('shows a P0 message with its label, hides P2, and the Bus chip filters to it', async () => {
    stubSurfaceFetch({ routes: { ...base, '/api/verse/agent-bus': busPage } });
    render(<FeedSection visible />);
    expect(await screen.findByText('Main is red')).toBeInTheDocument();
    expect(screen.getByText('claude-1 → leader · P0')).toBeInTheDocument();
    expect(screen.queryByText('Routine chatter')).toBeNull();
    fireEvent.click(within(screen.getByRole('group', { name: 'Filter the feed' })).getByRole('button', { name: 'Bus' }));
    expect(titles()).toEqual(['Main is red']);
  });

  it('renders the rest of the Feed with no error text when the bus route is a 404', async () => {
    stubSurfaceFetch({ routes: { ...base, '/api/verse/agent-bus': null } });
    render(<FeedSection visible />);
    await waitFor(() => expect(titles()).toEqual(['Leader memo.']));
    expect(screen.queryByText(/could not be loaded|unavailable/)).toBeNull();
  });
});
