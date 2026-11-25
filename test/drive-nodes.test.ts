import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DriveNodes, type NodesState, type NodesStore } from '../src/core/drive/nodes/index.js';
import { executeNodeFleet } from '../src/core/drive/nodes/commands.js';
import { emptyState, parseState } from '../src/core/drive/nodes/state.js';
import { versionFromCaps } from '../src/core/drive/nodes/phm-version.js';
import { cmdNodeFleet } from '../src/cli/node-fleet.js';

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

  it('a declining release fences that session out of claim; another session still can', () => {
    const f = fixture();
    const leader = f.a.heartbeat(f.alice)!.leader!;
    f.a.enqueue('job', { owner: 'o' });
    const c1 = f.a.claim(leader, f.bob, 'job')!;
    expect(f.a.release(c1, true)).toBe(true);
    expect(f.a.snapshot().jobs[0]).toMatchObject({ state: 'pending', declined: [f.bob.session] });
    // claim applies the same fence pull does: the declined session is never re-offered the job.
    expect(f.a.claim(leader, f.bob, 'job')).toBeNull();
    // A different session still can; its own decline appends, keyed by session.
    const c2 = f.a.claim(leader, f.alice, 'job')!;
    expect(f.a.release(c2, true)).toBe(true);
    expect(f.a.snapshot().jobs[0].declined).toEqual([f.bob.session, f.alice.session]);
  });

  it('claim applies the routing capability fences: caps and gh auth', () => {
    const f = fixture();
    const leader = f.a.heartbeat(f.alice)!.leader!;
    f.a.enqueue('needs-codex', { owner: 'o', requires: ['codex'] });
    f.a.enqueue('needs-gh', { owner: 'o', requires: ['gh'] });
    // alice and bob advertise no caps and report no auth.
    expect(f.a.claim(leader, f.bob, 'needs-codex')).toBeNull();
    expect(f.a.claim(leader, f.bob, 'needs-gh')).toBeNull();
    const worker = f.b.join('worker', { owners: ['o'], caps: ['codex', 'gh'] })!;
    f.b.heartbeat(worker, { auth: 'ok' });
    expect(f.a.claim(leader, worker, 'needs-codex')!.jobId).toBe('needs-codex');
    // gh work also needs the auth heartbeat; the cap alone is not enough.
    const noauth = f.a.join('noauth', { owners: ['o'], caps: ['gh'] })!;
    f.a.heartbeat(noauth);
    expect(f.a.claim(leader, noauth, 'needs-gh')).toBeNull();
    f.a.heartbeat(noauth, { auth: 'ok' });
    expect(f.a.claim(leader, noauth, 'needs-gh')!.jobId).toBe('needs-gh');
  });

  it('does not re-route a released job to the session that declined it', () => {
    const f = fixture();
    const alice = f.a.join('alice2', { owners: ['o'] })!, bob = f.b.join('bob2', { owners: ['o'] })!;
    f.a.heartbeat(alice); f.b.heartbeat(bob);
    f.a.enqueue('job', { owner: 'o', requires: [], secrets: [] });
    const claim = (f.b.pull(bob) ?? f.a.pull(alice))!.claim;
    const [holder, other, otherNode] = claim.nodeId === 'bob2' ? [f.b, f.a, alice] : [f.a, f.b, bob];
    const self = claim.nodeId === 'bob2' ? bob : alice;
    expect(holder.release(claim, true)).toBe(true);
    expect(holder.pull(self)).toBeNull();
    expect(other.plan('o')[0]!.nodeId).toBe(otherNode.nodeId);
    expect(other.pull(otherNode)!.claim.jobId).toBe('job');
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
    const worker = f.a.join('worker', { owners: ['o'], slots: 1 })!;
    f.a.heartbeat(worker);
    f.a.enqueue('job1', { owner: 'o' });
    f.a.enqueue('job2', { owner: 'o' });
    expect(f.a.pull(worker)!.claim.jobId).toBe('job1');
    f.a.leave(worker);
    const again = f.a.join('worker', { owners: ['o'], slots: 1 })!;
    f.a.heartbeat(again);
    expect(f.a.pull(again)!.claim.jobId).toBe('job2');
  });
});

