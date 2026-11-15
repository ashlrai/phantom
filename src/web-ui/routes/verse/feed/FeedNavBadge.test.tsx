import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeedNavBadge } from './FeedNavBadge.js';

vi.mock('../../../data/hooks.js', () => ({ useQuery: () => ({ data: undefined }) }));
vi.mock('../../../app/desktop-updates.js', () => ({ useDesktopUpdates: () => null }));
vi.mock('../shell/useActivity.js', () => ({ useActivity: () => ({ data: null }) }));
vi.mock('./feed-seen-store.js', () => ({ useFeedSeen: () => ({ seenAt: null }), countNew: () => 0 }));
vi.mock('./feed-dismiss-store.js', () => ({ useFeedDismissals: () => ({ map: {} }), isDismissed: () => false }));
vi.mock('./feed-unseen-count.js', () => ({ unseenCount: vi.fn() }));
import { unseenCount } from './feed-unseen-count.js';

afterEach(cleanup);
describe('FeedNavBadge', () => {
  it.each([[0, null], [3, '3'], [150, '99+']] as const)('renders %i unseen', (count, label) => {
    vi.mocked(unseenCount).mockReturnValue(count);
    const { container } = render(<FeedNavBadge />);
    if (label === null) expect(container.firstChild).toBeNull();
    else expect(screen.getByLabelText(`Feed, ${count} unseen`).textContent).toBe(label);
  });
});
