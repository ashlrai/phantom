import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { FleetLanesPane } from './FleetLanesPane.js';

const fixture: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'degraded', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [{ lane: 'codex', running: 1, target: 2, queued: 3, held: true, heldReason: 'Budget hold', tokensLastHour: null, merged24h: null, mergeRate24h: null }],
  workers: Array.from({ length: 13 }, (_, i) => ({ job: `job-${i}`, repo: 'example/repo', lane: 'codex', tier: 'frontier', ageSeconds: i })),
  leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 2, items: [{ repo: 'example/repo', number: 12, title: 'Fleet view' }, { repo: 'unknown', number: 13, title: 'No owner' }] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
const serve = (data: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => Response.json(data, { status })));
beforeEach(() => { evictAll(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('renders lanes, held reason, oldest workers and safe merge links', async () => {
  serve(fixture); render(<FleetLanesPane visible />);
  expect(await screen.findByText('1/2 · 3 queued')).toBeInTheDocument();
  expect(screen.getByText('Held')).toHaveAttribute('title', 'Budget hold');
  expect(screen.getByText('Runs directory: degraded')).toBeInTheDocument();
  const workers = screen.getByRole('heading', { name: 'Workers' }).parentElement!;
  expect(within(workers).getByText('job-12')).toBeInTheDocument();
  expect(within(workers).queryByText('job-0')).toBeNull();
  expect(within(workers).getByText('+1 more')).toBeInTheDocument();
  const link = screen.getByRole('link', { name: 'example/repo #12 Fleet view' });
  expect(link).toHaveAttribute('href', 'https://github.com/example/repo/pull/12');
  expect(link).toHaveAttribute('target', '_blank'); expect(link).toHaveAttribute('rel', 'noreferrer');
  expect(screen.getByText('unknown #13 No owner').tagName).not.toBe('A');
});

it('explains a missing endpoint and allows refresh', async () => {
  serve({}, 404); render(<FleetLanesPane visible />);
  expect(await screen.findByText('The fleet runs API has not landed in this build yet.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('polls every five seconds only while the pane and document are visible', async () => {
  vi.useFakeTimers(); serve(fixture);
  let visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility as DocumentVisibilityState);
  const view = render(<FleetLanesPane visible />);
  await act(async () => {});
  await act(async () => { vi.advanceTimersByTime(5_000); }); expect(fetch).toHaveBeenCalledTimes(2);
  visibility = 'hidden'; act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await act(async () => { vi.advanceTimersByTime(15_000); }); expect(fetch).toHaveBeenCalledTimes(2);
  visibility = 'visible'; await act(async () => { document.dispatchEvent(new Event('visibilitychange')); }); expect(fetch).toHaveBeenCalledTimes(3);
  view.rerender(<FleetLanesPane visible={false} />);
  await act(async () => { vi.advanceTimersByTime(15_000); }); expect(fetch).toHaveBeenCalledTimes(3);
  await act(async () => { view.rerender(<FleetLanesPane visible />); }); expect(fetch).toHaveBeenCalledTimes(4);
});