describe('release: decline versus retry (CLI + router)', () => {
  const lease = (c: { nodeId: string; session: number; jobId: string; token: number; leaderToken: number }) =>
    ['--job', c.jobId, '--node', c.nodeId, '--session', String(c.session), '--token', String(c.token), '--leader-token', String(c.leaderToken)];
  function one() {
    const f = fixture();
    const node = f.a.join('solo', { owners: ['o'] })!;
    f.a.heartbeat(node);
    f.a.enqueue('job', { owner: 'o', requires: [], secrets: [] });
    return { f, node, claim: f.a.pull(node)!.claim };
  }
  it('plain release over the CLI is retryable: the same node is planned the job again', () => {
    const { f, node, claim } = one();
    expect(executeNodeFleet('release', lease(claim), f.a)).toMatchObject({ released: true, declined: false });
    expect(f.a.snapshot().jobs[0].declined).toBeUndefined();
    expect(f.a.plan('o')[0]).toMatchObject({ nodeId: node.nodeId });
  });
  it('--decline over the CLI is permanent for that session and plans the genuine all-declined fix', () => {
    const { f, claim } = one();
    expect(executeNodeFleet('release', [...lease(claim), '--decline'], f.a)).toMatchObject({ released: true, declined: true });
    const plan = f.a.plan('o')[0]!;
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

describe('pull session honesty', () => {
  const pullArgs = (nodeId: string, session: number) => ['--node', nodeId, '--session', String(session)];
  it('answers no-job only to a live session; a dead one gets session-expired', () => {
    const f = fixture();
    const worker = f.a.join('worker', { owners: ['o'], slots: 1 })!;
    // Live session, empty route: the honest "nothing for you" answer.
    expect(executeNodeFleet('pull', pullArgs('worker', worker.session), f.a)).toEqual({ pulled: false });
    // Past the node TTL the same pull must not read as "no job": the session
    // is gone and the node has to rejoin before it can hear about work.
    f.advance(100);
    expect(() => executeNodeFleet('pull', pullArgs('worker', worker.session), f.a)).toThrowError(
      expect.objectContaining({ code: 'session-expired', exit: 1 }));
    // A rejoined node gets a new session; the replaced one stays refused.
    const again = f.a.join('worker', { owners: ['o'], slots: 1 })!;
    expect(again.session).not.toBe(worker.session);
    expect(() => executeNodeFleet('pull', pullArgs('worker', worker.session), f.a)).toThrowError(
      expect.objectContaining({ code: 'session-expired' }));
    expect(executeNodeFleet('pull', pullArgs('worker', again.session), f.a)).toEqual({ pulled: false });
  });
});

describe('session-expired rejoin hint', () => {
  const args = (nodeId: string, session: number) => ['--node', nodeId, '--session', String(session)];
  function failure(fn: () => unknown): { code?: string; message?: string; fix?: string } {
    try { fn(); } catch (e) { return e as { code?: string; message?: string; fix?: string }; }
    throw new Error('expected the verb to refuse');
  }
  it('prints the last advertised join command for an expired session', () => {
    const f = fixture();
    const worker = f.a.join('laptop', { owners: ['acme', 'ops'], caps: ['build', 'gh'], slots: 2 })!;
    f.advance(100);
    const err = failure(() => executeNodeFleet('pull', args('laptop', worker.session), f.a));
    expect(err.code).toBe('session-expired');
    expect(err.message).toContain('laptop');
    expect(err.fix).toBe('Rejoin with: phm node join --node laptop --owner acme,ops --caps build,gh --slots 2; then use the new session.');
  });
  it('keeps the node id but placeholders for owner and caps once the record is gone', () => {
    const f = fixture();
    const worker = f.a.join('laptop', { owners: ['acme'], caps: ['build'] })!;
    expect(f.a.leave(worker)).toBe(true);
    const err = failure(() => executeNodeFleet('pull', args('laptop', worker.session), f.a));
    expect(err.fix).toBe('Rejoin with: phm node join --node laptop --owner <scope>; then use the new session.');
  });
  it('never inlines an id-invalid node id into the suggested command', () => {
    const f = fixture();
    const err = failure(() => executeNodeFleet('pull', args('bad;id', 1), f.a));
    expect(err.fix).toBe('Rejoin with: phm node join --node <id> --owner <scope>; then use the new session.');
    expect(err.fix).not.toContain('bad;id');
  });
  it('beat reports the same rejoin hint', () => {
    const f = fixture();
    const worker = f.a.join('laptop', { owners: ['acme'], caps: ['build'] })!;
    f.advance(100);
    const err = failure(() => executeNodeFleet('beat', args('laptop', worker.session), f.a));
    expect(err.code).toBe('session-expired');
    expect(err.fix).toContain('phm node join --node laptop --owner acme --caps build');
  });
});

describe('live-session recovery hints', () => {
  const args = (nodeId: string, session: number) => ['--node', nodeId, '--session', String(session)];
  const joinArgs = (nodeId: string) => ['--node', nodeId, '--owner', 'acme'];
  const sessionOf = (out: Record<string, unknown>): number => out['session'] as number;
  function failure(fn: () => unknown): { code?: string; message?: string; fix?: string } {
    try { fn(); } catch (e) { return e as { code?: string; message?: string; fix?: string }; }
    throw new Error('expected the verb to refuse');
  }
  it('join refusal names the live session and the exact leave command', () => {
    const f = fixture();
    const worker = executeNodeFleet('join', joinArgs('laptop'), f.a);
    const session = sessionOf(worker);
    const err = failure(() => executeNodeFleet('join', joinArgs('laptop'), f.a));
    expect(err.code).toBe('node-live');
    expect(err.fix).toContain(`session ${session}`);
    expect(err.fix).toContain(`phm node leave --node laptop --session ${session}`);
  });
  it('beat and pull under a replaced session name the live one', () => {
    const f = fixture();
    const first = executeNodeFleet('join', joinArgs('laptop'), f.a);
    f.advance(100);
    const second = executeNodeFleet('join', joinArgs('laptop'), f.a);
    const live = sessionOf(second);
    expect(live).not.toBe(sessionOf(first));
    for (const verb of ['beat', 'pull']) {
      const err = failure(() => executeNodeFleet(verb, args('laptop', sessionOf(first)), f.a));
      expect(err.code).toBe('session-expired');
      expect(err.fix).toContain(`live as session ${live}`);
      expect(err.fix).toContain(`phm node leave --node laptop --session ${live}`);
    }
  });
  it('a node with no live record still gets the rejoin hint', () => {
    const f = fixture();
    executeNodeFleet('join', joinArgs('laptop'), f.a);
    f.advance(200);
    const err = failure(() => executeNodeFleet('beat', args('laptop', 999), f.a));
    expect(err.code).toBe('session-expired');
    expect(err.fix).toContain('Rejoin with: phm node join --node laptop --owner acme');
    expect(err.fix).not.toContain('live as session');
  });
  it('leave under a replaced session reports the live session instead of a bare false', () => {
    const f = fixture();
    const first = executeNodeFleet('join', joinArgs('laptop'), f.a);
    f.advance(100);
    const second = executeNodeFleet('join', joinArgs('laptop'), f.a);
    const live = sessionOf(second);
    const out = executeNodeFleet('leave', args('laptop', sessionOf(first)), f.a);
    expect(out).toMatchObject({ nodeId: 'laptop', left: false, liveSession: live,
      next: `phm node leave --node laptop --session ${live}` });
    expect(executeNodeFleet('leave', args('laptop', live), f.a)).toMatchObject({ left: true });
  });
  it('leave of an unknown node stays a bare false', () => {
    const f = fixture();
    expect(executeNodeFleet('leave', args('ghost', 1), f.a)).toEqual({ nodeId: 'ghost', left: false });
  });
});

describe('standalone join version reporting', () => {
  it('advertises the running build as a phm-<version> cap so self-update reads it', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      const store = new MemoryStore();
      const code = await cmdNodeFleet('join', ['--node', 'laptop', '--owner', 'acme', '--caps', 'build', '--json'],
        { store, phmVersion: () => '9.9.9' });
      expect(code).toBe(0);
      const node = store.state.nodes.find(n => n.nodeId === 'laptop')!;
      expect(node.caps).toEqual(['build', 'phm-9.9.9']);
      // The scoped view self-update reads reports the advertised build, not 'unreported'.
      expect(versionFromCaps(new DriveNodes(store).view(['acme']).nodes[0]!.caps)).toBe('9.9.9');
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({ command: 'join',
        caps: expect.arrayContaining(['build', 'phm-9.9.9']) });
    } finally { vi.restoreAllMocks(); }
  });
  it('replaces a stale version cap copied into --caps with the build actually joining', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      const store = new MemoryStore();
      const code = await cmdNodeFleet('join', ['--node', 'laptop', '--owner', 'acme', '--caps', 'build,phm-0.0.1-stale'],
        { store, phmVersion: () => '9.9.9' });
      expect(code).toBe(0);
      const node = store.state.nodes.find(n => n.nodeId === 'laptop')!;
      expect(node.caps).toEqual(['build', 'phm-9.9.9']);
      expect(versionFromCaps(node.caps)).toBe('9.9.9');
    } finally { vi.restoreAllMocks(); }
  });
  it('leaves --caps untouched when this build version cannot be determined', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      const store = new MemoryStore();
      const code = await cmdNodeFleet('join', ['--node', 'laptop', '--owner', 'acme', '--caps', 'build,phm-custom'],
        { store, phmVersion: () => null });
      expect(code).toBe(0);
      expect(store.state.nodes.find(n => n.nodeId === 'laptop')!.caps).toEqual(['build', 'phm-custom']);
    } finally { vi.restoreAllMocks(); }
  });
  it('the SSH endpoint join does not stamp this host version onto a worker', () => {
    const f = fixture();
    const joined = executeNodeFleet('join', ['--node', 'worker', '--owner', 'o', '--caps', 'build'], f.a);
    expect(joined['caps']).toEqual(['build']);
  });
});

