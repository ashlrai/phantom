import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { projectFleetAwareness } from '../src/core/fleet/awareness.js';
import { readFleetAwareness } from '../src/core/fleet/awareness-read.js';
import { emptyState, isNodeCapacity, parseState, type NodeCapacitySample, type NodesStore } from '../src/core/drive/nodes/state.js';
import { executePool, initializePool } from '../src/core/drive/nodes/pool.js';
import { DriveNodes } from '../src/core/drive/nodes/index.js';

function fixture() {
  let now = 100_000;
  const state = emptyState();
  const store: NodesStore = { transaction: fn => { const result = fn(state); parseState(state); return structuredClone(result); } };
  initializePool(store, 'primary', 'backup', now);
  const run = (verb: string, args: string[] = []) => executePool(store, { origin: 'primary', action: 'execute', verb, args }, 'mason', now).result;
  const beat = (nodeId: string, sample: Partial<NodeCapacitySample> = {}) => {
    const node = state.nodes.find(n => n.nodeId === nodeId)!;
    run('beat', ['--node', nodeId, '--session', String(node.session), '--capacity', JSON.stringify({
      ramBytes: 128 * 1024 ** 3, slots: 22, held: null, hostId: nodeId, sampledAtMs: now, ...sample })]);
  };
  const add = (nodeId: string, sample: Partial<NodeCapacitySample> = {}) => {
    run('join', ['--node', nodeId, '--caps', 'codex', '--slots', '64']); beat(nodeId, sample);
    return state.nodes.find(n => n.nodeId === nodeId)!;
  };
  const enqueue = (id = 'job') => run('enqueue', ['--job', id, '--requires', 'codex']);
  const plan = () => new DriveNodes(store, { now: () => now }).plan();
  return { state, store, run, beat, add, enqueue, plan, now: () => now, advance: (ms: number) => { now += ms; } };
}

test('pool dispatch prefers measured free slots and shares one host budget across workers', () => {
  const f = fixture();
  f.add('mbp-w1', { hostId: 'mbp', slots: 3 }); f.add('mbp-w2', { hostId: 'mbp', slots: 3 });
  f.add('air', { slots: 1 }); f.add('held', { slots: 0, held: 'memory-pressure' });
  for (let i = 0; i < 6; i++) f.enqueue(`j${i}`);
  expect(f.plan().map(r => r.nodeId)).toEqual(['mbp-w1', 'mbp-w1', 'air', 'mbp-w1', null, null]);
  const node = f.state.nodes[0]!;
  expect(f.run('pull', ['--node', node.nodeId, '--session', String(node.session)]).pulled).toBe(true);
  const report = projectFleetAwareness(f.state, f.now(), { schema: 'dispatchd.status.v1', last_tick: new Date(f.now()).toISOString(), paused: null,
    lanes: { codex: { running: 2, target: 5, effective_target: 4, floor: 1, queued: 6, held: false } } });
  expect(report.hosts.find(h => h.hostId === 'mbp')).toMatchObject({ slots: 3, running: 1, freeSlots: 2 });
  expect(report.lanes[0]).toMatchObject({ running: 2, target: 5, effectiveTarget: 4, floor: 1, queued: 6, available: 2 });
  expect(report.queue).toEqual({ nodePending: 5, laneQueued: 6 });
  expect(f.plan().filter(r => r.nodeId)).toHaveLength(3);
});

test('unknown, stale, future and expired reports never become pool capacity; exact two-interval boundary is fresh', () => {
  const f = fixture(); const n = f.add('node'); f.enqueue();
  f.advance(6000); expect(f.plan()[0]?.nodeId).toBe('node');
  f.advance(1); expect(f.plan()[0]?.nodeId).toBeNull();
  f.run('beat', ['--node', n.nodeId, '--session', String(n.session)]);
  expect(f.plan()[0]?.nodeId).toBeNull(); // a heartbeat alone cannot refresh a capacity sample
  f.beat('node', { sampledAtMs: f.now() + 1 }); expect(f.plan()[0]?.nodeId).toBeNull();
  f.beat('node'); expect(f.plan()[0]?.nodeId).toBe('node');
  n.expiresAt = f.now(); expect(f.plan()[0]?.nodeId).toBeNull();
  const legacy = fixture(); legacy.run('join', ['--node', 'legacy', '--slots', '64']); legacy.enqueue();
  expect(legacy.plan()[0]?.nodeId).toBeNull();
  expect(projectFleetAwareness(legacy.state, legacy.now()).hosts[0]?.freeSlots).toBeNull();
});

