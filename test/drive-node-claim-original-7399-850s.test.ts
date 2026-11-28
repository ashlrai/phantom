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

function fixture() {
  let now = 1_000;
  const store = new MemoryStore();
  const nodes = new DriveNodes(store, { now: () => now, nodeTtlMs: 100, leaderTtlMs: 20, claimTtlMs: 40 });
  const leaderNode = nodes.join('leader', { owners: ['other'] })!;
  const leader = nodes.heartbeat(leaderNode)!.leader!;
  return { nodes, leader, advance: (ms: number) => { now += ms; } };
}

function unchangedAfterRefusal(nodes: DriveNodes, attempt: () => unknown) {
  const before = nodes.snapshot();
  expect(attempt()).toBeNull();
  const after = nodes.snapshot();
  expect(after.jobs).toEqual(before.jobs);
  expect(after.sequence).toBe(before.sequence);
}

describe('original 7399 leader assignment evidence', () => {
  it('waits for the old claim to expire before assigning the job under a new leader', () => {
    const { nodes, leader, advance } = fixture();
    const first = nodes.join('first', { owners: ['team'] })!;
    const second = nodes.join('second', { owners: ['team'] })!;
    nodes.enqueue('job', { owner: 'team' });
    const old = nodes.claim(leader, first, 'job')!;

    advance(20);
    const nextLeader = nodes.heartbeat(second)!.leader!;
    expect(nextLeader.token).toBeGreaterThan(leader.token);
    expect(nodes.renewClaim(old)).toBeNull();
    expect(nodes.complete(old, 'late')).toBe(false);
    unchangedAfterRefusal(nodes, () => nodes.claim(nextLeader, second, 'job'));
    expect(nodes.pull(second)).toBeNull();

    advance(19);
    const renewedLeader = nodes.heartbeat(second)!.leader!;
    unchangedAfterRefusal(nodes, () => nodes.claim(renewedLeader, second, 'job'));
    advance(1);
    const replacement = nodes.claim(renewedLeader, second, 'job')!;
    expect(replacement.token).toBeGreaterThan(old.token);
    expect(nodes.complete(replacement, 'done')).toBe(true);
  });

  it('fences a declining session without changing the job and allows another session', () => {
    const { nodes, leader } = fixture();
    const first = nodes.join('first', { owners: ['team'] })!;
    const second = nodes.join('second', { owners: ['team'] })!;
    nodes.heartbeat(first); nodes.heartbeat(second);
    nodes.enqueue('job', { owner: 'team' });
    const claim = nodes.claim(leader, first, 'job')!;
    expect(nodes.release(claim, true)).toBe(true);
    expect(nodes.snapshot().jobs[0]).toMatchObject({ state: 'pending', declined: [first.session] });
    unchangedAfterRefusal(nodes, () => nodes.claim(leader, first, 'job'));
    expect(nodes.claim(leader, second, 'job')).toMatchObject({ nodeId: 'second', jobId: 'job' });
  });

  it('refuses missing capabilities until a capable session joins', () => {
    const { nodes, leader } = fixture();
    const worker = nodes.join('worker', { owners: ['team'] })!;
    nodes.heartbeat(worker);
    nodes.enqueue('job', { owner: 'team', requires: ['codex'] });
    unchangedAfterRefusal(nodes, () => nodes.claim(leader, worker, 'job'));
    const capable = nodes.join('capable', { owners: ['team'], caps: ['codex'] })!;
    nodes.heartbeat(capable);
    expect(nodes.claim(leader, capable, 'job')).toMatchObject({ nodeId: 'capable', jobId: 'job' });
  });

  it('requires an ok auth heartbeat for gh work', () => {
    const { nodes, leader } = fixture();
    const worker = nodes.join('worker', { owners: ['team'], caps: ['gh'] })!;
    nodes.heartbeat(worker);
    nodes.enqueue('job', { owner: 'team', requires: ['gh'] });
    unchangedAfterRefusal(nodes, () => nodes.claim(leader, worker, 'job'));
    nodes.heartbeat(worker, { auth: 'ok' });
    expect(nodes.claim(leader, worker, 'job')).toMatchObject({ nodeId: 'worker', jobId: 'job' });
  });

  it('keeps owner scope in routing while a live leader can directly assign foreign and ownerless jobs', () => {
    const { nodes, leader, advance } = fixture();
    const worker = nodes.join('worker', { owners: ['other'] })!;
    nodes.heartbeat(worker);
    nodes.enqueue('foreign', { owner: 'team' });
    nodes.enqueue('ownerless');
    expect(nodes.plan('team')).toMatchObject([{ jobId: 'foreign', nodeId: null }]);
    expect(nodes.plan().some(route => route.jobId === 'ownerless')).toBe(false);
    expect(nodes.pull(worker)).toBeNull();
    advance(20);
    const newLeader = nodes.heartbeat(worker)!.leader!;
    unchangedAfterRefusal(nodes, () => nodes.claim(leader, worker, 'foreign'));
    expect(nodes.claim(newLeader, worker, 'foreign')).toMatchObject({ nodeId: 'worker', jobId: 'foreign' });
    expect(nodes.claim(newLeader, worker, 'ownerless')).toMatchObject({ nodeId: 'worker', jobId: 'ownerless' });
  });
});