describe('standalone join node id default', () => {
  it('defaults --node to the sanitized hostname so the shortest join works', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      const store = new MemoryStore();
      const code = await cmdNodeFleet('join', ['--owner', 'acme', '--caps', 'build', '--json'],
        { store, hostname: () => 'My MacBook Pro' });
      expect(code).toBe(0);
      const out = JSON.parse(lines.at(-1)!);
      expect(out).toMatchObject({ command: 'join', nodeId: 'My-MacBook-Pro', owners: ['acme'] });
      expect(store.state.nodes.map(n => n.nodeId)).toEqual(['My-MacBook-Pro']);
      // The keep-alive hint names the same default-derived id.
      expect(out['next']).toBe(`phm node beat --node My-MacBook-Pro --session ${out['session']} --watch`);
    } finally { vi.restoreAllMocks(); }
  });
  it('an explicit --node still wins over the hostname default', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      const store = new MemoryStore();
      const code = await cmdNodeFleet('join', ['--node', 'laptop', '--owner', 'acme', '--json'],
        { store, hostname: () => 'My-MacBook-Pro' });
      expect(code).toBe(0);
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({ nodeId: 'laptop' });
      expect(store.state.nodes.map(n => n.nodeId)).toEqual(['laptop']);
    } finally { vi.restoreAllMocks(); }
  });
  it('a hostname that cannot form a valid id keeps the missing-flag refusal', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      const store = new MemoryStore();
      // '_hidden' sanitizes to itself but fails validId's leading-alphanumeric rule.
      const code = await cmdNodeFleet('join', ['--owner', 'acme', '--json'],
        { store, hostname: () => '_hidden' });
      expect(code).toBe(2);
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({ command: 'join',
        error: { code: 'missing-flag', message: expect.stringContaining('--node') } });
      expect(store.state.nodes).toEqual([]);
    } finally { vi.restoreAllMocks(); }
  });
  it('the SSH endpoint join still requires the worker to name its own node id', () => {
    const f = fixture();
    expect(() => executeNodeFleet('join', ['--owner', 'o'], f.a)).toThrowError(
      expect.objectContaining({ code: 'missing-flag' }));
  });
});

