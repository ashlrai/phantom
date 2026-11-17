/**
 * `phm nodes`: the read-only join of the tailnet read and the node registry.
 * Every source is injected; no real tailscale, home directory or registry is read.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdNodes } from '../src/cli/nodes.js';
import type { HostStats, NodeRecord, NodesState } from '../src/core/drive/nodes/state.js';
import { createFleetRuntimeIdentityApi } from '../src/core/verse/fleet-runtime-identity-api.js';
import { VERSE_FLEET_NODES_PATH, createFleetHostReachApi } from '../src/core/verse/fleet-host-reach-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { narrowComputers } from '../src/web-ui/routes/verse/fleet-host/computers-model.js';
import { nodesThatCanTake, readNodesView, type NodesRegistry, type NodesViewDeps } from '../src/core/fleet/nodes-view.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const GIB = 1024 ** 3;
const stats = (usedGib: number, load: number): HostStats => ({
  sampledAtMs: NOW, uptimeSeconds: 60, load: [load, load, load], ramTotal: 32 * GIB, ramUsed: usedGib * GIB, diskFree: null,
  cores: Array.from({ length: 8 }, () => ({ total: 100, idle: 50 })),
});
const node = (nodeId: string, extra: Partial<NodeRecord> = {}): NodeRecord => ({
  nodeId, session: 1, heartbeatAt: NOW - 2_000, expiresAt: NOW + 30_000, caps: ['claude', 'codex'], slots: 2, ...extra,
});
const registry = (nodes: NodeRecord[], jobs: NodesState['jobs'] = [], extra: Partial<NodesRegistry> = {}): NodesRegistry => ({
  source: 'pool-witness', selfNode: 'node-a', state: { version: 'drive.nodes.v1', sequence: 9, observedAt: NOW - 1_000, nodes, leader: null, jobs }, ...extra,
});
const tailnet = (peers: Record<string, unknown>[], backend = 'Running') => JSON.stringify({
  BackendState: backend, Self: { HostName: 'node-a' }, Peer: Object.fromEntries(peers.map((peer, i) => [`key-${i}`, peer])),
});
const peer = (name: string, online: boolean, lastSeen = '2026-11-17T10:42:00Z') => ({ HostName: name, OS: 'macOS', Online: online, LastSeen: lastSeen });
function deps(status: string | null, read: NodesRegistry | Error): NodesViewDeps {
  return {
    peers: { now: () => new Date(NOW), homeDir: () => '/fake-home', exec: () => { if (status === null) throw new Error('ENOENT'); return status; } },
    readRegistry: () => { if (read instanceof Error) throw read; return read; },
    localStats: () => stats(20, 2), hostName: () => 'node-a.fake.example', timeZone: 'UTC',
  };
}
const NO_POOL: NodesRegistry = { source: 'none', state: null, selfNode: null };

afterEach(() => { vi.restoreAllMocks(); });

describe('readNodesView', () => {
  it('local only: one row for this computer, measured here, told how to join', () => {
    const view = readNodesView(deps(tailnet([]), NO_POOL));
    expect(view).toEqual({
      schemaVersion: 1, asOf: '2026-11-17T12:00:00.000Z', self: 'node-a', registry: 'none',
      nodes: [{
        name: 'node-a', isSelf: true, reachable: true, lastSeen: '2026-11-17T12:00:00.000Z', phantom: 'not-running',
        freeMemoryBytes: 12 * GIB, cpuHeadroomPercent: 75, lanes: 'unknown', jobsRunning: 'unknown', freeSlots: 'unknown',
        stateCode: 'not-running', state: 'reachable but Phantom not running: run `phm node join` here',
      }],
      reasons: ['no node pool on this computer: run `phm node join` on each computer to pool them'],
    });
  });

  it('two reachable nodes: ready and busy, with reported memory, CPU, lanes and jobs', () => {
    const view = readNodesView(deps(tailnet([peer('node-b', true), peer('node-c', true), { HostName: 'fake-phone', OS: 'iOS', Online: true }]), registry(
      [node('node-a'), node('node-b', { hostStats: stats(8, 4), slots: 1 }), node('worker-3', { capacity: { hostId: 'node-c', sampledAtMs: NOW, ramBytes: 32 * GIB, slots: 0, held: 'memory-pressure' }, slots: 0 })],
      [{ id: 'job-1', state: 'running', claim: { jobId: 'job-1', nodeId: 'node-b', session: 1, token: 2, leaderToken: 1, expiresAt: NOW + 5_000 } }, { id: 'job-2', state: 'pending' }],
    )));
    expect(view.reasons).toEqual([]);
    expect(view.nodes.map(row => [row.name, row.stateCode, row.state])).toEqual([
      ['node-a', 'ready', 'ready for work'],
      ['node-b', 'busy', 'busy: 1 job running, no free slots'],
      ['node-c', 'held', 'holding: low memory'],
    ]);
    expect(view.nodes[1]).toMatchObject({
      reachable: true, phantom: 'running', freeMemoryBytes: 24 * GIB, cpuHeadroomPercent: 50,
      lanes: ['claude', 'codex'], jobsRunning: ['job-1'], freeSlots: 0,
    });
    expect(view.nodes[2]).toMatchObject({ freeMemoryBytes: 'unknown', cpuHeadroomPercent: 'unknown', jobsRunning: [] });
    expect(nodesThatCanTake(view, 'claude').map(row => row.name)).toEqual(['node-a']);
    expect(nodesThatCanTake(view, 'gemini')).toEqual([]);
  });

  it('one offline: says since when, today and on an earlier day', () => {
    const view = readNodesView(deps(tailnet([peer('node-b', false), peer('node-c', false, '2026-11-14T08:05:00Z'), peer('node-d', false, '0001-01-01T00:00:00Z')]),
      registry([node('node-a'), node('node-b', { expiresAt: NOW - 60_000 })])));
    expect(view.nodes.map(row => [row.name, row.reachable, row.state])).toEqual([
      ['node-a', true, 'ready for work'],
      ['node-b', false, 'offline since 10:42'],
      ['node-c', false, 'offline since Nov 14 08:05'],
      ['node-d', false, 'offline'],
    ]);
    expect(view.nodes[1]).toMatchObject({ lastSeen: '2026-11-17T10:42:00.000Z', phantom: 'not-running', lanes: ['claude', 'codex'] });
    expect(nodesThatCanTake(view, 'codex').map(row => row.name)).toEqual(['node-a']);
  });

  it('Phantom not running: a reachable computer with no live heartbeat is told to join', () => {
    const view = readNodesView(deps(tailnet([peer('node-b', true), peer('node-c', true)]), registry([node('node-a'), node('node-c', { expiresAt: NOW - 1 })])));
    for (const row of view.nodes.slice(1)) {
      expect(row).toMatchObject({ reachable: true, phantom: 'not-running', stateCode: 'not-running', state: 'reachable but Phantom not running: run `phm node join` there' });
    }
    expect(nodesThatCanTake(view, 'claude').map(row => row.name)).toEqual(['node-a']);
  });

  it('missing tailscale: reachability is unknown with the reason, registry facts still shown', () => {
    const view = readNodesView(deps(null, registry([node('node-a'), node('node-b')])));
    expect(view.reasons).toEqual(['tailscale unavailable or status unreadable']);
    expect(view.self).toBe('node-a');
    expect(view.nodes.map(row => [row.name, row.reachable, row.state])).toEqual([['node-a', true, 'ready for work'], ['node-b', 'unknown', 'ready for work']]);
    expect(view.nodes[1]?.lastSeen).toBe('2026-11-17T11:59:58.000Z');
  });

  it('never guesses: stopped tailscale, unreadable or remote registry and a stale mirror stay unknown', () => {
    const stopped = readNodesView(deps(tailnet([peer('node-b', true)], 'Stopped'), new Error('/fake-home/.ashlr/nodes boom')));
    expect(stopped.registry).toBe('unknown');
    expect(stopped.reasons).toEqual(['tailscale backend not running: Stopped', 'node list unreadable; Phantom status unknown']);
    expect(stopped.nodes).toMatchObject([{ name: 'node-a', phantom: 'unknown', state: 'reachable; Phantom status unknown' }]);
    expect(JSON.stringify(stopped)).not.toContain('boom');

    const worker = readNodesView(deps(tailnet([peer('node-b', true)]), { source: 'elsewhere', state: null, selfNode: 'node-a' }));
    expect(worker.nodes.map(row => row.phantom)).toEqual(['unknown', 'unknown']);
    expect(worker.reasons).toEqual(['the node list lives on the pool primary: run `phm nodes` there']);

    const mirror = registry([node('node-a'), node('node-b', { heartbeatAt: NOW - 600_000, expiresAt: NOW - 590_000 })], [], { source: 'pool-mirror' });
    mirror.state!.observedAt = NOW - 600_000;
    const stale = readNodesView(deps(tailnet([peer('node-b', true)]), mirror));
    expect(stale.nodes[1]).toMatchObject({ phantom: 'unknown', stateCode: 'unknown' });
    expect(stale.reasons).toEqual(['pool mirror last updated 11:50; newer node state unknown']);
  });
});

describe('phm nodes', () => {
  const run = async (args: string[], d = deps(tailnet([peer('node-b', true)]), registry([node('node-a'), node('node-b', { caps: ['codex'] })]))) => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await cmdNodes(args, d);
    return { code, out: out.mock.calls.map(call => String(call[0])).join('\n'), err: err.mock.calls.length };
  };

  it('prints stable JSON with a fixed key order', async () => {
    const first = await run(['--json']);
    vi.restoreAllMocks();
    expect((await run(['--json'])).out).toBe(first.out);
    const view = JSON.parse(first.out);
    expect(Object.keys(view)).toEqual(['schemaVersion', 'asOf', 'self', 'registry', 'nodes', 'reasons']);
    expect(Object.keys(view.nodes[0])).toEqual(['name', 'isSelf', 'reachable', 'lastSeen', 'phantom', 'freeMemoryBytes', 'cpuHeadroomPercent',
      'lanes', 'jobsRunning', 'freeSlots', 'stateCode', 'state']);
  });

  it('--can-take lists only computers ready for that lane', async () => {
    const json = JSON.parse((await run(['--can-take', 'claude', '--json'])).out);
    expect([json.canTake, json.nodes.map((row: { name: string }) => row.name)]).toEqual(['claude', ['node-a']]);
    vi.restoreAllMocks();
    expect((await run(['--can-take', 'gemini'])).out).toBe('No computer can take a gemini job now. Run `phm nodes` to see why.');
  });

  it('prints one plain row per computer and refuses bad flags', async () => {
    expect((await run([])).out).toBe([
      'node-a (this computer): ready for work | memory free 12.0 GB | CPU free 75% | lanes claude,codex | jobs 0',
      'node-b: ready for work | memory free unknown | CPU free unknown | lanes codex | jobs 0',
    ].join('\n'));
    vi.restoreAllMocks();
    for (const bad of [['--nope'], ['--can-take'], ['--can-take', 'Bad Lane'], ['--json', '--json']]) {
      expect(await run(bad)).toMatchObject({ code: 2, err: 1 });
      vi.restoreAllMocks();
    }
    expect(await run(['--help'])).toMatchObject({ code: 0, err: 0 });
  });
});

describe('GET /api/verse/fleet/runtime-identity/nodes', () => {
  const call = async (nodesDeps: NodesViewDeps, method = 'GET') => {
    let status = 0, text = '';
    const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
    const api = createFleetRuntimeIdentityApi({ hostReach: createFleetHostReachApi({ nodesDeps, now: () => new Date(NOW) }) });
    const handled = await api({ cfg: {}, allowDispatch: true } as VerseApiContext, {} as IncomingMessage, res, VERSE_FLEET_NODES_PATH, method);
    return { handled, status, body: JSON.parse(text) };
  };

  it('serves the same rows as the CLI, in the shape the Computers panel reads', async () => {
    const d = deps(tailnet([peer('node-b', false)]), registry([node('node-a')]));
    const { handled, status, body } = await call(d);
    expect([handled, status]).toEqual([true, 200]);
    expect(body).toEqual({ v: 1, generatedAt: '2026-11-17T12:00:00.000Z', ...readNodesView(d) });
    expect(narrowComputers(body)?.computers.map(card => [card.name, card.stateCode, card.state, card.jobsRunning])).toEqual([
      ['node-a', 'ready', 'ready for work', 0], ['node-b', 'offline', 'offline since 10:42', 0],
    ]);
    expect((await call(d, 'POST')).status).toBe(405);
  });

  it('a throwing reader is unknown, never the thrown text', async () => {
    const broken = { ...deps(null, NO_POOL), peers: { now: () => { throw new Error('boom'); }, homeDir: () => '', exec: () => '' } };
    const { body } = await call(broken);
    expect(body.nodes).toHaveLength(1);
    expect(body.asOf).toBe('unknown');
    expect(JSON.stringify(body)).not.toContain('boom');
  });
});
