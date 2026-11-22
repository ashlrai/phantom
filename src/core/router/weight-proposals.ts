import { z } from 'zod';

import type { RouterOutcome, RouterOutcomeRead } from './outcomes.js';

// Advisory router-weight proposals from recorded outcomes. Recovered from the pure proposal slice of
// PR #6794 (head f9e484e87ec2d01f155cc280e818d2e98519dbe7, src/core/router/tune.ts). Math only: no I/O,
// no weights.json, no applyRouterWeights. Nothing here changes live routing, rank or admission.

export const ROUTER_WEIGHT_PROPOSAL_SOURCE = {
  pr: 6794,
  head_sha: 'f9e484e87ec2d01f155cc280e818d2e98519dbe7',
  recovered_from: 'src/core/router/tune.ts#proposeRouterWeights',
} as const;
export const ROUTER_WEIGHT_BASELINE = 0.5;
export const ROUTER_WEIGHT_DEFAULT_MIN_SAMPLES = 20;
export const ROUTER_WEIGHT_DEFAULT_MAX_SHIFT = 0.1;

// Mirrors the documented route-ID shape. Not imported from src/core/routing/** (Tier-1 protected).
const ROUTE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const isRouteId = (v: unknown): v is string => typeof v === 'string' && ROUTE_ID.test(v);
const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export interface RouterWeightBaseline { work_class: string; lane: string; weight: number }

/**
 * Per-group outcome quality folded from the same known cohort the weight
 * decision uses. Every figure carries its own coverage count; a signal with
 * no recorded evidence reports null, never zero. The weight math still moves
 * on held-merge rate alone — this block only reports the other signals the
 * ledger already records so an operator sees merge quality (CI retries,
 * review load, cost, wall time, merge latency, queue-admission wait, CI
 * wall, publish-station wait, token usage, eval pass^k) before applying
 * anything.
 */
export interface RouterWeightEvidence {
  /** Group outcomes carrying a recorded CI first-pass verdict. */
  ci_first_pass_known: number;
  /** ci_first_pass===true over ci_first_pass_known; null when no verdict was recorded. */
  ci_first_pass_rate: number | null;
  /** Group outcomes carrying review_findings counts. */
  review_findings_known: number;
  /** Summed fixed/rejected/ignored across those outcomes; null when none recorded. */
  review_findings: { fixed: number; rejected: number; ignored: number } | null;
  /** Group outcomes with a recorded cost_usd. */
  cost_known: number;
  /** Mean cost_usd over cost_known; null when no outcome recorded a cost. */
  cost_usd_mean: number | null;
  /** Group outcomes with a recorded wall_s. */
  wall_known: number;
  /** Mean wall_s over wall_known; null when no outcome recorded wall time. */
  wall_s_mean: number | null;
  /** Group outcomes whose standing merge verdict recorded opened-to-merged seconds. */
  ttm_known: number;
  /** Mean recorded ttm_s over ttm_known; null when no merge recorded one. */
  ttm_s_mean: number | null;
  /** Group outcomes with a recorded queue-admission wait (arrival stamp to first dispatch). */
  queue_wait_known: number;
  /** Mean recorded queue_wait_s over queue_wait_known; null when none recorded. */
  queue_wait_s_mean: number | null;
  /** Group outcomes whose jobs ledger recorded exactly one ci_start/ci_complete pair. */
  ci_wall_known: number;
  /** Mean recorded ci_wall_s over ci_wall_known; null when none recorded. */
  ci_wall_s_mean: number | null;
  /** Group outcomes whose jobs ledger recorded exactly one finish/publish boundary pair. */
  publish_wait_known: number;
  /** Mean recorded publish_wait_s over publish_wait_known; null when none recorded. */
  publish_wait_s_mean: number | null;
  /**
   * Group outcomes (the known cohort) whose standing dispatch claim
   * recorded lane-hint blocking codes — a non-empty
   * `lane_hint_blocked_by`. The market's recorded empty list (`[]`,
   * written when the preferred lane was unknown or merely outranked
   * rather than rejected) is its "nothing blocked it" verdict and does
   * not count here. `lane_blocked_reasons` tallies the recorded codes
   * over the same cohort — `quota_exhausted`, `saturated`, `held`,
   * `lower_rank`, `hysteresis_*` — most jobs first, so a lane whose
   * hinted work keeps losing to capacity or rank shows the blocking
   * mix behind its off-hint share. Null when no outcome recorded
   * codes — never zero-filled.
   */
  lane_blocked_known: number;
  lane_blocked_reasons: { reason: string; jobs: number }[] | null;
  /** Group outcomes with a recorded finish-row tokens_total. */
  tokens_known: number;
  /** Mean recorded tokens_total over tokens_known; null when no outcome recorded usage. */
  tokens_total_mean: number | null;
  /** Group outcomes carrying an advisory passk score. */
  passk_known: number;
  /** Mean passk over passk_known; null when no outcome carried a score. */
  passk_mean: number | null;
  /**
   * Group outcomes with a recorded finish-row `acus` figure — the Devin
   * lane's billed ACU spend, the only cost evidence subscription lanes
   * record. A different unit than cost_usd: the two means never mix.
   */
  acus_known: number;
  /** Mean recorded acus over acus_known; null when none recorded. */
  acus_mean: number | null;
  /** Group outcomes with a recorded finish-row `diff_files` count. */
  diff_files_known: number;
  /** Mean recorded diff_files over diff_files_known; null when none recorded. */
  diff_files_mean: number | null;
  /** Group outcomes with a recorded finish-row `diff_lines` count. */
  diff_lines_known: number;
  /** Mean recorded diff_lines over diff_lines_known; null when none recorded. */
  diff_lines_mean: number | null;
  /**
   * Group outcomes carrying a recorded `usage_missing` label — finishes
   * whose usage stayed unknowable, with the ledger's own capture-gap
   * reason. A coverage count only; the reason tally lives at set level.
   */
  usage_missing_known: number;
  /**
   * Group outcomes (the known cohort) whose newest dispatch claim left
   * its recorded lane hint — the market's `resource_fit` /
   * `unknown_preference` / `preferred_lane_fallback` override or a
   * `batch_session` move, per the claim/batch_claim rows the outcome
   * fold carries as `lane_override`. A lane absorbing fallback work
   * shows its off-hint share here, so a merge rate built partly on
   * rerouted jobs reads differently than one built on preferred
   * assignments. `lane_override_reasons` tallies the recorded reason
   * codes over the same cohort, most jobs first; null when no outcome
   * recorded an override — never zero-filled.
   */
  lane_overrides_known: number;
  lane_override_reasons: { reason: string; jobs: number }[] | null;
}

