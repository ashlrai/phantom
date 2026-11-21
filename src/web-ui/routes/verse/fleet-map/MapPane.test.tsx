import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { buildFleetLiveMap, messageLineWidth, type FleetLiveMap } from '../../../../core/fleet/live-map.js';
import type { NodeRow } from '../../../../core/fleet/nodes-view.js';
import { fleetOrgMap } from '../../../../core/fleet/org-map.js';
import { fleetOrgTree } from '../../../../core/fleet/org-tree.js';
import { projectFleetEdges } from '../../../../core/fleet/fleet-edges.js';
import { buildMapEdges } from '../../../../core/fleet/map-edges.js';
import { buildAgentsMessages } from '../../../../core/fleet/agents-messages.js';
import type { FleetSessionsV1 } from '../../../../core/fleet/runs-sessions.js';
import { evictAll } from '../../../data/cache.js';
import { MessagesPane } from '../fleet-messages/MessagesPane.js';
import { showMessagePair } from '../fleet-messages/messages-pair.js';
import { getPane, type PaneProps } from '../panes/pane-registry.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { DETAIL_PANE, MapPane, MapView } from './MapPane.js';
import { layoutLiveMap, narrowLiveMap, narrowMapEdges, narrowMessagePairs, NODE_W } from './map-model.js';
import './fleet-map.pane.js';

const NOW = Date.parse('2026-11-17T12:00:00Z'), AT = new Date(NOW).toISOString();
const receipt = (from: string, to: string, receivedAt: number) => ({ cursor: 1, receivedAt,
  envelope: { id: `${from}-${to}-${receivedAt}`, from, to, priority: 'P2' as const, ttl: 3_600_000, body: { text: 'fixture' } } });
const computer = (name: string, jobs: string[], isSelf = false): NodeRow => ({ name, isSelf, reachable: true, lastSeen: AT, heartbeatAgeSeconds: 2, phantom: 'running',
  freeMemoryBytes: 8e9, freeMemoryPercent: 25, load: 1, cpuHeadroomPercent: 50, lanes: ['claude'], jobsRunning: jobs, freeSlots: 1, stateCode: 'ready', state: 'ready for work', joined: true, joinCommand: null });

function fleet(): FleetLiveMap {
  const messages = { schema: 'fleet.edges.v1' as const, source: 'available' as const, edges: projectFleetEdges([
    receipt('leader', 'claude', NOW - 20_000), receipt('claude', 'RQ-A', NOW - 5 * 60_000)] as never, NOW, 15) };
  const map = fleetOrgMap(null, { now: NOW, minutes: 15, messages, sessions: { generatedAt: AT, sourceState: 'healthy', truncated: false, recent: [], sessions: [
    { job: 'RQ-A', lane: 'claude', repo: 'phantom', model: 'fixture-model', status: 'running', elapsedSeconds: 60, startedAt: '2026-11-17T11:59:00Z', live: 'yes' },
  ] } as unknown as FleetSessionsV1 });
  return buildFleetLiveMap({ now: NOW, org: { ...map, tree: fleetOrgTree(map) },
    computers: { schema: 'phantom.nodes-view.v1', schemaVersion: 1, asOf: AT, self: 'node-a', registry: 'local', reasons: [], nodes: [computer('node-a', [], true), computer('node-b', [])] } });
}

