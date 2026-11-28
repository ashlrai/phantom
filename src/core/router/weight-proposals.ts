import { z } from 'zod';

import type {
  CommunitySeatOutcome,
  CommunitySeatsCoverage,
  CommunitySeatsState,
  OutsidePrCommunitySeatsRead,
} from './community-seats.js';
import type { ControllerQualityRead, ControllerQualityReceipt, ControllerQualityState } from './controller-quality.js';
import { rankTallyEntries, type RouterOutcome, type RouterOutcomeRead } from './outcomes.js';

// Advisory router-weight proposals from recorded outcomes. Recovered from the pure proposal slice of
// PR #6794 (head f9e484e87ec2d01f155cc280e818d2e98519dbe7, src/core/router/tune.ts). Math only: no I/O,
// no weights.json, no applyRouterWeights. Nothing here changes live routing, rank or admission.

const ROUTER_WEIGHT_PROPOSAL_SOURCE = {
  pr: 6794,
  head_sha: 'f9e484e87ec2d01f155cc280e818d2e98519dbe7',
  recovered_from: 'src/core/router/tune.ts#proposeRouterWeights',
} as const;
const ROUTER_WEIGHT_BASELINE = 0.5;
const ROUTER_WEIGHT_DEFAULT_MIN_SAMPLES = 20;
const ROUTER_WEIGHT_DEFAULT_MAX_SHIFT = 0.1;

// Mirrors the documented route-ID shape. Not imported from src/core/routing/** (Tier-1 protected).
const ROUTE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const isRouteId = (v: unknown): v is string =>
  typeof v === 'string' && ROUTE_ID.test(v) && v.toLowerCase() !== 'unknown';
const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const topJobs = <K extends string>(
  map: ReadonlyMap<string, number>,
  field: K,
  limit = 10,
): Array<Record<K, string> & { jobs: number }> =>
  rankTallyEntries(map, limit, (key, jobs) => ({ [field]: key, jobs }) as Record<K, string> & { jobs: number });

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
  /** Group outcomes carrying a joined cross_review verdict. */
  cross_review_known: number;
  /** Newest recorded cross-review verdict counts across those outcomes; null when none recorded. */
  cross_review: { approve: number; reject: number; failed: number; skipped: number } | null;
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
  /**
   * Group outcomes with a recorded subscription-pool percentage-point
   * figure — the reward-signals ledger's `cost.pctUsedDelta`, the only
   * per-job subscription-quota cost evidence (subscription lanes record
   * no cost_usd and acus covers only the Devin lane's ACU spend). A
   * different unit than both: the three means never mix.
   */
  pool_pct_used_known: number;
  /** Mean recorded pool_pct_used over pool_pct_used_known; null when none recorded. */
  pool_pct_used_mean: number | null;
  /**
   * Group outcomes carrying a recorded launch-cost probe verdict —
   * launch-cost.jsonl's fleet.launch-cost.v1 rows joined as
   * `launch_cost_status`: the fleet's first-minute process/CPU
   * measurement for the job's launch attempt (`measured` full window,
   * `partial` shorter coverage, `unknown` probe ran but recorded
   * nothing). `launch_cost_measured` counts the `measured` rows inside
   * the same cohort — the subset whose figures are full-window
   * evidence rather than partial coverage. `launch_peak_processes_mean`,
   * `launch_cpu_pct_mean` and `launch_cpu_pct_peak_mean` are the mean
   * recorded first-minute peak process count and mean/peak CPU
   * (percent of one core) over the outcomes that recorded each figure;
   * null when none did — a different unit than cost_usd, acus and
   * pool_pct_used, never summed with them.
   */
  launch_cost_known: number;
  launch_cost_measured: number;
  launch_peak_processes_mean: number | null;
  launch_cpu_pct_mean: number | null;
  launch_cpu_pct_peak_mean: number | null;
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
  /**
   * Group outcomes (the known cohort) whose newest work-market
   * route_decision recorded a non-empty `rejected_lanes` list — the
   * market's per-lane rejection record joined as `market_rejected`.
   * `market_rejected_reasons` tallies the recorded rejection codes over
   * the same cohort — each job contributes each code once however many
   * lanes rejected it for it (`quota_exhausted`, `saturated`, `held`,
   * `provider_backoff`, `cost_class_*`, the `unavailable` verdicts,
   * `hysteresis_*`, `lower_rank`) — most jobs first, so a cohort whose
   * decisions kept bouncing off capacity or rank shows the blocking
   * mix behind its routing. Null when no outcome recorded rejections —
   * never zero-filled.
   */
  market_rejected_known: number;
  market_rejected_reasons: { reason: string; jobs: number }[] | null;
  /**
   * Group outcomes (the known cohort) carrying the fleet's recorded
   * session-handoff advisory — dispatchd's `session_handoff_advisory`
   * provider-wall verdicts joined as `handoff_trigger`: a `rate-limit`
   * receipt that the job's run attempt died on a usage-limit wall (the
   * verdict dispatchd appends to jobs.jsonl), or a `quota-exhausted`
   * receipt that the job's lane measured zero quota (the producer's
   * other closed-vocabulary verdict — dispatchd writes it to
   * work-market.jsonl, so it joins here only if such a row lands in
   * the jobs window). `handoff_triggers` tallies the recorded trigger
   * labels over the same cohort, most jobs first — a lane whose merges
   * rest partly on provider-wall-hit runs shows the recorded mix.
   * Null when no outcome recorded an advisory — never zero-filled.
   */
  handoff_known: number;
  handoff_triggers: { trigger: string; jobs: number }[] | null;
  /**
   * Group outcomes (the known cohort) carrying the fleet's recorded
   * provider-wall lane hold — dispatchd's `autobackoff_hold` receipts
   * joined as `provider_wall_*`: the confirmed verdict that the job's
   * finished run log tail matched a provider usage/quota or auth
   * pattern and the lane was held. `provider_wall_triggers` tallies
   * the fold's derived trigger labels (`usage-limit`, `auth-failure`)
   * over the same cohort, most jobs first — jobs whose recorded
   * pattern stayed outside the producer's mirrored tables count in
   * `provider_wall_known` but contribute no trigger label. A lane
   * whose merges rest partly on provider-walled runs shows the
   * recorded mix here. Null when no outcome recorded a hold — never
   * zero-filled.
   */
  provider_wall_known: number;
  provider_wall_triggers: { trigger: string; jobs: number }[] | null;
  /**
   * Group outcomes (the known cohort) carrying the fleet's recorded
   * slot-throttle detection — dispatchd's `pool` receipts joined as
   * `pool_kind`: the per-tick `ratelimited()` scan's provider-limit
   * class for the job's recent error-log tail (`credits_exhausted`,
   * `usage_limit`, `model_capacity`, `rate_limit`). The receipt is
   * scan-time evidence, not a terminal verdict — a recovered run, an
   * in-flight run and a finished run whose finish row never recorded
   * `pool_error` all carry it — so `pool_kinds` tallies the recorded
   * classes over the same cohort, most jobs first, as diagnostic
   * context for how much provider-throttle exposure the group's
   * outcomes rested on. Null when no outcome recorded a detection —
   * never zero-filled.
   */
  pool_known: number;
  pool_kinds: { kind: string; jobs: number }[] | null;
  /**
   * Group outcomes (the known cohort) carrying recorded merge-queue
   * evidence — the merge-events.jsonl observations joined as
   * `merge_queue` for the job's standing PR. `merge_queue_blocked_known`
   * counts those whose recorded merge queue blocked the PR at least
   * once, and `merge_queue_blocked_reasons` tallies the distinct
   * recorded blocker codes over the same cohort — each job contributes
   * each reason once — most jobs first, so a lane whose held merges
   * rest on queue friction shows the blocking mix (`required_checks`,
   * `review`, `conflict`, `queue`, `other`) behind its merge latency.
   * `merge_queue_check_failures_known`, `merge_queue_conflicts_known`,
   * `merge_queue_retries_known` and `merge_queue_recuts_known` count the
   * same cohort's outcomes whose PR recorded at least one failed check
   * observation, merge conflict, merge-retry request or recut request —
   * post-publish queue-side friction, advisory context like every other
   * evidence field, never weight input. All stay 0 or null when no
   * outcome recorded merge-queue evidence — never zero-filled means.
   */
  merge_queue_known: number;
  merge_queue_blocked_known: number;
  merge_queue_blocked_reasons: { reason: string; jobs: number }[] | null;
  merge_queue_check_failures_known: number;
  merge_queue_conflicts_known: number;
  merge_queue_retries_known: number;
  merge_queue_recuts_known: number;
  /**
   * Group outcomes (the known cohort) carrying a recorded `repo` — the
   * repo the job targeted, joined by the outcome fold in the bounded
   * repo-label shape. `repos` tallies the recorded repo labels over the
   * same cohort, most jobs first — a group's merge rate built wholly on
   * one repo reads differently than one spread across the fleet, so the
   * repo mix behind the held-merge figure shows here as advisory
   * context. Null when no outcome recorded a repo — never zero-filled.
   */
  repos_known: number;
  repos: { repo: string; jobs: number }[] | null;
  /**
   * Group outcomes (the known cohort) carrying the node runner's
   * recorded execution verdict — `phm-node-runner.v1` finish rows
   * joined as `node_outcome`: the offloaded node-pack job's terminal
   * verdict (`succeeded` pack completed and staged its result
   * artifact, `fenced` claim lease lost mid-run, `failed` pack
   * errored). Node-pack jobs produce result artifacts, not pull
   * requests, so a recorded verdict here means the job reached its
   * merge verdict through another path after a node attempt — the
   * tally shows how much of the group's held-merge evidence survived
   * node-pool execution. `node_verdicts` tallies the recorded verdict
   * words over the same cohort, most jobs first. Null when no outcome
   * recorded a verdict — never zero-filled.
   */
  node_outcomes_known: number;
  node_verdicts: { verdict: string; jobs: number }[] | null;
}

