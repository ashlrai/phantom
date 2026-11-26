/**
 * Lane outcome tallies for `phm node route` (RQ-NODE-AUTOSCALE-1).
 *
 * `planAutoscaleRoutes` scores placements by a learned per-provider merge
 * rate (`{provider: {attempts, merged}}`, provider == lane). Until now that
 * file was hand-maintained, so the learned-rate term silently fell back to
 * the 0.5 prior on every real fleet. This module derives the same document
 * from the recorded job ledger (`metrics/jobs.jsonl`) through the bounded
 * `readRouterOutcomes` fold, so route scoring consumes real merge evidence.
 *
 * Counting rule: one `router.outcome.v1` record is one job. An outcome counts
 * as an attempt only when its merge verdict is known (`merged` is true or
 * false — MERGED, or CLOSED/merged:false). `merged: null` means the job's
 * result is unknown (still running, aborted, or no outcome row), so it is
 * excluded from both sides rather than counted as a failed attempt. Standing
 * terminal no-ops are also excluded because the fleet retired them unrun. A merge
 * recorded as reverted (`reverted: true`) still counts as an attempt but not
 * as a held merge — the same rule `proposeRouterWeights` applies — so a lane
 * whose merges get reverted does not keep an inflated learned rate. A lane
 * with no known verdicts simply has no entry and keeps the router's prior.
 */
import {
  readRouterOutcomes,
  type RouterOutcome,
  type RouterOutcomeRead,
} from '../../router/outcomes.js';
import type { LaneOutcomes } from './autoscale-router.js';

export const ROUTE_OUTCOMES_SCHEMA = 'phantom.node-route-outcomes.v1';

export interface RouteLaneOutcomes {
  schema: typeof ROUTE_OUTCOMES_SCHEMA;
  /** Ledger read state; only 'read' carries trustworthy tallies. */
  state: RouterOutcomeRead['state'];
  /** True when the ledger exceeded the retained tail; tallies are a lower bound. */
  truncated: boolean;
  path: string;
  /** Per-lane {attempts, merged}; empty unless state === 'read'. Keys sorted. */
  outcomes: Record<string, LaneOutcomes>;
}

/** Pure fold: router.outcome.v1 records -> {lane: {attempts, merged}}. */
export function foldRouteLaneOutcomes(outcomes: readonly RouterOutcome[]): Record<string, LaneOutcomes> {
  const tally = new Map<string, { attempts: number; merged: number }>();
  for (const outcome of outcomes) {
    if (outcome.lane === null || outcome.merged === null || outcome.noop === true) continue;
    const row = tally.get(outcome.lane) ?? { attempts: 0, merged: 0 };
    row.attempts++;
    if (outcome.merged && outcome.reverted !== true) row.merged++;
    tally.set(outcome.lane, row);
  }
  const folded: Record<string, LaneOutcomes> = {};
  for (const lane of [...tally.keys()].sort()) folded[lane] = tally.get(lane)!;
  return folded;
}

/**
 * Reads `<runsDir>/metrics/jobs.jsonl` (default ASHLR_RUNS_DIR, then
 * ~/.ashlr-runs) and folds it into route lane outcomes. A missing ledger is
 * state 'missing' with empty tallies — an absent append-only journal means no
 * recorded outcomes, not an error; 'unreadable' and 'not-file' mean the
 * evidence exists but cannot be trusted and callers should refuse.
 */
export async function readRouteLaneOutcomes(opts: { runsDir?: string } = {}): Promise<RouteLaneOutcomes> {
  const read = await readRouterOutcomes(opts);
  return {
    schema: ROUTE_OUTCOMES_SCHEMA,
    state: read.state,
    truncated: read.truncated,
    path: read.path,
    outcomes: read.state === 'read' ? foldRouteLaneOutcomes(read.outcomes) : {},
  };
}