let viewport: ViewportMock | null = null;
beforeEach(() => { evictAll(); showMessagePair(null); });
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

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
  // The leader node and the Messages switch.
  expect(screen.getAllByRole('button')).toHaveLength(2);
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
  // One read each of the graph, its message edges, its message cards, its conversations and its replay frames; none repeats inside the poll interval.
  await new Promise(resolve => setTimeout(resolve, 50));
  expect((fetch.mock.calls as unknown[][]).map(call => String(call[0]).replace(/^.*\/control\//, '')).sort()).toEqual(['agent-conversations', 'agent-messages', 'live-map', 'map-edges', 'map-replay']);
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

/** The `phm map edges` fixtures (test/fleet-map-edges.test.ts), as the pane reads them: the graph and its edges from the same bus rows. */
type Said = [from: string, to: string, secondsAgo: number, text: string];
const CHAT: Said[] = [['leader', 'claude', 400, 'please look at the build'], ['claude', 'leader', 300, 'on it'], ['leader', 'claude', 20, 'thanks, next the docs']];
const JOBS = ['RQ-ONE', 'RQ-TWO', 'RQ-THREE', 'RQ-FOUR', 'RQ-FIVE'];
const FAN: Said[] = [...JOBS.map((job, i): Said => ['claude', job, 200 + i, `start ${job}`]), ['claude', 'claude-7', 90, 'spare hands']];
function scene(said: Said[], jobs: string[] = []) {
  const rows = said.map(([from, to, ago, text], i) => ({ cursor: i + 1, receivedAt: NOW - ago * 1000,
    envelope: { id: `m${i}`, from, to, priority: 'P2' as const, ttl: 3_600_000, body: { text } } }));
  const org = fleetOrgMap(null, { now: NOW, minutes: 15, messages: { schema: 'fleet.edges.v1', source: 'available', edges: projectFleetEdges(rows as never, NOW, 15) },
    sessions: { generatedAt: AT, sourceState: 'healthy', truncated: false, recent: [], sessions: jobs.map(job => (
      { job, lane: 'claude', repo: 'phantom', model: 'fixture-model', status: 'running', elapsedSeconds: 60, startedAt: '2026-11-17T11:59:00Z', live: 'yes' })) } as unknown as FleetSessionsV1 });
  return { map: narrowLiveMap(JSON.parse(JSON.stringify(buildFleetLiveMap({ now: NOW, org: { ...org, tree: fleetOrgTree(org) } }))))!,
    edges: narrowMapEdges(JSON.parse(JSON.stringify(buildMapEdges({ source: 'available', rows: rows as never }, NOW - 15 * 60_000, NOW)))) };
}
const lines = (container: HTMLElement) => [...container.querySelectorAll<SVGPathElement>('path[data-kind="messaged-in-last-15-min"]')];

describe.each([['desktop width', 1440], ['390 px', 390]])('message edges on the map at %s', (_name, width) => {
  function show(said: Said[], jobs?: string[]) {
    viewport = mockViewport(width);
    const onOpenMessages = vi.fn();
    const view = render(<MapView {...scene(said, jobs)} now={NOW} onOpen={() => {}} onOpenMessages={onOpenMessages} />);
    // A phone starts on the org list; the drawn map is one tap away.
    if (width < 480) fireEvent.click(screen.getByRole('button', { name: 'Show the full map' }));
    return { ...view, onOpenMessages, talk: screen.getByRole('region', { name: 'Messages on the map' }) };
  }

  it('no messages: no message lines and a plain empty note', () => {
    const { container, talk } = show([]);
    expect(lines(container)).toHaveLength(0);
    expect(container.querySelectorAll('[data-open-messages]')).toHaveLength(0);
    expect(talk.textContent).toBe('No messages between agents in the last 15 minutes.');
  });

  it('two agents chatting: a line each way, thicker with more messages, pulsing when new, opening the last 20 messages', () => {
    const { container, talk, onOpenMessages } = show(CHAT);
    expect(lines(container).map(path => [path.style.strokeWidth, path.getAttribute('data-pulse')])).toEqual([['1.75', null], ['2.25', 'true']]);
    const rows = within(talk).getAllByRole('button');
    expect(rows.map(row => row.textContent)).toEqual([
      'claude → Leader (CEO): 1 in 15 min · last 5 m ago: “on it”', 'Leader (CEO) → claude: 2 in 15 min · last 20 s ago: “thanks, next the docs”']);
    expect(rows.map(row => row.getAttribute('data-pulse'))).toEqual([null, 'true']);
    fireEvent.click(rows[1]!);
    fireEvent.click(container.querySelector('[data-open-messages="messaged-in-last-15-min:lane:claude->leader"]')!);
    expect(onOpenMessages.mock.calls).toEqual([[['leader', 'claude']], [['claude', 'leader']]]);
    expect(within(talk).getByText('Select a line to open its last 20 messages.')).toBeTruthy();
  });

  it('one agent fanning out to five: five lines from the lane to its jobs, grouped in org rows, with off-map agents listed', () => {
    const { container, talk, onOpenMessages } = show(FAN, JOBS);
    expect(lines(container)).toHaveLength(5);
    expect(container.querySelectorAll('[data-open-messages^="messaged-in-last-15-min:lane:claude->job:RQ-"]')).toHaveLength(5);
    const top = (name: RegExp) => parseFloat(screen.getByRole('button', { name }).style.top);
    expect(top(/^Open leader/)).toBeLessThan(top(/^Open lane claude:/));
    for (const job of JOBS) {
      expect(top(/^Open lane claude:/)).toBeLessThan(top(new RegExp(`^Open job ${job}:`)));
      expect(within(talk).getByRole('button', { name: new RegExp(`^claude → ${job}: 1 in 15 min · last .* ago: “start ${job}”$`) })).toBeTruthy();
    }
    const offMap = within(within(talk).getByRole('list', { name: 'Messages not drawn on the map' })).getByRole('button');
    expect(offMap.textContent).toBe('claude (lane) → claude-7 (worker): 1, not drawn · last 1 m ago: “spare hands”');
    fireEvent.click(offMap);
    expect(onOpenMessages).toHaveBeenLastCalledWith(['claude', 'claude-7']);
    // Narrow screens scroll the drawing sideways inside its frame; no node is cut off, and the list above needs no scrolling.
    const canvas = parseFloat(screen.getByRole('button', { name: /^Open leader/ }).parentElement!.style.width);
    for (const node of container.querySelectorAll<HTMLElement>('button[data-kind]')) expect(parseFloat(node.style.left) + NODE_W).toBeLessThanOrEqual(canvas);
  });
});

it('draws lines without last words when the edges read is unknown, and caps thickness', () => {
  expect([1, 5, 40, null].map(messageLineWidth)).toEqual([1.75, 3.75, 6, 1.75]);
  expect(narrowMapEdges({ schema: 'fleet.map-edges.v1', version: 1, source: 'unavailable', edges: null })).toBeNull();
  expect(narrowMapEdges({ schema: 'fleet.map-edges.v1', version: 1, edges: [{ from: { name: 'a' }, to: { name: 'b', role: 'pilot' }, count: 1, lastAt: AT }, { from: {} }] }))
    .toEqual([{ id: 'a->b', from: { name: 'a', role: 'unknown', lane: null, node: null }, to: { name: 'b', role: 'unknown', lane: null, node: null }, count: 1, lastAt: AT, lastSummary: 'unknown' }]);
  const onOpenMessages = vi.fn();
  const { container } = render(<MapView map={scene(CHAT).map} edges={null} now={NOW} onOpen={() => {}} onOpenMessages={onOpenMessages} />);
  expect(lines(container)).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Leader (CEO) → claude: 2 in 15 min' }));
  expect(onOpenMessages).toHaveBeenCalledWith(['leader', 'claude']);
});

it('a message line opens the Messages pane on that pair, read from the typed messages API', async () => {
  const { map, edges } = scene(CHAT);
  const pairRead = { schema: 'agent-messages.v1', source: 'available', matched: 1, skipped: 0, messages: [{ id: 'm2', ts: AT, from: { name: 'leader', lane: 'leader' },
    to: { name: 'claude', lane: 'claude' }, kind: 'status', summary: 'thanks, next the docs', conversation: 'pair:claude|leader', job: null, pr: null }] };
  const fetch = vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).includes('/map-edges') ? { schema: 'fleet.map-edges.v1', version: 1, edges }
    : String(input).includes('/agent-bus/messages') ? pairRead : map));
  vi.stubGlobal('fetch', fetch);
  const openPane = vi.fn();
  render(<MapPane visible host={{ openPane } as never} />);
  fireEvent.click(await screen.findByRole('button', { name: /^Leader \(CEO\) → claude: 2 in 15 min · last/ }));
  expect(openPane).toHaveBeenLastCalledWith('fleet-messages');
  render(<MessagesPane {...({ visible: true, host: { openPane } } as unknown as PaneProps)} />);
  expect(await screen.findByText('leader ↔ claude · last 20 messages')).toBeTruthy();
  expect(await screen.findByText('thanks, next the docs')).toBeTruthy();
  expect(fetch.mock.calls.map(call => String(call[0])).find(url => url.includes('/agent-bus/messages'))).toContain('/api/verse/agent-bus/messages?agent=leader&with=claude&limit=20');
  fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
  await waitFor(() => expect(fetch.mock.calls.map(call => String(call[0])).some(url => url.endsWith('/api/verse/agent-bus/messages?limit=200'))).toBe(true));
  expect(screen.queryByText('leader ↔ claude · last 20 messages')).toBeNull();
});


