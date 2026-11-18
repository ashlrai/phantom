import { describe, expect, it } from 'vitest';
import type { FleetBoard, FleetClaim } from '../src/core/fleet/coordination.js';
import { projectCoordinationClaims } from '../src/core/fleet/coordination-claims-view.js';

const now = Date.parse('2026-11-14T12:00:00Z');
const claim: FleetClaim = { id: 'example', repo: 'example/repo', task: 'example',
  agent: 'example-agent', claimedAt: now, expiresAt: now + 1499 };
const board = (claims: FleetClaim[]): FleetBoard => ({ schema: 'fleet.coordination.v1',
  state: 'known', claims, messages: [], proposals: [], expiredClaims: 0 });
const invalidClocks = [8640000000000001, -8640000000000001, NaN, Infinity, -Infinity];

describe('coordination claims clock recovery', () => {
  it.each(invalidClocks)('keeps unknown observation and claim clocks readable: %s', clock => {
    const input = board([{ ...claim, claimedAt: clock, expiresAt: clock }]);
    const result = projectCoordinationClaims(input, clock);
    expect(result).toMatchObject({ asOf: 'unknown', claims: [{ claimedAt: 'unknown',
      expiresAt: 'unknown', expiresInSeconds: null }] });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(input.claims[0]?.claimedAt).toBe(clock);
    expect(projectCoordinationClaims(null, clock)).toMatchObject({ asOf: 'unknown',
      state: 'unknown', claims: [], expiredClaims: null });
  });

  it('retains a valid neighbor and excludes unrelated data when a row has malformed dates', () => {
    const bad = { ...claim, id: 'bad', claimedAt: 8640000000000001,
      expiresAt: -8640000000000001, lease: 'private-lease' };
    const input = { ...board([bad, claim]), messages: [{ body: 'private-message' }],
      proposals: [{ task: 'private-proposal' }] } as FleetBoard;
    const result = projectCoordinationClaims(input, now);
    expect(result.claims).toContainEqual({ id: 'bad', repo: claim.repo, task: claim.task,
      agent: claim.agent, claimedAt: 'unknown', expiresAt: 'unknown', expiresInSeconds: null });
    expect(result.claims).toContainEqual({ ...claim, claimedAt: new Date(now).toISOString(),
      expiresAt: new Date(claim.expiresAt).toISOString(), expiresInSeconds: 1 });
    expect(JSON.stringify(result)).not.toMatch(/lease|message|proposal/);
    expect(input.claims).toEqual([bad, claim]);
  });

  it('recovers duration for the same board when the observation clock becomes valid', () => {
    const input = board([claim]);
    expect(projectCoordinationClaims(input, Infinity).claims[0]?.expiresInSeconds).toBeNull();
    const recovered = projectCoordinationClaims(input, now);
    expect(recovered.asOf).toBe(new Date(now).toISOString());
    expect(recovered.claims[0]?.expiresInSeconds).toBe(1);
  });
});
