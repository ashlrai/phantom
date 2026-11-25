import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { inspectBusWorkClaims, mutateBusWorkClaim, releaseBusWorkClaimForOwner } from '../src/core/fleet/bus-work-claims.js';
import { acquireCoordination, listCoordination, releaseCoordinationBySource } from '../src/core/agents/claim-store.js';
import { readClaimStoreDrift } from '../src/core/fleet/claim-store-drift.js';

let root: string, now: number;
function post(id = 'message', ttl = 10_000) {
  expect(appendBusInbox({ id, from: 'fake', to: 'shared', priority: 'P1', ttl, body: 'PRIVATE_BODY' }, { root, now: () => now }).status).toBe('posted');
}
const acquire = (id = 'message', owner = 'worker', leaseMs = 1000) =>
  mutateBusWorkClaim({ action: 'acquire', id, owner, leaseMs, root });
/** The journal coordinates the coordination row's sourceId carries for `id`. */
function coords(id = 'message', owner = 'worker') {
  const row = inspectBusWorkClaims(root).claims.find(c => c.id === id && c.owner === owner);
  expect(row, `journal row for ${id}`).toBeDefined();
  return { id, cursor: row!.cursor, receivedAt: row!.receivedAt, owner };
}
const liveQueueClaims = () => listCoordination(root, now).claims.filter(c => c.live && c.key.startsWith('queue:'));
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bus-claims-owner-'));
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  post();
}, 60_000);
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); }, 60_000);

describe('releaseBusWorkClaimForOwner', () => {
  it('settles the journal row and its coordination partner, freeing re-acquire', () => {
    expect(acquire().status).toBe('acquired');
    expect(liveQueueClaims()).toHaveLength(1);
    expect(readClaimStoreDrift({ root, now }).state).toBe('VERIFIED');

    expect(releaseBusWorkClaimForOwner({ ...coords(), root, now }).status).toBe('released');
    expect(inspectBusWorkClaims(root).claims).toEqual([]);
    expect(liveQueueClaims()).toEqual([]);
    expect(readClaimStoreDrift({ root, now }).state).toBe('VERIFIED');
    // The freed message is claimable again — the release really settled both stores.
    expect(acquire('message', 'other').status).toBe('acquired');
  }, 60_000);

  it('answers lost for another owner or other receipt coordinates and touches nothing', () => {
    expect(acquire().status).toBe('acquired');
    const target = coords();
    expect(releaseBusWorkClaimForOwner({ ...target, owner: 'someone-else', root, now }).status).toBe('lost');
    expect(releaseBusWorkClaimForOwner({ ...target, cursor: target.cursor + 1, root, now }).status).toBe('lost');
    expect(releaseBusWorkClaimForOwner({ ...target, receivedAt: target.receivedAt + 1, root, now }).status).toBe('lost');
    expect(inspectBusWorkClaims(root).claims).toHaveLength(1);
    expect(liveQueueClaims()).toHaveLength(1);
  }, 60_000);

  it('reports expired and completed rows without releasing them', () => {
    const first = acquire();
    const target = coords();
    expect(mutateBusWorkClaim({ action: 'complete', id: 'message', token: first.token!, root }).status).toBe('completed');
    expect(releaseBusWorkClaimForOwner({ ...target, root, now }).status).toBe('completed');

    post('second');
    expect(acquire('second').status).toBe('acquired');
    const second = coords('second');
    now += 1001;
    expect(releaseBusWorkClaimForOwner({ ...second, root, now }).status).toBe('expired');
    // A dead row is retained until the next mutation sweeps it; it is not live evidence.
    expect(inspectBusWorkClaims(root).claims.find(c => c.id === 'second')?.completedAt).toBeNull();
  }, 60_000);

  it('clears an orphaned journal row whose coordination partner is already gone', () => {
    expect(acquire().status).toBe('acquired');
    const target = coords();
    // The failure this release exists for: the coordination row dropped while
    // the journal lease stayed live — busOnly drift and a blocked re-acquire.
    const partner = liveQueueClaims()[0]!;
    expect(releaseCoordinationBySource({ root, origin: 'message', sourceId: partner.sourceId,
      owner: partner.owner, leaseUntil: partner.leaseUntil, now }).status).toBe('released');
    expect(readClaimStoreDrift({ root, now }).state).toBe('DRIFT');
    expect(readClaimStoreDrift({ root, now }).busOnly).toHaveLength(1);

    expect(releaseBusWorkClaimForOwner({ ...target, root, now }).status).toBe('released');
    expect(inspectBusWorkClaims(root).claims).toEqual([]);
    expect(readClaimStoreDrift({ root, now }).state).toBe('VERIFIED');
  }, 60_000);

  it('refuses when the live coordination partner belongs to a different lease', () => {
    expect(acquire().status).toBe('acquired');
    const target = coords();
    const partner = liveQueueClaims()[0]!;
    releaseCoordinationBySource({ root, origin: 'message', sourceId: partner.sourceId,
      owner: partner.owner, leaseUntil: partner.leaseUntil, now });
    // A different lease now holds the same queue key; the orphaned journal row
    // must not be spliced over live disagreeing evidence.
    expect(acquireCoordination({ root, origin: 'message', key: 'queue:message', owner: 'other',
      leaseMs: 1000, leaseUntil: now + 1000, sourceId: 'message:2:2', now }).status).toBe('acquired');
    expect(releaseBusWorkClaimForOwner({ ...target, root, now }).status).toBe('mismatched-token');
    expect(inspectBusWorkClaims(root).claims).toHaveLength(1);
    expect(liveQueueClaims()).toHaveLength(1);
  }, 60_000);

  it('rejects malformed input before touching the store', () => {
    expect(releaseBusWorkClaimForOwner({ id: 'message', cursor: 0, receivedAt: now, owner: 'w', root, now }).status).toBe('invalid');
    expect(releaseBusWorkClaimForOwner({ id: 'message', cursor: 1, receivedAt: now, owner: 'bad owner', root, now }).status).toBe('invalid');
    expect(releaseBusWorkClaimForOwner({ id: 'message', cursor: 1, receivedAt: now, owner: 'w', root: 'relative', now }).status).toBe('invalid');
    expect(releaseBusWorkClaimForOwner({ id: 'message', cursor: 1, receivedAt: now, owner: 'w', root, now: -1 }).status).toBe('invalid');
    expect(inspectBusWorkClaims(root).claims).toEqual([]);
  }, 60_000);

  it('reports lock contention without changing state', () => {
    expect(acquire().status).toBe('acquired');
    const target = coords();
    const lock = acquireLocalStoreLockWithOutcome(join(root, 'bus-work-claims', 'writer.lock'), 0, { anchorPath: root, exactPrivateStorage: true });
    expect(lock.state).toBe('acquired');
    try {
      expect(releaseBusWorkClaimForOwner({ ...target, root, now }).status).toBe('retryable');
      expect(inspectBusWorkClaims(root).claims).toHaveLength(1);
    } finally { if (lock.state === 'acquired') releaseLocalStoreLock(lock.lock); }
  }, 60_000);
});