export interface RouterWeightProposalOptions {
  /** Known (merged true/false) outcomes required before a shift is proposed. Default 20. */
  minSamples?: number;
  /** Largest move from the baseline in either direction, in (0, 1]. Default 0.1. */
  maxShift?: number;
  /** Current weights. Absent (work_class, lane) pairs start at ROUTER_WEIGHT_BASELINE. */
  baselines?: readonly RouterWeightBaseline[];
}

export interface RouterWeightProposal {
  work_class: string;
  lane: string;
  status: 'proposed' | 'refused';
  reason: 'insufficient-evidence' | null;
  /** Known outcomes (merged non-null) behind this group. */
  known_n: number;
  /** Known outcomes whose merge was recorded as reverted; counted in known_n but never as a held merge. */
  reverted_n: number;
  baseline_weight: number;
  /** Equals baseline_weight when refused. Always within [0, 1]. */
  proposed_weight: number;
  shift: number;
  /** Outcome-quality signals over the same known_n cohort; advisory context, never weight input. */
  evidence: RouterWeightEvidence;
}

export interface RouterWeightProposalSet {
  proposals: RouterWeightProposal[];
  known_outcomes: number;
  unknown_outcomes: number;
  unclassified_outcomes: number;
  /**
   * Finish productivity signals inside the merged:null cohort — the same
   * classified outcomes `unknown_outcomes` counts, so these explain why the
   * merge verdict is missing rather than adding new jobs. `unknown_empty`
   * counts jobs whose newest finish recorded `empty: true` (the run produced
   * no diff); `unknown_nonzero_exit` counts jobs whose newest `exit_code`
   * was not 0 — the two overlap, since a crashed run usually diffs nothing.
   * `unknown_failure_classes` tallies the recorded failure classifications
   * (failure_class, else failure_reason, else pool_error on a finish row,
   * or the fixed reason on a launch_failed give_up receipt — the dead
   * launch's recorded cause), top entries first. `unknown_empty_classes` tallies the recorded
   * finish-row `empty_class` verdicts — dispatchd's classify_empty triage
   * (`no_diff` healthy no-op, `error` infrastructure, `unknown` capture
   * gap) — so the empty share splits the way the dispatcher's own
   * empty_error_rate does. `unknown_task_outcomes` tallies the recorded
   * batch-member `task_outcome` words — dispatchd's batcher.OUTCOMES
   * vocabulary, the member's finish boundary since batch members get no
   * per-member finish row — so a requeued member (`failed`/`deferred`/
   * `unreported`, batcher.RETRY) reads as an explained attempt instead of
   * an unresolved one, while `done`/`skipped` members still awaiting their
   * own publish verdict count in `unknown_unresolved`. `unknown_skipped`
   * counts jobs whose standing launch decision is a recorded skip-gate
   * decline — a `skipped_empty`/`precheck_skip` receipt no later dispatch
   * superseded — and `unknown_skip_reasons` tallies their recorded reason
   * labels (the empty-gate vocabulary, bounded `code` strings, and
   * `code:<n>` for gate-code-only declines, top entries first), so a job
   * the fleet chose not to launch reads as explained rather than
   * unresolved. `unknown_empty_tags` tallies the fleet's recorded empty
   * tags — the `job.empty-tag.v1` rows `phm jobs empty --record` stores in
   * metrics/empty-tags.jsonl, empty-tags.ts's closed
   * already_done/pool_cap/blocked/no_change_needed/unknown vocabulary —
   * so an empty finish reads with its recorded cause (work already on
   * master, quota exhausted, blocked on a missing tool, genuinely no
   * change needed, or the fleet's own unknown) instead of only the
   * finish row's bare empty flag. `unknown_deferred` counts jobs whose
   * standing launch decision is a recorded keep-queued verdict — a
   * `dispatch_deferred` duplicate-request receipt, a `recut_admission`
   * defer, or a `precheck_parked` park no later dispatch or decline
   * superseded — and `unknown_defer_reasons` tallies their recorded
   * reason labels (top entries first), so a job the fleet recorded
   * keeping queued reads as explained rather than unresolved, the same
   * exemption `unknown_skipped` applies. `unknown_market_reasons`
   * tallies the work market's recorded `reason_codes` for each job's
   * newest `route_decision` row — queue-side diagnostic context for why
   * the market was or was not routing the job (`no_runnable_lane`,
   * `global_admission`, `hysteresis_*`, `preferred_lane`/
   * `healthy_capacity`), never a launch decision and never a reduction
   * of `unknown_unresolved`. `unknown_unresolved`
   * is the remainder with no recorded failure signal — finished cleanly and
   * awaiting a merge verdict, still in flight, or only transient launch
   * receipts; the ledger simply records no terminal productivity outcome
   * for it. All are counts of
   * recorded evidence over the retained window, so 0 is a real measurement.
   */
  unknown_empty: number;
  unknown_nonzero_exit: number;
  unknown_failure_classes: { failure_class: string; jobs: number }[];
  unknown_empty_classes: { empty_class: string; jobs: number }[];
  unknown_task_outcomes: { task_outcome: string; jobs: number }[];
  unknown_skipped: number;
  unknown_skip_reasons: { reason: string; jobs: number }[];
  unknown_empty_tags: { tag: string; jobs: number }[];
  unknown_deferred: number;
  unknown_defer_reasons: { reason: string; jobs: number }[];
  /**
   * Top recorded work-market `reason_codes` inside the unknown cohort,
   * by jobs — the market's own routing verdict for each job's newest
   * `route_decision` row (`preferred_lane`/`healthy_capacity` behind a
   * chosen lane, `no_runnable_lane` when no executor could take it,
   * `hysteresis_*` holds, `hard_down`/`residency_elapsed` switches,
   * `global_admission`/`invalid_requirements`). Each job contributes
   * each recorded code once; a `market_reasons` of `[]` or `null`
   * contributes nothing — recorded-empty and missing evidence stay
   * distinct upstream. This is queue-side diagnostic context, not a
   * launch decision: it explains why the market was or was not routing
   * the job, and never reduces `unknown_unresolved` — a job still
   * awaiting a merge verdict stays unresolved however it was routed.
   */
  unknown_market_reasons: { reason: string; jobs: number }[];
  unknown_unresolved: number;
  /**
   * Top recorded `usage_missing` labels across every folded outcome —
   * known, unknown and unclassified alike, since usage capture is not
   * merge evidence. Each entry is a finish row's own capture-gap reason
   * (dispatchd's devin-, claude- and tokens-line- vocabulary or whatever
   * bounded label a producer wrote), so an operator sees where usage
   * telemetry is actually broken rather than only that tokens coverage
   * is thin. Empty when no outcome recorded one; counts cover the
   * retained window.
   */
  usage_missing: { usage_missing: string; jobs: number }[];
  /**
   * Top recorded `usage_source` labels across every folded outcome —
   * which measurement path actually supplied the usage figures
   * (devin-sessions-db, claude-result-json, tokens-line, ...). Paired
   * with usage_missing it separates "no usage reported" from "usage
   * reported through the fallback path". Same scope and bounds as
   * usage_missing.
   */
  usage_sources: { usage_source: string; jobs: number }[];
}

