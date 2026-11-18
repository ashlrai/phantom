import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildFleetLiveMap, type FleetLiveMap } from '../../../../core/fleet/live-map.js';
import type { NodeRow } from '../../../../core/fleet/nodes-view.js';
import { fleetOrgMap } from '../../../../core/fleet/org-map.js';
import { fleetOrgTree } from '../../../../core/fleet/org-tree.js';
import { projectFleetEdges } from '../../../../core/fleet/fleet-edges.js';
import type { FleetSessionsV1 } from '../../../../core/fleet/runs-sessions.js';
import { evictAll } from '../../../data/cache.js';
import { getPane } from '../panes/pane-registry.js';
import { DETAIL_PANE, MapPane, MapView } from './MapPane.js';
import { layoutLiveMap, narrowLiveMap } from './map-model.js';
import './fleet-map.pane.js';

const NOW = Date.parse('2026-11-17T12:00:00Z'), AT = new Date(NOW).toISOString();
const receipt = (from: string, to: string, receivedAt: number) => ({ cursor: 1, receivedAt,
  envelope: { id: `${from}-${to}-${receivedAt}`, from, to, priority: 'P2' as const, ttl: 3_600_000, body: { text: 'fixture' } } });
const computer = (name: string, jobs: string[], isSelf = false): NodeRow => ({ name, isSelf, reachable: true, lastSeen: AT, phantom: 'running',
  freeMemoryBytes: 8e9, cpuHeadroomPercent: 50, lanes: ['claude'], jobsRunning: jobs, freeSlots: 1, stateCode: 'ready', state: 'ready for work' });

function fleet(): FleetLiveMap {
  const messages = { schema: 'fleet.edges.v1' as const, source: 'available' as const, edges: projectFleetEdges([
    receipt('leader', 'claude', NOW - 20_000), receipt('claude', 'RQ-A', NOW - 5 * 60_000)] as never, NOW, 15) };
  const map = fleetOrgMap(null, { now: NOW, minutes: 15, messages, sessions: { generatedAt: AT, sourceState: 'healthy', truncated: false, recent: [], sessions: [
    { job: 'RQ-A', lane: 'claude', repo: 'phantom', model: 'fixture-model', status: 'running', elapsedSeconds: 60, startedAt: '2026-11-17T11:59:00Z', live: 'yes' },
  ] } as unknown as FleetSessionsV1 });
  return buildFleetLiveMap({ now: NOW, org: { ...map, tree: fleetOrgTree(map) },
    computers: { schemaVersion: 1, asOf: AT, self: 'node-a', registry: 'local', reasons: [], nodes: [computer('node-a', [], true), computer('node-b', [])] } });
}

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('registers a session-independent Map pane', () => {
  expect(getPane('fleet-map')).toMatchObject({ id: 'fleet-map', title: 'Map', needsSession: false });
});

it('draws every node in rows by org level with provider logos on lanes, and pulses only last-minute message lines', () => {
  const map = narrowLiveMap(JSON.parse(JSON.stringify(fleet())))!;
  const { container } = render(<MapView map={map} now={NOW} onOpen={() => {}} />);
  expect(screen.getByText('1 job · 2 computers · 2 messages in 15 minutes')).toBeTruthy();
  const lane = screen.getByRole('button', { name: /^Open lane claude:/ });
  expect(lane.querySelector('[data-provider-badge="Anthropic"]')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Open job RQ-A: fixture-model · phantom' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Open computer node-b: ready for work' })).toBeTruthy();
  const top = (name: RegExp) => parseFloat((screen.getByRole('button', { name }) as HTMLElement).style.top);
  expect(top(/^Open leader/)).toBeLessThan(top(/^Open lane claude:/));
  expect(top(/^Open lane claude:/)).toBeLessThan(top(/^Open job RQ-A/));
  expect(top(/^Open job RQ-A/)).toBeLessThan(top(/^Open computer node-a/));
  const paths = container.querySelectorAll('path[data-kind="messaged-in-last-15-min"]');
  expect(paths).toHaveLength(2);
  expect(container.querySelectorAll('path[data-pulse="true"]')).toHaveLength(1);
  expect(container.querySelectorAll('path[data-kind="runs-on"]')).toHaveLength(1);
  expect(screen.getByText('Leader (CEO) → claude: 1 in 15 min').getAttribute('data-pulse')).toBe('true');
  expect(screen.queryByText(/Nothing to map yet/)).toBeNull();
  // A minute later nothing pulses.
  const later = render(<MapView map={map} now={NOW + 61_000} onOpen={() => {}} />);
  expect(later.container.querySelectorAll('path[data-pulse="true"]')).toHaveLength(0);
});

it('shows the empty state with every unknown spelled out', () => {
  render(<MapView map={narrowLiveMap(JSON.parse(JSON.stringify(buildFleetLiveMap({ now: NOW }))))!} now={NOW} onOpen={() => {}} />);
  expect(screen.getByRole('status').textContent).toBe('Nothing to map yet: no lanes, jobs or computers reported.');
  expect(screen.getByText('jobs unknown · computers unknown · messages unknown')).toBeTruthy();
  expect(screen.getByText('Messages unknown.')).toBeTruthy();
  expect(screen.getByRole('list', { name: 'Unknown' }).textContent).toContain('Computers unknown');
  expect(screen.getAllByRole('button')).toHaveLength(1);
});

it('opens the existing detail pane for the node clicked and polls at most every 5 seconds', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(fleet()), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  const openPane = vi.fn();
  render(<MapPane visible host={{ openPane } as never} />);
  fireEvent.click(await screen.findByRole('button', { name: /^Open job RQ-A/ }));
  expect(openPane).toHaveBeenLastCalledWith('worker-log');
  fireEvent.click(screen.getByRole('button', { name: /^Open lane claude:/ }));
  expect(openPane).toHaveBeenLastCalledWith('fleet-lanes');
  fireEvent.click(screen.getByRole('button', { name: /^Open computer node-a/ }));
  expect(openPane).toHaveBeenLastCalledWith('fleet-computers');
  fireEvent.click(screen.getByRole('button', { name: /^Open leader/ }));
  expect(openPane).toHaveBeenLastCalledWith('leader-thread');
  expect(DETAIL_PANE.resource).toBe('fleet-usage');
  expect(String((fetch.mock.calls[0] as unknown[])[0])).toContain('/api/verse/fleet/control/live-map');
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('reads an unexpected payload as unavailable, and drops edges to nodes it does not have', async () => {
  expect(narrowLiveMap({ schema: 'fleet.map.v2', nodes: [], edges: [] })).toBeNull();
  const map = narrowLiveMap({ schema: 'fleet.live-map.v1', nodes: [{ id: 'leader', kind: 'leader', label: 'Leader' }, { id: 'x', kind: 'planet' }],
    edges: [{ id: 'e', kind: 'reports-to', from: 'x', to: 'leader' }] })!;
  expect(map.nodes.map(node => [node.id, node.status, node.detail])).toEqual([['leader', 'unknown', 'unknown']]);
  expect(map.edges).toEqual([]);
  expect(layoutLiveMap(map).nodes).toHaveLength(1);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ schema: 'other' }), { status: 200, headers: { 'content-type': 'application/json' } })));
  render(<MapPane visible host={{ openPane: vi.fn() } as never} />);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Map unavailable'));
});
