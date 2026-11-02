import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import * as client from '../../../data/client.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { WorkerLogPane } from './WorkerLogPane.js';

const fixture: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z',
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'missing', codex: 'missing', merges: 'missing' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null, lanes: [],
  workers: [{ job: 'RQ-NEW', repo: 'phantom', lane: 'codex', tier: 'mid', ageSeconds: 60 }, { job: 'RQ-OLD', repo: 'phantom', lane: 'codex-personal', tier: 'mid', ageSeconds: 720 }],
  leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
const detail = { schema: 'fleet.job.v1', job: 'RQ-OLD', state: 'running', lane: 'codex-personal', tier: 'mid', model: 'model', publish: { prUrl: 'https://github.com/example/repo/pull/1234' }, log: { source: 'live', tail: ['first line', 'second line'], truncated: true } };
let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { evictAll(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); evictAll(); });
function serve(runs: FleetRuns = fixture, job: unknown = detail) {
  spy = vi.spyOn(client, 'apiGet').mockImplementation(async (path: string) => path === '/api/verse/fleet/runs' ? runs : job);
}
it('lists workers, selects the oldest, and renders the ordered tail and PR', async () => {
  serve(); render(<WorkerLogPane visible />);
  const select = await screen.findByRole('combobox', { name: 'Worker' });
  expect(await within(select).findByRole('option', { name: 'RQ-OLD · codex-personal · 12 min' })).toBeInTheDocument();
  expect(select).toHaveValue('RQ-OLD');
  expect(within(select).getByRole('option', { name: 'RQ-NEW · codex · 1 min' })).toBeInTheDocument();
  expect(await screen.findByRole('log')).toHaveTextContent('… earlier lines not shown first line second line');
  expect(screen.getByRole('log').textContent).toBe('… earlier lines not shown\nfirst line\nsecond line');
  expect(screen.getByRole('link', { name: 'PR #1234' })).toHaveAttribute('rel', 'noreferrer');
  expect(spy).toHaveBeenCalledWith('/api/fleet/job?id=RQ-OLD', undefined);
});
it('does not fetch an invalid typed ID and toggles Follow', async () => {
  serve(); render(<WorkerLogPane visible />);
  await screen.findByRole('log');
  const follow = screen.getByRole('checkbox', { name: 'Follow' });
  expect(follow).toBeChecked(); fireEvent.click(follow); expect(follow).not.toBeChecked();
  const count = spy.mock.calls.length;
  fireEvent.change(screen.getByRole('textbox', { name: 'Job ID' }), { target: { value: '../bad' } });
  expect(screen.getByText(/Use 3–80/)).toBeInTheDocument();
  await act(async () => {});
  expect(spy).toHaveBeenCalledTimes(count);
});
it('keeps a selected worker after it finishes and the list refreshes', async () => {
  serve(); render(<WorkerLogPane visible />);
  await screen.findByRole('log');
  spy.mockImplementation(async (path: string) => path === '/api/verse/fleet/runs' ? { ...fixture, workers: [] } : { ...detail, state: 'published', log: { source: 'archived', tail: ['done'], truncated: false } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByText('No workers running right now.')).toBeInTheDocument();
  expect(await screen.findByText('published')).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Worker' })).toHaveValue('RQ-OLD');
  expect(screen.getByRole('log')).toHaveTextContent('done');
});
it('reports a missing API and a missing log', async () => {
  serve(fixture, null);
  spy.mockImplementation(async (path: string) => { if (path === '/api/verse/fleet/runs') return fixture; throw new client.ApiError('missing', 404, path); });
  const view = render(<WorkerLogPane visible />);
  expect(await screen.findByText('The job detail API has not landed in this build yet.')).toBeInTheDocument();
  view.unmount(); evictAll();
  spy.mockImplementation(async (path: string) => path === '/api/verse/fleet/runs' ? fixture : { schema: 'fleet.job.v1', log: { source: 'missing' } });
  render(<WorkerLogPane visible />);
  expect(await screen.findByText('No log yet.')).toBeInTheDocument();
});
it('follows new output only when Follow is enabled', async () => {
  serve(); render(<WorkerLogPane visible />);
  const log = await screen.findByRole('log');
  Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 100 });
  log.scrollTop = 10;
  fireEvent.click(screen.getByRole('checkbox', { name: 'Follow' }));
  spy.mockImplementation(async (path: string) => path === '/api/verse/fleet/runs' ? fixture : { ...detail, log: { ...detail.log, tail: ['new output'] } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByText(/new output/)).toBeInTheDocument();
  expect(log.scrollTop).toBe(10);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Follow' }));
  expect(log.scrollTop).toBe(100);
});
it('polls the detail at its state interval only while visible', async () => {
  vi.useFakeTimers(); serve();
  const view = render(<WorkerLogPane visible />);
  await act(async () => {});
  const detailCalls = () => spy.mock.calls.filter(call => String(call[0]).startsWith('/api/fleet/job?')).length;
  expect(detailCalls()).toBe(1);
  await act(async () => { vi.advanceTimersByTime(4000); });
  expect(detailCalls()).toBe(2);
  view.rerender(<WorkerLogPane visible={false} />);
  await act(async () => { vi.advanceTimersByTime(20000); });
  expect(detailCalls()).toBe(2);
  view.rerender(<WorkerLogPane visible />);
  await act(async () => {});
  const afterShow = detailCalls();
  const original = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => { vi.advanceTimersByTime(20000); });
  expect(detailCalls()).toBe(afterShow);
  if (original) Object.defineProperty(document, 'visibilityState', original);
  else delete (document as { visibilityState?: string }).visibilityState;
  act(() => document.dispatchEvent(new Event('visibilitychange')));
});
