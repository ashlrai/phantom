import { spawn, type spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { DriveNodes, type NodesState, type NodesStore } from '../src/core/drive/nodes/index.js';
import { NODE_BRIDGE_CALL_MS, NODE_BRIDGE_PASS_BUDGET_MS, bridgeLeaseOwner, localBridgeRouter, nodeBridgeReadiness, runNodeBridge, type BridgeRouter, type NodeBridgeHost } from '../src/core/drive/nodes/ready-bridge.js';
import { emptyState } from '../src/core/drive/nodes/state.js';
import { probeNodeLanes } from '../src/core/drive/nodes/worker.js';
import { probeRunnerPacks } from '../src/core/drive/nodes/runner-packs.js';
import { runTickPhase } from '../src/core/daemon/tick-phases.js';
import { bridgePhasesWithReceipts, createBridgeReceipts } from '../src/core/drive/nodes/ready-bridge-receipts.js';

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
  for (const d of ['queue/run', 'queue/batches', 'queue/prompts', 'bin']) mkdirSync(join(host.runsRoot, d), { recursive: true });
  copyFileSync(resolve('contrib/mac/dispatchd.py'), join(host.runsRoot, 'bin', 'dispatchd.py'));
  // codex-file offload embeds the prompt: materialize each row's absolute
  // /prompts/<job>.md cell as a real file inside queue/prompts, as live rows do.
  const byJob = new Map<string, string>();
  const materialized = rows.map(r => {
    const f = r.split('\t');
    if (!f[4]?.startsWith('/')) return r;
    const promptPath = join(host.runsRoot, 'queue', 'prompts', `${f[0]!}.md`);
    writeFileSync(promptPath, `# ${f[0]}\nBounded fixture task.\n`, { mode: 0o600 });
    f[4] = promptPath;
    const line = f.join('\t');
    byJob.set(f[0]!, line);
    return line;
  });
  writeFileSync(join(host.runsRoot, 'queue', 'ready.tsv'), materialized.map(r => r + '\n').join(''));
  let now = 1_000_000;
  const nodes_ = new DriveNodes(new MemoryStore(), { now: () => now, nodeTtlMs: 600_000, leaderTtlMs: 600_000, claimTtlMs: 1_000 });
  const sessions = new Map(nodes.map(n => [n.id, nodes_.join(n.id, { owners: ['ashlr'], caps: n.caps, ...(n.slots === undefined ? {} : { slots: n.slots }) })!]));
  const router = localBridgeRouter(nodes_, root);
  const pass = (apply = true, extra: Partial<Parameters<typeof runNodeBridge>[0]> = {}) =>
    runNodeBridge({ host, router, owner: 'ashlr', apply, now, pendingTtlMs: 60_000, ...extra });
  const ready = () => readFileSync(join(host.runsRoot, 'queue', 'ready.tsv'), 'utf8');
  const lease = (job: string) => join(host.runsRoot, 'queue', 'run', `${job}.batched`);
  // The ready.tsv line as written (prompt cell materialized), or the input row.
  const line = (job: string) => byJob.get(job) ?? rows.find(r => r.split('\t')[0] === job) ?? '';
  return { host, nodes: nodes_, sessions, router, pass, ready, lease, line, advance: (ms: number) => { now += ms; } };
}

