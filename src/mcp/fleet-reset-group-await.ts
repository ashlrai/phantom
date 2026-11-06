import { awaitResetGroup, isResetGroupLaneList, type ResetGroupAwaitResult } from '../core/fleet/reset-group-await.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import { MAX_FLEET_RESET_AWAIT_MS } from './fleet-reset-await.js';

export interface FleetResetGroupAwaitArgs { lanes: string[]; timeoutMs: number; pollMs?: number }

export function parseFleetResetGroupAwaitArgs(args: Record<string, unknown>): FleetResetGroupAwaitArgs | null {
  const { lanes, timeoutMs, pollMs } = args;
  if (Object.keys(args).some(key => !['lanes', 'timeoutMs', 'pollMs'].includes(key)) ||
      !Array.isArray(lanes) || !lanes.every(lane => typeof lane === 'string') || !isResetGroupLaneList(lanes) ||
      typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_FLEET_RESET_AWAIT_MS ||
      (pollMs !== undefined && (typeof pollMs !== 'number' || !Number.isInteger(pollMs) || pollMs < 1 || pollMs > timeoutMs))) return null;
  return { lanes, timeoutMs, ...(pollMs === undefined ? {} : { pollMs: pollMs as number }) };
}

/** Project only public evidence before it crosses the MCP boundary. */
export async function readFleetResetGroupAwait(input: FleetResetGroupAwaitArgs, read: typeof awaitResetGroup = awaitResetGroup): Promise<ResetGroupAwaitResult> {
  const result = await read({ ...input, pollMs: input.pollMs ?? input.timeoutMs });
  const cleanLane = (lane: string): string => lane.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"']+/g, '[path]');
  return sanitizePublicJson({
    v: result.v, authority: result.authority, outcome: result.outcome, checks: result.checks,
    observed: result.observed.map(row => ({ lane: cleanLane(row.lane), state: row.state, heldBy: row.heldBy, readingAsOf: row.readingAsOf })),
    pending: result.pending.map(cleanLane),
  }) as ResetGroupAwaitResult;
}