/** `phm agents messages` (test/agents-messages.test.ts) as the map reads it: per-line counts and the last 5 summaries. */
function pairsOf(said: Said[]) {
  const rows = said.map(([from, to, ago, text], i) => ({ cursor: i + 1, receivedAt: NOW - ago * 1000,
    envelope: { id: `m${i}`, from, to, priority: 'P2' as const, ttl: 3_600_000, body: { text } } }));
  return narrowMessagePairs(JSON.parse(JSON.stringify(buildAgentsMessages({ source: 'available', rows: rows as never }, { since: NOW - 3_600_000 }, NOW))));
}

describe('message cards, the Messages switch and reduced motion', () => {
  const SIX: Said[] = [...CHAT, ...[1, 2, 3, 4].map((n): Said => ['leader', 'claude', 100 - n, `note ${n}`])];

  it('hovering a line shows its count and last 5 summaries; an unknown read says so', () => {
    const { container } = render(<MapView {...scene(SIX)} pairs={pairsOf(SIX)} now={NOW} onOpen={() => {}} />);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseEnter(container.querySelector('[data-open-messages="messaged-in-last-15-min:leader->lane:claude"]')!);
    const card = screen.getByRole('tooltip', { name: 'Last messages Leader (CEO) → claude' });
    expect(card.querySelector('strong')!.textContent).toBe('Leader (CEO) → claude: 6 messages');
    expect(within(card).getAllByRole('listitem').map(li => li.textContent)).toEqual([
      '20 s ago · status: thanks, next the docs', '1 m ago · status: note 4', '1 m ago · status: note 3', '1 m ago · status: note 2', '1 m ago · status: note 1']);
    fireEvent.mouseLeave(container.querySelector('[data-open-messages="messaged-in-last-15-min:leader->lane:claude"]')!);
    expect(screen.queryByRole('tooltip')).toBeNull();
    cleanup();
    render(<MapView {...scene(CHAT)} pairs={null} now={NOW} onOpen={() => {}} />);
    fireEvent.focus(screen.getByRole('button', { name: /^claude → Leader \(CEO\): 1 in 15 min/ }));
    expect(screen.getByRole('tooltip').textContent).toBe('claude → Leader (CEO): 1 messageLast messages unknown.');
  });

  it('the Messages switch is on by default and hides every message line and list when off', () => {
    const { container } = render(<MapView {...scene(CHAT)} now={NOW} onOpen={() => {}} />);
    const toggle = screen.getByRole('button', { name: 'Messages' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(lines(container)).toHaveLength(2);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(lines(container)).toHaveLength(0);
    expect(container.querySelectorAll('[data-open-messages]')).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'Messages on the map' })).toBeNull();
    expect(container.querySelectorAll('path[data-kind="reports-to"]').length).toBeGreaterThan(0);
    fireEvent.click(toggle);
    expect(lines(container)).toHaveLength(2);
  });

  it('reduced motion turns the pulse off but keeps line thickness', () => {
    const moving = render(<MapView {...scene(CHAT)} now={NOW} onOpen={() => {}} />);
    const pulses = (root: HTMLElement) => root.querySelectorAll(':is(path, button)[data-pulse="true"]').length;
    expect(pulses(moving.container)).toBe(2);
    expect(screen.getByText('message in the last minute')).toBeTruthy();
    cleanup();
    const { container } = render(<MapView {...scene(CHAT)} now={NOW} onOpen={() => {}} reducedMotion />);
    expect(pulses(container)).toBe(0);
    expect(screen.queryByText('message in the last minute')).toBeNull();
    expect(lines(container).map(path => path.style.strokeWidth)).toEqual(['1.75', '2.25']);
  });
});