/** Running tallies for the outcome-quality signals; every count starts at zero and means stay sums until emitted. */
interface WeightEvidenceTally {
  ciPass: number; ciKnown: number;
  reviewFixed: number; reviewRejected: number; reviewIgnored: number; reviewKnown: number;
  costSum: number; costKnown: number;
  wallSum: number; wallKnown: number;
  ttmSum: number; ttmKnown: number;
  queueWaitSum: number; queueWaitKnown: number;
  ciWallSum: number; ciWallKnown: number;
  publishWaitSum: number; publishWaitKnown: number;
  laneBlocked: number; blockedReasons: Map<string, number>;
  tokensSum: number; tokensKnown: number;
  passkSum: number; passkKnown: number;
  acusSum: number; acusKnown: number;
  diffFilesSum: number; diffFilesKnown: number;
  diffLinesSum: number; diffLinesKnown: number;
  usageMissingKnown: number;
  laneOverrides: number;
  overrideReasons: Map<string, number>;
}

const freshTally = (): WeightEvidenceTally => ({
  ciPass: 0, ciKnown: 0, reviewFixed: 0, reviewRejected: 0, reviewIgnored: 0, reviewKnown: 0,
  costSum: 0, costKnown: 0, wallSum: 0, wallKnown: 0, ttmSum: 0, ttmKnown: 0,
  queueWaitSum: 0, queueWaitKnown: 0, ciWallSum: 0, ciWallKnown: 0,
  publishWaitSum: 0, publishWaitKnown: 0,
  laneBlocked: 0, blockedReasons: new Map(),
  tokensSum: 0, tokensKnown: 0, passkSum: 0, passkKnown: 0,
  acusSum: 0, acusKnown: 0, diffFilesSum: 0, diffFilesKnown: 0,
  diffLinesSum: 0, diffLinesKnown: 0, usageMissingKnown: 0,
  laneOverrides: 0, overrideReasons: new Map(),
});

