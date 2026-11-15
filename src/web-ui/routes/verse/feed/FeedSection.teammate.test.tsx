import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetDesktopUpdatesForTests } from '../../../app/desktop-updates.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { activitySnapshot } from '../command/fixtures.test-support.js';
import { openDockPane } from '../dock/dock-store.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { resetActivityForTest } from '../shell/useActivity.js';
import { FeedSection } from './FeedSection.js';

vi.mock('../command/nav.js', () => ({ openChat: vi.fn() }));
vi.mock('../dock/dock-store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../dock/dock-store.js')>(), openDockPane: vi.fn(),
}));

const now = Date.now();
beforeEach(() => { evictAll(); resetDesktopUpdatesForTests(); resetActivityForTest(async () => ({ ...activitySnapshot('live', now), needsYou: [] })); });
afterEach(() => { resetDesktopUpdatesForTests(); resetActivityForTest(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('shows waiting Dot texts, filters them, and opens the inbox', async () => {
  stubSurfaceFetch({ routes: {
    '/api/verse/leader/thread': { messages: [msg({ id: 'l1', at: new Date(now).toISOString(), text: 'Leader memo.' })] },
    '/api/verse/fleet/runs': { inbox: [], mergesLastHour: { count: 0, items: [] }, events: [] },
    '/api/verse/comms/owner-thread': null, '/api/verse/ops/self-update': null,
    '/api/verse/comms/inbox': { schema: 'comms.unified-inbox.v1', total: 1, omitted: 0, sources: {}, items: [
      { id: 'imessage:teammate-1', source: 'imessage', kind: 'teammate-text', severity: 'info', title: 'Please reply', since: new Date(now).toISOString() },
    ] },
  } });
  render(<FeedSection visible />);
  expect(await screen.findByText('Dot waiting')).toBeInTheDocument();
  fireEvent.click(within(screen.getByRole('group', { name: 'Filter the feed' })).getByRole('button', { name: 'Dot' }));
  expect(within(screen.getByRole('list', { name: 'Feed' })).getAllByRole('heading').map(h => h.textContent)).toEqual(['Please reply']);
  fireEvent.click(screen.getByRole('button', { name: 'Open inbox' }));
  expect(openDockPane).toHaveBeenCalledWith('fleet-inbox');
});
