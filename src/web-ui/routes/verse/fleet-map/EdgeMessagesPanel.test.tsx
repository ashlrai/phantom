// Recut of #6812: master's existing Messages pane owns the selected pair.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { AgentMessage, AgentMessages } from '../fleet-messages/messages-model.js';
import type { FleetLiveMap } from '../../../../core/fleet/live-map.js';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import { resetWorkerLogSelection, takeRequestedWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { MessagesPane } from '../fleet-messages/MessagesPane.js';
import { showMessagePair } from '../fleet-messages/messages-pair.js';
import { pairMessagesQuery } from '../fleet-messages/messages-query.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { MapPane, MapView } from './MapPane.js';
import { messagePairs, narrowLiveMap } from './map-model.js';

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
  id, ts: at(secondsAgo), priority: 'P2', from: ref(from), to: ref(to), kind: 'status', summary: `${id} text`, conversation: 'c', job: null, pr: null, ...over,
});
const page = (messages: AgentMessage[], matched = messages.length): AgentMessages => ({ schema: 'agent-messages.v1', source: messages.length ? 'available' : 'missing', messages, matched, skipped: 0 });

const ONE_PAIR: [string, string, number | null, number][] = [['leader', 'lane:claude', 2, 20], ['lane:claude', 'leader', 1, 300]];
const MANY: [string, string, number | null, number][] = [...ONE_PAIR, ['lane:claude', 'lane:codex-local', 4, 90], ['lane:grok', 'job:RQ-A', null, 600]];
const BUS = [
  msg('m5', 'leader', 'claude', 20, { kind: 'handoff', summary: 'Take RQ-A next', job: 'RQ-A' }),
  msg('m3', 'leader', 'claude', 200, { pr: 'ashlrai/phantom#6670' }),
  msg('m2', 'claude', 'leader', 300, { kind: 'reply', summary: 'On it' }),
];
const counts = () => screen.queryAllByRole('button', { name: /^Show .* between / });
let viewport: ViewportMock | null = null;
beforeEach(() => { evictAll(); showMessagePair(null); resetWorkerLogSelection(); });
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function stub(payload: unknown = page(BUS)) {
  const fetch = vi.fn(async () => payload === undefined ? new Response('{}', { status: 503 }) : Response.json(payload));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const host = { openPane: vi.fn() };
const props = { visible: true, host } as unknown as PaneProps;

it('merges both directions, preserves unknown totals, and omits non-message and self edges', () => {
  const map = liveMap(MANY);
  expect(messagePairs(map).map(p => p.count)).toEqual([3, 4, null]);
  expect(messagePairs(liveMap([]))).toEqual([]);
  expect(messagePairs(liveMap([['leader', 'lane:claude', 2, 20], ['lane:claude', 'leader', null, 10]]))[0]?.count).toBeNull();
  expect(messagePairs(liveMap([['leader', 'leader', 2, 20]]))).toEqual([]);
});

describe.each(WIDTHS)('message line selection at %s', (_name, width) => {
  it('draws no count without messages and shows the map observation time', () => {
    viewport = mockViewport(width);
    render(<MapView map={liveMap([])} now={NOW} onOpen={() => {}} />);
    if (width < 480) fireEvent.click(screen.getByRole('button', { name: 'Show the full map' })); // phone opens on the org list; the map is one tap away
    expect(counts()).toEqual([]);
    expect(screen.getByText('No messages between agents in the last 15 minutes.')).toBeTruthy();
    expect(screen.getByText(/Map as of/).querySelector('time')?.dateTime).toBe(at(0));
  });

  it('opens each pair through the existing pane without fetching a second map-side list', () => {
    viewport = mockViewport(width);
    const fetch = stub();
    const open = vi.fn();
    render(<MapView map={liveMap(MANY)} now={NOW} onOpen={() => {}} onOpenMessages={open} />);
    if (width < 480) fireEvent.click(screen.getByRole('button', { name: 'Show the full map' })); // phone opens on the org list; the map is one tap away
    expect(counts().map(button => button.textContent)).toEqual(['3', '4', '?']);
    const count = screen.getByRole('button', { name: 'Show 3 messages between Leader (CEO) and claude' });
    fireEvent.click(count);
    expect(open).toHaveBeenLastCalledWith(['leader', 'claude']);
    fireEvent.click(screen.getByRole('button', { name: 'claude → codex-local: 4 in 15 min' }));
    expect(open).toHaveBeenLastCalledWith(['claude', 'codex-local']);
    fireEvent.click(screen.getByRole('button', { name: /^Show an unknown number/ }));
    expect(open).toHaveBeenLastCalledWith(['grok', 'RQ-A']);
    const laneTop = parseFloat(screen.getByRole('button', { name: /^Open lane claude:/ }).style.top);
    expect(parseFloat(counts()[1]!.style.top) + 14).toBeLessThanOrEqual(laneTop);
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Messages' }));
    expect(counts()).toEqual([]);
  });

  it('keeps the last messages and their successful read time after a refresh failure, then recovers', async () => {
    viewport = mockViewport(width);
    showMessagePair(['leader', 'claude']);
    const fetch = stub();
    render(<MessagesPane {...props} />);
    expect(await screen.findByText('Take RQ-A next')).toBeTruthy();
    expect(fetch.mock.calls).toHaveLength(1);
    const observed = screen.getByText(/Messages as of/).querySelector('time')?.dateTime;
    expect(observed).toMatch(/^\d{4}-\d\d-\d\dT/);
    const query = pairMessagesQuery(['leader', 'claude']);
    fetch.mockRejectedValueOnce(new Error('fixture offline'));
    await act(async () => { await refetchQuery(query.key, () => query.fetch(), true); });
    expect(screen.getByRole('status').textContent).toContain('Refresh failed; showing the last messages, which may be stale.');
    expect(screen.getByText(/Messages as of/).querySelector('time')?.dateTime).toBe(observed);
    expect(screen.getByText('Take RQ-A next')).toBeTruthy();
    await act(async () => { await refetchQuery(query.key, () => query.fetch(), true); });
    expect(screen.queryByText(/Refresh failed/)).toBeNull();
  });
});

it('opens the selected pair and its job in the real panes, keeping PR links and bounded counts', async () => {
  const map = liveMap(ONE_PAIR);
  const fetch = vi.fn(async (input: RequestInfo | URL) => String(input).includes('/live-map') ? Response.json(map)
    : String(input).includes('/agent-bus/messages') ? Response.json(page(BUS, 5)) : Response.json({}));
  vi.stubGlobal('fetch', fetch);
  const openPane = vi.fn();
  render(<MapPane visible host={{ openPane } as never} />);
  fireEvent.click(await screen.findByRole('button', { name: /^Show 3 messages/ }));
  expect(openPane).toHaveBeenLastCalledWith('fleet-messages');
  expect(fetch.mock.calls.filter(call => String(call[0]).includes('/agent-bus/messages'))).toHaveLength(0);
  const messages = render(<MessagesPane {...props} />);
  expect(await within(messages.container).findByText('Take RQ-A next')).toBeTruthy();
  expect(fetch.mock.calls.filter(call => String(call[0]).includes('/agent-bus/messages')).map(call => String(call[0]))).toEqual([
    expect.stringContaining('?agent=leader&with=claude&limit=20'),
  ]);
  expect(screen.getByText('2 older messages not read.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'PR ashlrai/phantom#6670' }).getAttribute('href')).toBe('https://github.com/ashlrai/phantom/pull/6670');
  fireEvent.click(within(messages.container).getByRole('button', { name: 'Open job RQ-A: Take RQ-A next' }));
  expect(takeRequestedWorkerLogJob()).toBe('RQ-A');
  expect(host.openPane).toHaveBeenLastCalledWith('worker-log');
});

it.each(['network', 'malformed', 'unavailable'])('keeps %s reads unknown instead of claiming no messages', async kind => {
  const fetch = stub(kind === 'malformed' ? { schema: 'agent-messages.v2', messages: [] }
    : { ...page([]), source: 'unavailable' });
  if (kind === 'network') fetch.mockRejectedValue(new Error('fixture offline'));
  render(<MessagesPane {...props} />);
  expect(await screen.findByText('Agent messages unknown: the agent bus could not be read.')).toBeTruthy();
  expect(screen.queryByText(/No agent messages yet/)).toBeNull();
});

it('shows a known empty pair and renders scrubbed summaries as inert text', async () => {
  showMessagePair(['leader', 'claude']);
  stub(page([]));
  const first = render(<MessagesPane {...props} />);
  expect(await screen.findByText('No messages between leader and claude.')).toBeTruthy();
  first.unmount(); evictAll();
  stub(page([msg('safe', 'leader', 'claude', 5, { summary: '<script>fixture</script> [REDACTED]' })]));
  const second = render(<MessagesPane {...props} />);
  expect(await screen.findByText('<script>fixture</script> [REDACTED]', { exact: false })).toBeTruthy();
  expect(second.container.querySelector('script')).toBeNull();
});
