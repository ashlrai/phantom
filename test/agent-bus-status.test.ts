import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerAgentIdentity } from '../src/core/agents/bus-identity.js';
import { realHome } from '../src/core/real-home.js';
import { readUnifiedBusStatus, type UnifiedBusStatusOptions } from '../src/core/agents/bus-status.js';
import { announceWork, sendDirectMessage, sendWakeRequest, type UnifiedBusOptions } from '../src/core/agents/bus-unified.js';
import { writeOwnerChatReceipts, type OwnerChatReceipt } from '../src/core/agents/chat-owner-receipts.js';
import { acquireCoordination, releaseLiveClaimByOwner } from '../src/core/agents/claim-store.js';
import { appendBusInbox, BUS_INBOX_MAX_MESSAGES } from '../src/core/fleet/bus-inbox.js';
import { BusBoard } from '../src/core/fleet/bus-board.js';
import { createBusMailbox } from '../src/core/fleet/bus-mailbox.js';
import { SharedStore } from '../src/core/fleet/shared-store.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { appendBusHop } from '../src/core/fleet/bus-hoplog.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import type { AshlrConfig } from '../src/core/types.js';
import { runAgentsBusUnified } from '../src/cli/agents-bus-unified.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(at = 1_000): UnifiedBusStatusOptions & { clock: { now: number } } {
  const base = mkdtempSync(join(tmpdir(), 'agent-bus-status-'));
  dirs.push(base);
  const clock = { now: at };
  return { root: join(base, 'fleet'), runsRoot: join(base, 'runs'), now: () => clock.now, clock,
    seats: { home: join(base, 'seat-home') } };
}

