import { describe, expect, it } from 'vitest';
import type { FleetBoard, FleetClaim } from '../src/core/fleet/coordination.js';
import { parseCoordinationClaimsFilters, projectCoordinationClaims } from '../src/core/fleet/coordination-claims-view.js';

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
      matched: null, omitted: null, reason: 'coordination ledger: reader failed' });
  });

  it('preserves an unknown board', () => {
    expect(projectCoordinationClaims({ ...board([]), state: 'unknown', expiredClaims: null }, now))
      .toMatchObject({ state: 'unknown', claims: [], expiredClaims: null, matched: null, omitted: null });
  });

  it('reports matched and omitted honestly under the cap', () => {
    const input = board(Array.from({ length: 55 }, (_, i) => ({ ...claim, id: `claim-${i}`, claimedAt: now + i })));
    const view = projectCoordinationClaims(input, now);
    expect(view.claims).toHaveLength(50);
    expect(view.matched).toBe(55);
    expect(view.omitted).toBe(5);
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

describe('coordination claims filters', () => {
  const claims: FleetClaim[] = [
    { ...claim, id: 'claim-a', repo: 'ashlrai/phantom', task: 'alpha work', agent: 'dot-one', claimedAt: now - 3000 },
    { ...claim, id: 'claim-b', repo: 'ashlrai/other', task: 'beta work', agent: 'dot-two', claimedAt: now - 2000 },
    { ...claim, id: 'claim-c', repo: 'ASHLRAI/PHANTOM', task: 'gamma work', agent: 'dot-one', claimedAt: now - 1000 },
  ];
  const input = board(claims);

  it('keeps one exact claim id', () => {
    const view = projectCoordinationClaims(input, now, { id: 'claim-b' });
    expect(view.claims.map(c => c.id)).toEqual(['claim-b']);
    expect(view.matched).toBe(1);
    expect(view.omitted).toBe(0);
  });

  it('keeps claims one agent label holds, exactly', () => {
    const view = projectCoordinationClaims(input, now, { agent: 'dot-one' });
    expect(view.claims.map(c => c.id).sort()).toEqual(['claim-a', 'claim-c']);
    expect(view.matched).toBe(2);
  });

  it('compares repo case-insensitively', () => {
    const view = projectCoordinationClaims(input, now, { repo: 'ashlrai/phantom' });
    expect(view.claims.map(c => c.id).sort()).toEqual(['claim-a', 'claim-c']);
    expect(view.matched).toBe(2);
  });

  it('reads one [since, before) window on claimedAt', () => {
    const view = projectCoordinationClaims(input, now, { since: now - 2500, before: now - 1500 });
    expect(view.claims.map(c => c.id)).toEqual(['claim-b']);
    expect(view.matched).toBe(1);
    // A claim stamped exactly at before never matches — the exclusive upper bound.
    expect(projectCoordinationClaims(input, now, { before: now - 1000 }).claims.map(c => c.id))
      .toEqual(['claim-b', 'claim-a']);
    expect(projectCoordinationClaims(input, now, { since: now - 1000 }).claims.map(c => c.id))
      .toEqual(['claim-c']);
  });

  it('keeps claims whose id, repo, task or agent carries the needle', () => {
    // Resolved filters carry the parser-normalized lowercase needle.
    expect(projectCoordinationClaims(input, now, { contains: 'beta' }).claims.map(c => c.id)).toEqual(['claim-b']);
    expect(projectCoordinationClaims(input, now, { contains: 'dot-one' }).matched).toBe(2);
    expect(projectCoordinationClaims(input, now, { contains: 'missing' }).claims).toEqual([]);
    expect(projectCoordinationClaims(input, now, { contains: 'missing' }).matched).toBe(0);
  });

  it('reaches claims the unfiltered cap hides', () => {
    const many = board(Array.from({ length: 55 }, (_, i) => ({ ...claim, id: `claim-${i}`, claimedAt: now - i })));
    const oldest = projectCoordinationClaims(many, now).claims.some(c => c.id === 'claim-54');
    expect(oldest).toBe(false);
    const filtered = projectCoordinationClaims(many, now, { id: 'claim-54' });
    expect(filtered.claims.map(c => c.id)).toEqual(['claim-54']);
    expect(filtered.matched).toBe(1);
    expect(filtered.omitted).toBe(0);
  });

  it('keeps expiredClaims on the board total under filters', () => {
    const view = projectCoordinationClaims(input, now, { agent: 'dot-one' });
    expect(view.expiredClaims).toBe(3);
  });
});

describe('parseCoordinationClaimsFilters', () => {
  it('resolves the shared time grammar and lowercases repo', () => {
    const parsed = parseCoordinationClaimsFilters({ repo: 'AshlrAI/Phantom', since: '1h', contains: '  Beta   Work ' }, now);
    expect(parsed).toEqual({ ok: true, filters: {
      repo: 'ashlrai/phantom', since: now - 3_600_000, contains: 'beta work' } });
  });

  it.each([
    { id: 'bad id!' }, { agent: '' }, { repo: 'not-a-repo' },
    { since: 'whenever' }, { before: '-5' }, { contains: '   ' }, { contains: 'x'.repeat(513) },
  ])('refuses %j', input => {
    expect(parseCoordinationClaimsFilters(input, now).ok).toBe(false);
  });

  it('accepts an empty filter set', () => {
    expect(parseCoordinationClaimsFilters({}, now)).toEqual({ ok: true, filters: {} });
  });
});
