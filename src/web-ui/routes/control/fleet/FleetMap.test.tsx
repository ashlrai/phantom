import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { FleetCompute } from '../../../../core/fleet/compute-view.js';
import type { FleetMessageGraph } from '../../../../core/fleet/message-graph.js';
import type { FleetSessionMap, MapSession } from '../../../../core/fleet/sessions-view.js';
import { evictAll } from '../../../data/cache.js';
import { FleetMap } from './FleetMap.js';
import { cpuPercent } from './fleet-map-model.js';
import type { MapMessage } from '../../../../core/fleet/map-messages.js';
import { isFleetMessageGraph } from './fleet-map-queries.js';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const iso = new Date(NOW).toISOString();
const GIB = 1024 ** 3;
function compute(): FleetCompute {
  return { schema: 'fleet.compute.v1', generatedAt: iso, localNodeId: 'mini', truncated: false,
    sources: { local: 'loaded', registry: 'loaded' }, dispatcherAt: iso, lanes: {}, nodes: [{
      id: 'mini', local: true, owners: ['team'], heartbeatAt: NOW, state: 'ready', slots: 4, ramSlots: 8,
      jobs: [{ job: 'RQ-MAP', owner: 'team' }], pressure: null, memguardPaused: null,
      stats: { sampledAtMs: NOW, uptimeSeconds: 500, load: [1, 2, 3], ramTotal: 16 * GIB, ramUsed: 8 * GIB,
        diskFree: 64 * GIB, cores: [{ total: 1000, idle: 500 }] },
    }] };
}
function session(extra: Partial<MapSession> = {}): MapSession {
  return { job: 'RQ-MAP', lane: 'codex', model: 'test-model', elapsedSeconds: 65, status: 'running',
    nodeId: 'mini', placement: 'claim', mapState: 'running', branch: 'map-ui', worktree: 'recorded',
    activity: 'Testing the fleet map', prUrl: 'https://github.com/ashlrai/phantom/pull/42', outcome: null,
    detailSources: null, ...extra };
}
function sessions(rows = [session()]): FleetSessionMap {
  return { schema: 'fleet.sessions.v1', generatedAt: iso, computeAt: iso, localNodeId: '@local:fixture', runsDirPresent: true,
    sourceState: 'healthy', sources: { runDir: 'healthy', ready: 'healthy', claimed: 'healthy', precheck: 'healthy', status: 'healthy', metrics: 'healthy', live: 'healthy' },
    dispatcher: null, sessions: [], recent: [], mapSessions: rows, mapRecent: [], malformed: 0, truncated: false,
    counts: { queued: 0, parked: 0, launching: 0, running: rows.length, publishing: 0, exited: 0, stale: 0 } };
}
function graph(groups: NonNullable<FleetMessageGraph['groups']> | null = []): FleetMessageGraph {
  return { schema: 'fleet.message-graph.v1', version: 1, generatedAt: iso, since: new Date(NOW - 900_000).toISOString(), source: groups ? 'available' : 'unavailable',
    organizations: groups && [], groups, messages: groups && groups.reduce((sum, group) => sum + group.count, 0), skipped: 0 };
}
let live: MapMessage[] = [];
let machine: FleetCompute, inventory: FleetSessionMap, talk: FleetMessageGraph, failCompute: boolean, failSessions: boolean, plan: unknown;
const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
  if (url === '/api/verse/fleet/control/compute') return Response.json(failCompute ? { error: 'offline' } : machine, { status: failCompute ? 503 : 200 });
  if (url === '/api/verse/fleet/control/sessions') return Response.json(failSessions ? { error: 'offline' } : inventory, { status: failSessions ? 503 : 200 });
  if (url === '/api/fleet/message-graph') return Response.json(talk, { status: talk.groups ? 200 : 503 });
  if (url === '/api/fleet/map/messages') return Response.json({ schema: 'fleet.map-messages.v1', version: 1, generatedAt: iso, since: iso, source: 'available', messages: live, matched: live.length, skipped: 0 });
  if (url === '/api/verse/fleet/runtime-identity/nodes-plan') return Response.json(plan, { status: plan ? 200 : 503 });
  throw new Error(`Unexpected read: ${url}`);
});
/** Reads of the live maps; the slow-moving plan badges are counted on their own. */
const reads = () => fetcher.mock.calls.filter(([url]) => !url.includes('nodes-plan') && !url.includes('map/messages')).length;
async function mount(path = '/control/fleet') {
  await act(async () => { render(<MemoryRouter initialEntries={[path]}><FleetMap /></MemoryRouter>); });
}
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(4000); });
beforeEach(() => {
  evictAll(); vi.useFakeTimers(); vi.setSystemTime(NOW);
  live = []; machine = compute(); inventory = sessions(); talk = graph(); failCompute = false; failSessions = false; plan = null;
  fetcher.mockClear(); vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { cleanup(); evictAll(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('rejects incompatible successful responses without crashing or replacing retained observations', async () => {
  await mount();
  machine = {} as FleetCompute;
  inventory = { schema: 'fleet.sessions.v1', sessions: [] } as unknown as FleetSessionMap;
  await tick();
  expect(screen.getByText('Compute unavailable · showing last reading.')).toBeInTheDocument();
  expect(screen.getByText('Sessions unavailable · showing last reading.')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Machine mini' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Inspect session RQ-MAP' })).toBeInTheDocument();
});

describe('FleetMap', () => {
  it('draws live message edges, shows a summary on click, and hides them with the toggle', async () => {
    live = [{ id: 'm1', from: 'claude', to: 'codex', fromNode: 'lane:claude', toNode: 'lane:codex', kind: 'ask', summary: 'can you review the docs', at: new Date(NOW - 2000).toISOString() }];
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'claude to codex, ask' }));
    expect(screen.getByRole('status')).toHaveTextContent('can you review the docs');
    const toggle = screen.getByRole('checkbox', { name: 'Show messages' });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(screen.queryByRole('button', { name: 'claude to codex, ask' })).not.toBeInTheDocument();
    const reads = () => fetcher.mock.calls.filter(([url]) => url === '/api/fleet/map/messages').length, before = reads();
    await tick();
    expect(reads()).toBe(before);
  });

  it('renders real node telemetry, capacity heat and placed session tokens', async () => {
    await mount();
    const zone = within(screen.getByRole('region', { name: 'Machine mini' }));
    expect(zone.getByText('8 GiB / 16 GiB')).toBeInTheDocument();
    expect(zone.getByText('64 GiB')).toBeInTheDocument();
    expect(zone.getByText('1 / 2 / 3')).toBeInTheDocument();
    expect(zone.getByText('1 / 4')).toBeInTheDocument();
    expect(zone.getByRole('meter')).toHaveAttribute('aria-valuenow', '25');
    expect(zone.getByRole('button', { name: 'Inspect session RQ-MAP' })).toHaveTextContent('codex · test-model');
    expect(zone.getByText('CPU').nextElementSibling).toHaveTextContent('unknown');
    expect(screen.getByText(/Compute updated 0s ago/)).toBeInTheDocument();
    expect(document.querySelector('svg line, svg path[data-session]')).toBeNull();
  });

  it('renders missing telemetry and capacity as unknown without a gauge', async () => {
    Object.assign(machine.nodes[0]!, { stats: null, slots: null, ramSlots: null, state: 'unknown', heartbeatAt: null });
    inventory = sessions([session({ nodeId: null, placement: 'unknown', lane: null, model: null, elapsedSeconds: null })]);
    await mount();
    expect(screen.getByText('RAM used / total').nextElementSibling).toHaveTextContent('unknown / unknown');
    expect(screen.getByText('Claimed / measured slots').nextElementSibling).toHaveTextContent('unknown / unknown');
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Machine mini' })).toHaveAttribute('data-capacity', 'unknown');
    expect(within(screen.getByRole('region', { name: 'Unplaced sessions' })).getByRole('button')).toHaveTextContent('elapsed unknown');
  });

  it('opens live session details and PR/job links, closes with Escape and restores focus', async () => {
    await mount();
    const token = screen.getByRole('button', { name: 'Inspect session RQ-MAP' }); token.focus(); fireEvent.click(token);
    const detail = within(screen.getByRole('dialog', { name: 'RQ-MAP' }));
    expect(detail.getByText('Testing the fleet map')).toBeInTheDocument();
    expect(detail.getByText('map-ui')).toBeInTheDocument();
    expect(detail.getByText('Owned files').nextElementSibling).toHaveTextContent('unknown');
    expect(detail.getByRole('link', { name: 'Open PR' })).toHaveAttribute('href', session().prUrl);
    expect(detail.getByRole('link', { name: 'Job permalink' })).toHaveAttribute('href', '/control/fleet?mapSession=RQ-MAP');
    inventory = sessions([session({ activity: 'Reviewing results' })]); await tick();
    expect(within(screen.getByRole('dialog')).getByText('Reviewing results')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(token).toHaveFocus();
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });

  it('supports deep links, missing selections and safe PR links', async () => {
    inventory = sessions([session({ prUrl: 'javascript:alert(1)' })]);
    await mount('/control/fleet?mapSession=RQ-MAP');
    expect(screen.getByRole('dialog')).toBeInTheDocument(); expect(screen.queryByText('Open PR')).not.toBeInTheDocument();
    inventory = sessions([]); await tick();
    expect(screen.getByText('This selection is no longer in the current snapshot.')).toBeInTheDocument();
  });

  it('shows a plan badge per machine: online dot and suggested slots, unknown kept unknown', async () => {
    plan = { schema: 'phantom.nodes-plan.v1', as_of: iso, assignable: [], reasons: [],
      nodes: [{ name: 'Mini', online: true, suggested_slots: 2, why: 'ready for work; room for 2 more jobs' }, { name: 'other', online: false, suggested_slots: 0, why: 'offline' }] };
    await mount();
    expect(screen.getByLabelText('Plan: online, 2 suggested slots')).toHaveTextContent('2 slots');
    plan = { schema: 'phantom.nodes-plan.v1', nodes: [{ name: 'mini', online: 'unknown', suggested_slots: 'unknown', why: '' }] };
    cleanup(); evictAll(); await mount();
    expect(screen.getByLabelText('Plan: online unknown, slots unknown')).toHaveTextContent('? slots');
  });

  it('shows no badge when the plan is unavailable', async () => {
    await mount();
    expect(screen.queryByLabelText(/^Plan:/)).not.toBeInTheDocument();
  });

  it('opens machine details without fleet mutations', async () => {
    await mount(); fireEvent.click(screen.getByRole('button', { name: 'mini' }));
    expect(within(screen.getByRole('dialog', { name: 'mini' })).getByText('team')).toBeInTheDocument();
    expect(reads()).toBe(3);
  });

  it('keeps conflicting or absent nodes unplaced and includes recently finished sessions', async () => {
    inventory = sessions([session({ nodeId: 'missing' }), session({ job: 'conflict', placement: 'conflict' })]);
    inventory.mapRecent = [session({ job: 'done', status: 'finished', nodeId: null })];
    await mount();
    expect(within(screen.getByRole('region', { name: 'Unplaced sessions' })).getAllByRole('button')).toHaveLength(2);
    fireEvent.click(screen.getByText('Recently finished · 1'));
    expect(screen.getByRole('button', { name: 'Inspect session done' })).toBeInTheDocument();
  });

  it('shows an honest empty fleet and incomplete inventory notices', async () => {
    machine.nodes = []; inventory = sessions([]); inventory.sourceState = 'missing'; inventory.truncated = true;
    await mount();
    expect(screen.getByText('No machines observed.')).toBeInTheDocument();
    expect(screen.getByText(/No active sessions observed · session inventory incomplete/)).toBeInTheDocument();
    expect(screen.getByText(/Partial fleet/)).toBeInTheDocument();
  });

  it('does not treat unavailable endpoints as an empty fleet', async () => {
    failCompute = true; failSessions = true; await mount();
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(screen.queryByText('No machines observed.')).not.toBeInTheDocument();
    expect(screen.queryByText(/No active sessions/)).not.toBeInTheDocument();
  });

  it('derives CPU from fresh deltas and retains a percentage for an unchanged remote sample', async () => {
    await mount();
    machine.nodes[0]!.stats = { ...machine.nodes[0]!.stats!, sampledAtMs: NOW + 4000, uptimeSeconds: 504, cores: [{ total: 1100, idle: 525 }] };
    await tick(); expect(screen.getByText('75%')).toBeInTheDocument();
    await tick(); expect(screen.getByText('75%')).toBeInTheDocument();
    failCompute = true; failSessions = true; await tick();
    expect(screen.getByText('Compute unavailable · showing last reading.')).toBeInTheDocument();
    expect(screen.getByText(/Compute updated 12s ago/)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(88_000); });
    expect(screen.queryByText('75%')).not.toBeInTheDocument(); expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.getByText('RAM used / total').nextElementSibling).toHaveTextContent('unknown / unknown');
  });

  it('preserves zero capacity without division by zero and reports over-capacity claims', async () => {
    machine.nodes[0]!.slots = 0; await mount();
    expect(screen.getByText('1 / 0')).toBeInTheDocument(); expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Machine mini' })).toHaveAttribute('data-capacity', 'measured');
    machine.nodes[0]!.slots = 1; machine.nodes[0]!.jobs.push({ job: 'second', owner: null }); await tick();
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '200');
  });

  it('lists agent messages as lines between organizations: none, one, many and unknown', async () => {
    await mount();
    const zone = () => within(screen.getByRole('region', { name: 'Agent messages' }));
    expect(zone().getByRole('heading')).toHaveTextContent('Messages · 0 messages since 15m ago');
    expect(zone().getByText('No agent messages in this window.')).toBeInTheDocument();
    const at = new Date(NOW - 30_000).toISOString(), edge = (from: string, to: string, count: number) => ({ id: `${from}->${to}`, from, to, count, lastAt: at });
    talk = graph([{ id: 'Anthropic->OpenAI', from: 'Anthropic', to: 'OpenAI', count: 1, lastAt: at, edges: [edge('claude', 'codex', 1)] }]); await tick();
    expect(zone().getByRole('heading')).toHaveTextContent('Messages · 1 message since 15m ago');
    expect(zone().getByText('Anthropic → OpenAI').parentElement).toHaveTextContent('Anthropic → OpenAI · 1 message · last 34s ago');
    expect(zone().getByText('claude → codex · 1')).toBeInTheDocument();
    talk = graph([{ id: 'Anthropic->OpenAI', from: 'Anthropic', to: 'OpenAI', count: 5, lastAt: at, edges: [edge('claude', 'codex', 3), edge('claude-7', 'codex', 2)] },
      { id: 'unknown->Anthropic', from: 'unknown', to: 'Anthropic', count: 2, lastAt: at, edges: [edge('leader', 'claude', 2)] }]); await tick();
    expect(zone().getByRole('heading')).toHaveTextContent('Messages · 7 messages');
    expect(zone().getAllByText(/→ codex · \d/).map(row => row.textContent)).toEqual(['claude → codex · 3', 'claude-7 → codex · 2']);
    expect(zone().getByText('leader → claude · 2')).toBeInTheDocument();
    // An unreadable bus keeps the last reading and says so; a malformed graph is refused the same way.
    talk = graph(null); await tick();
    expect(screen.getByText('Messages unavailable · showing last reading.')).toBeInTheDocument();
    expect(zone().getByText('leader → claude · 2')).toBeInTheDocument();
    expect(isFleetMessageGraph({ ...graph(), groups: [{ id: 'a->b', from: 'a', to: 'b', count: 1, lastAt: at, edges: [{ id: 'x' }] }] })).toBe(false);
  });

  it('pauses polling while hidden, refreshes on return and cleans up on unmount', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('hidden'); await mount(); expect(reads()).toBe(0);
    visibility.mockReturnValue('visible'); await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(reads()).toBe(3); await tick(); expect(reads()).toBe(6);
    visibility.mockReturnValue('hidden'); fireEvent(document, new Event('visibilitychange'));
    await tick(); expect(reads()).toBe(6);
    expect(screen.getByRole('button', { name: 'Inspect session RQ-MAP' })).toBeInTheDocument();
    visibility.mockReturnValue('visible'); await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(reads()).toBe(9); cleanup(); await tick(); expect(reads()).toBe(9);
  });
});

it('rejects reset, mismatched, stale and invalid CPU counters', () => {
  const first = compute().nodes[0]!.stats!;
  const next = { ...first, sampledAtMs: NOW + 4000, uptimeSeconds: 504, cores: [{ total: 1100, idle: 600 }] };
  expect(cpuPercent(first, next)).toBe(0);
  for (const invalid of [first, { ...next, uptimeSeconds: 1 }, { ...next, sampledAtMs: NOW + 100_000 }, { ...next, cores: [] },
    { ...next, cores: [{ total: 900, idle: 500 }] }, { ...next, cores: [{ total: 1100, idle: 700 }] }]) {
    expect(cpuPercent(first, invalid)).toBeNull();
  }
});