describe('ready.tsv -> node router bridge', () => {
  it('keeps the blocked lock step and prior receipts in the timed-out daemon phase', async () => {
    const f = fixture([]);
    const started = Date.parse('2026-11-24T12:00:00Z');
    let now = started;
    const receipts = createBridgeReceipts(process.pid, f.host.runsRoot, () => now);
    const phase = await runTickPhase('node-bridge', signal => {
      signal.addEventListener('abort', () => { now = started + 10; receipts.finish(); }, { once: true });
      return f.pass(true, { signal, trace: receipts.trace, lock: () => new Promise(() => undefined) });
    }, { deadlineMs: 10, graceMs: 0, detached: true });
    expect(phase.status).toBe('timeout');
    expect(bridgePhasesWithReceipts([phase.record], process.pid, new Date(started).toISOString(), f.host.runsRoot, started + 500)).toMatchObject([{
      status: 'timeout', bridgeTiming: { endedAt: new Date(started + 10).toISOString(), steps: [
        { step: 'check-readiness', outcome: 'ok', ms: 0, startedAt: new Date(started).toISOString() },
        { step: 'acquire-lock', outcome: 'in-flight', ms: 10, startedAt: new Date(started).toISOString() },
      ] },
    }]);
  });

  it('reports failed steps without attributing receipts to an unrelated daemon', async () => {
    const f = fixture([]);
    const started = Date.parse('2026-11-24T12:00:00Z');
    const startedAt = new Date(started).toISOString();
    const phases = [{ name: 'node-bridge', status: 'degraded', durationMs: 5 }] as const;
    const read = (pid: number) => bridgePhasesWithReceipts([...phases], pid, startedAt, f.host.runsRoot, started + 5);
    expect(read(process.pid)).toEqual(phases);
    const receipts = createBridgeReceipts(process.pid, f.host.runsRoot, () => started);
    await expect(f.pass(true, { trace: receipts.trace, lock: async () => { throw new Error('fixture lock failed'); } })).rejects.toThrow('fixture lock failed');
    receipts.finish();
    expect(read(process.pid + 1)).toEqual(phases);
    expect(read(process.pid)).toMatchObject([{ bridgeTiming: { steps: [
      { step: 'check-readiness', outcome: 'ok' }, { step: 'acquire-lock', outcome: 'error' },
    ] } }]);
  });

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
    expect(JSON.parse(readFileSync(join(f.host.runsRoot, 'queue', 'batches', `${owner}.json`), 'utf8')).routerScope).toBe(f.router.scope);
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

  it('never offloads a parked row, even when its spec still names a remote lane', async () => {
    const spec = JSON.stringify({ preferred_lane: 'codex' });
    const f = fixture([
      // Dispatcher dialect: PARKED- marker in the lane cell, spec retained from before the park.
      ['RQ-REVIEW-PARKED', 'phantom', 'PARKED-DEP.codex', 'fast', '/prompts/RQ-REVIEW-PARKED.md', spec].join('\t'),
      // Same hold with no spec column at all.
      row('RQ-REVIEW-NOSPEC', 'PARKED-MERGERATE.codex'),
      // Status-first dialect: the PARKED- marker leads the row.
      ['PARKED-DEP.codex', 'RQ-REVIEW-HOLD', 'codex', 'fast', 'phantom', '/prompts/RQ-REVIEW-HOLD.md', spec].join('\t'),
      row('RQ-REVIEW-FINE'),
    ]);
    const dry = await f.pass(false);
    const reasons = Object.fromEntries(dry.rows.map(r => [r.job, r.reasons]));
    expect(reasons['RQ-REVIEW-PARKED']).toEqual(['parked_row']);
    expect(reasons['RQ-REVIEW-NOSPEC']).toEqual(['parked_row']);
    expect(reasons['PARKED-DEP.codex']).toEqual(['parked_row']);
    expect(dry.rows.find(r => r.job === 'RQ-REVIEW-FINE')!.offload).toBe(true);
    const applied = await f.pass();
    expect(applied.claimed).toEqual(['RQ-REVIEW-FINE']);
    expect(applied.requeued).toEqual([]);
    const left = f.ready();
    expect(left).toContain('PARKED-DEP.codex');
    expect(left).toContain('PARKED-MERGERATE.codex');
    expect(left).not.toContain('RQ-REVIEW-FINE');
    expect(f.nodes.view(['ashlr']).jobs.map(j => j.id)).toEqual(['ready:RQ-REVIEW-FINE:1']);
  });

  it('rejects inherited and non-string data classes', async () => {
    const f = fixture([
      row('RQ-REVIEW-DC-INHERITED', 'codex-cmp', { data_class: 'constructor' }),
      row('RQ-REVIEW-DC-NONSTRING', 'codex-cmp', { data_class: 4 }),
    ]);
    const report = await f.pass(false);
    const reasons = Object.fromEntries(report.rows.map(r => [r.job, r.reasons]));
    expect(reasons).toMatchObject({
      'RQ-REVIEW-DC-INHERITED': ['data_class_invalid'],
      'RQ-REVIEW-DC-NONSTRING': ['data_class_invalid'],
    });
    expect(report.rows.every(r => !r.offload)).toBe(true);
  });

  it('isolates malformed needs to their row', async () => {
    const f = fixture([
      row('RQ-REVIEW-NEEDS', 'codex-cmp', { needs: [{ toString: null }] }),
      row('RQ-REVIEW-GOOD'),
    ]);
    const report = await f.pass(false);
    const reasons = Object.fromEntries(report.rows.map(r => [r.job, r.reasons]));
    expect(reasons).toMatchObject({
      'RQ-REVIEW-NEEDS': ['needs_invalid'],
      'RQ-REVIEW-GOOD': [],
    });
    expect(report.rows.find(r => r.job === 'RQ-REVIEW-GOOD')!.offload).toBe(true);
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

  it('accounts free slots once per physical host for capacity-reporting nodes', async () => {
    // Two sessions on one host each advertise the host's measured slots; the
    // pair offers the host's 2 slots once, not 4 — matching nodeCapacityView.
    const f = fixture(['A', 'B', 'C'].map(j => row(`RQ-REVIEW-${j}`)),
      [{ id: 'node-a', caps: READ, slots: 2 }, { id: 'node-b', caps: READ, slots: 2 }]);
    const capacity = { hostId: 'shared-host', ramBytes: 8 * 1024 ** 3, slots: 2, held: null, sampledAtMs: 1_000_000 };
    for (const id of ['node-a', 'node-b']) f.nodes.heartbeat(f.sessions.get(id)!, { capacity });
    const report = await f.pass(false);
    expect(report.rows.map(r => r.offload)).toEqual([true, true, false]);
    expect(report.rows[2]!.reasons).toEqual(['no_free_slot']);
    // A second host with its own measured slots still takes the third row.
    const g = fixture(['A', 'B', 'C', 'D'].map(j => row(`RQ-REVIEW-${j}`)),
      [{ id: 'node-a', caps: READ, slots: 2 }, { id: 'node-b', caps: READ, slots: 2 }, { id: 'node-c', caps: READ, slots: 2 }]);
    for (const id of ['node-a', 'node-b']) g.nodes.heartbeat(g.sessions.get(id)!, { capacity });
    g.nodes.heartbeat(g.sessions.get('node-c')!, { capacity: { ...capacity, hostId: 'other-host' } });
    const second = await g.pass(false);
    expect(second.rows.map(r => r.offload)).toEqual([true, true, true, true]);
    expect(new Set(second.rows.map(r => r.nodeId))).toEqual(new Set(['node-a', 'node-c']));
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
    expect(f.ready()).toBe(f.line('RQ-REVIEW-A') + '\n');
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
    expect(f.ready()).toBe(f.line(other) + '\n');
  });

  it('holds a lease created under a different owner without withdrawing or requeueing it', async () => {
    const f = fixture([row('RQ-REVIEW-OWNER')]);
    await f.pass();
    const leaseOwner = bridgeLeaseOwner('RQ-REVIEW-OWNER');
    const manifestPath = join(f.host.runsRoot, 'queue', 'batches', `${leaseOwner}.json`);
    const manifestBefore = readFileSync(manifestPath, 'utf8');
    const leaseBefore = readFileSync(f.lease('RQ-REVIEW-OWNER'), 'utf8');
    const readyBefore = f.ready();
    let withdrawCalls = 0;
    const router: BridgeRouter = { ...f.router, withdraw: (jobId, owner) => {
      withdrawCalls++;
      return f.router.withdraw(jobId, owner);
    } };

    const report = await f.pass(true, { owner: 'owner-b', router });
    expect(report.leases[0]).toMatchObject({ leaseOwner, action: 'hold-owner-mismatch' });
    expect(withdrawCalls).toBe(0);
    expect(report.requeued).toEqual([]);
    expect(f.ready()).toBe(readyBefore);
    expect(readFileSync(f.lease('RQ-REVIEW-OWNER'), 'utf8')).toBe(leaseBefore);
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
  });

  it('holds a manifest from a different router scope without withdrawing or requeueing it', async () => {
    const f = fixture([row('RQ-REVIEW-SCOPE')]);
    await f.pass();
    const leaseOwner = bridgeLeaseOwner('RQ-REVIEW-SCOPE');
    const manifestPath = join(f.host.runsRoot, 'queue', 'batches', `${leaseOwner}.json`);
    const manifestBefore = readFileSync(manifestPath, 'utf8');
    const leaseBefore = readFileSync(f.lease('RQ-REVIEW-SCOPE'), 'utf8');
    const readyBefore = f.ready();
    let withdrawCalls = 0;
    const router: BridgeRouter = { ...f.router, scope: `${f.router.scope}:changed`, withdraw: (jobId, owner) => {
      withdrawCalls++;
      return f.router.withdraw(jobId, owner);
    } };

    const report = await f.pass(true, { router });
    expect(report.leases[0]).toMatchObject({ leaseOwner, action: 'hold-router-mismatch' });
    expect(withdrawCalls).toBe(0);
    expect(report.requeued).toEqual([]);
    expect(f.ready()).toBe(readyBefore);
    expect(readFileSync(f.lease('RQ-REVIEW-SCOPE'), 'utf8')).toBe(leaseBefore);
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
  });

  it('holds legacy manifests without a router scope, including when dry-run has no router', async () => {
    const f = fixture([row('RQ-REVIEW-LEGACY')]);
    await f.pass();
    const leaseOwner = bridgeLeaseOwner('RQ-REVIEW-LEGACY');
    const manifestPath = join(f.host.runsRoot, 'queue', 'batches', `${leaseOwner}.json`);
    const legacy = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    delete legacy['routerScope'];
    writeFileSync(manifestPath, JSON.stringify(legacy) + '\n');
    const manifestBefore = readFileSync(manifestPath, 'utf8');
    const leaseBefore = readFileSync(f.lease('RQ-REVIEW-LEGACY'), 'utf8');
    const readyBefore = f.ready();
    let withdrawCalls = 0;
    const router: BridgeRouter = { ...f.router, withdraw: (jobId, owner) => {
      withdrawCalls++;
      return f.router.withdraw(jobId, owner);
    } };

    const report = await f.pass(true, { router });
    expect(report.leases[0]).toMatchObject({ leaseOwner, action: 'hold-router-mismatch' });
    expect(withdrawCalls).toBe(0);
    expect(report.requeued).toEqual([]);
    expect(f.ready()).toBe(readyBefore);
    expect(readFileSync(f.lease('RQ-REVIEW-LEGACY'), 'utf8')).toBe(leaseBefore);
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);

    const dryRun = await f.pass(false, { router: null });
    expect(dryRun.leases[0]).toMatchObject({ leaseOwner, action: 'hold-router-mismatch' });
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
    expect(f.ready()).toBe(f.line('RQ-REVIEW-B') + '\n');
    // dispatchd's own O_EXCL lease primitive cannot take the bridged row.
    const out = execFileSync('python3', ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); import batch_sessions as b; print(b.acquire_lease(sys.argv[2], "RQ-REVIEW-A", "RQ-BATCH-x"))',
      resolve('contrib/mac'), join(f.host.runsRoot, 'queue', 'run')]).toString().trim();
    expect(out).toBe('False');
  });

  it('serializes two passes while a staged manifest is waiting for publication', async () => {
    const f = fixture([row('RQ-REVIEW-RACE')]);
    const baseRouter = localBridgeRouter(f.nodes, f.router.scope);
    let held = false;
    const lock = async () => {
      if (held) return { busy: 'bridge-pass-busy' };
      held = true;
      return { release: async () => { held = false; } };
    };
    let secondPass: ReturnType<typeof runNodeBridge> | undefined;
    const router: BridgeRouter = {
      scope: baseRouter.scope,
      view: owner => baseRouter.view(owner),
      withdraw: (jobId, owner) => baseRouter.withdraw(jobId, owner),
      enqueue: (jobId, spec) => {
        secondPass ??= f.pass(true, { router, lock });
        return baseRouter.enqueue(jobId, spec);
      },
    };

    const first = await f.pass(true, { router, lock });
    const second = await secondPass!;
    expect(first.claimed).toEqual(['RQ-REVIEW-RACE']);
    expect(second.held).toBe('bridge-pass-busy');
    expect(second.requeued).toEqual([]);
    expect(f.ready()).toBe('');
    expect(f.nodes.view(['ashlr']).jobs).toHaveLength(1);
    expect(existsSync(f.lease('RQ-REVIEW-RACE'))).toBe(true);
  });

  it('rechecks the ready row under lock before claiming its planned pack', async () => {
    const f = fixture([row('RQ-REVIEW-LOCKED')]);
    const changed = row('RQ-REVIEW-LOCKED', 'codex-local');
    const lock = async () => {
      writeFileSync(join(f.host.runsRoot, 'queue', 'ready.tsv'), `${changed}\n`);
      return { release: async () => {} };
    };

    const report = await f.pass(true, { lock });
    expect(report.claimed).toEqual([]);
    expect(report.rows[0]).toMatchObject({ offload: false, reasons: ['local_execution_required'] });
    expect(f.ready()).toBe(`${changed}\n`);
    expect(f.nodes.view(['ashlr']).jobs).toEqual([]);
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

  it('does not mistake a completed node result for a producer withdrawal', async () => {
    const f = fixture([row('RQ-REVIEW-WITHDRAWN')], [{ id: 'withdrawn', caps: READ, slots: 1 }]);
    await f.pass();
    const pulled = f.nodes.pull(f.sessions.get('withdrawn')!)!;
    expect(f.nodes.complete(pulled.claim, 'withdrawn')).toBe(true);
    expect(f.nodes.withdraw(pulled.job.id, 'ashlr')).toEqual({ state: 'completed', result: 'withdrawn' });

    f.advance(61_000);
    const report = await f.pass();
    expect(report.leases[0]).toMatchObject({ routerState: 'completed', action: 'complete' });
    expect(report.completed).toEqual(['RQ-REVIEW-WITHDRAWN']);
    expect(report.requeued).toEqual([]);
    expect(f.ready()).toBe('');
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
  it('starts no router call that cannot finish before the pass deadline', async () => {
    const f = fixture([row('RQ-REVIEW-A'), row('RQ-REVIEW-B'), row('RQ-REVIEW-C')]);
    let clock = 0;
    const calls: string[] = [];
    // Each router call blocks for the SSH transport's worst case, as a slow witness does.
    const slow: BridgeRouter = {
      scope: f.router.scope,
      view: (owner) => { calls.push('view'); clock += NODE_BRIDGE_CALL_MS; return f.router.view(owner); },
      enqueue: (jobId, spec) => { calls.push('enqueue'); clock += NODE_BRIDGE_CALL_MS; return f.router.enqueue(jobId, spec); },
      withdraw: (jobId, owner) => { calls.push('withdraw'); clock += NODE_BRIDGE_CALL_MS; return f.router.withdraw(jobId, owner); },
    };
    const report = await f.pass(true, { router: slow, clock: () => clock, deadlineAt: NODE_BRIDGE_PASS_BUDGET_MS });
    expect(clock).toBeLessThanOrEqual(NODE_BRIDGE_PASS_BUDGET_MS);
    expect(calls).toEqual(['view', 'enqueue']);
    expect(report.held).toBe('deadline');
    expect(report.claimed).toHaveLength(1);
    // The rows it had no time for stay in ready.tsv for the next pass.
    expect(f.ready().trim().split('\n')).toHaveLength(2);
    expect(report.rows.filter(r => r.reasons.includes('deadline'))).toHaveLength(2);
  });
});
