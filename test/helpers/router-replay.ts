import { routeSeat, type RouteOptions } from '../../src/core/routing/router.js';
import type { SeatCapacity } from '../../src/core/routing/headroom.js';
import type { BudgetPolicy, RoutingRequest } from '../../src/core/routing/types.js';

export interface ReplayJob {
  id: string;
  snapshotId: string;
  request: RoutingRequest;
  actualLane: string | null;
  outcome: 'merged' | 'closed' | 'failed' | 'pending' | 'held';
  /** Total measured input and output tokens, including failed attempts. */
  tokens: number | null;
}

export interface ReplayStatus {
  schemaVersion: 1;
  snapshots: Record<string, {
    capacities: SeatCapacity[];
    policy: BudgetPolicy;
    options: RouteOptions;
  }>;
}

function metric(jobs: readonly ReplayJob[]) {
  // Pending work and unknown usage cannot support a completed-work ratio.
  const measured = jobs.filter(j => ['merged', 'closed', 'failed'].includes(j.outcome) && j.tokens !== null);
  const tokens = measured.reduce((sum, j) => sum + j.tokens!, 0);
  const merged = measured.filter(j => j.outcome === 'merged').length;
  return { jobs: measured.length, merged, tokens, mergedPrPerToken: tokens > 0 ? merged / tokens : null };
}

/** Offline evaluation only. Outcomes on a different lane are not counterfactual evidence. */
export function replayRouter(jobs: readonly ReplayJob[], status: ReplayStatus) {
  if (status.schemaVersion !== 1) throw new Error('Unsupported replay schema');
  const ids = new Set<string>();
  const decisions = jobs.map(job => {
    if (!job.id || ids.has(job.id)) throw new Error(`Duplicate or empty job id: ${job.id}`);
    ids.add(job.id);
    if (job.tokens !== null && (!Number.isSafeInteger(job.tokens) || job.tokens < 0)) {
      throw new Error(`Invalid token count: ${job.id}`);
    }
    const snapshot = Object.hasOwn(status.snapshots, job.snapshotId) ? status.snapshots[job.snapshotId] : undefined;
    if (!snapshot || !Number.isFinite(snapshot.options.nowMs)) throw new Error(`Invalid snapshot: ${job.id}`);
    const seatIds = snapshot.capacities.map(seat => seat.seatId);
    if (new Set(seatIds).size !== seatIds.length) throw new Error(`Duplicate seat: ${job.id}`);
    if (job.actualLane !== null && !seatIds.includes(job.actualLane)) throw new Error(`Unknown actual lane: ${job.id}`);
    if ((job.actualLane === null) !== (job.outcome === 'held') || (job.outcome === 'held' && job.tokens !== 0)) {
      throw new Error(`Inconsistent held outcome: ${job.id}`);
    }
    const decision = routeSeat(job.request, snapshot.capacities, snapshot.policy, snapshot.options);
    return { id: job.id, actualLane: job.actualLane, replayLane: decision.seatId, matches: decision.seatId === job.actualLane };
  });
  const matched = jobs.filter((_, i) => decisions[i]!.matches);
  return {
    decisions,
    matches: matched.length,
    mismatches: decisions.filter(d => !d.matches),
    actual: metric(jobs),
    matched: metric(matched),
    byActualLane: [...new Set(jobs.map(j => j.actualLane))].map(lane => ({
      lane, ...metric(jobs.filter(j => j.actualLane === lane)),
    })),
  };
}

export function formatReplaySummary(report: ReturnType<typeof replayRouter>): string {
  const ratio = (value: number | null) => value === null ? 'unknown' : value.toFixed(8);
  return [
    `Router replay: ${report.matches}/${report.decisions.length} lanes match; ${report.mismatches.length} mismatches.`,
    `Actual: ${report.actual.merged} merged PRs / ${report.actual.tokens} tokens; merged-PR-per-token=${ratio(report.actual.mergedPrPerToken)}.`,
    `Matched cohort: ${report.matched.merged} merged PRs / ${report.matched.tokens} tokens; merged-PR-per-token=${ratio(report.matched.mergedPrPerToken)}.`,
    'Changed lanes have unknown outcomes; no counterfactual yield is estimated.',
    ...report.mismatches.map(d => `${d.id}: actual=${d.actualLane ?? 'held'}, replay=${d.replayLane ?? 'held'}`),
  ].join('\n');
}