describe('readUnifiedBusStatus', () => {
  it('reports every dependency missing or empty on a fresh root, never zeroing unknowns', () => {
    const status = readUnifiedBusStatus(setup());
    expect(status.store).toMatchObject({ source: 'missing', retainedCount: null, retainedBytes: null,
      liveCount: null, expiredCount: null, maxMessages: BUS_INBOX_MAX_MESSAGES, maxBytes: 1024 * 1024 });
    // A verifiably absent registry holds no identities: 0 is the real count.
    expect(status.registry).toEqual({ source: 'missing', identities: 0, channels: 0 });
    // A verifiably absent queue holds no hints: 0 is the real count, and
    // nothing can be truncated out of a queue that does not exist.
    expect(status.wakes).toEqual({ state: 'missing', hints: 0, truncated: false });
    // A verifiably absent hop log holds no hops: 0 is the real count.
    expect(status.hoplog).toEqual({ state: 'missing', bytes: 0, hops: 0,
      skippedRows: 0, truncated: false });
    expect(status.coordination).toEqual({ source: 'missing', liveClaims: null, statuses: null });
    expect(status.workClaims).toEqual({ source: 'missing', claims: null });
    // Two verified-empty stores agree trivially: VERIFIED with real zeros.
    expect(status.claimDrift).toEqual({ state: 'VERIFIED', matched: 0, busOnly: 0,
      coordOnly: 0, ownerMismatch: 0 });
    // A missing store is an empty feed, matching `work feed` semantics.
    expect(status.feed).toEqual({ status: 'ok', jobs: 0 });
    // A verifiably absent mailbox holds no pending mail: 0 is proven.
    expect(status.mailbox).toEqual({ source: 'missing', pending: 0 });
    // A verifiably absent receipts ledger holds no rows: 0 is proven.
    expect(status.ownerChat).toEqual({ source: 'missing', receipts: 0 });
    // A verifiably absent board holds no rows: 0 is the real count, and the
    // queue claim index reads as an empty-but-readable store.
    expect(status.board).toEqual({ source: 'missing', threads: 0, tasks: 0,
      pendingDeliveries: 0, claims: 'readable' });
    // A verifiably absent seat store holds no roster, states or records.
    expect(status.seats).toEqual({ source: 'missing', seats: 0, states: 0, handoffs: 0, notices: 0 });
    // A verifiably absent dispatch journal holds no receipts: 0 is proven.
    expect(status.peerDispatch).toEqual({ source: 'missing', receipts: 0, unpublished: 0 });
    // A verifiably absent coordination ledger holds no live rows: 0 is proven.
    expect(status.peerLedger).toEqual({ source: 'missing', liveRows: 0 });
    // A verifiably absent handoff store holds no journals: 0 is the real count.
    expect(status.sessionHandoffs).toEqual({ source: 'missing', journals: 0, open: 0,
      awaitingFailover: 0, unreadable: 0, truncated: false });
    expect(Number.isNaN(Date.parse(status.asOf))).toBe(false);
  });

  it('counts real rows across all sections after bus activity', async () => {
    const options = setup();
    const bus: UnifiedBusOptions = options;
    for (const handle of ['atlas', 'nova']) {
      expect(registerAgentIdentity({ handle,
        runtime: { cli: 'claude', provider: 'claude', model: null } }, options).status).toBe('created');
    }
    expect(await sendDirectMessage({ from: 'atlas', to: 'nova', text: 'ping', id: 'dm-1' }, bus))
      .toMatchObject({ status: 'posted' });
    expect(await sendWakeRequest({ from: 'atlas', to: 'nova', reason: 'check inbox', id: 'wk-1' }, bus))
      .toMatchObject({ status: 'posted' });
    expect(await announceWork({ from: 'atlas', jobId: 'RQ-S-1', title: 'Status probe', repo: 'a/b',
      claimKeys: ['repo:a/b'], provider: 'claude', id: 'w-1' }, bus)).toMatchObject({ status: 'posted' });
    const at = options.now();
    expect(acquireCoordination({ root: options.root, origin: 'resource', key: 'queue:RQ-S-1',
      owner: 'agent:nova', leaseMs: 60_000, leaseUntil: at + 60_000, sourceId: 'test:1', now: at }).status)
      .toBe('acquired');

    const status = readUnifiedBusStatus(options);
    expect(status.store.source).toBe('available');
    expect(status.store.retainedCount).toBeGreaterThanOrEqual(3);
    expect(status.store.liveCount).toBe(status.store.retainedCount);
    expect(status.registry).toEqual({ source: 'available', identities: 2, channels: 0 });
    expect(status.wakes.state).toBe('ok');
    expect(status.wakes.hints).toBeGreaterThanOrEqual(1);
    // The wake request above appended one hop to the send path's own log.
    expect(status.hoplog).toMatchObject({ state: 'ok', hops: 1, skippedRows: 0, truncated: false });
    expect(status.hoplog.bytes).toBeGreaterThan(0);
    expect(status.coordination.source).toBe('available');
    expect(status.coordination.liveClaims).toBe(1);
    expect(status.feed).toEqual({ status: 'ok', jobs: 1 });
    expect(status.mailbox).toEqual({ source: 'missing', pending: 0 });
    expect(status.ownerChat).toEqual({ source: 'missing', receipts: 0 });
  });

  it('keeps an unreadable registry unknown while the rest of the bus stays readable', () => {
    const options = setup();
    // Register first so the private directory chain exists with correct modes,
    // then corrupt only the registry payload.
    expect(registerAgentIdentity({ handle: 'atlas' }, options).status).toBe('created');
    const file = join(options.root!, 'agent-identities', 'registry.json');
    writeFileSync(file, '{not json');
    chmodSync(file, 0o600);
    const status = readUnifiedBusStatus(options);
    expect(status.registry).toEqual({ source: 'unavailable', identities: null, channels: null });
    expect(status.store.source).toBe('missing');
    expect(status.feed.status).toBe('ok');
  });

  it('surfaces a refused work feed with its reason instead of an empty job list', () => {
    const options = setup();
    const bus: UnifiedBusOptions = options;
    expect(registerAgentIdentity({ handle: 'atlas' }, options).status).toBe('created');
    // A retained post with no resolvable provider poisons the whole projection.
    expect(appendBusInbox({ id: 'poison-1', from: 'agent:ghost', to: 'leaders', priority: 'P2', ttl: 60_000,
      body: { kind: 'work.post', jobId: 'RQ-POISON', title: 'x', repo: 'a/b', claimKeys: [] } }, bus).status)
      .toBe('posted');
    const status = readUnifiedBusStatus(options);
    expect(status.feed.status).toBe('refused');
    expect(status.feed.jobs).toBeNull();
    expect(status.feed.reason).toContain('missing-provider');
    // The probe names the retained receipt the projection blamed.
    expect(status.feed.receipt).toBe('poison-1');
    // The store itself is still readable and counted.
    expect(status.store.source).toBe('available');
    expect(status.store.retainedCount).toBe(1);
  });

  it('counts retained message-id claim records and degrades only that section when the journal is unreadable', () => {
    // mutateBusWorkClaim reads the wall clock, so this probe needs real time.
    const options = setup(Date.now());
    const envelope: BusEnvelope = { id: 'w-claim-1', from: 'agent:nova', to: 'agent:atlas',
      priority: 'P2', ttl: 120_000, body: { kind: 'work', text: 'fake work' } };
    expect(appendBusInbox(envelope, { root: options.root, now: options.now }).status).toBe('posted');
    expect(mutateBusWorkClaim({ action: 'acquire', id: 'w-claim-1', owner: 'agent:atlas',
      leaseMs: 60_000, root: options.root }).status).toBe('acquired');

    const status = readUnifiedBusStatus(options);
    expect(status.workClaims).toEqual({ source: 'available', claims: 1 });
    // The same acquire also took a coordination lease under queue:w-claim-1.
    expect(status.coordination.liveClaims).toBe(1);

    // Corrupt only the journal payload; every other section still reads.
    const file = join(options.root!, 'bus-work-claims', 'claims.json');
    writeFileSync(file, '{not json');
    chmodSync(file, 0o600);
    const degraded = readUnifiedBusStatus(options);
    expect(degraded.workClaims).toEqual({ source: 'unavailable', claims: null });
    expect(degraded.store.source).toBe('available');
    expect(degraded.coordination.source).toBe('available');
    expect(degraded.feed.status).toBe('ok');
    // The journal the verdict joins is unreadable, so the comparison cannot
    // run: UNKNOWN with every count null — never a fabricated zero.
    expect(degraded.claimDrift).toEqual({ state: 'UNKNOWN', matched: null,
      busOnly: null, coordOnly: null, ownerMismatch: null });
  });

  it('counts pending legacy mailbox mail and degrades only that section when unreadable', () => {
    const options = setup();
    // The mailbox home is the fleet root's parent — the same derivation
    // `work mine` and the status probe both apply.
    const mailbox = createBusMailbox(dirname(options.root!), options.now);
    const send = (id: string, to: string, ttl = 60_000) => mailbox.send({ id, from: 'agent:atlas', to,
      priority: 'P2', ttl, body: { text: 'fake legacy mail' } });
    send('m-pending-1', 'atlas');
    send('m-pending-2', 'agent:nova');
    send('m-acked', 'atlas');
    expect(mailbox.ack('m-acked', 'atlas').acknowledged).toBe(true);
    send('m-expired', 'atlas', 1_000);
    // Advance the shared clock past the short TTL: the row stays retained but
    // is no longer pending, so the count proves real pending, not raw records.
    options.clock.now += 2_000;

    const status = readUnifiedBusStatus(options);
    expect(status.mailbox).toEqual({ source: 'available', pending: 2 });
    expect(status.store.source).toBe('missing');
    expect(status.coordination.source).toBe('missing');

    // A mailbox path that is not a directory reads unavailable, never zero.
    const broken = setup();
    writeFileSync(join(dirname(broken.root!), 'bus-mailbox'), 'not a directory', { mode: 0o600 });
    const degraded = readUnifiedBusStatus(broken);
    expect(degraded.mailbox).toEqual({ source: 'unavailable', pending: null });
    expect(degraded.store.source).toBe('missing');
  });

  it('counts owner-chat share receipts and degrades only that section when the ledger is unreadable', () => {
    const options = setup();
    // The ledger lives under the fleet root; writeOwnerChatReceipts needs the
    // private directory chain to exist first, the same way the ingress does.
    mkdirSync(options.root!, { recursive: true, mode: 0o700 });
    mkdirSync(join(options.root!, 'owner-chat-receipts'), { mode: 0o700 });
    const receipt: OwnerChatReceipt = { id: `owner-chat-${'a'.repeat(32)}`,
      recipients: [`agt_${'b'.repeat(20)}`], contentDigest: 'c'.repeat(64),
      envelopeDigest: 'd'.repeat(64), state: 'accepted', cursor: 1, receivedAt: 1_000 };
    writeOwnerChatReceipts(options.root!, [receipt]);

    const status = readUnifiedBusStatus(options);
    expect(status.ownerChat).toEqual({ source: 'available', receipts: 1 });
    expect(status.store.source).toBe('missing');

    // A corrupt ledger is the exact failure `inbox` reports as unavailable;
    // the probe must name it rather than leaving status all-green.
    const file = join(options.root!, 'owner-chat-receipts', 'receipts.json');
    writeFileSync(file, '{not json');
    chmodSync(file, 0o600);
    const degraded = readUnifiedBusStatus(options);
    expect(degraded.ownerChat).toEqual({ source: 'unavailable', receipts: null });
    expect(degraded.store.source).toBe('missing');
    expect(degraded.feed.status).toBe('ok');
  });
});

