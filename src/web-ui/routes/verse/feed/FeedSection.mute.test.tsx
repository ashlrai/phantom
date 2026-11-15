import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { activitySnapshot } from '../command/fixtures.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { resetActivityForTest } from '../shell/useActivity.js';
import { reloadVerseUiForTest, resetVerseUi } from '../verse-ui-store.js';
import { FeedSection } from './FeedSection.js';

beforeEach(() => {
  resetVerseUi(); evictAll();
  resetActivityForTest(async () => ({ ...activitySnapshot('live', Date.now()), needsYou: [] }));
  stubSurfaceFetch({ routes: { '/api/verse/leader/thread': { messages: [msg({ id: 'one', at: new Date().toISOString(), text: 'A note' })] }, '/api/verse/fleet/runs': { inbox: [], mergesLastHour: { count: 0, items: [] }, events: [] }, '/api/verse/comms/owner-thread': null, '/api/verse/ops/self-update': null } });
});
afterEach(() => { cleanup(); resetVerseUi(); resetActivityForTest(); vi.unstubAllGlobals(); });
it('mutes a kind, persists it, and restores it from the footer', async () => {
  const view = render(<FeedSection />);
  await waitFor(() => expect(screen.getByText('A note')).toBeInTheDocument());
  fireEvent.click(screen.getByLabelText('More actions for A note'));
  fireEvent.click(screen.getByRole('button', { name: 'Mute Leader' }));
  expect(screen.queryByText('A note')).toBeNull();
  view.unmount(); reloadVerseUiForTest(); render(<FeedSection />);
  expect(screen.getByText('1 kinds muted')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Show' }));
  fireEvent.click(screen.getByRole('button', { name: 'Unmute leader' }));
  await waitFor(() => expect(screen.getByText('A note')).toBeInTheDocument());
});
