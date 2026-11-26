import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import type { FleetCompute } from '../../../../core/fleet/compute-view.js';
import { ComputeMap } from './ComputeMap.js';
import { advanceCores, isFleetCompute, isFleetSessionMap } from './compute-model.js';
import { at, lane, NOW, sessions } from './company.test-support.js';
import type { MapSession } from '../../../../core/fleet/sessions-view.js';
import { getPane } from '../panes/pane-registry.js';
import './compute.pane.js';
import FleetWorld from '../fleet/FleetWorld.js';
import { markCheckComplete } from '../../../data/auth-store.js';
import { MockEventSource } from '../fixtures.test-support.js';

const stats = { sampledAtMs: NOW, uptimeSeconds: 500, load: [1, 2, 3], ramTotal: 16 * 1024 ** 3, ramUsed: 8 * 1024 ** 3, diskFree: 100 * 1024 ** 3, cores: [{ total: 100, idle: 50 }] };
const compute: FleetCompute = { schema: 'fleet.compute.v1', generatedAt: at(), localNodeId: 'local', truncated: false, sources: { registry: 'loaded' }, dispatcherAt: at(), lanes: { 'codex-personal': { hardCap: 4, quotaOk: null } }, nodes: [
  { id: 'local', local: true, owners: ['team'], heartbeatAt: null, state: 'unknown', stats, jobs: [], slots: 2, ramSlots: 1, pressure: null, memguardPaused: null },
  { id: 'muse', local: false, owners: ['team'], heartbeatAt: NOW - 553_560_000, state: 'offline', stats: null, jobs: [], slots: null, ramSlots: null, pressure: null, memguardPaused: null },
] };
const mapped = (over: Partial<MapSession> = {}): MapSession => ({
  job: 'RQ-A', lane: 'codex-personal', model: 'test-model', status: 'running', elapsedSeconds: 60,
  outcome: null, prUrl: null, nodeId: 'local', placement: 'process', mapState: 'running',
  branch: 'work/fleet', worktree: 'recorded', activity: 'running typecheck', detailSources: null, ...over,
});
function serve() {
  const payloads: Record<string, unknown> = {
    '/api/verse/fleet/control/compute': compute,
    '/api/verse/agent-bus?after=0&limit=100': { v: 1, status: 'ok', nextCursor: 1, messages: [{ cursor: 1, receivedAt: NOW, envelope: { id: 'bus-1', from: 'helper', to: 'worker', priority: 'P2', ttl: 60000, body: { kind: 'work.claim', jobId: 'RQ-A' } } }] },
    '/api/verse/fleet/control/sessions': { ...sessions, computeAt: at(), mapRecent: [], mapSessions: [mapped(), mapped({ job: 'RQ-WAIT', status: 'queued', nodeId: null, placement: 'unknown', mapState: 'queued' })] },
    '/api/fleet/lanes': { schema: 'fleet.lanes.v1', generatedAt: at(), lanes: [
      { ...lane, slotTarget: 2, hold: { held: true, by: 'autobackoff', reason: 'quota reset', until: at(-100) } },
      { ...lane, lane: 'lexicon', liveJobs: null, queueDepth: null, hold: null, credit: { ...lane.credit, state: 'unknown', observedAt: null } },
    ] },
    '/api/fleet/job?id=RQ-A': { schema: 'fleet.job.v1', branch: 'work/fleet', log: { tail: ['running typecheck'] }, publish: { prUrl: 'https://github.com/ashlrai/phantom/pull/1', autoMerge: true } },
    '/api/fleet/job/activity?id=RQ-A': { schema: 'fleet.job.activity.v1', job: 'RQ-A', generatedAt: at(), state: 'running', lane: 'codex-personal', tier: 'work', model: null, sources: { events: 'healthy', commands: 'healthy', files: 'healthy', reports: 'missing' }, entries: [{ kind: 'command', text: 'npm run typecheck', line: 1 }], counts: { event: 0, command: 1, files: 0, report: 0 }, truncated: false },
  };
  const fetch = vi.fn(async (input: RequestInfo | URL) => Response.json(payloads[String(input)] ?? {}, { status: payloads[String(input)] ? 200 : 503 }));
  vi.stubGlobal('fetch', fetch); return { fetch, payloads };
}
afterEach(() => { cleanup(); evictAll(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('opens the compute and agent lens from the existing Fleet surface independently of its old snapshot', async () => {
  serve(); render(<FleetWorld read={undefined} />);
  const lens = screen.getByText('Compute & agents');
  expect(lens).toHaveAttribute('role', 'radio'); fireEvent.click(lens);
  expect((await screen.findByText('The company at work')).tagName).toBe('H2');
});
it('shows offline/unknown telemetry, lane holds and queued placement', async () => {
  serve(); render(<ComputeMap visible />);
  expect(await screen.findByText('local · this host')).toBeInTheDocument();
  const offline = screen.getByText(/Offline machines/).closest('details')!;
  expect(offline).not.toHaveAttribute('open');
  expect(within(offline).getByText('muse')).toBeInTheDocument();
  expect(within(offline).getByText('since 6d 9h ago')).toHaveAttribute('title', at(553_560));
  expect(offline).not.toHaveTextContent(/unknown|0 slots/);
  const lexicon = screen.getByText('lexicon').closest('article')!;
  expect(lexicon).toHaveTextContent('No telemetry yet');
  expect(lexicon).not.toHaveTextContent(/unknown|0 running|0 queued/);
  expect(lexicon.querySelector('img')).toHaveAttribute('src', expect.stringContaining('lexicon-logo.svg'));
  expect(screen.getByText(/HELD · autobackoff · quota reset/)).toBeInTheDocument();
  expect(screen.getByText(/1 running \/ 2 target \/ 4 hard cap/)).toBeInTheDocument();
  expect(screen.getByRole('progressbar', { name: 'codex-personal slot utilization' })).toHaveAttribute('value', '1');
  expect(within(screen.getByRole('region', { name: 'Unassigned agents' })).getByText('RQ-WAIT')).toBeInTheDocument();
  expect(getPane('fleet-compute')?.needsSession).toBe(false);
});
it('draws running flow from observed placement, widening shared links and dashing uncertain links', async () => {
  const { payloads } = serve();
  payloads['/api/verse/fleet/control/sessions'] = { ...sessions, computeAt: at(), mapRecent: [], mapSessions: [
    mapped(), mapped({ job: 'RQ-B' }),
    mapped({ job: 'RQ-C', nodeId: 'muse', placement: 'claim' }),
    mapped({ job: 'RQ-D', nodeId: null, lane: null, placement: 'unknown' }),
    mapped({ job: 'RQ-WAIT', status: 'queued', mapState: 'queued' }),
  ] };
  render(<ComputeMap visible />);
  const flow = await screen.findByRole('img', { name: 'Running agent flow' });
  const shared = within(flow).getByText('local → codex-personal: 2 running agents').parentElement!;
  const stale = within(flow).getByText('muse → codex-personal: 1 running agent (stale or unknown)').parentElement!;
  const unplaced = within(flow).getByText('Machine unknown → Lane unknown: 1 running agent (stale or unknown)').parentElement!;
  const agent = within(flow).getByText('codex-personal → RQ-A: 1 running agent').parentElement!;
  expect(Number(shared.getAttribute('stroke-width'))).toBeGreaterThan(Number(agent.getAttribute('stroke-width')));
  expect(shared).not.toHaveAttribute('stroke-dasharray');
  expect(stale).toHaveAttribute('stroke-dasharray');
  expect(unplaced).toHaveAttribute('stroke-dasharray');
  expect(flow).not.toHaveTextContent('RQ-WAIT');
});
it('keeps the selected agent and its recorded detail through orbit and zoom', async () => {
  serve(); vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null); // jsdom has no canvas
  render(<ComputeMap visible />);
  const token = (await screen.findByText('RQ-A')).closest('button')!;
  fireEvent.click(token);
  const detail = screen.getByText('Claims & handoffs').closest('section')!;
  expect(detail).toHaveAttribute('aria-label', 'Agent detail');
  expect(await within(detail).findByText(/Branch: work\/fleet/)).toBeInTheDocument();
  expect(await within(detail).findByText(/helper → worker/)).toBeInTheDocument();
  expect(within(detail).getByText('Open recorded PR')).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/1');
  const mode = screen.getByText('3D');
  expect(mode.tagName).toBe('BUTTON'); fireEvent.click(mode);
  fireEvent.change(screen.getByLabelText('Orbit'), { target: { value: '35' } });
  fireEvent.change(screen.getByLabelText('Zoom'), { target: { value: '1.2' } });
  expect(screen.getByLabelText('Orbit')).toHaveValue('35');
  expect(screen.getByLabelText('Zoom')).toHaveValue('1.2');
  expect(detail).toHaveTextContent('RQ-A');
  expect(token).toHaveAttribute('aria-pressed', 'true');
});

it('opens a side panel with the live log when a node is chosen, and closes it again', async () => {
  const { payloads } = serve();
  payloads['/api/fleet/job/tail?id=RQ-A&lines=200'] = { schema: 'fleet.job.tail.v1', job: 'RQ-A', status: 'live', message: null, truncated: false,
    detail: { lane: 'codex-personal', model: 'test-model', launchedAt: null, repo: null, tokens: null }, controls: { available: true, reason: null }, events: [{ ts: null, source: 'log', text: 'writing tests' }] };
  render(<ComputeMap visible />);
  fireEvent.click((await screen.findByText('RQ-A')).closest('button')!);
  const panel = within(screen.getByRole('region', { name: 'Agent detail' }));
  expect(await panel.findByRole('log', { name: 'Live log for RQ-A' })).toHaveTextContent('writing tests');
  expect(panel.getByText((_, el) => el?.tagName === 'DIV' && el.textContent === 'Repoashlrai/phantom')).toBeInTheDocument(); // from the session list
  expect(panel.getByRole('button', { name: 'Pause this job' })).toBeEnabled();
  expect(screen.getByRole('region', { name: 'Fleet compute map' })).toHaveAttribute('data-panel', 'open');
  fireEvent.click(panel.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('region', { name: 'Agent detail' })).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Fleet compute map' })).not.toHaveAttribute('data-panel');
});
it('stops every read while hidden and retains explicitly stale data when refresh fails', async () => {
  vi.useFakeTimers(); const { fetch, payloads } = serve();
  const view = render(<ComputeMap visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); }); expect(fetch).not.toHaveBeenCalled();
  view.rerender(<ComputeMap visible />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  const initial = fetch.mock.calls.length;
  delete payloads['/api/verse/fleet/control/compute'];
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(screen.getByText('Compute refresh failed. Last reading retained; may be stale.')).toBeInTheDocument();
  expect(fetch.mock.calls.length).toBeGreaterThan(initial);
  view.rerender(<ComputeMap visible={false} />); const count = fetch.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); }); expect(fetch).toHaveBeenCalledTimes(count);
});
it('refreshes compute, sessions, lanes and agent messages on the shared stream', async () => {
  const { fetch, payloads } = serve();
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
  markCheckComplete(true);
  try {
    render(<ComputeMap visible />);
    await screen.findByText(/4 hard cap/);
    fetch.mockClear();
    payloads['/api/verse/fleet/control/compute'] = { ...compute, lanes: { 'codex-personal': { hardCap: 6, quotaOk: true } } };
    const source = MockEventSource.instances.find(event => event.url.includes('topics='));
    expect(source?.url).toContain('fleet-compute');
    await act(async () => source!.emitNamed('fleet-compute', { refresh: true }));
    expect(await screen.findByText(/6 hard cap/)).toBeInTheDocument();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(expect.arrayContaining([
      '/api/verse/fleet/control/compute', '/api/verse/fleet/control/sessions', '/api/fleet/lanes', '/api/verse/fleet/control/map',
    ]));
  } finally { markCheckComplete(false); }
});
it('never infers utilization from a first sample, stale/reordered counters, reboot or unknown placement', () => {
  expect(isFleetCompute(compute)).toBe(true);
  expect(isFleetCompute({ ...compute, nodes: [{ id: 'muse', stats: { load: 'invented' } }] })).toBe(false);
  const first = advanceCores(undefined, stats, NOW); expect(first.samples).toEqual([[null]]);
  const next = { ...stats, sampledAtMs: NOW + 5000, cores: [{ total: 200, idle: 75 }] };
  expect(advanceCores(first, next, NOW + 5000).samples.at(-1)).toEqual([75]);
  expect(advanceCores(first, { ...next, uptimeSeconds: 1 }, NOW + 5000).samples.at(-1)).toEqual([null]);
  expect(advanceCores(first, { ...next, sampledAtMs: NOW - 1 }, NOW).samples).toEqual([[null]]);
  expect(advanceCores(first, next, NOW).samples).toEqual([[null]]);
  expect(advanceCores(first, next, NOW + 100_000).samples).toEqual([[null]]);
  expect(isFleetSessionMap({ schema: 'fleet.sessions.v1', sessions: [] })).toBe(false);
});

