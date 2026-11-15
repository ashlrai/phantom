/**
 * core/fleet/claim-store-drift.ts: one read-only verdict comparing the two
 * stores a bus work claim is written to. mutateBusWorkClaim writes the bus
 * claims table (`<root>/bus-work-claims/claims.json`) and the coordination
 * table (`<root>/coordination/claims.json`, origin 'message', key
 * `queue:<id>`, sourceId `<id>:<cursor>:<receivedAt>`) one after the other,
 * so a crash or a settle failure between the writes can leave them
 * disagreeing: a work-board owner can be shown for a lease the coordination
 * table no longer holds, or the reverse. Nothing reports that today.
 *
 * The comparison covers only live rows: uncompleted bus rows whose lease is
 * still running (`completedAt === null && now < leaseUntil`) against live
 * coordination rows with origin 'message' and a `queue:` key. A pair joins
 * only when BOTH the coordination sourceId equals
 * `<id>:<cursor>:<receivedAt>` AND its key equals `queue:<id>`; a joined pair
 * whose owners differ is ownerMismatch, not a match. Completed or expired
 * bus rows and non-message or non-queue coordination rows are out of scope.
 *
 * Every reader is injectable (defaults come from the modules themselves); a
 * reader that throws or returns a malformed result marks only its own source
 * 'unavailable' and the verdict UNKNOWN, naming the source in missing[].
 * DRIFT wins over VERIFIED only when a source read is usable. Fencing tokens
 * never leave the store modules and are never part of a Row. Pure read: no
 * lock, no write, no network, never throws, grants no authority.
 */
import {
  inspectBusWorkClaims,
  type BusWorkClaimsInspection,
  type BusWorkClaimView,
} from './bus-work-claims.js';
import {
  listCoordination,
  type CoordinationView,
} from '../agents/claim-store.js';

export const CLAIM_DRIFT_SCHEMA = 'fleet.claim-drift.v1';
const QUEUE_PREFIX = 'queue:';

export type ClaimDriftSource = 'missing' | 'available' | 'unavailable';
export type ClaimDriftState = 'VERIFIED' | 'DRIFT' | 'UNKNOWN';

export interface ClaimDriftRow {
  id: string;
  cursor: number;
  /** ISO-8601 receipt timestamp carried by the sourceId triple. */
  receivedAt: string;
  owner: string;
  /** ISO-8601 lease expiry. */
  leaseUntil: string;
  /** ownerMismatch rows: the owner observed in the bus table. */
  busOwner?: string;
  /** ownerMismatch rows: the owner observed in the coordination table. */
  coordOwner?: string;
  /** coordOnly rows: the coordination sourceId as stored (join evidence). */
  sourceId?: string;
}

export interface ClaimStoreDrift {
  schema: typeof CLAIM_DRIFT_SCHEMA;
  /** ISO-8601 verdict clock. */
  asOf: string;
  bus: ClaimDriftSource;
  coordination: ClaimDriftSource;
  /** Joined pairs whose owners agree. */
  matched: number;
  busOnly: ClaimDriftRow[];
  coordOnly: ClaimDriftRow[];
  ownerMismatch: ClaimDriftRow[];
  state: ClaimDriftState;
  /** Sources that read 'unavailable' ('bus', 'coordination'). */
  missing: string[];
}

