import { render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { buildFleetWorklog } from '../../../../core/fleet/worklog-numbers.js';
import { WorkLogPane } from './WorkLogPane.js';

const NOW = Date.parse('2026-11-18T15:20:00Z');
const pull = (n: number) => `https://github.com/ashlrai/phantom/pull/${n}`;
const ROWS = [
  { event: 'launch', job: 'old', lane: 'fast', repo: 'phantom', ts: '2026-11-17T10:00:00Z' },
  { event: 'outcome', state: 'MERGED', job: 'old', url: pull(3), ttm_s: 120, ts: '2026-11-17T11:00:00Z' },
  { event: 'launch', job: 'alpha', lane: 'work', repo: 'phantom', ts: '2026-11-18T14:00:00Z' },
  { event: 'finish', job: 'alpha', empty: true, ts: '2026-11-18T14:10:00Z' },
  { event: 'launch', job: 'alpha', lane: 'work', repo: 'phantom', ts: '2026-11-18T14:20:00Z' },
  { event: 'publish', job: 'alpha', url: pull(7), ts: '2026-11-18T14:30:00Z' },
  { event: 'outcome', state: 'MERGED', job: 'alpha', url: pull(7), ts: '2026-11-18T14:40:00Z' },
];
// The pane shows exactly what the API sends, so the fixtures are the real report over a small ledger.
const report = (rows: object[] | null) => buildFleetWorklog({ ledger: rows && rows.map(row => JSON.stringify(row)).join('\n'), now: NOW, utcOffsetMinutes: 0 });
const state = vi.hoisted(() => ({ status: 'success', data: undefined as unknown, fetch: null as null | ((signal: AbortSignal) => unknown) }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: (def: { fetch: (signal: AbortSignal) => unknown }) => { state.fetch = def.fetch; return state; }, useRefetch: () => vi.fn() }));
const get = vi.hoisted(() => vi.fn());
vi.mock('../../../data/client.js', () => ({ apiGet: get }));
const show = (data: unknown, status = 'success') => {
  state.data = data; state.status = status;
  return render(<WorkLogPane {...({ visible: true } as Parameters<typeof WorkLogPane>[0])} />);
};
beforeEach(() => { state.data = undefined; state.status = 'success'; });
it('says each number today against yesterday with one trend line each, then a table by lane and by repo', () => {
  show(report(ROWS));
  expect(screen.getByText('1 merged today, 1 yesterday.')).toBeTruthy();
  expect(screen.getByText('Median time from PR opened to merged: 10m 0s today, 2m 0s yesterday.')).toBeTruthy();
  expect(screen.getByText('Merged PRs per 100 launches: 50 today, 100 yesterday.')).toBeTruthy();
  expect(screen.getByText('Launches that ended with no change: 1 today, 0 yesterday.')).toBeTruthy();
  expect(screen.getAllByRole('img')).toHaveLength(5);
  expect(screen.getByRole('img', { name: /^PRs merged, each hour of the last 24: from 0 to 0, range 0 to 1/ })).toBeTruthy();
  // Hours with no timed merge are gaps in the line, not zero minutes.
  expect(screen.getByRole('img', { name: /^Median minutes from PR opened to merged, each hour of the last 24: from 10 to 10, range 10 to 10, 23 points without data/ })).toBeTruthy();
  const lanes = within(screen.getByRole('table', { name: 'By lane' })).getAllByRole('row').map(row => row.textContent);
  expect(lanes).toEqual(['LaneMerged todayMerged yesterdayLaunches todayNo change todayMedian minutes to merge today', 'work102110', 'fast0100unknown']);
  expect(within(screen.getByRole('table', { name: 'By repo' })).getAllByRole('row')[1]!.textContent).toBe('phantom112110');
  expect(screen.getByText('phm fleet worklog --json')).toBeTruthy();
  state.fetch!(new AbortController().signal);
  expect(get).toHaveBeenCalledWith('/api/fleet/worklog?hours=24', expect.anything());
});
it('shows a day that was never recorded as unknown, not zero', () => {
  show(report(ROWS.slice(2)));
  expect(screen.getByText('1 merged today, unknown yesterday.')).toBeTruthy();
  expect(within(screen.getByRole('table', { name: 'By lane' })).getAllByRole('row')[1]!.textContent).toBe('work1unknown2110');
});
it('shows a quiet fleet as zeros and an unreadable file or report as unknown', () => {
  const quiet = show(report([{ event: 'launch', job: 'past', lane: 'work', ts: '2026-11-10T10:00:00Z' }]));
  expect(screen.getByText('0 merged today, 0 yesterday.')).toBeTruthy();
  expect(screen.getByText('No work recorded by lane today or yesterday.')).toBeTruthy();
  quiet.unmount();
  const unreadable = show(report(null));
  expect(screen.getByRole('status').textContent).toBe('Work log: unknown (the job metrics file could not be read).');
  expect(screen.queryByRole('img')).toBeNull();
  unreadable.unmount();
  const failed = show({ error: 'nope' });
  expect(screen.getByRole('status').textContent).toBe('Work log: unknown (the report could not be read).');
  failed.unmount();
  const loading = show(undefined, 'loading');
  expect(screen.getByRole('status').textContent).toBe('Reading the work log…');
  loading.unmount();
  // A failed refresh keeps the last reading and says so.
  show(report(ROWS), 'error');
  expect(screen.getByRole('status').textContent).toBe('Could not refresh. Showing the last reading.');
  expect(screen.getByText('1 merged today, 1 yesterday.')).toBeTruthy();
});
