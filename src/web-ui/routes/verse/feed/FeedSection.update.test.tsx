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
const runs = { inbox: [], mergesLastHour: { count: 1, items: [{ repo: 'ashlrai/phantom', number: 42, title: 'Merged the feed pane', mergedAt: at(2) }] }, events: [] };
const thread = { messages: [msg({ id: 'l1', at: at(1), text: 'Leader memo.' })] };
const base = { '/api/verse/leader/thread': thread, '/api/verse/fleet/runs': runs, '/api/verse/comms/owner-thread': null };

function titles(): string[] {
  return within(screen.getByRole('list', { name: 'Feed' })).getAllByRole('heading').map(h => h.textContent ?? '');
}
function stageNative(): void {
  (window as unknown as Record<string, unknown>).__ASHLR_DESKTOP__ = {
    updates: { getState: () => ({ phase: 'staged', enabled: true, version: '3.30.29', bytesReceived: 0, bytesTotal: null, reason: null }) },
  };
}

beforeEach(() => { evictAll(); resetDesktopUpdatesForTests(); resetActivityForTest(async () => ({ ...activitySnapshot('live', now), needsYou: [] })); });
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__ASHLR_DESKTOP__;
  resetDesktopUpdatesForTests(); resetActivityForTest(); vi.unstubAllGlobals();
});

describe('FeedSection update news', () => {
  it('shows a ready update and the Updates chip filters to it', async () => {
    stageNative();
    stubSurfaceFetch({ routes: { ...base, '/api/verse/ops/self-update': null } });
    render(<FeedSection visible />);
    expect(await screen.findByText('Phantom 3.30.29 is ready to install')).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('group', { name: 'Filter the feed' })).getByRole('button', { name: 'Updates' }));
    expect(titles()).toEqual(['Phantom 3.30.29 is ready to install']);
  });

  it('renders the other items with no error when the update read is a 404', async () => {
    stubSurfaceFetch({ routes: { ...base, '/api/verse/ops/self-update': null } });
    render(<FeedSection visible />);
    await waitFor(() => expect(titles()).toEqual(['Leader memo.', 'Merged the feed pane']));
    expect(screen.queryByText(/could not be loaded|unavailable/)).toBeNull();
  });

  it('renders the other items with no error when the update read fails', async () => {
    stubSurfaceFetch({ routes: { ...base, '/api/verse/ops/self-update': () => new Response('{}', { status: 500 }) } });
    render(<FeedSection visible />);
    await waitFor(() => expect(titles()).toEqual(['Leader memo.', 'Merged the feed pane']));
    expect(screen.queryByText(/could not be loaded|unavailable/)).toBeNull();
  });
});