describe('claimDrift section', () => {
  const claimEnvelope = (id: string): BusEnvelope => ({ id, from: 'agent:nova', to: 'agent:atlas',
    priority: 'P2', ttl: 120_000, body: { kind: 'work', text: 'fake work' } });

  it('verifies a matched claim pair, then reports bus-only drift when the coordination row is gone', () => {
    // mutateBusWorkClaim reads the wall clock, so this probe needs real time.
    const options = setup(Date.now());
    expect(appendBusInbox(claimEnvelope('w-drift-1'), { root: options.root, now: options.now }).status).toBe('posted');
    expect(mutateBusWorkClaim({ action: 'acquire', id: 'w-drift-1', owner: 'agent:atlas',
      leaseMs: 60_000, root: options.root }).status).toBe('acquired');

    // The acquire dual-wrote both stores: one joined pair, owners agree.
    const verified = readUnifiedBusStatus(options);
    expect(verified.claimDrift).toEqual({ state: 'VERIFIED', matched: 1, busOnly: 0,
      coordOnly: 0, ownerMismatch: 0 });

    // Settle only the coordination side. The bus journal still shows a live
    // lease the coordination table no longer holds — DRIFT, never verified.
    expect(releaseLiveClaimByOwner({ root: options.root, key: 'queue:w-drift-1',
      owner: 'agent:atlas' }).status).toBe('released');
    expect(readUnifiedBusStatus(options).claimDrift)
      .toEqual({ state: 'DRIFT', matched: 0, busOnly: 1, coordOnly: 0, ownerMismatch: 0 });
  });

  it('reports coordination-only and owner-mismatch drift kinds', () => {
    // mutateBusWorkClaim reads the wall clock, so this probe needs real time.
    const options = setup(Date.now());
    const at = options.now();
    // A live message claim with no bus partner is coordination-only drift.
    expect(acquireCoordination({ root: options.root, origin: 'message', key: 'queue:ghost-1',
      owner: 'agent:nova', leaseMs: 60_000, leaseUntil: at + 60_000,
      sourceId: 'ghost-1:9:9', now: at }).status).toBe('acquired');
    expect(readUnifiedBusStatus(options).claimDrift)
      .toEqual({ state: 'DRIFT', matched: 0, busOnly: 0, coordOnly: 1, ownerMismatch: 0 });

    // A joined pair whose owners disagree is owner-mismatch drift: the bus
    // journal names atlas while the coordination row names nova. The bus
    // row's sourceId triple is <id>:<cursor>:<receivedAt> — cursor 1 for the
    // first retained message, receivedAt the frozen probe clock.
    expect(appendBusInbox(claimEnvelope('w-drift-2'), { root: options.root, now: options.now }).status).toBe('posted');
    expect(mutateBusWorkClaim({ action: 'acquire', id: 'w-drift-2', owner: 'agent:atlas',
      leaseMs: 60_000, root: options.root }).status).toBe('acquired');
    expect(releaseLiveClaimByOwner({ root: options.root, key: 'queue:w-drift-2',
      owner: 'agent:atlas' }).status).toBe('released');
    expect(acquireCoordination({ root: options.root, origin: 'message', key: 'queue:w-drift-2',
      owner: 'agent:nova', leaseMs: 60_000, leaseUntil: at + 60_000,
      sourceId: `w-drift-2:1:${at}`, now: at }).status).toBe('acquired');
    expect(readUnifiedBusStatus(options).claimDrift)
      .toEqual({ state: 'DRIFT', matched: 0, busOnly: 0, coordOnly: 1, ownerMismatch: 1 });
  });

  it('nulls every count when the coordination side cannot be read', () => {
    const options = setup(Date.now());
    expect(appendBusInbox(claimEnvelope('w-drift-3'), { root: options.root, now: options.now }).status).toBe('posted');
    expect(mutateBusWorkClaim({ action: 'acquire', id: 'w-drift-3', owner: 'agent:atlas',
      leaseMs: 60_000, root: options.root }).status).toBe('acquired');

    const file = join(options.root!, 'coordination', 'claims.json');
    writeFileSync(file, '{not json');
    chmodSync(file, 0o600);
    const degraded = readUnifiedBusStatus(options);
    expect(degraded.coordination.source).toBe('unavailable');
    expect(degraded.claimDrift).toEqual({ state: 'UNKNOWN', matched: null,
      busOnly: null, coordOnly: null, ownerMismatch: null });
    // The bus journal itself still reads and counts.
    expect(degraded.workClaims).toEqual({ source: 'available', claims: 1 });
  });
});

