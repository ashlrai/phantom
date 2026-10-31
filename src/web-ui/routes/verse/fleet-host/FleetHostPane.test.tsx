import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { FleetHostPane } from './FleetHostPane.js';

const fixture: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'degraded', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: '2026-10-31T11:59:00Z', paused: true, memFreePct: 22, diskFreeGb: 12, switches: ['KILL'], claudeLane: 'DOWN: offline',
  lanes: [], workers: [], leaders: [], orchestratorAgents: 2, publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
const serve = (data: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => Response.json(data, { status })));
beforeEach(() => { evictAll(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('shows host health, pause, switches and the down lane hint', async () => {
  serve(fixture); render(<FleetHostPane visible />);
  expect(await screen.findByRole('meter', { name: 'Memory free' })).toHaveAttribute('aria-valuetext', 'Memory free: 22%');
  expect(screen.getByText('Fleet is paused.')).toBeInTheDocument();
  expect(screen.getByText('KILL')).toBeInTheDocument();
  expect(screen.getByText('DOWN: offline')).toHaveAttribute('data-tone', 'bad');
  expect(screen.getByText('~/.ashlr-runs/bin/fix-claude-lane.sh')).toBeInTheDocument();
  expect(screen.getByText('12 GB')).toBeInTheDocument();
  expect(screen.getByText('Orchestrator agents: 2')).toBeInTheDocument();
  expect(screen.getByText('Runs directory: degraded')).toBeInTheDocument();
});

it('explains a missing endpoint and allows refresh', async () => {
  serve({}, 404); render(<FleetHostPane visible />);
  expect(await screen.findByText('The fleet runs API has not landed in this build yet.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('keeps the last reading when refresh fails and shows empty switches', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ ...fixture, switches: [], paused: false, claudeLane: null })).mockResolvedValueOnce(new Response(null, { status: 500 }));
  vi.stubGlobal('fetch', fetchMock); render(<FleetHostPane visible />);
  expect(await screen.findByText('No switches set')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByText('Fleet runs could not refresh. Showing the last reading.')).toBeInTheDocument();
  expect(screen.getByRole('meter', { name: 'Memory free' })).toHaveAttribute('aria-valuetext', 'Memory free: 22%');
});

it('polls every five seconds only while visible', async () => {
  vi.useFakeTimers(); serve(fixture);
  let visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility as DocumentVisibilityState);
  const view = render(<FleetHostPane visible />);
  await act(async () => {});
  await act(async () => { vi.advanceTimersByTime(5_000); }); expect(fetch).toHaveBeenCalledTimes(2);
  visibility = 'hidden'; act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await act(async () => { vi.advanceTimersByTime(15_000); }); expect(fetch).toHaveBeenCalledTimes(2);
  visibility = 'visible'; await act(async () => { document.dispatchEvent(new Event('visibilitychange')); }); expect(fetch).toHaveBeenCalledTimes(3);
  view.rerender(<FleetHostPane visible={false} />);
  await act(async () => { vi.advanceTimersByTime(15_000); }); expect(fetch).toHaveBeenCalledTimes(3);
  await act(async () => { view.rerender(<FleetHostPane visible />); }); expect(fetch).toHaveBeenCalledTimes(4);
});
