/**
 * fleet_reset_release_await — bounded wait for a recorded autobackoff release
 * on the isolated fleet MCP server. fleet_reset_await resolves on fresh reset
 * evidence; the release loop can still fail to act on that evidence, so a
 * supervisor that stopped there would resume work while the hold still stood.
 * This tool resolves 'recorded' only once the audit log proves the reset loop
 * recorded releasing the lane — proof of a completed past release, never a
 * verdict on present lane health or successful dispatch.
 *
 * There is deliberately no filesystem-root argument: the wait always runs at
 * the configured default root. The tool is read-only — it never probes a
 * provider, releases a hold or changes a lane.
 */
import { awaitResetRelease, type ResetReleaseAwaitResult } from '../core/fleet/reset-release-await.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export const MAX_FLEET_RESET_RELEASE_AWAIT_MS = 60_000;
export interface FleetResetReleaseAwaitArgs { lane: string; timeoutMs: number; pollMs?: number }

const AWAIT_KEYS = new Set(['lane', 'timeoutMs', 'pollMs']);

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Unknown keys
 * (including any root/path override), blank lanes and non-integer or
 * out-of-range millisecond bounds are rejected before the reader runs.
 */
export function parseFleetResetReleaseAwaitArgs(args: Record<string, unknown>): FleetResetReleaseAwaitArgs | null {
  const { lane, timeoutMs, pollMs } = args;
  if (Object.keys(args).some(key => !AWAIT_KEYS.has(key)) ||
      typeof lane !== 'string' || !lane.trim() ||
      typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_FLEET_RESET_RELEASE_AWAIT_MS ||
      (pollMs !== undefined && (typeof pollMs !== 'number' || !Number.isInteger(pollMs) || pollMs < 1 || pollMs > timeoutMs))) return null;
  return { lane, timeoutMs, ...(pollMs === undefined ? {} : { pollMs: pollMs as number }) };
}

/**
 * Only the waiter's public evidence fields cross the MCP boundary: outcome,
 * lane, check count and the matched release's timestamp/state. The audit
 * record's by/reason fields never forward, and absolute paths inside the lane
 * are redacted the same way the sibling reset tools redact them.
 */
export async function readFleetResetReleaseAwait(input: FleetResetReleaseAwaitArgs,
    read: typeof awaitResetRelease = awaitResetRelease): Promise<ResetReleaseAwaitResult> {
  const result = await read({ lane: input.lane, timeoutMs: input.timeoutMs, pollMs: input.pollMs ?? input.timeoutMs });
  const release = result.release;
  return sanitizePublicJson({
    v: result.v, authority: result.authority, outcome: result.outcome,
    lane: result.lane.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"']+/g, '[path]'), checks: result.checks,
    release: release === null ? null : { timestamp: release.timestamp, state: release.state },
  }) as ResetReleaseAwaitResult;
}
