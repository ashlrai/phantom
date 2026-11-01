import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { getDockState, resetDockStore } from '../dock/dock-store.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { FleetHubPane } from './FleetHubPane.js';

const runs = { v: 1, generatedAt: new Date().toISOString(), sources: { runsDir: 'missing', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [], workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 0, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null };
const backlog = { v: 1, source: 'ok', generatedAt: new Date().toISOString(), items: [{}, {}],
  counts: { mergeState: { DIRTY: 1, CLEAN: 1 }, actions: { recut: 1, merge: 1, refresh: 0, wait: 0, none: 0 } } };
const response = (data: unknown, status = 200) => Promise.resolve(Response.json(data, { status }));

beforeEach(() => {
  evictAll(); resetDockStore();
  vi.stubGlobal('fetch', vi.fn((path: string) => {
    if (String(path).includes('/github/fleet-backlog')) return response(backlog);
    if (String(path).endsWith('/fleet/runs')) return response(runs);
    return response({}, 404);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('shows the backlog and opens Merges', async () => {
  render(<FleetHubPane visible />);
  const tile = (await screen.findByText('Merge backlog')).closest('button')!;
  expect(tile).toHaveTextContent('2 open · CLEAN 1 · DIRTY 1');
  expect(tile).toHaveTextContent('recut 1 · merge 1');
  fireEvent.click(tile);
  expect(getDockState().active).toBe('fleet-merges');
});
it('hides the tile when the route returns 404', async () => {
  vi.mocked(fetch).mockImplementation((path) => String(path).endsWith('/fleet/runs') ? response(runs) : response({}, 404));
  render(<FleetHubPane visible />);
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).includes('/github/fleet-backlog'))).toBe(true));
  expect(screen.queryByText('Merge backlog')).not.toBeInTheDocument();
});
it('shows the structured GitHub failure returned with HTTP 503', async () => {
  vi.mocked(fetch).mockImplementation((path) => String(path).includes('/github/fleet-backlog')
    ? response({ ...backlog, source: 'gh-failed', reason: 'gh-pr-list-failed' }, 503)
    : String(path).endsWith('/fleet/runs') ? response(runs) : response({}, 404));
  render(<FleetHubPane visible />);
  expect(await screen.findByText('GitHub read failed · gh-pr-list-failed')).toBeInTheDocument();
});
it('polls each minute only while visible', async () => {
  vi.useFakeTimers();
  const view = render(<SectionVisibilityProvider visible><FleetHubPane visible /></SectionVisibilityProvider>);
  await act(async () => {});
  const calls = () => vi.mocked(fetch).mock.calls.filter(([path]) => String(path).includes('/github/fleet-backlog'));
  expect(calls()).toHaveLength(1);
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(calls()).toHaveLength(2);
  view.rerender(<SectionVisibilityProvider visible={false}><FleetHubPane visible /></SectionVisibilityProvider>);
  await act(async () => { vi.advanceTimersByTime(120_000); });
  expect(calls()).toHaveLength(2);
});