export interface RouterWeightProposalOptions {
  /** Known (merged true/false) outcomes required before a shift is proposed. Default 20. */
  minSamples?: number;
  /** Largest move from the baseline in either direction, in (0, 1]. Default 0.1. */
  maxShift?: number;
  /** Current weights. Absent (work_class, lane) pairs start at ROUTER_WEIGHT_BASELINE. */
  baselines?: readonly RouterWeightBaseline[];
  /**
   * Fleet-controller lane-quality read (`queue/fleet-controller.json`
   * quality_receipts, see controller-quality.ts). Absent or null leaves
   * controller_quality_state 'unreported' — distinct from a missing state
   * file — and controller_quality null.
   */
  controllerQuality?: ControllerQualityRead | null;
  /**
   * Outside-PR community-seat read (`metrics/outside-pr-outcomes.jsonl`,
   * see community-seats.ts). Absent or null leaves community_seats_state
   * 'unreported' — distinct from 'missing' (no journal yet) — and
   * community_seats null. Advisory context only: outside PRs carry no
   * lane or work_class, so the tallies never enter a proposal group.
   */
  communitySeats?: OutsidePrCommunitySeatsRead | null;
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
   * of `unknown_unresolved`. `unknown_node_outcomes` counts jobs
   * carrying the node runner's recorded terminal execution verdict —
   * node-pack jobs produce artifacts, not pull requests, so the
   * verdict is the job's own answer to "did the work run" and explains
   * the missing merge verdict the same way — and `unknown_node_verdicts`
   * tallies the recorded verdict words. `unknown_unresolved`
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
   * Jobs inside the unknown cohort whose standing verdict is the fleet's
   * recorded terminal no-op — an empty-family outcome phase
   * (`DONE-NOOP`/`EMPTY`/`EMPTY_DONE`/`SKIPPED-EMPTY`/`NOOP`) no later
   * launch-decision receipt superseded, joined as `noop`. dispatchd's
   * already-merged/terminal-target, recut-skip and repair-freshness
   * verdicts and restock's precheck retirements land here: the fleet
   * recorded that the job needed no publishable work, so the missing
   * merge verdict is explained rather than unresolved. The verdict
   * reads jobs-ledger rows only — no side ledger — so the tally is
   * available whenever the jobs read succeeded.
   */
  unknown_noop: number;
  /**
   * Top recorded no-op reasons inside the unknown cohort, by jobs — the
   * newest empty-family row's `reason` label (`already-merged`,
   * `target_pr_merged`/`target_pr_closed`,
   * `target_pr_conflicts_resolved`, `recut-already-merged`, the
   * precheck retirement labels) or `unlabeled` when the verdict row
   * carried no bounded reason. Empty when none recorded.
   */
  unknown_noop_reasons: { reason: string; jobs: number }[];
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
  /**
   * Jobs inside the unknown cohort whose newest work-market
   * route_decision recorded a non-empty `rejected_lanes` list — the
   * market's per-lane rejection record joined as `market_rejected`,
   * the per-lane why behind `no_runnable_lane`/`global_admission`
   * verdicts that `unknown_market_reasons` names only in aggregate.
   * Queue-side diagnostic context like `unknown_market_reasons`:
   * it explains which lanes the market turned the job away from and
   * never reduces `unknown_unresolved`.
   */
  unknown_market_rejected: number;
  /**
   * Top recorded market rejection codes inside the unknown cohort, by
   * jobs — each job contributes each code once however many lanes
   * rejected it for it (the same per-job-per-code rule the unfed
   * rejection accounting applies). Null-reasons entries contribute
   * nothing; a `market_rejected` of `[]` or `null` contributes
   * nothing — recorded-empty and missing evidence stay distinct
   * upstream. Diagnostic context only, never a reduction of
   * `unknown_unresolved`.
   */
  unknown_market_rejected_reasons: { reason: string; jobs: number }[];
  /**
   * Jobs inside the unknown cohort whose recorded session-handoff
   * advisory is a `rate-limit` verdict — the fleet's once-per-attempt
   * receipt that the job's run hit a provider usage-limit wall and
   * produced no usable work. Like a failure classification it explains
   * the missing merge verdict, so these jobs leave
   * `unknown_unresolved`. A `quota-exhausted` advisory — the pending
   * job's lane measured at zero quota, a verdict the producer writes
   * to the market ledger — is queue-side context tallied in
   * `unknown_handoff_triggers` but never reduces the remainder, the
   * same rule `unknown_market_reasons` follows: the job is still
   * waiting on capacity, not failed.
   */
  unknown_handoffs: number;
  /**
   * Top recorded session-handoff trigger labels inside the unknown
   * cohort, by jobs — `rate-limit` attempt kills (the jobs-ledger
   * verdict) and `quota-exhausted` pending-lane verdicts (accepted
   * producer vocabulary). Diagnostic context only; only the
   * rate-limit share is counted in `unknown_handoffs`.
   */
  unknown_handoff_triggers: { trigger: string; jobs: number }[];
  /**
   * Jobs inside the unknown cohort carrying the fleet's recorded
   * provider-wall lane hold — dispatchd's `autobackoff_hold` receipts
   * joined as `provider_wall_*`. A hold only lands on a failed or
   * no-work run (the auth scanner additionally requires its
   * `auth_failures` streak), so like a `rate-limit` handoff it is the
   * fleet's recorded receipt that the attempt died on a provider wall
   * — it explains the missing merge verdict and leaves
   * `unknown_unresolved` for both trigger families. Reads jobs-ledger
   * rows only, so the tally is real whenever the jobs read succeeded.
   */
  unknown_provider_walls: number;
  /**
   * Top recorded provider-wall trigger labels inside the unknown
   * cohort, by jobs — the fold's derived `usage-limit`/`auth-failure`
   * families; jobs whose pattern stayed outside the producer's
   * mirrored tables contribute to `unknown_provider_walls` but no
   * label here. Diagnostic context only.
   */
  unknown_provider_wall_triggers: { trigger: string; jobs: number }[];
  /**
   * Jobs inside the unknown cohort carrying the fleet's recorded
   * slot-throttle detection — dispatchd's `pool` receipts joined as
   * `pool_kind`. The receipt is scan-time evidence, not a terminal
   * verdict: the detector fires on a log-tail pattern match for any
   * job whose `.base` still stands, so a recovered run, an in-flight
   * run and a finished run all carry it — it never reduces
   * `unknown_unresolved`, the same rule `unknown_market_reasons`
   * follows: the job's terminal state stays genuinely unrecorded.
   * Reads jobs-ledger rows only, so the tally is real whenever the
   * jobs read succeeded.
   */
  unknown_pool_throttles: number;
  /**
   * Top recorded pool throttle classes inside the unknown cohort, by
   * jobs — the producer's closed CLS vocabulary (`credits_exhausted`,
   * `usage_limit`, `model_capacity`, `rate_limit`). Diagnostic
   * context only; never a reduction of `unknown_unresolved`.
   */
  unknown_pool_kinds: { kind: string; jobs: number }[];
  /**
   * Jobs inside the unknown cohort carrying recorded merge-queue
   * evidence — the merge-events.jsonl observations joined as
   * `merge_queue` for the job's standing PR, so a job still awaiting
   * its merge verdict reads with the queue-side history the fleet
   * recorded for its PR. `unknown_merge_queue_blocked` counts those
   * whose recorded merge queue blocked the PR at least once, and
   * `unknown_merge_queue_blocked_reasons` tallies the distinct
   * recorded blocker codes — each job contributes each reason once —
   * most jobs first. `unknown_merge_queue_check_failures`,
   * `unknown_merge_queue_conflicts`, `unknown_merge_queue_retries`
   * and `unknown_merge_queue_recuts` count the same cohort's jobs
   * whose PR recorded at least one failed check observation, merge
   * conflict, merge-retry request or recut request. Queue-side
   * diagnostic context like `unknown_market_reasons`: it explains
   * what the merge queue was doing with the PR and never reduces
   * `unknown_unresolved` — a job still awaiting a merge verdict
   * stays unresolved however the queue treated it.
   */
  unknown_merge_queue: number;
  unknown_merge_queue_blocked: number;
  unknown_merge_queue_blocked_reasons: { reason: string; jobs: number }[];
  unknown_merge_queue_check_failures: number;
  unknown_merge_queue_conflicts: number;
  unknown_merge_queue_retries: number;
  unknown_merge_queue_recuts: number;
  /**
   * Jobs inside the unknown cohort carrying the node runner's recorded
   * execution verdict — `phm-node-runner.v1` finish rows joined as
   * `node_outcome`: the offloaded node-pack job's terminal verdict
   * (`succeeded`/`fenced`/`failed`). Node-pack jobs produce result
   * artifacts, not pull requests, so the verdict is the job's own
   * answer to "did the work run" — like a failure classification it
   * explains the missing merge verdict, so these jobs leave
   * `unknown_unresolved` for all three verdict words: a `failed` or
   * `fenced` attempt is the recorded failure signal, and a
   * `succeeded` attempt is the recorded terminal success the node
   * path was built to produce. `unknown_node_verdicts` tallies the
   * recorded verdict words, most jobs first. Reads jobs-ledger rows
   * only, so the tallies are real whenever the jobs read succeeded.
   */
  unknown_node_outcomes: number;
  unknown_node_verdicts: { verdict: string; jobs: number }[];
  /**
   * Jobs inside the unknown cohort carrying the standing PR's newest
   * recorded cross-model review verdict — `cross_review` joined from
   * <ashlr>/fleet/cross-review.jsonl through the job's unambiguous
   * canonical PR claim. Review-gate context like the merge-queue join:
   * a `reject` is the recorded reason the PR may never merge, so it
   * explains the missing merge verdict without ever reducing
   * `unknown_unresolved` (a review verdict is not a merge verdict).
   * `unknown_cross_review_verdicts` tallies the recorded verdict words
   * (`approve`/`reject`/`failed`/`skipped`), most jobs first. Reads the
   * cross-review side ledger, so the tallies are real only when that
   * tail was read.
   */
  unknown_cross_reviews: number;
  unknown_cross_review_verdicts: { verdict: string; jobs: number }[];
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
  /**
   * Top recorded `repo` labels across every folded outcome — known,
   * unknown and unclassified alike, since repo identity is not merge
   * evidence (the same scope rule usage_missing/usage_sources follow).
   * Each entry is the repo the job targeted in the outcome fold's
   * bounded repo-label shape, so an operator sees which repos the
   * retained window's outcomes came from. Empty when no outcome
   * recorded one; counts cover the retained window.
   */
  repos: { repo: string; jobs: number }[];
}

