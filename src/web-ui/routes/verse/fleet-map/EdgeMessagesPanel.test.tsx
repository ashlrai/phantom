import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { projectAgentMessages, type AgentMessage, type AgentMessages } from '../../../../core/fleet/agent-messages.js';
import type { FleetLiveMap } from '../../../../core/fleet/live-map.js';
import { evictAll } from '../../../data/cache.js';
import { resetWorkerLogSelection, takeRequestedWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { EdgePanel } from './EdgeMessagesPanel.js';
import { MapPane, MapView } from './MapPane.js';
import { messagePairs, narrowLiveMap, nodeOfAgent, pairMessages } from './map-model.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();
const WIDTHS: [string, number][] = [['desktop width', 1440], ['390 px', 390]];

/** A live map with the leader, three lanes and one job; `talk` rows are [from, to, messages, seconds since the newest]. */
function liveMap(talk: [string, string, number | null, number][]): FleetLiveMap {
  const node = (id: string, kind: string, label: string) => ({ id, kind, label, provider: 'unknown', status: 'running', detail: 'fixture', live: null });
  return narrowLiveMap({
    schema: 'fleet.live-map.v1', generatedAt: at(0), windowMinutes: 15, pulseSeconds: 60,
    nodes: [node('leader', 'leader', 'Leader (CEO)'), node('lane:claude', 'lane', 'claude'), node('lane:codex-local', 'lane', 'codex-local'),
      node('lane:grok', 'lane', 'grok'), node('job:RQ-A', 'job', 'RQ-A')],
    edges: [{ id: 'r1', kind: 'reports-to', from: 'lane:claude', to: 'leader' },
      ...talk.map(([from, to, messages, ago]) => ({ id: `message:${from}:${to}`, kind: 'messaged-in-last-15-min', from, to, messages, lastMessageAt: at(ago) }))],
    counts: { messages: talk.reduce((sum, row) => sum + (row[2] ?? 0), 0) }, sources: { messages: 'available' }, unmappedMessages: 0, gaps: [],
  })!;
}
const ref = (name: string) => ({ name, lane: name === 'leader' ? 'leader' : name.startsWith('RQ-') ? null : name });
const msg = (id: string, from: string, to: string, secondsAgo: number, over: Partial<AgentMessage> = {}): AgentMessage => ({
  id, ts: at(secondsAgo), from: ref(from), to: ref(to), kind: 'status', summary: `${id} text`, conversation: 'c', job: null, pr: null, ...over,
});
const page = (messages: AgentMessage[], matched = messages.length): AgentMessages => ({ schema: 'agent-messages.v1', source: messages.length ? 'available' : 'missing', messages, matched, skipped: 0 });

const fetched: string[] = [];
function stub(messages: unknown, map?: FleetLiveMap) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    if (url.includes('/api/verse/agent-bus/messages')) return messages === undefined ? new Response('{}', { status: 503 }) : Response.json(messages);
    return map && url.includes('/live-map') ? Response.json(map) : new Response('{}', { status: 404 });
  }));
}
const counts = () => screen.queryAllByRole('button', { name: /^Show .* between / });
const rows = (panel: HTMLElement) => within(panel).getAllByRole('listitem').map(item => item.textContent);

let viewport: ViewportMock | null = null;
beforeEach(() => { evictAll(); resetWorkerLogSelection(); fetched.length = 0; });
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; vi.unstubAllGlobals(); resetWorkerLogSelection(); });

const ONE_PAIR: [string, string, number | null, number][] = [['leader', 'lane:claude', 2, 20], ['lane:claude', 'leader', 1, 300]];
const MANY: [string, string, number | null, number][] = [...ONE_PAIR, ['lane:claude', 'lane:codex-local', 4, 90], ['lane:grok', 'job:RQ-A', null, 600]];
const BUS = [
  msg('m5', 'leader', 'claude', 20, { kind: 'handoff', summary: 'Take RQ-A next', job: 'RQ-A' }),
  msg('m4', 'claude', 'codex-local', 90, { kind: 'ask', summary: 'Can you review?', pr: 'ashlrai/phantom#6670' }),
  msg('m3', 'leader', 'claude', 200),
  msg('m2', 'claude', 'leader', 300, { kind: 'reply', summary: 'On it' }),
  msg('m1', 'claude-7', 'leader', 400, { summary: 'from an agent that is not on the map' }),
];

