import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { LeaderJournalPane } from './LeaderJournalPane.js';
import styles from './leader-journal.module.css';

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); });

it('filters, expands and highlights matching passes, then restores them when cleared', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    v: 1, generatedAt: '2026-01-01T12:05:00Z', sources: { planLog: 'healthy', ingestLog: 'healthy', ingested: 'healthy' },
    passes: [
      { at: '2026-01-01T12:01:00Z', sections: [{ title: 'Plan', bullets: ['First task'] }] },
      { at: '2026-01-01T12:02:00Z', sections: [{ title: 'Plan', bullets: ['Release approved'] }] },
      { at: '2026-01-01T12:03:00Z', sections: [{ title: 'Plan', bullets: ['Other task'] }] },
    ], ingest: [], ingested: [], rejectedLastHour: 0,
  })));
  render(<LeaderJournalPane visible />);
  const region = await screen.findByRole('region', { name: 'Passes' });
  expect(region.querySelectorAll('details')).toHaveLength(3);
  const input = screen.getByRole('searchbox', { name: 'Search journal' });
  fireEvent.change(input, { target: { value: 'release' } });
  expect(within(region).getByText('1 of 3 passes')).toBeInTheDocument();
  const details = region.querySelectorAll('details');
  expect(details).toHaveLength(1);
  expect(details[0]).toHaveAttribute('open');
  expect(within(details[0]!).getByText('Release approved', { selector: 'li' })).toHaveClass(styles.match);
  fireEvent.change(input, { target: { value: 'absent' } });
  expect(within(region).getByText('No passes match')).toBeInTheDocument();
  fireEvent.change(input, { target: { value: '' } });
  expect(region.querySelectorAll('details')).toHaveLength(3);
  expect(within(region).queryByText('1 of 3 passes')).not.toBeInTheDocument();
});