describe('board section', () => {
  /** The shared task board at the paths the probe derives from the fleet root. */
  function board(options: UnifiedBusStatusOptions) {
    return new BusBoard({ root: join(dirname(options.root!), 'bus'),
      fleet: new SharedStore(join(options.root!, 'bus-queue'), 60_000),
      cfg: { foundry: {} } as AshlrConfig });
  }

  it('reports a never-written board as verified missing without creating its store', () => {
    const options = setup();
    options.board = { config: { foundry: {} } as AshlrConfig };
    const status = readUnifiedBusStatus(options);
    expect(status.board).toEqual({ source: 'missing', threads: 0, tasks: 0,
      pendingDeliveries: 0, claims: 'readable' });
    // Read-only: the probe never creates the board or queue directories.
    expect(existsSync(join(dirname(options.root!), 'bus'))).toBe(false);
    expect(existsSync(join(options.root!, 'bus-queue'))).toBe(false);
    expect(status.store.source).toBe('missing');
  });

  it('counts stored board rows and deliveries still awaiting receipt', async () => {
    const options = setup();
    options.board = { config: { foundry: {} } as AshlrConfig };
    const store = board(options);
    const threadId = store.createThread('nova', 'Coordination').id;
    store.joinThread('atlas', threadId);
    await store.post('nova', threadId, 'probe mail');
    store.createTask('nova', threadId, 'item-1', 'Board task');
    // Two members each got one delivery; atlas's receipt leaves one pending.
    const delivery = store.readThread('atlas', threadId)[0]!;
    store.acknowledge('atlas', threadId, delivery.id);

    const status = readUnifiedBusStatus(options);
    expect(status.board).toEqual({ source: 'available', threads: 1, tasks: 1,
      pendingDeliveries: 1, claims: 'readable' });
    expect(status.store.source).toBe('missing');
  });

  it('reports an unreadable board as unavailable while the queue stays probed', async () => {
    const options = setup();
    options.board = { config: { foundry: {} } as AshlrConfig };
    const store = board(options);
    const threadId = store.createThread('nova', 'Faults').id;
    store.createTask('nova', threadId, 'item-x', 'Task');

    // Corrupt board state: unavailable with null counts, never an empty board.
    writeFileSync(join(dirname(options.root!), 'bus', 'state.json'), '{broken', { mode: 0o600 });
    const status = readUnifiedBusStatus(options);
    expect(status.board).toEqual({ source: 'unavailable', threads: null, tasks: null,
      pendingDeliveries: null, claims: 'readable' });
    expect(status.store.source).toBe('missing');
  });

  it('keeps the board readable while reporting an unreadable queue claim index', async () => {
    const options = setup();
    options.board = { config: { foundry: {} } as AshlrConfig };
    const store = board(options);
    const threadId = store.createThread('nova', 'Queue fault').id;
    store.createTask('nova', threadId, 'item-x', 'Task');

    mkdirSync(join(options.root!, 'bus-queue'), { recursive: true });
    writeFileSync(join(options.root!, 'bus-queue', 'ashlr-fleet-queue.json'), '{broken', { mode: 0o600 });
    const status = readUnifiedBusStatus(options);
    expect(status.board).toEqual({ source: 'available', threads: 1, tasks: 1,
      pendingDeliveries: 0, claims: 'unreadable' });
  });

  it('derives board paths from a configured shared queue and fails closed without attestation', async () => {
    const options = setup();
    const sharedDir = join(dirname(options.root!), 'shared-queue');
    const cfg = { foundry: {}, fleet: { sharedQueue: { mode: 'filesystem' as const,
      path: sharedDir, trustedCoherentStorage: true } } } as AshlrConfig;
    options.board = { config: cfg };
    const store = new BusBoard({ root: join(sharedDir, 'bus'),
      fleet: new SharedStore(sharedDir, 60_000), cfg });
    const threadId = store.createThread('nova', 'Shared').id;
    store.createTask('nova', threadId, 'item-s', 'Shared task');

    const status = readUnifiedBusStatus(options);
    expect(status.board).toEqual({ source: 'available', threads: 1, tasks: 1,
      pendingDeliveries: 0, claims: 'readable' });

    // A shared-queue config without the coherent-storage attestation is
    // unavailable — the probe never guesses an untrusted queue path.
    options.board = { config: { foundry: {}, fleet: { sharedQueue: { mode: 'filesystem' as const,
      path: sharedDir } } } as AshlrConfig };
    expect(readUnifiedBusStatus(options).board).toEqual({ source: 'unavailable', threads: null,
      tasks: null, pendingDeliveries: null, claims: null });
  });
});

