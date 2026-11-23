import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBusInbox, BUS_INBOX_MAX_READ } from '../src/core/fleet/bus-inbox.js';
import type { BusEnvelope, BusPriority } from '../src/core/fleet/bus-envelope.js';
import { claimNextBusWork, type BusNextRequest } from '../src/core/fleet/bus-next-claim.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { createAgentChannel, registerAgentIdentity, stableAgentId } from '../src/core/agents/bus-identity.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

let root: string, now: number;
const request = () => ({ to: 'worker-a', owner: 'worker-a', leaseMs: 60_000, root });
function post(id: string, changes: Partial<BusEnvelope> = {}) {
  const envelope: BusEnvelope = { id, from: 'fake-sender', to: 'worker-a', priority: 'P2', ttl: 120_000, body: { kind: 'work', text: 'fake work' }, ...changes };
  expect(appendBusInbox(envelope, { root, now: () => now }).status).toBe('posted');
}
function acquired() {
  const result = claimNextBusWork(request());
  expect(result.status).toBe('acquired');
  if (result.status !== 'acquired' || !('token' in result)) throw new Error('expected a claim');
  return result;
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bus-next-')); now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it('orders priority then cursor, fences live leases, and honors completion and release', () => {
  post('low', { priority: 'P3' }); post('first-high', { priority: 'P0' }); post('second-high', { priority: 'P0' });
  post('chat', { priority: 'P0', body: 'fake chat' }); post('other', { priority: 'P0', to: 'worker-b' });
  const first = acquired();
  expect(first.receipt.envelope.id).toBe('first-high');
  expect(first.leaseUntil).toBe(now + 60_000);
  const second = acquired();
  expect(second.receipt.envelope.id).toBe('second-high');
  expect(mutateBusWorkClaim({ action: 'complete', id: 'first-high', token: first.token, root }).status).toBe('completed');
  expect(mutateBusWorkClaim({ action: 'release', id: 'second-high', token: second.token, root }).status).toBe('released');
  const again = acquired();
  expect(again.receipt.envelope.id).toBe('second-high');
  expect(again.token).not.toBe(second.token);
  expect(acquired().receipt.envelope.id).toBe('low');
  // Three live claimable receipts still address worker-a: first-high is
  // completed, second-high and low stay held under worker-a's leases.
  expect(claimNextBusWork({ ...request(), owner: 'worker-b' }))
    .toEqual({ status: 'empty', candidates: 3, held: 2 });
});

it('passes the first page, follows sparse high-water cursors and ignores expired work', () => {
  post('expired', { ttl: 1, priority: 'P0' });
  now += 2;
  post('chat-0', { body: { kind: 'chat' } });
  const path = join(root, 'bus-inbox', 'messages.json');
  const snapshot = JSON.parse(readFileSync(path, 'utf8'));
  const seed = snapshot.rows[0];
  // Construct retained sparse history, then append the matching receipt normally.
  snapshot.rows = Array.from({ length: BUS_INBOX_MAX_READ }, (_, i) => ({
    ...seed, cursor: 10_001 + i, envelope: { ...seed.envelope, id: `chat-${i}` },
  }));
  snapshot.highWater = 10_000 + BUS_INBOX_MAX_READ;
  writeFileSync(path, JSON.stringify(snapshot), { mode: 0o600 });
  post('beyond', { priority: 'P1' });
  const result = acquired();
  expect(result.receipt.envelope.id).toBe('beyond');
  expect(result.receipt.cursor).toBeGreaterThan(10_000 + BUS_INBOX_MAX_READ);
  now += 120_000;
  // Every claimable receipt has lapsed past its TTL, so the live scan finds
  // no candidates at all — a verified-empty well, not held work.
  expect(claimNextBusWork(request())).toEqual({ status: 'empty', candidates: 0, held: 0 });
}, 120_000);

it('reports actual lock contention and claim storage errors without returning a body or token', () => {
  post('work');
  const first = acquired();
  expect(mutateBusWorkClaim({ action: 'release', id: 'work', token: first.token, root }).status).toBe('released');
  const lock = acquireLocalStoreLockWithOutcome(join(root, 'bus-work-claims', 'writer.lock'), 0, { anchorPath: root, exactPrivateStorage: true });
  expect(lock.state).toBe('acquired');
  try { expect(claimNextBusWork(request())).toEqual({ status: 'retryable' }); }
  finally { if (lock.state === 'acquired') releaseLocalStoreLock(lock.lock); }
  writeFileSync(join(root, 'bus-work-claims', 'claims.json'), '{invalid', { mode: 0o600 });
  expect(claimNextBusWork(request())).toEqual({ status: 'unavailable' });
});

