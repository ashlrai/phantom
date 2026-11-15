/** Read-only live-runtime reachability verdict for the isolated fleet MCP server. */
import { readFleetBoard, type FleetBoard } from '../core/fleet/coordination.js';
import { projectCoordinationClaims } from '../core/fleet/coordination-claims-view.js';
import { STALE_AFTER_SECONDS } from '../core/fleet/runtime-identity.js';
import { readFleetPeerLedger } from './fleet-peer-ledger.js';
import { readFleetRuntime } from './fleet-runtime.js';

export const NOTE = 'One-call verdict on whether a cloud agent can reach the live Phantom runtime on this computer: READY only when the runtime snapshot, the coordination claims ledger and the peer ledger all read cleanly — the same evidence as fleet_runtime, fleet_coordination_claims and fleet_peer_ledger joined into one answer. BLOCKED names each missing part in missing[]; each reader has a finite deadline and a reader that fails or stalls marks only its own section unavailable, so the call itself never throws, and explicitly unknown, malformed or negative-age producer evidence is treated the same way — an age alone never makes unknown runtime or peer state healthy. runtime carries the snapshot fields with fleet-state freshness checked against the same 15-minute staleness bound as runtime-identity; claims carries the live count and the newest claim age; peers carries the sanitized peer-bus budget. Evidence only; it grants no dispatch, claim, send or merge authority and a READY is reachability, not work. Takes no arguments: no caller root, path or cwd is accepted, and the tool never writes anything.';

// Shared per-reader deadline, comfortably inside the 8 s HTTP envelope
// (BRIDGE_CHECK_TIMEOUT_MS in core/verse/fleet-bridge-check-api.ts) so direct
// MCP/CLI callers also finish in finite time when one evidence reader stalls.
// Same bound as the claim-execution read deadline. The race stops waiting for
// a stalled read; it does not cancel the underlying I/O.
export const BRIDGE_CHECK_READER_DEADLINE_MS = 5_000;

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
  /** Per-reader deadline in ms; defaults to BRIDGE_CHECK_READER_DEADLINE_MS. */
  deadlineMs?: number;
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

/** Small future-clock allowance for a claim timestamp, matching the 5 s
 * future-skew bound other local evidence readers use. A claimedAt beyond it is
 * contradictory evidence — never a fresh zero-age live claim. */
const CLAIM_MAX_FUTURE_SKEW_MS = 5_000;

/** A claim row in the shape projectCoordinationClaims emits: the producer's
 * string identity and timestamp fields plus the expiresInSeconds count. Both
 * timestamps must parse, expiry must fall after the claim (the ledger's own
 * ordering invariant) and claimedAt cannot sit materially in the future;
 * expiresInSeconds is the producer's rounded remaining TTL, never negative for
 * a live row. One malformed or temporally impossible row makes the whole list
 * unreadable — the check never reports a smaller live count filtered out of
 * bad evidence. */
function isProducerClaimRow(value: unknown, nowMs: number): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  for (const key of ['id', 'repo', 'task', 'agent', 'expiresAt'] as const) {
    if (typeof value[key] !== 'string') return false;
  }
  const claimedAt = value['claimedAt'];
  const expiresInSeconds = value['expiresInSeconds'];
  if (typeof claimedAt !== 'string' || typeof expiresInSeconds !== 'number'
    || !Number.isFinite(expiresInSeconds) || expiresInSeconds < 0) return false;
  const claimedAtMs = Date.parse(claimedAt);
  const expiresAtMs = Date.parse(value['expiresAt'] as string);
  return Number.isFinite(claimedAtMs) && Number.isFinite(expiresAtMs)
    && expiresAtMs > claimedAtMs
    && claimedAtMs <= nowMs + CLAIM_MAX_FUTURE_SKEW_MS;
}

/** Terminal statuses the producers use for evidence that was actually read.
 * Anything else — 'unavailable', 'unknown', or an unrecognized string — is
 * unknown evidence and can never earn a READY on its own. */
const READABLE_STATUSES: ReadonlySet<string> = new Set(['ok', 'empty']);

type AttemptResult<T> = { ok: true; value: T } | { ok: false; timedOut: boolean };

/** One read behind its own finite deadline; a throw, rejection or stall is a
 * missing part, never a thrown verdict. Handlers stay attached after the
 * deadline wins, so a late rejection is consumed and can never surface as an
 * unhandled rejection; the deadline does not cancel the underlying read. */
