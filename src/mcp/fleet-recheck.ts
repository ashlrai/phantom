/**
 * fleet_recheck — read-only projection of `ashlr fleet recheck` over the
 * isolated fleet MCP surface: the same readFleetRecheck() verdict joining
 * runtime identity, the claims ledger, channel health and the work board. It
 * never appends to the recheck log, never takes a lock and never writes: a
 * call only runs the bounded readers and sanitizes the result.
 *
 * fleet_recheck_history — read-only projection of
 * `ashlr fleet recheck-record --last`: the retained rows from
 * <ashlrHome>/fleet/recheck-log.jsonl, newest first, with skipped/malformed
 * counts and a missing flag. It only reads what `fleet recheck-record`
 * appended; it never records a row itself.
 */
import { ashlrHome } from '../core/cloud/store.js';
import { readFleetRecheck, type FleetRecheck } from '../core/fleet/fleet-recheck.js';
import { readRecheckRecords, type ReadRecords } from '../core/fleet/recheck-record.js';

/** `last` bounds for fleet_recheck_history, matching the CLI's --last N. */
export const MAX_FLEET_RECHECK_HISTORY = 50;
export const DEFAULT_FLEET_RECHECK_HISTORY = 5;

export interface FleetRecheckHistoryArgs {
  /** Newest rows to return, 1..50. */
  last: number;
}

/** The tool takes no arguments; anything else is rejected before a read. */
export function parseFleetRecheckArgs(args: Record<string, unknown> | undefined): Record<string, never> | null {
  return Object.keys(args ?? {}).length === 0 ? {} : null;
}

/** `last` is optional (default 5); unknown keys, nulls and out-of-range or
 * non-integer values are rejected before the log is touched. */
export function parseFleetRecheckHistoryArgs(args: Record<string, unknown> | undefined): FleetRecheckHistoryArgs | null {
  const a = args ?? {};
  const last = a['last'] ?? DEFAULT_FLEET_RECHECK_HISTORY;
  if (Object.keys(a).some(key => key !== 'last') ||
    a['last'] === null ||
    typeof last !== 'number' || !Number.isInteger(last) || last < 1 || last > MAX_FLEET_RECHECK_HISTORY) return null;
  return { last };
}

/** The same read-only verdict `ashlr fleet recheck` prints; no row is appended. */
export async function readFleetRecheckTool(): Promise<FleetRecheck> {
  return readFleetRecheck();
}

/** The same retained-row read `ashlr fleet recheck-record --last` performs:
 * root is ashlrHome(), rows come back newest first. */
export async function readFleetRecheckHistoryTool(input: FleetRecheckHistoryArgs): Promise<ReadRecords> {
  return readRecheckRecords(ashlrHome(), input.last);
}
