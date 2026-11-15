import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetDesktopUpdatesForTests } from '../../../app/desktop-updates.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { activitySnapshot } from '../command/fixtures.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { resetActivityForTest } from '../shell/useActivity.js';
import { FeedSection } from './FeedSection.js';

const now = Date.now();
beforeEach(() => { evictAll(); resetDesktopUpdatesForTests(); resetActivityForTest(async () => ({ ...activitySnapshot('live', now), needsYou: [] })); });
afterEach(() => { resetDesktopUpdatesForTests(); resetActivityForTest(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('shows and filters waiting communications and dismisses them', async () => {
  stubSurfaceFetch({ routes: {
    '/api/verse/leader/thread': { messages: [msg({ id: 'l1', at: new Date(now).toISOString(), text: 'Leader memo.' })] },
    '/api/verse/fleet/runs': { inbox: [], mergesLastHour: { count: 0, items: [] }, events: [] },
    '/api/verse/comms/owner-thread': null, '/api/verse/ops/self-update': null,
    '/api/verse/comms/inbox': { schema: 'comms.unified-inbox.v1', generatedAt: new Date(now).toISOString(), total: 3, omitted: 0, sources: {}, items: [
      { id: 'work', source: 'gmail', kind: 'gmail-over-target', severity: 'warn', title: 'Work inbox', since: null },
      { id: 'bad', source: 'gmail', kind: 'gmail-over-target', severity: 'warn', title: 'Bad inbox', since: 'bad' },
      { id: 'message', source: 'linkedin', kind: 'linkedin-message', severity: 'info', title: 'Reply to Alex', since: new Date(now).toISOString() },
    ] },
  } });
  render(<FeedSection visible />);
  expect(await screen.findByText('Gmail over target')).toBeInTheDocument();
  expect(screen.getByText('LinkedIn waiting')).toBeInTheDocument();
  expect(screen.queryByText('Bad inbox')).not.toBeInTheDocument();
  fireEvent.click(within(screen.getByRole('group', { name: 'Filter the feed' })).getByRole('button', { name: 'Comms' }));
  expect(within(screen.getByRole('list', { name: 'Feed' })).getAllByRole('heading').map(h => h.textContent)).toEqual(['Work inbox', 'Reply to Alex']);
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss Work inbox' }));
  expect(screen.queryByText('Work inbox')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Show' }));
  fireEvent.click(screen.getByRole('button', { name: 'Restore Work inbox' }));
  expect(screen.getByText('Work inbox')).toBeInTheDocument();
});