describe('message pairs on the map (pure)', () => {
  it('has no pairs when no agents exchanged messages', () => {
    expect(messagePairs(liveMap([]))).toEqual([]);
  });
  it('merges both directions of one pair into one line with one count', () => {
    expect(messagePairs(liveMap(ONE_PAIR)).map(p => [p.a, p.b, p.count, p.lastMessageAt, p.edges.length])).toEqual([['leader', 'lane:claude', 3, at(20), 2]]);
  });
  it('keeps many pairs apart, newest first, and an unknown count stays unknown', () => {
    expect(messagePairs(liveMap(MANY)).map(p => [p.key, p.count])).toEqual([['lane:claude|leader', 3], ['lane:claude|lane:codex-local', 4], ['job:RQ-A|lane:grok', null]]);
  });
  it('matches a message to a line only when both agents name exactly one node', () => {
    const map = liveMap(MANY);
    expect([ref('leader'), ref('claude'), ref('RQ-A'), ref('claude-7')].map(agent => nodeOfAgent(agent, map))).toEqual(['leader', 'lane:claude', 'job:RQ-A', null]);
    expect(pairMessages(BUS, map, { a: 'leader', b: 'lane:claude' }).map(m => m.id)).toEqual(['m5', 'm3', 'm2']);
    expect(pairMessages(BUS, map, { a: 'lane:grok', b: 'job:RQ-A' })).toEqual([]);
  });
});