/** Running tallies for the outcome-quality signals; every count starts at zero and means stay sums until emitted. */
interface WeightEvidenceTally {
  ciPass: number; ciKnown: number;
  reviewFixed: number; reviewRejected: number; reviewIgnored: number; reviewKnown: number;
  crossApprove: number; crossReject: number; crossFailed: number; crossSkipped: number; crossReviewKnown: number;
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
  poolPctSum: number; poolPctKnown: number;
  launchCost: number; launchCostMeasured: number;
  launchPeakSum: number; launchPeakKnown: number;
  launchCpuSum: number; launchCpuKnown: number;
  launchCpuPeakSum: number; launchCpuPeakKnown: number;
  diffFilesSum: number; diffFilesKnown: number;
  diffLinesSum: number; diffLinesKnown: number;
  usageMissingKnown: number;
  laneOverrides: number;
  overrideReasons: Map<string, number>;
  marketRejected: number;
  rejectedReasons: Map<string, number>;
  handoff: number;
  handoffTriggers: Map<string, number>;
  providerWall: number;
  providerWallTriggers: Map<string, number>;
  pool: number;
  poolKinds: Map<string, number>;
  mergeQueue: number;
  mergeQueueBlocked: number;
  mergeQueueBlockedReasons: Map<string, number>;
  mergeQueueCheckFailures: number;
  mergeQueueConflicts: number;
  mergeQueueRetries: number;
  mergeQueueRecuts: number;
  repos: number;
  repoLabels: Map<string, number>;
  nodeOutcomes: number;
  nodeVerdicts: Map<string, number>;
}

const freshTally = (): WeightEvidenceTally => ({
  ciPass: 0, ciKnown: 0, reviewFixed: 0, reviewRejected: 0, reviewIgnored: 0, reviewKnown: 0,
  crossApprove: 0, crossReject: 0, crossFailed: 0, crossSkipped: 0, crossReviewKnown: 0,
  costSum: 0, costKnown: 0, wallSum: 0, wallKnown: 0, ttmSum: 0, ttmKnown: 0,
  queueWaitSum: 0, queueWaitKnown: 0, ciWallSum: 0, ciWallKnown: 0,
  publishWaitSum: 0, publishWaitKnown: 0,
  laneBlocked: 0, blockedReasons: new Map(),
  tokensSum: 0, tokensKnown: 0, passkSum: 0, passkKnown: 0,
  acusSum: 0, acusKnown: 0, poolPctSum: 0, poolPctKnown: 0,
  launchCost: 0, launchCostMeasured: 0,
  launchPeakSum: 0, launchPeakKnown: 0, launchCpuSum: 0, launchCpuKnown: 0,
  launchCpuPeakSum: 0, launchCpuPeakKnown: 0,
  diffFilesSum: 0, diffFilesKnown: 0, diffLinesSum: 0, diffLinesKnown: 0, usageMissingKnown: 0,
  laneOverrides: 0, overrideReasons: new Map(),
  marketRejected: 0, rejectedReasons: new Map(),
  handoff: 0, handoffTriggers: new Map(),
  providerWall: 0, providerWallTriggers: new Map(),
  pool: 0, poolKinds: new Map(),
  mergeQueue: 0, mergeQueueBlocked: 0, mergeQueueBlockedReasons: new Map(),
  mergeQueueCheckFailures: 0, mergeQueueConflicts: 0, mergeQueueRetries: 0,
  mergeQueueRecuts: 0, repos: 0, repoLabels: new Map(),
  nodeOutcomes: 0, nodeVerdicts: new Map(),
});

/** Top recorded lane-hint blocking codes kept per group, most jobs first. */
const MAX_BLOCKED_REASONS = 8;
/** Top recorded market rejection codes kept per group, most jobs first. */
const MAX_REJECTED_REASONS = 8;
/** Top recorded merge-queue blocker codes kept per group, most jobs first. */
const MAX_MERGE_QUEUE_REASONS = 8;

/**
 * The batch-member task_outcome words that end the attempt without a
 * publish — dispatchd's batcher.RETRY set. `done`/`skipped` members hand
 * off to their own per-job publish and stay awaiting-verdict unresolved;
 * the requeue words are the member's recorded failure signal.
 */
const TASK_OUTCOME_RETRY: ReadonlySet<string> = new Set(['failed', 'deferred', 'unreported']);

const MAX_OVERRIDE_REASONS = 8;
/** Top recorded handoff trigger labels kept per group and in the unknown cohort, most jobs first. */
const MAX_HANDOFF_TRIGGERS = 8;
/** Top recorded provider-wall trigger labels kept per group and in the unknown cohort, most jobs first. */
const MAX_PROVIDER_WALL_TRIGGERS = 8;
/** Top recorded pool throttle classes kept per group and in the unknown cohort, most jobs first. */
const MAX_POOL_KINDS = 8;
/** Top recorded repo labels kept per group and at set level, most jobs first. */
const MAX_REPOS = 8;
/** Top recorded node-runner verdict words kept per group and in the unknown cohort, most jobs first. */
const MAX_NODE_VERDICTS = 8;
/** Top recorded cross-review verdict words kept in the unknown cohort, most jobs first. */
const MAX_CROSS_REVIEW_VERDICTS = 8;

