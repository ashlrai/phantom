/**
 * router-dataset.ts — fold the live fleet outcome projection into a
 * router-eval.v1 dataset (`phm eval dataset`).
 *
 * EVALHARNESS-1 (router-eval.ts) replays routing policies over frozen
 * router lines with known outcomes, but until now the only dataset was the
 * synthetic benchmark — the harness could never score a policy against what
 * the fleet actually did. This module closes that loop: it maps each
 * RouterOutcome row (src/core/router/outcomes.ts — the bounded,
 * unknown-preserving fold of jobs.jsonl, api-spend.jsonl,
 * work-market.jsonl, empty-tags.jsonl and merge-events.jsonl) onto one
 * dataset job line, so `phm eval router --dataset <out>` and
 * `phm eval prompts --dataset <out>` replay policies over real fleet
 * history.
 *
 * Outcome mapping (the dataset's terminal vocabulary is merged/closed/
 * failed/held/pending — the fleet fold keeps richer verdicts, so the map
 * is deliberately conservative):
 *
 *   - merged === true  -> 'merged'   (a recorded revert does not change
 *     the historical merge; durability is the eval-report's lane)
 *   - merged === false -> 'closed'   (explicit CLOSED/closed evidence)
 *   - merged === null, dispatched, explicit failure evidence
 *     (failure_class, nonzero exit_code, task_outcome 'failed', an empty
 *     finish, or a failed node-runner verdict) -> 'failed'
 *   - merged === null, dispatched, no failure evidence -> 'pending'
 *   - merged === null, no dispatch evidence -> 'held' (chosen=null)
 *
 * "Dispatched" means the retained rows carry positive evidence the job
 * was claimed, launched, ran or reached a PR — boundary stamps
 * (queue_wait_s/ci_wall_s/publish_wait_s), finish/usage fields, a
 * recorded claim override, a node-runner verdict, merge-queue friction,
 * CI/review verdicts, revert evidence, or a launch row's model. Market
 * decisions, lane hints, provider-wall/pool receipts and skip/defer/noop
 * verdicts are decision- or detection-time evidence and never count as
 * dispatch on their own. Anything ambiguous lands in 'pending' or
 * 'held' — both stay out of the terminal cohort — never a guessed
 * terminal state.
 *
 * Field mapping: id=job_id, repo/tier pass through, pool=the recorded
 * lane hint (market_preferred, then the claim's lane_hint — the
 * queue-assigned target strict-pool replays), chosen=the lane that ran
 * (lane, then the market's chosen lane; a dispatched outcome with no
 * recorded arm is dropped rather than invent one), candidates=only lanes
 * with positive evidence (the market's chosen lane and the lane that
 * ran — rejected lanes are not eligible evidence and the full eligible
 * set is not recorded), costUsd=cost_usd, tokens=tokens_total,
 * wallTimeMs=wall_s*1000. at/priority/task are not recorded by the
 * outcome fold and stay absent; counterfactual `arms` are never
 * fabricated — a changed decision replays as unobserved, exactly like a
 * benchmark line without an arms table. Unknown stays absent, never 0.
 */

import type { RouterOutcome } from '../router/outcomes.js';
import type { RouterEvalJob, RouterOutcome as EvalOutcome } from './router-eval.js';

/** One emitted dataset line: the router-eval.v1 job shape plus its schema tag. */
export interface RouterDatasetJobLine extends Omit<RouterEvalJob, 'arms'> {
  v: 1;
}

export interface RouterDatasetComputation {
  /** Job lines in job_id order — deterministic for a fixed outcome set. */
  jobs: RouterDatasetJobLine[];
  /** Outcome-class counts over emitted lines (held/pending stay non-terminal). */
  counts: Record<EvalOutcome, number>;
  /** Outcomes dropped because a dispatched verdict named no arm. */
  unattributed: number;
}

/** Evidence that the job was claimed, launched, ran or reached a PR. */
function hasDispatchEvidence(o: RouterOutcome): boolean {
  return o.queue_wait_s !== null || o.ci_wall_s !== null || o.publish_wait_s !== null
    || o.wall_s !== null || o.exit_code !== null || o.empty !== null
    || o.diff_files !== null || o.diff_lines !== null || o.tokens_total !== null
    || o.task_outcome !== null || o.empty_class !== null || o.empty_tag !== null
    || o.acus !== null || o.tokens_in !== null || o.tokens_out !== null
    || o.tokens_cache_read !== null || o.tokens_cache_write !== null
    || o.usage_source !== null || o.usage_missing !== null
    || o.failure_class !== null || o.lane_override !== null || o.node_outcome !== null
    || o.merge_queue !== null || o.ci_first_pass !== null || o.review_findings !== null
    || o.reverted === true
    // A launch row is the only jobs-ledger writer of `model`; an enqueue or
    // market decision never carries one, so a recorded model means the job
    // reached dispatch even when every other stamp is absent.
    || o.model !== null;
}

