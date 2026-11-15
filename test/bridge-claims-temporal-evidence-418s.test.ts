import { describe, expect, it } from 'vitest';
import type { FleetBoard } from '../src/core/fleet/coordination.js';
import { projectCoordinationClaims } from '../src/core/fleet/coordination-claims-view.js';
import { readFleetBridgeCheck, type FleetBridgeCheckDeps } from '../src/mcp/fleet-bridge-check.js';

const NOW = Date.parse('2026-11-15T00:00:00.000Z');
const NOW_ISO = '2026-11-15T00:00:00.000Z';
const MARKER = 'REJECTED-FIXTURE-MARKER-418s';

const RUNTIME = {
  lastFleetStateRead: { mtime: '2026-11-14T23:59:30.000Z', ageSeconds: 30 },
  asOf: NOW_ISO,
};
const PEERS = { v: 1, status: 'ok', asOf: NOW_ISO, liveRows: 0 };

function claimRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'fake-claim-a', repo: 'fake/repo', task: 'fake task', agent: 'fake-agent',
    claimedAt: '2026-11-14T23:59:00.000Z', expiresAt: '2026-11-15T01:00:00.000Z',
    expiresInSeconds: 3600, ...overrides,
  };
}

function projection(claims: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, source: 'coordination-ledger', asOf: NOW_ISO, state: 'known', claims, expiredClaims: 0, ...overrides };
}

function deps(claims: FleetBridgeCheckDeps['claims']): FleetBridgeCheckDeps {
  return {
    runtime: async () => structuredClone(RUNTIME),
    claims,
    peers: () => structuredClone(PEERS),
    now: () => NOW,
  };
}

function expectClaimsUnreadable(check: Awaited<ReturnType<typeof readFleetBridgeCheck>>) {
  expect(check.verdict).toBe('BLOCKED');
  expect(check.missing).toEqual(['claims']);
  expect(check.claims).toMatchObject({ status: 'unavailable', state: 'unknown', live: null,
    newestAgeSec: null, reason: 'claims-list-unreadable' });
  expect(check.runtime.status).toBe('ok');
  expect(check.peers.status).toBe('ok');
}

describe('fleet_bridge_check claims temporal evidence', () => {
  it('READY with live 0 and unknown newest age for a valid empty ledger', async () => {
    const check = await readFleetBridgeCheck(deps(() => projection([])));
    expect(check.verdict).toBe('READY');
    expect(check.missing).toEqual([]);
    expect(check.claims).toEqual({ status: 'ok', state: 'known', live: 0, newestAgeSec: null,
      source: 'coordination-ledger', asOf: NOW_ISO });
  });

  it('READY for rows projected by the real producer contract', async () => {
    const board: FleetBoard = {
      schema: 'fleet.coordination.v1', state: 'known',
      claims: [
        { id: 'fake-claim-new', repo: 'fake/repo', task: 'fake task', agent: 'fake-agent',
          claimedAt: NOW - 60_000, expiresAt: NOW + 3_600_000 },
        { id: 'fake-claim-old', repo: 'fake/repo', task: 'fake task', agent: 'fake-agent',
          claimedAt: NOW - 120_000, expiresAt: NOW + 3_540_000 },
      ],
      messages: [], proposals: [], expiredClaims: 0,
    };
    const claims = projectCoordinationClaims(board, NOW);
    const check = await readFleetBridgeCheck(deps(() => claims));
    expect(check.verdict).toBe('READY');
    expect(check.missing).toEqual([]);
    expect(check.claims).toMatchObject({ status: 'ok', state: 'known', live: 2, newestAgeSec: 60 });
    expect(claims.claims.every(row => Number.isFinite(row.expiresInSeconds))).toBe(true);
  });

  it('BLOCKED when expiresAt is not a parseable timestamp', async () => {
    for (const expiresAt of ['unknown', `not-a-date-${MARKER}`, '', '2026-13-40T99:99:99.000Z']) {
      const check = await readFleetBridgeCheck(deps(() => projection([claimRow({ expiresAt })])));
      expectClaimsUnreadable(check);
      expect(JSON.stringify(check)).not.toContain(MARKER);
    }
  });

  it('BLOCKED when expiry does not fall after the claim', async () => {
    const claimed = Date.parse('2026-11-14T23:59:00.000Z');
    for (const expiresAt of [
      '2026-11-14T23:58:59.000Z',
      '2026-11-14T23:59:00.000Z',
      new Date(claimed).toISOString(),
    ]) {
      const check = await readFleetBridgeCheck(deps(() => projection([claimRow({ expiresAt })])));
      expectClaimsUnreadable(check);
    }
  });

  it('BLOCKED when claimedAt sits materially in the future', async () => {
    for (const offsetMs of [60_000, 3_600_000]) {
      const check = await readFleetBridgeCheck(deps(() => projection([
        claimRow({ claimedAt: new Date(NOW + offsetMs).toISOString(),
          expiresAt: new Date(NOW + offsetMs + 60_000).toISOString() }),
      ])));
      expectClaimsUnreadable(check);
    }
  });

  it('tolerates a claimedAt inside the small clock-skew window as a fresh claim', async () => {
    const check = await readFleetBridgeCheck(deps(() => projection([
      claimRow({ claimedAt: new Date(NOW + 2_000).toISOString(),
        expiresAt: '2026-11-15T01:00:00.000Z' }),
    ])));
    expect(check.verdict).toBe('READY');
    expect(check.claims).toMatchObject({ status: 'ok', state: 'known', live: 1, newestAgeSec: 0 });
  });

  it('BLOCKED when expiresInSeconds contradicts a live claim', async () => {
    for (const expiresInSeconds of [-1, Number.NEGATIVE_INFINITY, 'soon', null]) {
      const check = await readFleetBridgeCheck(deps(() => projection([
        claimRow({ expiresInSeconds }),
      ])));
      expectClaimsUnreadable(check);
    }
  });

  it('BLOCKED with unknown live count when one row in a mixed list is temporally invalid', async () => {
    const check = await readFleetBridgeCheck(deps(() => projection([
      claimRow({ id: 'fake-claim-valid' }),
      claimRow({ id: 'fake-claim-bad', expiresAt: 'not-a-date' }),
    ])));
    expectClaimsUnreadable(check);
    expect(check.claims.live).toBeNull();
  });
});
