import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeedReport } from '../../../../core/feed.js';
import { FeedSection } from './FeedSection.js';
import { FeedNavBadge } from './FeedNavBadge.js';
import { buildFeed, sharedFeedAdapter } from './feed-model.js';

let shared: unknown;
let sharedError: Error | undefined;
let legacy: Record<string, unknown> = {};
vi.mock('../../../data/hooks.js', () => ({ useQuery: (q: { key: string }) => ({ data: q.key === 'shared-feed' ? shared : legacy[q.key], error: q.key === 'shared-feed' ? sharedError : undefined }), useRefetch: () => vi.fn() }));
vi.mock('../../../app/desktop-updates.js', () => ({ useDesktopUpdates: () => null }));
vi.mock('../shell/useActivity.js', () => ({ useActivity: () => ({ status: 'loading' }) }));
vi.mock('./feed-seen-store.js', async load => ({ ...await load<typeof import('./feed-seen-store.js')>(), useFeedSeen: () => ({ seenAt: '2026-11-17T10:00:00.000Z', markSeen: vi.fn() }) }));
const at = (minute: number) => `2026-11-17T10:${String(minute).padStart(2, '0')}:00.000Z`;
const rows = [
  { id: 'merge:42', kind: 'merge', at: at(1), text: 'Merged the feed', href: 'https://github.com/ashlrai/phantom/pull/42' },
  { id: 'release:ashlrai/phantom@v3.31.0', kind: 'release', at: at(2), text: 'Phantom v3.31.0 is released', href: 'https://github.com/ashlrai/phantom/releases/tag/v3.31.0' },
  { id: 'blocked:job', kind: 'blocked', at: at(3), text: 'RQ-TEST is blocked', href: '/verse/?pane=fleet-bus' },
  { id: 'leader:reply', kind: 'leader-reply', at: at(4), text: 'The update is ready.', href: '/verse/?pane=leader-thread' },
];
const report = (items: unknown[]) => ({ schema: 'phantom.feed.v1', items,
  sources: { merges: 'available', releases: 'available', incidents: 'available', leaderReplies: 'available' } }) as FeedReport;
afterEach(() => { cleanup(); localStorage.clear(); legacy = {}; sharedError = undefined; });

describe('shared CLI feed', () => {
  it('renders all four fixture types newest first with one time and link each', () => {
    shared = report([...rows, null, { ...rows[0], at: 'invalid' }]);
    const host = { openPane: vi.fn() };
    render(<FeedSection host={host} />);
    const list = screen.getByRole('list', { name: 'Feed' });
    const links = within(list).getAllByRole('link');
    expect(links.map(link => link.textContent)).toEqual([...rows].reverse().map(row => row.text));
    expect(list.querySelectorAll('time')).toHaveLength(4);
    expect(within(list).queryAllByRole('button')).toHaveLength(0);
    fireEvent.click(links[0]!);
    expect(host.openPane).toHaveBeenCalledWith('leader-thread');
    fireEvent.click(links[1]!);
    expect(host.openPane).toHaveBeenLastCalledWith('fleet-bus');
    expect(links[3]).toHaveAttribute('target', '_blank');
    expect(links[3]).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByText('Loading the feed…')).toBeNull();
  });
  it('shows the shared empty state while legacy readers are still loading', () => {
    shared = report([]);
    render(<FeedSection />);
    expect(screen.getByText(/Nothing new yet/)).toBeInTheDocument();
    expect(screen.queryByText('Loading the feed…')).toBeNull();
  });
  it('distinguishes unavailable empty sources from a retained read after refresh failure', () => {
    shared = { ...report([]), sources: { merges: 'unknown', releases: 'unknown', incidents: 'unknown', leaderReplies: 'unknown' } };
    const view = render(<FeedSection />);
    expect(screen.getByText(/The Feed is unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing new yet/)).toBeNull();
    shared = report(rows); sharedError = new Error('refresh failed'); view.rerender(<FeedSection />);
    expect(screen.getByText(/Showing the last successful read/)).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Feed' })).getAllByRole('link')).toHaveLength(4);
  });
  it('rejects malformed rows and unsafe destinations', () => {
    expect(sharedFeedAdapter(report([null, [], { ...rows[0], text: 8 }, { ...rows[0], kind: 'unknown' },
      ...['javascript:alert(1)', '//evil.test', 'https://github.com.evil.test/pull/1', '/verse/?pane=terminal'].map(href => ({ ...rows[0], href }))]))).toEqual([]);
    expect(sharedFeedAdapter({ items: rows })).toEqual([]);
  });
  it('deduplicates legacy merges and replies while preserving individual shared merges', () => {
    const items = buildFeed({ shared: report(rows), runs: { mergesLastHour: { count: 1, items: [{ repo: 'ashlrai/phantom', number: 42, title: 'Older title', mergedAt: at(5) }] } },
      leader: [{ id: 'old', at: at(4), text: rows[3]!.text, from: 'leader', channel: 'verse', kind: 'message' }] });
    expect(items).toHaveLength(4);
    expect(items.every(item => item.shared)).toBe(true);
    const merges = [1, 2, 3].map(number => ({ ...rows[0], id: `merge:${number}`, href: `https://github.com/ashlrai/phantom/pull/${number}` }));
    expect(buildFeed({ shared: report(merges) })).toHaveLength(3);
  });
  it('matches the CLI stream and publication time despite newer legacy events and release polls', () => {
    shared = report(rows);
    legacy = { 'verse-fleet-runs': { events: [{ at: at(8), text: 'Legacy only', kind: 'incident' }] },
      'verse-release-stages': { schema: 'verse.release-stages.v1', tag: 'v3.31.0', checkedAt: at(9), stages: [{ stage: 'published', status: 'observed' }] } };
    render(<><FeedSection /><FeedNavBadge /></>);
    const list = screen.getByRole('list', { name: 'Feed' });
    expect([...list.querySelectorAll('time')].map(time => time.dateTime)).toEqual([...rows].reverse().map(row => row.at));
    expect(screen.queryByText('Legacy only')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Filter the feed' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Running chats' })).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByLabelText('Feed, 4 unseen')).toHaveTextContent('4');
  });
});