const evidenceOf = (t: WeightEvidenceTally): RouterWeightEvidence => ({
  ci_first_pass_known: t.ciKnown,
  ci_first_pass_rate: t.ciKnown === 0 ? null : round6(t.ciPass / t.ciKnown),
  review_findings_known: t.reviewKnown,
  review_findings: t.reviewKnown === 0 ? null
    : { fixed: t.reviewFixed, rejected: t.reviewRejected, ignored: t.reviewIgnored },
  cross_review_known: t.crossReviewKnown,
  cross_review: t.crossReviewKnown === 0 ? null
    : { approve: t.crossApprove, reject: t.crossReject, failed: t.crossFailed, skipped: t.crossSkipped },
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
  lane_blocked_reasons: t.laneBlocked === 0 ? null : topJobs(t.blockedReasons, 'reason', MAX_BLOCKED_REASONS),
  tokens_known: t.tokensKnown,
  tokens_total_mean: t.tokensKnown === 0 ? null : round6(t.tokensSum / t.tokensKnown),
  passk_known: t.passkKnown,
  passk_mean: t.passkKnown === 0 ? null : round6(t.passkSum / t.passkKnown),
  acus_known: t.acusKnown,
  acus_mean: t.acusKnown === 0 ? null : round6(t.acusSum / t.acusKnown),
  pool_pct_used_known: t.poolPctKnown,
  pool_pct_used_mean: t.poolPctKnown === 0 ? null : round6(t.poolPctSum / t.poolPctKnown),
  launch_cost_known: t.launchCost,
  launch_cost_measured: t.launchCostMeasured,
  launch_peak_processes_mean: t.launchPeakKnown === 0 ? null : round6(t.launchPeakSum / t.launchPeakKnown),
  launch_cpu_pct_mean: t.launchCpuKnown === 0 ? null : round6(t.launchCpuSum / t.launchCpuKnown),
  launch_cpu_pct_peak_mean: t.launchCpuPeakKnown === 0 ? null : round6(t.launchCpuPeakSum / t.launchCpuPeakKnown),
  diff_files_known: t.diffFilesKnown,
  diff_files_mean: t.diffFilesKnown === 0 ? null : round6(t.diffFilesSum / t.diffFilesKnown),
  diff_lines_known: t.diffLinesKnown,
  diff_lines_mean: t.diffLinesKnown === 0 ? null : round6(t.diffLinesSum / t.diffLinesKnown),
  usage_missing_known: t.usageMissingKnown,
  lane_overrides_known: t.laneOverrides,
  lane_override_reasons: t.laneOverrides === 0 ? null : topJobs(t.overrideReasons, 'reason', MAX_OVERRIDE_REASONS),
  market_rejected_known: t.marketRejected,
  market_rejected_reasons: t.marketRejected === 0 ? null : topJobs(t.rejectedReasons, 'reason', MAX_REJECTED_REASONS),
  handoff_known: t.handoff,
  handoff_triggers: t.handoff === 0 ? null : topJobs(t.handoffTriggers, 'trigger', MAX_HANDOFF_TRIGGERS),
  provider_wall_known: t.providerWall,
  provider_wall_triggers: t.providerWall === 0 ? null : topJobs(t.providerWallTriggers, 'trigger', MAX_PROVIDER_WALL_TRIGGERS),
  pool_known: t.pool,
  pool_kinds: t.pool === 0 ? null : topJobs(t.poolKinds, 'kind', MAX_POOL_KINDS),
  merge_queue_known: t.mergeQueue,
  merge_queue_blocked_known: t.mergeQueueBlocked,
  merge_queue_blocked_reasons: t.mergeQueueBlocked === 0 ? null : topJobs(t.mergeQueueBlockedReasons, 'reason', MAX_MERGE_QUEUE_REASONS),
  merge_queue_check_failures_known: t.mergeQueueCheckFailures,
  merge_queue_conflicts_known: t.mergeQueueConflicts,
  merge_queue_retries_known: t.mergeQueueRetries,
  merge_queue_recuts_known: t.mergeQueueRecuts,
  repos_known: t.repos,
  repos: t.repos === 0 ? null : topJobs(t.repoLabels, 'repo', MAX_REPOS),
  node_outcomes_known: t.nodeOutcomes,
  node_verdicts: t.nodeOutcomes === 0 ? null : topJobs(t.nodeVerdicts, 'verdict', MAX_NODE_VERDICTS),
});

