/**
 * LanesPanel — RQ-PHANTOM-ENG-CONSOLE: per-lane engineering console.
 *
 * Contract:
 *   - Renders one row per lane from GET /api/fleet/lanes (fleet.lanes.v1)
 *     with credit, burn, reset, queue depth, live jobs and merges/hour.
 *   - Null cells render as "—"; the source-health line always renders so an
 *     operator can tell "empty" from "unreadable".
 *   - Error and empty states are explicit, never invented zeros.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { LanesPanel } from './LanesPanel.js';
import { evictAll } from '../../../data/cache.js';

const SNAPSHOT = {
  schema: 'fleet.lanes.v1',
  generatedAt: new Date().toISOString(),
  mergeWindowMinutes: 60,
  sources: {
    queue: { state: 'healthy', file: 'ready.tsv', rows: 6, dropped: 0 },
    queueState: { state: 'healthy', file: 'queue.v1.json', jobs: 8 },
    ledger: { state: 'healthy', file: 'jobs.jsonl', events: 6, dropped: 0 },
    usage: { state: 'healthy', files: ['usage-readings.log'], pools: 2, dropped: 0 },
    budgets: { state: 'healthy' },
  },
  lanes: [
    {
      lane: 'devin',
      queueDepth: 2,
      liveJobs: 1,
      mergesPerHour: 1,
      credit: {
        state: 'observed', label: '12.5 ACU', remainingPct: null, remainingCredits: 12.5,
        creditsUnit: 'acus', resetAt: null, burnPerHour: 0.5, projectedExhaustionAt: null,
        observedAt: '2026-10-28T01:55:00.000Z', source: 'budget-ledger',
      },
    },
    {
      lane: 'grok-ultra',
      queueDepth: 1,
      liveJobs: 0,
      mergesPerHour: 0,
      credit: {
        state: 'observed', label: '64% window', remainingPct: 64, remainingCredits: null,
        creditsUnit: null, resetAt: null, burnPerHour: null, projectedExhaustionAt: null,
        observedAt: '2026-10-28T01:50:00.000Z', source: 'usage-journal',
      },
    },
    {
      lane: 'local-omlx',
      queueDepth: null,
      liveJobs: null,
      mergesPerHour: null,
      credit: {
        state: 'unknown', label: 'unknown', remainingPct: null, remainingCredits: null,
        creditsUnit: null, resetAt: null, burnPerHour: null, projectedExhaustionAt: null,
        observedAt: null, source: null,
      },
    },
  ],
};

function respond(body: unknown, status = 200) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/fleet/lanes')) {
      return new Response(JSON.stringify(body), { status });
    }
    return new Response('not found', { status: 404 });
  });
}

describe('LanesPanel', () => {
  beforeEach(() => {
    evictAll();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders one row per lane with credit, queue, live and merge cells', async () => {
    vi.stubGlobal('fetch', respond(SNAPSHOT));
    render(<LanesPanel />);

    await waitFor(() => expect(screen.getByText('devin')).toBeInTheDocument());
    expect(screen.getByText('12.5 ACU')).toBeInTheDocument();
    expect(screen.getByText('0.5 ACU/h')).toBeInTheDocument();
    expect(screen.getByText('64% window')).toBeInTheDocument();
    expect(screen.getByText('grok-ultra')).toBeInTheDocument();
    // local-omlx has no evidence — every metric cell is an honest em dash.
    const localRow = screen.getByText('local-omlx').closest('tr')!;
    expect(localRow.querySelectorAll('td')[4]!.textContent).toBe('—'); // merges/h
    expect(localRow.textContent).toContain('unknown');
    // Source-health line keeps "empty" distinguishable from "unreadable".
    expect(screen.getByText(/ready\.tsv healthy \(6 rows\)/)).toBeInTheDocument();
    expect(screen.getByText(/budgets healthy/)).toBeInTheDocument();
  });

  it('renders the failure reason when the API read fails', async () => {
    vi.stubGlobal('fetch', respond({}, 500));
    render(<LanesPanel />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });

  it('renders an explicit empty state when no lanes are observed', async () => {
    vi.stubGlobal('fetch', respond({ ...SNAPSHOT, lanes: [] }));
    render(<LanesPanel />);

    await waitFor(() =>
      expect(screen.getByText(/No lanes observed/)).toBeInTheDocument(),
    );
  });
});
