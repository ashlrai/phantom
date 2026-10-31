import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { OpsQueue } from './OpsQueue.js';
import type { FleetQueueV1 } from './ops-queue-model.js';

const fixture: FleetQueueV1 = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { ready: 'healthy', skips: 'healthy' },
  total: 7, ready: 2, parked: 5, malformed: 1,
  byLane: [{ lane: 'codex', ready: 2, parked: 2 }, { lane: 'claude', ready: 0, parked: 3 }],
  groups: [
    { reason: 'MERGERATE', lane: 'codex', count: 2, jobs: ['job-one', 'job-two'] },
    { reason: 'INVALID', lane: null, count: 1, jobs: ['job-three'] },
    { reason: 'UNKNOWN', lane: 'claude', count: 2, jobs: ['job-four'] },
  ],
  skips: [{ at: '2026-10-31T11:59:00Z', job: 'job-dropped', code: '13', reason: 'ignored' }], skipsLast24h: 4,
};
const serve = (data: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => Response.json(data, { status })));
beforeEach(() => { evictAll(); localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('shows the queue totals, parked explanations, lanes and precheck drops', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
  serve(fixture); render(<OpsQueue />);
  await act(async () => {});
  for (const name of ['Ready: 2', 'Parked: 5', 'Dropped by precheck 24h: 4', 'Malformed lines: 1']) expect(screen.getByRole('group', { name })).toBeInTheDocument();
  const parked = screen.getByRole('table', { name: 'Parked, by reason' });
  expect(within(parked).getAllByRole('row')).toHaveLength(4);
  expect(within(parked).getByText('Merge rate gate')).toBeInTheDocument();
  expect(within(parked).getByText(/This lane's recent merge rate/)).toBeInTheDocument();
  expect(within(parked).getByText('Invalid job line')).toBeInTheDocument();
  expect(within(parked).getByText('Parked by dispatchd; reason code UNKNOWN.')).toBeInTheDocument();
  expect(within(parked).getByText('job-one, job-two')).toBeInTheDocument();
  expect(within(screen.getByRole('table', { name: 'By lane' })).getAllByRole('row')[1]).toHaveTextContent('claude');
  expect(screen.getByText('job-dropped').tagName).toBe('CODE');
  expect(screen.getByText(/Already done: every named file/)).toHaveTextContent('1 minute ago');
  expect(fetch).toHaveBeenCalledWith('/api/verse/fleet/live/queue?limit=25', expect.anything());
});
it('explains an empty healthy queue', async () => {
  serve({ ...fixture, groups: [], byLane: [], skips: [], parked: 0 }); render(<OpsQueue />);
  expect(await screen.findByText('Nothing parked. Every queued job is READY.')).toBeInTheDocument();
});
it('does not claim incomplete sources are empty', async () => {
  serve({ ...fixture, groups: [], sources: { ready: 'missing', skips: 'degraded' } }); render(<OpsQueue />);
  expect(await screen.findByText('Queue data is missing; counts and parked groups may be incomplete.')).toBeInTheDocument();
  expect(screen.getByText('Precheck history is degraded; dropped jobs may be incomplete.')).toBeInTheDocument();
  expect(screen.queryByText('Nothing parked. Every queued job is READY.')).toBeNull();
});
it('shows a recoverable error for an invalid response', async () => {
  serve({ v: 1 }); render(<OpsQueue />);
  expect(await screen.findByText('Queue is unavailable.')).toBeInTheDocument();
});
it('shows not-landed copy on 404 and retries after reopening', async () => {
  vi.useFakeTimers(); serve({}, 404);
  const view = render(<SectionVisibilityProvider visible><OpsQueue /></SectionVisibilityProvider>);
  await act(async () => {});
  expect(screen.getByText('The queue API has not landed in this build yet.')).toBeInTheDocument();
  await act(async () => { vi.advanceTimersByTime(30_000); }); expect(fetch).toHaveBeenCalledTimes(1);
  view.rerender(<SectionVisibilityProvider visible={false}><OpsQueue /></SectionVisibilityProvider>);
  view.rerender(<SectionVisibilityProvider visible><OpsQueue /></SectionVisibilityProvider>);
  await act(async () => {}); expect(fetch).toHaveBeenCalledTimes(2);
});
it('polls every 15 seconds only while visible', async () => {
  vi.useFakeTimers(); serve(fixture);
  const view = render(<SectionVisibilityProvider visible><OpsQueue /></SectionVisibilityProvider>);
  await act(async () => {});
  await act(async () => { vi.advanceTimersByTime(14_999); }); expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => { vi.advanceTimersByTime(1); }); expect(fetch).toHaveBeenCalledTimes(2);
  view.rerender(<SectionVisibilityProvider visible={false}><OpsQueue /></SectionVisibilityProvider>);
  await act(async () => { vi.advanceTimersByTime(30_000); }); expect(fetch).toHaveBeenCalledTimes(2);
  view.rerender(<SectionVisibilityProvider visible><OpsQueue /></SectionVisibilityProvider>);
  await act(async () => {}); expect(fetch).toHaveBeenCalledTimes(3);
});
