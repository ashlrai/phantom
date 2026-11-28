import { describe, expect, it } from 'vitest';
import { DriveNodes, type NodesState, type NodesStore } from '../src/core/drive/nodes/index.js';
import { emptyState } from '../src/core/drive/nodes/state.js';

class MemoryStore implements NodesStore {
  state = emptyState();
  transaction<T>(fn: (state: NodesState) => T): T {
    const draft = structuredClone(this.state);
    const result = fn(draft);
    this.state = draft;
    return structuredClone(result);
  }
}

/** Production-shaped ratios at test scale: the leader lease (20) is the
 * shortest, then the claim lease (40), then the node session (100) — the same
 * ordering as the 10 s / 30 s / 30 s production TTLs that made a 10-second
 * watch cadence rotate leadership every pass. */
function fixture() {
  let now = 1_000;
  const store = new MemoryStore();
  const options = { now: () => now, nodeTtlMs: 100, leaderTtlMs: 20, claimTtlMs: 40 };
  const nodes = new DriveNodes(store, options);
  const alice = nodes.join('alice', { owners: ['oa'] })!;
  const bob = nodes.join('bob', { owners: ['ob'] })!;
  return { nodes, store, alice, bob, advance: (ms: number) => { now += ms; } };
}

describe('claim liveness across lease boundaries', () => {
  it('renew alone keeps a pulled job, its session and its leader lease alive', () => {
    const f = fixture();
    f.nodes.heartbeat(f.alice);
    f.nodes.enqueue('job', { owner: 'oa' });
    const pulled = f.nodes.pull(f.alice)!;
    const leaderToken = f.store.state.leader!.token;
    // Past the leader lease (20) but inside the claim (40) and session (100)
    // leases: the claim is still valid, so renewal must succeed and carry the
    // session and leader lease forward — `renew --watch` with no beat watch.
    f.advance(25);
    const first = f.nodes.renewClaim(pulled.claim)!;
    expect(first.expiresAt).toBe(1_065);
    const mid = f.store.state;
    expect(mid.nodes.find(n => n.nodeId === 'alice')!.expiresAt).toBe(1_125);
    expect(mid.nodes.find(n => n.nodeId === 'alice')!.heartbeatAt).toBe(1_000); // last real beat, not a renewal
    expect(mid.leader!.token).toBe(leaderToken);
    expect(mid.leader!.expiresAt).toBe(1_045);
    // A second renewal past every lease boundary again: the watch is
    // self-sustaining — each pass re-arms all three leases it depends on.
    f.advance(25);
    const second = f.nodes.renewClaim(pulled.claim)!;
    expect(second.expiresAt).toBe(1_090);
    expect(f.store.state.leader!.token).toBe(leaderToken);
    expect(f.store.state.leader!.expiresAt).toBe(1_070);
    expect(f.nodes.complete(pulled.claim, 'done')).toBe(true);
  });

  it('a lapsed leader lease revived by its own session keeps the fencing token', () => {
    const f = fixture();
    const leader = f.nodes.heartbeat(f.alice)!.leader!;
    f.advance(25); // leader lease (20) lapsed; both sessions still live (100)
    const revived = f.nodes.heartbeat(f.alice)!.leader!;
    expect(revived.token).toBe(leader.token);
    expect(revived.nodeId).toBe('alice');
    expect(revived.expiresAt).toBe(1_045);
  });

  it('a different session acting after the lapse still takes a fresh token', () => {
    const f = fixture();
    f.nodes.heartbeat(f.alice);
    f.nodes.enqueue('job', { owner: 'oa' });
    const pulled = f.nodes.pull(f.alice)!;
    f.nodes.heartbeat(f.bob);
    f.advance(25); // alice's leader lease lapses; bob's session stays live
    const next = f.nodes.heartbeat(f.bob)!.leader!;
    expect(next.nodeId).toBe('bob');
    expect(next.token).toBeGreaterThan(pulled.claim.leaderToken);
    expect(f.nodes.renewClaim(pulled.claim)).toBeNull();
    expect(f.nodes.complete(pulled.claim, 'stale')).toBe(false);
  });

  it('a claim dies with its session even while renewals were flowing', () => {
    const f = fixture();
    f.nodes.heartbeat(f.alice);
    f.nodes.enqueue('job', { owner: 'oa' });
    const pulled = f.nodes.pull(f.alice)!;
    f.advance(25);
    expect(f.nodes.renewClaim(pulled.claim)).not.toBeNull();
    f.advance(105); // the renewal re-armed the session to 1125; now 1130 it is dead
    expect(f.nodes.renewClaim(pulled.claim)).toBeNull();
    expect(f.nodes.heartbeat(f.alice)).toBeNull();
  });

  it("a worker's renewal carries its own session, not the leader's lease", () => {
    const f = fixture();
    const leader = f.nodes.heartbeat(f.alice)!.leader!;
    f.nodes.enqueue('job', { owner: 'ob' });
    const claim = f.nodes.claim(leader, f.bob, 'job')!;
    const leaderExpiry = f.store.state.leader!.expiresAt;
    f.advance(15); // inside every lease
    expect(f.nodes.renewClaim(claim)).not.toBeNull();
    const mid = f.store.state;
    expect(mid.nodes.find(n => n.nodeId === 'bob')!.expiresAt).toBe(1_115);
    expect(mid.leader!.expiresAt).toBe(leaderExpiry); // bob is not the leader
  });
});