/**
 * Groups by (work_class, lane). Missing, invalid or placeholder IDs are unclassified; merged:null is unknown and
 * excluded from evidence. A group below minSamples is refused and keeps its baseline. Otherwise the
 * weight moves toward the observed held-merge rate — merged outcomes recorded as reverted count as
 * known evidence but never as held merges — capped at maxShift and clamped to [0, 1]. Each proposal
 * also reports the group's other recorded outcome signals (CI verdicts, review findings, cost, wall
 * time, merge latency, queue-admission wait, CI wall, publish-station
 * wait, pass^k, dispatch lane
 * overrides, lane-hint blocking codes, session-handoff advisories,
 * provider-wall lane holds, slot-throttle detections, node-runner
 * execution verdicts, merge-queue
 * friction and the recorded repo mix)
 * as advisory evidence over
 * the same known cohort. Recorded lane-hint blocking codes
 * (`lane_hint_blocked_by`) tally per group as
 * `lane_blocked_known`/`lane_blocked_reasons` — the market's reasons
 * the hinted lane could not take the work. Recorded session-handoff
 * advisories (`handoff_trigger`) tally per group as
 * `handoff_known`/`handoff_triggers` — the provider-wall verdicts the
 * fleet recorded on the group's jobs — and the confirmed
 * autobackoff lane holds (`provider_wall_*`) tally as
 * `provider_wall_known`/`provider_wall_triggers`, the hold receipts
 * covering the auth walls advisories never see.
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
  const noopReasons = new Map<string, number>();
  const marketReasons = new Map<string, number>();
  const marketRejectedReasons = new Map<string, number>();
  const handoffTriggersUnknown = new Map<string, number>();
  const providerWallTriggersUnknown = new Map<string, number>();
  const poolKindsUnknown = new Map<string, number>();
  const nodeVerdictsUnknown = new Map<string, number>();
  const crossReviewVerdictsUnknown = new Map<string, number>();
  const mergeQueueBlockedReasonsUnknown = new Map<string, number>();
  const usageMissing = new Map<string, number>();
  const usageSources = new Map<string, number>();
  const repos = new Map<string, number>();
  let unknownSkipped = 0;
  let unknownDeferred = 0;
  let unknownNoop = 0;
  let unknownMarketRejected = 0;
  let unknownHandoffs = 0;
  let unknownProviderWalls = 0;
  let unknownPoolThrottles = 0;
  let unknownNodeOutcomes = 0;
  let unknownCrossReviews = 0;
  let unknownMergeQueue = 0;
  let unknownMergeQueueBlocked = 0;
  let unknownMergeQueueCheckFailures = 0;
  let unknownMergeQueueConflicts = 0;
  let unknownMergeQueueRetries = 0;
  let unknownMergeQueueRecuts = 0;
  for (const o of outcomes) {
    // Usage provenance is capture evidence, not merge evidence: every folded
    // outcome tallies its recorded labels — classified or not.
    if (o.usage_missing !== null) usageMissing.set(o.usage_missing, (usageMissing.get(o.usage_missing) ?? 0) + 1);
    if (o.usage_source !== null) usageSources.set(o.usage_source, (usageSources.get(o.usage_source) ?? 0) + 1);
    // Repo identity is capture evidence like usage provenance, not merge
    // evidence: every folded outcome tallies its recorded repo —
    // classified or not.
    if (o.repo !== null) repos.set(o.repo, (repos.get(o.repo) ?? 0) + 1);
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
      // and explains it the same way. The fleet's recorded terminal
      // no-op verdict (an empty-family outcome phase — DONE-NOOP and kin —
      // that no later launch-decision receipt superseded) is the
      // recorded "no publishable work needed" decision: the job never
      // ran because the fleet already resolved its target, so it
      // explains the missing merge verdict the same way. A job carrying
      // none of them has no recorded launch decision — it finished
      // cleanly awaiting a verdict or is still in flight.
      const empty = o.empty === true;
      const nonzeroExit = o.exit_code !== null && o.exit_code !== 0;
      const requeued = o.task_outcome !== null && TASK_OUTCOME_RETRY.has(o.task_outcome);
      const declined = o.skipped === true;
      const deferred = o.deferred === true;
      const noop = o.noop === true;
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
      if (noop) {
        unknownNoop++;
        const key = o.noop_reason ?? 'unlabeled';
        noopReasons.set(key, (noopReasons.get(key) ?? 0) + 1);
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
      // The market's per-lane rejection record is the same kind of
      // queue-side diagnostic: each job contributes each recorded
      // rejection code once however many lanes rejected it for it.
      // It never feeds the unresolved remainder.
      if (o.market_rejected !== null && o.market_rejected.length > 0) {
        unknownMarketRejected++;
        const rejectedCodes = new Set<string>();
        for (const entry of o.market_rejected) {
          if (entry.reasons === null) continue;
          for (const code of entry.reasons) rejectedCodes.add(code);
        }
        for (const code of rejectedCodes) {
          marketRejectedReasons.set(code, (marketRejectedReasons.get(code) ?? 0) + 1);
        }
      }
      // The fleet's session-handoff advisory is recorded provider-wall
      // evidence: a `rate-limit` verdict means the job's run attempt
      // died on a usage-limit wall with no usable work — the same kind
      // of recorded failure signal failure_class carries, so it
      // explains the missing merge verdict and leaves
      // unknown_unresolved. A `quota-exhausted` verdict is queue-side
      // context — the pending job's lane measured at zero quota —
      // tallied diagnostically like market_reasons and never a
      // reduction of the remainder.
      if (o.handoff_trigger !== null) {
        handoffTriggersUnknown.set(o.handoff_trigger, (handoffTriggersUnknown.get(o.handoff_trigger) ?? 0) + 1);
        if (o.handoff_trigger === 'rate-limit') unknownHandoffs++;
      }
      // The fleet's autobackoff lane hold is the confirmed provider-wall
      // verdict: it only lands on a failed or no-work run (the auth
      // scanner additionally requires its auth_failures streak), so —
      // like a rate-limit handoff — it explains the missing merge
      // verdict for both trigger families and leaves unknown_unresolved.
      // A hold whose pattern stayed outside the producer's mirrored
      // tables still counts: the receipt is the verdict, the family
      // label is only its classification.
      if (o.provider_wall_pattern !== null) {
        unknownProviderWalls++;
        if (o.provider_wall_trigger !== null) {
          providerWallTriggersUnknown.set(o.provider_wall_trigger, (providerWallTriggersUnknown.get(o.provider_wall_trigger) ?? 0) + 1);
        }
      }
      // The slot-throttle detector's receipt is scan-time evidence,
      // not a terminal verdict: it fires on a log-tail pattern match
      // for any job whose `.base` still stands, so a recovered run,
      // an in-flight run and a finished run all carry it. Like the
      // market verdicts it is queue-side diagnostic — it tallies the
      // recorded throttle classes but never feeds the unresolved
      // remainder: the job's terminal state stays genuinely
      // unrecorded however the detector classified its log tail.
      if (o.pool_kind !== null) {
        unknownPoolThrottles++;
        poolKindsUnknown.set(o.pool_kind, (poolKindsUnknown.get(o.pool_kind) ?? 0) + 1);
      }
      // The node runner's finish row is the offloaded job's recorded
      // terminal execution verdict — node-pack jobs produce result
      // artifacts, not pull requests, so `merged` stays null however
      // the pack ended. All three verdict words are the fleet's
      // recorded answer to "did the work run": `failed`/`fenced` are
      // the attempt's recorded failure signal and `succeeded` is the
      // terminal success the node path exists to produce — each
      // explains the missing merge verdict the same way a failure
      // classification does, so every one leaves unknown_unresolved.
      if (o.node_outcome !== null) {
        unknownNodeOutcomes++;
        nodeVerdictsUnknown.set(o.node_outcome, (nodeVerdictsUnknown.get(o.node_outcome) ?? 0) + 1);
      }
      // The merge-queue join is queue-side diagnostic like the market
      // verdicts: each job's standing PR carried recorded merge-events
      // observations — blocked reasons, check failures, conflicts,
      // retries, recuts — explaining what the merge queue was doing
      // while the merge verdict stayed unrecorded. It never feeds the
      // unresolved remainder: a job still awaiting a merge verdict
      // stays unresolved however the queue treated its PR.
      if (o.merge_queue !== null) {
        unknownMergeQueue++;
        if (o.merge_queue.blocked_reasons.length > 0) {
          unknownMergeQueueBlocked++;
          for (const reason of o.merge_queue.blocked_reasons) {
            mergeQueueBlockedReasonsUnknown.set(reason, (mergeQueueBlockedReasonsUnknown.get(reason) ?? 0) + 1);
          }
        }
        if (o.merge_queue.check_failures > 0) unknownMergeQueueCheckFailures++;
        if (o.merge_queue.conflicts > 0) unknownMergeQueueConflicts++;
        if (o.merge_queue.retries > 0) unknownMergeQueueRetries++;
        if (o.merge_queue.recuts > 0) unknownMergeQueueRecuts++;
      }
      // The cross-review join is review-gate context like the merge-queue
      // join: the standing PR's newest recorded cross-model verdict
      // (approve/reject the reviewer's answers, failed/skipped the
      // recorded non-verdicts) explains what the review gate saw while
      // the merge verdict stayed unrecorded — a `reject` is the recorded
      // reason the PR may never merge. It never feeds the unresolved
      // remainder: a review verdict is not a merge verdict, so the job
      // stays unresolved however the reviewer ruled.
      if (o.cross_review !== null) {
        unknownCrossReviews++;
        crossReviewVerdictsUnknown.set(o.cross_review.outcome, (crossReviewVerdictsUnknown.get(o.cross_review.outcome) ?? 0) + 1);
      }
      if (!empty && !nonzeroExit && o.failure_class === null && !requeued && !declined && !deferred && !noop && o.handoff_trigger !== 'rate-limit' && o.provider_wall_pattern === null && o.node_outcome === null) unknownUnresolved++;
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
    // The cross-review join is the standing PR's newest recorded
    // cross-model verdict — approve/reject are the reviewer's answers,
    // failed/skipped the recorded non-verdicts. Advisory context like
    // review_findings: it tallies the verdict mix, never the weight.
    if (o.cross_review !== null) {
      t.crossReviewKnown++;
      if (o.cross_review.outcome === 'approve') t.crossApprove++;
      else if (o.cross_review.outcome === 'reject') t.crossReject++;
      else if (o.cross_review.outcome === 'failed') t.crossFailed++;
      else t.crossSkipped++;
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
    if (o.pool_pct_used !== null) { t.poolPctKnown++; t.poolPctSum += o.pool_pct_used; }
    if (o.launch_cost_status !== null) {
      t.launchCost++;
      if (o.launch_cost_status === 'measured') t.launchCostMeasured++;
      if (o.launch_peak_processes !== null) { t.launchPeakKnown++; t.launchPeakSum += o.launch_peak_processes; }
      if (o.launch_mean_cpu_pct !== null) { t.launchCpuKnown++; t.launchCpuSum += o.launch_mean_cpu_pct; }
      if (o.launch_peak_cpu_pct !== null) { t.launchCpuPeakKnown++; t.launchCpuPeakSum += o.launch_peak_cpu_pct; }
    }
    if (o.diff_files !== null) { t.diffFilesKnown++; t.diffFilesSum += o.diff_files; }
    if (o.diff_lines !== null) { t.diffLinesKnown++; t.diffLinesSum += o.diff_lines; }
    if (o.usage_missing !== null) t.usageMissingKnown++;
    if (o.lane_override !== null) {
      t.laneOverrides++;
      t.overrideReasons.set(o.lane_override, (t.overrideReasons.get(o.lane_override) ?? 0) + 1);
    }
    if (o.market_rejected !== null && o.market_rejected.length > 0) {
      t.marketRejected++;
      const rejectedCodes = new Set<string>();
      for (const entry of o.market_rejected) {
        if (entry.reasons === null) continue;
        for (const code of entry.reasons) rejectedCodes.add(code);
      }
      for (const code of rejectedCodes) {
        t.rejectedReasons.set(code, (t.rejectedReasons.get(code) ?? 0) + 1);
      }
    }
    if (o.handoff_trigger !== null) {
      t.handoff++;
      t.handoffTriggers.set(o.handoff_trigger, (t.handoffTriggers.get(o.handoff_trigger) ?? 0) + 1);
    }
    if (o.provider_wall_pattern !== null) {
      t.providerWall++;
      if (o.provider_wall_trigger !== null) {
        t.providerWallTriggers.set(o.provider_wall_trigger, (t.providerWallTriggers.get(o.provider_wall_trigger) ?? 0) + 1);
      }
    }
    if (o.pool_kind !== null) {
      t.pool++;
      t.poolKinds.set(o.pool_kind, (t.poolKinds.get(o.pool_kind) ?? 0) + 1);
    }
    if (o.node_outcome !== null) {
      t.nodeOutcomes++;
      t.nodeVerdicts.set(o.node_outcome, (t.nodeVerdicts.get(o.node_outcome) ?? 0) + 1);
    }
    if (o.merge_queue !== null) {
      t.mergeQueue++;
      if (o.merge_queue.blocked_reasons.length > 0) {
        t.mergeQueueBlocked++;
        for (const reason of o.merge_queue.blocked_reasons) {
          t.mergeQueueBlockedReasons.set(reason, (t.mergeQueueBlockedReasons.get(reason) ?? 0) + 1);
        }
      }
      if (o.merge_queue.check_failures > 0) t.mergeQueueCheckFailures++;
      if (o.merge_queue.conflicts > 0) t.mergeQueueConflicts++;
      if (o.merge_queue.retries > 0) t.mergeQueueRetries++;
      if (o.merge_queue.recuts > 0) t.mergeQueueRecuts++;
    }
    if (o.repo !== null) {
      t.repos++;
      t.repoLabels.set(o.repo, (t.repoLabels.get(o.repo) ?? 0) + 1);
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
  const topFailureClasses = topJobs(failureClasses, 'failure_class');
  const topEmptyClasses = topJobs(emptyClasses, 'empty_class');
  const topTaskOutcomes = topJobs(taskOutcomes, 'task_outcome');
  const topSkipReasons = topJobs(skipReasons, 'reason');
  const topEmptyTags = topJobs(emptyTags, 'tag');
  const topDeferReasons = topJobs(deferReasons, 'reason');
  const topNoopReasons = topJobs(noopReasons, 'reason');
  const topMarketReasons = topJobs(marketReasons, 'reason');
  const topMarketRejectedReasons = topJobs(marketRejectedReasons, 'reason');
  const topHandoffTriggers = topJobs(handoffTriggersUnknown, 'trigger', MAX_HANDOFF_TRIGGERS);
  const topProviderWallTriggers = topJobs(providerWallTriggersUnknown, 'trigger', MAX_PROVIDER_WALL_TRIGGERS);
  const topPoolKinds = topJobs(poolKindsUnknown, 'kind', MAX_POOL_KINDS);
  const topNodeVerdicts = topJobs(nodeVerdictsUnknown, 'verdict', MAX_NODE_VERDICTS);
  const topCrossReviewVerdicts = topJobs(crossReviewVerdictsUnknown, 'verdict', MAX_CROSS_REVIEW_VERDICTS);
  const topMergeQueueBlockedReasons = topJobs(mergeQueueBlockedReasonsUnknown, 'reason');
  const topUsageMissing = topJobs(usageMissing, 'usage_missing');
  const topUsageSources = topJobs(usageSources, 'usage_source');
  const topRepos = topJobs(repos, 'repo', MAX_REPOS);
  return { proposals, known_outcomes: known, unknown_outcomes: unknown, unclassified_outcomes: unclassified,
    unknown_empty: unknownEmpty, unknown_nonzero_exit: unknownNonzeroExit,
    unknown_failure_classes: topFailureClasses, unknown_empty_classes: topEmptyClasses,
    unknown_task_outcomes: topTaskOutcomes, unknown_skipped: unknownSkipped,
    unknown_skip_reasons: topSkipReasons, unknown_empty_tags: topEmptyTags,
    unknown_deferred: unknownDeferred, unknown_defer_reasons: topDeferReasons,
    unknown_noop: unknownNoop, unknown_noop_reasons: topNoopReasons,
    unknown_market_reasons: topMarketReasons,
    unknown_market_rejected: unknownMarketRejected,
    unknown_market_rejected_reasons: topMarketRejectedReasons,
    unknown_handoffs: unknownHandoffs,
    unknown_handoff_triggers: topHandoffTriggers,
    unknown_provider_walls: unknownProviderWalls,
    unknown_provider_wall_triggers: topProviderWallTriggers,
    unknown_pool_throttles: unknownPoolThrottles,
    unknown_pool_kinds: topPoolKinds,
    unknown_node_outcomes: unknownNodeOutcomes,
    unknown_node_verdicts: topNodeVerdicts,
    unknown_cross_reviews: unknownCrossReviews,
    unknown_cross_review_verdicts: topCrossReviewVerdicts,
    unknown_merge_queue: unknownMergeQueue,
    unknown_merge_queue_blocked: unknownMergeQueueBlocked,
    unknown_merge_queue_blocked_reasons: topMergeQueueBlockedReasons,
    unknown_merge_queue_check_failures: unknownMergeQueueCheckFailures,
    unknown_merge_queue_conflicts: unknownMergeQueueConflicts,
    unknown_merge_queue_retries: unknownMergeQueueRetries,
    unknown_merge_queue_recuts: unknownMergeQueueRecuts,
    unknown_unresolved: unknownUnresolved,
    usage_missing: topUsageMissing, usage_sources: topUsageSources,
    repos: topRepos };
}

export interface RouterWeightProposalReport {
  schema: 'router.weight-proposals.v1';
  /** Always true: proposals are never applied to routing, rank, admission or weights.json. */
  advisory_only: true;
  as_of: string;
  source: {
    readonly pr: 6794;
    readonly head_sha: 'f9e484e87ec2d01f155cc280e818d2e98519dbe7';
    readonly recovered_from: 'src/core/router/tune.ts#proposeRouterWeights';
  };
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
  /**
   * Health of the merge-events.jsonl tail behind merge_queue joins and
   * the unknown_merge_queue_* tallies. Anything but 'read' means no
   * merge-queue evidence joined — the tallies are then null (coverage
   * unknown), never an empty list claiming no merge friction was
   * recorded.
   */
  merge_events_state: RouterOutcomeRead['merge_events_state'];
  /** True when the merge-events tail was cut; joined evidence covers only the newest bytes. */
  merge_events_truncated: boolean;
  /**
   * Health of the revert-outcomes.jsonl ledger behind scan-detected
   * revert joins. Anything but 'read' means no `phm fleet reverts
   * --record` detections joined — held-merge tallies then see only
   * jobs-ledger, authority-ledger and explicit revert evidence.
   */
  revert_ledger_state: RouterOutcomeRead['revert_ledger_state'];
  /**
   * Health of the reward-signals.jsonl tail behind the reward-signal
   * joins — resolved merge verdicts recovered for jobs the bounded
   * jobs tail dropped plus pool_pct_used evidence. Anything but
   * 'read' means no reward rows joined; pool_pct_used then reads null
   * for every group, never a zeroed figure.
   */
  reward_state: RouterOutcomeRead['reward_state'];
  /** True when the reward tail was cut; joined evidence covers only the newest bytes. */
  reward_truncated: boolean;
  /**
   * Health of the launch-cost.jsonl tail behind the launch_cost_*
   * outcome joins and the per-group launch-cost evidence. Anything but
   * 'read' means no launch-cost rows joined — every group's
   * launch_cost_known reads 0 and the means stay null, never a
   * zeroed or guessed resource figure.
   */
  launch_cost_state: RouterOutcomeRead['launch_cost_state'];
  /** True when the launch-cost tail was cut; joined evidence covers only the newest bytes. */
  launch_cost_truncated: boolean;
  /**
   * Health of the cross-review.jsonl tail under the ASHLR home root
   * behind cross_review joins and the cross_review/unknown_cross_review_*
   * tallies. Anything but 'read' means no review verdicts joined — the
   * tallies then read 0/null, never an empty list claiming no reviews
   * were recorded.
   */
  cross_review_state: RouterOutcomeRead['cross_review_state'];
  /** True when the cross-review tail was cut; joined verdicts cover only the newest bytes. */
  cross_review_truncated: boolean;
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
   * Jobs inside the unknown cohort whose standing verdict is the fleet's
   * recorded terminal no-op — see RouterWeightProposalSet. Null when the
   * ledger was not read; 0 is a real measurement.
   */
  unknown_noop: number | null;
  /**
   * Top recorded no-op reasons inside the unknown cohort, by jobs —
   * `already-merged`, `target_pr_*`, `recut-already-merged`, the precheck
   * retirement labels and `unlabeled` for verdicts whose reason did not
   * join. Null when the ledger was not read; empty when none recorded.
   */
  unknown_noop_reasons: { reason: string; jobs: number }[] | null;
  /**
   * Top recorded work-market `reason_codes` inside the unknown cohort,
   * by jobs — the market's routing verdict for each job's newest
   * route_decision row (see RouterWeightProposalSet). Null when the
   * ledger was not read; empty when read but no unknown-cohort outcome
   * carried market reasons.
   */
  unknown_market_reasons: { reason: string; jobs: number }[] | null;
  /**
   * Jobs inside the unknown cohort whose newest route_decision recorded
   * a non-empty rejected_lanes list — see RouterWeightProposalSet.
   * Null when the ledger was not read; 0 is a real measurement.
   */
  unknown_market_rejected: number | null;
  /**
   * Top recorded market rejection codes inside the unknown cohort, by
   * jobs — each job contributes each code once however many lanes
   * rejected it for it (see RouterWeightProposalSet). Null when the
   * ledger was not read; empty when read but no unknown-cohort outcome
   * carried rejection codes.
   */
  unknown_market_rejected_reasons: { reason: string; jobs: number }[] | null;
  /**
   * Jobs inside the unknown cohort whose recorded session-handoff
   * advisory is a `rate-limit` verdict — see RouterWeightProposalSet.
   * Reads jobs-ledger rows only, so the tally is real whenever the
   * jobs read succeeded. Null when the ledger was not read; 0 is a
   * real measurement.
   */
  unknown_handoffs: number | null;
  /**
   * Top recorded session-handoff trigger labels inside the unknown
   * cohort, by jobs — `rate-limit` attempt kills and `quota-exhausted`
   * pending-lane verdicts (see RouterWeightProposalSet). Null when the
   * ledger was not read; empty when none recorded.
   */
  unknown_handoff_triggers: { trigger: string; jobs: number }[] | null;
  /**
   * Jobs inside the unknown cohort carrying the fleet's recorded
   * provider-wall lane hold — see RouterWeightProposalSet. Reads
   * jobs-ledger rows only, so the tally is real whenever the jobs
   * read succeeded. Null when the ledger was not read; 0 is a real
   * measurement.
   */
  unknown_provider_walls: number | null;
  /**
   * Top recorded provider-wall trigger labels inside the unknown
   * cohort, by jobs — `usage-limit`/`auth-failure` (see
   * RouterWeightProposalSet). Null when the ledger was not read;
   * empty when none recorded.
   */
  unknown_provider_wall_triggers: { trigger: string; jobs: number }[] | null;
  /**
   * Jobs inside the unknown cohort carrying the fleet's recorded
   * slot-throttle detection — dispatchd's `pool` receipts joined as
   * `pool_kind` (see RouterWeightProposalSet). Scan-time diagnostic
   * context only; never reduces unknown_unresolved. Reads
   * jobs-ledger rows only, so the tally is real whenever the jobs
   * read succeeded. Null when the ledger was not read; 0 is a real
   * measurement.
   */
  unknown_pool_throttles: number | null;
  /**
   * Top recorded pool throttle classes inside the unknown cohort, by
   * jobs — the producer's closed CLS vocabulary (`credits_exhausted`,
   * `usage_limit`, `model_capacity`, `rate_limit`). Diagnostic
   * context only; never a reduction of unknown_unresolved. Null when
   * the ledger was not read; empty when none recorded.
   */
  unknown_pool_kinds: { kind: string; jobs: number }[] | null;
  /**
   * Jobs inside the unknown cohort carrying the node runner's recorded
   * execution verdict — see RouterWeightProposalSet. The node-pack job's
   * terminal verdict (`succeeded`/`fenced`/`failed`) is its own answer
   * to "did the work run", so these jobs leave unknown_unresolved.
   * Reads jobs-ledger rows only, so the tally is real whenever the jobs
   * read succeeded. Null when the ledger was not read; 0 is a real
   * measurement.
   */
  unknown_node_outcomes: number | null;
  /**
   * Top recorded node-runner verdict words inside the unknown cohort,
   * by jobs — `succeeded`/`fenced`/`failed` (see
   * RouterWeightProposalSet). Null when the ledger was not read; empty
   * when none recorded.
   */
  unknown_node_verdicts: { verdict: string; jobs: number }[] | null;
  /**
   * Jobs inside the unknown cohort carrying the standing PR's newest
   * recorded cross-model review verdict — see RouterWeightProposalSet.
   * Review-gate context only; never reduces unknown_unresolved. Null
   * when the ledger was not read or the cross-review ledger was not
   * read (review coverage unknown); 0 is a real measurement when the
   * tail was read.
   */
  unknown_cross_reviews: number | null;
  /**
   * Top recorded cross-review verdict words inside the unknown cohort,
   * by jobs — `approve`/`reject`/`failed`/`skipped` (see
   * RouterWeightProposalSet). Null when the ledger was not read or
   * cross-review was not read; empty when read but no unknown-cohort
   * outcome carried a verdict.
   */
  unknown_cross_review_verdicts: { verdict: string; jobs: number }[] | null;
  /**
   * Jobs inside the unknown cohort carrying recorded merge-queue
   * evidence — see RouterWeightProposalSet. Queue-side diagnostic
   * context only; never reduces unknown_unresolved. Null when the
   * ledger was not read or the merge-events ledger was not read
   * (merge-queue coverage unknown); 0 is a real measurement when the
   * tail was read.
   */
  unknown_merge_queue: number | null;
  /** Of unknown_merge_queue, jobs whose recorded merge queue blocked the PR at least once. */
  unknown_merge_queue_blocked: number | null;
  /**
   * Top recorded merge-queue blocker codes inside the unknown cohort,
   * by jobs — each job contributes each reason once. Null when the
   * ledger was not read or merge-events was not read; empty when read
   * but no unknown-cohort outcome carried a blocked reason.
   */
  unknown_merge_queue_blocked_reasons: { reason: string; jobs: number }[] | null;
  /** Of unknown_merge_queue, jobs whose PR recorded at least one failed check observation. */
  unknown_merge_queue_check_failures: number | null;
  /** Of unknown_merge_queue, jobs whose PR recorded at least one merge conflict. */
  unknown_merge_queue_conflicts: number | null;
  /** Of unknown_merge_queue, jobs whose PR recorded at least one merge-retry request. */
  unknown_merge_queue_retries: number | null;
  /** Of unknown_merge_queue, jobs whose PR recorded at least one recut request. */
  unknown_merge_queue_recuts: number | null;
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
  /**
   * Top recorded `repo` labels across every folded outcome — see
   * RouterWeightProposalSet. Null when the ledger was not read; empty
   * when read but no outcome recorded a repo.
   */
  repos: { repo: string; jobs: number }[] | null;
  /**
   * Health of the fleet controller's recorded lane-quality verdicts
   * (`route.quality.v1` receipts in `queue/fleet-controller.json`, read via
   * controller-quality.ts). 'unreported' means the caller supplied no read —
   * distinct from 'missing' (no state file) and 'invalid' (the file parsed
   * but quality_receipts did not match the recorded contract).
   */
  controller_quality_state: ControllerQualityState | 'unreported';
  /**
   * Newest validated route.quality.v1 receipt per lane — the verdicts the
   * controller is currently enforcing (or shadowing) for routing. Null
   * unless controller_quality_state==='read'; an empty array then means the
   * controller recorded no verdicts, a real measurement.
   */
  controller_quality: ControllerQualityReceipt[] | null;
  /** Receipt rows rejected during validation; null unless state==='read'. */
  controller_quality_invalid_rows: number | null;
  /**
   * Health of the outside-PR outcome journal tail behind the
   * community-seat tallies — merged non-fleet PRs per attributed agent
   * (community-seats.ts). 'unreported' means the caller supplied no read —
   * distinct from 'missing' (no journal yet) and the degraded states.
   */
  community_seats_state: CommunitySeatsState | 'unreported';
  /** True when the journal tail was cut; seat counts cover the newest bytes only. */
  community_seats_truncated: boolean;
  /** Journal lines rejected by the parser; null unless state==='read'. */
  community_seats_ignored: number | null;
  /** Evidence window the seat tallies were folded under, in days; null unless state==='read'. */
  community_seats_window_days: number | null;
  /**
   * Per attributed-agent outside-merge tallies — prs/reverted/kept/unknown
   * inside the window plus the journaled open→merge latency
   * (`ttm_known`/`ttm_minutes_mean`), review-evidence
   * (`reviews_known`/`reviewed`/`unreviewed`/`approved`/
   * `changes_requested`/`review_required`), check-rollup CI-verdict
   * (`ci_known`/`ci_passed`/`ci_failed`/`ci_pending`/`ci_none`) and
   * diff-size (`diff_known`/`diff_lines_mean`/`diff_files_mean`)
   * tallies, each with its own honest denominator; model always null
   * (gh records none). Null unless community_seats_state==='read'; an
   * empty array then means no outside merges were journaled inside the
   * window, a real measurement.
   */
  community_seats: CommunitySeatOutcome[] | null;
  /**
   * Newest scan receipt's coverage fields — gh source state, revert-ledger
   * state and degraded/partial repo reads. Null when no scan row parsed or
   * the journal was not read; the tallies then carry no coverage context.
   */
  community_seats_coverage: CommunitySeatsCoverage | null;
  proposals: RouterWeightProposal[];
}

