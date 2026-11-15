import { describe, expect, it } from 'vitest';
import type { FleetBoard, FleetClaim } from '../src/core/fleet/coordination.js';
import { projectCoordinationClaims } from '../src/core/fleet/coordination-claims-view.js';

const now = Date.parse('2026-11-14T12:00:00Z');
const claim: FleetClaim = { id: 'claim-example', repo: 'ashlrai/phantom', task: 'example',
  agent: 'dot-example', claimedAt: now, expiresAt: now + 1499 };
function board(claims: FleetClaim[]): FleetBoard {
  return { schema: 'fleet.coordination.v1', state: 'known', claims,
    messages: [], proposals: [], expiredClaims: 3 };
}

describe('coordination claims projection (376)', () => {
  it('sorts newest first, caps at 50 and leaves the board untouched', () => {
    const input = board(Array.from({ length: 55 }, (_, i) => ({ ...claim, id: `claim-${i}`, claimedAt: now + i })));
    const view = projectCoordinationClaims(input, now);
    expect(view.claims.map(c => c.id)).toEqual(Array.from({ length: 50 }, (_, i) => `claim-${54 - i}`));
    expect(input.claims[0]?.id).toBe('claim-0');
    expect(view).toMatchObject({ v: 1, source: 'coordination-ledger', state: 'known', expiredClaims: 3, asOf: new Date(now).toISOString() });
  });

  it('caps task text and projects ISO timestamps with rounded expiry', () => {
    expect(projectCoordinationClaims(board([{ ...claim, task: 'x'.repeat(201) }]), now).claims)
      .toEqual([{ ...claim, task: 'x'.repeat(200), claimedAt: new Date(now).toISOString(),
        expiresAt: new Date(claim.expiresAt).toISOString(), expiresInSeconds: 1 }]);
  });

  it('reports reader failure as unknown ownership', () => {
    expect(projectCoordinationClaims(null, now)).toEqual({ v: 1, source: 'coordination-ledger',
      state: 'unknown', claims: [], expiredClaims: null, asOf: new Date(now).toISOString(),
      reason: 'coordination ledger: reader failed' });
  });

  it('preserves an unknown board', () => {
    expect(projectCoordinationClaims({ ...board([]), state: 'unknown', expiredClaims: null }, now))
      .toMatchObject({ state: 'unknown', claims: [], expiredClaims: null });
  });

  it('excludes injected lease material and non-claim sections', () => {
    const injected = { ...claim, leaseHash: 'private-hash-example', lease: 'private-lease-example' };
    const input = { ...board([injected]), messages: [{ body: 'private-message-example' }],
      proposals: [{ task: 'private-proposal-example' }] } as FleetBoard;
    const output = JSON.stringify(projectCoordinationClaims(input, now));
    for (const forbidden of ['leaseHash', 'lease', 'private-hash-example', 'private-lease-example',
      'messages', 'proposals', 'private-message-example', 'private-proposal-example']) expect(output).not.toContain(forbidden);
  });
});