it('returns empty for missing inbox and unavailable for corrupt inbox', () => {
  expect(claimNextBusWork(request())).toEqual({ status: 'empty', candidates: 0, held: 0 });
  post('work');
  writeFileSync(join(root, 'bus-inbox', 'messages.json'), '{invalid', { mode: 0o600 });
  expect(claimNextBusWork(request())).toEqual({ status: 'unavailable' });
});

it('claims work addressed under any label of the named agent identity', () => {
  expect(registerAgentIdentity({ handle: 'worker-a', aliases: ['wa-alias'] }, { root }).status).toBe('created');
  expect(registerAgentIdentity({ handle: 'worker-b', aliases: ['wb-alias'] }, { root }).status).toBe('created');
  post('a-bare');                                             // to worker-a, P2
  post('a-again', { to: 'wa-alias' });                        // P2, later cursor
  post('a-alias', { to: 'wa-alias', priority: 'P1' });
  post('a-address', { to: 'agent:worker-a', priority: 'P3' });
  post('b-alias', { to: 'wb-alias', priority: 'P0' });
  post('topic', { to: 'fleet.deploy', priority: 'P0' });
  const take = (to: string) => {
    const result = claimNextBusWork({ ...request(), to });
    expect(result.status).toBe('acquired');
    if (result.status !== 'acquired') throw new Error('expected a claim');
    // Complete, not release: a released receipt stays claimable and would be
    // picked again ahead of the lower-priority remainder.
    expect(mutateBusWorkClaim({ action: 'complete', id: result.receipt.envelope.id, token: result.token, root }).status).toBe('completed');
    return result.receipt.envelope.id;
  };
  // Every ref form names the same identity and sees work under every label,
  // highest priority first; worker-b's alias and the topic never qualify.
  expect(take('agent:worker-a')).toBe('a-alias');
  expect(take('wa-alias')).toBe('a-bare');
  expect(take(stableAgentId('worker-a'))).toBe('a-again');
  expect(take('worker-a')).toBe('a-address');
  // All four worker-a-addressed receipts are completed but still live, so the
  // scan counts them as candidates that answer 'completed', never 'held'.
  expect(claimNextBusWork({ ...request(), to: 'agent:worker-a' }))
    .toEqual({ status: 'empty', candidates: 4, held: 0 });
  // Non-identity addresses keep exact-label matching.
  expect(take('fleet.deploy')).toBe('topic');
  expect(take('agent:worker-b')).toBe('b-alias');
});

it('claims work addressed to a channel the --to identity belongs to, minus its own posts', () => {
  expect(registerAgentIdentity({ handle: 'worker-a', aliases: ['wa-alias'] }, { root }).status).toBe('created');
  expect(registerAgentIdentity({ handle: 'worker-b' }, { root }).status).toBe('created');
  expect(registerAgentIdentity({ handle: 'worker-c' }, { root }).status).toBe('created');
  // eng: worker-a + worker-b. ops: worker-c only.
  expect(createAgentChannel({ name: 'eng', createdBy: 'worker-a', members: ['worker-b'] }, { root }).status).toBe('created');
  expect(createAgentChannel({ name: 'ops', createdBy: 'worker-c' }, { root }).status).toBe('created');
  post('shared', { to: 'group:eng:general', priority: 'P1' });
  post('self-post', { to: 'group:eng:alerts', from: 'agent:worker-a', priority: 'P0' });
  post('ops-post', { to: 'group:ops:general', priority: 'P0' });
  post('direct-a', { to: 'worker-a', priority: 'P2' });
  post('direct-b', { to: 'worker-b', priority: 'P3' });
  const take = (to: string, owner: string) => {
    const result = claimNextBusWork({ ...request(), to, owner });
    expect(result.status).toBe('acquired');
    if (result.status !== 'acquired') throw new Error('expected a claim');
    expect(mutateBusWorkClaim({ action: 'complete', id: result.receipt.envelope.id, token: result.token, root }).status).toBe('completed');
    return result.receipt.envelope.id;
  };
  // worker-a (via its alias) sees the shared channel work and its own direct
  // mail; its own channel post and the ops channel stay out.
  expect(take('wa-alias', 'worker-a')).toBe('shared');
  expect(take('worker-a', 'worker-a')).toBe('direct-a');
  // shared and direct-a are completed but still live candidates; self-post is
  // the identity's own channel post and ops-post is not a member address.
  expect(claimNextBusWork({ ...request(), to: 'worker-a' }))
    .toEqual({ status: 'empty', candidates: 2, held: 0 });
  // worker-b claims the channel post worker-a sent — pending for every member
  // but its author — then its own direct mail; the completed shared work is fenced.
  expect(take('worker-b', 'worker-b')).toBe('self-post');
  expect(take('worker-b', 'worker-b')).toBe('direct-b');
  // shared, self-post and direct-b are completed but still live candidates for
  // worker-b; ops-post belongs to a channel worker-b is not a member of.
  expect(claimNextBusWork({ ...request(), to: 'worker-b' }))
    .toEqual({ status: 'empty', candidates: 3, held: 0 });
  // worker-c belongs to ops only: the eng channel work is not its to claim.
  expect(take('worker-c', 'worker-c')).toBe('ops-post');
  expect(claimNextBusWork({ ...request(), to: 'worker-c' }))
    .toEqual({ status: 'empty', candidates: 1, held: 0 });
  // An unresolvable ref and a bare channel name keep exact-label matching.
  expect(claimNextBusWork({ ...request(), to: 'worker-d' }))
    .toEqual({ status: 'empty', candidates: 0, held: 0 });
  expect(claimNextBusWork({ ...request(), to: 'group:eng' }))
    .toEqual({ status: 'empty', candidates: 0, held: 0 });
  // A literal group:<channel>:<topic> ref still exact-matches, sender aside.
  post('late', { to: 'group:eng:alerts', from: 'agent:worker-b', priority: 'P0' });
  expect(take('group:eng:alerts', 'worker-a')).toBe('late');
});