/** Top recorded lane-hint blocking codes kept per group, most jobs first. */
const MAX_BLOCKED_REASONS = 8;

/**
 * The batch-member task_outcome words that end the attempt without a
 * publish — dispatchd's batcher.RETRY set. `done`/`skipped` members hand
 * off to their own per-job publish and stay awaiting-verdict unresolved;
 * the requeue words are the member's recorded failure signal.
 */
const TASK_OUTCOME_RETRY: ReadonlySet<string> = new Set(['failed', 'deferred', 'unreported']);

const MAX_OVERRIDE_REASONS = 8;

const evidenceOf = (t: WeightEvidenceTally): RouterWeightEvidence => ({
  ci_first_pass_known: t.ciKnown,
  ci_first_pass_rate: t.ciKnown === 0 ? null : round6(t.ciPass / t.ciKnown),
  review_findings_known: t.reviewKnown,
  review_findings: t.reviewKnown === 0 ? null
    : { fixed: t.reviewFixed, rejected: t.reviewRejected, ignored: t.reviewIgnored },
  cost_known: t.costKnown,
  cost_usd_mean: t.costKnown === 0 ? null : round6(t.costSum / t.costKnown),
  wall_known: t.wallKnown,
  wall_s_mean: t.wallKnown === 0 ? null : round6(t.wallSum / t.wallKnown),
  ttm_known: t.ttmKnown,
  ttm_s_mean: t.ttmKnown === 0 ? null : round6(t.ttmSum / t.ttmKnown),
  queue_wait_known: t.queueWaitKnown,
  queue_wait_s_mean: t.queueWaitKnown === 0 ? null : round6(t.queueWaitSum / t.queueWaitKnown),
  ci_wall_known: t.ciWallKnown,
  ci_wall_s_mean: t.ciWallKnown === 0 ? null : round6(t.ciWallSum / t.ciWallKnown),
  publish_wait_known: t.publishWaitKnown,
  publish_wait_s_mean: t.publishWaitKnown === 0 ? null : round6(t.publishWaitSum / t.publishWaitKnown),
  lane_blocked_known: t.laneBlocked,
  lane_blocked_reasons: t.laneBlocked === 0 ? null
    : [...t.blockedReasons.entries()]
        .map(([reason, jobs]) => ({ reason, jobs }))
        .sort((a, b) => b.jobs - a.jobs || a.reason.localeCompare(b.reason))
        .slice(0, MAX_BLOCKED_REASONS),
  tokens_known: t.tokensKnown,
  tokens_total_mean: t.tokensKnown === 0 ? null : round6(t.tokensSum / t.tokensKnown),
  passk_known: t.passkKnown,
  passk_mean: t.passkKnown === 0 ? null : round6(t.passkSum / t.passkKnown),
  acus_known: t.acusKnown,
  acus_mean: t.acusKnown === 0 ? null : round6(t.acusSum / t.acusKnown),
  diff_files_known: t.diffFilesKnown,
  diff_files_mean: t.diffFilesKnown === 0 ? null : round6(t.diffFilesSum / t.diffFilesKnown),
  diff_lines_known: t.diffLinesKnown,
  diff_lines_mean: t.diffLinesKnown === 0 ? null : round6(t.diffLinesSum / t.diffLinesKnown),
  usage_missing_known: t.usageMissingKnown,
  lane_overrides_known: t.laneOverrides,
  lane_override_reasons: t.laneOverrides === 0 ? null
    : [...t.overrideReasons.entries()]
        .map(([reason, jobs]) => ({ reason, jobs }))
        .sort((a, b) => b.jobs - a.jobs || a.reason.localeCompare(b.reason))
        .slice(0, MAX_OVERRIDE_REASONS),
});

/**
 * Groups by (work_class, lane). Non-ID work_class or lane is unclassified; merged:null is unknown and
 * excluded from evidence. A group below minSamples is refused and keeps its baseline. Otherwise the
 * weight moves toward the observed held-merge rate — merged outcomes recorded as reverted count as
 * known evidence but never as held merges — capped at maxShift and clamped to [0, 1]. Each proposal
 * also reports the group's other recorded outcome signals (CI verdicts, review findings, cost, wall
 * time, merge latency, queue-admission wait, CI wall, publish-station
 * wait, pass^k, dispatch lane
 * overrides and lane-hint blocking codes) as advisory evidence over
 * the same known cohort. Recorded lane-hint blocking codes
 * (`lane_hint_blocked_by`) tally per group as
 * `lane_blocked_known`/`lane_blocked_reasons` — the market's reasons
 * the hinted lane could not take the work.
 */