export interface ClaimDriftDeps {
  root?: string;
  now?: number;
  inspectBus?: typeof inspectBusWorkClaims;
  listCoord?: typeof listCoordination;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Store rows are already validated labels/integers; the guards keep an
 * injected or future-schema row from ever throwing inside the report. */
const iso = (n: unknown): string =>
  new Date(finite(n) && n >= 0 && n <= 8_640_000_000_000_000 ? n : 0).toISOString();

const text = (s: unknown): string => (typeof s === 'string' ? s : '');

function busRow(row: BusWorkClaimView): ClaimDriftRow {
  return {
    id: text(row.id), cursor: finite(row.cursor) ? row.cursor : 0,
    receivedAt: iso(row.receivedAt), owner: text(row.owner), leaseUntil: iso(row.leaseUntil),
  };
}

/** Recover the bus coordinates of an orphaned coordination row: id from the
 * `queue:` key, cursor and receivedAt from the `<id>:<n>:<n>` sourceId tail.
 * An id may itself contain ':', so the tail is split only after the known
 * `<id>:` prefix; an unparseable tail is reported as 0/epoch with the raw
 * sourceId kept on the row for evidence. */
function coordRow(row: CoordinationView): ClaimDriftRow {
  const id = text(row.key).slice(QUEUE_PREFIX.length);
  const sourceId = text(row.sourceId);
  let cursor = 0, receivedAt = iso(0);
  const prefix = `${id}:`;
  const tail = sourceId.startsWith(prefix) ? sourceId.slice(prefix.length).split(':') : [];
  if (tail.length === 2 && tail.every(part => /^\d+$/.test(part))) {
    const [c, r] = tail.map(Number);
    if (Number.isSafeInteger(c) && Number.isSafeInteger(r)) {
      cursor = c;
      receivedAt = iso(r);
    }
  }
  return {
    id, cursor, receivedAt, owner: text(row.owner), leaseUntil: iso(row.leaseUntil), sourceId,
  };
}

function liveBus(row: BusWorkClaimView, now: number): boolean {
  return row.completedAt === null && now < row.leaseUntil;
}

function liveCoordination(row: CoordinationView): boolean {
  return row.live === true && row.origin === 'message' && text(row.key).startsWith(QUEUE_PREFIX);
}

function sourceOf(inspection: { source?: unknown; claims?: unknown } | undefined): ClaimDriftSource {
  const source = inspection?.source;
  return source === 'missing' || source === 'available' || source === 'unavailable' ? source : 'unavailable';
}

export function readClaimStoreDrift(opts: ClaimDriftDeps = {}): ClaimStoreDrift {
  const now = finite(opts.now) ? (opts.now as number) : Date.now();
  let bus: BusWorkClaimsInspection = { source: 'unavailable', claims: [] };
  let coord: { source?: unknown; claims?: CoordinationView[] } = { source: 'unavailable', claims: [] };
  try {
    bus = (opts.inspectBus ?? inspectBusWorkClaims)(opts.root) ?? bus;
  } catch { /* an unreadable table is reported, never thrown */ }
  try {
    coord = (opts.listCoord ?? listCoordination)(opts.root, now) ?? coord;
  } catch { /* same: a throwing reader degrades only its own source */ }

  const busSource = sourceOf(bus);
  const coordSource = sourceOf(coord);
  const missing: string[] = [];
  if (busSource === 'unavailable') missing.push('bus');
  if (coordSource === 'unavailable') missing.push('coordination');

  const matchedCoord = new Set<CoordinationView>();
  const matchedRows: [BusWorkClaimView, CoordinationView][] = [];
  const busOnly: ClaimDriftRow[] = [];
  if (busSource === 'available' && coordSource !== 'unavailable') {
    const coordination = (Array.isArray(coord.claims) ? coord.claims : []).filter(liveCoordination);
    for (const row of (Array.isArray(bus.claims) ? bus.claims : []).filter(r => liveBus(r, now))) {
      const sourceId = `${text(row.id)}:${row.cursor}:${row.receivedAt}`;
      const partner = coordination.find(c =>
        !matchedCoord.has(c) && c.sourceId === sourceId && c.key === `${QUEUE_PREFIX}${text(row.id)}`);
      if (partner === undefined) busOnly.push(busRow(row));
      else { matchedCoord.add(partner); matchedRows.push([row, partner]); }
    }
  }
  const ownerMismatch: ClaimDriftRow[] = [];
  let matched = 0;
  for (const [busClaim, coordClaim] of matchedRows) {
    if (busClaim.owner === coordClaim.owner) { matched++; continue; }
    ownerMismatch.push({
      ...busRow(busClaim), busOwner: text(busClaim.owner), coordOwner: text(coordClaim.owner),
    });
  }
  const coordOnly: ClaimDriftRow[] = [];
  if (coordSource === 'available' && busSource !== 'unavailable') {
    for (const row of (Array.isArray(coord.claims) ? coord.claims : []).filter(liveCoordination)) {
      if (!matchedCoord.has(row)) coordOnly.push(coordRow(row));
    }
  }

  const state: ClaimDriftState = missing.length > 0 ? 'UNKNOWN'
    : busOnly.length + coordOnly.length + ownerMismatch.length > 0 ? 'DRIFT' : 'VERIFIED';
  return {
    schema: CLAIM_DRIFT_SCHEMA, asOf: iso(now), bus: busSource, coordination: coordSource,
    matched, busOnly, coordOnly, ownerMismatch, state, missing,
  };
}
