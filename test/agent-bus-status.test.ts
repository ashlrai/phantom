import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerAgentIdentity } from '../src/core/agents/bus-identity.js';
import { readUnifiedBusStatus, type UnifiedBusStatusOptions } from '../src/core/agents/bus-status.js';
import { announceWork, sendDirectMessage, sendWakeRequest, type UnifiedBusOptions } from '../src/core/agents/bus-unified.js';
import { writeOwnerChatReceipts, type OwnerChatReceipt } from '../src/core/agents/chat-owner-receipts.js';
import { acquireCoordination } from '../src/core/agents/claim-store.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { BusBoard } from '../src/core/fleet/bus-board.js';
import { createBusMailbox } from '../src/core/fleet/bus-mailbox.js';
import { SharedStore } from '../src/core/fleet/shared-store.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import type { AshlrConfig } from '../src/core/types.js';
import { runAgentsBusUnified } from '../src/cli/agents-bus-unified.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(at = 1_000): UnifiedBusStatusOptions & { clock: { now: number } } {
  const base = mkdtempSync(join(tmpdir(), 'agent-bus-status-'));
  dirs.push(base);
  const clock = { now: at };
  return { root: join(base, 'fleet'), runsRoot: join(base, 'runs'), now: () => clock.now, clock };
}

describe('readUnifiedBusStatus', () => {
  it('reports every dependency missing or empty on a fresh root, never zeroing unknowns', () => {
    const status = readUnifiedBusStatus(setup());
    expect(status.store).toMatchObject({ source: 'missing', retainedCount: null, retainedBytes: null,
      liveCount: null, expiredCount: null, maxMessages: 1024, maxBytes: 1024 * 1024 });
    // A verifiably absent registry holds no identities: 0 is the real count.
    expect(status.registry).toEqual({ source: 'missing', identities: 0, channels: 0 });
    // A verifiably absent queue holds no hints: 0 is the real count, and
    // nothing can be truncated out of a queue that does not exist.
    expect(status.wakes).toEqual({ state: 'missing', hints: 0, truncated: false });
    expect(status.coordination).toEqual({ source: 'missing', liveClaims: null, statuses: null });
    expect(status.workClaims).toEqual({ source: 'missing', claims: null });
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
    expect(json.workClaims).toEqual({ source: 'missing', claims: null });
    expect(json.feed.status).toBe('ok');
    expect(json.mailbox).toEqual({ source: 'missing', pending: 0 });
    expect(json.ownerChat).toEqual({ source: 'missing', receipts: 0 });
    expect(json.board).toEqual({ source: 'missing', threads: 0, tasks: 0,
      pendingDeliveries: 0, claims: 'readable' });

    const text: string[] = [];
    expect(await runAgentsBusUnified(['status', '--root', options.root!], t => text.push(t), () => {}, {})).toBe(0);
    const lines = text.join('\n').split('\n');
    expect(lines[0]).toMatch(/^store missing /);
    expect(lines.join('\n')).toContain('workClaims missing claims=unknown');
    expect(lines.join('\n')).toContain('feed ok jobs=0');
    expect(lines.join('\n')).toContain('mailbox missing pending=0');
    expect(lines.join('\n')).toContain('ownerChat missing receipts=0');
    expect(lines.join('\n')).toContain('board missing threads=0 tasks=0 pending=0 claims=readable');
    expect(lines.join('\n')).toContain('wakes missing hints=0 truncated=false');
  });
});
