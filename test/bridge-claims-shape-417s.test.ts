import { describe, expect, it } from 'vitest';
import { readFleetBridgeCheck, type FleetBridgeCheckDeps } from '../src/mcp/fleet-bridge-check.js';

const NOW = Date.parse('2026-11-15T00:00:00.000Z');
const NOW_ISO = '2026-11-15T00:00:00.000Z';
const MARKER = 'REJECTED-FIXTURE-MARKER-417s';

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

describe('fleet_bridge_check claims ledger shape', () => {
  it('READY with live 0 for a known empty claims array', async () => {
    const check = await readFleetBridgeCheck(deps(() => projection([])));
    expect(check.verdict).toBe('READY');
    expect(check.missing).toEqual([]);
    expect(check.claims).toEqual({ status: 'ok', state: 'known', live: 0, newestAgeSec: null,
      source: 'coordination-ledger', asOf: NOW_ISO });
  });

  it('READY with the real count and newest age for a valid nonempty list', async () => {
    const check = await readFleetBridgeCheck(deps(() => projection([
      claimRow({ id: 'fake-claim-new', claimedAt: '2026-11-14T23:59:00.000Z' }),
      claimRow({ id: 'fake-claim-old', claimedAt: '2026-11-14T23:50:00.000Z' }),
    ])));
    expect(check.verdict).toBe('READY');
    expect(check.missing).toEqual([]);
    expect(check.claims).toMatchObject({ status: 'ok', state: 'known', live: 2, newestAgeSec: 60 });
  });

  it('tolerates extra fields on an otherwise producer-shaped row', async () => {
    const check = await readFleetBridgeCheck(deps(() => projection([
      claimRow({ futureField: 'x', another: 7 }),
    ])));
    expect(check.verdict).toBe('READY');
    expect(check.claims).toMatchObject({ status: 'ok', state: 'known', live: 1, newestAgeSec: 60 });
  });

  it('keeps the producer reason when the ledger state itself is unknown', async () => {
    const check = await readFleetBridgeCheck(deps(() => projection([], {
      state: 'unknown', reason: 'coordination ledger: reader failed',
    })));
    expect(check.verdict).toBe('BLOCKED');
    expect(check.missing).toEqual(['claims']);
    expect(check.claims).toMatchObject({ status: 'unavailable', state: 'unknown', live: null,
      newestAgeSec: null, reason: 'coordination ledger: reader failed' });
  });

  it('reports a claims reader that returns a non-record as failed, not empty', async () => {
    for (const value of [null, [claimRow()], 'ledger-text', 7] as const) {
      const check = await readFleetBridgeCheck(deps(() => value));
      expect(check.verdict).toBe('BLOCKED');
      expect(check.missing).toEqual(['claims']);
      expect(check.claims).toMatchObject({ status: 'unavailable', state: 'unknown', live: null,
        newestAgeSec: null, reason: 'claims-reader-failed' });
    }
  });

  it('BLOCKED with claims unreadable when a known projection has no real claims array', async () => {
    for (const list of [undefined, null, { bogus: MARKER }, `claims-${MARKER}`, 3, true] as const) {
      const check = await readFleetBridgeCheck(deps(() => projection(list)));
      expect(check.verdict).toBe('BLOCKED');
      expect(check.missing).toEqual(['claims']);
      expect(check.claims).toMatchObject({ status: 'unavailable', state: 'unknown', live: null,
        newestAgeSec: null, reason: 'claims-list-unreadable' });
      expect(check.runtime.status).toBe('ok');
      expect(check.peers.status).toBe('ok');
      expect(JSON.stringify(check)).not.toContain(MARKER);
    }
  });

  it('BLOCKED when a known projection carries malformed claim rows', async () => {
    const missingAgent = claimRow();
    delete missingAgent['agent'];
    for (const list of [
      [null],
      [`row-${MARKER}`],
      [{}],
      [claimRow({ claimedAt: 1_763_000_000 })],
      [claimRow({ claimedAt: `not-a-date-${MARKER}` })],
      [claimRow({ claimedAt: 'unknown' })],
      [missingAgent],
      [claimRow({ expiresInSeconds: 'soon' })],
      [claimRow(), null],
      [claimRow(), claimRow({ repo: 42 })],
    ] as const) {
      const check = await readFleetBridgeCheck(deps(() => projection(list)));
      expect(check.verdict).toBe('BLOCKED');
      expect(check.missing).toEqual(['claims']);
      expect(check.claims).toMatchObject({ status: 'unavailable', state: 'unknown', live: null,
        newestAgeSec: null, reason: 'claims-list-unreadable' });
      expect(check.runtime.status).toBe('ok');
      expect(check.peers.status).toBe('ok');
      expect(JSON.stringify(check)).not.toContain(MARKER);
    }
  });

  it('never echoes the projection reason or rejected row text on malformed claims', async () => {
    const check = await readFleetBridgeCheck(deps(() => projection(
      [claimRow({ claimedAt: `leak-${MARKER}` })],
      { reason: `producer-detail-${MARKER}` },
    )));
    expect(check.verdict).toBe('BLOCKED');
    expect(check.claims).toMatchObject({ status: 'unavailable', state: 'unknown', live: null,
      newestAgeSec: null, reason: 'claims-list-unreadable',
      source: 'coordination-ledger', asOf: NOW_ISO });
    expect(JSON.stringify(check)).not.toContain(MARKER);
  });

  it('recovers to READY on the same reader after a malformed response', async () => {
    const responses = [projection({ bogus: MARKER }), projection([claimRow()])];
    let index = 0;
    const claims = () => responses[Math.min(index++, responses.length - 1)];
    const first = await readFleetBridgeCheck(deps(claims));
    expect(first.verdict).toBe('BLOCKED');
    expect(first.missing).toEqual(['claims']);
    expect(first.claims).toMatchObject({ status: 'unavailable', state: 'unknown', live: null });
    const second = await readFleetBridgeCheck(deps(claims));
    expect(second.verdict).toBe('READY');
    expect(second.missing).toEqual([]);
    expect(second.claims).toMatchObject({ status: 'ok', state: 'known', live: 1, newestAgeSec: 60 });
  });
});
