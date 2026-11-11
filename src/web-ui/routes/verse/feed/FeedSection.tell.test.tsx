import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetDesktopUpdatesForTests } from '../../../app/desktop-updates.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { activitySnapshot } from '../command/fixtures.test-support.js';
import { openInterjectDialog } from '../fleet/interject-dialog-store.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { resetActivityForTest } from '../shell/useActivity.js';
import { resetFeedDismissals } from './feed-dismiss-store.js';
import { FeedSection } from './FeedSection.js';

vi.mock('../fleet/interject-dialog-store.js', () => ({ openInterjectDialog: vi.fn() }));

beforeEach(() => {
  localStorage.clear(); resetFeedDismissals(); evictAll(); resetDesktopUpdatesForTests();
  resetActivityForTest(async () => ({ ...activitySnapshot('live', Date.now()), needsYou: [] }));
  stubSurfaceFetch({ routes: {
    '/api/verse/leader/thread': { messages: [msg({ id: 'l1', at: new Date().toISOString(), text: 'RQ-FAKE-123 needs help' })] },
    '/api/verse/fleet/runs': { inbox: [], mergesLastHour: { count: 0, items: [] }, events: [] },
    '/api/verse/comms/owner-thread': null,
    '/api/verse/ops/self-update': null,
  } });
});
afterEach(() => { cleanup(); resetActivityForTest(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('opens a prefilled Leader composer without posting', async () => {
  render(<FeedSection visible />);
  const button = await screen.findByRole('button', { name: 'Tell the Leader about RQ-FAKE-123 needs help' });
  const fetchMock = vi.mocked(fetch);
  await waitFor(() => expect(screen.getByRole('list', { name: 'Feed' })).toBeInTheDocument());
  const callsBefore = fetchMock.mock.calls.length;
  fireEvent.click(button);
  expect(openInterjectDialog).toHaveBeenCalledWith({ prefill: 'About feed item "RQ-FAKE-123 needs help" (leader, RQ-FAKE-123): ' });
  expect(fetchMock.mock.calls.slice(callsBefore).some(([, options]) => options?.method === 'POST')).toBe(false);
});
