import { awaitResetEvidence, type ResetAwaitResult } from '../core/fleet/reset-evidence-await.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export const MAX_FLEET_RESET_AWAIT_MS = 60_000;
export interface FleetResetAwaitArgs { lane: string; timeoutMs: number; pollMs?: number }

export function parseFleetResetAwaitArgs(args: Record<string, unknown>): FleetResetAwaitArgs | null {
  const { lane, timeoutMs, pollMs } = args;
  if (Object.keys(args).some(key => !['lane', 'timeoutMs', 'pollMs'].includes(key)) ||
      typeof lane !== 'string' || !lane.trim() ||
      typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_FLEET_RESET_AWAIT_MS ||
      (pollMs !== undefined && (typeof pollMs !== 'number' || !Number.isInteger(pollMs) || pollMs < 1 || pollMs > timeoutMs))) return null;
  return { lane, timeoutMs, ...(pollMs === undefined ? {} : { pollMs: pollMs as number }) };
}

/** Only the awaiter's public evidence fields cross the MCP boundary. */
export async function readFleetResetAwait(input: FleetResetAwaitArgs, read: typeof awaitResetEvidence = awaitResetEvidence): Promise<ResetAwaitResult> {
  const result = await read({ ...input, pollMs: input.pollMs ?? input.timeoutMs });
  const evidence = result.evidence;
  return sanitizePublicJson({
    v: result.v, authority: result.authority, outcome: result.outcome,
    lane: result.lane.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"']+/g, '[path]'), checks: result.checks,
    evidence: evidence === null ? null : {
      sourceState: evidence.sourceState, state: evidence.state, heldBy: evidence.heldBy, readingAsOf: evidence.readingAsOf,
    },
  }) as ResetAwaitResult;
}