export function proposeRouterWeights(outcomes: readonly RouterOutcome[], opts: RouterWeightProposalOptions = {}): RouterWeightProposalSet {
  const minSamples = opts.minSamples ?? ROUTER_WEIGHT_DEFAULT_MIN_SAMPLES;
  const maxShift = opts.maxShift ?? ROUTER_WEIGHT_DEFAULT_MAX_SHIFT;
  if (!Number.isSafeInteger(minSamples) || minSamples < 1) throw new RangeError('minSamples must be a positive safe integer');
  if (!Number.isFinite(maxShift) || maxShift <= 0 || maxShift > 1) throw new RangeError('maxShift must be in (0, 1]');

  const baselines = new Map<string, number>();
  for (const b of opts.baselines ?? []) {
    if (!isRouteId(b.work_class) || !isRouteId(b.lane) || !Number.isFinite(b.weight) || b.weight < 0 || b.weight > 1) {
      throw new RangeError('baseline needs route-ID work_class and lane and a weight in [0, 1]');
    }
    const key = JSON.stringify([b.work_class, b.lane]);
    if (baselines.has(key)) throw new RangeError('duplicate baseline for work_class and lane');
    baselines.set(key, b.weight);
  }

  const groups = new Map<string, { work_class: string; lane: string; known: number; merged: number; reverted: number; tally: WeightEvidenceTally }>();
  let known = 0, unknown = 0, unclassified = 0;
  let unknownEmpty = 0, unknownNonzeroExit = 0, unknownUnresolved = 0;
  const failureClasses = new Map<string, number>();
  const emptyClasses = new Map<string, number>();
  const taskOutcomes = new Map<string, number>();
  const skipReasons = new Map<string, number>();
  const emptyTags = new Map<string, number>();
  const deferReasons = new Map<string, number>();
  const marketReasons = new Map<string, number>();
  const usageMissing = new Map<string, number>();
  const usageSources = new Map<string, number>();
  let unknownSkipped = 0;
  let unknownDeferred = 0;
  for (const o of outcomes) {
    // Usage provenance is capture evidence, not merge evidence: every folded
    // outcome tallies its recorded labels — classified or not.
    if (o.usage_missing !== null) usageMissing.set(o.usage_missing, (usageMissing.get(o.usage_missing) ?? 0) + 1);
    if (o.usage_source !== null) usageSources.set(o.usage_source, (usageSources.get(o.usage_source) ?? 0) + 1);
    if (!isRouteId(o.work_class) || !isRouteId(o.lane)) { unclassified++; continue; }
    if (o.merged === null) {
      unknown++;
      // Finish productivity evidence explains the missing merge verdict:
      // empty:true means the run produced no diff, a nonzero exit_code means
      // the worker failed, and failure_class names the classified cause —
      // a finish row's classification or a dead launch's give_up reason.
      // A batch member's task_outcome is its finish boundary: the requeue
      // words (failed/deferred/unreported) are the recorded failure signal,
      // while done/skipped members still await their own publish verdict.
      // A standing skip-gate decline (skipped_empty/precheck_skip with no
      // later dispatch) is the recorded launch decision — the fleet chose
      // not to run the job — so it explains the missing verdict the same
      // way. A standing keep-queued verdict (dispatch_deferred,
      // recut_admission defer or precheck_parked with no later dispatch
      // or decline) is the recorded keep-queued decision — the fleet
      // chose to hold the job for a covering attempt or a bounded retry —
      // and explains it the same way. A job carrying none of them has no
      // recorded launch decision — it finished cleanly awaiting a verdict
      // or is still in flight.
      const empty = o.empty === true;
      const nonzeroExit = o.exit_code !== null && o.exit_code !== 0;
      const requeued = o.task_outcome !== null && TASK_OUTCOME_RETRY.has(o.task_outcome);
      const declined = o.skipped === true;
      const deferred = o.deferred === true;
      if (empty) unknownEmpty++;
      if (nonzeroExit) unknownNonzeroExit++;
      if (o.failure_class !== null) failureClasses.set(o.failure_class, (failureClasses.get(o.failure_class) ?? 0) + 1);
      if (o.empty_class !== null) emptyClasses.set(o.empty_class, (emptyClasses.get(o.empty_class) ?? 0) + 1);
      if (o.task_outcome !== null) taskOutcomes.set(o.task_outcome, (taskOutcomes.get(o.task_outcome) ?? 0) + 1);
      if (o.empty_tag !== null) emptyTags.set(o.empty_tag, (emptyTags.get(o.empty_tag) ?? 0) + 1);
      if (declined) {
        unknownSkipped++;
        const key = o.skip_reason ?? (o.skip_code !== null ? `code:${o.skip_code}` : 'unlabeled');
        skipReasons.set(key, (skipReasons.get(key) ?? 0) + 1);
      }
      if (deferred) {
        unknownDeferred++;
        const key = o.defer_reason ?? 'unlabeled';
        deferReasons.set(key, (deferReasons.get(key) ?? 0) + 1);
      }
      // The market's newest route_decision verdict is queue-side
      // diagnostic: each recorded reason code tallies once per job —
      // `no_runnable_lane`/`global_admission` read as capacity-blocked,
      // `preferred_lane`/`healthy_capacity` as routable-and-waiting.
      // It never feeds the unresolved remainder: a job with no terminal
      // productivity verdict stays unresolved however the market routed it.
      if (o.market_reasons !== null) {
        for (const code of o.market_reasons) {
          marketReasons.set(code, (marketReasons.get(code) ?? 0) + 1);
        }
      }
      if (!empty && !nonzeroExit && o.failure_class === null && !requeued && !declined && !deferred) unknownUnresolved++;
      continue;
    }
    const key = JSON.stringify([o.work_class, o.lane]);
    const g = groups.get(key) ?? { work_class: o.work_class, lane: o.lane, known: 0, merged: 0, reverted: 0, tally: freshTally() };
    g.known++;
    if (o.merged) {
      if (o.reverted === true) g.reverted++;
      else g.merged++;
    }
    const t = g.tally;
    if (o.ci_first_pass !== null) { t.ciKnown++; if (o.ci_first_pass) t.ciPass++; }
    if (o.review_findings !== null) {
      t.reviewKnown++;
      t.reviewFixed += o.review_findings.fixed;
      t.reviewRejected += o.review_findings.rejected;
      t.reviewIgnored += o.review_findings.ignored;
    }
    if (o.cost_usd !== null) { t.costKnown++; t.costSum += o.cost_usd; }
    if (o.wall_s !== null) { t.wallKnown++; t.wallSum += o.wall_s; }
    if (o.ttm_s !== null) { t.ttmKnown++; t.ttmSum += o.ttm_s; }
    if (o.queue_wait_s !== null) { t.queueWaitKnown++; t.queueWaitSum += o.queue_wait_s; }
    if (o.ci_wall_s !== null) { t.ciWallKnown++; t.ciWallSum += o.ci_wall_s; }
    if (o.publish_wait_s !== null) { t.publishWaitKnown++; t.publishWaitSum += o.publish_wait_s; }
    if (o.lane_hint_blocked_by !== null && o.lane_hint_blocked_by.length > 0) {
      t.laneBlocked++;
      for (const code of o.lane_hint_blocked_by) {
        t.blockedReasons.set(code, (t.blockedReasons.get(code) ?? 0) + 1);
      }
    }
    if (o.tokens_total !== null) { t.tokensKnown++; t.tokensSum += o.tokens_total; }
    if (o.passk !== null) { t.passkKnown++; t.passkSum += o.passk; }
    if (o.acus !== null) { t.acusKnown++; t.acusSum += o.acus; }
    if (o.diff_files !== null) { t.diffFilesKnown++; t.diffFilesSum += o.diff_files; }
    if (o.diff_lines !== null) { t.diffLinesKnown++; t.diffLinesSum += o.diff_lines; }
    if (o.usage_missing !== null) t.usageMissingKnown++;
    if (o.lane_override !== null) {
      t.laneOverrides++;
      t.overrideReasons.set(o.lane_override, (t.overrideReasons.get(o.lane_override) ?? 0) + 1);
    }
    groups.set(key, g);
    known++;
  }

  const proposals = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, g]): RouterWeightProposal => {
    const baseline = baselines.get(key) ?? ROUTER_WEIGHT_BASELINE;
    const base = { work_class: g.work_class, lane: g.lane, known_n: g.known, reverted_n: g.reverted,
      baseline_weight: baseline, evidence: evidenceOf(g.tally) };
    if (g.known < minSamples) {
      return { ...base, status: 'refused', reason: 'insufficient-evidence', proposed_weight: baseline, shift: 0 };
    }
    const proposed = clamp(baseline + clamp(g.merged / g.known - baseline, -maxShift, maxShift), 0, 1);
    return { ...base, status: 'proposed', reason: null, proposed_weight: round6(proposed), shift: round6(proposed - baseline) };
  });
  const topFailureClasses = [...failureClasses.entries()]
    .map(([failure_class, jobs]) => ({ failure_class, jobs }))
    .sort((a, b) => b.jobs - a.jobs || a.failure_class.localeCompare(b.failure_class))
    .slice(0, 10);
  const topEmptyClasses = [...emptyClasses.entries()]
    .map(([empty_class, jobs]) => ({ empty_class, jobs }))
    .sort((a, b) => b.jobs - a.jobs || a.empty_class.localeCompare(b.empty_class))
    .slice(0, 10);
  const topTaskOutcomes = [...taskOutcomes.entries()]
    .map(([task_outcome, jobs]) => ({ task_outcome, jobs }))
    .sort((a, b) => b.jobs - a.jobs || a.task_outcome.localeCompare(b.task_outcome))
    .slice(0, 10);
  const topSkipReasons = [...skipReasons.entries()]
    .map(([reason, jobs]) => ({ reason, jobs }))
    .sort((a, b) => b.jobs - a.jobs || a.reason.localeCompare(b.reason))
    .slice(0, 10);
  const topEmptyTags = [...emptyTags.entries()]
    .map(([tag, jobs]) => ({ tag, jobs }))
    .sort((a, b) => b.jobs - a.jobs || a.tag.localeCompare(b.tag))
    .slice(0, 10);
  const topDeferReasons = [...deferReasons.entries()]
    .map(([reason, jobs]) => ({ reason, jobs }))
    .sort((a, b) => b.jobs - a.jobs || a.reason.localeCompare(b.reason))
    .slice(0, 10);
  const topMarketReasons = [...marketReasons.entries()]
    .map(([reason, jobs]) => ({ reason, jobs }))
    .sort((a, b) => b.jobs - a.jobs || a.reason.localeCompare(b.reason))
    .slice(0, 10);
  const topUsageMissing = [...usageMissing.entries()]
    .map(([usage_missing, jobs]) => ({ usage_missing, jobs }))
    .sort((a, b) => b.jobs - a.jobs || a.usage_missing.localeCompare(b.usage_missing))
    .slice(0, 10);
  const topUsageSources = [...usageSources.entries()]
    .map(([usage_source, jobs]) => ({ usage_source, jobs }))
    .sort((a, b) => b.jobs - a.jobs || a.usage_source.localeCompare(b.usage_source))
    .slice(0, 10);
  return { proposals, known_outcomes: known, unknown_outcomes: unknown, unclassified_outcomes: unclassified,
    unknown_empty: unknownEmpty, unknown_nonzero_exit: unknownNonzeroExit,
    unknown_failure_classes: topFailureClasses, unknown_empty_classes: topEmptyClasses,
    unknown_task_outcomes: topTaskOutcomes, unknown_skipped: unknownSkipped,
    unknown_skip_reasons: topSkipReasons, unknown_empty_tags: topEmptyTags,
    unknown_deferred: unknownDeferred, unknown_defer_reasons: topDeferReasons,
    unknown_market_reasons: topMarketReasons,
    unknown_unresolved: unknownUnresolved,
    usage_missing: topUsageMissing, usage_sources: topUsageSources };
}

