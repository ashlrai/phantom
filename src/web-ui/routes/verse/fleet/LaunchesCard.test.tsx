import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { LaunchRateReport } from '../../../../core/fleet/launch-rate.js';
import { gapWords, LaunchesCard, launchesQuery } from './LaunchesCard.js';

const state = vi.hoisted(() => ({ status: 'success', data: undefined as unknown }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => state, useRefetch: () => vi.fn() }));
const get = vi.hoisted(() => vi.fn());
vi.mock('../../../data/client.js', () => ({ apiGet: get }));
const show = (data: unknown, status = 'success') => { state.data = data; state.status = status; return render(<LaunchesCard />); };
beforeEach(() => { state.data = undefined; state.status = 'success'; });

const REPORT: LaunchRateReport = {
  schema: 'fleet.launches.v1', as_of: '2026-11-18T20:00:00.000Z', hours: 24, metrics: 'ok', plans: 'ok',
  waste_rule: { merged_per_start_under: 0.1, min_starts_24h: 10 },
  starts: 60, starts_per_hour: 2.5, wasted_starts: 21, longest_gap: { from: '2026-11-18T10:00:00.000Z', to: '2026-11-18T12:10:00.000Z', minutes: 130 },
  lanes: [], relaunches: {}, repeat_jobs: [], headline: '60 starts in the last 24 h (2.5 an hour), 21 wasted, longest gap 2 h 10 m',
  recommendations: ['zai took 21 of 60 starts in 24 h and merged 0; send its rows to claude (9% used, 48 h left).', 'second'],
};

it('shows the three headline numbers and only the top recommendation', () => {
  show(REPORT);
  expect(screen.getByText('Starts per hour').nextSibling?.textContent).toBe('2.5');
  expect(screen.getByText('Wasted starts').nextSibling?.textContent).toBe('21 of 60');
  expect(screen.getByText('Longest gap').nextSibling?.textContent).toBe('2 h 10 m');
  expect(screen.getByText(REPORT.recommendations[0]!)).toBeTruthy();
  expect(screen.queryByText('second')).toBeNull();
});

it('reads the typed route the CLI mirrors', async () => {
  await launchesQuery.fetch(new AbortController().signal);
  expect(get.mock.lastCall![0]).toBe('/api/verse/fleet/runs/launches?hours=24');
});

it('shows unknown, never zero, when metrics are unreadable or the reply is not a report', () => {
  show({ ...REPORT, metrics: 'unreadable', starts: null, starts_per_hour: null, wasted_starts: null, longest_gap: null, recommendations: ['Job metrics could not be read, so starts and merges are unknown.'] });
  expect(screen.getAllByText('unknown')).toHaveLength(3);
  screen.getByText('Job metrics could not be read, so starts and merges are unknown.');
  show({ error: 'not found' }, 'error');
  expect(screen.getByText('Job starts: unknown (the report could not be read).')).toBeTruthy();
});

it('keeps the last reading on a failed refresh and says so', () => {
  show(REPORT, 'error');
  expect(screen.getByText('Could not refresh. Showing the last reading.')).toBeTruthy();
  expect(gapWords(45)).toBe('45 m');
  expect(gapWords(120)).toBe('2 h');
});

it('lists the top three repeat jobs with one next step', () => {
  const job = (n: number) => ({ job: `RQ-R${n}`, launches: 4, lanes: ['zai'], minutes_spent: 98, prs: 0, merged: 0, summary: 'launched 4 times on zai, 98 minutes, no PR came out', suggest: 'move to another lane or retire' });
  show({ ...REPORT, repeat_jobs: [job(1), job(2), job(3), job(4)] });
  const list = screen.getByTestId('relaunches-list');
  expect(list.querySelectorAll('li')).toHaveLength(3);
  expect(list.textContent).toContain('launched 4 times on zai, 98 minutes, no PR came out; suggest: move to another lane or retire');
  expect(list.textContent).toContain('Next: RQ-R1, move to another lane or retire.');
  show({ ...REPORT, repeat_jobs: undefined });
  expect(screen.getAllByTestId('launches-card').length).toBeGreaterThan(0);
});
