import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import type { FleetRunsV1 } from '../../../../core/verse/fleet-runs-types.js';
import { evictAll } from '../../../data/cache.js';
import { FleetGraphPane } from './FleetGraphPane.js';

const fixture: FleetRunsV1 = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [{ lane: 'codex', running: 1, target: 2, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null }],
  workers: [{ job: 'job-1', lane: 'codex', repo: 'ashlrai/phantom', tier: 'frontier', ageSeconds: 90 }],
  leaders: [{ label: 'Fleet leader', ageSeconds: 12 }], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 2, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};

beforeEach(() => { evictAll(); vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url === '/api/verse/fleet/graph/live' ? { v: 1, live: { nodes: [] } } : fixture))); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('shows the live counts and graph nodes from the runs API', async () => {
  render(<FleetGraphPane visible />);
  expect(await screen.findByText('1 lane · 1 worker · 2 merges last hour')).toBeInTheDocument();
  const graph = screen.getByRole('region', { name: 'Workspace graph diagram' });
  expect(within(graph).getByText('codex 1/2')).toBeInTheDocument();
  expect(within(graph).getByText('Fleet leader')).toBeInTheDocument();
  expect(within(graph).getByRole('button', { name: 'Inspect workspace node run:job-1' })).toHaveAttribute('title', expect.stringContaining('frontier'));
});

it('stops both graph and pane polls while hidden and resumes on show', async () => {
  vi.useFakeTimers();
  const view = render(<FleetGraphPane visible />);
  await act(async () => {});
  await act(async () => { vi.advanceTimersByTime(10_000); });
  expect(fetch).toHaveBeenCalledTimes(3);
  view.rerender(<FleetGraphPane visible={false} />);
  await act(async () => { vi.advanceTimersByTime(30_000); });
  expect(fetch).toHaveBeenCalledTimes(3);
  view.rerender(<FleetGraphPane visible />);
  await act(async () => {});
  expect(fetch).toHaveBeenCalledTimes(5);
  await act(async () => { vi.advanceTimersByTime(10_000); });
  expect(fetch).toHaveBeenCalledTimes(6);
});
