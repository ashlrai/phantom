/**
 * SessionsView — fleet.sessions.v1: the unified dispatchd session list.
 *
 * Contract:
 *   - Renders active sessions (queued/parked/launching/running/publishing/
 *     exited/stale) with job, repo, lane, tier, StatusBadge status, live
 *     elapsed, model, pid and start time — plus a bounded recently-finished
 *     table with outcome, duration, tokens, diff and PR link.
 *   - Null cells render "—"; live='unknown' renders an "unverified" flag;
 *     per-source health and the degraded banner are always visible.
 *   - Loading, error and empty states are explicit, never invented rows.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SessionsView } from './SessionsView.js';
import { evictAll } from '../../../data/cache.js';
import type { FleetSessionsV1, FleetSessionV1 } from '../../../data/api-types.js';

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo * 1000).toISOString();

function session(over: Partial<FleetSessionV1>): FleetSessionV1 {
  return {
    job: 'JOB-X', repo: 'phantom', lane: 'codex-cmp', tier: 'work', status: 'running',
    model: null, batchId: null, pid: null, live: 'no', exitCode: null, timedOut: false,
    enqueuedAt: null, claimedAt: null, launchedAt: null, startedAt: null, finishedAt: null,
    elapsedSeconds: null, durationSeconds: null, queueWaitSeconds: null,
    tokensTotal: null, wallSeconds: null, diffLines: null, outcome: null, prUrl: null,
    ...over,
  };
}

const SNAPSHOT: FleetSessionsV1 = {
  schema: 'fleet.sessions.v1',
  generatedAt: new Date(NOW).toISOString(),
  runsDirPresent: true,
  sourceState: 'healthy',
  sources: {
    runDir: 'healthy', ready: 'healthy', claimed: 'missing', precheck: 'missing',
    status: 'healthy', metrics: 'healthy', live: 'healthy',
  },
  dispatcher: { lastTick: iso(12), paused: false, tickAgeSeconds: 12 },
  sessions: [
    session({
      job: 'JOB-RUN1', status: 'running', model: 'gpt-5.3-codex', pid: 4321, live: 'yes',
      startedAt: iso(300), elapsedSeconds: 754, enqueuedAt: iso(400), claimedAt: iso(300),
      launchedAt: iso(300), queueWaitSeconds: 100,
    }),
    session({
      job: 'JOB-Q1', status: 'queued', lane: 'claude', tier: 'frontier',
      startedAt: iso(600), elapsedSeconds: 600, enqueuedAt: iso(600),
    }),
    session({ job: 'JOB-P1', status: 'parked', lane: 'devin', tier: 'fast', startedAt: iso(900), elapsedSeconds: 900, enqueuedAt: iso(900) }),
    session({ job: 'JOB-STALE', status: 'stale', live: 'unknown', startedAt: iso(7200), elapsedSeconds: 7200 }),
  ],
  recent: [
    session({
      job: 'JOB-FIN', status: 'finished', outcome: 'pr',
      prUrl: 'https://github.com/ashlrai/phantom/pull/123',
      startedAt: iso(760), finishedAt: iso(120), elapsedSeconds: null,
      durationSeconds: 640, wallSeconds: 640, tokensTotal: 4321, diffLines: 17, exitCode: 0,
    }),
  ],
  counts: { queued: 1, parked: 1, launching: 0, running: 1, publishing: 0, exited: 0, stale: 1 },
  malformed: 0,
  truncated: false,
};

function respond(body: unknown, status = 200) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/fleet/sessions')) {
      return new Response(JSON.stringify(body), { status });
    }
    return new Response('not found', { status: 404 });
  });
}

function renderView() {
  return render(
    <MemoryRouter>
      <SessionsView />
    </MemoryRouter>,
  );
}

describe('SessionsView', () => {
  beforeEach(() => {
    evictAll();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders active sessions with status, elapsed, model, pid and lane/tier', async () => {
    vi.stubGlobal('fetch', respond(SNAPSHOT));
    renderView();

    await waitFor(() => expect(screen.getByText('JOB-RUN1')).toBeInTheDocument());
    const runRow = screen.getByText('JOB-RUN1').closest('tr')!;
    expect(runRow.textContent).toContain('running');
    expect(runRow.textContent).toContain('codex-cmp');
    expect(runRow.textContent).toContain('work');
    expect(runRow.textContent).toContain('gpt-5.3-codex');
    expect(runRow.textContent).toContain('4321');
    expect(runRow.textContent).toMatch(/12m 3\ds/); // 754s + sub-minute drift

    const qRow = screen.getByText('JOB-Q1').closest('tr')!;
    expect(qRow.textContent).toContain('queued');
    expect(qRow.textContent).toContain('claude');
    expect(qRow.textContent).toMatch(/10m [01]s/);

    expect(screen.getByText('JOB-P1').closest('tr')!.textContent).toContain('parked');

    // live='unknown' renders the honest unverified flag, never a fake pid.
    const staleRow = screen.getByText('JOB-STALE').closest('tr')!;
    expect(staleRow.textContent).toContain('stale');
    expect(staleRow.textContent).toContain('unverified');

    // Header count summary + dispatcher note + source line.
    expect(screen.getByText(/1 running · 1 stale · 1 queued · 1 parked/)).toBeInTheDocument();
    expect(screen.getByText(/dispatcher tick 12s ago/)).toBeInTheDocument();
    expect(screen.getByText(/sources: run markers healthy · ready\.tsv healthy/)).toBeInTheDocument();
  });

  it('renders the recently-finished table with outcome, duration, tokens, diff and PR link', async () => {
    vi.stubGlobal('fetch', respond(SNAPSHOT));
    renderView();

    await waitFor(() => expect(screen.getByText('JOB-FIN')).toBeInTheDocument());
    const row = screen.getByText('JOB-FIN').closest('tr')!;
    expect(row.textContent).toContain('pr');
    expect(row.textContent).toContain('10m 40s'); // 640s duration, no drift
    expect(row.textContent).toContain('4,321');
    expect(row.textContent).toContain('+17');
    const pr = row.querySelector('a');
    expect(pr?.getAttribute('href')).toBe('https://github.com/ashlrai/phantom/pull/123');
  });

  it('filters sessions by status and search text', async () => {
    vi.stubGlobal('fetch', respond(SNAPSHOT));
    renderView();
    await waitFor(() => expect(screen.getByText('JOB-RUN1')).toBeInTheDocument());

    const statusSelect = screen.getByLabelText('Status');
    fireEvent.change(statusSelect, { target: { value: 'queued' } });
    await waitFor(() => expect(screen.queryByText('JOB-RUN1')).not.toBeInTheDocument());
    expect(screen.getByText('JOB-Q1')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/job, repo, lane/i), { target: { value: 'JOB-P1' } });
    await waitFor(() => expect(screen.queryByText('JOB-Q1')).not.toBeInTheDocument());
  });

  it('shows the degraded banner and honest dashes when sources are unhealthy', async () => {
    const degraded: FleetSessionsV1 = {
      ...SNAPSHOT,
      sourceState: 'degraded',
      malformed: 3,
      sources: { ...SNAPSHOT.sources, metrics: 'degraded', live: 'degraded' },
      sessions: [
        session({ job: 'JOB-D1', status: 'running', live: 'unknown', pid: null, model: null, elapsedSeconds: null }),
      ],
      recent: [],
      counts: { queued: 0, parked: 0, launching: 0, running: 1, publishing: 0, exited: 0, stale: 0 },
    };
    vi.stubGlobal('fetch', respond(degraded));
    renderView();

    await waitFor(() => expect(screen.getByText('JOB-D1')).toBeInTheDocument());
    expect(screen.getByText(/session sources degraded/)).toBeInTheDocument();
    expect(screen.getByText(/3 malformed rows dropped/)).toBeInTheDocument();
    const row = screen.getByText('JOB-D1').closest('tr')!;
    expect(row.textContent).toContain('unverified');
    expect(row.textContent).not.toContain('undefined');
  });

  it('renders an explicit empty state when nothing is running or queued', async () => {
    vi.stubGlobal('fetch', respond({ ...SNAPSHOT, sessions: [], recent: [], runsDirPresent: false, sourceState: 'missing' }));
    renderView();

    await waitFor(() => expect(screen.getByText(/No runs directory found/)).toBeInTheDocument());
    expect(screen.getByText(/No active sessions/)).toBeInTheDocument();
    expect(screen.getByText(/No finished sessions recorded yet/)).toBeInTheDocument();
  });

  it('renders the failure reason when the API read fails', async () => {
    vi.stubGlobal('fetch', respond({}, 500));
    renderView();

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });
});
