import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDesktopUpdatesForTests } from '../../../app/desktop-updates.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { activitySnapshot } from '../command/fixtures.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { HomeUnread } from '../shell/WindowTitle.js';
import { resetActivityForTest } from '../shell/useActivity.js';
import { LAST_SEEN_STORAGE_KEY, resetLastSeen } from '../shell/last-seen-store.js';
import { resetFeedDismissals } from './feed-dismiss-store.js';
import { FeedSection } from './FeedSection.js';

vi.mock('../command/nav.js', () => ({ openChat: vi.fn() }));

const now = Date.now();
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const runs = { inbox: [], mergesLastHour: { count: 0, items: [] }, events: [] };
const routes = {
  '/api/verse/leader/thread': { messages: [msg({ id: 'l1', at: at(1), text: 'Fake note one.' }), msg({ id: 'l2', at: at(2), text: 'Fake note two.' })] },
  '/api/verse/fleet/runs': runs,
  '/api/verse/comms/owner-thread': null,
  '/api/verse/ops/self-update': null,
};

const titles = () => within(screen.getByRole('list', { name: 'Feed' })).getAllByRole('heading').map(h => h.textContent ?? '');

beforeEach(() => {
  localStorage.clear(); resetFeedDismissals(); evictAll(); resetDesktopUpdatesForTests();
  resetActivityForTest(async () => ({ ...activitySnapshot('live', now), needsYou: [] }));
  stubSurfaceFetch({ routes });
});
afterEach(() => { cleanup(); resetLastSeen(); resetActivityForTest(); vi.unstubAllGlobals(); });

describe('FeedSection dismissals', () => {
  it('dismisses an item, keeps it gone across a remount and a reload of storage', async () => {
    const first = render(<FeedSection visible />);
    await waitFor(() => expect(titles()).toEqual(['Fake note one.', 'Fake note two.']));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Fake note one.' }));
    expect(titles()).toEqual(['Fake note two.']);
    first.unmount();
    resetFeedDismissals(); // an app restart: memory gone, localStorage stays
    render(<FeedSection visible />);
    await waitFor(() => expect(titles()).toEqual(['Fake note two.']));
  });

  it('lists dismissed items under Show and brings one back with Restore', async () => {
    render(<FeedSection visible />);
    await waitFor(() => expect(titles()).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Fake note one.' }));
    expect(screen.getByText('1 dismissed')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Dismissed' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(within(screen.getByRole('list', { name: 'Dismissed' })).getByText('Fake note one.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restore Fake note one.' }));
    expect(titles()).toEqual(['Fake note one.', 'Fake note two.']);
    expect(screen.queryByText(/dismissed/)).toBeNull();
  });

  it('follows a dismissal made in another window (storage event)', async () => {
    render(<FeedSection visible />);
    await waitFor(() => expect(titles()).toHaveLength(2));
    act(() => {
      localStorage.setItem('ashlr.verse.feed.dismissed.v1', JSON.stringify({ 'leader:l2': 'leader:l2' }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'ashlr.verse.feed.dismissed.v1' }));
    });
    expect(titles()).toEqual(['Fake note one.']);
  });

  it('does not count a dismissed item as unread', async () => {
    localStorage.setItem(LAST_SEEN_STORAGE_KEY, JSON.stringify({ leader: 0, feed: 0 })); resetLastSeen();
    const onCounts = vi.fn();
    render(<><HomeUnread viewing={null} onCounts={onCounts} /><FeedSection visible /></>);
    await waitFor(() => expect(onCounts).toHaveBeenLastCalledWith(expect.objectContaining({ feed: 2 })));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Fake note one.' }));
    await waitFor(() => expect(onCounts).toHaveBeenLastCalledWith(expect.objectContaining({ feed: 1 })));
  });
});
