import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { FleetRunsV1 } from '../../../../core/verse/fleet-runs-types.js';
import { toneColor } from '../../../components/charts/colors.js';
import { evictAll } from '../../../data/cache.js';
import { FleetTimelinePane } from './FleetTimelinePane.js';

const fixture: FleetRunsV1 = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [
    { lane: 'codex', running: 2, target: 3, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null },
    { lane: 'devin', running: 0, target: 1, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null },
  ],
  workers: [
    { job: 'stuck-job', repo: 'example/repo', lane: 'codex', tier: 'work', ageSeconds: 3000 },
    { job: 'unknown-job', repo: 'example/repo', lane: 'codex', tier: 'work', ageSeconds: null },
  ],
  leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
const serve = (data: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => Response.json(data, { status })));
beforeEach(() => { evictAll(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('shows the summary, a danger-colored stuck worker and an empty lane', async () => {
  serve(fixture);
  const { container } = render(<FleetTimelinePane visible />);
  expect(await screen.findByText('2 workers · longest stuck-job 50:00 · 1 unknown age')).toBeInTheDocument();
  const bar = container.querySelector('rect[data-status="stuck"]');
  expect(bar).toHaveAttribute('fill', toneColor('danger'));
  expect(screen.getByLabelText('devin 0/1: 0 runs')).toBeInTheDocument();
  fireEvent.pointerEnter(bar!);
  expect(screen.getByText('stuck-job · work · 50:00')).toBeInTheDocument();
});

it('explains a missing endpoint', async () => {
  serve({}, 404); render(<FleetTimelinePane visible />);
  expect(await screen.findByText('The fleet runs API has not landed in this build yet.')).toBeInTheDocument();
});

it('keeps the last reading when refresh fails', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(fixture)).mockResolvedValueOnce(new Response(null, { status: 500 }));
  vi.stubGlobal('fetch', fetchMock); render(<FleetTimelinePane visible />);
  expect(await screen.findByText('2 workers · longest stuck-job 50:00 · 1 unknown age')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Fleet runs could not refresh. Showing the last reading.');
  expect(screen.getByText('2 workers · longest stuck-job 50:00 · 1 unknown age')).toBeInTheDocument();
});

it('shows empty fleet lanes when there are no workers', async () => {
  serve({ ...fixture, workers: [] }); render(<FleetTimelinePane visible />);
  expect(await screen.findByText('0 workers · longest — · 0 unknown age')).toBeInTheDocument();
  expect(screen.getByLabelText('devin 0/1: 0 runs')).toBeInTheDocument();
});

it('polls every ten seconds only while visible', async () => {
  vi.useFakeTimers(); serve(fixture);
  let visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility as DocumentVisibilityState);
  const view = render(<FleetTimelinePane visible />);
  await act(async () => {});
  await act(async () => { vi.advanceTimersByTime(10_000); }); expect(fetch).toHaveBeenCalledTimes(2);
  visibility = 'hidden'; act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await act(async () => { vi.advanceTimersByTime(20_000); }); expect(fetch).toHaveBeenCalledTimes(2);
  view.rerender(<FleetTimelinePane visible={false} />);
  visibility = 'visible'; act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await act(async () => { vi.advanceTimersByTime(10_000); }); expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => { view.rerender(<FleetTimelinePane visible />); });
  expect(fetch).toHaveBeenCalledTimes(3);
});
