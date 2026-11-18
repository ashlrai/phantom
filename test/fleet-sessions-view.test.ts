import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFleetCompute, type FleetCompute } from '../src/core/fleet/compute-view.js';
import { getFleetSessions } from '../src/core/fleet/runs-sessions.js';
import { mapSession, readFleetSessionMap, sessionMapState } from '../src/core/fleet/sessions-view.js';

const now = Date.now();
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sessions-map-')); roots.push(root);
  const save = async (name: string, text: string) => {
    const path = join(root, name); await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text); await utimes(path, new Date(now - 60_000), new Date(now - 60_000));
  };
  await save('queue/ready.tsv', 'RQ-WAIT\tphantom\tcodex-personal\twork\t/private/prompt\nRQ-HOLD\tphantom\tPARKED-DEP.codex-personal\twork\t/private/prompt\n');
  await save('queue/run/RQ-A.line', 'RQ-A phantom codex-personal work /private/prompt\n');
  await save('RQ-A.base', 'abc123 work/fleet /private/worktree\n');
  await save('RQ-A.log', 'working\nAuthorization: Bearer private-fixture-value\n');
  await save('metrics/jobs.jsonl', JSON.stringify({ job: 'RQ-A', event: 'launch', ts: new Date(now - 60_000).toISOString(), model: 'fixture-model' }) + '\n');
  // RQ-A is still running (no RESULT line yet). RQ-CLOUD is a published cloud job: base record, no log, RESULT PR.
  await save('RQ-A.publish', 'TEST pending\n');
  await save('queue/run/RQ-CLOUD.line', 'RQ-CLOUD phantom devin work /private/prompt\n');
  await save('RQ-CLOUD.base', 'abc123 work/cloud /private/worktree\n');
  await save('RQ-CLOUD.publish', 'RESULT PR https://github.com/ashlrai/phantom/pull/123\n');
  const compute = await readFleetCompute({ home: join(root, 'home'), runsDir: root, now, sample: () => { throw new Error('no telemetry'); } });
  const inventory = await getFleetSessions({ runsDir: root, now: () => now, runPs: async () => '' });
  return { root, save, compute, inventory };
}
const node = (id: string, job = 'RQ-A'): FleetCompute['nodes'][number] => ({ id, local: false, owners: [], heartbeatAt: now,
  state: 'ready', slots: null, ramSlots: null, jobs: [{ job, owner: null }], stats: null, pressure: null, memguardPaused: null });

