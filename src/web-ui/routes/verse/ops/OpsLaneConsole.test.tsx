/**
 * OpsLaneConsole — the lanes block at the top of Ops ▸ "Fleet & router",
 * fed by GET /api/fleet/lanes (fleet.lanes.v1): null cells read "—",
 * unknown credit reads "no reading" (never a 0% bar), degraded sources
 * are named in the footer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { evictAll } from '../../../data/cache.js';
import { OpsLaneConsole } from './OpsLaneConsole.js';
import type { FleetLaneSnapshot, FleetLaneView } from '../../../data/api-types.js';

const lane = (over: Partial<FleetLaneView> = {}): FleetLaneView => ({
  lane: 'codex-personal', queueDepth: 3, liveJobs: 2, mergesPerHour: 1.25,
  credit: { state: 'observed', label: '64% weekly', remainingPct: 64, remainingCredits: null, creditsUnit: null, resetAt: null, burnPerHour: null, projectedExhaustionAt: new Date(Date.now() + 7_200_000).toISOString(), observedAt: null, source: 'budget-ledger' },
  ...over,
});

const UNKNOWN_LANE: FleetLaneView = {
  lane: 'local-omlx', queueDepth: null, liveJobs: null, mergesPerHour: null,
  credit: { state: 'unknown', label: 'unknown', remainingPct: null, remainingCredits: null, creditsUnit: null, resetAt: null, burnPerHour: null, projectedExhaustionAt: null, observedAt: null, source: null },
};

const snapshot = (over: Partial<FleetLaneSnapshot> = {}): FleetLaneSnapshot => ({
  schema: 'fleet.lanes.v1', generatedAt: new Date(Date.now() - 12_000).toISOString(), mergeWindowMinutes: 60,
  sources: {
    queue: { state: 'healthy', file: 'ready.tsv', rows: 4, dropped: 0 }, queueState: { state: 'healthy', file: 'queue.v1.json', jobs: 3 },
    ledger: { state: 'healthy', file: 'jobs.jsonl', events: 7, dropped: 0 }, usage: { state: 'healthy', files: ['usage-readings.log'], pools: 2, dropped: 0 },
    budgets: { state: 'healthy' },
  },
  lanes: [lane(), UNKNOWN_LANE], ...over,
});

const stub = (handler: (url: string) => Response | Promise<Response>) => {
  const spy = vi.fn(async (input: RequestInfo | URL) => handler(typeof input === 'string' ? input : input.toString()));
  vi.stubGlobal('fetch', spy);
  return spy;
};

beforeEach(() => { evictAll(); localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('OpsLaneConsole', () => {
  it('renders one row per lane with chips, credit and the remaining-credit bar', async () => {
    stub(() => Promise.resolve(Response.json(snapshot())));
    render(<OpsLaneConsole />);

    await screen.findByText('codex-personal');
    expect(screen.getByText('Lanes on this Mac')).toBeInTheDocument();
    expect(screen.getByText(/updated \d+ s ago/)).toBeInTheDocument();
    expect(screen.getByText('live 2')).toBeInTheDocument();
    expect(screen.getByText('queued 3')).toBeInTheDocument();
    expect(screen.getByText('merges/h 1.3')).toBeInTheDocument();
    expect(screen.getByText(/64% weekly/)).toBeInTheDocument();
    expect(screen.getByText(/runs out in 2 h/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'codex-personal: 64% of weekly window left' })).toBeInTheDocument();

    // The unknown lane: honest dashes, "no reading", and no 0% bar.
    expect(screen.getByText('local-omlx')).toBeInTheDocument();
    expect(screen.getByText('no reading')).toBeInTheDocument();
    expect(screen.getByText('merges/h —')).toBeInTheDocument();
    expect(screen.getAllByRole('img')).toHaveLength(1);
  });

  it('renders the empty-lanes line and names a degraded source in the footer', async () => {
    const snap = snapshot({ lanes: [] });
    snap.sources.queue = { state: 'degraded', file: 'ready.tsv', rows: 0, dropped: 0 };
    stub(() => Promise.resolve(Response.json(snap)));
    render(<OpsLaneConsole />);

    await screen.findByText('No lanes reported by the queue dir');
    expect(screen.getByText(/queue: degraded \(ready\.tsv\)/)).toBeInTheDocument();
  });

  it('re-reads the route when Refresh is pressed', async () => {
    const spy = stub(() => Promise.resolve(Response.json(snapshot())));
    const user = userEvent.setup();
    render(<OpsLaneConsole />);

    await screen.findByText('codex-personal');
    const before = spy.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(before));
    expect(spy.mock.calls.at(-1)?.[0]).toBe('/api/fleet/lanes');
  });

  it('renders the failure reason with a Retry action', async () => {
    const spy = stub(() => Promise.resolve(Response.json({ error: 'queue dir unreadable' }, { status: 500 })));
    const user = userEvent.setup();
    render(<OpsLaneConsole />);

    await screen.findByRole('alert');
    expect(screen.getByText('queue dir unreadable')).toBeInTheDocument();
    const before = spy.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(before));
  });
});
