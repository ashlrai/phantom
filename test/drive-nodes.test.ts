import { describe, expect, it } from 'vitest';
import { DriveNodes, type NodesState, type NodesStore } from '../src/core/drive/nodes/index.js';
import { executeNodeFleet } from '../src/core/drive/nodes/commands.js';
import { emptyState, parseState } from '../src/core/drive/nodes/state.js';

class MemoryStore implements NodesStore {
  state = emptyState();
  transaction<T>(fn: (state: NodesState) => T): T {
    const draft = structuredClone(this.state);
    const result = fn(draft);
    this.state = draft;
    return structuredClone(result);
  }
}

function fixture() {
  let now = 1_000;
  const store = new MemoryStore();
  const options = { now: () => now, nodeTtlMs: 100, leaderTtlMs: 20, claimTtlMs: 40 };
  const a = new DriveNodes(store, options);
  const b = new DriveNodes(store, options);
  const alice = a.join('alice', { owners: ['o'] })!;
  const bob = b.join('bob', { owners: ['o'] })!;
  return { a, b, store, alice, bob, advance: (ms: number) => { now += ms; } };
}

describe('drive node leases', () => {
  it('acquires one leader and renews without changing its fencing token', () => {
    const f = fixture();
    const leader = f.a.heartbeat(f.alice)!.leader!;
    expect(f.b.heartbeat(f.bob)!.leader).toEqual(leader);
    f.advance(10);
    const renewed = f.a.heartbeat(f.alice)!.leader!;
    expect(renewed.token).toBe(leader.token);
    expect(renewed.expiresAt).toBe(leader.expiresAt + 10);
    expect(leader.expiresAt).toBe(1020); // returned values cannot mutate authority
    expect(f.a.snapshot().nodes.find(n => n.nodeId === 'alice')!.heartbeatAt).toBe(1010);
  });

  it('fails over at the exact expiry boundary and refuses the old leader', () => {
    const f = fixture();
    const old = f.a.heartbeat(f.alice)!.leader!;
    f.a.enqueue('job', { owner: 'o' });
    f.advance(20);
    const next = f.b.heartbeat(f.bob)!.leader!;
    expect(next.nodeId).toBe('bob');
    expect(next.token).toBeGreaterThan(old.token);
    expect(f.a.claim(old, f.alice, 'job')).toBeNull();
    expect(f.a.heartbeat(f.alice)!.leader).toEqual(next);
  });

  it('rejoins with a new session and rejects every old session operation', () => {
    const f = fixture();
    f.a.heartbeat(f.alice);
    expect(f.a.join('alice')).toBeNull();
    f.advance(100);
    expect(f.a.heartbeat(f.alice)).toBeNull();
    const rejoined = f.a.join('alice')!;
    expect(rejoined.session).toBeGreaterThan(f.alice.session);
    expect(f.a.heartbeat(f.alice)).toBeNull();
    expect(f.a.leave(f.alice)).toBe(false);
    expect(f.a.heartbeat(rejoined)!.leader!.nodeId).toBe('alice');
    expect(f.a.snapshot().nodes.filter(n => n.nodeId === 'alice')).toHaveLength(1);
  });

  it('graceful leave permits immediate failover without resetting tokens', () => {
    const f = fixture();
    const old = f.a.heartbeat(f.alice)!.leader!;
    expect(f.a.leave(f.alice)).toBe(true);
    const next = f.b.heartbeat(f.bob)!.leader!;
    expect(next.token).toBeGreaterThan(old.token);
    expect(f.a.join('alice')!.session).toBeGreaterThan(next.token);
  });

  it('renews claims and rejects expired claims at the exact boundary', () => {
    const f = fixture();
    const leader = f.a.heartbeat(f.alice)!.leader!;
    f.a.enqueue('job', { owner: 'o' });
    const claim = f.a.claim(leader, f.bob, 'job')!;
    expect(f.b.claim(leader, f.alice, 'job')).toBeNull();
    f.advance(10);
    f.a.heartbeat(f.alice);
    const renewed = f.b.renewClaim(claim)!;
    expect(renewed.token).toBe(claim.token);
    expect(renewed.expiresAt).toBe(claim.expiresAt + 10);
    for (let i = 0; i < 4; i++) {
      f.advance(10);
      f.a.heartbeat(f.alice);
    }
    expect(f.b.renewClaim(renewed)).toBeNull();
    expect(f.b.complete(renewed, 'late')).toBe(false);
    const next = f.a.claim(leader, f.alice, 'job')!;
    expect(next.token).toBeGreaterThan(claim.token);
    expect(f.a.complete(next, 'ok')).toBe(true);
  });

  it('release returns the job to pending, kills the token and cannot double-complete', () => {
    const f = fixture();
    const leader = f.a.heartbeat(f.alice)!.leader!;
    f.a.enqueue('job', { owner: 'o' });
    const claim = f.a.claim(leader, f.bob, 'job')!;
    expect(f.a.release({ ...claim, token: claim.token + 1 })).toBe(false); // forged token
    expect(f.a.release(claim)).toBe(true);
    expect(f.a.snapshot().jobs[0]).toMatchObject({ state: 'pending' });
    expect(f.a.snapshot().jobs[0].declined).toBeUndefined(); // default release is retryable
    expect(f.a.snapshot().jobs[0].claim).toBeUndefined();
    expect(f.b.renewClaim(claim)).toBeNull();
    expect(f.b.complete(claim, 'late')).toBe(false);
    expect(f.b.release(claim)).toBe(false);
    const next = f.a.claim(leader, f.alice, 'job')!;
    expect(next.token).toBeGreaterThan(claim.token);
    expect(f.b.release(claim)).toBe(false); // stale holder cannot release the newer claim
    expect(f.a.complete(next, 'ok')).toBe(true);
    expect(f.a.release(next)).toBe(false);
    expect(parseState(f.store.state).jobs[0].state).toBe('completed');
  });

  it('a plain release stays retryable by the same session and plans no all-declined fix', () => {
    const f = fixture();
    const leader = f.a.heartbeat(f.alice)!.leader!;
    f.a.enqueue('job', { owner: 'o' });
    const claim = f.a.claim(leader, f.bob, 'job')!;
    expect(f.a.release(claim)).toBe(true);
    expect(f.a.claim(leader, f.bob, 'job')!.token).toBeGreaterThan(claim.token);
  });

  it('a declining release is keyed by session and bars that session from re-claiming', () => {
    const f = fixture();
    const leader = f.a.heartbeat(f.alice)!.leader!;
    f.a.enqueue('job', { owner: 'o' });
    const c1 = f.a.claim(leader, f.bob, 'job')!;
    expect(f.a.release(c1, true)).toBe(true);
    expect(f.a.snapshot().jobs[0]).toMatchObject({ state: 'pending', declined: [f.bob.session] });
    expect(f.a.claim(leader, f.bob, 'job')).toBeNull();
    const c2 = f.a.claim(leader, f.alice, 'job')!;
    expect(f.a.release(c2, true)).toBe(true);
    expect(f.a.snapshot().jobs[0].declined).toEqual([f.bob.session, f.alice.session]);
  });

  it('does not re-route a released job to the session that declined it', () => {
    const f = fixture();
    const alice = f.a.join('alice2', { owners: ['o2'] })!, bob = f.b.join('bob2', { owners: ['o2'] })!;
    f.a.heartbeat(alice); f.b.heartbeat(bob);
    f.a.enqueue('job', { owner: 'o2', requires: [], secrets: [] });
    const claim = (f.b.pull(bob) ?? f.a.pull(alice))!.claim;
    const [holder, other, otherNode] = claim.nodeId === 'bob2' ? [f.b, f.a, alice] : [f.a, f.b, bob];
    const self = claim.nodeId === 'bob2' ? bob : alice;
    expect(holder.release(claim, true)).toBe(true);
    expect(holder.pull(self)).toBeNull();
    expect(other.plan('o2')[0]!.nodeId).toBe(otherNode.nodeId);
    expect(other.pull(otherNode)!.claim.jobId).toBe('job');
  });

  it('split brain: only the higher fencing token can complete the same job', () => {
    const f = fixture();
    const oldLeader = f.a.heartbeat(f.alice)!.leader!;
    f.a.enqueue('job', { owner: 'o' });
    const oldClaim = f.a.claim(oldLeader, f.alice, 'job')!;
    f.advance(20); // old worker still believes it leads, and its claim has not expired
    const newLeader = f.b.heartbeat(f.bob)!.leader!;
    expect(f.a.complete(oldClaim, 'before replacement claim')).toBe(false);
    const newClaim = f.b.claim(newLeader, f.bob, 'job')!;
    expect(newClaim.token).toBeGreaterThan(oldClaim.token);
    expect(f.a.renewClaim(oldClaim)).toBeNull();
    expect(f.a.complete(oldClaim, 'stale')).toBe(false);
    expect(f.b.complete(newClaim, 'winner')).toBe(true);
    expect(f.a.complete(oldClaim, 'overwrite')).toBe(false);
    expect(f.b.complete(newClaim, 'duplicate')).toBe(false);
    expect(f.b.claim(newLeader, f.bob, 'job')).toBeNull();
    expect(f.b.enqueue('job')).toBe(false);
    expect(f.a.snapshot().jobs[0].result).toBe('winner');
  });

  it('does not trust caller expiry, owner, epoch or a fabricated higher token', () => {
    const f = fixture();
    const leader = f.a.heartbeat(f.alice)!.leader!;
    f.a.enqueue('job', { owner: 'o' });
    const claim = f.a.claim(leader, f.bob, 'job')!;
    for (const patch of [{ token: claim.token + 100 }, { nodeId: 'alice' },
      { session: f.alice.session }, { leaderToken: leader.token + 1 }, { jobId: 'other' }]) {
      expect(f.a.complete({ ...claim, ...patch }, 'forged')).toBe(false);
    }
    f.advance(20);
    expect(f.a.complete({ ...claim, expiresAt: 999999 }, 'late')).toBe(false);
  });

  it('invalidates a departed worker claim and allows reassignment', () => {
    const f = fixture();
    const leader = f.a.heartbeat(f.alice)!.leader!;
    f.a.enqueue('job', { owner: 'o' });
    const old = f.a.claim(leader, f.bob, 'job')!;
    f.b.leave(f.bob);
    expect(f.a.complete(old, 'stale')).toBe(false);
    const next = f.a.claim(leader, f.alice, 'job')!;
    expect(next.token).toBeGreaterThan(old.token);
  });

  it('fails closed on clock regression and token exhaustion', () => {
    const f = fixture();
    f.advance(-1);
    expect(() => f.a.heartbeat(f.alice)).toThrow('clock');
    f.advance(1);
    f.store.state.sequence = Number.MAX_SAFE_INTEGER;
    expect(() => f.a.heartbeat(f.alice)).toThrow('exhausted');
    expect(f.store.state.leader).toBeNull();
  });

  it('validates durations, IDs, results and persisted state', () => {
    for (const ttl of [0, -1, NaN, Infinity, 0.5]) {
      expect(() => new DriveNodes(new MemoryStore(), { nodeTtlMs: ttl })).toThrow('duration');
    }
    const f = fixture();
    expect(() => f.a.join('')).toThrow('ID');
    expect(() => f.a.enqueue('bad\njob')).toThrow('ID');
    const leader = f.a.heartbeat(f.alice)!.leader!;
    f.a.enqueue('job', { owner: 'o' });
    const claim = f.a.claim(leader, f.alice, 'job')!;
    expect(() => f.a.complete(claim, 'x'.repeat(65537))).toThrow('result');
    expect(parseState(f.a.snapshot())).toEqual(f.a.snapshot());
    for (const value of [null, {}, { ...emptyState(), sequence: -1 },
      { ...emptyState(), leader: {} }, { ...emptyState(), jobs: [{ id: 'j', state: 'running' }] }]) {
      expect(() => parseState(value)).toThrow('Invalid');
    }
  });

  it('persists an explicit marker for producer withdrawals', () => {
    const f = fixture();
    f.a.enqueue('withdrawn-job', { owner: 'o' });
    expect(f.a.withdraw('withdrawn-job', 'o')).toEqual({ state: 'withdrawn' });
    expect(parseState(f.store.state).jobs[0]).toMatchObject({
      state: 'completed',
      result: 'withdrawn',
      producerWithdrawn: true,
    });
  });

  it('a rejoined session frees the slot its fenced claim held, while the job stays fenced', () => {
    const f = fixture();
    const worker = f.a.join('worker', { owners: ['o'], slots: 1 })!;
    const leader = f.a.heartbeat(worker)!.leader!;
    f.a.enqueue('job1', { owner: 'o' });
    f.a.enqueue('job2', { owner: 'o' });
    const first = f.a.claim(leader, worker, 'job1')!;
    expect(first.jobId).toBe('job1');
    expect(f.a.claim(leader, worker, 'job2')).toBeNull();
    f.a.leave(worker);
    const again = f.a.join('worker', { owners: ['o'], slots: 1 })!;
    const leader2 = f.a.heartbeat(again)!.leader!;
    const second = f.a.claim(leader2, again, 'job2')!;
    expect(second.jobId).toBe('job2');
    expect(f.a.renewClaim(first)).toBeNull();
    expect(f.a.snapshot().jobs.find(j => j.id === 'job1')!.state).toBe('running');
  });

  it('pull plans past a claim fenced by a rejoined session', () => {
    const f = fixture();
    const worker = f.a.join('worker', { owners: ['o2'], slots: 1 })!;
    f.a.heartbeat(worker);
    f.a.enqueue('job1', { owner: 'o2' });
    f.a.enqueue('job2', { owner: 'o2' });
    expect(f.a.pull(worker)!.claim.jobId).toBe('job1');
    f.a.leave(worker);
    const again = f.a.join('worker', { owners: ['o2'], slots: 1 })!;
    f.a.heartbeat(again);
    expect(f.a.pull(again)!.claim.jobId).toBe('job2');
  });

  it('claim refuses jobs outside the worker owner scope, including ownerless jobs', () => {
    const f = fixture();
    const leader = f.a.heartbeat(f.alice)!.leader!;
    f.a.enqueue('foreign', { owner: 'x' });
    f.a.enqueue('open');
    expect(f.a.claim(leader, f.bob, 'foreign')).toBeNull();
    expect(f.a.claim(leader, f.bob, 'open')).toBeNull();
    expect(f.a.snapshot().jobs.every(j => j.state === 'pending')).toBe(true);
  });

  it('claim refuses missing capabilities and gh work without a live local auth', () => {
    const f = fixture();
    const leader = f.a.heartbeat(f.alice)!.leader!;
    f.a.enqueue('cap', { owner: 'o', requires: ['build'] });
    expect(f.a.claim(leader, f.bob, 'cap')).toBeNull();
    const carol = f.a.join('carol', { owners: ['o'], caps: ['build'] })!;
    f.a.heartbeat(carol);
    expect(f.a.claim(leader, carol, 'cap')!.jobId).toBe('cap');
    f.a.enqueue('gh', { owner: 'o', requires: ['gh'] });
    const dave = f.a.join('dave', { owners: ['o'], caps: ['gh'] })!;
    f.a.heartbeat(dave);
    expect(f.a.claim(leader, dave, 'gh')).toBeNull();
    f.a.heartbeat(dave, { auth: 'ok' });
    expect(f.a.claim(leader, dave, 'gh')!.jobId).toBe('gh');
  });

  it('claim does not re-assign a job its session declined', () => {
    const f = fixture();
    const leader = f.a.heartbeat(f.alice)!.leader!;
    f.a.enqueue('job', { owner: 'o' });
    const claim = f.a.claim(leader, f.bob, 'job')!;
    expect(f.a.release(claim, true)).toBe(true);
    expect(f.a.claim(leader, f.bob, 'job')).toBeNull();
    expect(f.a.claim(leader, f.alice, 'job')!.jobId).toBe('job');
  });
});