it('groups session states and keeps placement absent from the current node snapshot visible', async () => {
  const { fetch, payloads } = serve();
  payloads['/api/verse/fleet/control/sessions'] = { ...sessions, computeAt: at(), mapRecent: [], mapSessions: [
    mapped({ job: 'RQ-IDLE', status: 'exited', mapState: 'idle' }),
    mapped({ job: 'RQ-HELD', status: 'parked', mapState: 'held', nodeId: null, placement: 'unknown' }),
    mapped({ job: 'RQ-REMOTE', status: 'unknown', mapState: 'unknown', nodeId: 'missing-node', placement: 'claim' }),
  ] };
  render(<ComputeMap visible />);
  expect(await screen.findByRole('group', { name: 'codex-personal idle' })).toHaveTextContent('RQ-IDLE');
  const unassigned = within(screen.getByRole('region', { name: 'Unassigned agents' }));
  expect(unassigned.getByRole('group', { name: 'codex-personal held' })).toHaveTextContent('RQ-HELD');
  expect(unassigned.getByText('RQ-REMOTE')).toBeInTheDocument();
  fireEvent.click(unassigned.getByText('RQ-REMOTE').closest('button')!);
  expect(screen.getByText('Activity detail unavailable for this placement.')).toBeInTheDocument();
  expect(screen.getByText('Open full job log')).toBeDisabled();
  expect(fetch.mock.calls.some(([url]) => String(url).includes('/api/fleet/job'))).toBe(false);
});