describe('seats section', () => {
  const botsDir = (options: UnifiedBusStatusOptions) => join(options.seats!.home!, '.phantom', 'bots');
  const seatRecord = { id: 'helper', kind: 'devin-bot', displayName: 'helper',
    participantId: 'atlas', capabilities: ['code'], quota: { source: 'none' } };
  const handoffRecord = { schema: 'phantom-bot-handoff.v1', handoffId: 'h-1', seatId: 'helper',
    work: { kind: 'bus-claim', ref: 'repo:a/b' }, done: 'unknown', left: 'unknown',
    branch: null, pr: null, createdAt: '2026-01-01T00:00:00.000Z' };

  it('counts roster, state and journal rows and never creates the store', () => {
    const options = setup();
    const dir = botsDir(options);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'seats.json'), JSON.stringify({ schema: 'phantom-bot-seats.v1', seats: [seatRecord] }));
    writeFileSync(join(dir, 'seat-state.json'), JSON.stringify({ helper: { state: 'draining', since: '2026-01-01T00:00:00.000Z', exhaustedReset: null } }));
    writeFileSync(join(dir, 'handoffs.jsonl'), JSON.stringify(handoffRecord) + '\n');

    const status = readUnifiedBusStatus(options);
    expect(status.seats).toEqual({ source: 'available', seats: 1, states: 1, handoffs: 1, notices: 0 });
    expect(status.store.source).toBe('missing');

    // Read-only: a fresh probe over a never-written home reports missing and
    // leaves no bots directory behind.
    const fresh = setup();
    expect(readUnifiedBusStatus(fresh).seats).toEqual({ source: 'missing', seats: 0, states: 0, handoffs: 0, notices: 0 });
    expect(existsSync(join(fresh.seats!.home!, '.phantom'))).toBe(false);
  });

  it('keeps readable files counted while a corrupt roster degrades the section', () => {
    const options = setup();
    const dir = botsDir(options);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'seats.json'), '{not json', { mode: 0o600 });
    writeFileSync(join(dir, 'seat-state.json'), JSON.stringify({ helper: {} }));
    writeFileSync(join(dir, 'handoffs.jsonl'), JSON.stringify(handoffRecord) + '\n');

    const status = readUnifiedBusStatus(options);
    // The same corrupt roster that makes planSeatHandoffs throw is named
    // here; the two healthy files still report their real counts.
    expect(status.seats).toEqual({ source: 'unavailable', seats: null, states: 1, handoffs: 1, notices: 0 });
    expect(status.feed.status).toBe('ok');
  });

  it('reports an unsafe bots path as unavailable with every count null', () => {
    const options = setup();
    mkdirSync(join(options.seats!.home!, '.phantom'), { recursive: true });
    writeFileSync(join(options.seats!.home!, '.phantom', 'bots'), 'not a directory', { mode: 0o600 });

    const status = readUnifiedBusStatus(options);
    expect(status.seats).toEqual({ source: 'unavailable', seats: null, states: null, handoffs: null, notices: null });
    expect(status.store.source).toBe('missing');
  });

  it('nulls only the file whose contents the snapshot cannot use', () => {
    const options = setup();
    const dir = botsDir(options);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'seats.json'), JSON.stringify({ schema: 'phantom-bot-seats.v1', seats: [seatRecord] }));
    // `null` parses as JSON but snapshot() cannot index it by seat id — the
    // same failure that makes the plan read throw.
    writeFileSync(join(dir, 'seat-state.json'), 'null', { mode: 0o600 });
    writeFileSync(join(dir, 'handoffs.jsonl'), 'null\n' + JSON.stringify(handoffRecord) + '\n');

    const status = readUnifiedBusStatus(options);
    expect(status.seats).toEqual({ source: 'unavailable', seats: 1, states: null, handoffs: null, notices: 0 });
  });

  it('counts handoff-notices receipt rows and nulls only a receipts file apply could not use', () => {
    const options = setup();
    const dir = botsDir(options);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'seats.json'), JSON.stringify({ schema: 'phantom-bot-seats.v1', seats: [seatRecord] }));
    writeFileSync(join(dir, 'handoff-notices.json'),
      JSON.stringify({ 'h-1': { bus: { id: 'm-1' }, owner: { id: 'o-1' } }, 'h-2': { bus: null, owner: null } }), { mode: 0o600 });

    expect(readUnifiedBusStatus(options).seats)
      .toEqual({ source: 'available', seats: 1, states: 0, handoffs: 0, notices: 2 });

    // A receipts file applySeatHandoff cannot round-trip: `null` throws on
    // the receipt lookup and an array silently drops string-keyed receipts
    // on saveReceipts — either way applies fail or resend while a
    // seats/states/handoffs-only probe would have stayed green.
    for (const bad of ['null', '[]', '"x"']) {
      writeFileSync(join(dir, 'handoff-notices.json'), bad, { mode: 0o600 });
      expect(readUnifiedBusStatus(options).seats)
        .toEqual({ source: 'unavailable', seats: 1, states: 0, handoffs: 0, notices: null });
    }
    writeFileSync(join(dir, 'handoff-notices.json'), '{not json', { mode: 0o600 });
    expect(readUnifiedBusStatus(options).seats)
      .toEqual({ source: 'unavailable', seats: 1, states: 0, handoffs: 0, notices: null });
  });
});

