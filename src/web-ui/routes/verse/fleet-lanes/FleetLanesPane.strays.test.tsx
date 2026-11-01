import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import type { StraySlotsV1 } from '../../../../core/fleet/stray-slots.js';
import { FleetLanesPane } from './FleetLanesPane.js';

const fixture: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [
    { lane: 'devin', running: 1, target: 2, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null },
    { lane: 'codex-personal', running: 0, target: 1, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null },
  ],
  workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], claimed: [],
  mergesLastHour: { count: 0, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
const strays = (lanes: StraySlotsV1['lanes']): StraySlotsV1 => ({
  v: 1, generatedAt: '2026-10-31T12:00:00Z', source: 'ok', lanes,
});
const busy = strays([
  { lane: 'codex-personal', slotsLost: 1, strays: [{ job: 'RQ-PHX-DEF', pid: 4322, ageSeconds: 60 }] },
  { lane: 'devin', slotsLost: 2, strays: [{ job: 'RQ-PHX-ABC', pid: 4321, ageSeconds: 30 }, { job: 'RQ-PHX-GHI', pid: 4323, ageSeconds: 90 }] },
]);

const serve = (report: unknown, strayStatus = 200) => vi.stubGlobal('fetch', vi.fn(async (input) =>
  Response.json(String(input).includes('/stray-slots') ? report : fixture,
    { status: String(input).includes('/stray-slots') ? strayStatus : 200 })));
const strayFetch = () => waitFor(() =>
  expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/stray-slots'))).toBe(true));

beforeEach(() => { evictAll(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('renders the per-lane and totals lines when counted slots are lost', async () => {
  serve(busy); render(<FleetLanesPane visible />);
  expect(await screen.findByText('2 slots lost to strays (RQ-PHX-ABC, RQ-PHX-GHI)')).toBeInTheDocument();
  expect(screen.getByText('1 slot lost to strays (RQ-PHX-DEF)')).toBeInTheDocument();
  expect(screen.getByText('3 counted slots have no worker (devin 2, codex-personal 1). Run leader/STOP-STRAYS.sh to list them.')).toBeInTheDocument();
  expect(screen.getByText('1/2 · 0 queued')).toBeInTheDocument();
});

it('renders neither line when no slots are lost', async () => {
  serve(strays([{ lane: 'devin', slotsLost: 0, strays: [] }])); render(<FleetLanesPane visible />);
  expect(await screen.findByText('1/2 · 0 queued')).toBeInTheDocument();
  await strayFetch(); await act(async () => {});
  expect(screen.queryByText(/lost to strays/)).toBeNull();
  expect(screen.queryByText(/counted slots?/)).toBeNull();
});

it('renders neither line and no error when the route has not landed', async () => {
  serve({}, 404); render(<FleetLanesPane visible />);
  expect(await screen.findByText('1/2 · 0 queued')).toBeInTheDocument();
  await strayFetch(); await act(async () => {});
  expect(screen.queryByText(/lost to strays/)).toBeNull();
  expect(screen.queryByText(/counted slots?/)).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
});
