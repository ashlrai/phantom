import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { NodesPanel } from './NodesPanel.js';
import { evictAll } from '../../data/cache.js';

const SNAP = {
  schema: 'phantom.nodes.v1', generatedAt: '2026-11-02T12:00:30.000Z', sourcePath: '/fake-home/nodes/nodes.json',
  observedAt: '2026-11-02T12:00:30.000Z', leaderId: 'mac-mini-1', error: null,
  nodes: [
    { id: 'mac-mini-1', role: 'leader', owners: [], caps: ['gh', 'os:darwin'], status: 'ready', heartbeatAt: '2026-11-02T12:00:00.000Z', heartbeatAgeMs: 30_000, liveJobs: ['job-7', 'job-9'], ghAuth: 'ok', leader: true, source: 'registry' },
    { id: 'lima-vm-2', role: 'worker', owners: [], caps: [], status: 'down', heartbeatAt: null, heartbeatAgeMs: null, liveJobs: [], ghAuth: 'missing', leader: false, source: 'registry' },
  ],
};

function serve(body: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })));
}

describe('NodesPanel', () => {
  beforeEach(() => evictAll());
  afterEach(() => vi.unstubAllGlobals());

  it('shows role, caps, heartbeat age, live jobs and the leader badge', async () => {
    serve(SNAP);
    render(<NodesPanel />);
    await waitFor(() => expect(screen.getByText(/★ leader/)).toBeInTheDocument());
    expect(screen.getByText('Nodes (2)')).toBeInTheDocument();
    expect(screen.getByText('Leader: mac-mini-1')).toBeInTheDocument();
    expect(screen.getByText('30s ago')).toBeInTheDocument();
    expect(screen.getByText('gh, os:darwin')).toBeInTheDocument();
    expect(screen.getByText('no heartbeat')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('surfaces an inventory error with the command that explains it', async () => {
    serve({ ...SNAP, nodes: [], leaderId: null, observedAt: null, error: 'inventory failed validation' });
    render(<NodesPanel />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('inventory failed validation'));
    expect(screen.getByRole('alert')).toHaveTextContent('ashlr fleet nodes');
    expect(screen.getByText('No live leader lease')).toBeInTheDocument();
  });

  it('says how to add a node when the inventory is empty', async () => {
    serve({ ...SNAP, nodes: [], leaderId: null });
    render(<NodesPanel />);
    await waitFor(() => expect(screen.getByText(/No nodes have joined/)).toBeInTheDocument());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says how to recover when the endpoint fails', async () => {
    serve('nope', 500);
    render(<NodesPanel />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('ashlr fleet nodes'));
  });
});
