/** `phm nodes offload`: every source is injected; no real tailscale, home, registry, queue or guard is read. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdNodes } from '../src/cli/nodes.js';
import type { HostStats, NodeRecord, NodesState } from '../src/core/drive/nodes/state.js';
import type { NodeProbe, NodeProbeReply } from '../src/core/fleet/nodes-doctor.js';
import { NODES_OFFLOAD_EVENT_SCHEMA, readRecordedOffloads, recordOffloadMoves, NODES_OFFLOAD_SCHEMA, assessHostGuard, readNodesOffload, readOffloadEnabled, writeOffloadEnabled, type HostGuardInputs, type NodesOffloadDeps } from '../src/core/fleet/nodes-offload.js';
import type { NodesRegistry, NodesViewDeps } from '../src/core/fleet/nodes-view.js';
import { ENGINE_ADMISSION_POLICY } from '../src/core/fleet/engine-admission-view.js';
import type { QueueOrderJob, QueueOrderV1 } from '../src/core/queue/order-types.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const GIB = 1024 ** 3;
const stats = (load: number): HostStats => ({ sampledAtMs: NOW, uptimeSeconds: 60, load: [load, load, load], ramTotal: 32 * GIB, ramUsed: 8 * GIB, diskFree: null,
  cores: Array.from({ length: 8 }, () => ({ total: 100, idle: 50 })) });
const node = (nodeId: string, extra: Partial<NodeRecord> = {}): NodeRecord =>
  ({ nodeId, session: 1, heartbeatAt: NOW - 2_000, expiresAt: NOW + 30_000, caps: ['claude', 'codex'], slots: 2, hostStats: stats(1), ...extra });
const registry = (nodes: NodeRecord[], jobs: NodesState['jobs'] = []): NodesRegistry => ({ source: 'pool-witness', selfNode: 'node-a',
  pool: { owner: 'acme', primary: 'primary-mac', backup: 'backup-mac' },
  state: { version: 'drive.nodes.v1', sequence: 9, observedAt: NOW - 1_000, nodes, leader: null, jobs } satisfies NodesState });
const tailnet = JSON.stringify({ BackendState: 'Running', Self: { HostName: 'node-a' },
  Peer: { p0: { HostName: 'node-b', OS: 'macOS', Online: true, LastSeen: '2026-11-17T10:42:00Z' } } });
const viewDeps = (nodes: NodeRecord[], jobs: NodesState['jobs'] = []): NodesViewDeps => ({ peers: { now: () => new Date(NOW), homeDir: () => '/fake-home', exec: () => tailnet },
  readRegistry: () => registry(nodes, jobs), localStats: () => stats(1), hostName: () => 'node-a.fake.example', timeZone: 'UTC' });
const ok = { installed: true, signedIn: true } as const;
const healthy = (): NodeProbeReply => ({ lanes: { claude: ok, codex: ok, devin: ok, gemini: ok, 'local-model': ok }, repos: ['phantom'], diskFreeBytes: 120e9 });
const probeAll: NodeProbe = async () => healthy();
const probeSelfOnly: NodeProbe = async (_n, isSelf) => (isSelf ? healthy() : null);
const job = (id: string, lane: string, position: number): QueueOrderJob => ({ position, id, repo: 'phantom', lane, tier: 'work', ageSeconds: 5, family: null, supersededBy: null });
const queueOf = (jobs: QueueOrderJob[]): QueueOrderV1 => ({ schema: 'queue.order.v1', version: 1, generatedAt: new Date(NOW).toISOString(), count: jobs.length, parked: 0, lanes: ['claude', 'codex'], jobs });
const memory = (allowed: boolean | null) => ({ gated: true, allowed, free_pct: 75, swap_gb: 4, pressure_level: allowed === false ? 2 as const : 1 as const, reason: allowed === false ? 'memory pressure is high' : null, policy: ENGINE_ADMISSION_POLICY });
const busy: HostGuardInputs = { load: { load1: 20, load5: 20, load15: 20, cores: 8, ratio: 2.5 }, admission: { state: 'waiting', why: 'load 20', settleSeconds: 60, load1: 20, ownedLoad1: 10 }, memory: memory(true) };
const fine: HostGuardInputs = { load: { load1: 1, load5: 1, load15: 1, cores: 8, ratio: 0.1 }, admission: { state: 'open', why: null, settleSeconds: null, load1: 1, ownedLoad1: 1 }, memory: memory(true) };

function deps(host: HostGuardInputs, over: Partial<NodesOffloadDeps> & { nodes?: NodeRecord[]; running?: NodesState['jobs']; probe?: NodeProbe; jobs?: QueueOrderJob[] } = {}): NodesOffloadDeps & { recorded: string[] } {
  const recorded: string[] = [];
  return { view: viewDeps(over.nodes ?? [node('node-a'), node('node-b')], over.running), probe: over.probe ?? probeAll,
    readQueue: async () => queueOf(over.jobs ?? [job('j1', 'claude', 1), job('j2', 'claude', 2), job('j3', 'claude', 3)]),
    readHost: () => host, readEnabled: () => true, readRecorded: () => new Set(), now: () => new Date(NOW),
    record: moves => { recorded.push(...moves.map(m => m.job)); return moves.length; }, recorded, ...over } as NodesOffloadDeps & { recorded: string[] };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('nodes offload', () => {
  it('host busy with a ready node: picks it, never past its free slots, records one event per move', async () => {
    const d = deps(busy);
    const report = await readNodesOffload(d, { dryRun: false });
    expect(report.schema).toBe(NODES_OFFLOAD_SCHEMA);
    expect(report).toMatchObject({ enabled: true, mode: 'live', recorded: 2, host: { state: 'busy', reasons: ['load'] } });
    expect(report.moves.map(m => [m.job, m.node])).toEqual([['j1', 'node-b'], ['j2', 'node-b']]);
    expect(report.moves[0]!.why).toMatch(/load on this computer; node-b passes the doctor/);
    expect(report.stays).toEqual([{ job: 'j3', lane: 'claude', why: 'no ready computer has a free claude slot; waiting here' }]);
    expect(d.recorded).toEqual(['j1', 'j2']);
  });

  it('memory backoff counts as busy and is named as the reason', async () => {
    const report = await readNodesOffload(deps({ ...fine, memory: memory(false) }), { dryRun: true });
    expect(report.host).toMatchObject({ state: 'busy', reasons: ['memory'] });
    expect(report.moves[0]!.reasons).toEqual(['memory']);
    expect(report).toMatchObject({ mode: 'dry-run', recorded: 0 });
  });

  it('host busy with no ready node: every job waits here and nothing is recorded', async () => {
    const d = deps(busy, { probe: probeSelfOnly });
    const report = await readNodesOffload(d, { dryRun: false });
    expect(report.moves).toEqual([]);
    expect(report.stays).toHaveLength(3);
    expect(report.summary).toMatch(/No computer is ready, so jobs keep waiting here/);
    expect(report.reasons.some(r => r.includes('node-b does not pass `phm nodes doctor`'))).toBe(true);
    expect(d.recorded).toEqual([]);
  });

  it('an unreadable queue is unknown, never "nothing is queued"; an empty one still is', async () => {
    const unreadable = await readNodesOffload(deps(busy, { readQueue: async () => { throw new Error('no order file'); } }), { dryRun: true });
    expect(unreadable.moves).toEqual([]);
    expect(unreadable.stays).toEqual([]);
    expect(unreadable.summary).not.toMatch(/nothing is queued/);
    expect(unreadable.summary).toMatch(/ready queue could not be read/);
    expect(unreadable.reasons).toContain('queue unreadable; ready jobs unknown');
    const empty = await readNodesOffload(deps(busy, { jobs: [] }), { dryRun: true });
    expect(empty.summary).toMatch(/nothing is queued/);
  });

  it('host fine: nothing moves', async () => {
    const d = deps(fine);
    const report = await readNodesOffload(d, { dryRun: false });
    expect(report.host.state).toBe('fine');
    expect(report.moves).toEqual([]);
    expect(report.stays.every(s => s.why === 'this computer would launch it')).toBe(true);
    expect(d.recorded).toEqual([]);
  });

  it('setting off: shows what would move but records nothing', async () => {
    const d = deps(busy, { readEnabled: () => false });
    const report = await readNodesOffload(d, { dryRun: false });
    expect(report).toMatchObject({ enabled: false, mode: 'dry-run', recorded: 0 });
    expect(report.moves).toHaveLength(2);
    expect(report.summary).toMatch(/^Offload is off\./);
    expect(d.recorded).toEqual([]);
  });

  it('never moves a running job or one already chosen; an unknown guard moves nothing', async () => {
    const running = [node('node-a', { slots: 2 }), node('node-b', { slots: 4 })];
    const live = [{ id: 'j1', state: 'running', claim: { nodeId: 'node-a', session: 1, expiresAt: NOW + 30_000 } } as unknown as NodesState['jobs'][number]];
    const a = await readNodesOffload(deps(busy, { nodes: running, running: live, readRecorded: () => new Set(['j2']) }), { dryRun: true });
    const j = (id: string) => a.stays.find(s => s.job === id)?.why;
    expect(j('j1')).toMatch(/already running/);
    expect(j('j2')).toMatch(/already chosen/);
    expect(a.moves.map(m => m.job)).toEqual(['j3']);
    const unknown = await readNodesOffload(deps({ load: { load1: null, load5: null, load15: null, cores: null, ratio: null }, admission: { state: 'unknown', why: null, settleSeconds: null, load1: null, ownedLoad1: null }, memory: memory(true) }), { dryRun: true });
    expect(unknown.host.state).toBe('unknown');
    expect(unknown.moves).toEqual([]);
  });

  it('never moves a ready row whose job already runs on a node under the bridge id', async () => {
    // The claim bridge enqueues a ready row as `ready:<job>:<attempt>`
    // (routerJobId in drive/nodes/ready-bridge.ts), so jobsRunning carries
    // node job ids, not ready-row ids. A re-queued row for the same job must
    // still count as running.
    const running = [node('node-a', { slots: 2 }), node('node-b', { slots: 4 })];
    const live = [{ id: 'ready:j1:1', state: 'running', claim: { nodeId: 'node-a', session: 1, jobId: 'ready:j1:1', expiresAt: NOW + 30_000 } } as unknown as NodesState['jobs'][number]];
    const report = await readNodesOffload(deps(busy, { nodes: running, running: live }), { dryRun: true });
    expect(report.stays.find(s => s.job === 'j1')?.why).toMatch(/already running/);
    expect(report.moves.map(m => m.job)).toEqual(['j2', 'j3']);
  });

  it('resolves market lanes to the node cap the bridge requires; host-bound lanes stay', async () => {
    // job.lane is a market lane: codex-personal needs the codex cap — the same
    // map the claim bridge applies (remoteLaneCap in unfed-market). `omlx` only
    // runs on this host, so a remote omlx cap never takes it; it keeps waiting here.
    const report = await readNodesOffload(deps(busy, {
      nodes: [node('node-a'), node('node-b', { caps: ['codex', 'omlx', 'omlx-work'] })],
      jobs: [job('j1', 'codex-personal', 1), job('j2', 'omlx', 2), job('j3', 'codex-personal', 3)],
    }), { dryRun: true });
    expect(report.moves.map(m => [m.job, m.node])).toEqual([['j1', 'node-b'], ['j3', 'node-b']]);
    expect(report.stays).toEqual([{ job: 'j2', lane: 'omlx', why: 'the omlx lane cannot run on another computer; waiting here' }]);
    const without = await readNodesOffload(deps(busy, {
      nodes: [node('node-a'), node('node-b', { caps: ['claude'] })],
      jobs: [job('j1', 'codex-personal', 1)],
    }), { dryRun: true });
    expect(without.moves).toEqual([]);
    expect(without.stays).toEqual([{ job: 'j1', lane: 'codex-personal', why: 'no ready computer has a free codex-personal slot; waiting here' }]);
  });

  it('assessHostGuard: the launch guard speaks first; load ratio only when it is silent', () => {
    const silent = { ...fine, admission: { ...fine.admission, state: 'unknown' as const }, load: { ...fine.load, ratio: 4.5 } };
    expect(assessHostGuard(silent)).toMatchObject({ state: 'busy', reasons: ['load'] });
    expect(assessHostGuard({ ...busy, admission: { ...busy.admission, state: 'open' } }).state).toBe('fine');
  });
});

describe('setting and CLI', () => {
  it('is off by default; on|off flips it and --json carries the schema id and records the event', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'offload-'));
    try {
      const path = join(dir, 'nodes-offload.json');
      expect(readOffloadEnabled(path)).toBe(false);
      writeOffloadEnabled(true, new Date(NOW), path);
      expect(readOffloadEnabled(path)).toBe(true);
      writeOffloadEnabled(false, new Date(NOW), path);
      expect(readOffloadEnabled(path)).toBe(false);

      const lines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((m: unknown) => { lines.push(String(m)); });
      const code = await cmdNodes(['offload', '--dry-run', '--json'], viewDeps([node('node-a'), node('node-b')]), async () => queueOf([job('j1', 'claude', 1)]), probeAll,
        { readHost: () => busy, readEnabled: () => true, readRecorded: () => new Set(), now: () => new Date(NOW) });
      expect(code).toBe(0);
      expect(JSON.parse(lines[0]!)).toMatchObject({ schema: NODES_OFFLOAD_SCHEMA, mode: 'dry-run', moves: [{ job: 'j1', node: 'node-b' }] });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(await cmdNodes(['offload', 'maybe'], viewDeps([node('node-a')]))).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a live run writes one typed event per move to the events file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'offload-'));
    try {
      const events = join(dir, 'events.jsonl');
      const report = await readNodesOffload({ ...deps(busy), record: (moves, from, now) => recordOffloadMoves(moves, from, now, events) }, { dryRun: false });
      expect(report.recorded).toBe(2);
      const first = JSON.parse(readFileSync(events, 'utf8').split('\n')[0]!);
      expect(first).toMatchObject({ schema: NODES_OFFLOAD_EVENT_SCHEMA, job: 'j1', from: 'node-a', to: 'node-b', reasons: ['load'] });
      expect([...readRecordedOffloads(events)].sort()).toEqual(['j1', 'j2']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
