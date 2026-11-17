import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ThroughputCounts, ThroughputReport } from '../../../../core/fleet/throughput.js';
import { ThroughputPane } from './ThroughputPane.js';

const NONE: ThroughputCounts = { launched: null, published: null, merged: null, finished: null, empty: null, empty_rate: null, median_publish_to_merge_s: null, merge_time_unknown: null };
const ZERO: ThroughputCounts = { ...NONE, launched: 0, published: 0, merged: 0, finished: 0, empty: 0, merge_time_unknown: 0 };
const BUSY: ThroughputCounts = { launched: 50, published: 40, merged: 38, finished: 48, empty: 6, empty_rate: 0.125, median_publish_to_merge_s: 170, merge_time_unknown: 2 };
const hours = (last: ThroughputCounts, rest: ThroughputCounts) => Array.from({ length: 6 }, (_, i) => ({ start: new Date(Date.UTC(2026, 10, 17, 6 + i)).toISOString(), ...(i === 5 ? last : rest) }));
function report(kind: 'busy' | 'quiet' | 'unreadable'): ThroughputReport {
  const totals = kind === 'busy' ? BUSY : kind === 'quiet' ? ZERO : NONE, rest = kind === 'unreadable' ? NONE : ZERO;
  return {
    schema: 'throughput.v1', as_of: '2026-11-17T12:00:00.000Z', since: '2026-11-17T06:00:00.000Z', hours: 6, by: 'lane', metrics_path: '/fake/jobs.jsonl',
    metrics: kind === 'unreadable' ? 'unreadable' : 'ok', malformed_lines: kind === 'busy' ? 3 : kind === 'quiet' ? 0 : null, main: kind === 'busy' ? 'green' : 'unknown',
    headline: kind === 'busy' ? '38 merged in the last 6 hours, median 2m 50s' : kind === 'quiet' ? '0 merged in the last 6 hours, median unknown' : 'Merged in the last 6 hours: unknown (cannot read the job metrics file)',
    totals, buckets: hours(totals, rest),
    groups: kind !== 'busy' ? [] : [
      { name: 'claude', totals: { ...BUSY, empty: 1, finished: 40, empty_rate: 0.025 }, buckets: hours(BUSY, ZERO) },
      { name: 'grok', totals: { ...ZERO, launched: 5, finished: 5, empty: 5, empty_rate: 1 }, buckets: hours(ZERO, ZERO) },
      { name: 'idle', totals: ZERO, buckets: hours(ZERO, ZERO) },
    ],
  };
}
const state = vi.hoisted(() => ({ status: 'success', data: undefined as unknown }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => state, useRefetch: () => vi.fn() }));
const show = (data: unknown, status = 'success') => {
  state.data = data; state.status = status;
  return render(<ThroughputPane {...({ visible: true } as Parameters<typeof ThroughputPane>[0])} />);
};
beforeEach(() => { state.data = undefined; state.status = 'success'; });

it('shows the headline, totals, both hourly lines and the empty rate bar by lane', () => {
  show(report('busy'));
  expect(screen.getByText('38 merged in the last 6 hours, median 2m 50s.')).toBeTruthy();
  expect(screen.getByText(/Launched 50 · published 40 · merged 38 · empty 6 of 48 finished \(13%\)\.\s+Main is green\./)).toBeTruthy();
  expect(screen.getByText('Metrics lines skipped because they could not be read: 3.')).toBeTruthy();
  expect(screen.getByText('Merged PRs with no publish time, left out of the median: 2.')).toBeTruthy();
  expect(screen.getByRole('img', { name: 'PRs merged per hour' })).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Median minutes from publish to merge per hour' })).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Empty rate by lane' })).toBeTruthy();
  expect(screen.getByRole('img', { name: 'grok: 100%' })).toBeTruthy();
  expect(screen.getByRole('img', { name: 'claude: 3%' })).toBeTruthy();
  // No job finished on the idle lane: its rate is not drawn as 0%.
  expect(screen.getByRole('img', { name: 'idle: no data' })).toBeTruthy();
  expect(screen.getAllByRole('row', { hidden: true }).some(row => row.textContent === 'grok5005100%unknown')).toBe(true);
});

it('shows a readable but quiet window as an empty state, not as missing data', () => {
  show(report('quiet'));
  expect(screen.getByText('0 merged in the last 6 hours, median unknown.')).toBeTruthy();
  expect(screen.getByText(/No jobs or PRs were recorded in the last 6 hours\.\s+Main is unknown\./)).toBeTruthy();
  expect(screen.getByRole('img', { name: 'PRs merged per hour' })).toBeTruthy();
  expect(screen.getByText('No merged PR with a known publish time in this window.')).toBeTruthy();
  expect(screen.getByText('No lane activity in this window.')).toBeTruthy();
  expect(screen.queryByRole('img', { name: 'Empty rate by lane' })).toBeNull();
});

it('keeps an unreadable metrics file unknown and draws nothing', () => {
  show(report('unreadable'));
  expect(screen.getByText('Merged in the last 6 hours: unknown (cannot read the job metrics file).')).toBeTruthy();
  expect(screen.getByText(/Launched unknown · published unknown · merged unknown · empty unknown of unknown finished \(unknown\)\./)).toBeTruthy();
  expect(screen.getAllByText('Unknown: the job metrics file could not be read.')).toHaveLength(3);
  expect(screen.queryByRole('img')).toBeNull();
});

it('says so while reading, and when the answer is not a throughput report', () => {
  show(undefined, 'loading').unmount();
  expect(screen.queryByText('Reading throughput…')).toBeNull();
  show(undefined, 'loading');
  expect(screen.getByText('Reading throughput…')).toBeTruthy();
  show({ v: 1 });
  expect(screen.getByText('Throughput: unknown (the report could not be read).')).toBeTruthy();
});
