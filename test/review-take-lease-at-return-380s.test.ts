import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimFleetWork, handoffFleetClaim, readFleetBoard, releaseFleetClaim,
  type FleetClaim,
} from '../src/core/fleet/coordination.js';
import { takeReview, type ReviewTakeOptions } from '../src/core/fleet/review-take.js';

const repo = 'example/phantom';
const SHA = 'a'.repeat(40);
const task = `review ${repo}#10 example/review @${SHA.slice(0, 12)}`;
const prRow = {
  number: 10, title: 'Example review', headRefName: 'example/review', headRefOid: SHA,
  isDraft: false, mergeStateStatus: 'CLEAN', updatedAt: '2026-11-12T00:00:00Z',
};
const listed = () => ({ ok: true, stderr: '', stdout: JSON.stringify([prRow]) });

let directory: string;
let path: string;
let now: number;
let ghCalls: number;
let duringRecheck: (() => void) | undefined;
const gh: NonNullable<ReviewTakeOptions['gh']> = async () => {
  ghCalls += 1;
  // The hook runs while the post-claim head re-read is in flight: whatever it
  // does to the ledger or clock lands before takeReview's final ownership read.
  if (ghCalls === 2) duringRecheck?.();
  return listed();
};
function options(): ReviewTakeOptions {
  return {
    repo, agent: 'agent-one', ledgerPath: path, now: () => now, gh,
    readClaimedTsv: async () => ({ state: 'healthy', text: '' }),
    inspectBusWork: () => ({ source: 'available', claims: [] }),
    listWorkers: async () => ({ v: 1, generatedAt: '', sourceState: 'healthy', workers: [], leaders: [], orchestratorAgents: 0 }),
  };
}
const board = () => readFleetBoard({ path, now });
/** Wrap the real writer so the test can see the lease the moment it is cut. */
function capturingClaim(leased: { current?: { claim: FleetClaim; lease: string } }): NonNullable<ReviewTakeOptions['claim']> {
  return (input, opts) => {
    const result = claimFleetWork(input, opts);
    if (result.ok) leased.current = result.value;
    return result;
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'review-take-lease-380s-'));
  path = join(directory, 'coordination.jsonl');
  writeFileSync(path, '', { mode: 0o600 });
  now = Date.parse('2026-11-14T16:00:00Z');
  ghCalls = 0;
  duringRecheck = undefined;
});
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