export interface RouterWeightProposalReport {
  schema: 'router.weight-proposals.v1';
  /** Always true: proposals are never applied to routing, rank, admission or weights.json. */
  advisory_only: true;
  as_of: string;
  source: typeof ROUTER_WEIGHT_PROPOSAL_SOURCE;
  ledger: { state: RouterOutcomeRead['state']; path: string };
  /** True when the ledger exceeded the retained tail; outcome counts cover only the newest bytes. */
  truncated: boolean;
  /**
   * Health of the work-market.jsonl tail behind work_class joins. Anything
   * but 'read' means no market classes joined; groups reflect only
   * jobs-ledger-recorded classes (production ledgers record none).
   */
  market_state: RouterOutcomeRead['market_state'];
  /** True when the market tail was cut; joined classes cover only the newest bytes. */
  market_truncated: boolean;
  /**
   * Health of the empty-tags.jsonl tail behind empty_tag joins and the
   * unknown_empty_tags tally. Anything but 'read' means no tags joined —
   * unknown_empty_tags is then null (coverage unknown), never an empty
   * list claiming no empty jobs were tagged.
   */
  empty_tag_state: RouterOutcomeRead['empty_tag_state'];
  /** True when the empty-tags tail was cut; joined tags cover only the newest bytes. */
  empty_tag_truncated: boolean;
  /** 'unavailable' when the ledger was not read; counts are then null, never zero. */
  status: 'proposed' | 'insufficient-evidence' | 'unavailable';
  bounds: { min_samples: number; max_shift: number };
  known_outcomes: number | null;
  unknown_outcomes: number | null;
  unclassified_outcomes: number | null;
  /**
   * Why the merged:null cohort has no merge verdict, from finish-row
   * evidence — see RouterWeightProposalSet. Null when the ledger was not
   * read; counts are then unknown, never zero.
   */
  unknown_empty: number | null;
  unknown_nonzero_exit: number | null;
  /** Top recorded failure classifications inside the unknown cohort, by jobs — finish-row labels or dead-launch give_up reasons; empty when none recorded. */
  unknown_failure_classes: { failure_class: string; jobs: number }[] | null;
  /**
   * Top recorded finish-row empty_class verdicts inside the unknown
   * cohort, by jobs — dispatchd's classify_empty triage (no_diff/error/
   * unknown). Null when the ledger was not read; empty when none recorded.
   */
  unknown_empty_classes: { empty_class: string; jobs: number }[] | null;
  /**
   * Top recorded batch-member task_outcome words inside the unknown
   * cohort, by jobs — dispatchd's batcher.OUTCOMES vocabulary, the
   * member's finish boundary (failed/deferred/unreported requeued the
   * member; done/skipped await their own publish verdict). Null when the
   * ledger was not read; empty when none recorded.
   */
  unknown_task_outcomes: { task_outcome: string; jobs: number }[] | null;
  /**
   * Jobs inside the unknown cohort whose standing launch decision is a
   * recorded skip-gate decline — see RouterWeightProposalSet. Null when
   * the ledger was not read; 0 is a real measurement.
   */
  unknown_skipped: number | null;
  /**
   * Top recorded skip reasons inside the unknown cohort, by jobs — the
   * empty-gate labels, bounded `code` strings and `code:<n>` gate-code
   * compositions. Null when the ledger was not read; empty when none
   * recorded.
   */
  unknown_skip_reasons: { reason: string; jobs: number }[] | null;
  /**
   * Top recorded empty tags inside the unknown cohort, by jobs — the
   * fleet's own why-it-ended-empty classification (already_done/pool_cap/
   * blocked/no_change_needed/unknown). Null when the ledger was not read
   * or the empty-tags ledger was not read (tag coverage unknown); empty
   * when the tags ledger was read and no unknown-cohort outcome carried
   * a tag.
   */
  unknown_empty_tags: { tag: string; jobs: number }[] | null;
  /**
   * Jobs inside the unknown cohort whose standing launch decision is a
   * recorded keep-queued verdict — see RouterWeightProposalSet.
   * Null when the ledger was not read; 0 is a real measurement.
   */
  unknown_deferred: number | null;
  /**
   * Top recorded keep-queued reasons inside the unknown cohort, by jobs —
   * `duplicate-request`, `recut-in-flight`, the precheck park reasons and
   * `unlabeled` for verdicts whose reason did not join. Null when the
   * ledger was not read; empty when none recorded.
   */
  unknown_defer_reasons: { reason: string; jobs: number }[] | null;
  /**
   * Top recorded work-market `reason_codes` inside the unknown cohort,
   * by jobs — the market's routing verdict for each job's newest
   * route_decision row (see RouterWeightProposalSet). Null when the
   * ledger was not read; empty when read but no unknown-cohort outcome
   * carried market reasons.
   */
  unknown_market_reasons: { reason: string; jobs: number }[] | null;
  unknown_unresolved: number | null;
  /**
   * Top recorded `usage_missing` labels across every folded outcome —
   * see RouterWeightProposalSet. Null when the ledger was not read;
   * empty when no outcome recorded a usage gap.
   */
  usage_missing: { usage_missing: string; jobs: number }[] | null;
  /**
   * Top recorded `usage_source` labels across every folded outcome —
   * see RouterWeightProposalSet. Null when the ledger was not read;
   * empty when no outcome recorded a measurement path.
   */
  usage_sources: { usage_source: string; jobs: number }[] | null;
  proposals: RouterWeightProposal[];
}

