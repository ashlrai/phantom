import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import badgeStyles from '../../../components/primitives/StatusBadge.module.css';
import { evictAll } from '../../../data/cache.js';
import { LeaderJournalPane } from './LeaderJournalPane.js';

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('shows the overdue badge and updates its tone as time passes while visible', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T12:27:00Z'));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    v: 1, generatedAt: '2026-01-01T12:27:00Z', notes: [], sources: { orchestration: 'healthy', planLog: 'healthy', ingestLog: 'healthy', ingested: 'healthy' },
    passes: [{ at: '2026-01-01T12:00:00Z', sections: [] }], ingest: [], ingested: [], rejectedLastHour: 0,
  })));
  const view = render(<LeaderJournalPane visible />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const status = screen.getByRole('status');
  expect(status).toHaveTextContent('pass overdue by 12 min');
  expect(within(status).getByText('pass overdue by 12 min')).toHaveClass(badgeStyles.warning);
  view.rerender(<LeaderJournalPane visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(19 * 60_000); });
  expect(status).toHaveTextContent('pass overdue by 12 min');
  view.rerender(<LeaderJournalPane visible />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByRole('status')).toHaveTextContent('pass overdue by 31 min');
  expect(within(screen.getByRole('status')).getByText('pass overdue by 31 min')).toHaveClass(badgeStyles.danger);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(screen.getByRole('status')).toHaveTextContent('pass overdue by 32 min');
});