/** Wraps one bounded ledger read. Raw ledger rows are never copied into the report. */
export function buildRouterWeightProposalReport(read: RouterOutcomeRead, asOf: string, opts: RouterWeightProposalOptions = {}): RouterWeightProposalReport {
  if (!z.iso.datetime().safeParse(asOf).success) throw new RangeError('as_of must be an ISO-8601 UTC timestamp');
  const bounds = { min_samples: opts.minSamples ?? ROUTER_WEIGHT_DEFAULT_MIN_SAMPLES, max_shift: opts.maxShift ?? ROUTER_WEIGHT_DEFAULT_MAX_SHIFT };
  const controller = opts.controllerQuality ?? null;
  const seats = opts.communitySeats ?? null;
  const head = { schema: 'router.weight-proposals.v1' as const, advisory_only: true as const, as_of: asOf,
    source: ROUTER_WEIGHT_PROPOSAL_SOURCE, ledger: { state: read.state, path: read.path }, truncated: read.truncated,
    market_state: read.market_state, market_truncated: read.market_truncated,
    empty_tag_state: read.empty_tag_state, empty_tag_truncated: read.empty_tag_truncated,
    merge_events_state: read.merge_events_state, merge_events_truncated: read.merge_events_truncated,
    revert_ledger_state: read.revert_ledger_state,
    reward_state: read.reward_state, reward_truncated: read.reward_truncated,
    launch_cost_state: read.launch_cost_state, launch_cost_truncated: read.launch_cost_truncated,
    cross_review_state: read.cross_review_state, cross_review_truncated: read.cross_review_truncated,
    controller_quality_state: (controller?.state ?? 'unreported') as RouterWeightProposalReport['controller_quality_state'],
    controller_quality: controller?.state === 'read' ? controller.receipts : null,
    controller_quality_invalid_rows: controller?.state === 'read' ? controller.invalid_rows : null,
    // Community seats are an independent journal, not a jobs-ledger join:
    // they report whenever the caller supplied a read, even when the jobs
    // ledger itself was unavailable.
    community_seats_state: (seats?.state ?? 'unreported') as RouterWeightProposalReport['community_seats_state'],
    community_seats_truncated: seats?.state === 'read' ? seats.truncated : false,
    community_seats_ignored: seats?.state === 'read' ? seats.ignored_rows : null,
    community_seats_window_days: seats?.state === 'read' ? seats.window_days : null,
    community_seats: seats?.state === 'read' ? seats.seats : null,
    community_seats_coverage: seats?.state === 'read' ? seats.coverage : null,
    bounds };
  if (read.state !== 'read') {
    return { ...head, status: 'unavailable', known_outcomes: null, unknown_outcomes: null, unclassified_outcomes: null,
      unknown_empty: null, unknown_nonzero_exit: null, unknown_failure_classes: null, unknown_empty_classes: null,
      unknown_task_outcomes: null, unknown_skipped: null, unknown_skip_reasons: null, unknown_empty_tags: null,
      unknown_deferred: null, unknown_defer_reasons: null, unknown_noop: null,
      unknown_noop_reasons: null, unknown_market_reasons: null,
      unknown_market_rejected: null, unknown_market_rejected_reasons: null,
      unknown_handoffs: null, unknown_handoff_triggers: null,
      unknown_provider_walls: null, unknown_provider_wall_triggers: null,
      unknown_pool_throttles: null, unknown_pool_kinds: null,
      unknown_node_outcomes: null, unknown_node_verdicts: null,
      unknown_cross_reviews: null, unknown_cross_review_verdicts: null,
      unknown_merge_queue: null, unknown_merge_queue_blocked: null,
      unknown_merge_queue_blocked_reasons: null,
      unknown_merge_queue_check_failures: null, unknown_merge_queue_conflicts: null,
      unknown_merge_queue_retries: null, unknown_merge_queue_recuts: null,
      unknown_unresolved: null,
      usage_missing: null, usage_sources: null, repos: null, proposals: [] };
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
    // No-op verdicts are jobs-ledger rows like the skip and keep-queued
    // verdicts — no side-ledger join — so the tallies are real whenever
    // the jobs read succeeded.
    unknown_noop: set.unknown_noop, unknown_noop_reasons: set.unknown_noop_reasons,
    // Market reasons and the per-lane rejection record join through the
    // same work-market.jsonl tail as work_class: anything but 'read'
    // means no decision verdicts joined, so the tallies would claim "no
    // market reasons/rejections recorded" when they only know "market
    // unread" — report null, the same rule empty_tags uses.
    unknown_market_reasons: read.market_state === 'read' ? set.unknown_market_reasons : null,
    unknown_market_rejected: read.market_state === 'read' ? set.unknown_market_rejected : null,
    unknown_market_rejected_reasons: read.market_state === 'read' ? set.unknown_market_rejected_reasons : null,
    // Session-handoff advisories and autobackoff lane holds are
    // jobs-ledger rows like the skip, keep-queued and no-op verdicts —
    // no side-ledger join — so the tallies are real whenever the jobs
    // read succeeded.
    unknown_handoffs: set.unknown_handoffs,
    unknown_handoff_triggers: set.unknown_handoff_triggers,
    unknown_provider_walls: set.unknown_provider_walls,
    unknown_provider_wall_triggers: set.unknown_provider_wall_triggers,
    // Pool receipts are jobs-ledger rows like the skip, keep-queued,
    // no-op, handoff and provider-wall verdicts — no side-ledger join —
    // so the tallies are real whenever the jobs read succeeded.
    unknown_pool_throttles: set.unknown_pool_throttles,
    unknown_pool_kinds: set.unknown_pool_kinds,
    // Node-runner finish rows are jobs-ledger rows like the skip,
    // keep-queued, no-op, handoff, provider-wall and pool verdicts —
    // no side-ledger join — so the tallies are real whenever the jobs
    // read succeeded.
    unknown_node_outcomes: set.unknown_node_outcomes,
    unknown_node_verdicts: set.unknown_node_verdicts,
    // Cross-review evidence joins through the same bounded
    // cross-review.jsonl tail under the ASHLR home root: anything but
    // 'read' means no review verdicts joined, so the tallies would
    // claim "no reviews recorded" when they only know "cross-review
    // unread" — report null, the same rule unknown_merge_queue uses.
    unknown_cross_reviews: read.cross_review_state === 'read' ? set.unknown_cross_reviews : null,
    unknown_cross_review_verdicts: read.cross_review_state === 'read' ? set.unknown_cross_review_verdicts : null,
    // Merge-queue evidence joins through the same bounded
    // merge-events.jsonl tail: anything but 'read' means no merge_queue
    // joined, so the tallies would claim "no merge friction recorded"
    // when they only know "merge-events unread" — report null, the same
    // rule unknown_market_reasons and unknown_empty_tags use.
    unknown_merge_queue: read.merge_events_state === 'read' ? set.unknown_merge_queue : null,
    unknown_merge_queue_blocked: read.merge_events_state === 'read' ? set.unknown_merge_queue_blocked : null,
    unknown_merge_queue_blocked_reasons: read.merge_events_state === 'read' ? set.unknown_merge_queue_blocked_reasons : null,
    unknown_merge_queue_check_failures: read.merge_events_state === 'read' ? set.unknown_merge_queue_check_failures : null,
    unknown_merge_queue_conflicts: read.merge_events_state === 'read' ? set.unknown_merge_queue_conflicts : null,
    unknown_merge_queue_retries: read.merge_events_state === 'read' ? set.unknown_merge_queue_retries : null,
    unknown_merge_queue_recuts: read.merge_events_state === 'read' ? set.unknown_merge_queue_recuts : null,
    unknown_unresolved: set.unknown_unresolved,
    usage_missing: set.usage_missing, usage_sources: set.usage_sources,
    repos: set.repos,
    proposals: set.proposals };
}
