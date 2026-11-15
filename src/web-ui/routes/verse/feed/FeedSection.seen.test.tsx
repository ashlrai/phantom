import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDesktopUpdatesForTests } from '../../../app/desktop-updates.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { activitySnapshot } from '../command/fixtures.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { resetActivityForTest } from '../shell/useActivity.js';
import { resetFeedDismissals } from './feed-dismiss-store.js';
import { FEED_SEEN_STORAGE_KEY, resetFeedSeen } from './feed-seen-store.js';
import { FeedSection } from './FeedSection.js';

vi.mock('../command/nav.js', () => ({ openChat: vi.fn() }));

const now = Date.now();
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const runs = { inbox: [], mergesLastHour: { count: 0, items: [] }, events: [] };
const routes = {
  '/api/verse/leader/thread': { messages: [msg({ id: 'l1', at: at(1), text: 'Fake note one.' }), msg({ id: 'l2', at: at(3), text: 'Fake note two.' })] },
  '/api/verse/fleet/runs': runs,
  '/api/verse/comms/owner-thread': null,
  '/api/verse/ops/self-update': null,
};
const seenBetween = () => { localStorage.setItem(FEED_SEEN_STORAGE_KEY, JSON.stringify(at(2))); resetFeedSeen(); };
const titles = () => within(screen.getByRole('list', { name: 'Feed' })).getAllByRole('heading').map(h => h.textContent ?? '');

beforeEach(() => {
  localStorage.clear(); resetFeedDismissals(); resetFeedSeen(); evictAll(); resetDesktopUpdatesForTests();
  resetActivityForTest(async () => ({ ...activitySnapshot('live', now), needsYou: [] }));
  stubSurfaceFetch({ routes });
});
afterEach(() => { cleanup(); resetActivityForTest(); vi.unstubAllGlobals(); });

describe('FeedSection new since you last looked', () => {
  it('counts the new item and puts the Earlier separator between new and old', async () => {
    seenBetween();
    render(<FeedSection visible />);
    await waitFor(() => expect(titles()).toHaveLength(2));
    expect(screen.getByText('1 new since you last looked')).toBeInTheDocument();
    const rows = [...screen.getByRole('list', { name: 'Feed' }).children].map(li => li.getAttribute('role') === 'separator' ? 'Earlier' : li.querySelector('h1, h2, h3, h4')?.textContent);
    expect(rows).toEqual(['Fake note one.', 'Earlier', 'Fake note two.']);
  });

  it('shows nothing on a first launch', async () => {
    render(<FeedSection visible />);
    await waitFor(() => expect(titles()).toHaveLength(2));
    expect(screen.queryByText(/new since you last looked/)).toBeNull();
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('Mark all seen clears the line and the separator', async () => {
    seenBetween();
    render(<FeedSection visible />);
    await waitFor(() => expect(screen.getByText('1 new since you last looked')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Mark all seen' }));
    expect(screen.queryByText(/new since you last looked/)).toBeNull();
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('leaving the Feed marks it seen, so a remount shows no count', async () => {
    seenBetween();
    const view = render(<FeedSection visible />);
    await waitFor(() => expect(screen.getByText('1 new since you last looked')).toBeInTheDocument());
    view.rerender(<FeedSection visible={false} />);
    view.unmount();
    render(<FeedSection visible />);
    await waitFor(() => expect(titles()).toHaveLength(2));
    expect(screen.queryByText(/new since you last looked/)).toBeNull();
  });

  it('does not count a dismissed new item', async () => {
    seenBetween();
    render(<FeedSection visible />);
    await waitFor(() => expect(screen.getByText('1 new since you last looked')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Fake note one.' }));
    expect(screen.queryByText(/new since you last looked/)).toBeNull();
    expect(screen.queryByRole('separator')).toBeNull();
  });
});
