import { render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { buildTrend } from '../../../../core/fleet/scoreboard-trend.js';
import { ScoreboardTrends } from './ScoreboardTrends.js';

const NOW = Date.parse('2026-11-18T12:30:00Z');
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const trend = buildTrend({ window: '24h', now: NOW,
  jobs: [{ job: 'a1', lane: 'work', tier: 'work', started: at(10.5), finished: at(10), empty: false, merged: true, published_at: at(10), merged_at: at(9.5) },
    { job: 'b1', lane: 'work', tier: 'work', started: at(2.5), finished: at(2), empty: true, merged: false, published_at: null, merged_at: null }],
  usage: [{ pool: 'claude', used_pct: 60, observed_at: at(8) }, { pool: 'claude', used_pct: 4, observed_at: at(3) }, { pool: 'claude', used_pct: 6, observed_at: at(1) }] });
const state = vi.hoisted(() => ({ data: undefined as unknown, status: 'success' }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => ({ status: state.status, data: state.data }), useRefetch: () => vi.fn() }));

it('draws one chart per number and plan, gaps as gaps, with a sentence and a screen-reader summary each', () => {
  state.data = { trend };
  render(<ScoreboardTrends window="24h" visible />);
  const cards = within(screen.getByRole('list', { name: 'Trend charts' })).getAllByRole('listitem');
  expect(cards.map(c => c.getAttribute('aria-label'))).toEqual(['PRs merged', 'Jobs started', 'Starts that merged', 'Starts that ended empty', 'Minutes from publish to merge', 'claude used']);
  expect(screen.getAllByRole('img')).toHaveLength(6);
  const started = screen.getByRole('listitem', { name: 'Jobs started' });
  // Hours with no job events are gaps: the chart's spoken summary counts them as without data, not zero.
  expect(within(started).getByRole('img').getAttribute('aria-label')).toContain('periods have data, 20 without');
  expect(within(started).getByRole('img').getAttribute('aria-label')).toContain('Jobs started: latest');
  expect(screen.getByText(trend.sentence, { exact: false })).toBeTruthy();
  expect(within(screen.getByRole('listitem', { name: 'claude used' })).getByText(/↺ Reset at/)).toBeTruthy();
  expect(within(screen.getByRole('listitem', { name: 'claude used' })).getByText(/up 2 points from yesterday/)).toBeTruthy();
});

it('says unknown when there is no trend or the read failed', () => {
  state.data = undefined; state.status = 'error';
  render(<ScoreboardTrends window="7d" visible />);
  expect(screen.getByText('Trends are unknown.')).toBeTruthy();
});