it('renders empty and malformed session telemetry without inventing agents', async () => {
  const { payloads } = serve();
  payloads['/api/verse/fleet/control/sessions'] = { ...sessions, computeAt: at(), sourceState: 'missing', mapSessions: [], mapRecent: [] };
  const view = render(<ComputeMap visible />);
  expect(await screen.findByText('Session inventory unknown.')).toBeInTheDocument();
  expect(screen.queryByText('RQ-A')).not.toBeInTheDocument();
  view.unmount(); evictAll();
  payloads['/api/verse/fleet/control/sessions'] = { ...sessions, computeAt: at(), mapRecent: [], mapSessions: [{ ...mapped(), mapState: 'invented' }] };
  render(<ComputeMap visible />);
  expect(await screen.findByText('Sessions refresh failed. No data available.')).toBeInTheDocument();
});
it('renders node-pool hosts with oversubscription, caps and unknown slots', async () => {
  const { payloads } = serve();
  const host = { id: 'muse', nodeIds: ['muse', 'muse-w2'], inferred: true, ramTotal: 8 * 1024 ** 3, cores: 8, observedAt: NOW, caps: ['codex'], liveWorkers: 2, liveSlots: 2 + 4, heldWorkers: 0, claims: 1, ramSlots: 4, oversubscribed: true };
  const unknown = { ...host, id: 'air-w1', nodeIds: ['air-w1'], inferred: false, liveSlots: null, oversubscribed: null, caps: [] };
  payloads['/api/verse/fleet/control/compute'] = { ...compute, hosts: [unknown, host],
    pool: { hosts: 2, liveWorkers: 4, liveSlots: null, ramSlots: 8, claims: 2, unplacedNodes: 1, oversubscribedHosts: 1 } };
  render(<ComputeMap visible />);
  const region = await screen.findByRole('region', { name: 'Node pool hosts' });
  expect(within(region).getAllByText(/live slots unknown/).length).toBe(2);
  expect(within(region).getByText(/1 nodes without host telemetry/)).toBeInTheDocument();
  expect(within(region).getByText('OVERSUBSCRIBED · 6 advertised vs 4 RAM-budget')).toBeInTheDocument();
  expect(within(region).getByText('Oversubscription unknown')).toBeInTheDocument();
  expect(within(region).getByText('muse + muse-w2')).toBeInTheDocument();
  expect(within(region).getByText(/Caps: none reported/)).toBeInTheDocument();
});
