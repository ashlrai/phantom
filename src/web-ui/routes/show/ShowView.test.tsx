import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { evictAll } from '../../data/cache.js';
import { ShowView } from './ShowView.js';

const NOW_ISO = new Date().toISOString();

const RUNNING_RUN = {
  id: 'r-live',
  goal: 'polish the observability layer',
  status: 'running',
  engine: 'codex',
  provider: 'openai',
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
  budget: { maxTokens: 100000, maxSteps: 50, allowCloud: true },
  usage: { tokensIn: 10, tokensOut: 5, steps: 1, estCostUsd: 0 },
  tasks: [{ id: 't1', goal: 'wire the live strip', deps: [], status: 'running' }],
  steps: [{ ts: NOW_ISO, taskId: 't1', kind: 'tool', summary: 'edited ShowView' }],
};

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    let data: unknown;
    if (url.startsWith('/api/fleet/lanes')) data = { lanes: [
      { lane: 'claude', liveJobs: 2, slotTarget: 8, queueDepth: 4, mergesPerHour: 1, credit: { state: 'observed', label: '64% weekly', remainingPct: 64, resetAt: null }, hold: null },
      { lane: 'codex', liveJobs: null, slotTarget: null, queueDepth: null, mergesPerHour: null, credit: { state: 'unknown', label: 'unknown', remainingPct: null, resetAt: null }, hold: null },
    ], generatedAt: '2026-01-02T00:00:00Z' };
    else if (url.startsWith('/api/fleet-activity')) data = {
      recentMerges: [{ ts: '2026-01-02T00:00:00Z', repo: 'phantom', engine: 'agent' }],
      recentTicks: [],
      recentActions: [
        { ts: '2026-01-02T01:00:00Z', actor: 'verifier', kind: 'verification', outcome: 'verified', action: 'verify', summary: 'Verified the change', repo: 'phantom', runId: 'r-live' },
        { ts: '2026-01-02T00:59:00Z', actor: 'daemon', kind: 'dispatch', outcome: 'started', action: 'dispatch', summary: 'Dispatched a job', runId: 'r-live' },
      ],
    };
    else if (url.startsWith('/api/fleet')) data = { queue: { backlogItems: 7 }, merges: { recent: 3 } };
    else if (url.startsWith('/api/logs-observation')) data = { entries: [] };
    else if (url.startsWith('/api/runs')) data = [RUNNING_RUN];
    else if (url.startsWith('/api/run/')) data = RUNNING_RUN;
    else if (url.startsWith('/api/inbox')) data = { pending: 2, proposals: [] };
    else return new Response('missing', { status: 404 });
    return new Response(JSON.stringify(data), { status: 200 });
  });
}

function renderShow() {
  return render(
    <MemoryRouter>
      <ShowView />
    </MemoryRouter>,
  );
}

describe('ShowView', () => {
  beforeEach(() => {
    evictAll();
    vi.stubGlobal('fetch', mockFetch());
  });
  afterEach(() => vi.unstubAllGlobals());
  it('shows observed metrics and merges and lets the viewer pause', async () => {
    renderShow();
    await waitFor(() => expect(screen.getAllByText('Merged in phantom').length).toBeGreaterThan(0));
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getAllByText('phantom').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Pause story' }));
    expect(screen.getByText('PAUSED')).toBeInTheDocument();
  });
  it('threads agent comms by session with readable kinds and a jump link', async () => {
    renderShow();
    const comms = await screen.findByRole('region', { name: 'Agent comms' });
    // Both run-scoped actions fold into one thread titled with the run goal.
    await waitFor(() => expect(comms).toHaveTextContent('polish the observability layer'));
    expect(comms).toHaveTextContent('Verified the change');
    expect(comms).toHaveTextContent('verifier · Verified');
    expect(comms).toHaveTextContent('daemon · Dispatched');
    expect(comms.querySelector('a[href="/work/runs/r-live"]')).not.toBeNull();
  });
  it('renders win feed and only observed quota gauges', async () => {
    renderShow();
    expect(await screen.findByRole('region', { name: 'Win feed' })).toHaveTextContent('Merged in phantom');
    const gauges = await screen.findByRole('region', { name: 'Quota gauges' });
    await waitFor(() => expect(gauges).toHaveTextContent('64% weekly'));
    expect(screen.getByRole('meter', { name: 'claude remaining' })).toHaveAttribute('aria-valuenow', '64');
    expect(gauges).not.toHaveTextContent('codex');
  });
  it('shows the lane strip and live session cards for running work', async () => {
    renderShow();
    const strip = await screen.findByRole('region', { name: 'Lane health' });
    await waitFor(() => expect(strip).toHaveTextContent('2/8'));
    expect(strip).toHaveTextContent('claude');
    const live = await screen.findByRole('region', { name: 'Live sessions' });
    await waitFor(() => expect(live).toHaveTextContent('polish the observability layer'));
    expect(live).toHaveTextContent('wire the live strip');
  });
  it('reports unavailable sources instead of presenting an empty fleet as fact', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 500 })));
    renderShow();
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(screen.getByText('Merge activity unavailable.')).toBeInTheDocument();
    expect(screen.getByText('Quota readings unavailable.')).toBeInTheDocument();
    expect(screen.getByText('Agent comms unavailable.')).toBeInTheDocument();
  });
});