describe('release: decline versus retry (CLI + router)', () => {
  const lease = (c: { nodeId: string; session: number; jobId: string; token: number; leaderToken: number }) =>
    ['--job', c.jobId, '--node', c.nodeId, '--session', String(c.session), '--token', String(c.token), '--leader-token', String(c.leaderToken)];
  function one() {
    const f = fixture();
    const node = f.a.join('solo', { owners: ['o2'] })!;
    f.a.heartbeat(node);
    f.a.enqueue('job', { owner: 'o2', requires: [], secrets: [] });
    return { f, node, claim: f.a.pull(node)!.claim };
  }
  it('plain release over the CLI is retryable: the same node is planned the job again', () => {
    const { f, node, claim } = one();
    expect(executeNodeFleet('release', lease(claim), f.a)).toMatchObject({ released: true, declined: false });
    expect(f.a.snapshot().jobs[0].declined).toBeUndefined();
    expect(f.a.plan('o2')[0]).toMatchObject({ nodeId: node.nodeId });
  });
  it('--decline over the CLI is permanent for that session and plans the genuine all-declined fix', () => {
    const { f, claim } = one();
    expect(executeNodeFleet('release', [...lease(claim), '--decline'], f.a)).toMatchObject({ released: true, declined: true });
    const plan = f.a.plan('o2')[0]!;
    expect(plan.nodeId).toBeNull();
    expect(plan.fix).toContain('released');
    expect(plan.fix).toContain('unrun');
  });
  it('rejects --decline on other verbs and a stale release', () => {
    const { f, claim } = one();
    expect(() => executeNodeFleet('complete', [...lease(claim), '--result', 'x', '--decline'], f.a)).toThrow();
    expect(executeNodeFleet('release', lease(claim), f.a)).toMatchObject({ released: true });
    expect(() => executeNodeFleet('release', lease(claim), f.a)).toThrow();
  });
});
