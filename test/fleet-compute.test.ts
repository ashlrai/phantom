import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readFleetCompute } from '../src/core/fleet/compute-view.js';
import { isHostStats, type HostStats } from '../src/core/drive/nodes/state.js';
import { DriveNodes } from '../src/core/drive/nodes/index.js';
import { emptyState } from '../src/core/drive/nodes/state.js';
import { executeNodeFleet } from '../src/core/drive/nodes/commands.js';

const now = 1_800_000_000_000;
const stats: HostStats = { sampledAtMs: now, uptimeSeconds: 123, load: [1, 2, 3], ramTotal: 16000, ramUsed: 10000, diskFree: 6000, cores: [{ total: 100, idle: 50 }] };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fleet-compute-')); roots.push(root);
  for (const dir of ['nodes', 'node-pool', 'queue']) await mkdir(join(root, dir));
  const state = emptyState(); state.sequence = 1; state.observedAt = now;
  state.nodes = [{ nodeId: 'muse', session: 1, heartbeatAt: now - 400_000, expiresAt: now - 1, owners: ['team'], slots: 2, hostStats: stats }];
  await writeFile(join(root, 'nodes', 'nodes.json'), JSON.stringify(state));
  return { root, state, options: { home: root, runsDir: root, now, sample: () => stats } };
}
it('projects real numeric observations, offline nodes, per-source failures and explicit unknowns', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'queue', 'status.json'), JSON.stringify({ last_tick: new Date(now).toISOString(), lanes: { claude: { hard_cap: 8, quota_ok: false }, broken: { hard_cap: -1 } } }));
  const view = await readFleetCompute(f.options);
  expect(view.nodes.find(n => n.id === 'muse')).toMatchObject({ state: 'offline', slots: 2, stats, pressure: null, memguardPaused: null });
  expect(view.nodes.find(n => n.local)?.stats).toEqual(stats);
  expect(view.lanes.claude).toEqual({ hardCap: 8, quotaOk: false });
  expect(view.lanes.broken).toEqual({ hardCap: null, quotaOk: null });
  expect(view.sources.pool).toBe('unavailable');
  expect(JSON.stringify(view)).not.toContain(f.root);
});
it('binds local identity only through explicit pool config; merges freshest registry/mirror and live fenced claims', async () => {
  const f = await fixture();
  const mirror = structuredClone(f.state); mirror.nodes[0]!.heartbeatAt = now; mirror.nodes[0]!.expiresAt = now + 1000;
  mirror.jobs = [{ id: 'RQ-REMOTE', owner: 'team', state: 'running', claim: { nodeId: 'muse', session: 1, token: 1, leaderToken: 1, jobId: 'RQ-REMOTE', expiresAt: now + 500 } }];
  await writeFile(join(f.root, 'node-pool', 'primary-mirror.json'), JSON.stringify(mirror));
  let view = await readFleetCompute(f.options);
  expect(view.nodes.find(n => n.id === 'muse')).toMatchObject({ local: false, state: 'ready', jobs: [{ job: 'RQ-REMOTE', owner: 'team' }] });
  await writeFile(join(f.root, 'node-pool', 'config.json'), JSON.stringify({ node: 'muse' }));
  view = await readFleetCompute(f.options);
  expect(view.localNodeId).toBe('muse');
  expect(view.nodes).toHaveLength(1);
  mirror.observedAt = now + 5; mirror.jobs = [];
  await writeFile(join(f.root, 'node-pool', 'nodes.json'), JSON.stringify(mirror));
  view = await readFleetCompute({ ...f.options, now: now + 10 });
  expect(view.sources.witness).toBe('loaded');
  expect(view.nodes[0]!.jobs).toEqual([]); // a newer witness completion wins a tied heartbeat
});
it('frees claims fenced by an expired node record, matching the router\'s actionableClaim', async () => {
  const f = await fixture();
  // The fixture record is already expired; its claim is not. The router frees
  // that claim's capacity at once, so the projection must not show it held.
  f.state.jobs = [{ id: 'RQ-FENCED', owner: 'team', state: 'running',
    claim: { nodeId: 'muse', session: 1, token: 1, leaderToken: 1, jobId: 'RQ-FENCED', expiresAt: now + 500 } }];
  await writeFile(join(f.root, 'nodes', 'nodes.json'), JSON.stringify(f.state));
  const view = await readFleetCompute(f.options);
  expect(view.nodes.find(n => n.id === 'muse')).toMatchObject({ state: 'offline', jobs: [] });
  expect(view.pool?.claims).toBe(0);
});
it('rejects symlinked/corrupt sources and telemetry with extra fields without leaking values', async () => {
  const f = await fixture();
  f.state.nodes[0]!.hostStats = { ...stats, credential: 'private fixture' } as HostStats;
  await writeFile(join(f.root, 'nodes', 'nodes.json'), JSON.stringify(f.state));
  await symlink(join(f.root, 'nodes', 'nodes.json'), join(f.root, 'node-pool', 'primary-mirror.json'));
  await writeFile(join(f.root, 'queue', 'status.json'), '{broken');
  const view = await readFleetCompute({ ...f.options, sample: () => { throw new Error('private fixture'); } });
  expect(view.nodes.every(n => n.stats === null)).toBe(true);
  expect(view.sources).toMatchObject({ pool: 'unavailable', dispatcher: 'invalid', local: 'unavailable' });
  expect(JSON.stringify(view)).not.toContain('private fixture');
  expect(isHostStats({ ...stats, load: [NaN, 0, 0] })).toBe(false);
  expect(isHostStats({ ...stats, load: [null, null, null] })).toBe(true);
});
it('round-trips optional beats, copies observations and refuses invalid payloads without renewing authority', () => {
  const state = emptyState();
  const nodes = new DriveNodes({ transaction: fn => fn(state) }, { now: () => now });
  const joined = nodes.join('muse', { owners: ['team'], slots: 2 })!;
  executeNodeFleet('beat', ['--node', 'muse', '--session', String(joined.session), '--host-stats', JSON.stringify(stats)], nodes);
  expect(nodes.snapshot().nodes[0]!.hostStats).toEqual(stats);
  const sample = structuredClone(stats); nodes.heartbeat(joined, { hostStats: sample }); sample.load[0] = 999;
  expect(nodes.snapshot().nodes[0]!.hostStats!.load[0]).toBe(1);
  expect(() => nodes.heartbeat(joined, { hostStats: { ...stats, ramUsed: -1 } })).toThrow('Invalid host stats');
  expect(() => executeNodeFleet('beat', ['--node', 'muse', '--session', '1', '--host-stats', '{bad'], nodes)).toThrow('numeric host observation');
  nodes.heartbeat(joined);
  expect(nodes.snapshot().nodes[0]!.hostStats).toEqual(stats);
});
it('does not turn old or future pressure telemetry into a current memory/memguard signal', async () => {
  const f = await fixture();
  const machine = { sampledAtMs: now - 91_000, memoryPressure: { level: 'critical' }, memguardPaused: true };
  const save = () => writeFile(join(f.root, 'fleet.json'), JSON.stringify({ resources: { machine } }));
  await save(); expect((await readFleetCompute(f.options)).nodes.find(n => n.local)?.pressure).toBeNull();
  machine.sampledAtMs = now; await save();
  expect((await readFleetCompute(f.options)).nodes.find(n => n.local)).toMatchObject({ pressure: 'critical', memguardPaused: true });
  machine.sampledAtMs = now + 1; await save();
  expect((await readFleetCompute(f.options)).nodes.find(n => n.local)?.memguardPaused).toBeNull();
});
it('projects admission and publishing evidence without inventing counts or exposing unselected fields', async () => {
  const f = await fixture();
  expect((await readFleetCompute(f.options)).operations).toEqual({ publishes24h: null,
    admission: { admit: null, gateReason: null, warnings: null, observedAt: null } });
  const ts = new Date(now).toISOString();
  await writeFile(join(f.root, 'queue', 'status.json'), JSON.stringify({ publishes_24h: 17,
    admission: { ts, admit: false, gate_reason: 'worktrees', warnings: ['daemon-stale', 5], privateField: 'must stay private' } }));
  const view = await readFleetCompute(f.options);
  expect(view.operations).toEqual({ publishes24h: 17,
    admission: { admit: false, gateReason: 'worktrees', warnings: ['daemon-stale'], observedAt: ts } });
  expect(JSON.stringify(view)).not.toContain('must stay private');
  await writeFile(join(f.root, 'queue', 'status.json'), JSON.stringify({ publishes_24h: -1,
    admission: { ts: 'invalid', admit: 'yes', gate_reason: 5, warnings: null } }));
  expect((await readFleetCompute(f.options)).operations).toEqual({ publishes24h: null,
    admission: { admit: null, gateReason: null, warnings: null, observedAt: null } });
});