describe.each(WIDTHS)('edge layer and panel at %s', (_name, width) => {
  it('draws no count and no panel when there are no messages', () => {
    viewport = mockViewport(width);
    render(<MapView map={liveMap([])} now={NOW} onOpen={() => {}} />);
    expect(counts()).toEqual([]);
    expect(screen.getByText('No messages between agents in the last 15 minutes.')).toBeTruthy();
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('puts the count on the line for one pair and lists that pair\'s messages, newest first, from the messages API', async () => {
    viewport = mockViewport(width);
    stub(page(BUS));
    const openJob = vi.fn();
    const { container } = render(<MapView map={liveMap(ONE_PAIR)} now={NOW} onOpen={() => {}} onOpenJob={openJob} />);
    expect(container.querySelectorAll('path[data-kind="messaged-in-last-15-min"]')).toHaveLength(2);
    const count = screen.getByRole('button', { name: 'Show 3 messages between Leader (CEO) and claude' });
    expect(count.textContent).toBe('3');
    expect(counts()).toHaveLength(1);
    // The count sits between its two nodes on the canvas.
    const tops = ['Open leader', 'Open lane claude'].map(name => parseFloat(screen.getByRole('button', { name: new RegExp(`^${name}`) }).style.top) + 26);
    expect(parseFloat(count.style.top)).toBeGreaterThan(Math.min(...tops) - 30);
    expect(parseFloat(count.style.top)).toBeLessThan(Math.max(...tops));
    expect(fetched).toEqual([]);

    fireEvent.click(count);
    const panel = screen.getByRole('complementary', { name: 'Messages between Leader (CEO) and claude' });
    expect(within(panel).getByRole('status').textContent).toBe('Reading messages…');
    expect(await within(panel).findByRole('heading', { name: 'Leader (CEO) ↔ claude · 3 messages' })).toBeTruthy();
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toContain('/api/verse/agent-bus/messages?since=15m');
    expect(rows(panel).map(text => /Take RQ-A next|m3 text|On it/.exec(text ?? '')?.[0])).toEqual(['Take RQ-A next', 'm3 text', 'On it']);
    expect(rows(panel)[0]).toContain('handoff');
    expect(rows(panel)[0]).toContain('leader · leader → claude · claude: Take RQ-A next · RQ-A');
    expect(panel.textContent).not.toContain('not on the map');
    expect(panel.textContent).toContain('phm messages --since 15m');
    expect(count.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(within(panel).getByRole('button', { name: /^Open job RQ-A/ }));
    expect(openJob).toHaveBeenCalledWith('RQ-A');
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('draws one count per pair for many pairs and opens each pair\'s own list, from the line or from its row', async () => {
    viewport = mockViewport(width);
    stub(page(BUS));
    render(<MapView map={liveMap(MANY)} now={NOW} onOpen={() => {}} />);
    expect(counts().map(button => [button.getAttribute('aria-label'), button.textContent])).toEqual([
      ['Show 3 messages between Leader (CEO) and claude', '3'],
      ['Show 4 messages between claude and codex-local', '4'],
      ['Show an unknown number of messages between grok and RQ-A', '?'],
    ]);
    // A count between two lanes in one row sits in the gap above the row, clear of the lane boxes.
    const laneTop = parseFloat(screen.getByRole('button', { name: /^Open lane claude:/ }).style.top);
    expect(parseFloat(counts()[1]!.style.top) + 14).toBeLessThanOrEqual(laneTop);
    // The row under the map opens the same panel: the easy target when the map scrolls sideways.
    fireEvent.click(screen.getByRole('button', { name: 'claude → codex-local: 4 in 15 min' }));
    const panel = await screen.findByRole('complementary', { name: 'Messages between claude and codex-local' });
    expect(await within(panel).findByRole('heading', { name: 'claude ↔ codex-local · 1 message' })).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'PR ashlrai/phantom#6670' }).getAttribute('href')).toBe('https://github.com/ashlrai/phantom/pull/6670');
    // Another line swaps the panel; a pair with nothing readable says so instead of showing a stale list.
    fireEvent.click(screen.getByRole('button', { name: /^Show an unknown number/ }));
    const other = screen.getByRole('complementary', { name: 'Messages between grok and RQ-A' });
    expect(screen.getAllByRole('complementary')).toHaveLength(1);
    expect(other.textContent).toContain('No messages between them in the last 15 minutes.');
  });

  it('shows a redacted message exactly as the shared redactor returned it', async () => {
    viewport = mockViewport(width);
    const secret = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
    const projected = projectAgentMessages([{ cursor: 1, receivedAt: NOW - 20_000,
      envelope: { id: 's1', from: 'leader', to: 'lane:claude', priority: 'P2', ttl: 3_600_000, body: { kind: 'note', text: `use token ${secret} for the push` } } }] as never);
    stub(page(projected));
    const { container } = render(<MapView map={liveMap(ONE_PAIR)} now={NOW} onOpen={() => {}} />);
    fireEvent.click(counts()[0]!);
    const panel = screen.getByRole('complementary');
    expect(await within(panel).findByText(/use token .*REDACTED.* for the push/i)).toBeTruthy();
    expect(container.innerHTML).not.toContain(secret);
  });

  it('says unknown, never empty, when the messages read fails or is not the expected shape', async () => {
    viewport = mockViewport(width);
    stub(undefined);
    const first = render(<MapView map={liveMap(ONE_PAIR)} now={NOW} onOpen={() => {}} />);
    fireEvent.click(counts()[0]!);
    expect(await screen.findByText('Messages unknown: the agent bus could not be read.')).toBeTruthy();
    expect(screen.queryByText(/No messages between them/)).toBeNull();
    first.unmount(); evictAll();
    stub({ schema: 'agent-messages.v2', messages: [] });
    render(<MapView map={liveMap(ONE_PAIR)} now={NOW} onOpen={() => {}} />);
    fireEvent.click(counts()[0]!);
    expect(await screen.findByText('Messages unknown: the agent bus could not be read.')).toBeTruthy();
  });

  it('renders the panel alone in each state', () => {
    viewport = mockViewport(width);
    const props = { a: 'claude', b: 'grok', minutes: 15, onClose: () => {}, onOpenJob: () => {} };
    const loading = render(<EdgePanel {...props} read={{ state: 'loading' }} />);
    expect(screen.getByRole('heading', { name: 'claude ↔ grok' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBe(document.activeElement);
    loading.unmount();
    render(<EdgePanel {...props} read={{ state: 'ready', messages: [msg('p1', 'claude', 'grok', 5)], more: 2 }} />);
    expect(screen.getByRole('heading', { name: 'claude ↔ grok · 1 message' })).toBeTruthy();
    expect(screen.getByText('2 older messages in the window not read; some may belong here.')).toBeTruthy();
  });
});

it('opens the job log from the panel in the real pane and reads messages only once a line is opened', async () => {
  stub(page(BUS), liveMap(ONE_PAIR));
  const openPane = vi.fn();
  render(<MapPane visible host={{ openPane } as never} />);
  fireEvent.click(await screen.findByRole('button', { name: /^Show 3 messages/ }));
  expect(fetched.filter(url => url.includes('agent-bus/messages'))).toHaveLength(1);
  fireEvent.click(await screen.findByRole('button', { name: /^Open job RQ-A: Take RQ-A next/ }));
  expect(openPane).toHaveBeenLastCalledWith('worker-log');
  expect(takeRequestedWorkerLogJob()).toBe('RQ-A');
});
