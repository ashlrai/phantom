/** `phm nodes doctor`: fake probe adapter, injected tailnet and registry. No real machine, home or CLI is touched. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdNodes } from '../src/cli/nodes.js';
import { NODES_DOCTOR_SCHEMA, readNodesDoctor, type NodeProbe, type NodeProbeReply } from '../src/core/fleet/nodes-doctor.js';
import type { NodesRegistry, NodesViewDeps } from '../src/core/fleet/nodes-view.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const GB = 1e9;
const tailnet = (peers: Array<[string, boolean]>) => JSON.stringify({
  BackendState: 'Running', Self: { HostName: 'home-mac' },
  Peer: Object.fromEntries(peers.map(([name, online], i) => [`k${i}`, { HostName: name, OS: 'macOS', Online: online, LastSeen: '2026-11-17T10:00:00Z' }])),
});
const NO_POOL: NodesRegistry = { source: 'none', state: null, selfNode: null, pool: null };
const deps = (peers: Array<[string, boolean]>): NodesViewDeps => ({
  peers: { now: () => new Date(NOW), homeDir: () => '/fake-home', exec: () => tailnet(peers) },
  readRegistry: () => NO_POOL, hostName: () => 'home-mac', timeZone: 'UTC',
  localStats: () => ({ sampledAtMs: NOW, uptimeSeconds: 1, load: [1, 1, 1], ramTotal: 8, ramUsed: 4, diskFree: null, cores: [{ total: 1, idle: 1 }] }),
});
const allReady = { installed: true, signedIn: true } as const;
const healthy = (overrides: NodeProbeReply['lanes'] = {}, repos = ['phantom', 'ashlr-md']): NodeProbeReply => ({
  lanes: { claude: allReady, codex: allReady, devin: allReady, gemini: allReady, 'local-model': allReady, ...overrides }, repos, diskFreeBytes: 120 * GB,
});
/** Fake adapter: answers per computer name; unlisted names cannot be probed. */
const fake = (replies: Record<string, NodeProbeReply | null>): NodeProbe => async node => replies[node] ?? null;

afterEach(() => { vi.restoreAllMocks(); });