async function attempt<T>(read: () => T | Promise<T>, deadlineMs: number): Promise<AttemptResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      Promise.resolve().then(read).then(
        (value): { kind: 'ok'; value: T } => ({ kind: 'ok', value }),
        (): { kind: 'failed' } => ({ kind: 'failed' }),
      ),
      new Promise<{ kind: 'timeout' }>(resolve => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), deadlineMs);
        timer.unref?.();
      }),
    ]);
    if (outcome.kind === 'timeout') return { ok: false, timedOut: true };
    return outcome.kind === 'ok' ? { ok: true, value: outcome.value } : { ok: false, timedOut: false };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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

  const deadlineMs = deps.deadlineMs ?? BRIDGE_CHECK_READER_DEADLINE_MS;
  const [runtime, claims, peers] = await Promise.all([
    attempt(deps.runtime ?? (() => readFleetRuntime()), deadlineMs),
    attempt(readClaims, deadlineMs),
    attempt(deps.peers ?? (() => readFleetPeerLedger({})), deadlineMs),
  ]);

  let runtimeSection: FleetBridgeCheck['runtime'];
  if (runtime.ok && isRecord(runtime.value)) {
    const snapshot = { ...runtime.value };
    delete snapshot['note'];
    const fleetState = isRecord(snapshot['lastFleetStateRead']) ? snapshot['lastFleetStateRead'] : undefined;
    const ageSeconds = fleetState?.['ageSeconds'];
    // An explicit producer status is evidence: only a readable terminal status
    // stays healthy. Absent status keeps the historical 'ok' (the snapshot
    // contract carries none); a non-string status is malformed.
    const rawStatus = snapshot['status'];
    const status = typeof rawStatus === 'string' ? rawStatus : rawStatus === undefined ? 'ok' : 'unavailable';
    runtimeSection = {
      ...snapshot,
      status,
      source: 'fleet-runtime',
      asOf: typeof snapshot['asOf'] === 'string' ? snapshot['asOf'] : asOf,
    };
    // Age must be a finite, nonnegative number: 'UNKNOWN', NaN, Infinity and
    // negative values are all unreadable evidence, and a negative age can never
    // be fresh no matter how small its magnitude.
    if (typeof ageSeconds !== 'number' || !Number.isFinite(ageSeconds) || ageSeconds < 0) {
      missing.push('runtime.fleet-state');
      runtimeSection['reason'] = 'fleet-state-unreadable';
    } else if (ageSeconds > STALE_AFTER_SECONDS) {
      missing.push('runtime.fleet-state-stale');
      runtimeSection['reason'] = 'fleet-state-stale';
    }
    // Sub-evidence the snapshot carries explicitly: a present-but-unknown
    // coordination or execution state is unknown runtime evidence. Absent
    // sub-objects stay tolerated for minimal producer-shaped reports.
    for (const [key, missingKey, reason] of [
      ['coordination', 'runtime.coordination', 'runtime-coordination-unknown'],
      ['execution', 'runtime.execution', 'runtime-execution-unknown'],
    ] as const) {
      const sub = snapshot[key];
      if (sub === undefined) continue;
      if (!isRecord(sub) || sub['state'] !== 'known') {
        missing.push(missingKey);
        if (runtimeSection['reason'] === undefined) runtimeSection['reason'] = reason;
      }
    }
    if (!READABLE_STATUSES.has(status)) {
      missing.push('runtime');
      if (runtimeSection['reason'] === undefined) runtimeSection['reason'] = 'runtime-status-unreadable';
    }
  } else {
    runtimeSection = { status: 'unavailable',
      reason: !runtime.ok && runtime.timedOut ? 'runtime-reader-timeout' : 'runtime-reader-failed',
      source: 'fleet-runtime', asOf };
    missing.push('runtime');
  }

  let claimsSection: FleetBridgeCheck['claims'];
  if (claims.ok && isRecord(claims.value)) {
    const projection = claims.value;
    const state = typeof projection['state'] === 'string' ? projection['state'] : 'unknown';
    // A 'known' projection earns trust only from an actual claims array of
    // producer-shaped rows; a missing, non-array or partly malformed list is
    // unreadable evidence — never an empty ledger or a filtered live count.
    const rawClaims = projection['claims'];
    const list = Array.isArray(rawClaims) && rawClaims.every(row => isProducerClaimRow(row, nowMs))
      ? (rawClaims as Record<string, unknown>[])
      : null;
    const base = {
      source: typeof projection['source'] === 'string' ? projection['source'] : 'coordination-ledger',
      asOf: typeof projection['asOf'] === 'string' ? projection['asOf'] : asOf,
    };
    if (state !== 'known' || list === null) {
      claimsSection = {
        ...base, status: 'unavailable', state: state === 'known' ? 'unknown' : state,
        live: null, newestAgeSec: null,
        ...(state === 'known' ? { reason: 'claims-list-unreadable' }
          : typeof projection['reason'] === 'string' ? { reason: projection['reason'] } : {}),
      };
      missing.push('claims');
    } else {
      const newest = list.length === 0 ? Number.NEGATIVE_INFINITY
        : Math.max(...list.map(claim => Date.parse(claim['claimedAt'] as string)));
      claimsSection = {
        ...base, status: 'ok', state, live: list.length,
        newestAgeSec: Number.isFinite(newest)
          ? Math.max(0, Math.floor((nowMs - newest) / 1000))
          : null,
        ...(typeof projection['reason'] === 'string' ? { reason: projection['reason'] } : {}),
      };
    }
  } else {
    claimsSection = { status: 'unavailable', state: 'unknown', live: null, newestAgeSec: null,
      reason: !claims.ok && claims.timedOut ? 'claims-reader-timeout' : 'claims-reader-failed',
      source: 'coordination-ledger', asOf };
    missing.push('claims');
  }

  let peersSection: FleetBridgeCheck['peers'];
  if (peers.ok && isRecord(peers.value)) {
    const report = { ...peers.value };
    delete report['note'];
    // Only the producer's readable terminal statuses ('ok', 'empty') are
    // healthy; 'unavailable' and every other value — including 'unknown' or an
    // unrecognized string — is unknown evidence and blocks the verdict.
    const rawStatus = report['status'];
    const status = typeof rawStatus === 'string' ? rawStatus : 'unavailable';
    peersSection = {
      ...report,
      status,
      source: 'peer-ledger',
      asOf: typeof report['asOf'] === 'string' ? report['asOf'] : asOf,
    };
    if (!READABLE_STATUSES.has(status)) {
      missing.push('peers');
      const malformed = typeof rawStatus !== 'string' || status !== 'unavailable';
      if (malformed && peersSection['reason'] === undefined) peersSection['reason'] = 'peer-status-unreadable';
    }
  } else {
    peersSection = { status: 'unavailable',
      reason: !peers.ok && peers.timedOut ? 'peers-reader-timeout' : 'peers-reader-failed',
      source: 'peer-ledger', asOf };
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
