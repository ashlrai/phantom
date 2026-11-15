/** RQ-PHX-CLAIMSTOREDRIFT332 — `readClaimStoreDrift` compares live bus work
 * claims with their dual-written coordination leases. Both readers are faked
 * here: nothing touches the real home, ledger, bus or network. Fixtures are
 * plainly fake (agent-alpha, fake-request-1); no fencing token ever leaves a
 * store, so the verdict must never contain a 64-hex string. */
import { describe, expect, it } from 'vitest';
import {
  CLAIM_DRIFT_SCHEMA,
  readClaimStoreDrift,
  type ClaimDriftDeps,
} from '../src/core/fleet/claim-store-drift.js';
import type { BusWorkClaimsInspection, BusWorkClaimView } from '../src/core/fleet/bus-work-claims.js';
import type { CoordinationView } from '../src/core/agents/claim-store.js';

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const RECV = NOW - 60_000;
const LEASE = NOW + 600_000;

function busView(over: Partial<BusWorkClaimView> = {}): BusWorkClaimView {
  return {
    id: 'fake-request-1', cursor: 7, receivedAt: RECV, owner: 'agent-alpha',
    leaseUntil: LEASE, completedAt: null, ...over,
  };
}

function coordView(over: Partial<CoordinationView> = {}): CoordinationView {
  return {
    origin: 'message', key: 'queue:fake-request-1', owner: 'agent-alpha',
    leaseUntil: LEASE, sourceId: `fake-request-1:7:${RECV}`, live: true,
    repo: null, branch: null, path: null, started: null, ...over,
  };
}

function deps(over: {
  bus?: BusWorkClaimsInspection;
  coord?: { source: 'missing' | 'available' | 'unavailable'; claims: CoordinationView[] };
} = {}): ClaimDriftDeps {
  return {
    now: NOW,
    inspectBus: () => over.bus ?? { source: 'available', claims: [] },
    listCoord: () => ({ ...(over.coord ?? { source: 'available', claims: [] }), statuses: [] }),
  };
}