describe('readNodesDoctor', () => {
  it('healthy node: every lane ok, repos and disk known, no gaps', async () => {
    const report = await readNodesDoctor({ view: deps([['studio-mac', true]]), probe: fake({ 'home-mac': healthy(), 'studio-mac': healthy() }) });
    expect(report.schema).toBe(NODES_DOCTOR_SCHEMA);
    const studio = report.nodes.find(n => n.name === 'studio-mac')!;
    expect(studio).toMatchObject({ reachable: true, diskFreeGb: 120, repos: ['phantom', 'ashlr-md'], missingRepos: [], gaps: [], unknowns: [], ready: true });
    expect(studio.lanes.map(l => l.status)).toEqual(['ready', 'ready', 'ready', 'ready', 'ready']);
  });

  it('missing CLI: one plain install line', async () => {
    const report = await readNodesDoctor({ view: deps([['studio-mac', true]]),
      probe: fake({ 'home-mac': healthy(), 'studio-mac': healthy({ gemini: { installed: false, signedIn: false } }) }) }, 'studio-mac');
    expect(report.nodes).toHaveLength(1);
    expect(report.nodes[0]!.gaps).toEqual(['studio-mac: gemini is not installed. Install it on that Mac.']);
    expect(report.nodes[0]!.ready).toBe(false);
  });

  it('signed-out lane: names the login command', async () => {
    const report = await readNodesDoctor({ view: deps([['studio-mac', true]]),
      probe: fake({ 'home-mac': healthy(), 'studio-mac': healthy({ codex: { installed: true, signedIn: false } }) }) });
    expect(report.nodes.find(n => n.name === 'studio-mac')!.gaps).toEqual(['studio-mac: codex is not signed in. Run `codex login` on that Mac.']);
  });

  it('low disk and a missing repo each get one fix line', async () => {
    const low: NodeProbeReply = { ...healthy({}, ['phantom']), diskFreeBytes: 12.34 * GB };
    const report = await readNodesDoctor({ view: deps([['studio-mac', true]]), probe: fake({ 'home-mac': healthy(), 'studio-mac': low }) });
    const gaps = report.nodes.find(n => n.name === 'studio-mac')!.gaps;
    expect(gaps).toEqual([
      'studio-mac: only 12.3 GB free; jobs hold under 20 GB. Free space on that Mac.',
      'studio-mac: missing repo ashlr-md. Clone it under ~/Projects/ashlrai on that Mac.',
    ]);
  });

  it('offline node: not reachable, everything else unknown with a reason, never probed', async () => {
    const probe = vi.fn<NodeProbe>(async () => healthy());
    const report = await readNodesDoctor({ view: deps([['studio-mac', false]]), probe });
    const studio = report.nodes.find(n => n.name === 'studio-mac')!;
    expect(probe).toHaveBeenCalledTimes(1); // this computer only
    expect(studio.reachable).toBe(false);
    expect(studio.gaps).toEqual(['studio-mac: not reachable. Wake it and check it is on Tailscale.']);
    expect(studio.diskFreeGb).toBe('unknown');
    expect(studio.repos).toBe('unknown');
    expect(studio.lanes.every(l => l.status === 'unknown' && l.reason === 'computer is offline')).toBe(true);
  });

  it('a computer that cannot be probed stays unknown, never guessed', async () => {
    const report = await readNodesDoctor({ view: deps([['studio-mac', true]]), probe: fake({ 'home-mac': healthy() }) });
    const studio = report.nodes.find(n => n.name === 'studio-mac')!;
    expect(studio.gaps).toEqual([]);
    expect(studio.lanes.every(l => l.status === 'unknown')).toBe(true);
    expect(studio.diskFreeGb).toBe('unknown');
    expect(studio.unknowns.some(u => u.includes('repo clones unknown'))).toBe(true);
    expect(studio.ready).toBe(false);
  });

  it('standalone registry: a peer named like a local node id never inherits this disk', async () => {
    // The standalone store is single-host, so the laptop record is this
    // computer's session; the tailnet peer named laptop is not probed and
    // must report unknown disk, not this machine's 5 GB host stat.
    const local: NodesRegistry = { source: 'local', selfNode: null, pool: null, state: {
      version: 'drive.nodes.v1', sequence: 1, observedAt: NOW - 1_000,
      nodes: [{ nodeId: 'laptop', session: 1, heartbeatAt: NOW - 2_000, expiresAt: NOW + 30_000,
        hostStats: { sampledAtMs: NOW, uptimeSeconds: 1, load: [1, 1, 1], ramTotal: 8, ramUsed: 4, diskFree: 5 * GB, cores: [{ total: 1, idle: 1 }] } }],
      leader: null, jobs: [] } };
    const viewDeps: NodesViewDeps = { ...deps([['laptop', true]]), readRegistry: () => local };
    const report = await readNodesDoctor({ view: viewDeps, probe: fake({ 'home-mac': healthy() }) });
    const peer = report.nodes.find(n => n.name === 'laptop')!;
    expect(peer.diskFreeGb).toBe('unknown');
    expect(peer.gaps.some(g => g.includes('GB free'))).toBe(false);
    expect(peer.unknowns.some(u => u.includes('free disk unknown'))).toBe(true);
  });

  it('a reachable computer with no live Phantom session is a gap, never ready', async () => {
    // NO_POOL leaves this computer's standalone registry empty, so the view
    // proves Phantom is not running here even though every lane checks out.
    const report = await readNodesDoctor({ view: deps([]), probe: fake({ 'home-mac': healthy() }) });
    const self = report.nodes.find(n => n.name === 'home-mac')!;
    expect(self.gaps).toEqual(['home-mac: reachable but Phantom not running: run `phm node join --owner <scope>` here']);
    expect(self.ready).toBe(false);
  });

  it('a throwing adapter is unknown, not a crash', async () => {
    const report = await readNodesDoctor({ view: deps([]), probe: async () => { throw new Error('boom'); } });
    expect(report.nodes[0]!.repos).toBe('unknown');
  });
});

describe('phm nodes doctor', () => {
  it('--json carries the schema id', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await cmdNodes(['doctor', '--json'], deps([['studio-mac', true]]), undefined, fake({ 'home-mac': healthy() }));
    expect(code).toBe(0);
    expect(JSON.parse(String(out.mock.calls[0]![0])).schema).toBe('phantom.nodes-doctor.v1');
  });

  it('--node with an unknown name exits 1; bad flags exit 2', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdNodes(['doctor', '--node', 'nope'], deps([]), undefined, fake({}))).toBe(1);
    expect(await cmdNodes(['doctor', '--bogus'], deps([]), undefined, fake({}))).toBe(2);
  });

  it('human output prints a fix line', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdNodes(['doctor'], deps([['studio-mac', true]]), undefined,
      fake({ 'home-mac': healthy(), 'studio-mac': healthy({ codex: { installed: true, signedIn: false } }) }));
    expect(String(out.mock.calls[0]![0])).toContain('fix: studio-mac: codex is not signed in. Run `codex login` on that Mac.');
  });
});