it('composes fixture claims, launch, queue, PR and scrubbed worktree/activity receipts without private paths', async () => {
  const f = await fixture();
  const view = await readFleetSessionMap({ compute: f.compute, sessions: f.inventory, runsDir: f.root, now });
  expect(view.schema).toBe('fleet.sessions.v1');
  expect(view.sessions).toEqual(f.inventory.sessions);
  expect(view.recent).toEqual(f.inventory.recent);
  expect(view.mapSessions.find(s => s.job === 'RQ-A')).toMatchObject({ model: 'fixture-model', branch: 'work/fleet',
    worktree: 'recorded', nodeId: null, placement: 'unknown', mapState: 'running', elapsedSeconds: 60 });
  expect(view.mapSessions.find(s => s.job === 'RQ-CLOUD')).toBeUndefined();
  expect(view.mapRecent.find(s => s.job === 'RQ-CLOUD')).toMatchObject({ status: 'finished', outcome: 'pr', prUrl: 'https://github.com/ashlrai/phantom/pull/123' });
  expect(view.mapSessions.find(s => s.job === 'RQ-WAIT')).toMatchObject({ nodeId: null, mapState: 'queued', activity: null });
  expect(view.mapSessions.find(s => s.job === 'RQ-HOLD')).toMatchObject({ nodeId: null, mapState: 'held' });
  expect(JSON.stringify(view)).not.toMatch(/private-fixture-value|\/private\//);
});

it('uses unique fenced node claims or confirmed local processes; conflicting evidence stays unplaced', async () => {
  const f = await fixture(), row = f.inventory.sessions.find(s => s.job === 'RQ-A')!;
  const compute = { ...f.compute, nodes: [...f.compute.nodes, node('remote')] };
  expect(mapSession(row, compute)).toMatchObject({ nodeId: 'remote', placement: 'claim' });
  expect(mapSession({ ...row, live: 'yes' }, f.compute)).toMatchObject({ nodeId: f.compute.localNodeId, placement: 'process' });
  expect(mapSession({ ...row, live: 'yes' }, compute)).toMatchObject({ nodeId: null, placement: 'conflict' });
  expect(mapSession(row, { ...compute, nodes: [...compute.nodes, node('other')] })).toMatchObject({ nodeId: null, placement: 'conflict' });
  const detail = vi.fn();
  const view = await readFleetSessionMap({ compute, sessions: f.inventory, runsDir: f.root, readDetail: detail });
  expect(detail).not.toHaveBeenCalled();
  expect(view.mapSessions.find(s => s.job === 'RQ-A')).toMatchObject({ branch: null, activity: null });
});

it('includes claim-only remote jobs without guessing state, lane, model, elapsed or local activity', async () => {
  const f = await fixture(), detail = vi.fn();
  const view = await readFleetSessionMap({ compute: { ...f.compute, nodes: [node('remote', 'RQ-REMOTE')] },
    sessions: { ...f.inventory, sessions: [] }, runsDir: f.root, readDetail: detail });
  expect(view.mapSessions).toEqual([expect.objectContaining({ job: 'RQ-REMOTE', nodeId: 'remote', status: 'unknown',
    lane: null, model: null, elapsedSeconds: null, mapState: 'unknown', activity: null })]);
  expect(detail).not.toHaveBeenCalled();
});

it('refuses symlink metadata and preserves explicit missing sources', async () => {
  const f = await fixture();
  await rm(join(f.root, 'RQ-A.base')); await symlink(join(f.root, 'RQ-A.log'), join(f.root, 'RQ-A.base'));
  let view = await readFleetSessionMap({ compute: f.compute, sessions: f.inventory, runsDir: f.root });
  expect(view.mapSessions.find(s => s.job === 'RQ-A')).toMatchObject({ branch: null, worktree: null, detailSources: { base: 'degraded' } });
  const missing = join(f.root, 'absent');
  view = await readFleetSessionMap({ runsDir: missing, compute: { ...f.compute, nodes: [] },
    sessions: await getFleetSessions({ runsDir: missing, runPs: async () => '' }) });
  expect(view).toMatchObject({ sourceState: 'missing', mapSessions: [], mapRecent: [] });
});

it('bounds detail work and marks omitted details partial while preserving unknown evidence', async () => {
  const f = await fixture(), row = f.inventory.sessions.find(s => s.job === 'RQ-A')!;
  const detail = vi.fn(async () => { throw new Error('unavailable'); });
  const view = await readFleetSessionMap({ compute: f.compute, sessions: { ...f.inventory,
    sessions: Array.from({ length: 101 }, (_, i) => ({ ...row, job: `RQ-${i}` })) }, readDetail: detail });
  expect(detail).toHaveBeenCalledTimes(100); expect(view.truncated).toBe(true);
  expect(view.mapSessions.every(s => s.activity === null)).toBe(true);
  expect(['queued', 'parked', 'running', 'launching', 'publishing', 'exited', 'stale'].map(s => sessionMapState(s as typeof row.status)))
    .toEqual(['queued', 'held', 'running', 'running', 'running', 'idle', 'unknown']);
});


it('does not manufacture an active claim-only duplicate of a recently finished job', async () => {
  const f = await fixture();
  const view = await readFleetSessionMap({ compute: { ...f.compute, nodes: [{ ...node(f.compute.localNodeId, 'RQ-CLOUD'), local: true }] },
    sessions: f.inventory, runsDir: f.root, now });
  expect(view.mapSessions.filter(s => s.job === 'RQ-CLOUD')).toEqual([]);
  expect(view.mapRecent.filter(s => s.job === 'RQ-CLOUD')).toEqual([expect.objectContaining({ status: 'finished',
    outcome: 'pr', branch: 'work/cloud', prUrl: 'https://github.com/ashlrai/phantom/pull/123' })]);
});

it('keeps a new active attempt ahead of an older terminal receipt with the same id', async () => {
  const f = await fixture(), row = f.inventory.sessions.find(s => s.job === 'RQ-A')!;
  const view = await readFleetSessionMap({ compute: f.compute, sessions: { ...f.inventory,
    recent: [{ ...row, status: 'finished', model: 'older-attempt' }] }, runsDir: f.root, now });
  expect(view.mapSessions.filter(s => s.job === 'RQ-A')).toHaveLength(1);
  expect(view.mapSessions.find(s => s.job === 'RQ-A')).toMatchObject({ model: 'fixture-model', mapState: 'running' });
  expect(view.mapRecent.filter(s => s.job === 'RQ-A')).toEqual([]);
});


it('never hydrates a recent job from local files when its claim is on another host', async () => {
  const f = await fixture(), detail = vi.fn();
  const view = await readFleetSessionMap({ compute: { ...f.compute, nodes: [node('remote', 'RQ-CLOUD')] },
    sessions: { ...f.inventory, sessions: [] }, runsDir: f.root, now, readDetail: detail });
  expect(view.mapSessions).toEqual([]);
  expect(view.mapRecent.find(s => s.job === 'RQ-CLOUD')).toMatchObject({ status: 'finished', nodeId: 'remote', branch: null, activity: null });
  expect(detail).not.toHaveBeenCalled();
});
