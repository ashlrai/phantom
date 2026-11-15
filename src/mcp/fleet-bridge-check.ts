/** Read-only live-runtime reachability verdict for the isolated fleet MCP server. */
import { readFleetBoard, type FleetBoard } from '../core/fleet/coordination.js';
import { projectCoordinationClaims } from '../core/fleet/coordination-claims-view.js';
import { STALE_AFTER_SECONDS } from '../core/fleet/runtime-identity.js';
import { readFleetPeerLedger } from './fleet-peer-ledger.js';
import { readFleetRuntime } from './fleet-runtime.js';

export const NOTE = 'One-call verdict on whether a cloud agent can reach the live Phantom runtime on this computer: READY only when the runtime snapshot, the coordination claims ledger and the peer ledger all read cleanly — the same evidence as fleet_runtime, fleet_coordination_claims and fleet_peer_ledger joined into one answer. BLOCKED names each missing part in missing[]; a reader that fails marks only its own section unavailable, so the call itself never throws. runtime carries the snapshot fields with fleet-state freshness checked against the same 15-minute staleness bound as runtime-identity; claims carries the live count and the newest claim age; peers carries the sanitized peer-bus budget. Evidence only; it grants no dispatch, claim, send or merge authority and a READY is reachability, not work. Takes no arguments: no caller root, path or cwd is accepted, and the tool never writes anything.';

/** The tool takes no arguments; anything else is rejected before a read. */
export function parseFleetBridgeCheckArgs(args: Record<string, unknown> | undefined): Record<string, never> | null {
  return Object.keys(args ?? {}).length === 0 ? {} : null;
}

export interface FleetBridgeCheckDeps {
  /** Runtime snapshot reader; defaults to the fleet_runtime adapter. */
  runtime?: () => Promise<unknown>;
  /** Claims projection reader; defaults to the fleet_coordination_claims read. */
  claims?: () => unknown;
  /** Peer ledger reader; defaults to the aggregate fleet_peer_ledger read. */
  peers?: () => unknown;
  /** Verdict clock. */
  now?: () => number;
}

interface SectionBase {
  status: string;
  source: string;
  asOf: string;
  reason?: string;
}

export interface FleetBridgeCheck {
  verdict: 'READY' | 'BLOCKED';
  asOf: string;
  runtime: SectionBase & Record<string, unknown>;
  claims: SectionBase & { state: string; live: number | null; newestAgeSec: number | null };
  peers: SectionBase & Record<string, unknown>;
  missing: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One read behind its own boundary; a throw or rejection is a missing part, never a thrown verdict. */
async function attempt<T>(read: () => T | Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await read() };
  } catch {
    return { ok: false };
  }
}

/** Compose the same READY | BLOCKED answer the bridge check CLI prints: READY
 * only when every section read cleanly and the fleet state is fresh. Each
 * reader keeps its own deadline; a failed or stale part lands in missing[]
 * and only that section reports unavailable — the verdict never throws. */
export async function readFleetBridgeCheck(deps: FleetBridgeCheckDeps = {}): Promise<FleetBridgeCheck> {
  let nowMs: number;
  try {
    nowMs = (deps.now ?? Date.now)();
  } catch {
    nowMs = Date.now();
  }
  const asOf = new Date(nowMs).toISOString();
  const missing: string[] = [];

  const readClaims = deps.claims ?? (() => {
    let board: FleetBoard | null;
    try {
      board = readFleetBoard();
    } catch {
      board = null;
    }
    return projectCoordinationClaims(board, nowMs);
  });

  const [runtime, claims, peers] = await Promise.all([
    attempt(deps.runtime ?? (() => readFleetRuntime())),
    attempt(readClaims),
    attempt(deps.peers ?? (() => readFleetPeerLedger({}))),
  ]);

  let runtimeSection: FleetBridgeCheck['runtime'];
  if (runtime.ok && isRecord(runtime.value)) {
    const snapshot = { ...runtime.value };
    delete snapshot['note'];
    const ageSeconds = isRecord(snapshot['lastFleetStateRead']) ? snapshot['lastFleetStateRead']['ageSeconds'] : undefined;
    runtimeSection = {
      ...snapshot,
      status: 'ok',
      source: 'fleet-runtime',
      asOf: typeof snapshot['asOf'] === 'string' ? snapshot['asOf'] : asOf,
    };
    if (typeof ageSeconds !== 'number' || !Number.isFinite(ageSeconds)) {
      missing.push('runtime.fleet-state');
      runtimeSection['reason'] = 'fleet-state-unreadable';
    } else if (ageSeconds > STALE_AFTER_SECONDS) {
      missing.push('runtime.fleet-state-stale');
      runtimeSection['reason'] = 'fleet-state-stale';
    }
  } else {
    runtimeSection = { status: 'unavailable', reason: 'runtime-reader-failed', source: 'fleet-runtime', asOf };
    missing.push('runtime');
  }

  let claimsSection: FleetBridgeCheck['claims'];
  if (claims.ok && isRecord(claims.value)) {
    const projection = claims.value;
    const state = typeof projection['state'] === 'string' ? projection['state'] : 'unknown';
    const list = Array.isArray(projection['claims']) ? projection['claims'].filter(isRecord) : [];
    const newest = Math.max(...list.map(claim => Date.parse(typeof claim['claimedAt'] === 'string' ? claim['claimedAt'] : '')), Number.NEGATIVE_INFINITY);
    claimsSection = {
      status: state === 'known' ? 'ok' : 'unavailable',
      state,
      live: state === 'known' ? list.length : null,
      newestAgeSec: state === 'known' && Number.isFinite(newest)
        ? Math.max(0, Math.floor((nowMs - newest) / 1000))
        : null,
      source: typeof projection['source'] === 'string' ? projection['source'] : 'coordination-ledger',
      asOf: typeof projection['asOf'] === 'string' ? projection['asOf'] : asOf,
      ...(typeof projection['reason'] === 'string' ? { reason: projection['reason'] } : {}),
    };
    if (state !== 'known') missing.push('claims');
  } else {
    claimsSection = { status: 'unavailable', state: 'unknown', live: null, newestAgeSec: null,
      reason: 'claims-reader-failed', source: 'coordination-ledger', asOf };
    missing.push('claims');
  }

  let peersSection: FleetBridgeCheck['peers'];
  if (peers.ok && isRecord(peers.value)) {
    const report = { ...peers.value };
    delete report['note'];
    const status = typeof report['status'] === 'string' ? report['status'] : 'unavailable';
    peersSection = {
      ...report,
      status,
      source: 'peer-ledger',
      asOf: typeof report['asOf'] === 'string' ? report['asOf'] : asOf,
    };
    if (status === 'unavailable') missing.push('peers');
  } else {
    peersSection = { status: 'unavailable', reason: 'peers-reader-failed', source: 'peer-ledger', asOf };
    missing.push('peers');
  }

  return {
    verdict: missing.length === 0 ? 'READY' : 'BLOCKED',
    asOf,
    runtime: runtimeSection,
    claims: claimsSection,
    peers: peersSection,
    missing,
  };
}