describe('peerDispatch section', () => {
  const queueId = (c: string) => `peer-work-${c.repeat(32)}`;
  const receiptId = (c: string) => `pw-${c.repeat(32)}`;
  const receipt = (over: Record<string, unknown> = {}) => ({
    kind: 'work.result', jobId: 'RQ-PEER-1', claimKey: `queue:${queueId('a')}`,
    queueId: queueId('a'), receiptId: receiptId('b'), outcome: 'admitted',
    peer: 'peer-a', consumer: 'dispatch', digest: 'c'.repeat(64),
    at: 1_000, ...over,
  });
  /** The journal `consumePeerWork` writes under `<busRoot>/agentnet/` — the same path the probe resolves from `root`. */
  const writeJournal = (options: UnifiedBusStatusOptions, receipts: unknown[]) => {
    const dir = join(options.root!, 'agentnet');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'work-dispatch.json'), JSON.stringify({ version: 1, receipts }), { mode: 0o600 });
  };

  it('counts retained receipts and the unpublished backlog without creating the store', () => {
    const options = setup();
    writeJournal(options, [
      // sent trails outcome — still owed to the peer.
      receipt({ sent: 'reserved' }),
      // sent absent entirely — never published.
      receipt({ outcome: 'complete', queueId: queueId('d'), receiptId: receiptId('e'), claimKey: `queue:${queueId('d')}` }),
      // Latest outcome already published — history, not pending.
      receipt({ outcome: 'failed', reason: 'repo-denied', sent: 'failed', queueId: queueId('f'), receiptId: receiptId('0'), claimKey: `queue:${queueId('f')}` }),
      // Outcome and sent agree — nothing owed.
      receipt({ outcome: 'reserved', sent: 'reserved', queueId: queueId('1'), receiptId: receiptId('2'), claimKey: `queue:${queueId('1')}` }),
    ]);

    const status = readUnifiedBusStatus(options);
    expect(status.peerDispatch).toEqual({ source: 'available', receipts: 4, unpublished: 2 });
    expect(status.store.source).toBe('missing');

    // Read-only: a fresh probe over a never-written root reports missing and
    // leaves no agentnet directory behind.
    const fresh = setup();
    expect(readUnifiedBusStatus(fresh).peerDispatch).toEqual({ source: 'missing', receipts: 0, unpublished: 0 });
    expect(existsSync(join(fresh.root!, 'agentnet'))).toBe(false);
  });

  it('keeps a corrupt journal unavailable with null counts while the rest of the bus stays readable', () => {
    const options = setup();
    const dir = join(options.root!, 'agentnet');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'work-dispatch.json'), '{not json', { mode: 0o600 });

    const status = readUnifiedBusStatus(options);
    // The same corrupt journal that makes consumePeerWork throw and the
    // unified inbox report unavailable is named here; nulls, never zeros.
    expect(status.peerDispatch).toEqual({ source: 'unavailable', receipts: null, unpublished: null });
    expect(status.store.source).toBe('missing');
    expect(status.feed.status).toBe('ok');
  });
});

describe('peerLedger section', () => {
  const NOW = 1_800_000_000_000, HOUR = 3_600_000;
  const UUID = '123e4567-e89b-12d3-a456-426614174000';
  let n = 0;
  const ledgerRow = (from: string, target: string, at: number, over: Record<string, unknown> = {}) => ({
    id: `peer-${UUID.slice(0, 35)}${n++ % 10}`, fromAgent: from, target,
    origin: `peer-${UUID}`, digest: 'a'.repeat(64), hopCount: 1,
    threadId: 'thread', at, ...over });
  /** The ledger `sendPeerMessage`/`readPeerInbox` parse under
   * `<busRoot>/agentnet/` — the same path the probe resolves from `root`. */
  const writeLedger = (options: UnifiedBusStatusOptions, rows: unknown[]) => {
    const dir = join(options.root!, 'agentnet');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'coordination.json'), JSON.stringify(rows), { mode: 0o600 });
  };

  it('counts live ledger rows without creating the store', () => {
    const options = setup(NOW);
    writeLedger(options, [
      ledgerRow('agent0', 'agent1', NOW - 1_000),
      ledgerRow('agent0', 'agent2', NOW - 2_000),
      // Older than the 24h live window — retained but no longer budgeted.
      ledgerRow('agent0', 'agent1', NOW - 25 * HOUR),
    ]);

    const status = readUnifiedBusStatus(options);
    expect(status.peerLedger).toEqual({ source: 'available', liveRows: 2 });
    expect(status.store.source).toBe('missing');

    // Read-only: a fresh probe over a never-written root reports missing and
    // leaves no agentnet directory behind.
    const fresh = setup(NOW);
    expect(readUnifiedBusStatus(fresh).peerLedger).toEqual({ source: 'missing', liveRows: 0 });
    expect(existsSync(join(fresh.root!, 'agentnet'))).toBe(false);
  });

  it('keeps a present-but-fully-expired ledger available with a real zero', () => {
    const options = setup(NOW);
    writeLedger(options, [ledgerRow('agent0', 'agent1', NOW - 25 * HOUR)]);

    const status = readUnifiedBusStatus(options);
    // The file exists and parses — available — but no row sits inside the
    // live window, so 0 is the proven count, not a missing-store placeholder.
    expect(status.peerLedger).toEqual({ source: 'available', liveRows: 0 });
  });

  it('keeps a corrupt ledger unavailable with a null count while the rest of the bus stays readable', () => {
    const options = setup(NOW);
    const dir = join(options.root!, 'agentnet');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'coordination.json'), '{not json', { mode: 0o600 });

    const status = readUnifiedBusStatus(options);
    // The same corrupt ledger that makes sendPeerMessage/readPeerInbox throw
    // closed is named here; null, never zero.
    expect(status.peerLedger).toEqual({ source: 'unavailable', liveRows: null });
    expect(status.store.source).toBe('missing');
    expect(status.feed.status).toBe('ok');
  });
});