describe('the 2D/3D toggle', () => {
  afterEach(() => { localStorage.clear(); });
  const map = () => narrowLiveMap(JSON.parse(JSON.stringify(fleet())))!;
  const stage = () => screen.queryByTestId('map-3d');

  it('desktop, normal fixture: one control switches to 3D with the same nodes, remembers it, and a node opens its detail pane', () => {
    viewport = mockViewport(1440);
    const onOpen = vi.fn(), onOpenMessages = vi.fn();
    const first = render(<MapView map={map()} now={NOW} onOpen={onOpen} onOpenMessages={onOpenMessages} />);
    const toggle = screen.getByRole('radiogroup', { name: 'Map view' });
    expect(within(toggle).getByRole('radio', { name: '2D' }).getAttribute('aria-checked')).toBe('true');
    const flat = screen.getAllByRole('button', { name: /^Open / }).map(b => b.getAttribute('aria-label')).sort();
    expect(stage()).toBeNull();
    fireEvent.click(within(toggle).getByRole('radio', { name: '3D' }));
    expect(stage()).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Open / }).map(b => b.getAttribute('aria-label')).sort()).toEqual(flat);
    // Every node has been placed, and the leader sits above its lanes and jobs.
    const y = (name: RegExp) => Number(/translate\([\d.-]+px, ([\d.-]+)px\)/.exec(screen.getByRole('button', { name }).style.transform)![1]);
    expect(y(/^Open leader/)).toBeLessThan(y(/^Open lane claude:/));
    expect(y(/^Open lane claude:/)).toBeLessThan(y(/^Open job RQ-A/));
    // Message lines keep their pulse and the sender's provider logo, and open the messages for that pair.
    expect(stage()!.querySelectorAll('line[data-kind="messaged-in-last-15-min"]')).toHaveLength(2);
    expect(stage()!.querySelectorAll('line[data-pulse="true"]')).toHaveLength(1);
    expect(stage()!.querySelector('[data-edge-badge] [data-provider-badge="Anthropic"]')).toBeTruthy();
    fireEvent.click(stage()!.querySelector('[data-open-messages]')!);
    expect(onOpenMessages).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /^Open job RQ-A/ }));
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'job:RQ-A' }));
    // Remembered: a fresh map opens in 3D.
    first.unmount();
    render(<MapView map={map()} now={NOW} onOpen={() => {}} />);
    expect(stage()).toBeTruthy();
    expect(screen.getByRole('radio', { name: '3D' }).getAttribute('aria-checked')).toBe('true');
  });

  it('3D groups by org: a label per lane with its running count; clicking it hides the lane\'s jobs and counts them; nodes still open', () => {
    viewport = mockViewport(1440);
    localStorage.setItem('phantom.fleet-map.view', '3d');
    const onOpen = vi.fn();
    render(<MapView map={map()} now={NOW} onOpen={onOpen} />);
    const labels = () => [...stage()!.querySelectorAll<HTMLElement>('[data-label]')];
    const claude = () => stage()!.querySelector<HTMLElement>('[data-label="lane:claude"]')!;
    expect(claude().textContent).toMatch(/^claude: \d+ running/);
    expect(labels().length).toBeGreaterThan(0);
    expect(claude().style.transform).toMatch(/translate\(/);
    const jobs = () => screen.queryAllByRole('button', { name: /^Open job RQ-A/ }).length;
    expect(jobs()).toBe(1);
    fireEvent.click(claude());
    expect(claude().getAttribute('aria-expanded')).toBe('false');
    expect(claude().textContent).toMatch(/, \d+ hidden$/);
    expect(jobs()).toBe(0);
    fireEvent.click(claude());
    expect(jobs()).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: /^Open lane claude:/ }));
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'lane:claude' }));
  });

  it('desktop, empty fixture: 3D shows the empty note and only the leader', () => {
    viewport = mockViewport(1440);
    localStorage.setItem('phantom.fleet-map.view', '3d');
    render(<MapView map={narrowLiveMap(JSON.parse(JSON.stringify(buildFleetLiveMap({ now: NOW }))))!} now={NOW} onOpen={() => {}} />);
    expect(stage()).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Nothing to map yet: no lanes, jobs or computers reported.');
    expect(within(stage()!).getAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual([expect.stringMatching(/^Open leader/)]);
  });

  it('turns slowly, stops while hovered or focused, and never turns under reduced motion', () => {
    viewport = mockViewport(1440);
    localStorage.setItem('phantom.fleet-map.view', '3d');
    const view = render(<MapView map={map()} now={NOW} onOpen={() => {}} />);
    expect(stage()!.getAttribute('data-rotate')).toBe('on');
    fireEvent.pointerEnter(stage()!);
    expect(stage()!.getAttribute('data-rotate')).toBe('paused');
    fireEvent.pointerLeave(stage()!);
    expect(stage()!.getAttribute('data-rotate')).toBe('on');
    fireEvent.focus(screen.getByRole('button', { name: /^Open leader/ }));
    expect(stage()!.getAttribute('data-rotate')).toBe('paused');
    view.unmount();
    viewport.restore();
    viewport = mockViewport(1440, { reducedMotion: true });
    render(<MapView map={map()} now={NOW} onOpen={() => {}} />);
    expect(stage()!.getAttribute('data-rotate')).toBe('off');
    fireEvent.pointerLeave(stage()!);
    expect(stage()!.getAttribute('data-rotate')).toBe('off');
  });

  it('at 390 px: no toggle, and the 2D rows even when 3D was chosen', () => {
    viewport = mockViewport(390);
    localStorage.setItem('phantom.fleet-map.view', '3d');
    render(<MapView map={map()} now={NOW} onOpen={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show the full map' }));
    expect(screen.queryByRole('radiogroup', { name: 'Map view' })).toBeNull();
    expect(stage()).toBeNull();
    expect(screen.getByRole('button', { name: /^Open lane claude:/ }).style.top).not.toBe('');

  });
});


it('3D preserves message cards, the Messages switch and reduced-motion pulse suppression', () => {
  viewport = mockViewport(1440);
  localStorage.setItem('phantom.fleet-map.view', '3d');
  const { container } = render(<MapView {...scene(CHAT)} pairs={pairsOf(CHAT)} now={NOW} onOpen={() => {}} reducedMotion />);
  const stage = screen.getByTestId('map-3d');
  expect(stage.getAttribute('data-rotate')).toBe('off');
  expect(container.querySelectorAll('[data-pulse="true"]')).toHaveLength(0);
  fireEvent.mouseEnter(stage.querySelector('[data-open-messages="messaged-in-last-15-min:leader->lane:claude"]')!);
  expect(screen.getByRole('tooltip').textContent).toContain('thanks, next the docs');
  fireEvent.click(screen.getByRole('button', { name: 'Messages' }));
  expect(container.querySelectorAll('[data-open-messages]')).toHaveLength(0);
  expect(screen.queryByRole('tooltip')).toBeNull();
  expect(stage.querySelectorAll('line[data-kind="reports-to"]').length).toBeGreaterThan(0);
  localStorage.clear();
});

describe('filter bar', () => {
  /** RQ-A (claude, phantom, running) plus RQ-Z (zai, docs, done). */
  const view = () => {
    const raw = JSON.parse(JSON.stringify(fleet())) as FleetLiveMap;
    raw.nodes.push({ id: 'job:RQ-Z', kind: 'job', level: 2, label: 'RQ-Z', provider: 'unknown', status: 'running', detail: 'fixture-model · docs', live: null, lane: 'zai', repo: 'docs', state: 'done' });
    return narrowLiveMap(raw)!;
  };
  const choose = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
  afterEach(() => sessionStorage.clear());

  it('narrows the desktop map, says so when nothing matches, and Clear restores everything', () => {
    viewport = mockViewport(1440);
    render(<MapView map={view()} now={NOW} onOpen={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    choose('Lane', 'claude');
    expect(screen.getByRole('button', { name: /^Open job RQ-A/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Open computer node-b/ })).toBeNull();
    choose('State', 'running');
    choose('Repo', 'phantom');
    expect(screen.getByRole('button', { name: /^Open job RQ-A/ })).toBeTruthy();
    choose('State', 'done');
    expect(screen.getByRole('status').textContent).toBe('No agents match these filters.');
    expect(screen.queryByRole('button', { name: /^Open job/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByRole('button', { name: /^Open computer node-b/ })).toBeTruthy();
    expect((screen.getByLabelText('Lane') as HTMLSelectElement).value).toBe('');
    expect(sessionStorage.getItem('phantom.fleet-map.filter')).toBe('{}');
  });

  it('keeps the choice for the session across a remount', () => {
    viewport = mockViewport(1440);
    const first = render(<MapView map={view()} now={NOW} onOpen={() => {}} />);
    choose('State', 'running');
    first.unmount();
    render(<MapView map={view()} now={NOW} onOpen={() => {}} />);
    expect((screen.getByLabelText('State') as HTMLSelectElement).value).toBe('running');
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
  });

  it('uses the same filter on the phone list', () => {
    viewport = mockViewport(390);
    render(<MapView map={view()} now={NOW} onOpen={() => {}} />);
    expect(screen.getByRole('group', { name: 'Filter the map' })).toBeTruthy();
    choose('Lane', 'claude');
    expect(screen.getByTestId('org-headline')).toBeTruthy();
    choose('State', 'done');
    expect(screen.getByRole('status').textContent).toBe('No agents match these filters.');
    expect(screen.queryByTestId('org-headline')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByTestId('org-headline')).toBeTruthy();
  });

  it('reads a stored filter with a bad state as none', () => {
    sessionStorage.setItem('phantom.fleet-map.filter', '{"state":"asleep","lane":"claude"}');
    viewport = mockViewport(1440);
    render(<MapView map={view()} now={NOW} onOpen={() => {}} />);
    expect((screen.getByLabelText('State') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('Lane') as HTMLSelectElement).value).toBe('claude');
  });
});