/** Recorded evidence the dispatched attempt failed to produce mergeable work. */
function hasFailureEvidence(o: RouterOutcome): boolean {
  return o.failure_class !== null
    || (o.exit_code !== null && o.exit_code !== 0)
    || o.task_outcome === 'failed'
    || o.empty === true
    || o.node_outcome === 'failed';
}

/**
 * Map one RouterOutcome onto a dataset job line, or null when the row
 * cannot be represented honestly — a dispatched/pending/terminal verdict
 * with no recorded arm has no `chosen` to name, and held is the only
 * outcome allowed a null arm.
 */
export function routerOutcomeToDatasetJob(o: RouterOutcome): RouterDatasetJobLine | null {
  let outcome: EvalOutcome;
  let chosen: string | null;
  if (o.merged === true) {
    outcome = 'merged';
    chosen = o.lane ?? o.market_lane;
  } else if (o.merged === false) {
    outcome = 'closed';
    chosen = o.lane ?? o.market_lane;
  } else if (hasDispatchEvidence(o)) {
    outcome = hasFailureEvidence(o) ? 'failed' : 'pending';
    chosen = o.lane ?? o.market_lane;
  } else {
    outcome = 'held';
    chosen = null;
  }
  if (outcome !== 'held' && chosen === null) return null;

  const candidates = [...new Set([o.market_lane, o.lane].filter((l): l is string => l !== null))];
  const pool = o.market_preferred ?? o.lane_hint;
  const line: RouterDatasetJobLine = {
    v: 1,
    id: o.job_id,
    candidates,
    chosen,
    outcome,
  };
  if (o.repo !== null) line.repo = o.repo;
  if (pool !== null) line.pool = pool;
  if (o.tier !== null) line.tier = o.tier;
  // The dataset parser rejects negative/fractional measures — a recorded
  // value outside the accepted shape stays absent rather than emitting a
  // line the harness cannot read.
  if (o.cost_usd !== null && Number.isFinite(o.cost_usd) && o.cost_usd >= 0) line.costUsd = o.cost_usd;
  if (o.tokens_total !== null && Number.isSafeInteger(o.tokens_total) && o.tokens_total >= 0) line.tokens = o.tokens_total;
  if (o.wall_s !== null && Number.isFinite(o.wall_s) && o.wall_s >= 0) line.wallTimeMs = Math.round(o.wall_s * 1000);
  return line;
}

/** Fold RouterOutcome rows into dataset job lines plus outcome counts. */
export function foldRouterEvalDataset(outcomes: readonly RouterOutcome[]): RouterDatasetComputation {
  const jobs: RouterDatasetJobLine[] = [];
  const counts: Record<EvalOutcome, number> = { merged: 0, closed: 0, failed: 0, held: 0, pending: 0 };
  let unattributed = 0;
  for (const o of [...outcomes].sort((a, b) => (a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : 0))) {
    const line = routerOutcomeToDatasetJob(o);
    if (line === null) { unattributed++; continue; }
    counts[line.outcome]++;
    jobs.push(line);
  }
  return { jobs, counts, unattributed };
}

const ROUTER_DATASET_SCHEMA_NOTE =
  'router-eval.v1 fold of live fleet ledgers (phm eval dataset); real outcomes only — no counterfactual arms, changed decisions replay unobserved';

/** Serialize the computation to dataset JSONL: one meta line, then job lines. */
export function routerEvalDatasetText(computation: RouterDatasetComputation, now: Date = new Date()): string {
  const meta = {
    v: 1,
    kind: 'meta',
    id: `fleet-router-eval-${now.toISOString().slice(0, 10)}`,
    day: now.toISOString().slice(0, 10),
    note: ROUTER_DATASET_SCHEMA_NOTE,
  };
  return [JSON.stringify(meta), ...computation.jobs.map((j) => JSON.stringify(j))].join('\n') + '\n';
}
