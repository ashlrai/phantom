import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { DirectPane } from './DirectPane.js';

const props = { visible: true, host: { openPane: vi.fn() } } as unknown as PaneProps;
function stub(map: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const hit = Object.entries(map).find(([path]) => String(input).includes(path));
    return hit ? Response.json(hit[1]) : new Response('{}', { status: 500 });
  }));
}
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const runs = { lanes: [{ lane: 'claude', running: 1, target: 8, queued: 0, held: false, heldReason: null, tokensLastHour: 500 }],
  mergesLastHour: { count: 1, items: [{ repo: 'ashlrai/phantom', number: 3, title: 'Ship' }] }, codexPersonal: { usedPct: 10, resetsAt: null, asOf: null } };

it('renders every panel from live feeds beside the direct box', async () => {
  stub({
    '/api/verse/fleet/runs': runs, '/api/verse/fleet/agent-roster': { schema: 'agent-roster.v1', claims: { items: [{ owner: 'claude', completed: false }] } },
    '/api/verse/ops/releases': { v: 1, generatedAt: 'x', sourceState: 'healthy', repos: [{ repo: 'ashlrai/phantom', path: '/p', version: '1.0.0', latestTag: 'v1.0.0', releaseWorkflow: null, gh: null, notes: [] }] },
    '/api/nodes': { schema: 'phantom.nodes.v1', generatedAt: 'x', sourcePath: 'x', observedAt: null, leaderId: 'mbp', nodes: [{ id: 'mbp', status: 'ready', leader: true }], error: null },
  });
  render(<DirectPane {...props} />);
  expect(await screen.findByRole('region', { name: 'Fleet' })).toHaveTextContent('1 of 8 slots running');
  expect(screen.getByRole('region', { name: 'Merges' })).toHaveTextContent('1 merge in the last hour');
  expect(screen.getByRole('region', { name: 'Releases' })).toHaveTextContent('v1.0.0');
  expect(screen.getByRole('region', { name: 'Nodes' })).toHaveTextContent('1 of 1 ready');
  expect(screen.getByRole('region', { name: 'Agents' })).toHaveTextContent('1 active claim across 1 agent');
  expect(screen.getByRole('region', { name: 'Spend' })).toHaveTextContent('10% of the personal plan used');
  expect(screen.getByRole('textbox', { name: 'Direct to leaders' })).toBeInTheDocument();
});

it('shows an error state per panel when feeds are down, and keeps the box usable', async () => {
  stub({});
  render(<DirectPane {...props} />);
  const fleet = await screen.findByRole('region', { name: 'Fleet' });
  expect(within(fleet).getByRole('alert')).toHaveTextContent('Fleet lanes not reported right now');
  expect(screen.getByRole('region', { name: 'Nodes' })).toHaveAttribute('data-state', 'error');
  expect(screen.getByRole('textbox', { name: 'Direct to leaders' })).toBeEnabled();
});

it('shows empty states when feeds are up but quiet', async () => {
  stub({
    '/api/verse/fleet/runs': { lanes: [], mergesLastHour: { count: 0, items: [] } }, '/api/verse/fleet/agent-roster': { schema: 'agent-roster.v1', claims: { items: [] } },
    '/api/verse/ops/releases': { v: 1, generatedAt: 'x', sourceState: 'healthy', repos: [] },
    '/api/nodes': { schema: 'phantom.nodes.v1', generatedAt: 'x', sourcePath: 'x', observedAt: null, leaderId: null, nodes: [], error: null },
  });
  render(<DirectPane {...props} />);
  expect(await screen.findByRole('region', { name: 'Fleet' })).toHaveTextContent('No lanes reported');
  expect(screen.getByRole('region', { name: 'Merges' })).toHaveTextContent('No merges in the last hour');
  expect(screen.getByRole('region', { name: 'Nodes' })).toHaveTextContent('No nodes have joined');
  expect(screen.getByRole('region', { name: 'Agents' })).toHaveTextContent('No active claims');
});
