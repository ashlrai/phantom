/**
 * `phm nodes pool`: the joined Macs as one pool. Every source is injected; no real tailscale,
 * home directory, registry or setting is read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdNodes } from '../src/cli/nodes.js';
import type { HostStats, NodeRecord, NodesState } from '../src/core/drive/nodes/state.js';
import { NODES_POOL_SCHEMA, poolText, readNodesPool } from '../src/core/fleet/nodes-pool.js';
import type { NodesRegistry, NodesViewDeps } from '../src/core/fleet/nodes-view.js';
import { createFleetNodesPoolApi } from '../src/core/verse/fleet-nodes-pool-api.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const GIB = 1024 ** 3;
const stats = (usedGib: number, load: number, diskGib: number | null): HostStats => ({
  sampledAtMs: NOW, uptimeSeconds: 60, load: [load, load, load], ramTotal: 32 * GIB, ramUsed: usedGib * GIB, diskFree: diskGib === null ? null : diskGib * GIB,
  cores: Array.from({ length: 8 }, () => ({ total: 100, idle: 50 })),
});
const node = (nodeId: string, extra: Partial<NodeRecord> = {}): NodeRecord => ({
  nodeId, session: 1, heartbeatAt: NOW - 2_000, expiresAt: NOW + 30_000, caps: ['claude'], slots: 2, ...extra,
});
const registry = (nodes: NodeRecord[]): NodesRegistry => ({
  source: 'pool-witness', selfNode: 'node-a',
  state: { version: 'drive.nodes.v1', sequence: 9, observedAt: NOW - 1_000, nodes, leader: null, jobs: [] } satisfies NodesState,
});
const localRegistry = (nodes: NodeRecord[]): NodesRegistry => ({
  source: 'local', selfNode: null,
  state: { version: 'drive.nodes.v1', sequence: 9, observedAt: NOW - 1_000, nodes, leader: null, jobs: [] } satisfies NodesState,
});
const peer = (name: string, online: boolean, lastSeen = '2026-11-17T11:00:00Z') => ({ HostName: name, OS: 'macOS', Online: online, LastSeen: lastSeen });
const tailnet = (peers: Record<string, unknown>[]) => JSON.stringify({
  BackendState: 'Running', Self: { HostName: 'node-a' }, Peer: Object.fromEntries(peers.map((p, i) => [`peer-${i}`, p])),
});
function deps(peers: Record<string, unknown>[], read: NodesRegistry): NodesViewDeps {
  return { peers: { now: () => new Date(NOW), homeDir: () => '/fake-home', exec: () => tailnet(peers) }, readRegistry: () => read,
    localStats: () => stats(8, 1, 200), hostName: () => 'node-a.fake.example', timeZone: 'UTC' };
}
const claimed = (id: string, nodeId: string) => ({ id, state: 'running', claim: { nodeId, session: 1, expiresAt: NOW + 30_000 } }) as unknown as NodesState['jobs'][number];

afterEach(() => { vi.restoreAllMocks(); });

describe('readNodesPool', () => {
  it('one node: this Mac alone, with its slots, load, memory, disk and offload setting', () => {
    const pool = readNodesPool({ view: deps([], registry([node('node-a', { slots: 3 })])), readOffload: () => false });
    expect(pool.schema).toBe(NODES_POOL_SCHEMA);
    expect(pool.nodes).toHaveLength(1);
    expect(pool.nodes[0]).toMatchObject({ name: 'node-a', isSelf: true, status: 'online', freeSlots: 3, jobsRunning: [], load: 1, freeMemoryBytes: 24 * GIB,
      freeMemoryPercent: 75, freeDiskGb: 214.7, offload: 'off', lastSeen: '2026-11-17T12:00:00.000Z' });
    expect(pool.total).toMatchObject({ macs: 1, online: 1, freeSlots: 3, slotsUnknown: 0, jobsRunning: 0, line: '1 Mac, 3 free slots' });
    expect(poolText(pool).split('\n')[0]).toBe('1 Mac, 3 free slots. Offload is off on this Mac.');
    expect(poolText(pool)).toContain('● node-a (this Mac): online | 3 free slots | running nothing | load 1 | memory free 24.0 GB | disk free 214.7 GB | offload off | seen just now');
  });

  it('two nodes with one offline: the offline Mac offers nothing and this Mac comes first', () => {
    const view = deps([peer('node-b', true), peer('node-c', false, '2026-11-17T10:42:00Z')],
      registry([node('node-a', { slots: 4 }), node('node-b', { slots: 7, hostStats: stats(16, 4, 90) })]));
    const read = registry([node('node-a', { slots: 4 }), node('node-b', { slots: 7, hostStats: stats(16, 4, 90) })]);
    read.state!.jobs = [claimed('RQ-ONE', 'node-b'), claimed('RQ-TWO', 'node-b'), claimed('RQ-THREE', 'node-b'), claimed('RQ-FOUR', 'node-b')];
    view.readRegistry = () => read;
    const pool = readNodesPool({ view, readOffload: () => true });
    expect(pool.nodes.map(n => [n.name, n.status, n.freeSlots])).toEqual([['node-a', 'online', 4], ['node-b', 'online', 3], ['node-c', 'offline', 0]]);
    expect(pool.nodes[1]).toMatchObject({ freeDiskGb: 96.6, freeMemoryPercent: 50, load: 4, offload: 'unknown', jobsRunning: ['RQ-FOUR', 'RQ-ONE', 'RQ-THREE', 'RQ-TWO'] });
    expect(pool.nodes[2]).toMatchObject({ lastSeen: '2026-11-17T10:42:00.000Z', freeDiskGb: 'unknown', offload: 'unknown' });
    expect(pool.total).toMatchObject({ macs: 3, online: 2, freeSlots: 7, jobsRunning: 4, line: '3 Macs, 7 free slots' });
    const text = poolText(pool).split('\n');
    expect(text[0]).toBe('3 Macs, 7 free slots. Offload is on on this Mac.');
    expect(text.find(l => l.includes('node-b'))).toContain('running RQ-FOUR, RQ-ONE, RQ-THREE +1 more');
    expect(text.find(l => l.includes('node-c'))).toMatch(/^○ node-c: offline \| 0 free slots .*offload unknown \| seen 78 min ago$|^○ node-c: offline \| 0 free slots .*seen 1 h ago$/);
  });

  it('a node with unknown stats: unknown is said, never zero, and the total says how many were not measured', () => {
    // node-b is on the tailnet and its Phantom beats, but it never reported slots, memory, load or disk.
    const pool = readNodesPool({ view: deps([peer('node-b', true)], registry([node('node-a', { slots: 2 }), node('node-b', { slots: undefined })])), readOffload: () => false });
    const b = pool.nodes.find(n => n.name === 'node-b')!;
    expect(b).toMatchObject({ status: 'online', freeSlots: 'unknown', load: 'unknown', freeMemoryBytes: 'unknown', freeDiskGb: 'unknown', offload: 'unknown' });
    expect(pool.total).toMatchObject({ macs: 2, freeSlots: 2, slotsUnknown: 1, line: '2 Macs, 2 free slots (1 not measured)' });
    expect(poolText(pool)).toContain('● node-b: online | free slots unknown | running nothing | load unknown | memory free unknown | disk free unknown | offload unknown');
  });

  it('standalone registry: a peer named like a local node id never inherits this disk', () => {
    // `phm node join --node laptop` on this Mac writes the standalone store;
    // a tailnet peer also named laptop is a different computer and must not
    // show this machine's host-stats disk as its own.
    const pool = readNodesPool({ view: deps([peer('laptop', true)],
      localRegistry([node('laptop', { hostStats: stats(8, 1, 55) })])), readOffload: () => false });
    expect(pool.nodes.find(n => n.isSelf)).toMatchObject({ freeDiskGb: 214.7 });
    expect(pool.nodes.find(n => n.name === 'laptop')).toMatchObject({ isSelf: false, freeDiskGb: 'unknown' });
  });

  it('a failing reader never throws: no registry and no setting read as unknown', () => {
    const view = deps([], registry([]));
    view.readRegistry = () => { throw new Error('boom'); };
    const pool = readNodesPool({ view, readOffload: () => { throw new Error('boom'); } });
    expect(pool.nodes[0]).toMatchObject({ isSelf: true, offload: 'unknown', freeSlots: 'unknown' });
    expect(pool.reasons.length).toBeGreaterThan(0);
  });
});

describe('phm nodes pool', () => {
  const run = async (args: string[], view: NodesViewDeps) => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => { out.push(line); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await cmdNodes(['pool', ...args], view);
    return { code, out: out.join('\n'), err: err.mock.calls.length };
  };
  const view = () => deps([peer('node-b', false)], registry([node('node-a')]));

  it('prints the total first, then one line per Mac', async () => {
    const { code, out } = await run([], view());
    expect(code).toBe(0);
    expect(out.split('\n')[0]).toMatch(/^2 Macs, 2 free slots\./);
    expect(out).toContain('○ node-b: offline');
  });

  it('--json carries a schema id and a total', async () => {
    const { code, out } = await run(['--json'], view());
    const json = JSON.parse(out);
    expect(code).toBe(0);
    expect(json).toMatchObject({ schema: 'phantom.nodes-pool.v1', schemaVersion: 1, total: { macs: 2, online: 1 } });
    expect(Object.keys(json.nodes[0]).sort()).toEqual(['freeDiskGb', 'freeMemoryBytes', 'freeMemoryPercent', 'freeSlots', 'isSelf', 'jobsRunning', 'lastSeen', 'load', 'name', 'offload', 'state', 'status']);
  });

  it('refuses unknown flags with usage and exit 2; --help exits 0', async () => {
    expect((await run(['--bad'], view())).code).toBe(2);
    expect((await run(['--help'], view())).code).toBe(0);
  });
});

describe('GET /api/verse/fleet/control/nodes-pool', () => {
  const call = async (path: string, method: string, read = async () => readNodesPool({ view: deps([], registry([node('node-a')])), readOffload: () => false })) => {
    const sent: { status: number; body: unknown }[] = [];
    const res = { writeHead: (status: number) => { sent.push({ status, body: null }); }, end: (body: string) => { sent[0]!.body = JSON.parse(body); }, setHeader: () => {} };
    const handled = await createFleetNodesPoolApi(read)({} as never, { url: path } as never, res as never, path.split('?')[0]!, method);
    return { handled, sent: sent[0] };
  };
  it('serves the pool; rejects writes and queries; ignores other paths', async () => {
    expect((await call('/api/verse/fleet/control/nodes-pool', 'GET')).sent).toMatchObject({ status: 200, body: { schema: NODES_POOL_SCHEMA } });
    expect((await call('/api/verse/fleet/control/nodes-pool', 'POST')).sent?.status).toBe(405);
    expect((await call('/api/verse/fleet/control/nodes-pool?x=1', 'GET')).sent?.status).toBe(400);
    expect((await call('/api/verse/fleet/control/nodes-pool', 'GET', async () => { throw new Error('x'); })).sent?.status).toBe(503);
    expect((await call('/api/other', 'GET')).handled).toBe(false);
  });
});