it('keeps a case-variant agent ref on exact-label matching, never a folded identity', () => {
  expect(registerAgentIdentity({ handle: 'worker-a' }, { root }).status).toBe('created');
  expect(registerAgentIdentity({ handle: 'worker-b' }, { root }).status).toBe('created');
  // eng: worker-a + worker-b.
  expect(createAgentChannel({ name: 'eng', createdBy: 'worker-a', members: ['worker-b'] }, { root }).status).toBe('created');
  post('chan-work', { to: 'group:eng:general', priority: 'P1' });
  post('direct-a', { to: 'worker-a', priority: 'P2' });
  post('case-literal', { to: 'Worker-A', priority: 'P0' });
  const take = (to: string) => {
    const result = claimNextBusWork({ ...request(), to });
    expect(result.status).toBe('acquired');
    if (result.status !== 'acquired') throw new Error('expected a claim');
    expect(mutateBusWorkClaim({ action: 'complete', id: result.receipt.envelope.id, token: result.token, root }).status).toBe('completed');
    return result.receipt.envelope.id;
  };
  // 'Worker-A' is no registered handle, alias, stable id or agent: address, so
  // it resolves to no identity: it claims only the envelope literally
  // addressed 'Worker-A', never worker-a's channel or label-addressed work —
  // the same exact-label rule an unknown ref or unreadable registry follows.
  expect(take('Worker-A')).toBe('case-literal');
  expect(claimNextBusWork({ ...request(), to: 'Worker-A' }))
    .toEqual({ status: 'empty', candidates: 1, held: 0 });
  // The real 'worker-a' still claims its member-channel post and direct mail;
  // the 'Worker-A'-addressed receipt reaches it through the envelope-label
  // rule but is already completed, so it stays a fenced candidate.
  expect(take('worker-a')).toBe('chan-work');
  expect(take('worker-a')).toBe('direct-a');
  expect(claimNextBusWork({ ...request(), to: 'worker-a' }))
    .toEqual({ status: 'empty', candidates: 3, held: 0 });
});

it('keeps channel work unmatched when the identity registry is unreadable', () => {
  expect(registerAgentIdentity({ handle: 'worker-a' }, { root }).status).toBe('created');
  expect(registerAgentIdentity({ handle: 'worker-b' }, { root }).status).toBe('created');
  expect(createAgentChannel({ name: 'eng', createdBy: 'worker-a', members: ['worker-b'] }, { root }).status).toBe('created');
  post('chan-work', { to: 'group:eng:general', priority: 'P0' });
  post('direct', { to: 'worker-a', priority: 'P1' });
  writeFileSync(join(root, 'agent-identities', 'registry.json'), '{invalid', { mode: 0o600 });
  const result = claimNextBusWork(request());
  expect(result.status).toBe('acquired');
  if (result.status !== 'acquired') throw new Error('expected a claim');
  // The higher-priority channel-addressed receipt stays unmatched: an
  // unreadable registry narrows to the literal label, never widens.
  expect(result.receipt.envelope.id).toBe('direct');
  expect(mutateBusWorkClaim({ action: 'complete', id: 'direct', token: result.token, root }).status).toBe('completed');
  // 'direct' is completed but still a live candidate; 'chan-work' stays
  // unmatched under literal matching, so nothing is held.
  expect(claimNextBusWork(request())).toEqual({ status: 'empty', candidates: 1, held: 0 });
});

