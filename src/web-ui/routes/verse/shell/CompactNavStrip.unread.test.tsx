import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FEED_SCHEMA, FEED_VERSION, FEED_SOURCES } from '../../../../core/feed-schema.js';
import { CompactNavStrip } from './CompactNavStrip.js';

const feed = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: ({ key }: { key: string }) => ({
  data: key === 'shared-feed' ? { schema: FEED_SCHEMA, version: FEED_VERSION, sources: Object.fromEntries(FEED_SOURCES.map(key => [key, 'available'])), items: Array.from({ length: feed.count }, (_, i) => ({
    kind: 'leader', at: '2026-11-11T12:00:00Z', text: `Leader reply ${i}`,
  })) } : undefined,
}) }));
vi.mock('../../../app/desktop-updates.js', () => ({ useDesktopUpdates: () => null }));
vi.mock('./useActivity.js', () => ({ useActivity: () => ({ data: null }) }));
vi.mock('../feed/feed-seen-store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../feed/feed-seen-store.js')>(),
  useFeedSeen: () => ({ seenAt: '2026-11-10T12:00:00Z' }),
}));
vi.mock('../feed/feed-dismiss-store.js', () => ({ useFeedDismissals: () => ({ map: {} }), isDismissed: () => false }));
beforeEach(() => { feed.count = 0; });

describe('CompactNavStrip unread chips', () => {
  it('shows one "3 new" chip on Leader when Leader 3 / Feed 0', () => {
    render(<CompactNavStrip active="feed" needsYouCount={null} unread={{ leader: 3, feed: 0 }} onSelect={() => {}} />);
    expect(screen.getAllByLabelText(/ new$/)).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^Leader/ }).textContent).toBe('Leader3');
    expect(screen.getByLabelText('3 new')).toBeTruthy();
  });

  it('shows no chip on the active item', () => {
    render(<CompactNavStrip active="leader" needsYouCount={null} unread={{ leader: 3, feed: 0 }} onSelect={() => {}} />);
    expect(screen.queryByLabelText(/ new$/)).toBeNull();
  });

  it('caps the shared Feed badge at 99+ independently of legacy unread props', async () => {
    feed.count = 100;
    render(<CompactNavStrip active="leader" needsYouCount={null} unread={{ leader: 0, feed: 150 }} onSelect={() => {}} />);
    expect((await screen.findByLabelText('Feed, 100 unseen')).textContent).toBe('99+');
    expect(screen.queryByLabelText('150 new')).toBeNull();
  });

  it('keeps the Needs-you chip next to the new chips', async () => {
    feed.count = 2;
    render(<CompactNavStrip active={null} needsYouCount={1} unread={{ leader: 3, feed: 2 }} onSelect={() => {}} />);
    expect(screen.getByLabelText('1 waiting')).toBeTruthy();
    expect(screen.getAllByLabelText(/ new$/)).toHaveLength(1);
    expect(screen.getByLabelText('3 new')).toHaveTextContent('3');
    expect(await screen.findByLabelText('Feed, 2 unseen')).toHaveTextContent('2');
  });
});
