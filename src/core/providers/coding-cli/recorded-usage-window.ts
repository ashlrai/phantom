/**
 * Historical projection of one recorded usage window: a recorded snapshot plus
 * later recorded per-run usage, combined over a supplied reset schedule. Pure,
 * recorded input only (no clock, config, network or home reads).
 *
 * The result is a HISTORICAL CALCULATION. `remaining` is never current quota
 * evidence or a live allowance. A snapshot excluded from the window (expired,
 * future, or malformed as-of) does NOT prove zero current usage; it only means
 * this calculation did not count it.
 *
 * Recovered from PR #5952 (head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886),
 * scheduler/pools.ts projectUltra(). Behavior preserved: an elapsed reset
 * advances by whole periods (a reset exactly at `now` has elapsed); the
 * snapshot counts only when windowStart <= asOf < reset and asOf <= now;
 * events count when windowStart <= ts <= now and ts < reset, are skipped when
 * covered by a counted snapshot (ts <= asOf), and need a finite fraction > 0;
 * orchestrator and cloud-agent usage are summed separately (any other consumer
 * is cloud-agent, as in the source); total clamps to [0,1].
 *
 * Deliberate differences: an invalid `nowMs`, `resetAt` or `resetEveryMs`
 * throws RangeError (the source invented now + period for an unparsable reset);
 * a non-finite or negative snapshot fraction throws (source passed it through).
 */

export const RECORDED_USAGE_WINDOW_PROVENANCE = {
  sourcePr: 5952,
  sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
  basis: 'historical-offline',
} as const;

export type RecordedUsageConsumer = 'orchestrator' | 'cloud-agent';

export interface RecordedUsageEvent {
  /** ISO timestamp. Unparsable values are skipped. */
  ts: string;
  consumer: RecordedUsageConsumer;
  /** Fraction of the window. Non-finite or <= 0 values are skipped. */
  fraction: number;
}

export interface RecordedUsageWindowInput {
  /** Caller-supplied evaluation time (epoch ms). */
  nowMs: number;
  /** ISO time of one recorded reset boundary (any past or future one). */
  resetAt: string;
  /** Window length in ms; must be finite and > 0. */
  resetEveryMs: number;
  /** Recorded snapshot of unsplit usage; omit when none was recorded. */
  snapshot?: { usedFraction: number; asOf: string };
  events: readonly RecordedUsageEvent[];
}

export interface RecordedUsageWindowProjection {
  provenance: typeof RECORDED_USAGE_WINDOW_PROVENANCE;
  /** Historical calculation only; never current quota evidence. */
  remaining: number;
  usedFraction: number;
  /** Snapshot portion inside the window; not split by consumer. */
  unsplitUsedFraction: number;
  orchestrator: number;
  cloudAgent: number;
  windowStartMs: number;
  resetAtMs: number;
  snapshotCounted: boolean;
  currentAllowanceEvidence: false;
}

export function projectRecordedUsageWindow(input: RecordedUsageWindowInput): RecordedUsageWindowProjection {
  const { nowMs, resetEveryMs, snapshot, events } = input;
  if (!Number.isFinite(nowMs)) throw new RangeError('nowMs must be a finite number');
  if (!Number.isFinite(resetEveryMs) || resetEveryMs <= 0) throw new RangeError('resetEveryMs must be finite and > 0');
  let resetAtMs = Date.parse(input.resetAt);
  if (!Number.isFinite(resetAtMs)) throw new RangeError('resetAt must be a parsable timestamp');
  if (snapshot && (!Number.isFinite(snapshot.usedFraction) || snapshot.usedFraction < 0)) {
    throw new RangeError('snapshot.usedFraction must be finite and >= 0');
  }
  if (nowMs >= resetAtMs) resetAtMs += (Math.floor((nowMs - resetAtMs) / resetEveryMs) + 1) * resetEveryMs;
  const windowStartMs = resetAtMs - resetEveryMs;
  const asOf = snapshot ? Date.parse(snapshot.asOf) : Number.NaN;
  const snapshotCounted = Number.isFinite(asOf) && asOf >= windowStartMs && asOf < resetAtMs && asOf <= nowMs;
  const unsplit = snapshotCounted && snapshot ? snapshot.usedFraction : 0;
  let orchestrator = 0;
  let cloudAgent = 0;
  for (const event of events) {
    const ts = Date.parse(event.ts);
    if (!Number.isFinite(ts) || ts < windowStartMs || ts > nowMs || ts >= resetAtMs) continue;
    if (snapshotCounted && ts <= asOf) continue;
    if (!Number.isFinite(event.fraction) || event.fraction <= 0) continue;
    if (event.consumer === 'orchestrator') orchestrator += event.fraction;
    else cloudAgent += event.fraction;
  }
  const usedFraction = Math.min(1, Math.max(0, unsplit + orchestrator + cloudAgent));
  return {
    provenance: RECORDED_USAGE_WINDOW_PROVENANCE,
    remaining: Math.max(0, 1 - usedFraction),
    usedFraction,
    unsplitUsedFraction: unsplit,
    orchestrator,
    cloudAgent,
    windowStartMs,
    resetAtMs,
    snapshotCounted,
    currentAllowanceEvidence: false,
  };
}