describe('sendGate section', () => {
  // The gate reads realHome() — the worker's isolated HOME under the test
  // harness — never the probe's `root`, exactly like the send path.
  const killPath = () => join(realHome()!, '.ashlr', 'KILL');
  const pausePath = () => join(realHome()!, '.ashlr', 'comms', 'pause.json');
  afterEach(() => {
    // unlinkSync, not rmSync: rmSync leaves a dangling symlink in place
    // (existsSync follows the dead target and reports it absent), and a
    // later writeFileSync would write through the leftover link.
    for (const path of [killPath(), pausePath()]) {
      try { unlinkSync(path); } catch { /* absent or not a link/file */ }
    }
    rmSync(dirname(pausePath()), { recursive: true, force: true });
  });

  it('reports open when neither gate source is engaged', () => {
    const status = readUnifiedBusStatus(setup());
    expect(status.sendGate).toEqual({ state: 'open',
      kill: { state: 'inactive', reason: 'missing' },
      pause: { state: 'clear', since: null, reason: null } });
  });

  it('reports blocked with the kill verdict when the sentinel is present', () => {
    mkdirSync(dirname(killPath()), { recursive: true });
    writeFileSync(killPath(), 'kill switch active\n', { mode: 0o600 });
    const status = readUnifiedBusStatus(setup());
    expect(status.sendGate).toEqual({ state: 'blocked',
      kill: { state: 'active', reason: 'present' },
      pause: { state: 'clear', since: null, reason: null } });
    // The same read the send path makes agrees: localWriteGate refuses.
    expect(status.store.source).toBe('missing');
  });

  it('reports blocked with the pause verdict and its recorded start', () => {
    mkdirSync(dirname(pausePath()), { recursive: true });
    writeFileSync(pausePath(), JSON.stringify({ paused: true, since: 1_700_000_000_000 }));
    const status = readUnifiedBusStatus(setup());
    expect(status.sendGate).toEqual({ state: 'blocked',
      kill: { state: 'inactive', reason: 'missing' },
      pause: { state: 'paused', since: 1_700_000_000_000, reason: null } });
  });

  it('keeps an uninspectable pause file unknown — never clear — while sends still fail closed', () => {
    mkdirSync(dirname(pausePath()), { recursive: true });
    writeFileSync(pausePath(), '{not json', { mode: 0o600 });
    const status = readUnifiedBusStatus(setup());
    // isPaused() fails closed on the same file, so the gate refuses; the
    // probe says unknown with the reason rather than calling it a pause.
    expect(status.sendGate).toEqual({ state: 'unknown',
      kill: { state: 'inactive', reason: 'missing' },
      pause: { state: 'unknown', since: null, reason: 'is not valid JSON' } });
  });

  it('keeps an unsafe kill sentinel unknown rather than folding it into inactive', () => {
    mkdirSync(dirname(killPath()), { recursive: true });
    // A symlink fails safeAuthorityFile — the same 'unsafe' verdict
    // readKillSwitch reports, which killSwitchOn treats as engaged.
    symlinkSync(join(realHome()!, '.ashlr', 'missing-target'), killPath());
    const status = readUnifiedBusStatus(setup());
    expect(status.sendGate).toEqual({ state: 'unknown',
      kill: { state: 'unknown', reason: 'unsafe' },
      pause: { state: 'clear', since: null, reason: null } });
  });

  it('stays blocked when one gate is provably engaged and the other is unknown', () => {
    mkdirSync(dirname(killPath()), { recursive: true });
    writeFileSync(killPath(), 'kill switch active\n', { mode: 0o600 });
    mkdirSync(dirname(pausePath()), { recursive: true });
    writeFileSync(pausePath(), '{not json', { mode: 0o600 });
    const status = readUnifiedBusStatus(setup());
    // The armed kill switch is a positive block; the degraded pause file
    // keeps its own unknown verdict instead of being hidden by it.
    expect(status.sendGate).toEqual({ state: 'blocked',
      kill: { state: 'active', reason: 'present' },
      pause: { state: 'unknown', since: null, reason: 'is not valid JSON' } });
  });
});

