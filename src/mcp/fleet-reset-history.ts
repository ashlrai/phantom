/**
 * fleet_reset_history — recorded autobackoff release history for the isolated
 * fleet MCP server. Reuses the same bounded audit reader as
 * `phm fleet reset-history` and the /api/verse/ops/reset-releases projection —
 * never a second release path. Every record is a hold the reset loop already
 * recorded releasing: a completed past action, never a live lane-health or
 * launch-success verdict, and never evidence about what the detector sees now.
 *
 * The audit reader returns [] for unavailable sources, so an empty records
 * list proves only that no recorded releases were returned — it does not
 * prove the source is healthy, and this projection deliberately reports no
 * sourceState. Records are restricted to lane, at, state, usedPct,
 * readingAsOf and heldUntil; the audit's v/by/reason fields and any unknown
 * fields are not forwarded, and absolute paths are redacted the same way the
 * CLI redacts them.
 */
import { readResetReleases } from '../core/fleet/usage-reset-release.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export const MAX_FLEET_RESET_HISTORY = 200;
export const DEFAULT_FLEET_RESET_HISTORY = 20;

export interface FleetResetHistoryArgs {
  /** Newest-first record cap; the audit reader itself is bounded at 200. */
  limit: number;
  /** Exact case-sensitive lane filter, applied after the bounded read. */
  lane?: string;
}

export interface FleetResetHistoryDeps {
  read?: typeof readResetReleases;
}

export interface FleetResetHistoryRecord {
  lane: string | null;
  at: string | null;
  state: 'reset-detected' | 'reset-time-passed' | 'hold-expired';
  usedPct: number | null;
  readingAsOf: string | null;
  heldUntil: string | null;
}

export interface FleetResetHistoryV1 {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  note: string;
  records: FleetResetHistoryRecord[];
}

const NOTE = 'Recorded release history only: holds the reset loop recorded releasing, newest first. Never a live lane-health or launch-success verdict; an empty records list means no recorded releases were returned, not that the source is healthy.';

const HISTORY_KEYS = new Set(['limit', 'lane']);

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Unknown keys,
 * non-integer or out-of-range limits and non-string lanes are rejected before
 * the audit reader runs. There is deliberately no root/path argument — the
 * tool reads only the configured default root.
 */
export function parseFleetResetHistoryArgs(args: Record<string, unknown>): FleetResetHistoryArgs | null {
  const limit = args['limit'] ?? DEFAULT_FLEET_RESET_HISTORY, lane = args['lane'];
  if (Object.keys(args).some(key => !HISTORY_KEYS.has(key)) ||
    args['limit'] === null ||
    typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_FLEET_RESET_HISTORY ||
    lane !== undefined && typeof lane !== 'string') return null;
  return { limit, lane: lane as string | undefined };
}

/**
 * Newest-first audit page at the configured default root. A lane filter asks
 * the reader for its full 200-record bound, then exact-matches and applies
 * the caller's limit — the same filter-before-limit order the CLI uses, so a
 * filtered answer cannot be starved by newer records on other lanes.
 */
export async function readFleetResetHistory(input: FleetResetHistoryArgs, deps: FleetResetHistoryDeps = {}): Promise<FleetResetHistoryV1> {
  const read = deps.read ?? readResetReleases;
  const rows = await read(undefined, input.lane === undefined ? input.limit : MAX_FLEET_RESET_HISTORY);
  // Audit strings are untrusted: redact absolute paths even inside fields
  // normally expected to hold a lane name or timestamp (the CLI's rule).
  const clean = (value: string | null): string | null =>
    value?.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"']+/g, '[path]') ?? null;
  const records = rows
    .filter(row => input.lane === undefined || row.lane === input.lane)
    .slice(0, input.limit)
    .map(row => ({
      lane: clean(row.lane), at: clean(row.at), state: row.state, usedPct: row.usedPct,
      readingAsOf: clean(row.readingAsOf), heldUntil: clean(row.heldUntil),
    }));
  return sanitizePublicJson({
    schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
    generatedAt: new Date().toISOString(), note: NOTE, records,
  }) as FleetResetHistoryV1;
}
