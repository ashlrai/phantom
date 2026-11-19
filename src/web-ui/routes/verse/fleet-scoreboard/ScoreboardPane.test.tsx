import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { buildScoreboard } from '../../../../core/fleet/scoreboard.js';
import { ScoreboardPane } from './ScoreboardPane.js';

const NOW = Date.parse('2026-11-18T12:30:00Z');
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const rows = [
  { event: 'launch', job: 'a1', repo: 'phantom', ts: at(5) },
  { event: 'outcome', state: 'MERGED', job: 'a1', url: 'https://github.com/ashlrai/phantom/pull/1', ts: at(4), ttm_s: 600 },
  { event: 'launch', job: 'b1', repo: 'locus', ts: at(3) },
  { event: 'finish', job: 'b1', empty: true, ts: at(2) },
].map(row => JSON.stringify(row)).join('\n');
const state = vi.hoisted(() => ({ data: undefined as unknown, status: 'success' }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => ({ status: state.status, data: state.data }), useRefetch: () => vi.fn() }));
vi.mock('../resources/SpendDown.js', () => ({ SpendDown: () => <section aria-label="Spend down"><h2>Spend down</h2></section> }));
const props = { visible: true } as Parameters<typeof ScoreboardPane>[0];
beforeEach(() => { state.status = 'success'; state.data = buildScoreboard({ ledger: rows, now: NOW, days: 7 }); });

it('shows five charts, each with a value, a trend and a caption, beside the spend-down card', () => {
  render(<ScoreboardPane {...props} />);
  const cards = within(screen.getByRole('list', { name: 'Scoreboard charts' })).getAllByRole('listitem');
  expect(cards.map(card => card.getAttribute('aria-label'))).toEqual(['Merged per hour', 'Time to merge', 'Merged per start', 'Empty share', 'Self-improvement']);
  // The first paragraph of a card is its current value and trend; the chart axis repeats some numbers.
  const card = (name: string) => ({ value: screen.getByRole('listitem', { name }).querySelector('p')!.textContent, ...within(screen.getByRole('listitem', { name })) });
  expect(card('Merged per hour').value).toContain('0.04 an hour');
  expect(card('Time to merge').value).toContain('10 min');
  expect(card('Merged per start').value).toContain('0.5');
  expect(card('Empty share').value).toContain('100%');
  expect(card('Self-improvement').value).toContain('100%');
  // Nothing happened in the window before, so every arrow says unknown rather than guessing.
  expect(card('Merged per hour').value).toContain('? unknown');
  expect(card('Empty share').getByText('Finished jobs that produced nothing.')).toBeTruthy();
  expect(screen.getAllByRole('img').length).toBe(5);
  expect(screen.getByRole('heading', { name: 'Spend down' })).toBeTruthy();
});

it('switches to the daily window with one press', () => {
  render(<ScoreboardPane {...props} />);
  expect(screen.getAllByRole('img')[0]!.getAttribute('aria-label')).toBe('Merged per hour, per hour');
  fireEvent.click(screen.getByRole('radio', { name: '7 days' }));
  expect(screen.getAllByRole('img')[0]!.getAttribute('aria-label')).toBe('Merged per hour, per day');
});

it('says unknown, not zero, when there is no data or the file cannot be read', () => {
  state.data = buildScoreboard({ ledger: '', now: NOW, days: 7 });
  const { unmount } = render(<ScoreboardPane {...props} />);
  expect(screen.getByRole('listitem', { name: 'Merged per hour' }).querySelector('p')!.textContent).toBe('unknown? unknown');
  expect(screen.getByRole('listitem', { name: 'Empty share' }).querySelector('p')!.textContent).toBe('unknown? unknown');
  unmount();
  state.data = buildScoreboard({ ledger: null, now: NOW, days: 7 });
  render(<ScoreboardPane {...props} />);
  expect(screen.getByText(/the job metrics file could not be read/)).toBeTruthy();
  expect(screen.queryByRole('list', { name: 'Scoreboard charts' })).toBeNull();
});

it('says unknown when the read fails', () => {
  state.data = undefined; state.status = 'error';
  render(<ScoreboardPane {...props} />);
  expect(screen.getByText('Scoreboard is unknown.')).toBeTruthy();
});
