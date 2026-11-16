import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { NodeProfileRows, nodeRowSummary, profileNodeRows } from './NodeProfileRows.js';
import { evictAll } from '../../../data/cache.js';
import type { NodeRow } from '../../../../core/nodes/view.js';

const profile = { label: 'MacBook Pro (8 GB)', ramGb: 8, maxCliAgents: 2, localModels: false, memoryFloorPercent: 15 };
const base: NodeRow = { id: 'mbp8', role: 'worker', owners: ['ashlr'], caps: [], status: 'offline', heartbeatAt: null, heartbeatAgeMs: null,
  liveJobs: [], ghAuth: 'unknown', leader: false, source: 'profile', profile };
const plain: NodeRow = { ...base, id: 'muse', profile: undefined, status: 'ready', source: 'registry' };
const snap = (nodes: NodeRow[]) => ({ schema: 'phantom.nodes.v1', generatedAt: '2026-11-16T00:00:00.000Z', sourcePath: '/tmp/n.json', observedAt: null, leaderId: null, nodes, error: null });

describe('NodeProfileRows', () => {
  beforeEach(() => evictAll());
  afterEach(() => vi.unstubAllGlobals());

  it('only keeps nodes with a declared profile', () => {
    expect(profileNodeRows([base, plain]).map(n => n.id)).toEqual(['mbp8']);
    expect(profileNodeRows(undefined)).toEqual([]);
  });
  it('summarizes limits and heartbeat age', () => {
    expect(nodeRowSummary(base)).toBe('mbp8 offline · 8 GB, max 2 agents, no local models · no heartbeat');
    expect(nodeRowSummary({ ...base, status: 'ready', heartbeatAgeMs: 30_000 })).toContain('heartbeat 30s ago');
  });
  it('renders an unreachable profile host as offline in the resource bar', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(snap([base, plain])), { status: 200 })));
    render(<NodeProfileRows />);
    await waitFor(() => expect(screen.getByRole('button', { name: /mbp8 offline/ })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /mbp8 offline/ })).toHaveAttribute('data-state', 'offline');
    expect(screen.queryByText(/muse/)).toBeNull();
  });
  it('renders nothing when no profile node is in the snapshot or when disabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(snap([plain])), { status: 200 })));
    const { container } = render(<NodeProfileRows />);
    await new Promise(r => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });
});
