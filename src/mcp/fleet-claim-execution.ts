/** Claim execution evidence for the isolated read-only fleet MCP server. */
import {
  CLAIM_EXECUTION_SCHEMA,
  readClaimExecution,
  type ClaimExecutionDeps,
  type ClaimExecutionReport,
} from '../core/fleet/claim-execution-evidence.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const NOTE = "Read-only sanitized claim execution evidence: which live advisory claims have a matching worker process on this computer. RUNNING requires a matched worker; otherwise CLAIMED_NO_WORKER or UNKNOWN. Grants no dispatch, claim or merge authority. Accepts no arguments and never writes.";

// Same bound as the verse claim-execution API (FLEET_CLAIM_EXECUTION_READ_DEADLINE_MS):
// the evidence reader runs `ps` for the worker table, and a stalled host read
// must still produce a bounded answer. The race stops waiting for the read; it
// does not cancel it.
export const CLAIM_EXECUTION_READ_DEADLINE_MS = 5_000;
const READER_FAILED_REASON = 'claim execution: reader failed';
const READ_DEADLINE_REASON = 'claim execution: read deadline exceeded';

/** Reject every extra key before reading any host state. */
export function parseFleetClaimExecutionArgs(args: Record<string, unknown>): Record<string, never> | null {
  return Object.keys(args).length === 0 ? {} : null;
}

type ReadOutcome =
  | { kind: 'report'; report: ClaimExecutionReport }
  | { kind: 'rejected' }
  | { kind: 'timeout' };

/** Every field unavailable plus a fixed reason; never carries the thrown message. */
function unavailableReport(reason: string, asOf: string): ClaimExecutionReport {
  return {
    schema: CLAIM_EXECUTION_SCHEMA, authority: 'none', asOf,
    ledger: 'unavailable', processes: 'unavailable', rows: [],
    counts: { running: 0, claimedNoWorker: 0, unknown: 0 },
    reasons: [reason],
  };
}

/** Degraded-report stamp: the injected clock when it yields a valid instant, else the wall clock. */
function reportStamp(deps: ClaimExecutionDeps): string {
  try {
    const stamp = new Date((deps.now ?? Date.now)());
    if (!Number.isNaN(stamp.getTime())) return stamp.toISOString();
  } catch { /* a throwing clock degrades to the wall clock */ }
  return new Date().toISOString();
}

/**
 * One bounded claim-execution read. A read that never settles degrades to the
 * unavailable report with the deadline reason — never an invented RUNNING or
 * CLAIMED_NO_WORKER row — so an MCP client learns the evidence is missing
 * instead of waiting on the host process reader forever.
 */
export async function readFleetClaimExecution(
  deps: ClaimExecutionDeps = {},
  deadlineMs = CLAIM_EXECUTION_READ_DEADLINE_MS,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let outcome: ReadOutcome;
  try {
    outcome = await Promise.race<ReadOutcome>([
      // Handlers stay attached after the deadline wins, so a late rejection is
      // consumed and can never surface as an unhandled rejection or raw error.
      Promise.resolve().then(() => readClaimExecution(deps)).then(
        report => ({ kind: 'report' as const, report }),
        (): ReadOutcome => ({ kind: 'rejected' as const }),
      ),
      new Promise<ReadOutcome>(resolve => {
        timer = setTimeout(() => resolve({ kind: 'timeout' as const }), deadlineMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const report = outcome.kind === 'report'
    ? outcome.report
    : unavailableReport(
        outcome.kind === 'timeout' ? READ_DEADLINE_REASON : READER_FAILED_REASON,
        reportStamp(deps),
      );
  return sanitizePublicJson({ ...report, note: NOTE });
}
