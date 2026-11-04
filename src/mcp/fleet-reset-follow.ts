/**
 * fleet_reset_follow — collect newly recorded autobackoff releases across
 * lanes in one bounded call on the isolated fleet MCP server. It delegates
 * to the same bounded follower behind `phm fleet reset-follow`, collecting
 * each emitted public release (lane, at, state, usedPct, readingAsOf,
 * heldUntil — never the audit's by/reason fields) into a single response
 * with the terminal outcome, read count, delivered count and the
 * capped-source caveat. Collection stops at the record bound with outcome
 * 'limit', cancelling and disposing the follower; a reader failure reports
 * 'failed' without its message. Records are completed past releases —
 * never a live lane-health, capacity or launch-success verdict.
 *
 * There is deliberately no filesystem-root argument: the follow always runs
 * at the configured default root. The tool is read-only — it never probes a
 * provider, releases a hold or changes a lane.
 */
import {
  RESET_FOLLOW_SOURCE_LIMIT, followResetReleases,
  type ResetFollowRecord, type ResetFollowResult,
} from '../core/fleet/reset-history-follow.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export const MAX_FLEET_RESET_FOLLOW_MS = 60_000;
export const MAX_FLEET_RESET_FOLLOW_RECORDS = 200;
export interface FleetResetFollowArgs { timeoutMs: number; pollMs?: number; lane?: string; after?: string }
/** The emitted release fields, identical to the follower's public record minus its envelope. */
export type FleetResetFollowRelease = Omit<Extract<ResetFollowRecord, { type: 'release' }>, 'v' | 'type'>;
/** 'invalid' can never reach the boundary (arguments are validated first); 'limit' is wrapper-only. */
export type FleetResetFollowOutcome = 'deadline' | 'cancelled' | 'failed' | 'limit';
export interface FleetResetFollowResult {
  v: 1; authority: 'none'; outcome: FleetResetFollowOutcome;
  /** Audit reads the follower performed. */
  reads: number;
  /** Releases delivered in this response (bounded by MAX_FLEET_RESET_FOLLOW_RECORDS). */
  delivered: number;
  /** The exclusive lower-bound timestamp the follower actually applied. */
  watermark: string | null;
  /** The follower's own capped-source caveat. */
  sourceLimit: string;
  /** Set when a source read was still pending at the terminal stop. */
  inFlight?: true;
  note: string;
  records: FleetResetFollowRelease[];
}

const NOTE = 'Recorded release history only: holds the reset loop recorded releasing, oldest first. Never a live lane-health, capacity or launch-success verdict; an empty records list means no releases were emitted inside the call, not that the source is healthy.';

const FOLLOW_KEYS = new Set(['timeoutMs', 'pollMs', 'lane', 'after']);

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Unknown keys
 * (including any root/path override), nulls, blank lanes, unparsable
 * timestamps and non-integer or out-of-range millisecond bounds are rejected
 * before the follower runs.
 */
export function parseFleetResetFollowArgs(args: Record<string, unknown>): FleetResetFollowArgs | null {
  const { timeoutMs, pollMs, lane, after } = args;
  if (Object.keys(args).some(key => !FOLLOW_KEYS.has(key)) ||
      typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_FLEET_RESET_FOLLOW_MS ||
      (pollMs !== undefined && (typeof pollMs !== 'number' || !Number.isInteger(pollMs) || pollMs < 1 || pollMs > timeoutMs)) ||
      (lane !== undefined && (typeof lane !== 'string' || !lane.trim())) ||
      (after !== undefined && (typeof after !== 'string' || !Number.isFinite(Date.parse(after))))) return null;
  return { timeoutMs,
    ...(pollMs === undefined ? {} : { pollMs: pollMs as number }),
    ...(lane === undefined ? {} : { lane: lane as string }),
    ...(after === undefined ? {} : { after: after as string }) };
}

/**
 * One bounded follow at the configured default root. The wrapper owns an
 * AbortController only to stop the follower at the record bound — the
 * follower's own deadline, signal listeners and cleanup bound every other
 * exit — and forwards only its public record fields: never raw audit
 * reasons, source paths or the follower's error message.
 */
export async function readFleetResetFollow(input: FleetResetFollowArgs,
    follow: typeof followResetReleases = followResetReleases): Promise<FleetResetFollowResult> {
  const records: FleetResetFollowRelease[] = [];
  const controller = new AbortController();
  let limited = false, watermark: string | null = null, sourceLimit = RESET_FOLLOW_SOURCE_LIMIT;
  const emit = (record: ResetFollowRecord): void => {
    if (record.type === 'end') { watermark = record.watermark; sourceLimit = record.sourceLimit; return; }
    if (records.length >= MAX_FLEET_RESET_FOLLOW_RECORDS) { limited = true; controller.abort(); return; }
    const { lane, at, state, usedPct, readingAsOf, heldUntil } = record;
    records.push({ lane, at, state, usedPct, readingAsOf, heldUntil });
    if (records.length >= MAX_FLEET_RESET_FOLLOW_RECORDS) { limited = true; controller.abort(); }
  };
  const result: ResetFollowResult = await follow(
    { timeoutMs: input.timeoutMs, pollMs: input.pollMs ?? input.timeoutMs,
      lane: input.lane, after: input.after, signal: controller.signal },
    { emit });
  const outcome: FleetResetFollowOutcome =
    result.outcome === 'failed' || result.outcome === 'invalid' ? 'failed'
    : limited ? 'limit' : result.outcome;
  return sanitizePublicJson({
    v: 1, authority: 'none', outcome, reads: result.reads, delivered: records.length,
    watermark: watermark ?? (input.after === undefined ? null : new Date(Date.parse(input.after)).toISOString()),
    sourceLimit, ...(result.inFlight ? { inFlight: true as const } : {}), note: NOTE, records,
  }) as FleetResetFollowResult;
}
