import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claimFleetWork, readFleetBoard, type FleetCoordinationOptions, type FleetCoordinationResult } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { projectCoordinationReturns } from '../src/core/fleet/coordination-returns-view.js';

const REPO = 'ashlrai/phantom';
const AGENT_A = 'agent-a';
const AGENT_B = 'agent-b';
const dirs: string[] = [];

function fixture(now: number) {
  const dir = mkdtempSync(join(tmpdir(), 'return-expiry-reconnect-382s-'));
  dirs.push(dir);
  return { path: join(dir, 'coordination.jsonl'), now } satisfies FleetCoordinationOptions & { now: number };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
  return result.value;
}

function ledgerEvents(path: string): Array<Record<string, any>> {
  return readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, any>);
}

function expectNoLeaseMaterial(serialized: string, leases: string[]) {
  expect(serialized).not.toContain('leaseHash');
  for (const lease of leases) expect(serialized).not.toContain(lease);
}

describe('RESULT receipt expiry across ledger reconnects', () => {
  it('drops each receipt at its own expiresAt boundary while fresh reads stay known and claims stay released', () => {
    const options = fixture(1_000);
    // A reconnecting agent holds no board snapshot: every read replays the JSONL file.
    const reconnect = (nowMs: number) => {
      options.now = nowMs;
      const board = readFleetBoard(options);
      return { board, view: projectCoordinationReturns(board, nowMs) };
    };

    const claimA = must(claimFleetWork({ repo: REPO, task: 'return expiry reconnect A 382s', agent: AGENT_A }, options));
    expect(returnFleetClaim({ id: claimA.claim.id, agent: AGENT_A, lease: claimA.lease,
      tests: '12 tests passed', ttlMs: 2_000 }, options))
      .toMatchObject({ ok: true, outcome: 'returned', claimId: claimA.claim.id });

    options.now = 2_000;
    const claimB = must(claimFleetWork({ repo: REPO, task: 'return expiry reconnect B 382s', agent: AGENT_B }, options));
    expect(returnFleetClaim({ id: claimB.claim.id, agent: AGENT_B, lease: claimB.lease,
      artifact: 'proof-382s.txt', ttlMs: 6_000 }, options))
      .toMatchObject({ ok: true, outcome: 'returned', claimId: claimB.claim.id });

    // Every later step is a read: the settled ledger bytes must survive each reconnect untouched.
    const settledLedger = readFileSync(options.path, 'utf8');

    // Before expiry a fresh read projects both receipts with source, asOf and stored expiry.
    const early = reconnect(2_500);
    expect(early.board.state).toBe('known');
    expect(early.board.claims).toEqual([]);
    expect(early.view).toMatchObject({ v: 1, source: 'coordination-ledger', state: 'known', unparsed: 0,
      asOf: new Date(2_500).toISOString() });
    expect(early.view.returns).toEqual([
      expect.objectContaining({ claimId: claimB.claim.id, repo: REPO, result: 'VERIFIED', evidenceKind: 'artifact',
        evidence: 'artifact proof-382s.txt', from: AGENT_B,
        at: new Date(2_000).toISOString(), expiresAt: new Date(8_000).toISOString() }),
      expect.objectContaining({ claimId: claimA.claim.id, repo: REPO, result: 'VERIFIED', evidenceKind: 'tests',
        evidence: 'tests 12 tests passed', from: AGENT_A,
        at: new Date(1_000).toISOString(), expiresAt: new Date(3_000).toISOString() }),
    ]);
    expectNoLeaseMaterial(JSON.stringify(early.view), [claimA.lease, claimB.lease]);

    // One ms before the boundary the receipt is still live, and reopening the same
    // file returns the identical stored expiresAt: the TTL was anchored at post time.
    const justBefore = reconnect(2_999);
    expect(justBefore.view.returns.map(row => row.claimId)).toEqual([claimB.claim.id, claimA.claim.id]);
    expect(justBefore.view.returns[0]).toMatchObject({ expiresAt: new Date(8_000).toISOString() });
    expect(justBefore.view.returns[1]).toMatchObject({ at: new Date(1_000).toISOString(), expiresAt: new Date(3_000).toISOString() });
    expect(justBefore.view.returns[0]?.expiresAt).toBe(early.view.returns[0]?.expiresAt);
    expect(justBefore.view.returns[1]?.expiresAt).toBe(early.view.returns[1]?.expiresAt);
    // A stale in-memory board still carries the receipt: expiry honesty lives in the
    // fresh file read, so a reconnected agent must not re-project a cached snapshot.
    expect(projectCoordinationReturns(justBefore.board, 3_000).returns.map(row => row.claimId))
      .toEqual([claimB.claim.id, claimA.claim.id]);
    expectNoLeaseMaterial(JSON.stringify(projectCoordinationReturns(justBefore.board, 3_000)), [claimA.lease, claimB.lease]);
    expect(readFileSync(options.path, 'utf8')).toBe(settledLedger);

    // At the exact expiresAt boundary (the reader keeps messages with expiresAt > now)
    // A's receipt is excluded while B's later receipt stays live: expiry is per receipt.
    const boundary = reconnect(3_000);
    expect(boundary.board).toMatchObject({ state: 'known', claims: [], expiredClaims: 0 });
    expect(boundary.view).toMatchObject({ state: 'known', unparsed: 0, asOf: new Date(3_000).toISOString() });
    expect(boundary.view.returns).toEqual([expect.objectContaining({
      claimId: claimB.claim.id, expiresAt: new Date(8_000).toISOString(),
    })]);
    expectNoLeaseMaterial(JSON.stringify(boundary.view), [claimA.lease, claimB.lease]);

    // After the boundary the expired receipt never returns and the released claims
    // are not resurrected by any later reconnect.
    for (const nowMs of [3_001, 7_999]) {
      const later = reconnect(nowMs);
      expect(later.board).toMatchObject({ state: 'known', claims: [], expiredClaims: 0 });
      expect(later.view.state).toBe('known');
      expect(later.view.returns).toEqual([expect.objectContaining({ claimId: claimB.claim.id })]);
      expect(later.view.returns[0]?.expiresAt).toBe(new Date(8_000).toISOString());
      expectNoLeaseMaterial(JSON.stringify(later.view), [claimA.lease, claimB.lease]);
    }

    // Past B's own expiry the ledger still reads known with zero live receipts:
    // a historical VERIFIED line never becomes permanent live evidence.
    const drained = reconnect(8_000);
    expect(drained.board.state).toBe('known');
    expect(drained.view).toMatchObject({ state: 'known', returns: [], unparsed: 0, asOf: new Date(8_000).toISOString() });
    expectNoLeaseMaterial(JSON.stringify(drained.view), [claimA.lease, claimB.lease]);

    // Durable history is claim/release/post per return; the file itself never
    // changed across every reconnect and holds no lease material.
    const events = ledgerEvents(options.path);
    expect(events.map(event => event['kind'])).toEqual(['claim', 'release', 'post', 'claim', 'release', 'post']);
    expect(events[2]).toMatchObject({ kind: 'post', message: { id: `return-${claimA.claim.id}`, at: 1_000, expiresAt: 3_000 } });
    expect(events[5]).toMatchObject({ kind: 'post', message: { id: `return-${claimB.claim.id}`, at: 2_000, expiresAt: 8_000 } });
    const raw = readFileSync(options.path, 'utf8');
    expect(raw).toBe(settledLedger);
    expect(raw).not.toContain(claimA.lease);
    expect(raw).not.toContain(claimB.lease);
  });
});
