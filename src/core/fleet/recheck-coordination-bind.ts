/**
 * core/fleet/recheck-coordination-bind.ts: the identity binding between a
 * work-board pick and the claim-store row its bus work claim wrote.
 *
 * When a worker acquires a bus work claim, bus-work-claims.ts calls
 * acquireCoordination() with origin 'message', key `queue:<id>`, the claim
 * owner and sourceId `<id>:<cursor>:<receivedAt>`; the work board reports the
 * same coordinates as claimReceipt `bus-claim:<id>:<cursor>:<receivedAt>`. The
 * two stores are written separately, so a row agreeing on origin, key, exact
 * receipt coordinates and owner, with a lease live at the verdict clock, is
 * genuine task identity. Nothing weaker binds: there is no owner-only match.
 *
 * Pure: no I/O, no clock reads; the caller supplies the coordination listing
 * and the captured verdict clock.
 */
import type { CoordinationView } from '../agents/claim-store.js';

export type CoordinationSource = 'missing' | 'available' | 'unavailable';

export interface RecheckPickIdentity { id: string; owner: string; claimReceipt: string }

export interface RecheckCoordinationListing { source: CoordinationSource; claims: CoordinationView[] }

export interface RecheckCoordinationClaim {
  key: string;
  sourceId: string;
  owner: string;
  /** ISO lease expiry of the bound claim-store row. */
  leaseUntil: string;
}

export interface RecheckCoordinationBinding {
  state: 'VERIFIED' | 'UNKNOWN';
  claim: RecheckCoordinationClaim | null;
  /** Exact reason the binding did not verify; null when VERIFIED. */
  reason: string | null;
}

const RECEIPT_PREFIX = 'bus-claim:';

const unknown = (reason: string): RecheckCoordinationBinding => ({ state: 'UNKNOWN', claim: null, reason });

export function bindPickToCoordination(
  pick: RecheckPickIdentity,
  coordination: RecheckCoordinationListing,
  nowMs: number,
): RecheckCoordinationBinding {
  if (coordination.source !== 'available') {
    return unknown(`task: coordination store ${coordination.source}, claim binding unverified`);
  }
  if (!Number.isFinite(nowMs)) return unknown('task: verdict clock unknown, claim binding unverified');
  if (!pick.claimReceipt.startsWith(`${RECEIPT_PREFIX}${pick.id}:`)) {
    return unknown(`task: claim receipt does not name board item ${pick.id}`);
  }
  const key = `queue:${pick.id}`;
  const sourceId = pick.claimReceipt.slice(RECEIPT_PREFIX.length);
  const rows = coordination.claims.filter(row => row.origin === 'message' && row.key === key && row.sourceId === sourceId);
  if (rows.length === 0) {
    return unknown(`task: no message-origin coordination claim ${key} with source ${sourceId}`);
  }
  // Liveness is judged here from leaseUntil against the captured clock; the
  // listing's `live` flag (state live) is required too but never sufficient.
  const liveAt = (row: CoordinationView): boolean =>
    row.live && Number.isFinite(new Date(row.leaseUntil).getTime()) && nowMs < row.leaseUntil;
  const owned = rows.filter(row => row.owner === pick.owner);
  if (owned.length === 0) {
    return unknown(`task: coordination claim ${key} owner differs from board owner ${pick.owner}`);
  }
  const bound = owned.find(liveAt);
  if (bound === undefined) return unknown(`task: coordination claim ${key} lease not live at verdict clock`);
  return {
    state: 'VERIFIED',
    claim: { key, sourceId, owner: bound.owner, leaseUntil: new Date(bound.leaseUntil).toISOString() },
    reason: null,
  };
}
