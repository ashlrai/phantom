import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeedItem, FeedReport } from '../../../../core/feed-schema.js';
import { mockViewport } from '../shell/viewport.test-support.js';
import { FeedSection } from './FeedSection.js';
import { FeedNavBadge } from './FeedNavBadge.js';
import { buildFeed, sharedFeedAdapter } from './feed-model.js';

/** Query results by cache key: `shared-feed` is the default page, `shared-feed:<kind>:<limit>` the rest. */
let byKey: Record<string, unknown> = {};
let sharedError: Error | undefined;
const requested: string[] = [];
vi.mock('../../../data/hooks.js', () => ({
  useQuery: (q: { key: string }) => { requested.push(q.key); return { data: byKey[q.key], error: q.key === 'shared-feed' ? sharedError : undefined }; },
  useRefetch: () => vi.fn(),
}));
vi.mock('../../../app/desktop-updates.js', () => ({ useDesktopUpdates: () => null }));
vi.mock('../shell/useActivity.js', () => ({ useActivity: () => ({ status: 'loading' }) }));
vi.mock('./feed-seen-store.js', async load => ({ ...await load<typeof import('./feed-seen-store.js')>(), useFeedSeen: () => ({ seenAt: '2026-11-17T10:00:00.000Z', markSeen: vi.fn() }) }));

const at = (minute: number) => `2026-11-17T10:${String(minute).padStart(2, '0')}:00.000Z`;
const item = (kind: FeedItem['kind'], minute: number, text: string, href: string, more: Partial<FeedItem> = {}): FeedItem =>
  ({ id: `${kind}:${minute}`, kind, at: at(minute), text, detail: null, href, repo: null, lane: null, job: null, count: 1, ...more });
const rows: FeedItem[] = [
  item('merged', 1, 'Merged #42 Add the feed in phantom', 'https://github.com/ashlrai/phantom/pull/42', { repo: 'phantom' }),
  item('released', 2, 'Released ashlrai/phantom v3.31.0', 'https://github.com/ashlrai/phantom/releases/tag/v3.31.0'),
  item('failed', 3, 'RQ-TEST ended with no change: already on main', '/verse/?pane=worker-log', { job: 'RQ-TEST' }),
  item('incident', 4, 'Lane hold: codex credits exhausted', '/verse/?pane=fleet-bus', { count: 3 }),
  item('leader', 5, 'The update is ready.', '/verse/?pane=leader-thread'),
];
const sources = { jobs: 'available', events: 'available', leader: 'available', merges: 'available', releases: 'available', main: 'available' } as const;
const report = (items: unknown[], more = false): FeedReport => ({ schema: 'phantom.feed.v2', version: 2, items, more, sources }) as FeedReport;
afterEach(() => { cleanup(); localStorage.clear(); byKey = {}; sharedError = undefined; requested.length = 0; });

