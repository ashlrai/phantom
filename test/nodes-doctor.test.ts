/** `phm nodes doctor`: fake probe adapter, injected tailnet and registry. No real machine, home or CLI is touched. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdNodes } from '../src/cli/nodes.js';
import { NODES_DOCTOR_SCHEMA, localProbe, readNodesDoctor, type NodeProbe, type NodeProbeReply } from '../src/core/fleet/nodes-doctor.js';
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

  it('offline node: one shared cause prints one unknown line, not one per check', async () => {
    // Every lane check reports 'computer is offline'; the unknowns list is a
    // set of reasons, so the identical line collapses to its first occurrence
    // while disk and repo unknowns (different wording) still print.
    const report = await readNodesDoctor({ view: deps([['studio-mac', false]]), probe: fake({ 'home-mac': healthy() }) });
    const studio = report.nodes.find(n => n.name === 'studio-mac')!;
    expect(studio.unknowns.filter(u => u === 'studio-mac: computer is offline')).toHaveLength(1);
    expect(new Set(studio.unknowns).size).toBe(studio.unknowns.length);
    expect(studio.unknowns).toEqual([
      'studio-mac: computer is offline',
      'studio-mac: free disk unknown (no measurement from that computer)',
      'studio-mac: repo clones unknown (computer is offline)',
    ]);
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

  it('a remote node advertising omlx caps is local-model ready; a pack cap is not', async () => {
    // Remote probes do not exist yet, so lane readiness falls back to the
    // advertised caps. Workers publish the oMLX family (`omlx`, `omlx-<tier>`)
    // for local-model work; `local-model` is the report name, not a cap.
    const pool: NodesRegistry = { source: 'pool-witness', selfNode: 'home-mac',
      pool: { owner: 'acme', primary: 'primary-mac', backup: 'backup-mac' }, state: {
        version: 'drive.nodes.v1', sequence: 1, observedAt: NOW - 1_000,
        nodes: [
          { nodeId: 'node-b', session: 1, heartbeatAt: NOW - 2_000, expiresAt: NOW + 30_000, caps: ['omlx', 'omlx-work'], slots: 2 },
          { nodeId: 'node-c', session: 1, heartbeatAt: NOW - 2_000, expiresAt: NOW + 30_000, caps: ['pack:omlx-chat'], slots: 2 },
        ],
        leader: null, jobs: [] } };
    const viewDeps: NodesViewDeps = { ...deps([['node-b', true], ['node-c', true]]), readRegistry: () => pool };
    const report = await readNodesDoctor({ view: viewDeps, probe: fake({ 'home-mac': healthy() }) });
    const b = report.nodes.find(n => n.name === 'node-b')!;
    expect(b.lanes.find(l => l.lane === 'local-model')).toMatchObject({ status: 'ready' });
    expect(b.lanes.find(l => l.lane === 'claude')).toMatchObject({ status: 'unknown' });
    expect(report.nodes.find(n => n.name === 'node-c')!.lanes.find(l => l.lane === 'local-model')!.status).toBe('unknown');
  });

  it('an expired record never vouches for disk; only a live session does', async () => {
    // node-b's only registry record is an expired session: the nodes view
    // already reports its memory/load as unknown, so the doctor's disk
    // fallback must not resurrect its last hostStats figure either. node-c's
    // live record still measures disk normally.
    const stats = (diskFree: number) => ({ sampledAtMs: NOW - 2_000, uptimeSeconds: 1, load: [1, 1, 1], ramTotal: 8, ramUsed: 4, diskFree, cores: [{ total: 1, idle: 1 }] });
    const pool: NodesRegistry = { source: 'pool-witness', selfNode: 'home-mac',
      pool: { owner: 'acme', primary: 'primary-mac', backup: 'backup-mac' }, state: {
        version: 'drive.nodes.v1', sequence: 1, observedAt: NOW - 1_000,
        nodes: [
          { nodeId: 'node-b', session: 1, heartbeatAt: NOW - 7_200_000, expiresAt: NOW - 7_100_000, caps: ['codex'], slots: 2, hostStats: stats(120 * GB) },
          { nodeId: 'node-c', session: 1, heartbeatAt: NOW - 2_000, expiresAt: NOW + 30_000, caps: ['codex'], slots: 2, hostStats: stats(80 * GB) },
        ],
        leader: null, jobs: [] } };
    const viewDeps: NodesViewDeps = { ...deps([['node-b', true], ['node-c', true]]), readRegistry: () => pool };
    const report = await readNodesDoctor({ view: viewDeps, probe: fake({ 'home-mac': healthy() }) });
    const b = report.nodes.find(n => n.name === 'node-b')!;
    expect(b.diskFreeGb).toBe('unknown');
    expect(b.unknowns.some(u => u.includes('free disk unknown'))).toBe(true);
    expect(b.gaps.some(g => g.includes('GB free'))).toBe(false);
    const c = report.nodes.find(n => n.name === 'node-c')!;
    expect(c.diskFreeGb).toBe(80);
    expect(c.unknowns.some(u => u.includes('free disk unknown'))).toBe(false);
  });

  it('a reachable computer with no live Phantom session is a gap, never ready', async () => {
    // NO_POOL leaves this computer's standalone registry empty, so the view
    // proves Phantom is not running here even though every lane checks out.
    const report = await readNodesDoctor({ view: deps([]), probe: fake({ 'home-mac': healthy() }) });
    const self = report.nodes.find(n => n.name === 'home-mac')!;
    expect(self.gaps).toEqual(['home-mac: reachable but Phantom not running: run `phm node join --owner <scope> --watch` here']);
    expect(self.ready).toBe(false);
  });

  it('a throwing adapter is unknown, not a crash', async () => {
    const report = await readNodesDoctor({ view: deps([]), probe: async () => { throw new Error('boom'); } });
    expect(report.nodes[0]!.repos).toBe('unknown');
  });

  it('an unknown lane check prints the probe reason when one is given', async () => {
    // A probe that found the binary but could not complete its check says why;
    // the generic "no sign-in check" wording is only the fallback.
    const reason = 'claude is installed but did not answer `--version`';
    const report = await readNodesDoctor({ view: deps([['studio-mac', true]]),
      probe: fake({ 'home-mac': healthy(), 'studio-mac': healthy({ claude: { installed: true, signedIn: 'unknown', reason } }) }) });
    const claude = report.nodes.find(n => n.name === 'studio-mac')!.lanes.find(l => l.lane === 'claude')!;
    expect(claude).toMatchObject({ status: 'unknown', reason });
    expect(report.nodes.find(n => n.name === 'studio-mac')!.unknowns).toContain(`studio-mac: ${reason}`);
  });
});

describe('localProbe lane verdicts', () => {
  // Fake binaries under a scratch home; system allowlist dirs may also hold a
  // lane binary, but the stubbed runner answers every path the same, so the
  // verdicts below never depend on which host paths exist.
  let home: string;
  const touch = (name: string) => {
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(join(home, '.local', 'bin', name), '#!/bin/sh\n', { mode: 0o755 });
  };
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'nodes-doctor-'));
    touch('claude');
    touch('gemini');
  });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  const timedOut = { status: null, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) };
  const runFn = (handler: (args: string[]) => { status: number | null; error?: Error }) =>
    vi.fn((_binary: string, args: string[]) => handler(args)) as unknown as typeof spawnSync;

  it('a binary that exists but cannot answer --version is unknown, never "not installed"', () => {
    const reply = localProbe(runFn(() => timedOut), home);
    expect(reply.lanes['claude']).toMatchObject({ installed: true, signedIn: 'unknown' });
    expect(reply.lanes['claude']!.reason).toContain('`--version`');
  });

  it('a sign-in check that cannot run is unknown, never "signed out"', () => {
    const reply = localProbe(runFn(args => args[0] === '--version' ? { status: 0 } : timedOut), home);
    expect(reply.lanes['claude']).toMatchObject({ installed: true, signedIn: 'unknown' });
    expect(reply.lanes['claude']!.reason).toContain('sign-in check');
  });

  it('a nonzero sign-in exit is still a definitive signed-out', () => {
    const reply = localProbe(runFn(args => ({ status: args[0] === '--version' ? 0 : 1 })), home);
    expect(reply.lanes['claude']).toMatchObject({ installed: true, signedIn: false });
    expect(reply.lanes['claude']!.reason).toBeUndefined();
  });

  it('a lane with no sign-in command stays unknown without a probe reason', () => {
    const reply = localProbe(runFn(() => ({ status: 0 })), home);
    expect(reply.lanes['gemini']).toMatchObject({ installed: true, signedIn: 'unknown' });
    expect(reply.lanes['gemini']!.reason).toBeUndefined();
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

  it('human output prints the view reasons the JSON carries', async () => {
    // NO_POOL leaves this computer with no node pool, so a reachable remote
    // computer gets no join command; the reason that explains why must reach
    // the text output the same way `phm nodes` prints it, not stay JSON-only.
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdNodes(['doctor'], deps([['studio-mac', true]]), undefined, fake({ 'home-mac': healthy(), 'studio-mac': healthy() }));
    expect(String(out.mock.calls[0]![0])).toContain('note: no node pool on this computer');
  });
});
