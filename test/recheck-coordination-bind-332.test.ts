/** RQ-PHX-RECHECKCOORDBIND332 — bindPickToCoordination binds a work-board pick
 * to the claim-store row its bus work claim wrote: origin 'message', key
 * `queue:<id>`, sourceId `<id>:<cursor>:<receivedAt>`, same owner, lease live
 * at the verdict clock. Pure function; fixtures are plainly fake. */
import { describe, expect, it } from 'vitest';
import { bindPickToCoordination } from '../src/core/fleet/recheck-coordination-bind.js';
import type { CoordinationView } from '../src/core/agents/claim-store.js';

const NOW_MS = Date.parse('2026-11-13T13:13:00.000Z');
const LEASE_MS = NOW_MS + 600_000;
const pick = { id: 'fake-request-1', owner: 'agent-alpha', claimReceipt: 'bus-claim:fake-request-1:7:1700000000000' };

function row(over: Partial<CoordinationView> = {}): CoordinationView {
  return {
    origin: 'message', key: 'queue:fake-request-1', owner: 'agent-alpha', leaseUntil: LEASE_MS,
    sourceId: 'fake-request-1:7:1700000000000', live: true,
    repo: null, branch: null, path: null, started: null, ...over,
  };
}
const available = (claims: CoordinationView[]) => ({ source: 'available' as const, claims });
const NO_ROW = 'task: no message-origin coordination claim queue:fake-request-1 with source fake-request-1:7:1700000000000';

describe('bindPickToCoordination', () => {
  it('verifies an exact live match and reports the lease as ISO', () => {
    expect(bindPickToCoordination(pick, available([row()]), NOW_MS)).toEqual({
      state: 'VERIFIED',
      claim: {
        key: 'queue:fake-request-1', sourceId: 'fake-request-1:7:1700000000000',
        owner: 'agent-alpha', leaseUntil: new Date(LEASE_MS).toISOString(),
      },
      reason: null,
    });
  });

  it('names the owner check when the matching row has a different owner', () => {
    expect(bindPickToCoordination(pick, available([row({ owner: 'agent-beta' })]), NOW_MS)).toEqual({
      state: 'UNKNOWN', claim: null,
      reason: 'task: coordination claim queue:fake-request-1 owner differs from board owner agent-alpha',
    });
  });

  it('names the lease check when the lease expired, even if the row still says live', () => {
    const reason = 'task: coordination claim queue:fake-request-1 lease not live at verdict clock';
    expect(bindPickToCoordination(pick, available([row({ leaseUntil: NOW_MS })]), NOW_MS))
      .toEqual({ state: 'UNKNOWN', claim: null, reason });
    expect(bindPickToCoordination(pick, available([row({ leaseUntil: NOW_MS - 1 })]), NOW_MS))
      .toEqual({ state: 'UNKNOWN', claim: null, reason });
    // A released/completed row (live false) never binds even with a future lease.
    expect(bindPickToCoordination(pick, available([row({ live: false })]), NOW_MS))
      .toEqual({ state: 'UNKNOWN', claim: null, reason });
  });

  it('does not bind a row whose sourceId names another cursor', () => {
    expect(bindPickToCoordination(pick, available([row({ sourceId: 'fake-request-1:8:1700000000000' })]), NOW_MS))
      .toEqual({ state: 'UNKNOWN', claim: null, reason: NO_ROW });
  });

  it('does not bind a board: key or a board-origin row', () => {
    expect(bindPickToCoordination(pick, available([row({ key: 'board:fake-request-1' })]), NOW_MS))
      .toEqual({ state: 'UNKNOWN', claim: null, reason: NO_ROW });
    expect(bindPickToCoordination(pick, available([row({ origin: 'board' })]), NOW_MS))
      .toEqual({ state: 'UNKNOWN', claim: null, reason: NO_ROW });
  });

  it('rejects a receipt that names another board item', () => {
    const other = { ...pick, claimReceipt: 'bus-claim:fake-request-2:7:1700000000000' };
    expect(bindPickToCoordination(other, available([row()]), NOW_MS)).toEqual({
      state: 'UNKNOWN', claim: null, reason: 'task: claim receipt does not name board item fake-request-1',
    });
    // A prefix-sharing id is not the same item.
    const prefixed = { ...pick, claimReceipt: 'bus-claim:fake-request-10:7:1700000000000' };
    expect(bindPickToCoordination(prefixed, available([row()]), NOW_MS).state).toBe('UNKNOWN');
  });

  it('stays UNKNOWN when the store is missing or unavailable', () => {
    expect(bindPickToCoordination(pick, { source: 'missing', claims: [] }, NOW_MS)).toEqual({
      state: 'UNKNOWN', claim: null, reason: 'task: coordination store missing, claim binding unverified',
    });
    expect(bindPickToCoordination(pick, { source: 'unavailable', claims: [row()] }, NOW_MS)).toEqual({
      state: 'UNKNOWN', claim: null, reason: 'task: coordination store unavailable, claim binding unverified',
    });
  });

  it('stays UNKNOWN on a NaN verdict clock', () => {
    expect(bindPickToCoordination(pick, available([row()]), Number.NaN)).toEqual({
      state: 'UNKNOWN', claim: null, reason: 'task: verdict clock unknown, claim binding unverified',
    });
  });

  it('never falls back to owner-only matching', () => {
    const unrelated = row({ key: 'queue:fake-request-9', sourceId: 'fake-request-9:1:1700000000000' });
    expect(bindPickToCoordination(pick, available([unrelated]), NOW_MS).state).toBe('UNKNOWN');
  });

  it('binds the owner row when another owner also holds the same coordinates', () => {
    const result = bindPickToCoordination(pick, available([row({ owner: 'agent-beta' }), row()]), NOW_MS);
    expect(result.state).toBe('VERIFIED');
    expect(result.claim?.owner).toBe('agent-alpha');
  });
});