describe('lease still live at takeReview return on the real coordination ledger', () => {
  it('refuses when the lease expires during the head re-read', async () => {
    duringRecheck = () => { now += 120_000; };
    const result = await takeReview({ ...options(), ttlSeconds: 60 });
    expect(ghCalls).toBe(2);
    expect(result).toMatchObject({ outcome: 'none', claim: null, lease: null });
    expect(result.reason).toBe('claim lease ended during head recheck');
    expect(board().claims).toEqual([]);
  });

  it('refuses when the claim is released during the head re-read', async () => {
    const leased: { current?: { claim: FleetClaim; lease: string } } = {};
    duringRecheck = () => {
      const held = leased.current!;
      expect(releaseFleetClaim({ id: held.claim.id, agent: 'agent-one', lease: held.lease }, { path, now }).ok).toBe(true);
    };
    const result = await takeReview({ ...options(), claim: capturingClaim(leased) });
    expect(result).toMatchObject({ outcome: 'none', claim: null, lease: null });
    expect(board().claims).toEqual([]);
  });

  it('reports conflict and keeps the replacement owner claim when reassigned mid-read', async () => {
    const leased: { current?: { claim: FleetClaim; lease: string } } = {};
    duringRecheck = () => {
      const held = leased.current!;
      expect(handoffFleetClaim({ id: held.claim.id, agent: 'agent-one', lease: held.lease, to: 'agent-two' }, { path, now }).ok).toBe(true);
    };
    const result = await takeReview({ ...options(), claim: capturingClaim(leased) });
    expect(result).toMatchObject({ outcome: 'conflict', owner: 'agent-two', claim: null, lease: null });
    expect(result.reason).toBe('claim reassigned during head recheck');
    // The replacement owner's live claim is untouched and our stale lease cannot touch it.
    const claims = board().claims;
    expect(claims).toEqual([expect.objectContaining({ id: leased.current!.claim.id, agent: 'agent-two' })]);
    expect(releaseFleetClaim({ id: leased.current!.claim.id, agent: 'agent-one', lease: leased.current!.lease }, { path, now }))
      .toEqual({ ok: false, error: 'not-owner' });
    expect(board().claims).toHaveLength(1);
  });

  it('refuses when the lease rotates under the same agent during the head re-read', async () => {
    const leased: { current?: { claim: FleetClaim; lease: string } } = {};
    duringRecheck = () => {
      const held = leased.current!;
      expect(handoffFleetClaim({ id: held.claim.id, agent: 'agent-one', lease: held.lease, to: 'agent-one', ttlMs: 120_000 }, { path, now }).ok).toBe(true);
    };
    const result = await takeReview({ ...options(), claim: capturingClaim(leased), ttlSeconds: 60 });
    expect(result).toMatchObject({ outcome: 'none', claim: null, lease: null });
    expect(result.reason).toBe('claim record changed during head recheck');
    // The rotated claim stays live on the ledger; we hold no lease for it.
    expect(board().claims).toEqual([expect.objectContaining({ id: leased.current!.claim.id, agent: 'agent-one' })]);
  });

  it('still returns a live claim whose lease releases only that claim', async () => {
    const foreign = claimFleetWork({ repo, task: `review ${repo}#11 other/head @${'b'.repeat(12)}`, agent: 'agent-two', ttlMs: 60_000 }, { path, now });
    if (!foreign.ok) throw new Error('fixture claim failed');
    const result = await takeReview({ ...options(), ttlSeconds: 60 });
    expect(result).toMatchObject({ outcome: 'claimed', owner: 'agent-one', claim: { task }, lease: expect.any(String) });
    const claims = board().claims;
    expect(claims).toHaveLength(2);
    expect(releaseFleetClaim({ id: result.claim!.id, agent: 'agent-one', lease: 'not-our-lease' }, { path, now }))
      .toEqual({ ok: false, error: 'not-owner' });
    expect(releaseFleetClaim({ id: result.claim!.id, agent: 'agent-one', lease: result.lease! }, { path, now }).ok).toBe(true);
    expect(board().claims).toEqual([expect.objectContaining({ id: foreign.value.claim.id, agent: 'agent-two' })]);
  });

  it('fails honestly as unavailable when the final ownership read cannot be read', async () => {
    const readBoardAfter = vi.fn()
      .mockImplementationOnce(() => board())
      .mockImplementationOnce(() => { throw new Error('fake unavailable'); });
    const result = await takeReview({ ...options(), readBoardAfter });
    expect(result).toMatchObject({ outcome: 'unavailable', claim: null, lease: null });
    expect(result.reason).toBe('claim ownership recheck unavailable');
    expect(board().claims).toEqual([]);
  });

  it('keeps a recovery receipt distinct from claimed when final-read cleanup fails', async () => {
    const readBoardAfter = vi.fn()
      .mockImplementationOnce(() => board())
      .mockImplementationOnce(() => ({ ...board(), state: 'unknown' as const }));
    const result = await takeReview({ ...options(), readBoardAfter, release: () => ({ ok: false, error: 'unavailable' }) });
    expect(result.outcome).toBe('unavailable');
    expect(result).not.toMatchObject({ outcome: 'claimed' });
    expect(result).toMatchObject({ outcome: 'unavailable', owner: 'agent-one', reason: 'claim release unavailable', claim: { task }, lease: expect.any(String) });
    expect(board().claims[0]!.id).toBe(result.claim!.id);
  });
});