describe('readClaimStoreDrift', () => {
  it('verifies a matched pair with the fleet.claim-drift.v1 schema', () => {
    const drift = readClaimStoreDrift(deps({
      bus: { source: 'available', claims: [busView()] },
      coord: { source: 'available', claims: [coordView()] },
    }));
    expect(drift).toMatchObject({
      schema: CLAIM_DRIFT_SCHEMA, asOf: NOW_ISO, bus: 'available', coordination: 'available',
      matched: 1, busOnly: [], coordOnly: [], ownerMismatch: [], state: 'VERIFIED', missing: [],
    });
  });

  it('verifies when both stores are missing', () => {
    const drift = readClaimStoreDrift(deps({
      bus: { source: 'missing', claims: [] },
      coord: { source: 'missing', claims: [] },
    }));
    expect(drift).toMatchObject({ state: 'VERIFIED', matched: 0, missing: [] });
  });

  it('reports a live bus row with no coordination row as busOnly DRIFT', () => {
    const drift = readClaimStoreDrift(deps({
      bus: { source: 'available', claims: [busView()] },
    }));
    expect(drift.state).toBe('DRIFT');
    expect(drift.busOnly).toEqual([{
      id: 'fake-request-1', cursor: 7, owner: 'agent-alpha',
      receivedAt: new Date(RECV).toISOString(), leaseUntil: new Date(LEASE).toISOString(),
    }]);
    expect(drift.coordOnly).toEqual([]);
    expect(drift.matched).toBe(0);
  });

  it('reports a live coordination row with no bus row as coordOnly DRIFT', () => {
    const drift = readClaimStoreDrift(deps({
      coord: { source: 'available', claims: [coordView()] },
    }));
    expect(drift.state).toBe('DRIFT');
    expect(drift.coordOnly).toEqual([{
      id: 'fake-request-1', cursor: 7, owner: 'agent-alpha',
      receivedAt: new Date(RECV).toISOString(), leaseUntil: new Date(LEASE).toISOString(),
      sourceId: `fake-request-1:7:${RECV}`,
    }]);
    expect(drift.busOnly).toEqual([]);
  });

  it('reports a joined pair with different owners as ownerMismatch, not a match', () => {
    const drift = readClaimStoreDrift(deps({
      bus: { source: 'available', claims: [busView()] },
      coord: { source: 'available', claims: [coordView({ owner: 'agent-beta' })] },
    }));
    expect(drift.state).toBe('DRIFT');
    expect(drift.matched).toBe(0);
    expect(drift.busOnly).toEqual([]);
    expect(drift.coordOnly).toEqual([]);
    expect(drift.ownerMismatch).toEqual([{
      id: 'fake-request-1', cursor: 7, owner: 'agent-alpha',
      busOwner: 'agent-alpha', coordOwner: 'agent-beta',
      receivedAt: new Date(RECV).toISOString(), leaseUntil: new Date(LEASE).toISOString(),
    }]);
  });

  it('does not join a coordination row whose key is not queue:<id>', () => {
    const drift = readClaimStoreDrift(deps({
      bus: { source: 'available', claims: [busView()] },
      coord: { source: 'available', claims: [coordView({ key: 'queue:fake-request-2' })] },
    }));
    expect(drift.state).toBe('DRIFT');
    expect(drift.busOnly).toHaveLength(1);
    expect(drift.coordOnly).toHaveLength(1);
    expect(drift.coordOnly[0]!.id).toBe('fake-request-2');
  });

  it('ignores completed and expired bus rows', () => {
    const drift = readClaimStoreDrift(deps({
      bus: {
        source: 'available',
        claims: [
          busView({ id: 'fake-done', completedAt: NOW - 1_000 }),
          busView({ id: 'fake-stale', leaseUntil: NOW - 1_000 }),
        ],
      },
    }));
    expect(drift).toMatchObject({ state: 'VERIFIED', busOnly: [], matched: 0 });
  });

  it('reports a live coordination row whose bus twin completed as coordOnly', () => {
    const drift = readClaimStoreDrift(deps({
      bus: { source: 'available', claims: [busView({ completedAt: NOW - 1_000 })] },
      coord: { source: 'available', claims: [coordView()] },
    }));
    expect(drift.state).toBe('DRIFT');
    expect(drift.busOnly).toEqual([]);
    expect(drift.coordOnly).toHaveLength(1);
  });

  it('ignores non-message origins, non-queue keys and dead coordination rows', () => {
    const drift = readClaimStoreDrift(deps({
      coord: {
        source: 'available',
        claims: [
          coordView({ origin: 'board' }),
          coordView({ origin: 'resource', key: 'repo:ashlrai/phantom', sourceId: 'fake-source' }),
          coordView({ live: false, leaseUntil: NOW - 1_000 }),
        ],
      },
    }));
    expect(drift).toMatchObject({ state: 'VERIFIED', matched: 0, coordOnly: [] });
  });

  it('marks UNKNOWN and names the source when a reader is unavailable', () => {
    const busDown = readClaimStoreDrift(deps({
      bus: { source: 'unavailable', claims: [] },
      coord: { source: 'available', claims: [coordView()] },
    }));
    expect(busDown).toMatchObject({ state: 'UNKNOWN', missing: ['bus'], busOnly: [], coordOnly: [] });

    const coordDown = readClaimStoreDrift(deps({
      bus: { source: 'available', claims: [busView()] },
      coord: { source: 'unavailable', claims: [] },
    }));
    expect(coordDown).toMatchObject({ state: 'UNKNOWN', missing: ['coordination'], busOnly: [], coordOnly: [] });

    const bothDown = readClaimStoreDrift({
      now: NOW,
      inspectBus: () => { throw new Error('bus exploded'); },
      listCoord: () => { throw new Error('coord exploded'); },
    });
    expect(bothDown).toMatchObject({ state: 'UNKNOWN', missing: ['bus', 'coordination'] });
  });

  it('emits no 64-hex token anywhere in the serialized verdict', () => {
    const drift = readClaimStoreDrift(deps({
      bus: { source: 'available', claims: [busView(), busView({ id: 'fake-request-2', cursor: 8 })] },
      coord: {
        source: 'available',
        claims: [coordView(), coordView({ key: 'queue:fake-request-3', sourceId: 'fake-request-3:9:1', owner: 'agent-beta' })],
      },
    }));
    expect(drift.state).toBe('DRIFT');
    expect(drift.busOnly).toHaveLength(1);
    expect(drift.coordOnly).toHaveLength(1);
    expect(JSON.stringify(drift)).not.toMatch(/[a-f0-9]{64}/);
  });
});