test.each([
  { paused: 'disk guard' },
  { admission: { admit: false } },
  { admission: { decision: 'stop' } },
])('fleet lane availability honors a fresh dispatcher stop (%j)', stop => {
  const now = 100_000;
  const status = {
    schema: 'dispatchd.status.v1', last_tick: new Date(now).toISOString(), paused: null,
    lanes: { codex: { running: 1, target: 4, effective_target: 3, queued: 5, held: false } },
    ...stop,
  };
  expect(projectFleetAwareness(null, now, status).lanes[0]).toMatchObject({
    running: 1, target: 4, effectiveTarget: 3, queued: 5, available: 0,
  });
  expect(projectFleetAwareness(null, now + 60_001, status).lanes[0]?.available).toBeNull();
});

test('a claim fenced by a rejoined session frees its host slots at once', () => {
  const f = fixture();
  const n = f.add('worker', { hostId: 'mac', slots: 2 });
  f.enqueue();
  const nodes = new DriveNodes(f.store, { now: f.now });
  expect(nodes.pull(n)!.claim.jobId).toBe('job');
  f.run('leave', ['--node', 'worker', '--session', String(n.session)]);
  f.add('worker', { hostId: 'mac', slots: 2 });
  const report = projectFleetAwareness(f.state, f.now());
  expect(report.hosts).toHaveLength(1);
  expect(report.hosts[0]).toMatchObject({ hostId: 'mac', slots: 2, running: 0, freeSlots: 2 });
});

test.each(['memory-pressure', 'disk-pressure', 'memory-unmeasured', 'disk-unmeasured'] as const)('hold %s blocks siblings and direct claims', held => {
  const f = fixture(); const a = f.add('a', { hostId: 'mac' }); f.add('b', { hostId: 'mac', slots: 0, held }); f.enqueue();
  expect(f.plan()[0]?.nodeId).toBeNull();
  const nodes = new DriveNodes(f.store, { now: f.now });
  expect(nodes.claim(f.state.leader!, a, 'job')).toBeNull();
  f.advance(6001); f.beat('a');
  expect(f.plan()[0]?.nodeId).toBe('a'); // stale held sibling is unknown, cannot itself be assigned
  expect(nodes.claim(f.state.leader!, f.state.nodes[1]!, 'job')).toBeNull();
});

test('accepted witness boundaries weight observed latency and discard expired or incomplete samples', () => {
  const f = fixture(); const slow = f.add('a-slow', { slots: 1 });
  f.enqueue('slow'); const first = new DriveNodes(f.store, { now: f.now }).pull(slow)!;
  f.advance(4000); expect(new DriveNodes(f.store, { now: f.now }).complete(first.claim, 'result:slow')).toBe(true);
  f.beat('a-slow', { slots: 0, held: 'disk-pressure' });
  const fast = f.add('z-fast', { slots: 1 }); f.enqueue('fast');
  const second = new DriveNodes(f.store, { now: f.now }).pull(fast)!;
  f.advance(1000); expect(new DriveNodes(f.store, { now: f.now }).complete(second.claim, 'result:fast')).toBe(true);
  f.beat('a-slow', { slots: 1 }); f.beat('z-fast', { slots: 1 }); f.enqueue('next');
  expect(f.plan()[0]?.nodeId).toBe('z-fast');
  expect(projectFleetAwareness(f.state, f.now()).hosts.map(h => h.latency.medianMs)).toEqual([4000, 1000]);
  delete f.state.jobs[1]!.startedAt; expect(projectFleetAwareness(f.state, f.now()).hosts[1]!.latency.medianMs).toBeNull();
  f.advance(86_400_001); expect(projectFleetAwareness(f.state, f.now()).hosts.every(h => h.latency.samples === 0)).toBe(true);
});