describe('Feed built on /api/feed', () => {
  it.each([['desktop', 1440], ['phone', 390]])('renders one card per event at %s width (%ipx)', (_label, width) => {
    const viewport = mockViewport(width);
    try {
      byKey = { 'shared-feed': report([...rows].reverse()) };
      const host = { openPane: vi.fn() };
      render(<FeedSection host={host} />);
      const list = screen.getByRole('list', { name: 'Feed' });
      const cards = within(list).getAllByRole('listitem');
      expect(cards.map(card => card.getAttribute('data-kind'))).toEqual(['leader', 'incident', 'failed', 'released', 'merged']);
      expect(within(list).getAllByRole('img').map(icon => icon.getAttribute('aria-label'))).toEqual(['Leader', 'Incidents', 'Failed', 'Released', 'Merged']);
      expect([...list.querySelectorAll('time')].map(time => time.dateTime)).toEqual([...rows].reverse().map(row => row.at));
      expect(within(cards[1]!).getByText(/3 times/)).toBeInTheDocument();
      const links = within(list).getAllByRole('link');
      expect(links.map(link => link.textContent)).toEqual([...rows].reverse().map(row => row.text));
      fireEvent.click(links[0]!);
      expect(host.openPane).toHaveBeenLastCalledWith('leader-thread');
      fireEvent.click(links[2]!);
      expect(host.openPane).toHaveBeenLastCalledWith('worker-log');
      expect(links[4]).toHaveAttribute('target', '_blank');
      expect(links[4]).toHaveAttribute('rel', 'noopener noreferrer');
      expect(screen.getByRole('group', { name: 'Filter the feed' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Running chats' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    } finally { viewport.restore(); }
  });

  it('keeps cards inside a 390 px column: shrinkable text track, wrapping links, a full-size Load more target', async () => {
    const css = await readFile(resolve(process.cwd(), 'src/web-ui/routes/verse/feed/feed.module.css'), 'utf8');
    expect(/\.card \{[^}]*grid-template-columns: 1\.75rem minmax\(0, 1fr\)/.test(css)).toBe(true);
    expect(/\.cardBody a, [^{]*\{[^}]*overflow-wrap: anywhere/.test(css)).toBe(true);
    expect(/\.more \{[^}]*min-height: 2\.75rem/.test(css)).toBe(true);
    expect(/width: \d{3,}px/.test(css)).toBe(false);
  });

  it('filters by kind and loads more through the same route', () => {
    byKey = { 'shared-feed': report(rows, true), 'shared-feed:incident:30': report([rows[3]]), 'shared-feed:all:60': report([...rows, item('merged', 0, 'Older merge', 'https://github.com/ashlrai/phantom/pull/7')]) };
    render(<FeedSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(requested).toContain('shared-feed:all:60');
    expect(screen.getByRole('link', { name: 'Older merge' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Incidents' }));
    expect(screen.getByRole('button', { name: 'Incidents' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(screen.getByRole('list', { name: 'Feed' })).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('puts a burst behind one tap, shows a lane pause in plain words, and an empty filter leads back to everything', () => {
    const group = [1, 2, 3].map(n => ({ text: `Merged #${n} Change ${n} in phantom`, href: `https://github.com/ashlrai/phantom/pull/${n}`, at: at(n) }));
    byKey = { 'shared-feed:lane:30': report([]), 'shared-feed': report([
      item('merged', 9, '3 PRs merged in phantom in the last hour', '/verse/?pane=fleet-merges', { group: [...group, { text: 'Bad link', href: 'javascript:alert(1)', at: at(0) }, null as never] }),
      item('lane', 8, 'The codex lane hit its plan limit and is paused', '/verse/?pane=fleet-lanes', { lane: 'codex', detail: 'codex credits exhausted (limit)' }),
    ]) };
    const host = { openPane: vi.fn() };
    render(<FeedSection host={host} />);
    const [burst, lane] = within(screen.getByRole('list', { name: 'Feed' })).getAllByRole('listitem').filter(card => card.hasAttribute('data-kind'));
    expect(within(burst!).getByText('Show all 4')).toBeInTheDocument();
    expect(within(burst!).getAllByRole('link').map(link => link.getAttribute('href'))).toEqual(['/verse/?pane=fleet-merges', ...group.map(entry => entry.href)]);
    expect(within(burst!).getByText('Bad link').closest('a')).toBeNull();
    expect(within(lane!).getByRole('img', { name: 'Lanes' })).toBeInTheDocument();
    expect(within(lane!).getByText('codex credits exhausted (limit)')).toBeInTheDocument();
    fireEvent.click(within(lane!).getByRole('link'));
    expect(host.openPane).toHaveBeenLastCalledWith('fleet-lanes');
    fireEvent.click(screen.getByRole('button', { name: 'Lanes' }));
    expect(screen.getByText(/No lanes events in the last 7 days/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('says plainly when the feed is empty, partly unknown, or unavailable', () => {
    byKey = { 'shared-feed': report([]) };
    const view = render(<FeedSection />);
    expect(screen.getByText(/Nothing new yet/)).toBeInTheDocument();
    expect(screen.queryByText('Loading the feed…')).toBeNull();
    byKey = { 'shared-feed': { ...report([]), sources: { ...sources, main: 'unknown', releases: 'unknown' } } };
    view.rerender(<FeedSection />);
    expect(screen.getByText('Some updates are unavailable: releases, main status. The feed will retry.')).toBeInTheDocument();
    byKey = { 'shared-feed': { ...report([]), sources: Object.fromEntries(Object.keys(sources).map(key => [key, 'unknown'])) } };
    view.rerender(<FeedSection />);
    expect(screen.getByText(/The Feed is unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing new yet/)).toBeNull();
    byKey = { 'shared-feed': report(rows) }; sharedError = new Error('refresh failed');
    view.rerender(<FeedSection />);
    expect(screen.getByText(/Showing the last successful read/)).toBeInTheDocument();
  });

  it('drops malformed rows and never links outside the allowlist', () => {
    byKey = { 'shared-feed': report([null, { ...rows[0], kind: 'merge' }, { ...rows[0], at: 'invalid' }, { ...rows[1], href: 'javascript:alert(1)' }]) };
    render(<FeedSection />);
    const list = screen.getByRole('list', { name: 'Feed' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).queryAllByRole('link')).toHaveLength(0);
    expect(within(list).getByText(rows[1]!.text)).toBeInTheDocument();
    expect(sharedFeedAdapter(report(['//evil.test', 'https://github.com.evil.test/pull/1', '/verse/?pane=terminal'].map(href => ({ ...rows[0], href }))))
      .every(row => !row.shared)).toBe(true);
    expect(sharedFeedAdapter({ items: rows })).toEqual([]);
  });

  it('feeds the nav badge from the same report and dedupes legacy merges', () => {
    byKey = { 'shared-feed': report(rows) };
    render(<FeedNavBadge />);
    expect(screen.getByLabelText('Feed, 5 unseen')).toHaveTextContent('5');
    const items = buildFeed({ shared: report(rows), runs: { mergesLastHour: { count: 1, items: [{ repo: 'ashlrai/phantom', number: 42, title: 'Older title', mergedAt: at(6) }] } } });
    expect(items.filter(row => row.kind === 'merge')).toHaveLength(1);
  });
});
