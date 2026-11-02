import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { LeaderJournalPane } from './LeaderJournalPane.js';
import { filterNotes, isLeaderJournal } from './leader-journal-model.js';

const data = () => ({
  v: 1, generatedAt: '2026-10-31T13:00:00Z',
  sources: { orchestration: 'healthy', planLog: 'healthy', ingestLog: 'healthy', ingested: 'healthy' },
  notes: [
    { at: '08:50 ET Oct 31', bullets: ['Fake supply forecast.', 'Fake run-out estimate.'] },
    { at: '01:00 ET Oct 31', bullets: ['Fake blocker.', 'Stop writing fake duplicates.'] },
  ],
  passes: [{ at: '2026-10-31T12:00:00Z', sections: [{ title: 'Plan', bullets: ['Fake supply task.'] }] }],
  ingest: [], ingested: [], rejectedLastHour: null,
});
beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); });

it('renders notes before passes, expands the newest and searches both sections', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data())));
  render(<LeaderJournalPane visible />);
  const region = await screen.findByRole('region', { name: 'Leader notes' });
  expect(screen.getAllByRole('region')[0]).toBe(region);
  const details = region.querySelectorAll('details');
  expect(details).toHaveLength(2);
  expect(details[0]).toHaveAttribute('open');
  expect(details[1]).not.toHaveAttribute('open');
  expect(within(details[0]!).getAllByRole('listitem')).toHaveLength(2);
  expect(details[1]!.querySelector('summary')).toHaveTextContent('Fake blocker.');
  const search = screen.getByRole('searchbox', { name: 'Search journal' });
  fireEvent.change(search, { target: { value: '  SUPPLY  ' } });
  expect(region.querySelectorAll('details')).toHaveLength(1);
  expect(within(screen.getByRole('region', { name: 'Passes' })).getByText('Fake supply task.', { selector: 'li' })).toBeInTheDocument();
  fireEvent.change(search, { target: { value: 'duplicates' } });
  expect(region.querySelector('details')).toHaveAttribute('open');
  expect(within(region).getByText('Stop writing fake duplicates.', { selector: 'li' })).toBeInTheDocument();
  fireEvent.change(search, { target: { value: 'absent' } });
  expect(within(region).getByText('No notes match')).toBeInTheDocument();
  fireEvent.change(search, { target: { value: '' } });
  expect(region.querySelectorAll('details')).toHaveLength(2);
});

it.each(['missing', 'degraded'])('shows the source fallback for %s orchestration', async (orchestration) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...data(), notes: [], sources: { ...data().sources, orchestration } })));
  render(<LeaderJournalPane visible />);
  expect(await screen.findByText('Leader notes source missing.')).toBeInTheDocument();
});

it('validates notes while tolerating extra wire keys and shares case-insensitive matching', () => {
  expect(isLeaderJournal({ ...data(), extra: true, sources: { ...data().sources, extra: 'healthy' } })).toBe(true);
  expect(isLeaderJournal({ ...data(), notes: [{ at: 'fake', bullets: [1] }] })).toBe(false);
  expect(isLeaderJournal({ ...data(), sources: { ...data().sources, orchestration: 'unknown' } })).toBe(false);
  expect(filterNotes(data().notes, ' BLOCKER ')).toEqual([data().notes[1]]);
});
