import { describe, expect, it, vi } from 'vitest';
import { buildFleetLiveMap, renderFleetLiveMapText, type FleetLiveMap } from '../src/core/fleet/live-map.js';
import { fleetOrgMap } from '../src/core/fleet/org-map.js';
import { fleetOrgTree } from '../src/core/fleet/org-tree.js';
import { projectFleetEdges } from '../src/core/fleet/fleet-edges.js';
import type { NodeRow, NodesView } from '../src/core/fleet/nodes-view.js';
import type { FleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import type { ResourceLedgerV1 } from '../src/core/fleet/runs-resource-ledger.js';
import type { FleetSessionsV1 } from '../src/core/fleet/runs-sessions.js';

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../src/core/verse/fleet-live-map-api.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/verse/fleet-live-map-api.js')>(), readFleetLiveMap: mocks.read }));
import { cmdMap } from '../src/cli/map.js';
import { throttledLiveMap } from '../src/core/verse/fleet-live-map-api.js';

const NOW = Date.parse('2026-11-17T12:00:00Z'), AT = new Date(NOW).toISOString();
const session = (job: string, lane: string, extra: object = {}) => ({ job, lane, repo: 'phantom', model: 'fixture-model', status: 'running',
  elapsedSeconds: 120, startedAt: '2026-11-17T11:58:00Z', live: 'unknown', ...extra });
const receipt = (from: string, to: string, receivedAt: number, vendor?: string) => ({ cursor: 1, receivedAt,
  envelope: { id: `${from}-${to}-${receivedAt}`, from, to, priority: 'P2' as const, ttl: 3_600_000, body: { text: 'fixture body' },
    ...(vendor ? { sender: { agent_id: from, vendor } } : {}) } });
function org(sessions: object[], receipts?: ReturnType<typeof receipt>[]) {
  const messages = receipts ? { schema: 'fleet.edges.v1' as const, source: 'available' as const, edges: projectFleetEdges(receipts as never, NOW, 15) } : undefined;
  const map = fleetOrgMap(null, { now: NOW, minutes: 15, messages,
    sessions: { generatedAt: AT, sourceState: 'healthy', truncated: false, recent: [], sessions } as unknown as FleetSessionsV1 });
  const runs = { lanes: [{ lane: 'claude', running: 2, target: 8, queued: 1, held: false }], events: [], lastTick: AT, paused: false,
    sources: { status: 'healthy' } } as unknown as FleetRunsDirState;
  return { ...map, tree: fleetOrgTree(map, { runs }) };
}
const computer = (name: string, extra: Partial<NodeRow> = {}): NodeRow => ({ name, isSelf: false, reachable: true, lastSeen: AT, phantom: 'running',
  freeMemoryBytes: 8e9, cpuHeadroomPercent: 50, lanes: ['claude'], jobsRunning: [], freeSlots: 1, stateCode: 'ready', state: 'ready for work', ...extra });
const computers = (nodes: NodeRow[], reasons: string[] = []): NodesView => ({ schemaVersion: 1, asOf: AT, self: 'node-a', registry: 'local', nodes, reasons });
const usage = { v: 1, generatedAt: AT, asOf: AT, sources: { status: 'healthy', apiSpend: 'missing', jobs: 'missing' }, apiSpend: null, jobsMalformedRows: null, lanes: [
  { lane: 'claude', window: 'weekly', usedPct: 41.6, creditsRemaining: null, deadSignal: null },
  { lane: 'devin', window: 'credits', usedPct: null, creditsRemaining: 12, deadSignal: null },
  { lane: 'codex-local', window: 'none', usedPct: null, creditsRemaining: null, deadSignal: null },
] } as unknown as ResourceLedgerV1;
const ids = (map: FleetLiveMap, kind: string) => map.nodes.filter(node => node.kind === kind).map(node => node.id);
const edge = (map: FleetLiveMap, id: string) => map.edges.find(row => row.id === id);

describe('buildFleetLiveMap', () => {
  it('an empty fleet is the leader alone, with every missing source unknown and listed', () => {
    const map = buildFleetLiveMap({ now: NOW });
    expect(map.nodes).toEqual([{ id: 'leader', kind: 'leader', level: 0, label: 'Leader', provider: 'unknown', status: 'unknown', detail: 'dispatcher state unknown', live: null }]);
    expect(map.edges).toEqual([]);
    expect(map.counts).toEqual({ lanes: 0, jobs: 0, computers: 0, resources: 0, messages: null });
    expect(map.sources).toEqual({ org: 'unknown', jobs: 'unknown', computers: 'unknown', resources: 'unknown', messages: 'unknown' });
    expect(map.unmappedMessages).toBeNull();
    expect(map.gaps).toEqual(expect.arrayContaining([expect.stringMatching(/^Org unknown/), expect.stringMatching(/^Computers unknown/),
      expect.stringMatching(/^Pool usage unknown/), expect.stringMatching(/^Messages unknown/)]));
    const text = renderFleetLiveMapText(map);
    expect(text).toContain('Jobs:\n  unknown');
    expect(text).toContain('Messages in the last 15 minutes:\n  unknown');
  });

  it('one lane with jobs: jobs report to the lane, the lane to the leader, and the lane uses its pool', () => {
    const map = buildFleetLiveMap({ now: NOW, org: org([session('RQ-B', 'claude'), session('RQ-A', 'claude', { model: null })]), usage });
    expect(ids(map, 'job')).toEqual(['job:RQ-A', 'job:RQ-B']);
    expect(map.nodes.find(node => node.id === 'lane:claude')).toEqual({ id: 'lane:claude', kind: 'lane', level: 1, label: 'claude',
      provider: 'Anthropic', status: 'running', detail: '2 running of 8, 1 queued', live: null });
    expect(map.nodes.find(node => node.id === 'job:RQ-A')).toMatchObject({ level: 2, provider: 'Anthropic', status: 'running', detail: 'model unknown · phantom', live: true });
    expect(edge(map, 'reports-to:job:RQ-A->lane:claude')).toEqual({ id: 'reports-to:job:RQ-A->lane:claude', kind: 'reports-to', from: 'job:RQ-A', to: 'lane:claude',
      messages: null, lastMessageAt: null, pulse: false });
    expect(edge(map, 'reports-to:lane:claude->leader')).toBeDefined();
    expect(ids(map, 'resource')).toEqual(['resource:claude', 'resource:devin']);
    expect(map.nodes.find(node => node.id === 'resource:claude')).toMatchObject({ level: 4, label: 'claude weekly quota', status: 'available', detail: '42% used' });
    expect(map.nodes.find(node => node.id === 'resource:devin')).toMatchObject({ label: 'devin credits', detail: '12 credits left' });
    expect(edge(map, 'uses-resource:lane:claude->resource:claude')).toBeDefined();
    expect(map.counts).toMatchObject({ jobs: 2, resources: 2 });
    // Every edge joins two drawn nodes.
    const known = new Set(map.nodes.map(node => node.id));
    expect(map.edges.every(row => known.has(row.from) && known.has(row.to))).toBe(true);
  });

  it('two computers: jobs run where a registry claim or a local worker process puts them; unknown facts stay unknown', () => {
    const map = buildFleetLiveMap({ now: NOW, org: org([session('RQ-A', 'claude', { live: 'yes' }), session('RQ-B', 'claude')]),
      computers: computers([
        computer('node-b', { jobsRunning: ['RQ-B', 'RQ-POOL'], stateCode: 'busy', state: 'busy: 2 jobs running, no free slots' }),
        computer('node-a', { isSelf: true, jobsRunning: 'unknown', stateCode: 'unknown', state: 'reachable; Phantom status unknown' }),
      ], ['tailscale unavailable or status unreadable']) });
    expect(ids(map, 'computer')).toEqual(['computer:node-a', 'computer:node-b']);
    expect(map.nodes.find(node => node.id === 'computer:node-a')).toMatchObject({ level: 3, status: 'unknown', detail: 'reachable; Phantom status unknown (this computer)' });
    expect(map.edges.filter(row => row.kind === 'runs-on').map(row => row.id)).toEqual([
      'runs-on:job:RQ-A->computer:node-a', 'runs-on:job:RQ-B->computer:node-b', 'runs-on:job:RQ-POOL->computer:node-b']);
    expect(map.nodes.find(node => node.id === 'job:RQ-POOL')).toMatchObject({ status: 'running', detail: 'lane unknown', provider: 'unknown' });
    expect(map.edges.some(row => row.from === 'job:RQ-POOL' && row.kind === 'reports-to')).toBe(false);
    expect(map.gaps).toContain('Computers: tailscale unavailable or status unreadable');
    expect(renderFleetLiveMapText(map)).toContain('* RQ-B | running | fixture-model · phantom | on node-b');
  });

  it('a message chain: leader to lane to job, counted per edge, pulsing only within the last minute', () => {
    const map = buildFleetLiveMap({ now: NOW, org: org([session('RQ-A', 'claude')], [
      receipt('leader', 'claude', NOW - 10 * 60_000), receipt('leader', 'claude', NOW - 30_000),
      receipt('claude', 'RQ-A', NOW - 5 * 60_000),
      receipt('RQ-A', 'leader', NOW - 2 * 60_000),
      receipt('RQ-A', 'stranger-agent', NOW - 20_000),
      receipt('leader', 'claude', NOW - 20 * 60_000),
    ]) });
    const talk = map.edges.filter(row => row.kind === 'messaged-in-last-15-min');
    expect(talk.map(row => [row.from, row.to, row.messages, row.pulse])).toEqual([
      ['job:RQ-A', 'leader', 1, false], ['lane:claude', 'job:RQ-A', 1, false], ['leader', 'lane:claude', 2, true]]);
    expect(edge(map, 'messaged-in-last-15-min:leader->lane:claude')?.lastMessageAt).toBe(new Date(NOW - 30_000).toISOString());
    expect(map.counts.messages).toBe(5);
    expect(map.unmappedMessages).toBe(1);
    expect(map.gaps).toContain('1 message could not be matched to a node on this map.');
    expect(JSON.stringify(map)).not.toContain('fixture body');
    expect(renderFleetLiveMapText(map)).toContain('~ Leader (CEO) -> claude: 2');
  });

  it('prints stable JSON: the same facts in any input order give identical bytes, with fixed key order', () => {
    const receipts = [receipt('leader', 'claude', NOW - 30_000), receipt('claude', 'RQ-A', NOW - 60_000)];
    const a = buildFleetLiveMap({ now: NOW, usage, org: org([session('RQ-A', 'claude'), session('RQ-B', 'claude')], receipts),
      computers: computers([computer('node-a', { isSelf: true }), computer('node-b', { jobsRunning: ['RQ-B'] })]) });
    const b = buildFleetLiveMap({ now: NOW, usage: { ...usage, lanes: [...usage.lanes].reverse() }, org: org([session('RQ-B', 'claude'), session('RQ-A', 'claude')], [...receipts].reverse()),
      computers: computers([computer('node-b', { jobsRunning: ['RQ-B'] }), computer('node-a', { isSelf: true })]) });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(Object.keys(a)).toEqual(['schema', 'generatedAt', 'windowMinutes', 'pulseSeconds', 'nodes', 'edges', 'counts', 'sources', 'unmappedMessages', 'gaps', 'orgLayout']);
    expect(a.nodes.every(node => Object.keys(node).join() === `id,kind,level,label,provider,status,detail,live${node.kind === 'resource' ? ',usedPct' : node.kind === 'job' ? ',lane,repo,state' : ''}`)).toBe(true);
    expect(a.nodes.filter(node => node.kind === 'resource').every(node => node.usedPct === null || typeof node.usedPct === 'number')).toBe(true);
    expect(a.edges.every(row => Object.keys(row).join() === 'id,kind,from,to,messages,lastMessageAt,pulse')).toBe(true);
    expect(a.nodes.map(node => node.level)).toEqual([...a.nodes.map(node => node.level)].sort((x, y) => x - y));
    expect(new Set(a.nodes.map(node => node.id)).size).toBe(a.nodes.length);
  });
});

describe('throttledLiveMap', () => {
  it('reads the fleet at most once per 5 seconds and shares a build in flight', async () => {
    let now = NOW;
    const read = vi.fn(async () => buildFleetLiveMap({ now }));
    const get = throttledLiveMap(read, () => now);
    await Promise.all([get(), get()]);
    now += 4_999; await get();
    expect(read).toHaveBeenCalledTimes(1);
    now += 1; await get();
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('does not keep a failed build', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(buildFleetLiveMap({ now: NOW }));
    const get = throttledLiveMap(read, () => NOW);
    await expect(get()).rejects.toThrow('down');
    await expect(get()).resolves.toMatchObject({ schema: 'fleet.live-map.v1' });
  });
});

describe('phm map', () => {
  it('prints JSON with --json, text by default, usage on bad flags', async () => {
    mocks.read.mockResolvedValue(buildFleetLiveMap({ now: NOW }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {}), err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdMap(['--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toMatchObject({ schema: 'fleet.live-map.v1' });
    expect(await cmdMap([])).toBe(0);
    expect(String(log.mock.calls.at(-1)![0])).toMatch(/^Leader: unknown, dispatcher state unknown\./);
    expect(await cmdMap(['--minutes'])).toBe(2);
    expect(await cmdMap(['--help'])).toBe(0);
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(err).toHaveBeenCalledTimes(1);
    log.mockRestore(); err.mockRestore();
  });
});
