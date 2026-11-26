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
import { chooseNodeForLane, nodesThatCanTake, readNodesView, type NodesRegistry, type NodesViewDeps } from '../src/core/fleet/nodes-view.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const GIB = 1024 ** 3;
const stats = (usedGib: number, load: number): HostStats => ({
  sampledAtMs: NOW, uptimeSeconds: 60, load: [load, load, load], ramTotal: 32 * GIB, ramUsed: usedGib * GIB, diskFree: null,
  cores: Array.from({ length: 8 }, () => ({ total: 100, idle: 50 })),
});
const node = (nodeId: string, extra: Partial<NodeRecord> = {}): NodeRecord => ({
  nodeId, session: 1, heartbeatAt: NOW - 2_000, expiresAt: NOW + 30_000, caps: ['claude', 'codex'], slots: 2, ...extra,
});
const POOL = { owner: 'acme', primary: 'primary-mac', backup: 'backup-mac' };
const JOIN = 'phm node join --owner acme --primary primary-mac --backup backup-mac';
const registry = (nodes: NodeRecord[], jobs: NodesState['jobs'] = [], extra: Partial<NodesRegistry> = {}): NodesRegistry => ({
  source: 'pool-witness', selfNode: 'node-a', pool: POOL, state: { version: 'drive.nodes.v1', sequence: 9, observedAt: NOW - 1_000, nodes, leader: null, jobs }, ...extra,
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
const NO_POOL: NodesRegistry = { source: 'none', state: null, selfNode: null, pool: null };

afterEach(() => { vi.restoreAllMocks(); });

describe('readNodesView', () => {
  it('local only: one row for this computer, measured here, told how to join', () => {
    const view = readNodesView(deps(tailnet([]), NO_POOL));
    expect(view).toEqual({
      schema: 'phantom.nodes-view.v1', schemaVersion: 1, asOf: '2026-11-17T12:00:00.000Z', self: 'node-a', registry: 'none',
      nodes: [{
        name: 'node-a', isSelf: true, reachable: true, lastSeen: '2026-11-17T12:00:00.000Z', phantom: 'not-running',
        heartbeatAgeSeconds: 'unknown', freeMemoryBytes: 12 * GIB, freeMemoryPercent: 38, load: 2, cpuHeadroomPercent: 75, lanes: 'unknown', jobsRunning: 'unknown', freeSlots: 'unknown',
        stateCode: 'not-running', state: 'reachable but Phantom not running: run `phm node join --owner <scope>` here',
        joined: true, joinCommand: null,
      }],
      reasons: ['no node pool on this computer: other computers cannot join its list (docs/NODES.md)'],
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

  it('frees slots for claims no live session can still act on', () => {
    const view = readNodesView(deps(tailnet([peer('node-b', true)]), registry(
      [node('node-a', { slots: 1 }), node('node-b', { session: 2, slots: 1 })],
      [
        { id: 'held', state: 'running', claim: { jobId: 'held', nodeId: 'node-a', session: 1, token: 2, leaderToken: 1, expiresAt: NOW + 5_000 } },
        { id: 'lapsed', state: 'running', claim: { jobId: 'lapsed', nodeId: 'node-b', session: 2, token: 3, leaderToken: 1, expiresAt: NOW - 1 } },
        { id: 'fenced', state: 'running', claim: { jobId: 'fenced', nodeId: 'node-b', session: 1, token: 4, leaderToken: 1, expiresAt: NOW + 5_000 } },
        { id: 'queued', state: 'pending' },
      ],
    )));
    expect(view.nodes.find(row => row.name === 'node-a')).toMatchObject({ jobsRunning: ['held'], freeSlots: 0, stateCode: 'busy' });
    expect(view.nodes.find(row => row.name === 'node-b')).toMatchObject({ jobsRunning: [], freeSlots: 1, stateCode: 'ready' });
    expect(nodesThatCanTake(view, 'codex').map(row => row.name)).toEqual(['node-b']);
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

  it('Phantom not running: a reachable computer is told the command that actually joins it', () => {
    const view = readNodesView(deps(tailnet([peer('node-b', true), peer('node-c', true)]), registry([node('node-a'), node('node-c', { expiresAt: NOW - 1 })])));
    // node-b was never enrolled: it needs the full pool command. node-c holds an
    // expired session: a configured Mac re-enrolls with bare `phm node join`.
    expect(view.nodes[1]).toMatchObject({ name: 'node-b', reachable: true, phantom: 'not-running', stateCode: 'not-running', joined: false,
      state: `reachable but Phantom not running: run \`${JOIN}\` there`, joinCommand: JOIN });
    expect(view.nodes[2]).toMatchObject({ name: 'node-c', reachable: true, phantom: 'not-running', stateCode: 'not-running', joined: true,
      state: 'reachable but Phantom not running: run `phm node join` there', joinCommand: null });
    expect(nodesThatCanTake(view, 'claude').map(row => row.name)).toEqual(['node-a']);
  });

  it('standalone registry: records are this computer whatever id they joined under', () => {
    const local = (nodes: NodeRecord[]): NodesRegistry => ({ source: 'local', selfNode: null, pool: null, state: {
      version: 'drive.nodes.v1', sequence: 3, observedAt: NOW - 1_000, nodes, leader: null, jobs: [] } });
    // The documented join (`phm node join --node laptop --owner acme --caps
    // build,gh`) leaves a record whose id is not this computer's tailnet name.
    // The standalone store is single-host, so the record is this computer:
    // the self row reports Phantom running and the peer named laptop stays
    // not joined instead of inheriting the local heartbeat. With no node pool
    // the peer cannot join this computer's list at all, so no command is shown.
    const view = readNodesView(deps(tailnet([peer('laptop', true)]), local([node('laptop', { caps: ['build', 'gh'], slots: undefined })])));
    expect(view.nodes.map(row => [row.name, row.isSelf, row.phantom, row.state])).toEqual([
      ['node-a', true, 'running', 'Phantom running; free slots unknown'],
      ['laptop', false, 'not-running', 'reachable but Phantom not running'],
    ]);
    expect(view.nodes[0]).toMatchObject({ joined: true, joinCommand: null, lanes: ['build', 'gh'], jobsRunning: [], freeSlots: 'unknown' });
    expect(view.nodes[1]).toMatchObject({ joined: false, joinCommand: null, reachable: true, lanes: 'unknown' });
  });

  it('standalone registry: an expired local session is told the rejoin its record proves', () => {
    const view = readNodesView(deps(tailnet([]), { source: 'local', selfNode: null, pool: null, state: {
      version: 'drive.nodes.v1', sequence: 3, observedAt: NOW - 1_000,
      nodes: [node('laptop', { expiresAt: NOW - 1, owners: ['acme'] })], leader: null, jobs: [] } }));
    expect(view.nodes).toHaveLength(1);
    // The hint restores the last advertised profile — owners, caps and slots —
    // the same command a session-expired fix prints, so the suggested rejoin
    // never silently downgrades the node's capabilities.
    expect(view.nodes[0]).toMatchObject({ isSelf: true, phantom: 'not-running', stateCode: 'not-running',
      state: 'reachable but Phantom not running: run `phm node join --node laptop --owner acme --caps claude,codex --slots 2` here' });
  });

  it('standalone registry: a record with no advertised profile gets placeholders, not invented flags', () => {
    const view = readNodesView(deps(tailnet([]), { source: 'local', selfNode: null, pool: null, state: {
      version: 'drive.nodes.v1', sequence: 3, observedAt: NOW - 1_000,
      nodes: [node('laptop', { expiresAt: NOW - 1, owners: undefined, caps: undefined, slots: undefined })], leader: null, jobs: [] } }));
    expect(view.nodes[0]).toMatchObject({ isSelf: true, stateCode: 'not-running',
      state: 'reachable but Phantom not running: run `phm node join --node laptop --owner <scope>` here' });
  });

  it('missing tailscale: reachability is unknown with the reason, registry facts still shown', () => {
    const view = readNodesView(deps(null, registry([node('node-a'), node('node-b')])));
    expect(view.reasons).toEqual(['tailscale unavailable or status unreadable']);
    expect(view.self).toBe('node-a');
    expect(view.nodes.map(row => [row.name, row.reachable, row.state])).toEqual([['node-a', true, 'ready for work'], ['node-b', 'unknown', 'Phantom running; reachability unknown']]);
    expect(view.nodes[1]?.lastSeen).toBe('2026-11-17T11:59:58.000Z');
  });

  it('never guesses: stopped tailscale, unreadable or remote registry and a stale mirror stay unknown', () => {
    const stopped = readNodesView(deps(tailnet([peer('node-b', true)], 'Stopped'), new Error('/fake-home/.ashlr/nodes boom')));
    expect(stopped.registry).toBe('unknown');
    expect(stopped.reasons).toEqual(['tailscale backend not running: Stopped', 'node list unreadable; Phantom status unknown']);
    expect(stopped.nodes).toMatchObject([{ name: 'node-a', phantom: 'unknown', state: 'reachable; Phantom status unknown' }]);
    expect(JSON.stringify(stopped)).not.toContain('boom');

    const worker = readNodesView(deps(tailnet([peer('node-b', true)]), { source: 'elsewhere', state: null, selfNode: 'node-a', pool: POOL }));
    expect(worker.nodes.map(row => row.phantom)).toEqual(['unknown', 'unknown']);
    expect(worker.reasons).toEqual(['the node list lives on the pool primary: run `phm nodes` there']);

    const mirror = registry([node('node-a'), node('node-b', { heartbeatAt: NOW - 600_000, expiresAt: NOW - 590_000 })], [], { source: 'pool-mirror' });
    mirror.state!.observedAt = NOW - 600_000;
    const stale = readNodesView(deps(tailnet([peer('node-b', true)]), mirror));
    expect(stale.nodes[1]).toMatchObject({ phantom: 'unknown', stateCode: 'unknown', jobsRunning: 'unknown' });
    expect(stale.reasons).toEqual(['pool mirror last updated 11:50; newer node state unknown']);
  });
});

describe('chooseNodeForLane', () => {
  it('keeps a local-only pool local and honors an explicit local restriction', () => {
    const local = readNodesView(deps(tailnet([]), registry([node('node-a')])));
    expect(chooseNodeForLane(local, 'codex')).toMatchObject({ node: 'node-a', target: 'local', reason: 'local-only' });
    const pool = readNodesView(deps(tailnet([peer('node-b', true)]), registry([node('node-a'), node('node-b')])));
    expect(chooseNodeForLane(pool, 'codex', { localOnly: true })).toMatchObject({ node: 'node-a', reason: 'local-only' });
    expect(chooseNodeForLane({ ...pool, nodes: pool.nodes.slice(1) }, 'codex', { localOnly: true }))
      .toMatchObject({ node: null, target: 'none', reason: 'no-ready-node' });
  });

  it('prefers a ready remote computer and ranks remotes by free slots', () => {
    const view = readNodesView(deps(tailnet([peer('node-b', true), peer('node-c', true)]),
      registry([node('node-a', { slots: 10 }), node('node-b'), node('node-c', { slots: 3 })])));
    expect(chooseNodeForLane(view, 'codex')).toEqual({ lane: 'codex', node: 'node-c', target: 'remote', reason: 'remote-ready',
      explanation: 'Ready remote computer; most free slots first, then name.' });
  });

  it.each([
    ['offline', false, {}], ['expired heartbeat', true, { expiresAt: NOW }],
    ['full', true, { slots: 0 }], ['unmeasured slots', true, { slots: undefined }],
    ['wrong lane', true, { caps: ['claude'] }],
    ['held', true, { capacity: { hostId: 'node-b', sampledAtMs: NOW, ramBytes: 32 * GIB, slots: 2, held: 'memory-pressure' } }],
  ] satisfies [string, boolean, Partial<NodeRecord>][])('falls back locally when the remote is %s', (_reason, online, extra) => {
    const view = readNodesView(deps(tailnet([peer('node-b', online)]), registry([node('node-a'), node('node-b', extra)])));
    expect(nodesThatCanTake(view, 'codex').map(row => row.name)).toEqual(['node-a']);
    expect(chooseNodeForLane(view, 'codex')).toMatchObject({ node: 'node-a', target: 'local', reason: 'local-fallback' });
  });

  it('breaks remote ties by name regardless of input order without mutating the snapshot', () => {
    const view = readNodesView(deps(tailnet([peer('node-c', true), peer('node-b', true)]),
      registry([node('node-c'), node('node-a'), node('node-b')])));
    const before = JSON.stringify(view);
    const choice = chooseNodeForLane(view, 'codex');
    expect(choice.node).toBe('node-b');
    expect(chooseNodeForLane({ ...view, nodes: [...view.nodes].reverse() }, 'codex')).toEqual(choice);
    expect(JSON.stringify(view)).toBe(before);
  });

  it('does not place on unknown reachability or fabricate a ready local fallback', () => {
    const view = readNodesView(deps(null, registry([node('node-a'), node('node-b')])));
    expect(chooseNodeForLane(view, 'codex')).toMatchObject({ node: 'node-a', reason: 'local-fallback' });
    for (const empty of [readNodesView(deps(tailnet([]), NO_POOL)), { ...view, nodes: view.nodes.slice(1) }]) {
      expect(chooseNodeForLane(empty, 'codex')).toMatchObject({ node: null, target: 'none', reason: 'no-ready-node' });
    }
  });

  it('rejects stale mirror evidence even when copied node leases have not expired', () => {
    const mirror = registry([node('node-a'), node('node-b')], [], { source: 'pool-mirror' });
    mirror.state!.observedAt = NOW - 600_000;
    const view = readNodesView(deps(tailnet([peer('node-b', true)]), mirror));
    expect(nodesThatCanTake(view, 'codex')).toEqual([]);
    expect(chooseNodeForLane(view, 'codex')).toMatchObject({ node: null, reason: 'no-ready-node' });
  });

  it('does not inherit a lane from an expired record on an otherwise ready computer', () => {
    const view = readNodesView(deps(tailnet([peer('node-b', true)]), registry([
      node('node-a'), node('node-b'), node('old-worker', { expiresAt: NOW, caps: ['gemini'],
        capacity: { hostId: 'node-b', sampledAtMs: NOW, ramBytes: 32 * GIB, slots: 2 } }),
    ])));
    expect(view.nodes[1]?.lanes).toEqual(['claude', 'codex']);
    expect(chooseNodeForLane(view, 'gemini')).toMatchObject({ node: null, reason: 'no-ready-node' });
  });
});

describe('machines: one, two with one offline, none', () => {
  it('two machines, one silent for over 5 minutes: offline, with heartbeat age; stale stats stay unknown', () => {
    const view = readNodesView(deps(tailnet([]), registry([
      node('node-a'), node('mac-two', { heartbeatAt: NOW - 6 * 60_000, expiresAt: NOW - 5 * 60_000, hostStats: stats(8, 1.5) }),
    ])));
    expect(view.schema).toBe('phantom.nodes-view.v1');
    expect(view.nodes.map(row => [row.name, row.stateCode, row.heartbeatAgeSeconds])).toEqual([['node-a', 'ready', 2], ['mac-two', 'offline', 360]]);
    expect(view.nodes[1]).toMatchObject({ reachable: false, freeSlots: 'unknown', freeMemoryPercent: 'unknown', load: 'unknown' });
    expect(view.nodes[0]).toMatchObject({ freeMemoryPercent: 38, load: 2, freeSlots: 2 });
  });

  it('a fresh heartbeat is not offline', () => {
    const view = readNodesView(deps(tailnet([]), registry([node('node-a'), node('mac-two', { heartbeatAt: NOW - 60_000 })])));
    expect(view.nodes[1]?.stateCode).not.toBe('offline');
  });

  it('none: the view lists only this computer', () => {
    const view = readNodesView(deps(tailnet([]), NO_POOL));
    expect(view.nodes).toHaveLength(1);
    expect(view.nodes[0]?.isSelf).toBe(true);
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
    expect(Object.keys(view)).toEqual(['schema', 'schemaVersion', 'asOf', 'self', 'registry', 'nodes', 'reasons']);
    expect(Object.keys(view.nodes[0])).toEqual(['name', 'isSelf', 'reachable', 'lastSeen', 'heartbeatAgeSeconds', 'phantom', 'freeMemoryBytes', 'freeMemoryPercent',
      'load', 'cpuHeadroomPercent', 'lanes', 'jobsRunning', 'freeSlots', 'stateCode', 'state', 'joined', 'joinCommand']);
  });

  it('--can-take lists only computers ready for that lane', async () => {
    const json = JSON.parse((await run(['--can-take', 'claude', '--json'])).out);
    expect([json.canTake, json.nodes.map((row: { name: string }) => row.name)]).toEqual(['claude', ['node-a']]);
    expect(json.placement).toMatchObject({ node: 'node-a', reason: 'local-fallback' });
    vi.restoreAllMocks();
    expect((await run(['--can-take', 'gemini'])).out).toBe('No computer can take a gemini job now. Run `phm nodes` to see why.');
  });

  it('exposes the same remote choice in JSON and plain words, and null when no lane is ready', async () => {
    const json = JSON.parse((await run(['--can-take', 'codex', '--json'])).out);
    expect(json.placement).toMatchObject({ lane: 'codex', node: 'node-b', target: 'remote', reason: 'remote-ready' });
    vi.restoreAllMocks();
    expect((await run(['--can-take', 'codex'])).out).toContain(`Suggested computer: node-b. ${json.placement.explanation}`);
    vi.restoreAllMocks();
    expect(JSON.parse((await run(['--can-take', 'gemini', '--json'])).out).placement)
      .toMatchObject({ node: null, target: 'none', reason: 'no-ready-node' });
  });

  it('says "Only this Mac." when no other computer is known', async () => {
    const solo = await run([], deps(tailnet([]), NO_POOL));
    expect(solo.out.split('\n')).toContain('Only this Mac.');
    expect((await run([])).out).not.toContain('Only this Mac.');
    expect(JSON.parse((await run(['--json'], deps(tailnet([]), NO_POOL))).out).schema).toBe('phantom.nodes-view.v1');
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
