import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { AwayDigestCard } from './AwayDigestCard.js';
import { buildAwayDigest } from './away-digest.js';
import type { FeedFilter, FeedItem } from './feed-model.js';
import { FEED_SEEN_STORAGE_KEY, readStored, resetFeedSeen, useFeedSeen } from './feed-seen-store.js';

const NOW = Date.parse('2026-11-10T20:00:00.000Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const SEEN = ago(190); // 3h10m ago; the newest item is 100m ago → the 90m gap shows the card.

const items: FeedItem[] = [
  { id: 'merge:ashlrai/phantom#42', at: ago(100), kind: 'merge', title: 'Merged the feed pane', body: 'ashlrai/phantom #42' },
  { id: 'release:v3.30.32:published', at: ago(110), kind: 'update', title: 'v3.30.32 is public; the required desktop assets are present.' },
  { id: 'alert:leader:veto-window:a2', at: ago(115), kind: 'alert', title: 'Leader will raise Grok to 3 lanes in 18m' },
  { id: 'leader:m1', at: ago(120), kind: 'leader', title: 'Morning memo' },
];

/** The wiring FeedSection gives the card: the shared last-seen store, the digest, the filter and dismiss. */
function Harness() {
  const { seenAt, markSeen } = useFeedSeen();
  const [filter, setFilter] = useState<FeedFilter>('all');
  const digest = buildAwayDigest(items, seenAt, NOW);
  return <>
    <div data-testid="filter">{filter}</div>
    {digest ? <AwayDigestCard digest={digest} onFilter={setFilter} onDismiss={() => markSeen(digest.newestAt)} /> : null}
  </>;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(FEED_SEEN_STORAGE_KEY, JSON.stringify(SEEN));
  resetFeedSeen();
});
afterEach(cleanup);

describe('AwayDigestCard', () => {
  it('summarizes what arrived while Mason was away', () => {
    render(<Harness />);
    const card = screen.getByRole('note', { name: 'While you were away' });
    expect(card).toHaveTextContent('While you were away (3h 10m):');
    expect(within(card).getByRole('button', { name: '1 PR merged' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'release 3.30.32 published' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: '1 ask waiting' })).toBeInTheDocument();
    expect(card).toHaveTextContent('1 other update');
    expect(card.textContent).toContain(' · ');
  });

  it('stays hidden while the gap is under the threshold, and filters to a part’s kind on click', () => {
    localStorage.setItem(FEED_SEEN_STORAGE_KEY, JSON.stringify(ago(140))); // newest is 40m past this look
    resetFeedSeen();
    const first = render(<Harness />);
    expect(screen.queryByRole('note', { name: 'While you were away' })).toBeNull();

    localStorage.setItem(FEED_SEEN_STORAGE_KEY, JSON.stringify(SEEN));
    resetFeedSeen();
    first.unmount();
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '1 PR merged' }));
    expect(screen.getByTestId('filter')).toHaveTextContent('merge');
    fireEvent.click(screen.getByRole('button', { name: '1 ask waiting' }));
    expect(screen.getByTestId('filter')).toHaveTextContent('alert');
  });

  it('Dismiss hides the card and marks the period seen', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('note', { name: 'While you were away' })).toBeNull();
    expect(readStored()).toBe(items[0]!.at);
    expect(JSON.parse(localStorage.getItem(FEED_SEEN_STORAGE_KEY)!)).toBe(items[0]!.at);
  });
});