describe('result: read-only owner-scoped outcome', () => {
  const resultArgs = (jobId: string, owner: string) => ['--job', jobId, '--owner', owner];
  const leaseArgs = (claim: { nodeId: string; session: number; jobId: string; token: number; leaderToken: number }, result?: string) =>
    ['--job', claim.jobId, '--node', claim.nodeId, '--session', String(claim.session),
      '--token', String(claim.token), '--leader-token', String(claim.leaderToken),
      ...(result === undefined ? [] : ['--result', result])];
  function fixtureWithJob() {
    const f = fixture();
    const worker = f.a.join('worker', { owners: ['o'] })!;
    f.a.heartbeat(worker);
    f.a.enqueue('job', { owner: 'o' });
    return { f, worker, claim: f.a.pull(worker)!.claim };
  }
  it('returns a completed job\'s result, executor and completion time without mutating', () => {
    const { f, claim } = fixtureWithJob();
    expect(executeNodeFleet('complete', leaseArgs(claim, 'the answer'), f.a)).toMatchObject({ completed: true });
    const before = f.a.snapshot();
    const out = executeNodeFleet('result', resultArgs('job', 'o'), f.a);
    expect(out).toMatchObject({ jobId: 'job', state: 'completed', result: 'the answer', completedBy: 'worker' });
    expect(out['completedAt']).toBe(before.jobs[0]!.completedAt);
    expect(f.a.snapshot()).toEqual(before);
  });
  it('reports pending and running states, claimedBy for a live claim, and absent honestly', () => {
    const f = fixture();
    const worker = f.a.join('worker', { owners: ['o'] })!;
    f.a.heartbeat(worker);
    f.a.enqueue('waiting', { owner: 'o' });
    f.a.enqueue('foreign', { owner: 'other' });
    expect(executeNodeFleet('result', resultArgs('waiting', 'o'), f.a)).toEqual({ jobId: 'waiting', state: 'pending' });
    expect(executeNodeFleet('result', resultArgs('ghost', 'o'), f.a)).toEqual({ jobId: 'ghost', state: 'absent' });
    // Another owner's job is absent inside this scope and pending inside its own.
    expect(executeNodeFleet('result', resultArgs('foreign', 'o'), f.a)).toEqual({ jobId: 'foreign', state: 'absent' });
    expect(executeNodeFleet('result', resultArgs('foreign', 'other'), f.a)).toEqual({ jobId: 'foreign', state: 'pending' });
    // Pull the one routable job: running names the node whose live claim can act.
    const claim = f.a.pull(worker)!.claim;
    expect(claim.jobId).toBe('waiting');
    expect(executeNodeFleet('result', resultArgs('waiting', 'o'), f.a))
      .toEqual({ jobId: 'waiting', state: 'running', claimedBy: 'worker' });
    // A lapsed claim is fenced: still running, but no live claimant is named.
    f.advance(100);
    expect(executeNodeFleet('result', resultArgs('waiting', 'o'), f.a))
      .toEqual({ jobId: 'waiting', state: 'running' });
  });
  it('marks a producer withdrawal instead of passing it off as node work', () => {
    const f = fixture();
    f.a.enqueue('doomed', { owner: 'o' });
    expect(f.a.withdraw('doomed', 'o')).toEqual({ state: 'withdrawn' });
    expect(executeNodeFleet('result', resultArgs('doomed', 'o'), f.a))
      .toMatchObject({ jobId: 'doomed', state: 'completed', result: 'withdrawn', producerWithdrawn: true });
  });
  it('requires both --job and --owner and refuses nothing else', () => {
    const f = fixture();
    expect(() => executeNodeFleet('result', ['--job', 'j'], f.a)).toThrowError(
      expect.objectContaining({ code: 'missing-flag' }));
    expect(() => executeNodeFleet('result', ['--owner', 'o'], f.a)).toThrowError(
      expect.objectContaining({ code: 'missing-flag' }));
    expect(() => executeNodeFleet('result', ['--job', 'j', '--owner', 'o', '--node', 'x'], f.a)).toThrowError(
      expect.objectContaining({ code: 'unknown-flag' }));
  });
  it('keeps the --json envelope through cmdNodeFleet', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      const store = new MemoryStore();
      const nodes = new DriveNodes(store);
      const joined = executeNodeFleet('join', ['--node', 'worker', '--owner', 'o'], nodes);
      executeNodeFleet('enqueue', ['--job', 'job', '--owner', 'o'], nodes);
      const pulled = executeNodeFleet('pull', ['--node', 'worker', '--session', String(joined['session'])], nodes);
      const claim = pulled['claim'] as { jobId: string; nodeId: string; session: number; token: number; leaderToken: number };
      executeNodeFleet('complete', ['--job', claim.jobId, '--node', claim.nodeId, '--session', String(claim.session),
        '--token', String(claim.token), '--leader-token', String(claim.leaderToken), '--result', 'done'], nodes);
      const code = await cmdNodeFleet('result', ['--job', 'job', '--owner', 'o', '--json'], { store });
      expect(code).toBe(0);
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({ schemaVersion: 1, command: 'result',
        jobId: 'job', state: 'completed', result: 'done', completedBy: 'worker' });
    } finally { vi.restoreAllMocks(); }
  });
  it('prints the lease, task and ready commands on a text pull', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      const store = new MemoryStore();
      const nodes = new DriveNodes(store);
      const joined = executeNodeFleet('join', ['--node', 'worker', '--owner', 'o', '--caps', 'build'], nodes);
      const session = String(joined['session']);
      const taskText = 'Summarize the README in one line.';
      const digest = createHash('sha256').update(taskText).digest('hex');
      executeNodeFleet('enqueue', ['--job', 'task-job', '--owner', 'o', '--pack', 'codex-file',
        '--requires', 'build', '--secrets', 'DEPLOY_KEY',
        '--task-part', taskText, '--task-sha256', `sha256:${digest}`], nodes);
      expect(await cmdNodeFleet('pull', ['--node', 'worker', '--session', session], { store })).toBe(0);
      const out = lines.at(-1)!;
      const claim = store.state.jobs[0]!.claim!;
      expect(out).toContain('Claimed task-job (owner o; requires build; pack codex-file; secrets DEPLOY_KEY).');
      expect(out).toContain(`Lease token ${claim.token}, leader-token ${claim.leaderToken};`);
      expect(out).toContain('Task:');
      expect(out).toContain(taskText);
      const lease = `--job task-job --node worker --session ${session} --token ${claim.token} --leader-token ${claim.leaderToken}`;
      expect(out).toContain(`Run: phm node renew ${lease}`);
      expect(out).toContain(`Done? Run: phm node complete ${lease} --result <text>`);
      // A second pull finds the job already running and keeps the short no-job text.
      lines.length = 0;
      expect(await cmdNodeFleet('pull', ['--node', 'worker', '--session', session], { store })).toBe(0);
      expect(lines.at(-1)).toBe('No job for this node. Run: phm node plan');
    } finally { vi.restoreAllMocks(); }
  });
});