it('keeps exact-label matching when the identity registry is unreadable', () => {
  expect(registerAgentIdentity({ handle: 'worker-a', aliases: ['wa-alias'] }, { root }).status).toBe('created');
  post('exact', { to: 'agent:worker-a' });
  post('alias-work', { to: 'wa-alias', priority: 'P0' });
  writeFileSync(join(root, 'agent-identities', 'registry.json'), '{invalid', { mode: 0o600 });
  const result = claimNextBusWork({ ...request(), to: 'agent:worker-a' });
  expect(result.status).toBe('acquired');
  if (result.status !== 'acquired') throw new Error('expected a claim');
  // The higher-priority alias-addressed receipt stays unmatched: an
  // unreadable registry narrows to the literal label, never widens.
  expect(result.receipt.envelope.id).toBe('exact');
  expect(mutateBusWorkClaim({ action: 'complete', id: 'exact', token: result.token, root }).status).toBe('completed');
  // 'exact' is completed but still a live candidate; 'alias-work' stays
  // unmatched under literal matching, so nothing is held.
  expect(claimNextBusWork({ ...request(), to: 'agent:worker-a' }))
    .toEqual({ status: 'empty', candidates: 1, held: 0 });
});

it('reports held and completed candidates separately from a dry well', () => {
  post('held-task', { priority: 'P0' });
  post('done-task', { priority: 'P1' });
  // A peer holds the high-priority task; the worker takes and completes the rest.
  const held = claimNextBusWork({ ...request(), owner: 'peer' });
  expect(held.status).toBe('acquired');
  const done = acquired();
  expect(done.receipt.envelope.id).toBe('done-task');
  expect(mutateBusWorkClaim({ action: 'complete', id: 'done-task', token: done.token, root }).status).toBe('completed');
  // Both addressed receipts are now unclaimable — one held by the peer's live
  // lease, one completed — so empty reports candidates with only the held one.
  expect(claimNextBusWork(request())).toEqual({ status: 'empty', candidates: 2, held: 1 });
  // An address with nothing posted is a verified-empty well, not held work.
  expect(claimNextBusWork({ ...request(), to: 'worker-b' })).toEqual({ status: 'empty', candidates: 0, held: 0 });
});

it('applies contains, since and priority to the claimable scan and its empty totals', () => {
  const t0 = now;
  post('old-alpha', { priority: 'P0', body: { kind: 'work', text: 'deploy alpha' } });
  now += 30_000;
  post('new-chore', { priority: 'P3', body: { kind: 'work', text: 'unrelated chore' } });
  post('new-alpha', { priority: 'P1', body: { kind: 'work', text: 'ship ALPHA build' } });
  const complete = (result: ReturnType<typeof claimNextBusWork>) => {
    if (result.status !== 'acquired' || !('token' in result)) throw new Error('expected a claim');
    expect(mutateBusWorkClaim({ action: 'complete', id: result.receipt.envelope.id, token: result.token, root }).status).toBe('completed');
  };

  // --priority keeps only the exact band: the P1 alpha claims while the
  // higher-priority old-alpha and lower-priority chore stay outside it.
  const byPriority = claimNextBusWork({ ...request(), priority: 'P1' });
  expect(byPriority.status).toBe('acquired');
  if (byPriority.status === 'acquired') expect(byPriority.receipt.envelope.id).toBe('new-alpha');
  complete(byPriority);

  // --contains matches the scrubbed rendered summary case-insensitively:
  // both alpha receipts remain candidates (one completed), so claim order
  // takes the P0 old-alpha; the chore never enters the filtered scan.
  const byContains = claimNextBusWork({ ...request(), contains: '  ALPHA  ' });
  expect(byContains.status).toBe('acquired');
  if (byContains.status === 'acquired') expect(byContains.receipt.envelope.id).toBe('old-alpha');
  complete(byContains);

  // --since is the inclusive receivedAt cutoff: old-alpha arrived at t0, the
  // rest at t0+30s. A P0 band cut off at t0+1 finds nothing; at t0 it finds
  // the completed receipt again — a candidate that answers 'completed'.
  expect(claimNextBusWork({ ...request(), priority: 'P0', since: t0 + 1 }))
    .toEqual({ status: 'empty', candidates: 0, held: 0 });
  expect(claimNextBusWork({ ...request(), priority: 'P0', since: t0 }))
    .toEqual({ status: 'empty', candidates: 1, held: 0 });

  // A peer holds the only unclaimed chore; the filtered totals count just it,
  // and a needle nothing matches reports a verified-empty well.
  const held = claimNextBusWork({ ...request(), owner: 'peer' });
  expect(held.status).toBe('acquired');
  if (held.status === 'acquired') expect(held.receipt.envelope.id).toBe('new-chore');
  expect(claimNextBusWork({ ...request(), contains: 'chore' }))
    .toEqual({ status: 'empty', candidates: 1, held: 1 });
  expect(claimNextBusWork({ ...request(), contains: 'zzz' }))
    .toEqual({ status: 'empty', candidates: 0, held: 0 });
});

