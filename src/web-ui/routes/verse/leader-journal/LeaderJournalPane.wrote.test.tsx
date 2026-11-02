import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import badgeStyles from '../../../components/primitives/StatusBadge.module.css';
import { evictAll } from '../../../data/cache.js';
import { LeaderJournalPane } from './LeaderJournalPane.js';

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('shows the number of jobs written by each pass and the latest pass in the headline', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T12:30:00Z'));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    v: 1, generatedAt: '2026-01-01T12:30:00Z', notes: [], sources: { orchestration: 'healthy', planLog: 'healthy', ingestLog: 'healthy', ingested: 'healthy' },
    passes: [
      { at: '2026-01-01T12:00:00Z', sections: [{ title: 'Plan', bullets: ['Old summary'] }] },
      { at: '2026-01-01T12:10:00Z', sections: [] },
      { at: '2026-01-01T12:20:00Z', sections: [] },
    ],
    ingest: [], ingested: [
      { at: '2026-01-01T12:12:00Z', id: 'fake-1', leader: 'fake', lane: 'fake', tier: 'fake', title: 'Fake' },
      { at: '2026-01-01T12:22:00Z', id: 'fake-2', leader: 'fake', lane: 'fake', tier: 'fake', title: 'Fake' },
      { at: '2026-01-01T12:23:00Z', id: 'fake-3', leader: 'other', lane: 'fake', tier: 'fake', title: 'Fake' },
    ], rejectedLastHour: 0,
  })));
  render(<LeaderJournalPane visible />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const passes = screen.getByRole('heading', { name: 'Passes' }).closest('section')!;
  const summaries = within(passes).getAllByText(/^2026-01-01T12:/).map((time) => time.closest('summary')!);
  expect(summaries[0]).toHaveTextContent('wrote 2 jobs');
  expect(summaries[1]).toHaveTextContent('wrote 1 jobs');
  expect(summaries[2]).toHaveTextContent('wrote 0 jobs');
  expect(summaries[2]).toHaveTextContent('Old summary');
  const zeroBadge = within(summaries[2]).getByText('wrote 0 jobs');
  expect(zeroBadge).toHaveClass(badgeStyles.warning);
  expect(zeroBadge.parentElement).toHaveAttribute('data-tone', 'warning');
  expect(screen.getByText(/last pass wrote 2 jobs/)).toHaveTextContent('· last pass wrote 2 jobs');
});