test('a producer withdrawal is a fence, not latency evidence; accepted completions still count', () => {
  const f = fixture();
  const worker = f.add('worker', { hostId: 'mac', slots: 4 });
  f.enqueue('fenced');
  const nodes = new DriveNodes(f.store, { now: f.now });
  expect(nodes.pull(worker)!.claim.jobId).toBe('fenced');
  f.advance(31_000); // claim, node and leader leases all lapse
  expect(f.run('withdraw', ['--job', 'fenced'])).toMatchObject({ state: 'withdrawn' });
  const rejoined = f.add('worker', { hostId: 'mac', slots: 4 });
  f.enqueue('real');
  const second = nodes.pull(rejoined)!;
  f.advance(2000);
  expect(nodes.complete(second.claim, 'result:real')).toBe(true);
  const host = projectFleetAwareness(f.state, f.now()).hosts.find(h => h.hostId === 'mac')!;
  expect(host.latency).toEqual({ samples: 1, medianMs: 2000, windowMs: 86_400_000 });
});

test('unattributed completions cannot give a reassigned worker a routing advantage', () => {
  const f = fixture();
  const worker = f.add('z-worker', { hostId: 'old-mac', slots: 1 });
  const nodes = new DriveNodes(f.store, { now: f.now });
  f.enqueue('legacy');
  const legacy = nodes.pull(worker)!;
  f.advance(100);
  expect(nodes.complete(legacy.claim, 'result:legacy')).toBe(true);
  delete f.state.jobs[0]!.executionHostId; // Older records may lack claim-time host evidence.
  f.run('leave', ['--node', worker.nodeId, '--session', String(worker.session)]);

  const measured = f.add('a-worker', { hostId: 'measured-mac', slots: 1 });
  f.enqueue('measured');
  const run = nodes.pull(measured)!;
  f.advance(4000);
  expect(nodes.complete(run.claim, 'result:measured')).toBe(true);
  f.beat(measured.nodeId, { hostId: 'measured-mac', slots: 1 });
  f.add(worker.nodeId, { hostId: 'new-mac', slots: 1 });
  f.enqueue('next');

  expect(projectFleetAwareness(f.state, f.now()).hosts.map(h => [h.hostId, h.latency.medianMs]))
    .toEqual([['measured-mac', 4000], ['new-mac', null]]);
  expect(f.plan()[0]?.nodeId).toBe(measured.nodeId);
});

test('capacity cannot bypass owner/capability/auth fences and status stays scoped', () => {
  const f = fixture(); f.add('node');
  const nodes = new DriveNodes(f.store, { now: f.now });
  nodes.enqueue('foreign', { owner: 'other' }); nodes.enqueue('auth', { owner: 'mason', requires: ['gh'] });
  expect(nodes.plan().every(r => r.nodeId === null)).toBe(true);
  nodes.join('foreign-node', { owners: ['other'] });
  const view = f.run('status');
  expect(JSON.stringify(view)).not.toContain('foreign');
  expect(view.nodes).toEqual([expect.objectContaining({ capacity: expect.objectContaining({ slots: 22, held: null }) })]);
  for (const bad of [null, {}, { ...f.state.nodes[0]!.capacity, slots: 65 }, { ...f.state.nodes[0]!.capacity, token: 'refused' },
    { ...f.state.nodes[0]!.capacity, held: 'memory-pressure' }]) expect(isNodeCapacity(bad)).toBe(false);
  expect(() => f.run('beat', ['--node', 'node', '--session', String(f.state.nodes[0]!.session), '--capacity', '{}'])).toThrow();
});

