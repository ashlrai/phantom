import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { evictAll } from '../../data/cache.js';
import { FleetHealthStrip } from './FleetHealthStrip.js';

const SNAPSHOT = {
  schema: 'fleet.lanes.v1',
  generatedAt: '2026-11-10T12:00:00Z',
  mergeWindowMinutes: 60,
  holdSource: 'healthy',
  notes: [],
  sources: {
    queue: { state: 'healthy', file: 'ready.tsv', rows: 12, dropped: 0 },
    queueState: { state: 'healthy', file: 'queue.v1.json', jobs: 14 },
    ledger: { state: 'healthy', file: 'jobs.jsonl', events: 40, dropped: 0 },
    usage: { state: 'healthy', files: ['u.jsonl'], pools: 3, dropped: 0 },
    budgets: { state: 'healthy' },
  },
  lanes: [
    {
      lane: 'codex-personal',
      liveJobs: 12,
      slotTarget: 32,
      queueDepth: 7,
      mergesPerHour: 2,
      credit: { state: 'observed', label: '64% weekly', remainingPct: 64, resetAt: null },
      hold: null,
    },
    {
      lane: 'zai',
      liveJobs: null,
      slotTarget: 3,
      queueDepth: null,
      mergesPerHour: null,
      credit: { state: 'unknown', label: 'unknown', remainingPct: null, resetAt: null },
      hold: null,
    },
    {
      lane: 'gemini',
      liveJobs: 0,
      slotTarget: 0,
      queueDepth: 4,
      mergesPerHour: null,
      credit: { state: 'observed', label: '10% weekly', remainingPct: 10, resetAt: null },
      hold: { held: true, reason: 'autobackoff', until: null, by: 'autobackoff', since: null },
    },
  ],
};

function mockFetch(data: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(data), { status }));
}

describe('FleetHealthStrip', () => {
  beforeEach(() => {
    evictAll();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders a chip per lane with live/target, queue and credit', async () => {
    vi.stubGlobal('fetch', mockFetch(SNAPSHOT));
    render(<FleetHealthStrip />);
    const strip = await screen.findByRole('region', { name: 'Lane health' });
    await waitFor(() => expect(strip).toHaveTextContent('codex-personal'));
    expect(strip).toHaveTextContent('12/32');
    expect(strip).toHaveTextContent('queue 7 · 64% weekly');
    expect(screen.getByRole('meter', { name: 'codex-personal credit remaining' })).toHaveAttribute('aria-valuenow', '64');
  });

  it('shows honest unknowns and HELD markers instead of invented zeros', async () => {
    vi.stubGlobal('fetch', mockFetch(SNAPSHOT));
    render(<FleetHealthStrip />);
    const strip = await screen.findByRole('region', { name: 'Lane health' });
    await waitFor(() => expect(strip).toHaveTextContent('zai'));
    // zai: unobserved live/queue/credit render as dashes and "credit unknown" — no bar.
    expect(strip).toHaveTextContent('—/3');
    expect(strip).toHaveTextContent('credit unknown');
    expect(screen.queryByRole('meter', { name: 'zai credit remaining' })).not.toBeInTheDocument();
    // gemini is held.
    expect(strip).toHaveTextContent('HELD');
  });

  it('reports a failed read instead of an empty fleet', async () => {
    vi.stubGlobal('fetch', mockFetch('unavailable', 500));
    render(<FleetHealthStrip />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });
});