/** Wraps one bounded ledger read. Raw ledger rows are never copied into the report. */
export function buildRouterWeightProposalReport(read: RouterOutcomeRead, asOf: string, opts: RouterWeightProposalOptions = {}): RouterWeightProposalReport {
  if (!z.iso.datetime().safeParse(asOf).success) throw new RangeError('as_of must be an ISO-8601 UTC timestamp');
  const bounds = { min_samples: opts.minSamples ?? ROUTER_WEIGHT_DEFAULT_MIN_SAMPLES, max_shift: opts.maxShift ?? ROUTER_WEIGHT_DEFAULT_MAX_SHIFT };
  const head = { schema: 'router.weight-proposals.v1' as const, advisory_only: true as const, as_of: asOf,
    source: ROUTER_WEIGHT_PROPOSAL_SOURCE, ledger: { state: read.state, path: read.path }, truncated: read.truncated,
    market_state: read.market_state, market_truncated: read.market_truncated,
    empty_tag_state: read.empty_tag_state, empty_tag_truncated: read.empty_tag_truncated, bounds };
  if (read.state !== 'read') {
    return { ...head, status: 'unavailable', known_outcomes: null, unknown_outcomes: null, unclassified_outcomes: null,
      unknown_empty: null, unknown_nonzero_exit: null, unknown_failure_classes: null, unknown_empty_classes: null,
      unknown_task_outcomes: null, unknown_skipped: null, unknown_skip_reasons: null, unknown_empty_tags: null,
      unknown_deferred: null, unknown_defer_reasons: null, unknown_market_reasons: null,
      unknown_unresolved: null,
      usage_missing: null, usage_sources: null, proposals: [] };
  }
  const set = proposeRouterWeights(read.outcomes, { ...opts, minSamples: bounds.min_samples, maxShift: bounds.max_shift });
  const status = set.proposals.some(p => p.status === 'proposed') ? 'proposed' : 'insufficient-evidence';
  return { ...head, status, known_outcomes: set.known_outcomes, unknown_outcomes: set.unknown_outcomes,
    unclassified_outcomes: set.unclassified_outcomes,
    unknown_empty: set.unknown_empty, unknown_nonzero_exit: set.unknown_nonzero_exit,
    unknown_failure_classes: set.unknown_failure_classes, unknown_empty_classes: set.unknown_empty_classes,
    unknown_task_outcomes: set.unknown_task_outcomes, unknown_skipped: set.unknown_skipped,
    unknown_skip_reasons: set.unknown_skip_reasons,
    // Tag coverage is only as good as the tags ledger read: anything but
    // 'read' leaves every empty_tag null, so the tally would claim "no
    // empty jobs tagged" when it only knows "tags unread" — report null.
    unknown_empty_tags: read.empty_tag_state === 'read' ? set.unknown_empty_tags : null,
    unknown_deferred: set.unknown_deferred, unknown_defer_reasons: set.unknown_defer_reasons,
    // Market reasons join through the same work-market.jsonl tail as
    // work_class: anything but 'read' means no decision verdicts joined,
    // so the tally would claim "no market reasons recorded" when it only
    // knows "market unread" — report null, the same rule empty_tags uses.
    unknown_market_reasons: read.market_state === 'read' ? set.unknown_market_reasons : null,
    unknown_unresolved: set.unknown_unresolved,
    usage_missing: set.usage_missing, usage_sources: set.usage_sources,
    proposals: set.proposals };
}