it('applies the exclusive before bound to the claimable scan and its empty totals', () => {
  const t0 = now;
  post('pre-work', { priority: 'P0' });
  now += 30_000;
  const t1 = now;
  post('edge-work', { priority: 'P1' });
  now += 30_000;
  const t2 = now;
  post('post-work', { priority: 'P2' });
  const take = (filters: Partial<BusNextRequest> = {}) => {
    const result = claimNextBusWork({ ...request(), ...filters });
    if (result.status !== 'acquired' || !('token' in result)) throw new Error(`expected a claim, got ${result.status}`);
    expect(mutateBusWorkClaim({ action: 'complete', id: result.receipt.envelope.id, token: result.token, root }).status).toBe('completed');
    return result.receipt.envelope.id;
  };

  // --before is the exclusive receivedAt ceiling: the t1 receipt sits exactly
  // on the bound and never matches, so only the t0 work is inside the window.
  expect(take({ before: t1 })).toBe('pre-work');
  // [since, before) composes both bounds on the same receivedAt field: the
  // completed t0 receipt is the only candidate the window still holds — it
  // answers 'completed', never 'held'.
  expect(claimNextBusWork({ ...request(), since: t0, before: t1 }))
    .toEqual({ status: 'empty', candidates: 1, held: 0 });
  // The window [t1, t2) holds only the boundary-stamped edge receipt; the
  // t2 receipt sits exactly on the ceiling and stays outside.
  expect(take({ since: t1, before: t2 })).toBe('edge-work');
  // A ceiling at or before the oldest receipt, an inverted or empty window,
  // and a window the newest receipt sits on are all honest empty scans —
  // never a widened claim.
  expect(claimNextBusWork({ ...request(), before: t0 }))
    .toEqual({ status: 'empty', candidates: 0, held: 0 });
  expect(claimNextBusWork({ ...request(), since: t1, before: t1 }))
    .toEqual({ status: 'empty', candidates: 0, held: 0 });
  expect(claimNextBusWork({ ...request(), since: t1 + 1, before: t2 }))
    .toEqual({ status: 'empty', candidates: 0, held: 0 });
  expect(claimNextBusWork({ ...request(), since: t1, before: t2 }))
    .toEqual({ status: 'empty', candidates: 1, held: 0 });
  // Unbounded, the one remaining live receipt still claims.
  expect(take()).toBe('post-work');
});

it('rejects malformed contains, since and priority filters before scanning', () => {
  post('work');
  const bad: Partial<BusNextRequest>[] = [
    { contains: '   ' },
    { contains: 'x'.repeat(513) },
    { contains: 42 as unknown as string },
    { since: -1 },
    { since: 1.5 },
    { since: Number.MAX_SAFE_INTEGER + 1 },
    { since: NaN },
    { before: -1 },
    { before: 1.5 },
    { before: Number.MAX_SAFE_INTEGER + 1 },
    { before: NaN },
    { priority: 'P9' as unknown as BusPriority },
  ];
  for (const filters of bad) {
    expect(claimNextBusWork({ ...request(), ...filters })).toEqual({ status: 'invalid' });
  }
});

it('reports full claim storage rather than declaring the queue empty', () => {
  post('first');
  acquired();
  const path = join(root, 'bus-work-claims', 'claims.json');
  const [row] = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify(Array.from({ length: 1024 }, (_, i) => ({ ...row, id: `old-${i}` }))), { mode: 0o600 });
  expect(claimNextBusWork(request())).toEqual({ status: 'full' });
});
