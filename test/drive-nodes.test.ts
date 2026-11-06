import { describe, expect, it } from 'vitest';
import { DriveNodes, type NodesState, type NodesStore } from '../src/core/drive/nodes/index.js';
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
  const alice = a.join('alice')!;
  const bob = b.join('bob')!;
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
    f.a.enqueue('job');
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
    f.a.enqueue('job');
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

  it('split brain: only the higher fencing token can complete the same job', () => {
    const f = fixture();
    const oldLeader = f.a.heartbeat(f.alice)!.leader!;
    f.a.enqueue('job');
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
    f.a.enqueue('job');
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
    f.a.enqueue('job');
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
    f.a.enqueue('job');
    const claim = f.a.claim(leader, f.alice, 'job')!;
    expect(() => f.a.complete(claim, 'x'.repeat(65537))).toThrow('result');
    expect(parseState(f.a.snapshot())).toEqual(f.a.snapshot());
    for (const value of [null, {}, { ...emptyState(), sequence: -1 },
      { ...emptyState(), leader: {} }, { ...emptyState(), jobs: [{ id: 'j', state: 'running' }] }]) {
      expect(() => parseState(value)).toThrow('Invalid');
    }
  });
});
