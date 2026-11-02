import { screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../../data/cache.js';
import { fleetRunsFixture } from '../../fleet/fleet-runs-fixtures.test-support.js';
import { resetInboxReadMissingForTest } from '../inbox-read-query.js';
import { renderMobile, stubFetch } from '../mobile.test-support.js';
import { InboxScreen } from './InboxScreen.js';

afterEach(() => {
  evictAll();
  resetInboxReadMissingForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(entries: Array<{ at: string; source: string; priority: null; text: string }>) {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-31T04:24:00Z'));
  stubFetch({
    'GET /api/verse/fleet/runs/inbox': { v: 1, generatedAt: '2026-10-31T04:24:00Z', sourceState: 'healthy', limit: 100, source: null, dropped: 0, entries },
    'GET /api/verse/fleet/runs': fleetRunsFixture({ generatedAt: '2026-10-31T04:24:00Z', host: null, claudeLane: null, leaders: [{ label: 'fake leader', ageSeconds: 480 }], inbox: [] }),
  });
  renderMobile(<InboxScreen />);
}

it('shows the pending summary above the inbox entries', async () => {
  setup([{ at: '2026-10-31 00:20', source: 'phone', priority: null, text: 'A message' }]);
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 waiting for a leader pass · next due in 7 min'));
});

it('hides the summary for an empty inbox', async () => {
  setup([]);
  await screen.findByText('Nothing yet.');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
