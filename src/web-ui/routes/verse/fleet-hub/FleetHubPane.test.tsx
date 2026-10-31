import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { getDockState, resetDockStore, subscribeDockState } from '../dock/dock-store.js';
import { registerPane } from '../panes/pane-registry.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { FleetHubPane } from './FleetHubPane.js';
import '../fleet-lanes/fleet-lanes.pane.js';
import '../fleet-events/fleet-events.pane.js';

const fixture: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'degraded', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [{ lane: 'codex', running: 1, target: 2, queued: 3, held: true, heldReason: 'Budget hold', tokensLastHour: null, merged24h: null, mergeRate24h: null }],
  workers: Array.from({ length: 13 }, (_, i) => ({ job: `job-${i}`, repo: 'example/repo', lane: 'codex', tier: 'frontier', ageSeconds: i })),
  leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 2, items: [{ repo: 'example/repo', number: 12, title: 'Fleet view' }, { repo: 'unknown', number: 13, title: 'No owner' }] }, events: [], codexPersonal: null, inbox: [], drop: null,
};

beforeEach(() => {
  localStorage.clear(); resetDockStore(); evictAll();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture)));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('opens a tile and lays out only registered fleet panes with one store update', async () => {
  render(<FleetHubPane visible />);
  await screen.findByText('1/2');
  fireEvent.click(screen.getByText('Lanes'));
  expect(getDockState().active).toBe('fleet-lanes');
  const listener = vi.fn();
  const unsubscribe = subscribeDockState(listener);
  fireEvent.click(screen.getByRole('button', { name: 'Open fleet workspace' }));
  expect(getDockState()).toMatchObject({ open: true, active: 'fleet-lanes', splitWith: 'fleet-events', tabs: ['fleet-lanes', 'fleet-events'] });
  expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe();
  expect(screen.getByText('Inbox').closest('button')).toBeDisabled();
});

it('reacts to late registrations and uses the registered title', async () => {
  render(<FleetHubPane visible />);
  await screen.findByText('1/2');
  let unregister = () => {};
  act(() => { unregister = registerPane({ id: 'fleet-inbox', title: 'Fleet inbox', needsSession: false, icon: () => null, component: () => null }); });
  fireEvent.click(screen.getByRole('button', { name: 'Fleet inbox 0' }));
  expect(getDockState().active).toBe('fleet-inbox');
  act(() => unregister());
  expect(screen.getByText('Inbox').closest('button')).toBeDisabled();
});

it('refreshes counts while visible and stops polling when hidden', async () => {
  vi.useFakeTimers();
  const view = render(<FleetHubPane visible />);
  await act(async () => {});
  await act(async () => { vi.advanceTimersByTime(5_000); });
  expect(fetch).toHaveBeenCalledTimes(2);
  view.rerender(<FleetHubPane visible={false} />);
  await act(async () => { vi.advanceTimersByTime(10_000); });
  expect(fetch).toHaveBeenCalledTimes(2);
});
