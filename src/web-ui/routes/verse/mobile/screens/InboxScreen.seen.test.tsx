import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll, refetchQuery } from '../../../../data/cache.js';
import { fleetRunsFixture } from '../../fleet/fleet-runs-fixtures.test-support.js';
import { resetInboxReadMissingForTest } from '../inbox-read-query.js';
import { inboxTailQuery } from '../inbox-tail-query.js';
import { mobileTime } from '../interject-ack-model.js';
import { renderMobile, stubFetch } from '../mobile.test-support.js';
import { InboxScreen } from './InboxScreen.js';

afterEach(() => {
  evictAll();
  resetInboxReadMissingForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('shows each acknowledgment, counts the filtered rows, and updates after a pass', async () => {
  const now = Date.parse('2026-10-31T04:24:00Z');
  vi.spyOn(Date, 'now').mockReturnValue(now);
  let ageSeconds = 300;
  stubFetch({
    'GET /api/verse/fleet/runs/inbox': {
      v: 1, generatedAt: '2026-10-31T04:20:00Z', sourceState: 'healthy', limit: 100, source: null, dropped: 0,
      entries: [
        { at: '2026-10-31 00:13', source: 'desktop', priority: null, text: 'Already read' },
        { at: '2026-10-31 00:16', source: 'telegram', priority: null, text: 'Still waiting' },
      ],
    },
    'GET /api/verse/fleet/runs': () => fleetRunsFixture({
      generatedAt: '2026-10-31T04:20:00Z', host: null, claudeLane: null,
      leaders: [{ label: 'fake leader', ageSeconds }], inbox: [],
    }),
  });
  renderMobile(<InboxScreen />);
  const seen = await screen.findByText('Already read');
  const waiting = screen.getByText('Still waiting');
  await waitFor(() => expect(within(seen.closest('article')!).getByText(`Seen by leaders ${mobileTime('2026-10-31T04:15:00Z')}`)).toBeInTheDocument());
  expect(within(waiting.closest('article')!).getByText('Waiting · next pass due in about 6 min')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('1 waiting for a leader pass');
  const filters = screen.getByRole('group', { name: 'Filter by source' });
  fireEvent.click(within(filters).getByRole('button', { name: 'desktop' }));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  fireEvent.click(within(filters).getByRole('button', { name: 'All' }));
  ageSeconds = 0;
  await act(() => refetchQuery(inboxTailQuery.key, () => inboxTailQuery.fetch(), true));
  expect(within(screen.getByText('Still waiting').closest('article')!).getByText(`Seen by leaders ${mobileTime('2026-10-31T04:20:00Z')}`)).toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