describe('text output names outcomes in plain words', () => {
  function harness() {
    const store = new MemoryStore();
    let now = 1_000_000;
    const deps = { store, now: () => now };
    const nodes = () => new DriveNodes(store, { now: () => now });
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
    return { deps, nodes, lines, advance: (ms: number) => { now += ms; } };
  }
  const last = (lines: string[]) => lines.at(-1)!;
  it('status, enqueue, withdraw, renew, complete and leave say what happened', async () => {
    const { deps, nodes, lines, advance } = harness();
    try {
      // An empty scope says so and prints the join command — the first-run case.
      expect(await cmdNodeFleet('status', ['--owner', 'acme'], deps)).toBe(0);
      expect(last(lines)).toBe([
        'Owner scope: acme',
        'No nodes joined in this scope.',
        'No jobs queued in this scope.',
        'Join this computer: phm node join --owner acme',
      ].join('\n'));
      const session = String(executeNodeFleet('join', ['--node', 'box', '--owner', 'acme'], nodes())['session']);
      // enqueue names the id; a duplicate id is a fact, not a failure.
      expect(await cmdNodeFleet('enqueue', ['--job', 'j1', '--owner', 'acme'], deps)).toBe(0);
      expect(last(lines)).toBe('Enqueued j1.');
      expect(await cmdNodeFleet('enqueue', ['--job', 'j1', '--owner', 'acme'], deps)).toBe(0);
      expect(last(lines)).toBe('Job j1 already exists; nothing changed.');
      expect(await cmdNodeFleet('status', ['--owner', 'acme'], deps)).toBe(0);
      expect(last(lines)).toContain('job j1 pending');
      // Once pulled, status names the node holding the claim.
      const claim = (executeNodeFleet('pull', ['--node', 'box', '--session', session], nodes())['claim'] as
        { jobId: string; token: number; leaderToken: number });
      const lease = ['--job', 'j1', '--node', 'box', '--session', session,
        '--token', String(claim.token), '--leader-token', String(claim.leaderToken)];
      expect(await cmdNodeFleet('status', ['--owner', 'acme'], deps)).toBe(0);
      expect(last(lines)).toContain('job j1 running (claimed by box)');
      // withdraw on a live claim says to retry after it lapses.
      expect(await cmdNodeFleet('withdraw', ['--job', 'j1', '--owner', 'acme'], deps)).toBe(0);
      expect(last(lines)).toBe('Job j1 is held by a live claim; withdraw again once the claim lapses or completes.');
      // renew prints the expiry as a time; complete a sentence.
      expect(await cmdNodeFleet('renew', lease, deps)).toBe(0);
      expect(last(lines)).toMatch(/^Renewed j1; the lease expires \d{4}-\d{2}-\d{2}T/);
      expect(await cmdNodeFleet('complete', [...lease, '--result', 'done'], deps)).toBe(0);
      expect(last(lines)).toBe('Completed j1.');
      expect(await cmdNodeFleet('status', ['--owner', 'acme'], deps)).toBe(0);
      expect(last(lines)).toContain('job j1 completed by box');
      expect(await cmdNodeFleet('withdraw', ['--job', 'j1', '--owner', 'acme'], deps)).toBe(0);
      expect(last(lines)).toBe('Job j1 already completed.');
      expect(await cmdNodeFleet('withdraw', ['--job', 'j2', '--owner', 'acme'], deps)).toBe(0);
      expect(last(lines)).toBe("Job j2 is absent in this owner scope (unknown id or another owner's job).");
      // A producer withdrawal reads back marked, never as node work.
      executeNodeFleet('enqueue', ['--job', 'j3', '--owner', 'acme'], nodes());
      expect(await cmdNodeFleet('withdraw', ['--job', 'j3', '--owner', 'acme'], deps)).toBe(0);
      expect(last(lines)).toBe('Job j3 withdrawn: it is terminal and can never run again.');
      expect(await cmdNodeFleet('status', ['--owner', 'acme'], deps)).toBe(0);
      expect(last(lines)).toContain('job j3 completed (withdrawn by the producer)');
      // A lapsed claim drops the claimant from the status line.
      executeNodeFleet('enqueue', ['--job', 'j4', '--owner', 'acme'], nodes());
      executeNodeFleet('pull', ['--node', 'box', '--session', session], nodes());
      advance(31_000);
      expect(await cmdNodeFleet('status', ['--owner', 'acme'], deps)).toBe(0);
      expect(last(lines)).toContain('job j4 running (no live claim)');
      // leave names the live session on a refusal, then succeeds.
      const live = String(executeNodeFleet('join', ['--node', 'box', '--owner', 'acme'], nodes())['session']);
      expect(await cmdNodeFleet('leave', ['--node', 'box', '--session', session], deps)).toBe(0);
      expect(last(lines)).toBe(`Node box was not left; it is live as session ${live}. Run: phm node leave --node box --session ${live}`);
      expect(await cmdNodeFleet('leave', ['--node', 'box', '--session', live], deps)).toBe(0);
      expect(last(lines)).toBe('Node box left the registry.');
    } finally { vi.restoreAllMocks(); }
  });
});

