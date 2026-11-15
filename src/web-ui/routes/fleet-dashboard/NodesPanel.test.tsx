import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { NodesPanel } from './NodesPanel.js';
import { evictAll } from '../../data/cache.js';

const SNAP = {
  schema: 'phantom.nodes.v1', generatedAt: '2026-11-02T12:00:30.000Z',
  sourcePath: '/tmp/x/nodes.json', observedAt: '2026-11-02T12:00:29.000Z', leaderId: 'mac-mini-1',
  nodes: [
    { id: 'mac-mini-1', role: 'leader', owners: ['mason'], caps: ['gh', 'os:darwin'], status: 'ready', heartbeatAt: '2026-11-02T12:00:00.000Z', heartbeatAgeMs: 30_000, liveJobs: ['job-7', 'job-9'], ghAuth: 'ok', leader: true, source: 'registry' },
    { id: 'lima-vm-2', role: 'worker', owners: [], caps: [], status: 'down', heartbeatAt: null, heartbeatAgeMs: null, liveJobs: [], ghAuth: 'missing', leader: false, source: 'registry' },
  ],
  error: 'inventory contains a secret-shaped value',
};

describe('NodesPanel', () => {
  beforeEach(() => evictAll());
  afterEach(() => vi.unstubAllGlobals());

  it('shows role, caps, heartbeat age, live jobs, leader badge and the snapshot error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(SNAP), { status: 200 })));
    render(<NodesPanel />);
    await waitFor(() => expect(screen.getByText(/★ leader/)).toBeInTheDocument());
    expect(screen.getByText('Leader: mac-mini-1')).toBeInTheDocument();
    expect(screen.getByText('30s ago')).toBeInTheDocument();
    expect(screen.getByText('gh, os:darwin')).toBeInTheDocument();
    expect(screen.getByText('no heartbeat')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('inventory contains a secret-shaped value');
  });

  it('says how to recover when the endpoint fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    render(<NodesPanel />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('phm fleet nodes'));
  });
});
