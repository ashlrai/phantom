import { spawn, type spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { DriveNodes, type NodesState, type NodesStore } from '../src/core/drive/nodes/index.js';
import { bridgeLeaseOwner, localBridgeRouter, nodeBridgeReadiness, runNodeBridge, type NodeBridgeHost } from '../src/core/drive/nodes/ready-bridge.js';
import { emptyState } from '../src/core/drive/nodes/state.js';
import { probeNodeLanes } from '../src/core/drive/nodes/worker.js';
import { probeRunnerPacks } from '../src/core/drive/nodes/runner-packs.js';

class MemoryStore implements NodesStore {
  state = emptyState();
  transaction<T>(fn: (state: NodesState) => T): T {
    const draft = structuredClone(this.state);
    const result = fn(draft);
    this.state = draft;
    return structuredClone(result);
  }
}

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const READ = ['codex', 'pack:codex-file'];
const row = (job: string, lane = 'codex-cmp', spec?: object) =>
  [job, 'phantom', lane, 'work', `/prompts/${job}.md`, ...(spec ? [JSON.stringify(spec)] : [])].join('\t');

function fixture(rows: string[], nodes: { id: string; caps: string[]; slots?: number }[] = [{ id: 'air-w4', caps: READ, slots: 2 }, { id: 'muse-w2', caps: READ, slots: 1 }]) {
  const root = mkdtempSync(join(tmpdir(), 'node-bridge-'));
  roots.push(root);
  const host: NodeBridgeHost = { runsRoot: join(root, 'runs'), wtRoot: join(root, 'wt') };
  for (const d of ['queue/run', 'queue/batches', 'bin']) mkdirSync(join(host.runsRoot, d), { recursive: true });
  copyFileSync(resolve('contrib/mac/dispatchd.py'), join(host.runsRoot, 'bin', 'dispatchd.py'));
  writeFileSync(join(host.runsRoot, 'queue', 'ready.tsv'), rows.map(r => r + '\n').join(''));
  let now = 1_000_000;
  const nodes_ = new DriveNodes(new MemoryStore(), { now: () => now, nodeTtlMs: 600_000, leaderTtlMs: 600_000, claimTtlMs: 1_000 });
  const sessions = new Map(nodes.map(n => [n.id, nodes_.join(n.id, { owners: ['ashlr'], caps: n.caps, ...(n.slots === undefined ? {} : { slots: n.slots }) })!]));
  const router = localBridgeRouter(nodes_);
  const pass = (apply = true, extra: Partial<Parameters<typeof runNodeBridge>[0]> = {}) =>
    runNodeBridge({ host, router, owner: 'ashlr', apply, now, pendingTtlMs: 60_000, ...extra });
  const ready = () => readFileSync(join(host.runsRoot, 'queue', 'ready.tsv'), 'utf8');
  const lease = (job: string) => join(host.runsRoot, 'queue', 'run', `${job}.batched`);
  return { host, nodes: nodes_, sessions, pass, ready, lease, advance: (ms: number) => { now += ms; } };
}

describe('ready.tsv -> node router bridge', () => {
  it('offloads an eligible row under a dispatchd-honored lease and a router job', async () => {
    const f = fixture([row('RQ-REVIEW-A')]);
    const dry = await f.pass(false);
    expect(dry).toMatchObject({ mode: 'dry-run', inert: null, claimed: [] });
    expect(dry.rows[0]).toMatchObject({ job: 'RQ-REVIEW-A', offload: true, nodeId: 'air-w4', pack: 'codex-file',
      routerJobId: 'ready:RQ-REVIEW-A:1', requires: ['codex', 'pack:codex-file'] });
    expect(existsSync(f.lease('RQ-REVIEW-A'))).toBe(false);
    const done = await f.pass();
    expect(done.claimed).toEqual(['RQ-REVIEW-A']);
    const owner = bridgeLeaseOwner('RQ-REVIEW-A');
    expect(readFileSync(f.lease('RQ-REVIEW-A'), 'utf8')).toBe(owner);
    expect(owner.startsWith('RQ-BATCH-')).toBe(true);
    // dispatchd's LEASE_ORPHANED sweep keeps a lease only when this manifest exists.
    expect(existsSync(join(f.host.runsRoot, 'queue', 'batches', `${owner}.json`))).toBe(true);
    expect(f.ready()).toBe('');
    expect(f.nodes.view(['ashlr']).jobs).toEqual([expect.objectContaining({ id: 'ready:RQ-REVIEW-A:1', state: 'pending',
      pack: 'codex-file', secrets: [] })]);
  });

  it('keeps ineligible rows local with a reason code', async () => {
    const f = fixture([row('RQ-REVIEW-EX', 'codex-cmp', { exclusive: true }), row('RQ-REVIEW-LOC', 'codex-local'),
      row('RQ-REVIEW-DC', 'codex-cmp', { data_class: 'confidential' }), row('RQ-REVIEW-CL', 'claude'),
      row('RQ-REVIEW-DV', 'devin'), row('RQ-FEAT-W'), row('RQ-REVIEW-T', 'codex-cmp', { min_tier: 'frontier' })]);
    const report = await f.pass();
    expect(Object.fromEntries(report.rows.map(r => [r.job, r.reasons]))).toEqual({
      'RQ-REVIEW-EX': ['exclusive'], 'RQ-REVIEW-LOC': ['local_execution_required'], 'RQ-REVIEW-DC': ['data_class_exceeded'],
      'RQ-REVIEW-CL': ['lane_mismatch'], 'RQ-REVIEW-DV': ['lane_not_remote'], 'RQ-FEAT-W': ['pack_inert'],
      'RQ-REVIEW-T': ['requirement_unverifiable'] });
    expect(report.claimed).toEqual([]);
  });

  it('refuses rows past free slots and treats unknown slots as unknown, not zero', async () => {
    const f = fixture(['A', 'B', 'C', 'D'].map(j => row(`RQ-REVIEW-${j}`)));
    const report = await f.pass(false);
    expect(report.rows.map(r => r.nodeId)).toEqual(['air-w4', 'air-w4', 'muse-w2', null]);
    expect(report.rows[3]!.reasons).toEqual(['no_free_slot']);
    const unknown = fixture([row('RQ-REVIEW-A')], [{ id: 'muse-w5', caps: READ }]);
    const r2 = await unknown.pass(false);
    expect(r2.nodes).toEqual([expect.objectContaining({ nodeId: 'muse-w5', slots: null, freeSlots: null })]);
    expect(r2.rows[0]!.reasons).toEqual(['slots_unknown']);
  });

  it('never offers a job to a node whose local capability probe failed', async () => {
    // air-w4 has no codex binary: the local probe drops the cap, whatever its config says.
    const run = (() => ({ status: null, error: Object.assign(new Error('missing'), { code: 'ENOENT' }) })) as unknown as typeof spawnSync;
    const caps = probeNodeLanes(run);
    expect(caps).toEqual([]);
    const f = fixture([row('RQ-REVIEW-A')], [{ id: 'air-w4', caps: [...caps, 'pack:codex-file'], slots: 2 }]);
    const report = await f.pass();
    expect(report.rows[0]!.reasons).toEqual(['lane_mismatch']);
    expect(report.claimed).toEqual([]);
    f.nodes.enqueue('probe-job', { owner: 'ashlr', requires: ['codex'] });
    expect(f.nodes.plan('ashlr')).toEqual([expect.objectContaining({ jobId: 'probe-job', nodeId: null })]);
    expect(f.nodes.pull(f.sessions.get('air-w4')!)).toBeNull();
  });

  it('returns a row to ready.tsv when its node lease expires, and fences the stale completion', async () => {
    const f = fixture([row('RQ-REVIEW-A')]);
    await f.pass();
    const pulled = f.nodes.pull(f.sessions.get('air-w4')!)!;
    expect(pulled.job.id).toBe('ready:RQ-REVIEW-A:1');
    expect((await f.pass()).leases[0]).toMatchObject({ routerState: 'running', action: 'check-lease' });
    expect(f.ready()).toBe('');
    f.advance(2_000);
    const report = await f.pass();
    expect(report.requeued).toEqual(['RQ-REVIEW-A']);
    expect(f.ready()).toBe(row('RQ-REVIEW-A') + '\n');
    expect(existsSync(f.lease('RQ-REVIEW-A'))).toBe(false);
    expect(f.nodes.complete(pulled.claim, 'late-result')).toBe(false);
    expect(f.nodes.renewClaim(pulled.claim)).toBeNull();
    expect(f.nodes.pull(f.sessions.get('muse-w2')!)).toBeNull();
    // The next offload is a new router job under a higher fencing generation.
    expect((await f.pass(false)).rows[0]).toMatchObject({ offload: true, routerJobId: 'ready:RQ-REVIEW-A:2' });
  });

  it('requeues a row no node pulled before the pending TTL and keeps a completed one', async () => {
    const f = fixture([row('RQ-REVIEW-A'), row('RQ-REVIEW-B')]);
    await f.pass();
    const pulled = f.nodes.pull(f.sessions.get('air-w4')!)!;
    expect(f.nodes.complete(pulled.claim, 'result-ref')).toBe(true);
    f.advance(61_000);
    const report = await f.pass();
    expect(report.completed).toEqual([pulled.job.id.split(':')[1]]);
    const other = pulled.job.id.includes('-A:') ? 'RQ-REVIEW-B' : 'RQ-REVIEW-A';
    expect(report.requeued).toEqual([other]);
    expect(f.ready()).toBe(row(other) + '\n');
  });

  it('loses the duplicate-claim race to a running dispatchd tick and to an existing local claim', async () => {
    const f = fixture([row('RQ-REVIEW-A'), row('RQ-REVIEW-B')]);
    const tick = spawn('python3', ['-c', 'import fcntl,sys; f=open(sys.argv[1],"a"); fcntl.flock(f,fcntl.LOCK_EX); print("held",flush=True); sys.stdin.read()',
      join(f.host.runsRoot, 'queue', 'dispatchd.tick.lock')], { stdio: ['pipe', 'pipe', 'ignore'] });
    await new Promise(r => tick.stdout.once('data', r));
    const busy = await f.pass();
    expect(busy).toMatchObject({ held: 'dispatcher-tick-busy', claimed: [] });
    expect(existsSync(f.lease('RQ-REVIEW-A'))).toBe(false);
    expect(f.nodes.view(['ashlr']).jobs).toEqual([]);
    tick.stdin.end();
    await new Promise(r => tick.once('close', r));
    // dispatchd launched B first: its marker wins.
    writeFileSync(join(f.host.runsRoot, 'queue', 'run', 'RQ-REVIEW-B.dispatched'), '');
    const report = await f.pass();
    expect(report.claimed).toEqual(['RQ-REVIEW-A']);
    expect(report.rows.find(r => r.job === 'RQ-REVIEW-B')!.reasons).toEqual(['local_claim_present']);
    expect(f.ready()).toBe(row('RQ-REVIEW-B') + '\n');
    // dispatchd's own O_EXCL lease primitive cannot take the bridged row.
    const out = execFileSync('python3', ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); import batch_sessions as b; print(b.acquire_lease(sys.argv[2], "RQ-REVIEW-A", "RQ-BATCH-x"))',
      resolve('contrib/mac'), join(f.host.runsRoot, 'queue', 'run')]).toString().trim();
    expect(out).toBe('False');
  });

  it('derives pack caps from the runner probe, never from config', async () => {
    const reply = (stdout: unknown, status = 0) => (() => ({ status, stdout })) as unknown as typeof spawnSync;
    expect(probeRunnerPacks('/runner', reply(JSON.stringify({ protocol: 'phm-node-worker/v1',
      packs: ['shell-check', 'omlx-ping', 'codex-file', 'codex-file', 'BAD PACK', 7] })))).toEqual(
      ['pack:codex-file', 'pack:omlx-ping', 'pack:shell-check']);
    expect(probeRunnerPacks('/runner', reply('{"protocol":"other","packs":["codex-file"]}'))).toEqual([]);
    expect(probeRunnerPacks('/runner', reply('not json'))).toEqual([]);
    expect(probeRunnerPacks('/runner', reply(JSON.stringify({ protocol: 'phm-node-worker/v1', packs: ['codex-file'] }), 2))).toEqual([]);
    const old = (() => ({ status: null, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) })) as unknown as typeof spawnSync;
    expect(probeRunnerPacks('/runner', old)).toEqual([]);
    // A runner that reports codex-file makes a read-only row routable; without it the row stays local.
    const caps = ['codex', ...probeRunnerPacks('/runner', reply(JSON.stringify({ protocol: 'phm-node-worker/v1', packs: ['codex-file'] })))];
    expect((await fixture([row('RQ-REVIEW-A')], [{ id: 'muse-w2', caps, slots: 1 }]).pass(false)).rows[0]!.offload).toBe(true);
    expect((await fixture([row('RQ-REVIEW-A')], [{ id: 'muse-w2', caps: ['codex'], slots: 1 }]).pass(false)).rows[0]!.reasons)
      .toEqual(['node_pack_unsupported']);
  });

  it('stays inert with a reason code until the installed dispatcher honors the lease protocol', async () => {
    const f = fixture([row('RQ-REVIEW-A')]);
    writeFileSync(join(f.host.runsRoot, 'bin', 'dispatchd.py'), '# old dispatcher\n');
    expect(nodeBridgeReadiness(f.host)).toBe('dispatcher-lease-unsupported');
    const report = await f.pass();
    expect(report).toMatchObject({ inert: 'dispatcher-lease-unsupported', claimed: [] });
    expect(report.rows[0]!.offload).toBe(true);
    rmSync(join(f.host.runsRoot, 'bin', 'dispatchd.py'));
    expect(nodeBridgeReadiness(f.host)).toBe('dispatcher-absent');
    expect((await f.pass(true, { owner: null })).inert).toBe('bridge-owner-unset');
  });
});
