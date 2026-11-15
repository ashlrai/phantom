/**
 * recut-desk-old-c160 — coverage for the #2880 (RQ-NODE-4-VIEW) recut: the
 * Fleet Dashboard Nodes panel renders the phantom.nodes.v1 snapshot served by
 * GET /api/nodes (the same projection `phm fleet nodes` prints).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { NodesPanel } from './NodesPanel.js';
import { evictAll } from '../../data/cache.js';

const base = {
  schema: 'phantom.nodes.v1', generatedAt: '2026-11-11T12:00:30.000Z',
  sourcePath: '/tmp/x/nodes.json', observedAt: '2026-11-11T12:00:29.000Z',
  leaderId: null, error: null,
};

const node = (over: Record<string, unknown> = {}) => ({
  id: 'worker-1', role: 'worker', owners: [], caps: ['os:darwin'], status: 'ready',
  heartbeatAt: '2026-11-11T11:59:00.000Z', heartbeatAgeMs: 90_000, liveJobs: [],
  ghAuth: 'ok', leader: false, source: 'registry', ...over,
});

const respond = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('NodesPanel recut (phantom.nodes.v1)', () => {
  beforeEach(() => evictAll());
  afterEach(() => vi.unstubAllGlobals());

  it('renders a worker row with stale heartbeat and job count from the live snapshot', async () => {
    vi.stubGlobal('fetch', respond({
      ...base,
      nodes: [
        node({ id: 'worker-1', status: 'stale', heartbeatAgeMs: 120_000, liveJobs: ['RQ-1'] }),
        node({ id: 'worker-2', role: 'standby', owners: ['mason', 'ci'], caps: [], status: 'ready', heartbeatAgeMs: 5_000 }),
      ],
    }));
    render(<NodesPanel />);
    await waitFor(() => expect(screen.getByText('Nodes (2)')).toBeInTheDocument());
    expect(screen.getByText('No live leader lease')).toBeInTheDocument();
    expect(screen.getByText('2m ago')).toBeInTheDocument();
    expect(screen.getByText('stale')).toBeInTheDocument();
    expect(screen.getByText('mason, ci')).toBeInTheDocument();
  });

  it('shows the snapshot error as the empty state when no nodes joined', async () => {
    vi.stubGlobal('fetch', respond({ ...base, nodes: [], error: 'inventory missing' }));
    render(<NodesPanel />);
    await waitFor(() => expect(screen.getByText('Nodes (0)')).toBeInTheDocument());
    expect(screen.getByText('inventory missing')).toBeInTheDocument();
  });

  it('renders the zero-node empty state when the registry is empty', async () => {
    vi.stubGlobal('fetch', respond({ ...base, nodes: [] }));
    render(<NodesPanel />);
    await waitFor(() => expect(screen.getByText('No nodes have joined this fleet.')).toBeInTheDocument());
  });
});
