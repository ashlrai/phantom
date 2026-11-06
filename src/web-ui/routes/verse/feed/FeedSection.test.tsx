import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerseActivityResponse } from '../../../../core/verse/workbench-types.js';
import { evictAll } from '../../../data/cache.js';
import { ApiError } from '../../../data/client.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { activitySnapshot, needsYouItems } from '../command/fixtures.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { resetActivityForTest } from '../shell/useActivity.js';
import { FeedSection } from './FeedSection.js';

const now = Date.now();
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const runs = {
  inbox: [],
  mergesLastHour: { count: 1, items: [{ repo: 'ashlrai/phantom', number: 42, title: 'Merged the feed pane', mergedAt: at(2) }] },
  events: [],
};
const thread = { messages: [msg({ id: 'l1', at: at(1), text: 'Memo: raise Grok to 3 lanes.' })] };

function activity(): VerseActivityResponse {
  return { ...activitySnapshot('live', now), needsYou: [needsYouItems(now)[1]!] };
}

function titles(): string[] {
  const list = screen.getByRole('list', { name: 'Feed' });
  return within(list).getAllByRole('heading').map(h => h.textContent ?? '');
}

beforeEach(() => { evictAll(); });
afterEach(() => { resetActivityForTest(); vi.unstubAllGlobals(); });

describe('FeedSection', () => {
  it('merges three sources newest first, and the chips filter them', async () => {
    stubSurfaceFetch({ routes: { '/api/verse/leader/thread': thread, '/api/verse/fleet/runs': runs } });
    resetActivityForTest(async () => activity());
    render(<FeedSection visible />);
    await waitFor(() => expect(titles()).toEqual(['Memo: raise Grok to 3 lanes.', 'Merged the feed pane', 'Leader will raise Grok to 3 lanes in 18m']));
    expect(screen.queryByText('Some updates could not be loaded.')).toBeNull();
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/42');

    const filters = screen.getByRole('group', { name: 'Filter the feed' });
    fireEvent.click(within(filters).getByRole('button', { name: 'Merges' }));
    expect(within(filters).getByRole('button', { name: 'Merges' })).toHaveAttribute('aria-pressed', 'true');
    expect(titles()).toEqual(['Merged the feed pane']);
    fireEvent.click(within(filters).getByRole('button', { name: 'Alerts' }));
    expect(titles()).toEqual(['Leader will raise Grok to 3 lanes in 18m']);
    fireEvent.click(within(filters).getByRole('button', { name: 'Leader' }));
    expect(titles()).toEqual(['Memo: raise Grok to 3 lanes.']);
    fireEvent.click(within(filters).getByRole('button', { name: 'All' }));
    expect(titles()).toHaveLength(3);
  });

  it('renders the rest with a note when one source fails', async () => {
    stubSurfaceFetch({ routes: { '/api/verse/leader/thread': null, '/api/verse/fleet/runs': runs } });
    resetActivityForTest(async () => activity());
    render(<FeedSection visible />);
    expect(await screen.findByText('Some updates could not be loaded.')).toBeInTheDocument();
    await waitFor(() => expect(titles()).toEqual(['Merged the feed pane', 'Leader will raise Grok to 3 lanes in 18m']));
  });

  it('says the feed is unavailable when every source fails, and empty when nothing happened', async () => {
    stubSurfaceFetch({ routes: { '/api/verse/leader/thread': null, '/api/verse/fleet/runs': () => new Response('{}', { status: 500 }) } });
    resetActivityForTest(async () => { throw new ApiError('not found', 404, '/api/verse/activity'); });
    const view = render(<FeedSection visible />);
    expect(await screen.findByText(/The Feed is unavailable/)).toBeInTheDocument();
    view.unmount();

    evictAll();
    stubSurfaceFetch({ routes: { '/api/verse/leader/thread': { messages: [] }, '/api/verse/fleet/runs': { inbox: [] } } });
    resetActivityForTest(async () => ({ ...activity(), needsYou: [] }));
    render(<FeedSection visible />);
    expect(await screen.findByText(/Nothing new yet/)).toBeInTheDocument();
  });
});