describe('sessionHandoffs section', () => {
  const handoffsDir = (options: UnifiedBusStatusOptions) => join(options.runsRoot!, 'handoffs');

  function journalRecord(job: string, signal: unknown = { kind: 'checkpoint' }, planState = 'pending') {
    return {
      schema: 'session-handoff.v1', revision: 1, at: '2026-11-20T10:00:00.000Z',
      signal, job, attempt: 'att-1', repo: 'test/fixture', lane: 'codex-personal', model: 'model-a',
      minTier: 'work', needs: ['typescript'], goal: 'Do the fake thing',
      plan: [{ action: 'step 1', state: planState }],
      filesTouched: ['result'], decisions: ['keep it'], evidence: ['e1'],
      nextAction: 'do step 1', contextDigest: 'ctx',
      repoState: { root: '/fake/host/root', head: 'a'.repeat(40), digest: 'b'.repeat(64), entireCheckpoint: null },
    };
  }

  function writeJournal(options: UnifiedBusStatusOptions, job: string, records: object[]) {
    const dir = handoffsDir(options);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${job}.jsonl`), records.map(record => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 });
  }

  it('counts open and failover-yielded journals while isolating unreadable ones', () => {
    const options = setup();
    writeJournal(options, 'parked', [journalRecord('parked')]);
    writeJournal(options, 'yielded', [journalRecord('yielded', { kind: 'rate-limit', status: 429 })]);
    writeJournal(options, 'budget-ok', [journalRecord('budget-ok',
      { kind: 'budget', remainingFraction: 0.5, threshold: 0.2 })]);
    writeJournal(options, 'done', [journalRecord('done', { kind: 'completed' }, 'done')]);
    writeFileSync(join(handoffsDir(options), 'corrupt.jsonl'), 'not json\n', { mode: 0o600 });
    // open: parked, yielded, budget-ok (3); awaitingFailover: yielded only —
    // budget-ok stays above its threshold; done is retained history.
    expect(readUnifiedBusStatus(options).sessionHandoffs).toEqual({
      source: 'available', journals: 5, open: 3, awaitingFailover: 1, unreadable: 1, truncated: false });
  });

  it('reports unavailable with null counts when the store cannot be read', () => {
    const options = setup();
    writeJournal(options, 'job', [journalRecord('job')]);
    chmodSync(options.runsRoot!, 0);
    try {
      expect(readUnifiedBusStatus(options).sessionHandoffs).toEqual({ source: 'unavailable',
        journals: null, open: null, awaitingFailover: null, unreadable: null, truncated: null });
    } finally { chmodSync(options.runsRoot!, 0o700); }
  });
});

describe('hoplog section', () => {
  const hoplogFile = (options: UnifiedBusStatusOptions) => join(options.root!, 'bus', 'hops.jsonl');

  it('counts valid hops and reports malformed rows as skipped evidence', () => {
    const options = setup();
    const file = hoplogFile(options);
    expect(appendBusHop({ id: 'hop-1', from: 'agent:atlas', to: 'agent:nova' }, file)).toBe(true);
    expect(appendBusHop({ id: 'hop-2', from: 'agent:atlas', to: 'agent:nova' }, file)).toBe(true);
    appendFileSync(file, 'not json\n');
    const status = readUnifiedBusStatus(options);
    expect(status.hoplog).toMatchObject({ state: 'ok', hops: 2, skippedRows: 1, truncated: false });
    expect(status.hoplog.bytes).toBeGreaterThan(0);
    // A sick log degrades only its own section; the rest of the bus stays readable.
    expect(status.wakes.state).toBe('missing');
    expect(status.store.source).toBe('missing');
  });

  it('reports unreadable with null counts when the log fails custody', () => {
    const options = setup();
    const file = hoplogFile(options);
    expect(appendBusHop({ id: 'hop-1', from: 'agent:a', to: 'agent:b' }, file)).toBe(true);
    chmodSync(file, 0o644);
    try {
      expect(readUnifiedBusStatus(options).hoplog).toEqual({ state: 'unreadable',
        bytes: null, hops: null, skippedRows: null, truncated: null });
    } finally { chmodSync(file, 0o600); }
  });
});

describe('phm agents bus status', () => {
  it('prints one honest line per section in human mode and the object as JSON', async () => {
    const options = setup();
    const out: string[] = [], err: string[] = [];
    const code = await runAgentsBusUnified(['status', '--root', options.root!, '--json'],
      t => out.push(t), t => err.push(t), {});
    expect(code).toBe(0);
    const json = JSON.parse(out.join('\n'));
    expect(json.store.source).toBe('missing');
    expect(json.registry.identities).toBe(0);
    expect(json.wakes.state).toBe('missing');
    expect(json.hoplog).toEqual({ state: 'missing', bytes: 0, hops: 0,
      skippedRows: 0, truncated: false });
    expect(json.workClaims).toEqual({ source: 'missing', claims: null });
    expect(json.claimDrift).toEqual({ state: 'VERIFIED', matched: 0, busOnly: 0,
      coordOnly: 0, ownerMismatch: 0 });
    expect(json.feed.status).toBe('ok');
    expect(json.mailbox).toEqual({ source: 'missing', pending: 0 });
    expect(json.ownerChat).toEqual({ source: 'missing', receipts: 0 });
    expect(json.board).toEqual({ source: 'missing', threads: 0, tasks: 0,
      pendingDeliveries: 0, claims: 'readable' });
    expect(json.seats).toEqual({ source: 'missing', seats: 0, states: 0, handoffs: 0, notices: 0 });
    expect(json.peerDispatch).toEqual({ source: 'missing', receipts: 0, unpublished: 0 });
    expect(json.peerLedger).toEqual({ source: 'missing', liveRows: 0 });
    expect(json.sessionHandoffs).toEqual({ source: 'missing', journals: 0, open: 0,
      awaitingFailover: 0, unreadable: 0, truncated: false });
    expect(json.sendGate).toEqual({ state: 'open',
      kill: { state: 'inactive', reason: 'missing' },
      pause: { state: 'clear', since: null, reason: null } });

    const text: string[] = [];
    expect(await runAgentsBusUnified(['status', '--root', options.root!], t => text.push(t), () => {}, {})).toBe(0);
    const lines = text.join('\n').split('\n');
    expect(lines[0]).toMatch(/^store missing /);
    expect(lines.join('\n')).toContain('workClaims missing claims=unknown');
    expect(lines.join('\n')).toContain('claimDrift VERIFIED matched=0 busOnly=0 coordOnly=0 ownerMismatch=0');
    expect(lines.join('\n')).toContain('feed ok jobs=0');
    expect(lines.join('\n')).toContain('mailbox missing pending=0');
    expect(lines.join('\n')).toContain('ownerChat missing receipts=0');
    expect(lines.join('\n')).toContain('board missing threads=0 tasks=0 pending=0 claims=readable');
    expect(lines.join('\n')).toContain('seats missing seats=0 states=0 handoffs=0');
    expect(lines.join('\n')).toContain('peerDispatch missing receipts=0 unpublished=0');
    expect(lines.join('\n')).toContain('peerLedger missing liveRows=0');
    expect(lines.join('\n')).toContain('sessionHandoffs missing journals=0 open=0 awaitingFailover=0 unreadable=0 truncated=false');
    expect(lines.join('\n')).toContain('sendGate open kill=inactive:missing pause=clear');
    expect(lines.join('\n')).toContain('wakes missing hints=0 truncated=false');
    expect(lines.join('\n')).toContain('hoplog missing bytes=0 hops=0 skipped=0 truncated=false');
  });
});
