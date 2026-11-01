import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { FleetLanesPane } from './FleetLanesPane.js';

const fixture: FleetRuns = {
  v: 1, generatedAt: '2026-11-01T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: false, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: 'down token rejected 2026-11-01 01:31:50',
  lanes: [{ lane: 'claude', running: 0, target: 12, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null }],
  workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
const serve = (data: FleetRuns) => vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
beforeEach(() => { evictAll(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('explains the down lane and copies the runnable fix for two seconds', async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  serve(fixture); render(<FleetLanesPane visible />);
  expect(await screen.findByText('Down')).toHaveAttribute('data-tone', 'danger');
  expect(screen.getByText(/12 slots idle · token rejected · since 01:31/)).toBeInTheDocument();
  expect(screen.getByText(/Run on this Mac: ~\/\.ashlr-runs\/bin\/fix-claude-lane\.sh/)).toBeInTheDocument();
  vi.useFakeTimers();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy' })); });
  expect(writeText).toHaveBeenCalledExactlyOnceWith('~/.ashlr-runs/bin/fix-claude-lane.sh');
  expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  act(() => { vi.advanceTimersByTime(2_000); });
  expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
});

it('leaves the healthy lane unchanged', async () => {
  serve({ ...fixture, claudeLane: 'healthy' }); render(<FleetLanesPane visible />);
  expect(await screen.findByText('0/12 · 0 queued')).toBeInTheDocument();
  expect(screen.queryByText('Down')).not.toBeInTheDocument();
  expect(screen.queryByText(/slots idle/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Run on this Mac/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
});
