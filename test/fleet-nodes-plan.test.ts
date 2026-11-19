/**
 * `phm nodes plan`: read-only plan over the node view and the queue.
 * Every source is injected; no real tailscale, home directory, registry or queue is read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdNodes } from '../src/cli/nodes.js';
import type { HostStats, NodeRecord, NodesState } from '../src/core/drive/nodes/state.js';
import type { NodesRegistry, NodesViewDeps } from '../src/core/fleet/nodes-view.js';
import { NODES_PLAN_SCHEMA, readNodesPlan, TAILSCALE_MISSING_WORDS } from '../src/core/fleet/nodes-plan.js';
import type { QueueOrderJob, QueueOrderV1 } from '../src/core/queue/order-types.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const GIB = 1024 ** 3;
const stats = (usedGib: number, load: number): HostStats => ({
  sampledAtMs: NOW, uptimeSeconds: 60, load: [load, load, load], ramTotal: 32 * GIB, ramUsed: usedGib * GIB, diskFree: null,
  cores: Array.from({ length: 8 }, () => ({ total: 100, idle: 50 })),
});
const node = (nodeId: string, extra: Partial<NodeRecord> = {}): NodeRecord => ({
  nodeId, session: 1, heartbeatAt: NOW - 2_000, expiresAt: NOW + 30_000, caps: ['claude', 'codex'], slots: 2, ...extra,
});
const registry = (nodes: NodeRecord[]): NodesRegistry => ({
  source: 'pool-witness', selfNode: 'node-a',
  state: { version: 'drive.nodes.v1', sequence: 9, observedAt: NOW - 1_000, nodes, leader: null, jobs: [] } satisfies NodesState,
});
const peer = (name: string, online: boolean) => ({ HostName: name, OS: 'macOS', Online: online, LastSeen: '2026-11-17T10:42:00Z' });
const tailnet = (peers: Record<string, unknown>[]) => JSON.stringify({
  BackendState: 'Running', Self: { HostName: 'node-a' }, Peer: Object.fromEntries(peers.map((p, i) => [`peer-${i}`, p])),
});
function deps(exec: () => string, read: NodesRegistry): NodesViewDeps {
  return { peers: { now: () => new Date(NOW), homeDir: () => '/fake-home', exec }, readRegistry: () => read,
    localStats: () => stats(8, 1), hostName: () => 'node-a.fake.example', timeZone: 'UTC' };
}
const job = (id: string, lane: string, position: number): QueueOrderJob =>
  ({ position, id, repo: 'phantom', lane, tier: 'work', ageSeconds: 5, family: null, supersededBy: null });
const queueOf = (jobs: QueueOrderJob[]): QueueOrderV1 =>
  ({ schema: 'queue.order.v1', version: 1, generatedAt: new Date(NOW).toISOString(), count: jobs.length, parked: 0, lanes: ['claude', 'codex'], jobs });

afterEach(() => { vi.restoreAllMocks(); });

describe('readNodesPlan', () => {
  const healthy = (): NodesViewDeps => deps(() => tailnet([peer('node-b', true), peer('node-c', false)]),
    registry([node('node-a', { slots: 1 }), node('node-b', { hostStats: stats(8, 4) })]));

  it('two healthy nodes and one offline node: slots, memory, load and the offline zero', async () => {
    const plan = await readNodesPlan({ view: healthy(), readQueue: async () => queueOf([]) });
    expect(plan.schema).toBe(NODES_PLAN_SCHEMA);
    expect(plan.as_of).toBe('2026-11-17T12:00:00.000Z');
    expect(plan.nodes.map(n => [n.name, n.online, n.suggested_slots])).toEqual([['node-a', true, 1], ['node-b', true, 2], ['node-c', false, 0]]);
    expect(plan.nodes[1]).toMatchObject({ free_mem_pct: 75, load: 4, lanes: ['claude', 'codex'] });
    expect(plan.nodes[2]!.why).toMatch(/^offline since .*no jobs suggested$/);
    expect(plan.reasons).toEqual([]);
  });

  it('assigns queued jobs in launch order, remote first, never past the suggested slots', async () => {
    const jobs = [job('j1', 'claude', 1), job('j2', 'claude', 2), job('j3', 'claude', 3), job('j4', 'claude', 4), job('j5', 'gemini', 5)];
    const plan = await readNodesPlan({ view: healthy(), readQueue: async () => queueOf(jobs) });
    expect(plan.assignable.map(a => [a.job, a.node])).toEqual([['j1', 'node-b'], ['j2', 'node-b'], ['j3', 'node-a']]);
    expect(plan.unassigned).toBe(2);
    expect(plan.nodes.every(n => n.suggested_slots !== 'unknown')).toBe(true);
  });

  it('keeps unknown unknown: unreadable queue and unmeasured slots', async () => {
    const view = deps(() => tailnet([peer('node-b', true)]), registry([node('node-a'), node('node-b', { slots: undefined })]));
    const plan = await readNodesPlan({ view, readQueue: async () => { throw new Error('no queue'); } });
    expect(plan.nodes.find(n => n.name === 'node-b')).toMatchObject({ suggested_slots: 'unknown' });
    expect(plan.assignable).toEqual([]);
    expect(plan.unassigned).toBe('unknown');
    expect(plan.reasons).toContain('queue unreadable; job assignments unknown');
  });

  it('missing Tailscale CLI: says so in plain words and plans this computer only', async () => {
    const view = deps(() => { throw Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' }); }, registry([node('node-a')]));
    const plan = await readNodesPlan({ view, readQueue: async () => queueOf([job('j1', 'claude', 1)]) });
    expect(plan.reasons).toEqual([TAILSCALE_MISSING_WORDS]);
    expect(TAILSCALE_MISSING_WORDS).toBe('Tailscale is not installed here.');
    expect(plan.nodes.map(n => n.name)).toEqual(['node-a']);
    expect(plan.assignable).toEqual([{ job: 'j1', node: 'node-a', why: expect.stringContaining('claude lane') }]);
  });

  it('a Tailscale that fails for another reason is not called missing', async () => {
    const view = deps(() => { throw new Error('exit 1'); }, registry([node('node-a')]));
    const plan = await readNodesPlan({ view, readQueue: async () => queueOf([]) });
    expect(plan.reasons).toEqual(['tailscale unavailable or status unreadable']);
  });
});

describe('phm nodes plan', () => {
  it('prints typed JSON with a schema id and changes nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = vi.fn(() => tailnet([peer('node-b', true)]));
    const code = await cmdNodes(['plan', '--json'], deps(exec, registry([node('node-a'), node('node-b')])), async () => queueOf([job('j1', 'codex', 1)]));
    expect(code).toBe(0);
    const out = JSON.parse(String(log.mock.calls[0]![0]));
    expect(Object.keys(out)).toEqual(['schema', 'as_of', 'nodes', 'assignable', 'unassigned', 'reasons']);
    expect(out.schema).toBe('phantom.nodes-plan.v1');
    expect(out.assignable).toHaveLength(1);
  });

  it('prints plain words without --json, and rejects extra arguments', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = deps(() => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); }, registry([node('node-a')]));
    expect(await cmdNodes(['plan'], view, async () => queueOf([]))).toBe(0);
    const text = String(log.mock.calls[0]![0]);
    expect(text).toContain('node-a: 2 slots');
    expect(text).toContain('note: Tailscale is not installed here.');
    expect(await cmdNodes(['plan', '--bogus'], view, async () => queueOf([]))).toBe(2);
    expect(err).toHaveBeenCalled();
  });
});
