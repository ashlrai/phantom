import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SharedStore, type QueueClaimRef } from '../src/core/fleet/shared-store.js';

let dir: string;
let store: SharedStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bus-handoff-'));
  store = new SharedStore(dir, 60_000);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function claim(): QueueClaimRef {
  const refs = store.claimLeases(['work-item'], 1, 'peer-a');
  expect(refs).toHaveLength(1);
  return refs[0]!;
}

describe('fleet claim handoff', () => {
  it('transfers a live claim with a fresh generation and fences all old-holder actions', () => {
    const old = claim();
    const next = store.handoffClaim(old, 'peer-b');
    expect(next).toMatchObject({ itemId: old.itemId, machineId: 'peer-b', phase: 'claimed', queueId: old.queueId });
    expect(next!.epoch).toBeGreaterThan(old.epoch);
    expect(next!.ownerToken).not.toBe(old.ownerToken);
    expect(store.validateClaims([next!])).toEqual([next]);
    expect(store.validateClaims([old])).toEqual([]);
    expect(store.renewClaims([old])).toEqual([]);
    expect(store.releaseClaims([old])).toEqual([]);
    expect(store.beginClaimExecution(old)).toBeNull();
    expect(store.handoffClaim(old, 'peer-c')).toBeNull();
    expect(new SharedStore(dir).claimLeases([old.itemId], 1, 'peer-c')).toEqual([]);
    expect(store.readSnapshot().claims[old.itemId]?.machineId).toBe('peer-b');
  });

  it('allows exactly one winner when independent stores hand off the same claim', () => {
    const ref = claim();
    const contenders = [new SharedStore(dir, 60_000), new SharedStore(dir, 60_000)];
    const results = contenders.map((contender, index) => contender.handoffClaim(ref, `peer-${index}`));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(store.validateClaims([ref])).toEqual([]);
    expect(store.readSnapshot().claims[ref.itemId]?.machineId).toBe(results.find(Boolean)!.machineId);
  });

  it('rejects an expired claim even before another peer reclaims it', () => {
    const ref = claim();
    vi.spyOn(Date, 'now').mockReturnValue(ref.leaseUntil);
    expect(store.handoffClaim(ref, 'peer-b')).toBeNull();
    const successor = store.claimLeases([ref.itemId], 1, 'peer-c')[0]!;
    expect(successor.machineId).toBe('peer-c');
    expect(store.handoffClaim(ref, 'peer-b')).toBeNull();
    expect(store.validateClaims([successor])).toEqual([successor]);
  });

  it('rejects both the old claimed ref and executing ref after execution starts', () => {
    const ref = claim();
    const executing = store.beginClaimExecution(ref)!;
    expect(executing.phase).toBe('executing');
    expect(store.handoffClaim(ref, 'peer-b')).toBeNull();
    expect(store.handoffClaim(executing, 'peer-b')).toBeNull();
    expect(store.validateClaims([executing])).toEqual([executing]);
  });

  it.each(['', '   ', 'peer-a', 'x'.repeat(513), 'é'.repeat(257)])('rejects an invalid or unchanged target (%#)', (peer) => {
    const ref = claim();
    expect(store.handoffClaim(ref, peer)).toBeNull();
    expect(store.validateClaims([ref])).toEqual([ref]);
  });

  it('requires the exact generation, token, queue, and lease', () => {
    const ref = claim();
    for (const invalid of [
      { ...ref, ownerToken: 'wrong' }, { ...ref, queueId: 'wrong' },
      { ...ref, epoch: ref.epoch + 1 }, { ...ref, leaseUntil: ref.leaseUntil + 1 },
      { ...ref, machineId: 'peer-b' },
    ]) expect(store.handoffClaim(invalid, 'peer-c')).toBeNull();
    expect(store.validateClaims([ref])).toEqual([ref]);
  });

  it('fails closed on queue lock contention and preserves ownership', () => {
    const ref = claim();
    writeFileSync(join(dir, 'ashlr-fleet-queue.json.lock'), JSON.stringify({ token: 'test-holder' }), { mode: 0o600 });
    expect(store.handoffClaim(ref, 'peer-b')).toBeNull();
    expect(store.validateClaims([ref])).toEqual([ref]);
  });

  it('does not overwrite an unreadable queue', () => {
    const ref = claim();
    writeFileSync(join(dir, 'ashlr-fleet-queue.json'), '{broken');
    expect(store.handoffClaim(ref, 'peer-b')).toBeNull();
    expect(store.readHealth().readable).toBe(false);
  });
});
