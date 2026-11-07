import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../../data/cache.js';
import { resetInboxReadMissingForTest } from '../inbox-read-query.js';
import { renderMobile, stubFetch } from '../mobile.test-support.js';
import { InboxScreen } from './InboxScreen.js';

afterEach(() => {
  evictAll();
  resetInboxReadMissingForTest();
  vi.unstubAllGlobals();
});

it('collapses repeated deliveries and keeps source filtering on the raw entries', async () => {
  stubFetch({ 'GET /api/verse/fleet/runs/inbox': {
    v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy', limit: 100, source: null, dropped: 0,
    entries: [
      { at: '2026-10-31T10:00:00Z', source: 'Telegram', priority: null, text: 'Same message' },
      { at: '2026-10-31T10:01:00Z', source: 'email', priority: null, text: 'Same message' },
      { at: '2026-10-31T10:02:00Z', source: 'Phantom mobile', priority: null, text: 'Same message' },
      { at: '2026-10-31T10:03:00Z', source: 'email', priority: null, text: 'Another message' },
    ],
  } });
  renderMobile(<InboxScreen />);
  const message = await screen.findByText('Same message');
  expect(screen.getAllByRole('article')).toHaveLength(2);
  const article = message.closest('article')!;
  expect(within(article).getByTestId('inbox-repeats')).toHaveTextContent('×3 · also via Phantom mobile, email');
  expect(within(article).getByText('Telegram')).toBeInTheDocument();
  expect(screen.getByText('Another message')).toBeInTheDocument();

  fireEvent.click(within(screen.getByRole('group', { name: 'Filter by source' })).getByRole('button', { name: 'email' }));
  expect(screen.getAllByRole('article')).toHaveLength(2);
  expect(screen.queryByTestId('inbox-repeats')).not.toBeInTheDocument();
});