describe('beat --capacity sample honesty', () => {
  const beatArgs = (session: number, capacity?: string) =>
    ['--node', 'laptop', '--session', String(session), ...(capacity === undefined ? [] : ['--capacity', capacity])];
  const sample = { hostId: 'laptop.local', ramBytes: 17_179_869_184, slots: 4, held: null, sampledAtMs: 1_000 };
  function failure(fn: () => unknown): { code?: string; message?: string; fix?: string; exit?: number } {
    try { fn(); } catch (e) { return e as { code?: string; message?: string; fix?: string; exit?: number }; }
    throw new Error('expected the verb to refuse');
  }
  it('refuses a malformed or wrong-shaped --capacity as usage, never a store failure', () => {
    const f = fixture();
    const worker = f.a.join('laptop', { owners: ['acme'] })!;
    for (const bad of ['not json', '', 'null', '[]', '{"hostId":"x"}', JSON.stringify({ ...sample, extra: 1 })]) {
      const err = failure(() => executeNodeFleet('beat', beatArgs(worker.session, bad), f.a));
      expect(err).toMatchObject({ code: 'bad-capacity', exit: 2 });
      expect(err.fix).toContain('phm node measure');
    }
  });
  it('the --json envelope names --capacity instead of the store', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      const store = new MemoryStore();
      const nodes = new DriveNodes(store);
      const joined = executeNodeFleet('join', ['--node', 'laptop', '--owner', 'acme'], nodes);
      const code = await cmdNodeFleet('beat', beatArgs(joined['session'] as number, 'not json').concat('--json'),
        { store, probeAuth: () => 'unknown' });
      expect(code).toBe(2);
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({ schemaVersion: 1, command: 'beat',
        error: { code: 'bad-capacity', fix: expect.stringContaining('phm node measure') } });
    } finally { vi.restoreAllMocks(); }
  });
  it('records a measured sample so the node reports its slots', () => {
    const f = fixture();
    const worker = f.a.join('laptop', { owners: ['acme'] })!;
    expect(executeNodeFleet('beat', beatArgs(worker.session, JSON.stringify(sample)), f.a))
      .toMatchObject({ nodeId: 'laptop', leader: true });
    const node = f.a.snapshot().nodes.find(n => n.nodeId === 'laptop')!;
    expect(node.capacity).toEqual(sample);
    expect(node.slots).toBe(4);
  });
});