test('unattributed live claims hold capacity and executor identity binds latency across node moves', () => {
  const f = fixture(); const n = f.add('worker', { hostId: 'old-mac' }); f.enqueue();
  const nodes = new DriveNodes(f.store, { now: f.now }), pulled = nodes.pull(n)!;
  f.advance(100); nodes.complete(pulled.claim, 'done');
  f.beat('worker', { hostId: 'new-mac' });
  expect(projectFleetAwareness(f.state, f.now()).hosts[0]!.latency.samples).toBe(0);
  f.state.jobs[0]!.state = 'running'; delete f.state.jobs[0]!.executionHostId;
  f.state.nodes[0]!.capacity = undefined; f.add('other');
  expect(projectFleetAwareness(f.state, f.now()).hosts.every(h => h.freeSlots === null)).toBe(true);
});

test('bounded projection reads actual fixture mirrors and rejects symlinks, oversized files and stale lanes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-aware-')); const f = fixture(); f.add('mac');
  try {
    await mkdir(join(root, 'node-pool')); await mkdir(join(root, 'queue'));
    await writeFile(join(root, 'node-pool/primary-mirror.json'), JSON.stringify(f.state));
    await writeFile(join(root, 'queue/status.json'), JSON.stringify({ last_tick: new Date(f.now() - 60_001).toISOString(),
      lanes: { codex: { running: 0, target: 20, queued: 4 } } }));
    const options = { home: root, runsDir: root, now: f.now() };
    const report = await readFleetAwareness(options);
    expect(report.hosts[0]?.freeSlots).toBe(22); expect(report.lanes[0]?.available).toBeNull();
    expect(report.queue.laneQueued).toBeNull();
    await rm(join(root, 'node-pool/primary-mirror.json'));
    await writeFile(join(root, 'outside'), JSON.stringify(f.state));
    await symlink(join(root, 'outside'), join(root, 'node-pool/primary-mirror.json'));
    expect((await readFleetAwareness(options)).hosts).toEqual([]);
    await rm(join(root, 'node-pool/primary-mirror.json'));
    await writeFile(join(root, 'node-pool/primary-mirror.json'), ' '.repeat(2 * 1024 * 1024 + 1));
    expect((await readFleetAwareness(options)).phases.find(p => p.name === 'mirror')?.status).toBe('unavailable');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('hung reads abort at their phase deadlines, remain unknown and cannot mutate a returned snapshot', async () => {
  vi.useFakeTimers();
  try {
    const signals: AbortSignal[] = []; let finish: ((v: unknown) => void) | undefined;
    const pending = readFleetAwareness({ now: 100_000, deadlineMs: 10, read: (_path, signal) => {
      signals.push(signal); return new Promise(resolve => { finish = resolve; });
    } });
    await vi.advanceTimersByTimeAsync(10); const report = await pending;
    expect(report.phases.every(p => p.status === 'timeout')).toBe(true);
    expect(signals.every(s => s.aborted)).toBe(true); expect(report.queue.nodePending).toBeNull();
    const before = JSON.stringify(report); finish?.({ lanes: {} }); await Promise.resolve();
    expect(JSON.stringify(report)).toBe(before);
  } finally { vi.useRealTimers(); }
});

test('failed and cancelled reads are independent, and a pool snapshot outranks an unrelated newer registry', async () => {
  const f = fixture(); f.add('pool-node');
  const local = { ...emptyState(), observedAt: f.now() + 1 };
  const report = await readFleetAwareness({ now: f.now() + 1, read: async path => {
    if (path.endsWith('primary-mirror.json')) return f.state;
    if (path.endsWith('/nodes/nodes.json')) return local;
    throw new Error('unavailable');
  } });
  expect(report.hosts[0]?.hostId).toBe('pool-node'); expect(report.phases.filter(p => p.status === 'unavailable')).toHaveLength(2);
  const controller = new AbortController(); controller.abort();
  const stopped = await readFleetAwareness({ signal: controller.signal, read: async (_path, signal) => { signal.throwIfAborted(); return f.state; } });
  expect(stopped.phases.every(p => p.status === 'timeout')).toBe(true);
  expect(stopped.hosts).toEqual([]);
});
