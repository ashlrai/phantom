import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { readLaneScores, type LaneScoresRead } from '../eval/passk.js';

// Read-only recorded job outcomes from the newest ROUTER_OUTCOME_LEDGER_LIMIT
// bytes of <runs>/metrics/jobs.jsonl, joined with the per-call spend ledger
// <runs>/metrics/api-spend.jsonl and the work-market decision journal
// <runs>/metrics/work-market.jsonl under the same bound. Recovered from the
// router-outcome slice of #6794 (head f9e484e87ec2). Scope is deliberately
// bounded: no routing, ranking, tuning, weights, or network. `passk` joins
// each outcome's (lane, model) to the published eval.lane-scores.v1
// projection — advisory evidence only; a missing, degraded or ambiguous
// score leaves passk null. jobs.jsonl rows never carry work_class, so the
// fold fills it from each job's latest work-market route_decision row — the
// market's own recorded classification — while an explicit jobs-row
// work_class always wins. The same newest route_decision row also supplies
// the market's recorded routing verdict as market_lane/market_preferred/
// market_override/market_reasons — decision-side intent and reason codes
// (no_runnable_lane, hysteresis_*, global_admission) distinct from the
// claim rows' launch record. jobs.jsonl queue rows also carry the
// dispatcher's recorded repo cell (`repo` — a bare fleet name or an
// owner/repo pair), which folds as `repo` newest-explicit-wins in the
// bounded repo-label shape: the repo the job targeted reaches
// router.outcome.v1 instead of stopping at the ledger, so per-repo
// outcome mixes can be read beside the per-lane and per-class ones. The
// ledgers are append-only and unbounded, so each
// read retains a tail window: an oversized ledger reports truncated:true (or
// spend_truncated/market_truncated for the joined sources) and folds only
// the retained rows, never a refused read. jobs.jsonl finish rows carry
// cost:null by design, so cost_usd is populated from api-spend rows naming
// the job — the same job|job_id|id attribution and cost_usd|usd|cost
// precedence the fleet spend readers already use — and stays null when no
// call reported a cost. `reverted` also joins the authority ledger's verified
// evidence index: a `revert:landed` row undoing a `merge:landed` landing marks
// the merged PR's outcome reverted through its unambiguous jobs-ledger PR URL
// claim — the fleet's own revert record, which jobs.jsonl rows never carry.
// Batch sessions fold per member like the sibling fleet readers: RQ-BATCH-*
// session rows are infrastructure evidence counted in session_rows, never
// outcomes or URL claims, and a member's task_outcome row supplies its
// recorded end-of-session word — members get no per-member finish row, so
// their finish verdicts and usage stay null rather than split from the
// session's aggregates. Node session-pool rows (fleet.session-pool.v1)
// resolve job identity by the producer's own contract: `job` is the
// per-attempt id and `jobId` the logical queue id, so only `jobId` keys an
// outcome — the attempt id never mints a phantom outcome, and a queue
// job's launch/finish rows fold together whether one session or a later
// retry ran them. Node-runner finish rows (phm-node-runner.v1) carry the
// same dual-id contract — `job` is the per-claim id (<jobId>:<token>)
// and `jobId` the logical node-queue id the claim worked — so only
// `jobId` keys their outcome either, and the runner's recorded verdict
// folds as node_outcome/node_id/node_pack: the fleet's recorded
// succeeded/fenced/failed word for the offloaded pack job plus the node
// and pack that ran it — the node pool's execution evidence reaching
// router.outcome.v1 instead of stopping at the attempt-scoped id.
// Finish rows also carry dispatchd's job_usage block
// (acus — the Devin lane's billed spend, the token breakdown, and the
// usage_source/usage_missing provenance labels) plus job_diff_metrics'
// diff_files/diff_lines: the fold keeps each recorded figure
// newest-explicit-wins like tokens_total, so a lane's ACU spend — the only
// cost evidence subscription lanes record — its usage capture gaps and its
// change size reach router.outcome.v1 instead of stopping at the ledger.
// The skip gate's launch-decline receipts (`skipped_empty`/`precheck_skip`
// event rows, `applied:false` dry runs excluded) fold as
// skipped/skip_reason/skip_code: the newest decline stands until a later
// claim/batch_claim/launch row supersedes it, so a job the fleet chose not
// to launch stops reading as an unexplained unknown. The fleet's
// keep-queued receipts — `dispatch_deferred` (a duplicate request an
// earlier job already covers), `recut_admission` defer/ready/skip verdicts
// and `precheck_parked` — fold the same way as
// deferred/defer_reason/defer_repeat_of: the newest keep-queued verdict
// stands until a later dispatch or skip-gate decline supersedes it, so a
// job the fleet recorded keeping queued stops reading as unexplained
// unknown too. The fleet's recorded terminal no-op verdicts — outcome-phase
// rows in the canonical empty family (DONE-NOOP plus the defensive
// EMPTY/EMPTY_DONE/SKIPPED-EMPTY/NOOP spellings the sibling readers
// share) — fold as noop/noop_reason/noop_repeat_of under the same
// row-order competition: dispatchd's already-merged/terminal-target
// admission, recut-skip and repair-freshness verdicts and restock's
// precheck retirements record that the job needed no publishable work,
// the verdict resolves a standing skip or deferral, and every newer
// launch-decision receipt supersedes it — so a job the fleet recorded
// needing no work stops reading as unexplained unknown as well.
// `empty_tag` joins a fourth bounded ledger, <runs>/metrics/empty-tags.jsonl:
// the `job.empty-tag.v1` rows `phm jobs empty --record` appends beside the
// job ledger — the fleet's own recorded WHY for a job that finished empty
// (already_done/pool_cap/blocked/no_change_needed/unknown, the closed
// empty-tags vocabulary). The tag is evidence an empty finish was recorded
// fleet-side; it attaches to the job's outcome regardless of the standing
// finish verdict, stays null when no tag row named the job, and rows for
// jobs outside the jobs window never create outcomes — the same join rule
// spend costs and market classes follow. The same newest route_decision row
// also carries the market's per-lane rejection record — `rejected_lanes`,
// every lane the market would not run the job on with its reason_codes —
// which folds as market_rejected: the per-lane why behind a
// no_runnable_lane/global_admission verdict that market_reasons only names
// in aggregate. jobs.jsonl `session_handoff_advisory` rows — dispatchd's
// session-failover.v1 provider-wall receipts (rate-limit verdicts land
// here through metric(); the producer's quota-exhausted verdicts land in
// work-market.jsonl through market_metric(), where the same decision's
// rejection evidence already folds through the route_decision joins) —
// fold as
// handoff_trigger/handoff_lane/handoff_target: the fleet's recorded
// verdict that a run attempt died on a usage-limit wall or that a
// pending job's lane measured zero quota, the
// once-per-attempt evidence the finish row's own classification can
// miss when a walled run exits cleanly. The advisory is evidence about
// an attempt, not a launch decision, so it competes with nothing: the
// newest recognized advisory row replaces the triple wholesale and
// every other event leaves it alone. jobs.jsonl `autobackoff_hold`
// rows — dispatchd's confirmed provider-wall lane holds, the
// usage/quota and auth backoff scanners' hold receipts appended
// through the same `metric()` path — fold as
// provider_wall_trigger/provider_wall_pattern/provider_wall_lane: the
// fleet's recorded verdict that the job's finished run log tail
// matched a provider error pattern and the lane was held, covering
// the auth-failure walls the session-handoff advisory never sees and
// the usage walls whose hold landed where no advisory did (an
// outcome-unreadable run, a still-standing earlier hold). Like the
// advisory it is attempt evidence, not a launch decision: the newest
// recognized hold row replaces the triple wholesale and every other
// event leaves it alone; the skip receipts (helper-unavailable scans
// that recorded no verdict) never join. jobs.jsonl `pool` rows —
// dispatchd's slot-throttle detector receipts, appended through the
// same `metric()` path when the per-tick `ratelimited()` scan finds a
// launched job's recent error-log tail matching a provider-limit
// pattern — fold as pool_kind/pool_mem_free_pct/pool_swap_gb: the
// fleet's recorded throttle class for the attempt (`kind` in the
// producer's closed CLS vocabulary — credits_exhausted, usage_limit,
// model_capacity, rate_limit — the same classes the finish row's
// pool_error and the friction ledger's quota vocabulary share) plus
// the host memory readings (`mem_free_pct`/`swap_gb`) the detector
// captured at detection time. The receipt is scan-time evidence, not
// a launch or terminal verdict: `ratelimited()` fires on a log-tail
// pattern match for any job whose `.base` still stands — a run that
// recovered, is still in flight, or already finished without the
// finish row's own pool_error all carry the same receipt — so like
// the market and merge-queue evidence it competes with nothing: the
// newest recognized pool row replaces the triple wholesale and every
// other event leaves it alone. The row counts only on the `pool`
// event name (the `event`/`type`/`kind` alias set) with a `kind`
// inside the closed vocabulary; `mem_free_pct` joins only as a
// bounded percentage and `swap_gb` only as a non-negative figure — a
// malformed value drops to null without discarding the recorded
// class, and a `kind` outside the vocabulary skips the row entirely,
// never recorded raw. All three stay null when no pool row named the
// job: the retained window recorded no throttle detection, which is
// unknown, not "no throttle ever".
// `merge_queue` joins a fifth bounded ledger, <runs>/metrics/merge-events.jsonl:
// the fleet merge-latency observation journal (repo+pr keyed rows the
// host merge observer and `phm fleet merge-retry` append — opened,
// queued, eligible, blocked, conflict, check_observed, retry_*,
// recut_requested, auto_merge_* and the merged/closed terminals). The
// join runs through each job's newest unambiguous canonical PR claim —
// the same owner/repo#n prKey the authority revert join uses — so a
// job's recorded merge-queue friction (blocked reasons, conflicts,
// failed checks, dropped auto-merges, recuts, retries) reaches
// router.outcome.v1 instead of stopping at the merge-latency report.
// Rows for PRs no jobs outcome claims unambiguously join nothing, and
// a missing or cut merge-events tail leaves every merge_queue null —
// unknown, never a guessed queue history.

/** Newest-bytes bound retained from the append-only jobs ledger. */
export const ROUTER_OUTCOME_LEDGER_LIMIT = 16 * 1024 * 1024;
export const ROUTER_OUTCOME_LEDGER_RELATIVE = join('metrics', 'jobs.jsonl');
export const ROUTER_SPEND_LEDGER_RELATIVE = join('metrics', 'api-spend.jsonl');
export const ROUTER_MARKET_LEDGER_RELATIVE = join('metrics', 'work-market.jsonl');
export const ROUTER_EMPTY_TAGS_LEDGER_RELATIVE = join('metrics', 'empty-tags.jsonl');
export const ROUTER_MERGE_EVENTS_LEDGER_RELATIVE = join('metrics', 'merge-events.jsonl');

export interface RouterOutcome {
  schema: 'router.outcome.v1';
  job_id: string;
  lane: string | null;
  model: string | null;
  tier: string | null;
  /**
   * work_class recorded on a jobs.jsonl row when present; otherwise the
   * latest work-market route_decision class for the job; null when neither
   * ledger recorded one — unknown stays null, never derived.
   */
  work_class: string | null;
  /**
   * The repo the job targeted, recorded on jobs.jsonl rows as `repo` —
   * dispatchd writes the ready line's repo cell on its queue rows
   * (enqueue/claim/launch/skip/defer/outcome/task_outcome alike). The
   * value joins only in the bounded repo-label shape — a bare fleet
   * name (`phantom`, `lexicon`, `ashlr-md`) or an `owner/repo` pair —
   * and the newest recognized value wins like lane/model/tier: a row
   * without `repo` or with a value outside the shape leaves the
   * standing record, so absolute paths, whitespace and deeper paths
   * are skipped, never recorded raw, and never guessed from the job
   * id or PR URL. Null when no retained row recorded a bounded repo —
   * unknown, not "no repo".
   */
  repo: string | null;
  /**
   * The dispatch claim's recorded lane override — the pair a `claim` or
   * `batch_claim` row writes when the launch left its hinted lane.
   * `lane_hint` is the preferred lane the claim left (the market's
   * `preferred_lane` on solo claims, the member's own lane on
   * `batch_claim` rows) and `lane_override` the recorded reason code —
   * dispatchd writes the work market's closed `resource_fit` /
   * `unknown_preference` / `preferred_lane_fallback` vocabulary on solo
   * claims and the literal `batch_session` when a batch member moved
   * lanes with its session (contrib/mac/dispatchd.py, docs/QUEUE.md).
   * The newest claim row stands: a later claim that ran on its hint —
   * or a batch member whose session lane matched its own — clears an
   * earlier override, and rows of every other event never touch the
   * pair. `lane_override` joins only in the bounded lowercase code
   * shape the fleet unfed claims fold accepts and `lane_hint` only in
   * the bounded lane shape; a malformed hint or reason is skipped,
   * never recorded raw, and an override reason without a recorded hint
   * still joins with `lane_hint` null. Advisory `failover` receipts
   * carry the same field names under a different vocabulary
   * (`failover_*`, hint = the failed lane) and never join — they are
   * not claim routing decisions. Both stay null when no claim row
   * recorded an override.
   */
  lane_hint: string | null;
  lane_override: string | null;
  /**
   * true on explicit MERGED merge evidence — a MERGED terminal phase across
   * phase|state|outcome|status|result|conclusion, or a 'merged' event name
   * when no phase field resolves — or merged:true; false on CLOSED evidence
   * likewise or merged:false; else null. A resolved phase stays
   * authoritative over the event name, and mergedAt/closedAt stay the
   * preferred stamps on terminal rows.
   */
  merged: boolean | null;
  /**
   * true on explicit revert evidence — reverted:true, a revert event name or
   * terminal REVERT/REVERTED state, a parseable reverted_at/revertedAt stamp,
   * or a verified authority-ledger revert:landed undoing the merge the job's
   * unambiguous PR URL claim names; false only on an explicit reverted:false
   * with no positive evidence; else null. Sticky-true like metrics-ingest: a
   * recorded revert is never contradicted by a later reverted:false.
   */
  reverted: boolean | null;
  ci_first_pass: boolean | null;
  review_findings: { fixed: number; rejected: number; ignored: number } | null;
  /**
   * USD cost recorded for the job: an explicit cost field on a jobs.jsonl row
   * (cost_usd|usd|cost) wins; otherwise the sum of api-spend.jsonl call costs
   * naming the job. Null when neither source reported a cost — a job whose
   * calls carried no cost is unknown, never zero. May include
   * collector-estimated costs (cost_estimated rows still report a USD figure).
   */
  cost_usd: number | null;
  wall_s: number | null;
  /**
   * Recorded usage total in tokens — the finish row's `tokens_total`/
   * `tokensTotal` spelling. Newest explicit row wins like cost_usd and
   * wall_s. Null when no jobs row recorded one; never derived from cost
   * or event names.
   */
  tokens_total: number | null;
  /**
   * The finish row's recorded usage block — dispatchd's job_usage spread,
   * the same fields every finish metric carries. `acus` is the Devin
   * lane's billed ACU spend: the only cost figure subscription lanes
   * record, in a different unit than cost_usd and never summed with it.
   * `tokens_in`/`tokens_out`/`tokens_cache_read`/`tokens_cache_write` are
   * the token breakdown behind tokens_total. `usage_source` names the
   * recorded measurement path (dispatchd's devin-sessions-db /
   * claude-result-json / tokens-line vocabulary) and `usage_missing` the
   * recorded reason usage stayed unknowable (its devin-, claude- and
   * tokens-line- capture-gap vocabulary); both join as bounded
   * identifier labels, never raw text. Newest explicit row wins like
   * tokens_total — a later finish row without a recognized value keeps
   * the earlier one. All stay null when no jobs row recorded them.
   */
  acus: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  usage_source: string | null;
  usage_missing: string | null;
  /**
   * Recorded opened-to-merged seconds — the jobs-ledger `ttm_s`/`ttmS`
   * dialect the fleet's merge-pace, merge-graph, throughput, eval-report and
   * job-activity readers share. It belongs to the merge verdict, not to the
   * job's rows in general: the fold takes it from the row that last won the
   * merge verdict (the same newest-timestamp rule `merged` uses), only when
   * that verdict is a merge, and a later winning verdict replaces it
   * wholesale — a close clears it and a newer merge row without the field
   * leaves it null rather than keeping a stale figure. Null when no
   * standing merge recorded one; never derived from wall_s or timestamps.
   */
  ttm_s: number | null;
  /**
   * Recorded queue-admission seconds — the jobs-ledger arrival stamp
   * (`enqueue`/`enqueued`/`queued`, the boundary job-latency's queue_wait
   * phase names `queued`) to the job's first dispatch (`claim`/
   * `batch_claim`/`launch`, the same dispatch set reward-feed pairs), both
   * read across the retained rows' `ts`/`timestamp`/`at`/`time` dialect.
   * The fold derives it once per job: the earliest dispatch stamp minus
   * the latest arrival stamp at or before it, so a requeued job's later
   * arrivals never move its first-dispatch wait and a same-tick
   * admission records a real 0. Null when the job recorded no arrival at
   * or before its first dispatch — a direct dispatch, a member claimed
   * only through its batch session, or rows that never wrote the
   * boundary — unknown, never zero and never another phase's duration.
   */
  queue_wait_s: number | null;
  /**
   * Recorded CI wall seconds — the jobs-ledger `ci_start`/`ci_complete`
   * event pair the reward feed's ciWallMs, job-latency's `ci` phase and
   * visit-sync's check boundaries already read. The fold derives it once
   * per job under the same rule those readers apply: exactly one start
   * and one complete stamp across the retained rows (identical repeated
   * stamps dedupe, a re-run's second pair makes the job ambiguous), both
   * read across the `ts`/`timestamp`/`at`/`time` dialect, and the
   * complete stamp must not precede the start. Anything else — a missing
   * boundary, reversed stamps or repeated pairs — leaves the job absent
   * here so its outcome keeps null: unknown stays unknown, never a
   * partial guess and never another phase's duration.
   */
  ci_wall_s: number | null;
  /**
   * Recorded publish-station wait seconds — the jobs-ledger finish →
   * publish boundary pair job-latency's publish_wait phase and
   * visit-sync's publish station already read: how long finished work
   * sat waiting for the publisher. The fold derives it once per job
   * under the same rule those readers apply: exactly one finish stamp
   * and one publish stamp across the retained rows (identical repeated
   * stamps dedupe, a retried attempt's second finish or a republish's
   * second publish makes the job ambiguous), both read across the
   * `ts`/`timestamp`/`at`/`time` dialect, the publish stamp not
   * preceding the finish, and terminal lifecycle phases authoritative
   * over event names — the outcomes reconciler copies the publish row
   * and only swaps the outcome, so its `{event:'publish',
   * outcome:'MERGED'}` row is merge evidence stamped at verdict time,
   * never a second publish. Anything else leaves the job absent so its
   * outcome keeps null: unknown stays unknown, never a partial guess
   * and never another phase's duration.
   */
  publish_wait_s: number | null;
  /**
   * Recorded productivity verdicts, newest explicit row wins like cost_usd
   * and wall_s. `empty` is the boolean a finish row records for its diff
   * check (true = the run produced no diff); `exit_code` is the worker's
   * recorded exit status — negative values are signal exits and stay
   * recorded; `failure_class` is the recorded failure classification — a
   * finish row's `failure_class`, then `failure_reason`, then `pool_error`
   * (the precedence the skill-nudge ledger reader shares), or a
   * `launch_failed` row's fixed `reason` when its `action` is `give_up`
   * (the launch budget is spent or the failure permanent, so the job
   * never reaches a finish; retry receipts and `launch_terminal` rows
   * never join) — accepted only in the bounded identifier shape (values
   * outside it are skipped, never guessed or recorded raw); `empty_class`
   * is the finish row's recorded empty-diff classification in dispatchd's
   * closed classify_empty vocabulary. All stay null when no jobs row
   * recorded them — unknown, never inferred from merged state, PR URLs or
   * event names.
   */
  empty: boolean | null;
  /**
   * The finish row's recorded diff size — dispatchd's job_diff_metrics
   * file count and line total for the job's final tracked tree against
   * its launch base (BRIDGE_NOTES.md excluded). `diff_lines` stays null
   * when untracked files made the line total unmeasurable: recorded
   * unknown, never a partial sum. Newest explicit row wins like wall_s.
   */
  diff_files: number | null;
  diff_lines: number | null;
  exit_code: number | null;
  failure_class: string | null;
  /**
   * The finish row's recorded empty-diff classification — dispatchd's
   * `classify_empty` verdict (contrib/mac/launch_precheck.py), the same
   * triage its 24h rollup uses for `empty_error_rate`: `no_diff` is a
   * clean exit that produced nothing publishable (a healthy no-op),
   * `error` is a nonzero exit or pool error (the lane-penalizing
   * infrastructure share), `unknown` means no exit status was recorded
   * (a possible capture gap, not blamed on the prompt). The vocabulary is
   * closed — unrecognized spellings are skipped, never recorded raw — and
   * like failure_class the newest row carrying a recognized value wins;
   * a later finish row without one keeps it. Null when no jobs row
   * recorded one.
   */
  empty_class: string | null;
  /**
   * The fleet's recorded WHY for a job that ended empty — the
   * `job.empty-tag.v1` row `phm jobs empty --record` appends to
   * metrics/empty-tags.jsonl from empty-final-reason's verdict (src/core/
   * fleet/empty-tags.ts): the closed five-tag vocabulary
   * already_done/pool_cap/blocked/no_change_needed/unknown. Unlike
   * empty_class — the finish row's own no_diff/error/unknown measure —
   * the tag is the fleet's post-hoc triage of the job's final output, so
   * it attaches to the outcome whether or not the finish row's
   * empty_class resolved. The newest tag row for the job stands
   * (recordEmptyTags dedups by job id, so repeats are rare); rows naming
   * jobs outside the jobs window never create outcomes, and a missing,
   * unreadable or truncated tags ledger leaves every tag null — unknown,
   * never a guessed cause.
   */
  empty_tag: string | null;
  /**
   * The batch member's recorded end-of-session word — a `task_outcome`
   * event row's `outcome` field in dispatchd's closed batcher.OUTCOMES
   * vocabulary (`done`/`skipped` handed the member to its own publish;
   * `failed`/`deferred`/`unreported` requeued it). This is the member's
   * finish boundary: batch members get no per-member finish row, so the
   * word is the only recorded per-member productivity verdict. Newest
   * explicit recognized row wins like the other finish fields;
   * unrecognized spellings and non-task_outcome rows never set it. Null
   * for solo jobs and when no task_outcome row recorded a word — unknown,
   * never inferred from merge state or event names.
   */
  task_outcome: string | null;
  /**
   * The dispatch claim's recorded lane-hint blocking codes — the third
   * field of the claim's lane-override record. A solo `claim` row that
   * left its hinted lane spreads the work market's
   * `preferred_lane_blocked_by` here (contrib/mac/dispatchd.py,
   * docs/QUEUE.md): the rejected preferred lane's `reason_codes` —
   * `quota_exhausted`, `saturated`, `held`, `provider_backoff`,
   * `hysteresis_*` and the rest of the market's closed vocabulary — or
   * `[]` when the preferred lane was unknown to the market or merely
   * outranked rather than rejected (`unknown_preference`,
   * `resource_fit`, hysteresis-held fallbacks). `batch_claim` rows
   * never carry the field — a member that moved lanes with its session
   * has no market blocking record — so it stays `null` there, unknown,
   * never `[]`. The list joins only alongside a well-formed
   * `lane_override` on the newest `claim`/`batch_claim` row — the same
   * newest-claim-stands rule the override pair follows: a later
   * on-hint claim clears it, a malformed reason or hint skips the row,
   * and non-claim rows never touch it. Entries join only in the bounded
   * lowercase reason-code shape, deduplicated in recorded order and
   * capped; a non-array value or a list whose entries are all
   * unrecognizable reads as unrecorded (`null`), while a recorded empty
   * list stays `[]` — the market's own "nothing blocked it" verdict,
   * distinct from missing evidence.
   */
  lane_hint_blocked_by: string[] | null;
  /**
   * The skip-gate's recorded launch decline — dispatchd's `empty_gate`
   * and precheck skip paths and restock's empty gate write
   * `skipped_empty` (with `precheck_skip` the spelling the sibling fleet
   * readers honor for the same receipts) when they decline a ready line
   * instead of launching it: `reason` carries the empty-gate vocabulary
   * (`upkeep_empty_same_base`, `prompt_empty_same_base_24h`,
   * `task_empty_repeat_24h`), `code` the precheck gate's exit status.
   * The verdict competes with the dispatch rows on row order like the
   * claim override pair: the newest decline stands until a later
   * `claim`/`batch_claim`/`launch` row — or the skip gate's own
   * `applied:false` dry-run receipt, which records the job still
   * launched — supersedes it to `false` ("a decline was recorded but
   * the job dispatched after all"). `finish`/`publish`/`outcome` rows
   * belong to attempts already decided and never touch it, and a
   * `dupcheck_skip` receipt never joins — its paired `skipped_empty`
   * row already carries the canonical decline. `null` means no skip
   * evidence — never declined or only dry-run receipts — distinct from
   * `empty`, the finish row's measured no-diff, from a batch member's
   * `task_outcome` word, and from the queue's terminal no-op verdict.
   */
  skipped: boolean | null;
  /**
   * The standing skip verdict's recorded reason — the newest skip row's
   * `reason`, then `empty_reason`, then `skip_reason`, with a
   * bounded-string `code` as the last resort (sibling readers treat a
   * string code as the skip's label; integer codes join `skip_code`
   * instead). Accepted only in the bounded identifier-label shape
   * `failure_class` uses — the empty-gate vocabulary and bounded code
   * strings like `open_pr`/`dup` fit; unrecognized spellings are
   * skipped, never recorded raw. The newest skip row replaces it
   * wholesale and a superseding dispatch clears it; `null` whenever
   * `skipped` is not `true` — including precheck-code-only declines,
   * whose reason stays unrecorded rather than guessed.
   */
  skip_reason: string | null;
  /**
   * The standing skip verdict's recorded gate code — the newest skip
   * row's `code`/`precheck_code` as a non-negative safe integer
   * (dispatchd's precheck exit-status vocabulary, including the
   * `EMPTY_CODE`/`DUPCHECK_CODE` 14 receipts). String `code` values
   * join `skip_reason` instead; anything else is skipped, never
   * recorded raw. Replaced wholesale by the newest skip row and cleared
   * by a superseding dispatch; `null` whenever `skipped` is not `true`.
   */
  skip_code: number | null;
  /**
   * The fleet's recorded keep-queued launch verdict — dispatchd evaluated
   * this ready job and kept it queued instead of launching it, with a
   * recorded reason: a `dispatch_deferred` row (another job's claim
   * already covers the same request digest — `duplicate-request`), a
   * `recut_admission` row whose `action` is `defer` (an in-flight recut
   * attempt covers the job — `recut-in-flight`), or a `precheck_parked`
   * row (the precheck park — the job retries at its recorded retry_at).
   * `recut_admission` `ready`/`skip` actions are the recorded blocker
   * resolving or the job ending, and supersede a standing deferral to
   * `false` like a dispatch does. The verdict competes with the other
   * launch-decision rows on row order: the newest keep-queued receipt
   * stands until a later `claim`/`batch_claim`/`launch` dispatch row or
   * a skip-gate decline — the fleet's newer recorded decision about the
   * same queued job — supersedes it to `false` ("a deferral was recorded
   * but the job dispatched or was declined after all").
   * `finish`/`publish`/`outcome` rows belong to attempts already decided
   * and never touch it. `null` means no keep-queued evidence — never
   * deferred, only resolved verdicts, or rows that write no receipt
   * (launch_hold waits, lane-admission rejects and market rejections
   * keep the job queued silently) — distinct from `skipped` (the skip
   * gate's decline, a different launch decision), `task_outcome`
   * `deferred` (a batch member's requeue word) and `empty` (the finish
   * row's measured no-diff).
   */
  deferred: boolean | null;
  /**
   * The standing keep-queued verdict's recorded reason — the newest
   * defer-family row's `reason`/`defer_reason` in the bounded
   * identifier-label shape `failure_class` uses (`duplicate-request`,
   * `recut-in-flight`, the precheck park reasons like
   * `files_and_tests_exist`/`unproven_completion`/
   * `invalid_or_unknown_receipt`). A malformed label joins `null`,
   * never recorded raw; the newest defer row replaces it wholesale and
   * a superseding dispatch or decline clears it; `null` whenever
   * `deferred` is not `true`.
   */
  defer_reason: string | null;
  /**
   * The standing keep-queued verdict's recorded covering job — the
   * defer row's `repeatOf`/`repeat_of` in the bounded job-id shape:
   * `dispatch_deferred`'s duplicate-request owner and
   * `recut_admission`'s in-flight or merged prior attempt. A
   * `precheck_parked` row parks the job itself and records no cover,
   * so it stays `null` there; malformed values are skipped, never
   * recorded raw. Replaced wholesale by the newest defer row and
   * cleared with the verdict; `null` whenever `deferred` is not `true`.
   */
  defer_repeat_of: string | null;
  /**
   * The fleet's recorded terminal no-op verdict — an outcome-phase row
   * whose resolved phase sits in the canonical empty family
   * (`DONE-NOOP`, `EMPTY`, `EMPTY_DONE`, `SKIPPED-EMPTY`, `NOOP`, the
   * vocabulary skill-nudge's EMPTY_PHASES, lane-yield-verdict/weight's
   * EMPTY_PHASES, queue job-outcomes' TERMINAL_EMPTY and
   * launch_precheck's _TERMINAL_EMPTY share; `SKIPPED` stays out so a
   * batch member's task_outcome word never mints a job verdict).
   * dispatchd writes it as `{event:'outcome', state:'DONE-NOOP'}` when
   * its admission check finds the job already merged or its target PR
   * terminal (`already-merged`, `target_pr_merged`,
   * `target_pr_closed`), when a recut already merged
   * (`recut-already-merged`), and when a repair target's freshness
   * resolves (`target_pr_conflicts_resolved` and kin); restock writes
   * the same row when precheck retires the line — always with
   * `launched:false` and the recorded `reason`. It is the fleet's
   * recorded "no publishable work needed" verdict, distinct from
   * `empty` (the finish row's measured no-diff — these jobs never ran),
   * `skipped` (the skip gate's decline — the job may be re-evaluated),
   * `deferred` (kept queued) and the merge lifecycle fields (the
   * reward feed and retro feed deliberately never count DONE-NOOP as a
   * merge resolution). The verdict stands until the fleet's newer
   * recorded launch decision — a `claim`/`batch_claim`/`launch`
   * dispatch, a skip-gate receipt, a keep-queued receipt or a
   * `recut_admission` verdict — supersedes it to `false`, and a
   * standing skip or deferral clears when the no-op verdict lands,
   * since the terminal verdict resolves the queued job. `null` when no
   * empty-family phase row named the job — unknown, never a guessed
   * verdict.
   */
  noop: boolean | null;
  /**
   * The standing no-op verdict's recorded reason — the newest
   * empty-family row's `reason`, then `empty_reason`, then
   * `noop_reason`, in the bounded identifier-label shape
   * `failure_class` uses (`already-merged`, `target_pr_merged`,
   * `target_pr_closed`, `target_pr_conflicts_resolved`,
   * `target_pr_checks_resolved`, `recut-already-merged`, the precheck
   * retirement labels).
   * Malformed labels are skipped, never recorded raw; the newest
   * no-op row replaces it wholesale and a superseding launch decision
   * clears it; `null` whenever `noop` is not `true`.
   */
  noop_reason: string | null;
  /**
   * The standing no-op verdict's recorded covering attempt — the
   * no-op row's `repeatOf`/`repeat_of` in the bounded job-id shape:
   * the recut verdict's in-flight or merged prior attempt, which the
   * recut-skip DONE-NOOP row carries through from its
   * `recut_admission` receipt. The dispatchd admission,
   * repair-freshness and restock retirements record no cover, so it
   * stays `null` there; malformed values are
   * skipped, never recorded raw. Replaced wholesale by the newest
   * no-op row and cleared with the verdict; `null` whenever `noop`
   * is not `true`.
   */
  noop_repeat_of: string | null;
  /**
   * The work market's recorded routing verdict for the job — the newest
   * `work-market.v1` `route_decision` row's `chosen_lane`, the lane the
   * market last decided to send the job to (`null` inside a recorded
   * decision when it routed nowhere — `no_runnable_lane`,
   * `global_admission` or `invalid_requirements`). This is decision-side
   * intent, not the launch record: the claim rows' `lane` is where the
   * job actually ran, and a later hysteresis release, batch move or lane
   * change can legitimately diverge from the market's pick. Joins only
   * in the bounded lane-id shape; a malformed value is skipped, never
   * recorded raw. `null` when no decision row named the job or the
   * market ledger was not read — unknown, never a guessed lane.
   */
  market_lane: string | null;
  /**
   * The market decision's recorded `preferred_lane` — the job's declared
   * lane hint the market evaluated (an open hint records `null` inside
   * the decision). Same bounded lane-id shape and newest-decision rule
   * as `market_lane`; `null` when unrecorded or no decision exists.
   */
  market_preferred: string | null;
  /**
   * The market decision's recorded override reason — `override.reason`
   * on the newest `route_decision` row, the market's own
   * `resource_fit`/`unknown_preference`/`preferred_lane_fallback`
   * verdict for picking a lane other than the hint (the same closed
   * vocabulary the claim-side `lane_override` carries, minus
   * `batch_session`, which only a claim can record). Joins only in the
   * bounded lowercase reason-code shape; a malformed reason or a
   * decision with no override stays `null` — the pair
   * (`market_preferred` → `market_lane`) already names the move, so
   * only the reason joins here. `null` when no decision recorded one.
   */
  market_override: string | null;
  /**
   * The market decision's recorded `reason_codes` — why the newest
   * `route_decision` row resolved as it did: `preferred_lane` or
   * `healthy_capacity` behind a chosen lane, `no_runnable_lane` when no
   * executor could take the job, `hysteresis_*` residency/move-cap
   * holds, `hard_down`/`residency_elapsed` prior-pool switches, and
   * dispatchd's appended `global_admission`/`invalid_requirements`
   * verdicts. Entries join only in the bounded lowercase reason-code
   * shape, deduplicated in recorded order and capped; a recorded empty
   * list stays `[]` while a missing or all-unrecognizable list reads as
   * unrecorded (`null`) — the same recorded-empty-vs-missing-evidence
   * distinction `lane_hint_blocked_by` keeps. `null` when no decision
   * row named the job or the market ledger was not read.
   */
  market_reasons: string[] | null;
  /**
   * The market decision's recorded rejected lanes — the newest
   * `route_decision` row's `rejected_lanes` list: every lane the market
   * would not run the job on, each entry's `reason_codes` carrying the
   * recorded why (ineligible codes like `quota_exhausted`, `saturated`,
   * `held`, `provider_backoff`, `cost_class_*` and the `unavailable`
   * verdicts; `hysteresis_*` holds; `lower_rank` for eligible lanes
   * ranked below the chosen one). This is the per-lane detail behind a
   * `no_runnable_lane`/`global_admission` verdict that `market_reasons`
   * names only in aggregate, and it joins whether or not a lane was
   * chosen. Entries join only in the bounded lane-id shape with reasons
   * in the bounded reason-code shape — malformed entries are skipped,
   * never recorded raw; a recorded empty list stays `[]` while a
   * missing or all-unrecognizable list reads as unrecorded (`null`),
   * the same distinction `market_reasons` keeps. `null` when no
   * decision row named the job or the market ledger was not read —
   * unknown, never a guessed rejection set.
   */
  market_rejected: { lane: string; reasons: string[] | null }[] | null;
  /**
   * The fleet's recorded session-handoff advisory verdict for the job —
   * dispatchd's `session_handoff_advisory` rows (`session-failover.v1`,
   * the contrib/mac/session_handoff.py producer mirrored here). The
   * producer's closed trigger vocabulary has two verdicts:
   * `rate-limit`, the once-per-attempt receipt dispatchd appends to
   * metrics/jobs.jsonl through `metric()` when a run's log tail matched
   * a usage-limit pattern AND the attempt failed or produced no usable
   * work (docs/SESSION-HANDOFF.md) — the provider wall that names the
   * lane whose run died, distinct from the finish row's own
   * exit/empty measures since a walled run can exit cleanly and still
   * produce nothing publishable; and `quota-exhausted`, the
   * pending-job verdict dispatchd writes through `market_metric()` to
   * metrics/work-market.jsonl when the job's lane measured zero quota,
   * carrying the market's chosen lane as `target` — that market-side
   * copy is a different ledger's row (the same decision's rejection
   * evidence already folds through the route_decision joins), while
   * this fold keeps the producer's full vocabulary so a
   * quota-exhausted row that lands in the jobs window still joins
   * under the same rules. `handoff_trigger` joins only in the producer's closed
   * vocabulary (`rate-limit`, `quota-exhausted`); `handoff_lane` the
   * advisory's lane in the bounded lane-id shape and `handoff_target`
   * its target lane when one was recorded (the market's chosen lane
   * on quota-exhausted verdicts; the rate-limit producer records
   * none). The newest recognized advisory row stands like the other
   * newest-explicit fields — the triple replaces wholesale — and rows
   * of every other event never touch it; a malformed trigger, lane or
   * target is skipped, never recorded raw. All stay null when no
   * advisory row named the job — the retained window recorded no
   * provider-wall verdict, which is unknown, not "no wall ever".
   */
  handoff_trigger: string | null;
  handoff_lane: string | null;
  handoff_target: string | null;
  /**
   * The fleet's recorded provider-wall lane hold for the job —
   * dispatchd's `autobackoff_hold` receipts (jobs.jsonl rows the
   * usage/quota and auth backoff scanners append through `metric()`
   * when a finished run's log tail matched a provider error pattern
   * and the lane was held; the contrib/mac/dispatchd.py producer
   * mirrored here). A hold only lands on a failed or no-work run —
   * the auth scanner additionally requires a streak of
   * `auth_failures` — so the receipt is the fleet's confirmed
   * provider-wall verdict for the attempt, covering the auth walls
   * the session-handoff advisory never sees and the usage walls
   * whose hold landed where no advisory did. `provider_wall_trigger`
   * joins in the fold's closed two-label derivation — `usage-limit`
   * for the usage/quota scanner's pattern family, `auth-failure` for
   * the auth scanner's (a recorded `auth_failures` count marks the
   * auth streak holds outright) — `provider_wall_pattern` records
   * the producer's pattern id in the bounded identifier-label shape
   * and `provider_wall_lane` the held lane in the bounded lane-id
   * shape. The row counts only on the `autobackoff_hold` event name
   * (the `event`/`type`/`kind` alias set) with a bounded pattern id —
   * the payload field every producer hold row carries; an
   * unrecognized pattern still records the hold with trigger null
   * rather than skipping the receipt, a malformed lane drops to null
   * without discarding it, and the `autobackoff_skip`/`authbackoff_skip`
   * helper-unavailable receipts — scans that recorded no verdict —
   * never join. The newest recognized hold row stands like the other
   * newest-explicit fields — the triple replaces wholesale — and rows
   * of every other event never touch it. All stay null when no hold
   * row named the job: the retained window recorded no confirmed
   * provider wall, which is unknown, not "no wall ever".
   */
  provider_wall_trigger: string | null;
  provider_wall_pattern: string | null;
  provider_wall_lane: string | null;
  /**
   * The fleet's recorded slot-throttle detection for the job —
   * dispatchd's `pool` receipts (jobs.jsonl rows the per-tick
   * `ratelimited()` scan appends through `metric()` when a launched
   * job's recent error-log tail matches a provider-limit pattern;
   * the contrib/mac/dispatchd.py producer mirrored here). The row is
   * scan-time evidence, not a launch or terminal verdict: the
   * detector fires on a log-tail match for any job whose `.base`
   * still stands, once per (job, class) via the producer's `.seen`
   * markers, so a recovered run, an in-flight run and a finished run
   * whose finish row never recorded `pool_error` all carry the same
   * receipt. `pool_kind` joins only in the producer's closed CLS
   * vocabulary — `credits_exhausted`, `usage_limit`,
   * `model_capacity`, `rate_limit`, the same classes the finish
   * row's `pool_error` and the friction ledger's quota vocabulary
   * share — `pool_mem_free_pct` the host free-memory percentage and
   * `pool_swap_gb` the host swap figure the detector captured at
   * detection time, each only as a bounded number (a malformed
   * value drops to null without discarding the recorded class). The
   * row counts only on the `pool` event name (the
   * `event`/`type`/`kind` alias set, case-folded like the sibling
   * verdict folds); a `kind` outside the vocabulary skips the row
   * entirely, never recorded raw. The newest recognized pool row
   * replaces the triple wholesale and every other event leaves it
   * alone — the receipt competes with nothing, like the market and
   * merge-queue evidence. All three stay null when no pool row named
   * the job: the retained window recorded no throttle detection,
   * which is unknown, not "no throttle ever".
   */
  pool_kind: string | null;
  pool_mem_free_pct: number | null;
  pool_swap_gb: number | null;
  /**
   * The node runner's recorded execution verdict for the job — a
   * `phm-node-runner.v1` finish row's `outcome` word in the producer's
   * closed three-value vocabulary (src/core/drive/nodes/runner.ts):
   * `succeeded` (the pack completed and staged its result artifact),
   * `fenced` (the claim's lease was lost mid-run — renewal failed,
   * expiry passed or the node was demoted) and `failed` (the pack
   * errored or its result could not be staged). This is the offloaded
   * node-pack job's terminal execution verdict — the node pool's
   * answer to "did the work run" — distinct from every merge and
   * launch-decision field: node-pack jobs produce result artifacts,
   * not pull requests, so none of the three words is a terminal merge
   * phase and `merged` stays null. The row counts only on
   * the `phm-node-runner.v1` schema with an `outcome` inside the
   * vocabulary; the newest recognized finish row replaces the triple
   * wholesale and every other row leaves it alone. `node_id` joins the
   * row's `node` — the machine that ran the pack — and `node_pack`
   * its `pack` reference, each only in the bounded identifier shape
   * the producer's validId alphabet allows (a malformed value drops
   * to null without discarding the recorded verdict, and is never
   * recorded raw). Claim and leader fencing tokens on the same rows
   * are machinery, never outcome evidence, and never join. All three
   * stay null when no recognized runner row named the job — the
   * retained window recorded no node execution verdict, which is
   * unknown, not "never ran on a node".
   */
  node_outcome: string | null;
  node_id: string | null;
  node_pack: string | null;
  /**
   * The job's recorded merge-queue evidence — the merge-events.jsonl
   * observations for the job's newest unambiguous canonical PR claim
   * (`owner/repo#n`, the same prKey the authority revert join uses),
   * joined by readRouterOutcomes under `merge_events_state`. See
   * MergeQueueEvidence for the field semantics. Null when the merge
   * ledger was not read, the job never claimed a canonical github.com
   * pull URL unambiguously, or no merge-events row named that PR —
   * unknown, never a guessed queue history. Earlier PRs the job claimed
   * (a superseded recut's, say) are not joined: the standing claim is
   * the newest recorded one, the same newest-wins rule the merge
   * verdict follows.
   */
  merge_queue: MergeQueueEvidence | null;
  /** The lane+model's pass^k (passPowK) from the latest eval.lane-scores.v1 projection; null when unknown. */
  passk: number | null;
}

export type LedgerReadState = 'read' | 'missing' | 'unreadable' | 'not-file' | 'too-large';

export type LedgerRead = { state: 'read'; text: string } | { state: Exclude<LedgerReadState, 'read'> };

export type LedgerTailRead =
  | { state: 'read'; text: string; truncated: boolean }
  | { state: 'missing' | 'unreadable' | 'not-file' };

/**
 * Bounded read of one regular file. O_NOFOLLOW refuses a symlink at the final path
 * component (reported as 'unreadable'); only ENOENT is 'missing'. Anything past `limit`
 * bytes is 'too-large', never truncated and parsed.
 */
export async function readLedgerFile(path: string, limit = ROUTER_OUTCOME_LEDGER_LIMIT): Promise<LedgerRead> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { state: 'not-file' };
    if (stat.size > limit) return { state: 'too-large' };
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return length > limit ? { state: 'too-large' } : { state: 'read', text: bytes.subarray(0, length).toString('utf8') };
  } catch {
    return { state: 'unreadable' };
  } finally {
    await handle.close();
  }
}

/**
 * Bounded read of the newest `maxBytes` of one regular file, same symlink and
 * file-type refusals as readLedgerFile. When the file exceeds the bound the
 * first (cut) line is dropped so every returned line is whole; a window with no
 * newline at all yields empty text. `truncated` is true exactly when older
 * bytes were not read.
 */
export async function readLedgerTail(path: string, maxBytes = ROUTER_OUTCOME_LEDGER_LIMIT): Promise<LedgerTailRead> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { state: 'not-file' };
    const truncated = stat.size > maxBytes;
    const start = truncated ? stat.size - maxBytes : 0;
    const length = stat.size - start;
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(bytes, offset, length - offset, start + offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    let text = bytes.subarray(0, offset).toString('utf8');
    if (truncated) {
      const newline = text.indexOf('\n');
      text = newline < 0 ? '' : text.slice(newline + 1);
    }
    return { state: 'read', text, truncated };
  } catch {
    return { state: 'unreadable' };
  } finally {
    await handle.close();
  }
}

type Row = Record<string, unknown>;
const str = (r: Row, ...keys: string[]): string | null => {
  for (const k of keys) {
    const v = r[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
};
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const count = (v: unknown): number | null => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : null;
/** Exit statuses are safe integers of either sign — dispatchd records signal exits as negatives. */
const exitStatus = (v: unknown): number | null => Number.isSafeInteger(v) ? v as number : null;
/** Recorded ledger labels (failure classifications, usage provenance) join only bounded identifier-shaped values; anything else is skipped, never recorded raw. */
const LEDGER_LABEL = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
/** Event names across the event|type|kind dialect spelling. */
const EVENT_NAME_KEYS = ['event', 'type', 'kind'] as const;
/**
 * The recorded failure classification, in the skill-nudge precedence:
 * `failure_class`, then `failure_reason`, then `pool_error` (snake_case
 * before camelCase within each). dispatchd writes `failure_class` only for
 * the devin pool, so without the fallbacks every other lane's classified
 * cause — launch_timeout, provider_*, agent_exit_nonzero,
 * exit_status_missing, or a pool error like rate_limit — folded to null.
 * A `launch_failed` row whose `action` is `give_up` supplies the same kind
 * of evidence from the launch side: dispatchd drops the line when the
 * bounded retry budget is spent or the failure is permanent, so the row's
 * fixed `reason` label (launch_precheck's launch_timeout /
 * local_backend_unavailable / authentication / resource_exhausted /
 * provider_unavailable / launch_interrupted / launch_script_error
 * vocabulary) is the job's recorded cause for never reaching a finish.
 * `action: 'retry'` receipts are transient backoff — the job is still in
 * flight — and `launch_terminal` rows fire on requeues and skips too, so
 * neither mints a classification. The receipt's `class` field describes
 * retryability, not cause, and never joins either.
 */
const FAILURE_CLASS_KEYS = ['failure_class', 'failureClass', 'failure_reason', 'failureReason', 'pool_error', 'poolError'] as const;
const failureClass = (r: Row): string | null => {
  const v = str(r, ...FAILURE_CLASS_KEYS);
  if (v !== null && LEDGER_LABEL.test(v)) return v;
  if (str(r, ...EVENT_NAME_KEYS)?.toLowerCase() === 'launch_failed' &&
      str(r, 'action')?.toLowerCase() === 'give_up') {
    const reason = str(r, 'reason');
    if (reason !== null && LEDGER_LABEL.test(reason)) return reason;
  }
  return null;
};

/**
 * The finish row's recorded usage provenance labels — `usage_source` names
 * the measurement path that supplied the usage block (dispatchd's
 * devin-sessions-db / claude-result-json / tokens-line vocabulary) and
 * `usage_missing` names why usage stayed unknowable (its devin-, claude-
 * and tokens-line- capture-gap vocabulary). Both join in the same bounded
 * identifier shape failure_class uses — dispatchd's vocabulary is closed
 * today, but the fold records whatever bounded label a producer wrote
 * rather than second-guessing it; snake_case before camelCase.
 */
const usageLabel = (r: Row, ...keys: string[]): string | null => {
  const v = str(r, ...keys);
  return v !== null && LEDGER_LABEL.test(v) ? v : null;
};

/**
 * The recorded repo label — a bare fleet name or an `owner/repo` pair,
 * each segment a bounded identifier (`phantom`, `ashlr-md`,
 * `ashlrai/phantom` all fit; absolute paths, whitespace and deeper
 * paths do not). dispatchd's repo cell is a repo name, not a path, so
 * anything outside the shape is skipped rather than recorded raw.
 */
const REPO_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;
const repoLabel = (r: Row): string | null => {
  const v = str(r, 'repo');
  return v !== null && REPO_LABEL.test(v) ? v : null;
};

/**
 * The finish row's recorded empty-diff classification. dispatchd writes
 * `empty_class` from launch_precheck.classify_empty — a closed three-value
 * vocabulary (EMPTY_NO_DIFF/EMPTY_ERROR/EMPTY_UNKNOWN), so unlike
 * failure_class the fold accepts only those labels: an unrecognized
 * spelling is not evidence of a known class and stays null. snake_case
 * before camelCase, the same dialect tolerance the other finish fields use.
 */
const EMPTY_CLASS_KEYS = ['empty_class', 'emptyClass'] as const;
const EMPTY_CLASSES: ReadonlySet<string> = new Set(['no_diff', 'error', 'unknown']);
const emptyClass = (r: Row): string | null => {
  const v = str(r, ...EMPTY_CLASS_KEYS);
  return v !== null && EMPTY_CLASSES.has(v) ? v : null;
};

/**
 * RQ-BATCH-* ids are batch-session infrastructure, not jobs: dispatchd runs
 * related ready lines as one session whose members arrive through
 * `batch_claim` rows and close through per-member `task_outcome` rows,
 * while the session id's own launch/finish rows carry session-aggregate
 * evidence no single job owns (members get no per-member finish row, so
 * their usage stays unmeasured — the same call the fleet outcome readers
 * make). The sibling readers already skip the prefix; the fold does the
 * same so a session never mints a phantom outcome or a PR-URL claim.
 */
const BATCH_SESSION_PREFIX = 'RQ-BATCH-';
/**
 * The node session pool's ledger schema (src/core/fleet/session-pool.ts,
 * CONTRACT.md RQ-CMP-ORG-RUNTIME-1). Its task rows carry two ids under the
 * producer's own contract: `job` is the unique per-attempt id
 * (`<sessionId>:<n>` — session machinery, never a job identity) and `jobId`
 * the logical queue id the attempt worked (`ready:<job>:<attempt>`, the
 * node bridge's routerJobId). Only `jobId` may key an outcome: the
 * standard dialect would otherwise mint one phantom outcome per attempt
 * and never attach the attempt's launch/finish rows to the queue job
 * they actually ran. `session_start`/`session_stop` carry no job fields
 * and stay unattached either way; `session_rotate` carries the
 * just-pulled task's ids like `launch`/`finish` do.
 */
const SESSION_POOL_SCHEMA = 'fleet.session-pool.v1';
/**
 * The node runner's ledger schema (src/core/drive/nodes/runner.ts —
 * the multi-Mac node pool's pack executor). Its finish rows carry the
 * same dual-id contract the session pool uses: `job` is the unique
 * per-claim id (`<jobId>:<token>` — the claim's fencing token makes
 * every attempt distinct) and `jobId` the logical node-queue id the
 * claim worked (`ready:<job>:<attempt>`, the node bridge's
 * routerJobId). Only `jobId` may key an outcome: the standard dialect
 * would otherwise mint one phantom outcome per claim token and never
 * attach the finish rows to the queue job they actually ran, and a
 * retried claim's rows fold into the same outcome like the session
 * pool's. The row's `outcome` is the runner's closed terminal verdict
 * vocabulary — `succeeded` (the pack completed and staged its result
 * artifact), `fenced` (the lease was lost mid-run — renewal failed,
 * expiry passed or the node was demoted) and `failed` (the pack errored
 * or its result could not be staged) — an execution verdict, never a
 * merge phase: node-pack jobs produce result artifacts, not pull
 * requests, so none of the three words resolves a merge verdict and
 * `merged` stays null. The producer writes exactly one row shape
 * (`event: 'finish'`); the fold keys the verdict on the schema plus
 * the bounded outcome word and lets `node`/`pack` join independently
 * in the producer's id shape.
 */
const NODE_RUNNER_SCHEMA = 'phm-node-runner.v1';
const NODE_RUNNER_OUTCOMES: ReadonlySet<string> = new Set(['succeeded', 'fenced', 'failed']);
/**
 * Bounded identifier shape for the runner's `node` and `pack` fields —
 * the producer validates both through drive/nodes/state.ts's validId
 * (`[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}`); the fold keeps the same
 * alphabet at the 63-character bound the file's other id fields use.
 * A malformed value drops to null rather than skipping the recorded
 * verdict, and anything outside the shape is never recorded raw.
 */
const NODE_RUNNER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$/;

/**
 * The batch member's recorded end-of-session word — the `task_outcome`
 * row's `outcome` field in dispatchd's closed batcher.OUTCOMES vocabulary:
 * `done`/`skipped` handed the member to its own publish, while
 * `failed`/`deferred`/`unreported` requeued it. Only `task_outcome`
 * events carry the word; every other row's `outcome` field stays a
 * merge-phase spelling and never sets it. snake_case before camelCase on
 * the event name, the same dialect tolerance the other event reads use.
 */
const TASK_OUTCOME_EVENTS: ReadonlySet<string> = new Set(['task_outcome']);
const TASK_OUTCOME_WORDS: ReadonlySet<string> = new Set(['done', 'skipped', 'failed', 'deferred', 'unreported']);
const taskOutcome = (r: Row): string | null => {
  const event = str(r, ...EVENT_NAME_KEYS);
  if (event === null || !TASK_OUTCOME_EVENTS.has(event)) return null;
  const word = str(r, 'outcome');
  return word !== null && TASK_OUTCOME_WORDS.has(word) ? word : null;
};

/**
 * The claim events that can carry lane-routing evidence — `claim` for
 * solo launches, `batch_claim` for batch members. The same pair the
 * lane-override fold reads; kept under its own name so each fold binds
 * the evidence it consumes.
 */
const LANE_BLOCKED_CLAIM_EVENTS: ReadonlySet<string> = new Set(['claim', 'batch_claim']);
/**
 * The recorded blocking-code and hint shapes — the same bounds the
 * lane-override fold applies to its pair: each blocked-by entry joins
 * only as a lowercase bounded reason code and the claim's hint only as
 * a bounded lane id. Anything else is skipped, never recorded raw.
 */
const LANE_BLOCKED_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const LANE_BLOCKED_HINT = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
/** Bound on recorded blocking codes per claim — the market's per-lane rejection list never approaches it. */
const LANE_BLOCKED_MAX = 32;

/**
 * The claim row's recorded lane-hint blocking codes. dispatchd spreads
 * the market's `preferred_lane_blocked_by` onto solo `claim` rows whose
 * launch left its hinted lane — the rejected preferred lane's
 * `reason_codes`, possibly empty when the lane was unknown to the
 * market or merely outranked (`resource_fit`/`unknown_preference`/
 * hysteresis-held fallbacks record `[]`). `batch_claim` rows never
 * carry the field. Entries join only in the bounded reason-code shape,
 * deduplicated in recorded order and capped; a non-array value or a
 * list whose entries are all unrecognizable reads as unrecorded
 * (`null`), while a recorded empty list stays `[]` — the market's own
 * "nothing blocked it" verdict, distinct from missing evidence.
 */
const laneHintBlockedBy = (r: Row): string[] | null => {
  const v = r['lane_hint_blocked_by'];
  if (!Array.isArray(v)) return null;
  if (v.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of v) {
    if (out.length >= LANE_BLOCKED_MAX) break;
    if (typeof entry === 'string' && LANE_BLOCKED_CODE.test(entry) && !seen.has(entry)) {
      seen.add(entry);
      out.push(entry);
    }
  }
  return out.length === 0 ? null : out;
};

/**
 * Queue-admission boundary spellings. Arrival rows are the queue wait's
 * start — dispatchd's `enqueue` plus the `enqueued`/`queued` aliases
 * job-latency's boundaryEvent folds to its `queued` phase start. Dispatch
 * rows are its end — `claim`/`batch_claim`/`launch`, the same set
 * reward-feed's DISPATCH_EVENTS pairs for dispatch evidence. Event names
 * compare case-insensitively across the event|type|kind dialect, the same
 * tolerance failure_class and the revert names use.
 */
const QUEUE_ARRIVAL_EVENTS: ReadonlySet<string> = new Set(['enqueue', 'enqueued', 'queued']);
const QUEUE_DISPATCH_EVENTS: ReadonlySet<string> = new Set(['claim', 'batch_claim', 'launch']);

/**
 * The claim events that carry the dispatch routing decision — `claim`
 * for solo launches, `batch_claim` for batch members. `launch` rows
 * re-state the lane but record no override pair, and advisory `failover`
 * receipts write the same field names under a different vocabulary
 * (`failover_*` codes, hint = the failed lane) — neither is a claim
 * routing decision, so both stay out.
 */
const CLAIM_EVENTS: ReadonlySet<string> = new Set(['claim', 'batch_claim']);
/**
 * The recorded lane-override shapes, the same bounds the fleet unfed
 * claims fold applies to this field pair: the reason joins only as a
 * lowercase bounded code (the market's resource_fit /
 * unknown_preference / preferred_lane_fallback codes and the literal
 * batch_session all fit; foreign bounded codes join as written) and the
 * hint only as a bounded lane id. Anything else is skipped, never
 * recorded raw.
 */
const LANE_OVERRIDE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const LANE_OVERRIDE_HINT = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

/**
 * The skip-gate event names — dispatchd's `empty_gate` and precheck skip
 * paths write `skipped_empty`, and `precheck_skip` is the spelling the
 * sibling fleet readers (empties, job-outcomes, slot-yield,
 * leader-batches) honor for the same receipts, including the
 * `applied:false` dry-run guard: a dry run records the job still
 * launched, so it never mints a decline. `dupcheck_skip` stays out —
 * it is the detailed dupcheck receipt whose paired `skipped_empty`
 * row already carries the canonical decline.
 */
const SKIP_GATE_EVENTS: ReadonlySet<string> = new Set(['skipped_empty', 'precheck_skip']);

/**
 * The standing skip verdict's recorded reason label — the newest skip
 * row's `reason`, then `empty_reason`, then `skip_reason`, with a
 * bounded-string `code` as the last resort (sibling readers treat a
 * string code as the skip's label; integer codes join `skip_code`
 * instead). Accepted only in the bounded identifier-label shape
 * `failure_class` uses; the first recorded spelling decides, so a
 * malformed reason is skipped rather than replaced by a fallback.
 */
const SKIP_REASON_KEYS = ['reason', 'empty_reason', 'skip_reason', 'code'] as const;
const skipReason = (r: Row): string | null => {
  const v = str(r, ...SKIP_REASON_KEYS);
  return v !== null && LEDGER_LABEL.test(v) ? v : null;
};

/**
 * The standing skip verdict's recorded gate code — the newest skip
 * row's `code`/`precheck_code` as a non-negative safe integer
 * (dispatchd's precheck exit-status vocabulary). String `code` values
 * join `skip_reason` instead; anything else is skipped, never
 * recorded raw.
 */
const skipCode = (r: Row): number | null => count(r['code']) ?? count(r['precheck_code']);

/**
 * The keep-queued event names — dispatchd's launch loop writes
 * `dispatch_deferred` when a ready line's request digest is already
 * covered by an earlier job's claim, and `precheck_parked` when the
 * precheck parks the job for a bounded retry (the row only exists for
 * the park verdict — code 13 — so every receipt is a deferral).
 * `recut_admission` rows carry the recut coverage verdict under an
 * `action` field and fold separately: `defer` marks the standing
 * deferral while `ready`/`skip` resolve it.
 */
const DEFER_EVENTS: ReadonlySet<string> = new Set(['dispatch_deferred', 'precheck_parked']);
const RECUT_ADMISSION_EVENT = 'recut_admission';
/**
 * The standing keep-queued verdict's recorded reason label — the
 * defer row's `reason`, then `defer_reason`, in the same bounded
 * identifier-label shape `failure_class` uses. The writers' vocabulary
 * is closed today (`duplicate-request`, `recut-in-flight`, the
 * precheck park reasons), but the fold records whatever bounded label
 * a producer wrote rather than second-guessing it; anything else is
 * skipped, never recorded raw.
 */
const DEFER_REASON_KEYS = ['reason', 'defer_reason'] as const;
const deferReason = (r: Row): string | null => {
  const v = str(r, ...DEFER_REASON_KEYS);
  return v !== null && LEDGER_LABEL.test(v) ? v : null;
};
/**
 * The standing keep-queued verdict's recorded covering job — the defer
 * row's `repeatOf`/`repeat_of` in the bounded job-id shape the reward
 * ledger accepts. `precheck_parked` rows carry no cover field, so they
 * join `null` here; a malformed value is skipped, never recorded raw.
 */
const DEFER_REPEAT_OF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const deferRepeatOf = (r: Row): string | null => {
  const v = str(r, 'repeatOf', 'repeat_of');
  return v !== null && DEFER_REPEAT_OF.test(v) ? v : null;
};

/**
 * The terminal no-op phase vocabulary — the fleet's canonical empty
 * family across the sibling readers: skill-nudge's EMPTY_PHASES,
 * lane-yield-verdict/weight's EMPTY_PHASES, queue job-outcomes'
 * TERMINAL_EMPTY and launch_precheck's _TERMINAL_EMPTY. DONE-NOOP is
 * the live spelling — dispatchd's admission, recut-skip and
 * repair-freshness verdicts and restock's precheck retirements write
 * `{event:'outcome', state:'DONE-NOOP'}`; the rest are defensive dialect
 * coverage. `SKIPPED` stays out on purpose: a `task_outcome` row's
 * `outcome` field resolves to it, and a batch member's session word
 * must never mint a job-level verdict.
 */
const TERMINAL_NOOP_PHASES: ReadonlySet<string> = new Set([
  'DONE-NOOP', 'EMPTY', 'EMPTY_DONE', 'SKIPPED-EMPTY', 'NOOP',
]);
/**
 * The standing no-op verdict's recorded reason label — the newest
 * empty-family row's `reason`, then `empty_reason`, then `noop_reason`,
 * in the same bounded identifier-label shape `failure_class` uses. The
 * writers' vocabulary is closed today (`already-merged`,
 * `target_pr_merged`/`target_pr_closed`,
 * `target_pr_conflicts_resolved`, `recut-already-merged`, the precheck
 * retirement labels), but the fold records whatever bounded label a
 * producer wrote rather than second-guessing it; anything else is
 * skipped, never recorded raw.
 */
const NOOP_REASON_KEYS = ['reason', 'empty_reason', 'noop_reason'] as const;
const noopReason = (r: Row): string | null => {
  const v = str(r, ...NOOP_REASON_KEYS);
  return v !== null && LEDGER_LABEL.test(v) ? v : null;
};

/**
 * The session-handoff advisory's row schema and closed trigger
 * vocabulary, mirrored from the producer (contrib/mac/
 * session_handoff.py): `session_handoff_advisory` rows carry
 * `schema: 'session-failover.v1'` and a `trigger` of `rate-limit`
 * (a run attempt died on a usage-limit wall) or `quota-exhausted`
 * (a pending job's lane measured zero quota). dispatchd appends the
 * rate-limit verdict to metrics/jobs.jsonl through the same `metric()`
 * path every other job receipt takes and the quota-exhausted verdict
 * to metrics/work-market.jsonl through `market_metric()`; the router
 * keeps its own copy of the vocabulary so a producer-side rename can
 * never leak an unbounded label into router.outcome.v1.
 */
const HANDOFF_SCHEMA = 'session-failover.v1';
const HANDOFF_EVENT = 'session_handoff_advisory';
const HANDOFF_TRIGGERS: ReadonlySet<string> = new Set(['rate-limit', 'quota-exhausted']);

/**
 * The autobackoff lane-hold receipt's event name and the producer's
 * pattern-id tables, mirrored from contrib/mac/dispatchd.py: the
 * usage/quota scanner's `AB_RX` ids classify `usage-limit` walls and
 * the auth scanner's `AB_AUTH_RX` ids classify `auth-failure` walls —
 * the router keeps its own copy of both tables so a producer-side
 * rename can never leak an unbounded label into router.outcome.v1.
 * `claude_oauth_expired` sits in the usage table producer-side (the
 * usage scanner's own OAuth-expiry line), so it classifies
 * `usage-limit` here exactly as the producer's scan order implies.
 * A recorded `auth_failures` count marks the auth scanner's streak
 * holds outright — the producer writes it on every auth hold and
 * never on a usage hold — so the derivation stays honest even if a
 * pattern id is renamed; a pattern outside both tables still records
 * the bounded id with trigger null rather than guessing a family.
 */
const WALL_HOLD_EVENT = 'autobackoff_hold';
const WALL_TRIGGER_USAGE = 'usage-limit';
const WALL_TRIGGER_AUTH = 'auth-failure';
const USAGE_WALL_PATTERNS: ReadonlySet<string> = new Set([
  'codex_usage_limit', 'codex_credits_exhausted', 'codex_rate_limit_429',
  'claude_usage_limit', 'claude_rate_limit_error', 'claude_credit_balance',
  'claude_oauth_expired',
  'devin_acu_exhausted', 'devin_usage_limit', 'devin_weekly_quota',
]);
const AUTH_WALL_PATTERNS: ReadonlySet<string> = new Set([
  'codex_auth_failure', 'devin_auth_failure',
  'claude_auth_401', 'claude_not_logged_in', 'claude_auth_error',
]);
const wallTrigger = (r: Row, pattern: string): string | null => {
  const authFailures = r['auth_failures'];
  if (typeof authFailures === 'number' && Number.isFinite(authFailures) && authFailures >= 0) {
    return WALL_TRIGGER_AUTH;
  }
  if (AUTH_WALL_PATTERNS.has(pattern)) return WALL_TRIGGER_AUTH;
  if (USAGE_WALL_PATTERNS.has(pattern)) return WALL_TRIGGER_USAGE;
  return null;
};

/**
 * The slot-throttle detector's receipt event name and closed class
 * vocabulary, mirrored from the producer (contrib/mac/dispatchd.py):
 * the per-tick `ratelimited()` scan matches a launched job's recent
 * error-log tail against `CLS` — credits_exhausted, usage_limit,
 * model_capacity, rate_limit, in the producer's own order — and the
 * first unmarked match appends a `pool` row carrying the class under
 * `kind` plus the host `mem_free_pct`/`swap_gb` readings. The router
 * keeps its own copy of the vocabulary so a producer-side rename can
 * never leak an unbounded label into router.outcome.v1; the same four
 * classes are the finish row's `pool_error` values and the friction
 * ledger's quota-error set. `mem_free_pct` is a percentage and joins
 * only inside [0, 100]; `swap_gb` joins only as a non-negative
 * figure — both through the same bounded-number rule the other
 * measured fields use.
 */
const POOL_EVENT = 'pool';
const POOL_KINDS: ReadonlySet<string> = new Set([
  'credits_exhausted', 'usage_limit', 'model_capacity', 'rate_limit',
]);
/** A recorded free-memory percentage joins only inside its physical range. */
const memFreePct = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n <= 100 ? n : null;
};

// Revert evidence uses the same field vocabulary the fleet ledger readers
// already honor: event names (event/type/kind), terminal state fields
// (phase/state/outcome/status/result/conclusion) and the reverted_at /
// revertedAt stamps (ask status stream and outcome metrics dialects).
const REVERT_NAMES: ReadonlySet<string> = new Set(['revert', 'reverted']);
/**
 * jobs.jsonl terminal-phase dialect: phase|state|outcome|status plus the
 * producer aliases result|conclusion — the same field set and order the
 * fleet's shared ledgerPhase accessor and sibling outcome readers accept.
 * Merge and revert resolution share it.
 */
const PHASE_KEYS = ['phase', 'state', 'outcome', 'status', 'result', 'conclusion'] as const;
const hasRevertName = (r: Row, keys: readonly string[]): boolean =>
  keys.some(k => {
    const v = r[k];
    return typeof v === 'string' && REVERT_NAMES.has(v.trim().toLowerCase());
  });
const hasRevertStamp = (r: Row): boolean =>
  ['reverted_at', 'revertedAt'].some(k => {
    const v = r[k];
    return typeof v === 'string' && v.trim() !== '' && Number.isFinite(Date.parse(v));
  });

/**
 * jobs.jsonl timestamp dialect: ts|timestamp|at|time|mergedAt|closedAt|
 * recordedAt|updatedAt, with mergedAt/closedAt preferred on terminal rows —
 * the same field set dispatchd `_vc_pick` and metrics/loop accept.
 */
const LEDGER_TS_KEYS = ['ts', 'timestamp', 'at', 'time', 'mergedAt', 'closedAt', 'recordedAt', 'updatedAt'] as const;
/** Timestamp keys for a row in the given phase; MERGED prefers mergedAt, CLOSED closedAt. */
const ledgerTsKeys = (phase: string): readonly string[] => {
  const preferred = phase === 'MERGED' ? 'mergedAt' : phase === 'CLOSED' ? 'closedAt' : null;
  return preferred === null ? LEDGER_TS_KEYS : [preferred, ...LEDGER_TS_KEYS.filter(k => k !== preferred)];
};

/**
 * Event names that carry a terminal merge verdict when no phase field
 * resolves — the job-outcomes convention ('merged'/'closed'). A resolved
 * phase always stays authoritative over the event name, and every other
 * event or phase spelling resolves nothing: unknown stays unknown.
 */
const OUTCOME_EVENT_STATES: Readonly<Record<string, string>> = { merged: 'MERGED', closed: 'CLOSED' };

/** Uppercased terminal phase for merge resolution; the event name only when no phase field resolves. */
const mergePhase = (r: Row): string => {
  const phase = (str(r, ...PHASE_KEYS) ?? '').toUpperCase();
  if (phase !== '') return phase;
  return OUTCOME_EVENT_STATES[(str(r, 'event', 'type', 'kind') ?? '').toLowerCase()] ?? '';
};

/** A github.com pull URL in the canonical shape dispatchd and the fleet writers emit. */
const GITHUB_PULL_URL = /^https:\/\/github\.com\/([^/?#\s]+)\/([^/?#\s]+)\/pull\/([1-9]\d*)\/?$/i;

/** `owner/repo#n` (lowercase repo) for a pull URL; null when the URL is not that shape. */
function pullRequestKey(url: string): string | null {
  const m = GITHUB_PULL_URL.exec(url);
  return m ? `${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}#${m[3]}` : null;
}

/** Landing ids are `${repo}#${prNumber}@${mergeSha12}` (fleet/host-merge.ts landingId()). */
const LANDING_PR = /^([^#@\s]+)#([1-9]\d*)@/;

/**
 * The evidence-row fields the authority revert join reads — a structural
 * subset of the authority ledger's LedgerEvidenceRow, declared locally so
 * callers and tests never import the Tier-1 ledger module for a read-only
 * join. LedgerEvidenceRow rows are assignable as given.
 */
export interface RouterOutcomeEvidenceRow {
  kind: string;
  landingId: string | null;
  revertsLandingId?: string | null;
}

/**
 * prKey-form (`owner/repo#n`, lowercase repo) identities of merged PRs the
 * authority ledger records as reverted: a `revert:landed` evidence row whose
 * `revertsLandingId` resolves to a `merge:landed` row's landing id. The rows
 * are the chain-verified index — a broken chain still contributes only
 * hash-verified prefix entries. Unparseable landing ids, reverts targeting
 * non-merge landings and merge rows reclassified as reverts contribute
 * nothing: unknown stays unknown.
 */
export function authorityRevertedPrKeys(evidence: readonly RouterOutcomeEvidenceRow[]): Set<string> {
  const merges = new Map<string, string>();
  for (const row of evidence) {
    if (row.kind !== 'merge:landed' || row.landingId === null) continue;
    const m = LANDING_PR.exec(row.landingId);
    if (m) merges.set(row.landingId, `${m[1]!.toLowerCase()}#${m[2]}`);
  }
  const keys = new Set<string>();
  for (const row of evidence) {
    if (row.kind !== 'revert:landed') continue;
    const target = row.revertsLandingId;
    if (target == null) continue;
    const key = merges.get(target);
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

export interface RouterOutcomeFold {
  outcomes: RouterOutcome[];
  /** Non-blank lines that were not a JSON object. Skipped, never attached. */
  malformed_rows: number;
  /** Rows with no job identity that could not be attached. */
  unattached_rows: number;
  /** PR URLs claimed by more than one job; URL-only rows for them are not attached to any job. */
  ambiguous_urls: number;
  /**
   * Rows keyed by an RQ-BATCH-* session id — batch-session infrastructure
   * evidence (launch, finish, session-aggregate usage). They never form
   * outcomes and never claim PR URLs; member jobs fold through their own
   * batch_claim/task_outcome/publish/verdict rows instead.
   */
  session_rows: number;
}

export interface RouterOutcomeFoldOptions {
  /** Resolve the advisory pass^k score for a (lane, model) pair; absent or null stays null. */
  passkFor?: (lane: string, model: string) => number | null;
  /**
   * Resolve the market-recorded work_class for a job id; consulted only
   * when no jobs.jsonl row carried one. Absent or null/empty stays null.
   */
  workClassFor?: (jobId: string) => string | null;
  /**
   * `owner/repo#n` (lowercase repo) identities of merged PRs recorded as
   * reverted — e.g. `authorityRevertedPrKeys` over the authority ledger's
   * verified evidence index. A jobs row whose PR URL claim resolves
   * unambiguously to its own job and canonicalizes to one of these keys
   * marks the outcome `reverted: true` (sticky-true); ambiguous or
   * foreign claims never mark. Absent means no authority join.
   */
  revertedPrKeys?: ReadonlySet<string>;
  /**
   * `owner/repo#n` (lowercase repo) → recorded merge-queue evidence, e.g.
   * `foldMergeEvents` over metrics/merge-events.jsonl. The fold joins each
   * outcome's newest unambiguous canonical PR claim (the same claim rule
   * `revertedPrKeys` applies) to its summary as `merge_queue`; a job with
   * no unambiguous claim or no recorded events keeps null. Absent means no
   * merge-events join — every merge_queue stays null.
   */
  mergeEvents?: ReadonlyMap<string, MergeQueueEvidence>;
}

/** Folds JSONL text into one outcome per job. Explicit fields only; nothing inferred. */
export function foldRouterOutcomes(text: string, opts: RouterOutcomeFoldOptions = {}): RouterOutcomeFold {
  const rows: Row[] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) rows.push(value as Row);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  // fleet.session-pool.v1 and phm-node-runner.v1 rows resolve their job
  // identity differently: `job` is the per-attempt id and `jobId` the
  // logical queue id, so the attempt id must never key an outcome (see
  // SESSION_POOL_SCHEMA and NODE_RUNNER_SCHEMA).
  const jobId = (r: Row) => r['schema'] === SESSION_POOL_SCHEMA || r['schema'] === NODE_RUNNER_SCHEMA
    ? str(r, 'jobId')
    : str(r, 'job', 'job_id', 'jobId', 'id');
  const prUrl = (r: Row) => str(r, 'url', 'pr_url', 'prUrl', 'pr');

  // A PR URL resolves to a job only when exactly one job claims it. Batch
  // session rows are infrastructure: they never claim URLs themselves.
  const claims = new Map<string, Set<string>>();
  for (const r of rows) {
    const j = jobId(r), u = prUrl(r);
    if (j && u && !j.startsWith(BATCH_SESSION_PREFIX)) claims.set(u, (claims.get(u) ?? new Set()).add(j));
  }
  const ambiguous = new Set([...claims].filter(([, jobs]) => jobs.size > 1).map(([u]) => u));
  const urlToJob = new Map([...claims].filter(([u, jobs]) => !ambiguous.has(u) && jobs.size === 1)
    .map(([u, jobs]) => [u, [...jobs][0]!] as const));

  // Queue-admission evidence, derived once per job from the same boundary
  // stamps job-latency's queue_wait phase pairs: arrival rows (enqueue/
  // enqueued/queued) start the wait, dispatch rows (claim/batch_claim/
  // launch) end it. queue_wait_s is the earliest dispatch minus the latest
  // arrival at or before it — a requeue's later arrivals never move the
  // first-dispatch wait, and a job with no recorded arrival before its
  // first dispatch stays absent here so its outcome keeps null.
  const queueMarks = new Map<string, { arrivals: number[]; dispatches: number[] }>();
  for (const r of rows) {
    const j = jobId(r);
    if (!j || j.startsWith(BATCH_SESSION_PREFIX)) continue;
    const event = str(r, ...EVENT_NAME_KEYS);
    if (event === null) continue;
    const name = event.toLowerCase();
    const arrival = QUEUE_ARRIVAL_EVENTS.has(name);
    if (!arrival && !QUEUE_DISPATCH_EVENTS.has(name)) continue;
    const at = Date.parse(str(r, ...LEDGER_TS_KEYS) ?? '');
    if (!Number.isFinite(at)) continue;
    const marks = queueMarks.get(j) ?? { arrivals: [], dispatches: [] };
    (arrival ? marks.arrivals : marks.dispatches).push(at);
    queueMarks.set(j, marks);
  }
  const queueWaitS = new Map<string, number>();
  for (const [j, marks] of queueMarks) {
    if (marks.arrivals.length === 0 || marks.dispatches.length === 0) continue;
    const firstDispatch = Math.min(...marks.dispatches);
    let admission = Number.NEGATIVE_INFINITY;
    for (const a of marks.arrivals) if (a <= firstDispatch && a > admission) admission = a;
    if (admission === Number.NEGATIVE_INFINITY) continue;
    const waitMs = firstDispatch - admission;
    if (waitMs >= 0) queueWaitS.set(j, waitMs / 1000);
  }

  // CI-boundary evidence, derived once per job from the same ci_start/
  // ci_complete event pair the reward feed's ciWallMs and job-latency's
  // ci phase read: exactly one of each boundary yields the recorded CI
  // wall seconds, identical repeated stamps dedupe so a replayed append
  // cannot fake ambiguity, and a missing, reversed or repeated boundary
  // set leaves the job absent so its outcome keeps null.
  const ciMarks = new Map<string, { starts: Set<number>; completes: Set<number> }>();
  for (const r of rows) {
    const j = jobId(r);
    if (!j || j.startsWith(BATCH_SESSION_PREFIX)) continue;
    const event = str(r, ...EVENT_NAME_KEYS);
    if (event === null) continue;
    const name = event.toLowerCase();
    if (name !== 'ci_start' && name !== 'ci_complete') continue;
    const at = Date.parse(str(r, ...LEDGER_TS_KEYS) ?? '');
    if (!Number.isFinite(at)) continue;
    const marks = ciMarks.get(j) ?? { starts: new Set<number>(), completes: new Set<number>() };
    (name === 'ci_start' ? marks.starts : marks.completes).add(at);
    ciMarks.set(j, marks);
  }
  const ciWallS = new Map<string, number>();
  for (const [j, marks] of ciMarks) {
    if (marks.starts.size !== 1 || marks.completes.size !== 1) continue;
    const wallMs = [...marks.completes][0]! - [...marks.starts][0]!;
    if (wallMs >= 0) ciWallS.set(j, wallMs / 1000);
  }

  // Publish-station evidence, derived once per job from the same
  // finish -> publish boundary pair job-latency's publish_wait phase
  // and visit-sync's publish station read: exactly one finish stamp
  // and one publish stamp across the retained rows yields the recorded
  // publish wait — identical repeated stamps dedupe so a replayed
  // append cannot fake ambiguity, and a retried attempt's second
  // finish or a republish's second publish leaves the job absent so
  // its outcome keeps null. Terminal lifecycle phases stay
  // authoritative over the event name: the outcomes reconciler copies
  // the publish row and only swaps the outcome, so its
  // {event:'publish', outcome:'MERGED'} row is merge evidence stamped
  // at verdict time, never a second publish — while a PUBLISHED phase
  // on any row is the publish claim itself, event name or not.
  const publishMarks = new Map<string, { finishes: Set<number>; publishes: Set<number> }>();
  for (const r of rows) {
    const j = jobId(r);
    if (!j || j.startsWith(BATCH_SESSION_PREFIX)) continue;
    const event = str(r, ...EVENT_NAME_KEYS)?.toLowerCase() ?? null;
    const phase = mergePhase(r);
    const terminal = phase === 'MERGED' || phase === 'CLOSED';
    const finish = event === 'finish' && !terminal && phase !== 'PUBLISHED';
    const publish = phase === 'PUBLISHED' || ((event === 'publish' || event === 'published') && !terminal);
    if (!finish && !publish) continue;
    const at = Date.parse(str(r, ...LEDGER_TS_KEYS) ?? '');
    if (!Number.isFinite(at)) continue;
    const marks = publishMarks.get(j) ?? { finishes: new Set<number>(), publishes: new Set<number>() };
    (finish ? marks.finishes : marks.publishes).add(at);
    publishMarks.set(j, marks);
  }
  const publishWaitS = new Map<string, number>();
  for (const [j, marks] of publishMarks) {
    if (marks.finishes.size !== 1 || marks.publishes.size !== 1) continue;
    const waitMs = [...marks.publishes][0]! - [...marks.finishes][0]!;
    if (waitMs >= 0) publishWaitS.set(j, waitMs / 1000);
  }

  // Each job's standing PR identity for side-ledger joins: the newest row
  // (ledger order) whose canonical github.com pull URL this job claims
  // unambiguously — the same claim rule the authority revert join applies,
  // so a contested or foreign URL never resolves to a prKey.
  const jobPrKeys = new Map<string, string>();

  const outcomes = new Map<string, RouterOutcome>();
  const mergedAt = new Map<string, number>();
  let unattached = 0;
  let sessionRows = 0;
  for (const r of rows) {
    const u = prUrl(r);
    const j = jobId(r) ?? (u ? urlToJob.get(u) : undefined);
    if (!j) { unattached++; continue; }
    if (j.startsWith(BATCH_SESSION_PREFIX)) { sessionRows++; continue; }
    if (u !== null && urlToJob.get(u) === j) {
      const prKey = pullRequestKey(u);
      if (prKey !== null) jobPrKeys.set(j, prKey);
    }
    const o: RouterOutcome = outcomes.get(j) ?? {
      schema: 'router.outcome.v1', job_id: j, lane: null, model: null, tier: null, work_class: null,
      repo: null,
      lane_hint: null, lane_override: null,
      merged: null, reverted: null, ci_first_pass: null, review_findings: null, cost_usd: null, wall_s: null,
      tokens_total: null, acus: null, tokens_in: null, tokens_out: null,
      tokens_cache_read: null, tokens_cache_write: null,
      usage_source: null, usage_missing: null,
      ttm_s: null, queue_wait_s: queueWaitS.get(j) ?? null, ci_wall_s: ciWallS.get(j) ?? null,
      publish_wait_s: publishWaitS.get(j) ?? null,
      empty: null, diff_files: null, diff_lines: null,
      exit_code: null, failure_class: null, empty_class: null, empty_tag: null,
      task_outcome: null, lane_hint_blocked_by: null,
      skipped: null, skip_reason: null, skip_code: null,
      deferred: null, defer_reason: null, defer_repeat_of: null,
      noop: null, noop_reason: null, noop_repeat_of: null,
      market_lane: null, market_preferred: null, market_override: null, market_reasons: null,
      market_rejected: null,
      handoff_trigger: null, handoff_lane: null, handoff_target: null,
      provider_wall_trigger: null, provider_wall_pattern: null, provider_wall_lane: null,
      pool_kind: null, pool_mem_free_pct: null, pool_swap_gb: null,
      node_outcome: null, node_id: null, node_pack: null,
      merge_queue: null,
      passk: null,
    };
    o.lane = str(r, 'lane', 'pool', 'arm') ?? o.lane;
    o.model = str(r, 'model') ?? o.model;
    o.tier = str(r, 'tier') ?? o.tier;
    o.work_class = str(r, 'work_class') ?? o.work_class;
    o.repo = repoLabel(r) ?? o.repo;
    // The claim rows are the job's routing decisions: the newest one
    // stands, so a later claim that ran on its hint clears an earlier
    // override, and every non-claim row leaves the pair alone. A
    // malformed reason or hint is skipped — the pair cannot be named
    // honestly — while an override reason without a recorded hint still
    // joins with lane_hint null, the same tolerance the unfed claims
    // fold applies.
    const claimEvent = str(r, ...EVENT_NAME_KEYS)?.toLowerCase();
    if (claimEvent !== undefined && CLAIM_EVENTS.has(claimEvent)) {
      const reason = str(r, 'lane_override');
      if (reason === null) {
        o.lane_hint = null;
        o.lane_override = null;
      } else if (LANE_OVERRIDE_CODE.test(reason)) {
        const hint = str(r, 'lane_hint');
        if (hint === null || LANE_OVERRIDE_HINT.test(hint)) {
          o.lane_override = reason;
          o.lane_hint = hint;
        }
      }
    }
    const state = mergePhase(r);
    const merged = state === 'MERGED' ? true : state === 'CLOSED' ? false : typeof r['merged'] === 'boolean' ? r['merged'] : null;
    if (merged !== null) {
      const ts = Date.parse(str(r, ...ledgerTsKeys(state)) ?? '') || 0;
      if (ts >= (mergedAt.get(j) ?? -1)) {
        o.merged = merged;
        mergedAt.set(j, ts);
        // ttm_s is merge evidence: only the row that stands as the merge
        // verdict supplies it, so a close clears it and a non-merge row's
        // figure is never attached (the sibling fleet readers gate the same
        // way). The newest winning row replaces it wholesale.
        o.ttm_s = merged === true ? num(r['ttm_s']) ?? num(r['ttmS']) : null;
      }
    }
    // Sticky-true, matching metrics-ingest: any recorded revert evidence wins
    // and a later reverted:false cannot undo it; explicit false only stands
    // when no positive evidence exists anywhere in the job's rows.
    if (o.reverted !== true) {
      if (r['reverted'] === true || hasRevertStamp(r) || hasRevertName(r, EVENT_NAME_KEYS) || hasRevertName(r, PHASE_KEYS)) {
        o.reverted = true;
      } else if (r['reverted'] === false) {
        o.reverted = false;
      }
      // The authority-ledger join marks only through the row's own unambiguous
      // PR claim: urlToJob.get(u) === j means this job is the URL's single
      // claimant, so a reverted pull can never mark a foreign or contested job.
      if (o.reverted !== true && u !== null && urlToJob.get(u) === j && opts.revertedPrKeys !== undefined) {
        const key = pullRequestKey(u);
        if (key !== null && opts.revertedPrKeys.has(key)) o.reverted = true;
      }
    }
    if (typeof r['ci_first_pass'] === 'boolean') o.ci_first_pass = r['ci_first_pass'];
    o.cost_usd = num(r['cost_usd']) ?? num(r['usd']) ?? num(r['cost']) ?? o.cost_usd;
    o.wall_s = num(r['wall_s']) ?? o.wall_s;
    o.tokens_total = num(r['tokens_total']) ?? num(r['tokensTotal']) ?? o.tokens_total;
    o.acus = num(r['acus']) ?? num(r['acus_consumed']) ?? num(r['acusConsumed']) ?? o.acus;
    o.tokens_in = num(r['tokens_in']) ?? num(r['tokensIn']) ?? o.tokens_in;
    o.tokens_out = num(r['tokens_out']) ?? num(r['tokensOut']) ?? o.tokens_out;
    o.tokens_cache_read = num(r['tokens_cache_read']) ?? num(r['tokensCacheRead']) ?? o.tokens_cache_read;
    o.tokens_cache_write = num(r['tokens_cache_write']) ?? num(r['tokensCacheWrite']) ?? o.tokens_cache_write;
    o.usage_source = usageLabel(r, 'usage_source', 'usageSource') ?? o.usage_source;
    o.usage_missing = usageLabel(r, 'usage_missing', 'usageMissing') ?? o.usage_missing;
    if (typeof r['empty'] === 'boolean') o.empty = r['empty'];
    o.diff_files = num(r['diff_files']) ?? num(r['diffFiles']) ?? o.diff_files;
    o.diff_lines = num(r['diff_lines']) ?? num(r['diffLines']) ?? o.diff_lines;
    o.exit_code = exitStatus(r['exit_code']) ?? exitStatus(r['exitCode']) ?? o.exit_code;
    o.failure_class = failureClass(r) ?? o.failure_class;
    o.empty_class = emptyClass(r) ?? o.empty_class;
    o.task_outcome = taskOutcome(r) ?? o.task_outcome;
    const f = r['review_findings'];
    if (f !== null && typeof f === 'object' && !Array.isArray(f)) {
      const fixed = count((f as Row)['fixed']), rejected = count((f as Row)['rejected']), ignored = count((f as Row)['ignored']);
      if (fixed !== null && rejected !== null && ignored !== null) o.review_findings = { fixed, rejected, ignored };
    }
    // The same claim rows carry the hinted lane's recorded blocking
    // codes — the third field of the dispatch override record. The
    // newest claim stands under the same rule the override pair
    // follows: a later claim that ran on its hint clears the codes, a
    // malformed reason or hint skips the row entirely, and every
    // non-claim row leaves them alone.
    const blockedEvent = str(r, ...EVENT_NAME_KEYS)?.toLowerCase();
    if (blockedEvent !== undefined && LANE_BLOCKED_CLAIM_EVENTS.has(blockedEvent)) {
      const blockedReason = str(r, 'lane_override');
      if (blockedReason === null) {
        o.lane_hint_blocked_by = null;
      } else if (LANE_BLOCKED_CODE.test(blockedReason)) {
        const blockedHint = str(r, 'lane_hint');
        if (blockedHint === null || LANE_BLOCKED_HINT.test(blockedHint)) {
          o.lane_hint_blocked_by = laneHintBlockedBy(r);
        }
      }
    }
    // The skip-gate's launch-decline receipts compete with the dispatch
    // rows on row order like the claim override pair: a
    // skipped_empty/precheck_skip row (applied !== false — a dry run
    // records the job still launched) marks the standing decline with
    // its recorded reason/code, while a later claim/batch_claim/launch
    // row or a dry-run receipt supersedes it to false. finish/publish/
    // outcome rows belong to attempts already decided and never touch
    // the verdict; non-skip, non-dispatch rows leave it alone.
    const skipEvent = str(r, ...EVENT_NAME_KEYS)?.toLowerCase();
    if (skipEvent !== undefined && SKIP_GATE_EVENTS.has(skipEvent)) {
      if (r['applied'] !== false) {
        o.skipped = true;
        o.skip_reason = skipReason(r);
        o.skip_code = skipCode(r);
      } else if (o.skipped === true) {
        o.skipped = false;
        o.skip_reason = null;
        o.skip_code = null;
      }
    } else if (skipEvent !== undefined && QUEUE_DISPATCH_EVENTS.has(skipEvent) && o.skipped === true) {
      o.skipped = false;
      o.skip_reason = null;
      o.skip_code = null;
    }
    // The keep-queued receipts compete with the other launch-decision
    // rows on row order like the skip decline: a
    // dispatch_deferred/precheck_parked row or a recut_admission 'defer'
    // marks the standing deferral with its recorded reason/cover, a
    // recut_admission 'ready'/'skip' resolves the blocker, and a later
    // claim/batch_claim/launch dispatch or skip-gate decline — the
    // fleet's newer recorded decision about the same queued job —
    // supersedes it to false. finish/publish/outcome rows belong to
    // attempts already decided and never touch the verdict; an
    // unrecognized recut action or non-defer event leaves it alone.
    const deferEvent = str(r, ...EVENT_NAME_KEYS)?.toLowerCase();
    if (deferEvent !== undefined && DEFER_EVENTS.has(deferEvent)) {
      o.deferred = true;
      o.defer_reason = deferReason(r);
      o.defer_repeat_of = deferRepeatOf(r);
    } else if (deferEvent === RECUT_ADMISSION_EVENT) {
      const action = str(r, 'action')?.toLowerCase();
      if (action === 'defer') {
        o.deferred = true;
        o.defer_reason = deferReason(r);
        o.defer_repeat_of = deferRepeatOf(r);
      } else if ((action === 'ready' || action === 'skip') && o.deferred === true) {
        o.deferred = false;
        o.defer_reason = null;
        o.defer_repeat_of = null;
      }
    } else if (deferEvent !== undefined && o.deferred === true &&
        (QUEUE_DISPATCH_EVENTS.has(deferEvent) || SKIP_GATE_EVENTS.has(deferEvent))) {
      o.deferred = false;
      o.defer_reason = null;
      o.defer_repeat_of = null;
    }
    // The fleet's recorded terminal no-op verdict competes with the other
    // launch-decision rows on row order like the skip and keep-queued
    // verdicts: an outcome-phase row whose resolved phase sits in the
    // canonical empty family (DONE-NOOP and kin — dispatchd's
    // already-merged/terminal-target, recut-skip and repair-freshness
    // verdicts, restock's precheck retirements) marks the standing
    // verdict with its recorded reason/cover and resolves any standing
    // skip or deferral — the terminal verdict is the fleet's newest
    // recorded decision about the queued job (a null skip/defer stays
    // null: no receipt was ever recorded, so none is superseded). Every
    // newer launch-decision receipt — a claim/batch_claim/launch
    // dispatch, a skip-gate row, a keep-queued receipt or a
    // recut_admission verdict — supersedes it to false ("a no-op
    // verdict was recorded but the job was decided again after all").
    // finish/publish/outcome rows of other phases and non-decision
    // events never touch it; the newest no-op row replaces reason and
    // cover wholesale.
    if (TERMINAL_NOOP_PHASES.has(state)) {
      o.noop = true;
      o.noop_reason = noopReason(r);
      o.noop_repeat_of = deferRepeatOf(r);
      if (o.skipped === true) {
        o.skipped = false;
        o.skip_reason = null;
        o.skip_code = null;
      }
      if (o.deferred === true) {
        o.deferred = false;
        o.defer_reason = null;
        o.defer_repeat_of = null;
      }
    } else if (o.noop === true && deferEvent !== undefined &&
        (QUEUE_DISPATCH_EVENTS.has(deferEvent) || SKIP_GATE_EVENTS.has(deferEvent) ||
         DEFER_EVENTS.has(deferEvent) || deferEvent === RECUT_ADMISSION_EVENT)) {
      o.noop = false;
      o.noop_reason = null;
      o.noop_repeat_of = null;
    }
    // The session-handoff advisory is the fleet's recorded provider-wall
    // verdict for the job — evidence about an attempt, not a launch
    // decision, so it competes with nothing: the newest recognized
    // advisory row replaces the triple wholesale and every other event
    // leaves it alone. The row counts only on the exact
    // session-failover.v1 schema and event name with a trigger inside
    // the producer's closed vocabulary; lane and target join
    // independently in the bounded lane-id shape, so a malformed value
    // drops to null rather than skipping the recorded trigger, and a
    // malformed trigger skips the row entirely — never recorded raw.
    if (r['schema'] === HANDOFF_SCHEMA &&
        str(r, ...EVENT_NAME_KEYS)?.toLowerCase() === HANDOFF_EVENT) {
      const trigger = str(r, 'trigger');
      if (trigger !== null && HANDOFF_TRIGGERS.has(trigger)) {
        const lane = str(r, 'lane');
        const target = str(r, 'target');
        o.handoff_trigger = trigger;
        o.handoff_lane = lane !== null && LANE_BLOCKED_HINT.test(lane) ? lane : null;
        o.handoff_target = target !== null && LANE_BLOCKED_HINT.test(target) ? target : null;
      }
    }
    // The autobackoff lane-hold receipt is the fleet's confirmed
    // provider-wall verdict for the job — the usage/quota and auth
    // backoff scanners' hold decision recorded beside the
    // session-handoff advisory. It is likewise attempt evidence, not
    // a launch decision, so it competes with nothing: the newest
    // recognized hold row replaces the triple wholesale and every
    // other event leaves it alone. The row counts only on the
    // autobackoff_hold event name with a bounded pattern id — the
    // payload field every producer hold row carries; the trigger
    // derives from the producer's mirrored pattern tables (a recorded
    // auth_failures count marks the auth streak holds outright), the
    // lane joins independently in the bounded lane-id shape, and an
    // unrecognized pattern still records the hold with trigger null
    // rather than skipping the receipt — a producer-side pattern
    // addition degrades to bounded evidence, never a guessed family.
    // The autobackoff_skip/authbackoff_skip helper-unavailable
    // receipts record no verdict and never join.
    if (str(r, ...EVENT_NAME_KEYS)?.toLowerCase() === WALL_HOLD_EVENT) {
      const pattern = str(r, 'pattern');
      if (pattern !== null && LEDGER_LABEL.test(pattern)) {
        const lane = str(r, 'lane');
        o.provider_wall_trigger = wallTrigger(r, pattern);
        o.provider_wall_pattern = pattern;
        o.provider_wall_lane = lane !== null && LANE_BLOCKED_HINT.test(lane) ? lane : null;
      }
    }
    // The slot-throttle detector's receipt is the fleet's recorded
    // provider-limit detection for the job — scan-time evidence like
    // the market and merge-queue joins, not a launch or terminal
    // verdict, so it competes with nothing: the newest recognized
    // pool row replaces the triple wholesale and every other event
    // leaves it alone. The row counts only on the `pool` event name
    // with a `kind` inside the producer's closed CLS vocabulary —
    // the payload field every producer pool row carries; the host
    // memory readings join independently as bounded numbers, so a
    // malformed value drops to null rather than skipping the
    // recorded class, and a `kind` outside the vocabulary skips the
    // row entirely — never recorded raw.
    if (str(r, ...EVENT_NAME_KEYS)?.toLowerCase() === POOL_EVENT) {
      const kind = str(r, 'kind');
      if (kind !== null && POOL_KINDS.has(kind)) {
        o.pool_kind = kind;
        o.pool_mem_free_pct = memFreePct(r['mem_free_pct']);
        o.pool_swap_gb = num(r['swap_gb']);
      }
    }
    // The node runner's finish receipt is the fleet's recorded
    // execution verdict for an offloaded node-pack job — attempt
    // evidence like the market and pool joins, not a launch or merge
    // decision, so it competes with nothing: the newest recognized
    // runner row replaces the triple wholesale and every other row
    // leaves it alone. The row counts only on the
    // phm-node-runner.v1 schema with an `outcome` inside the
    // producer's closed vocabulary — succeeded/fenced/failed; a word
    // outside it skips the row entirely, never recorded raw — while
    // `node` and `pack` join independently in the bounded id shape,
    // so a malformed value drops to null without discarding the
    // recorded verdict. The row's `job`/`token`/`leaderToken` fields
    // are claim machinery and never join.
    if (r['schema'] === NODE_RUNNER_SCHEMA) {
      const verdict = str(r, 'outcome');
      if (verdict !== null && NODE_RUNNER_OUTCOMES.has(verdict)) {
        const node = str(r, 'node');
        const pack = str(r, 'pack');
        o.node_outcome = verdict;
        o.node_id = node !== null && NODE_RUNNER_ID.test(node) ? node : null;
        o.node_pack = pack !== null && NODE_RUNNER_ID.test(pack) ? pack : null;
      }
    }
    outcomes.set(j, o);
  }
  if (opts.passkFor || opts.workClassFor) {
    for (const o of outcomes.values()) {
      if (opts.passkFor && o.lane !== null && o.model !== null) {
        const score = opts.passkFor(o.lane, o.model);
        o.passk = typeof score === 'number' && Number.isFinite(score) ? score : null;
      }
      if (opts.workClassFor && o.work_class === null) {
        const workClass = opts.workClassFor(o.job_id);
        if (typeof workClass === 'string' && workClass.trim()) o.work_class = workClass.trim();
      }
    }
  }
  if (opts.mergeEvents !== undefined) {
    for (const o of outcomes.values()) {
      const prKey = jobPrKeys.get(o.job_id);
      if (prKey === undefined) continue;
      const evidence = opts.mergeEvents.get(prKey);
      if (evidence === undefined) continue;
      o.merge_queue = { ...evidence, blocked_reasons: [...evidence.blocked_reasons] };
    }
  }
  return {
    outcomes: [...outcomes.values()],
    malformed_rows: malformed,
    unattached_rows: unattached,
    ambiguous_urls: ambiguous.size,
    session_rows: sessionRows,
  };
}

/**
 * Folds api-spend.jsonl text into per-job USD cost sums — the dispatch
 * collector's per-call spend feed. A row attributes to a job through
 * job|job_id|id and reports cost as cost_usd|usd|cost, the precedence the
 * fleet spend readers (runs-job-cost, runs-resource-ledger) already use.
 * Rows that are not objects, name no job, or report no usable cost are
 * skipped; a job whose calls never reported a cost stays absent from the map
 * so its outcome keeps cost_usd null — unknown, never zero. Estimated costs
 * (cost_estimated) still report a USD figure and count toward the sum.
 */
export function foldSpendCosts(text: string): Map<string, number> {
  const costs = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const r = value as Row;
    const j = str(r, 'job', 'job_id', 'id');
    if (!j) continue;
    const cost = num(r['cost_usd']) ?? num(r['usd']) ?? num(r['cost']);
    if (cost === null) continue;
    costs.set(j, (costs.get(j) ?? 0) + cost);
  }
  return costs;
}

/** work_class joins only values shaped like the route identifiers weight proposals group on. */
const MARKET_WORK_CLASS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Folds work-market.jsonl route_decision rows into each job's latest recorded
 * work_class. The dispatcher re-decides every waiting job each tick, so rows
 * collapse to the newest timestamp per job — the same latest-decision rule
 * the unfed report applies. Only work-market.v1 route_decision rows with a
 * bounded job id, a finite epoch-seconds ts and a route-identifier-shaped
 * work_class count; every other row is skipped, never guessed. The class is
 * the market's own classification of the job (declared or derived from its
 * requirements), recorded whether or not a lane was chosen.
 */
export function foldRouteDecisionWorkClasses(text: string): Map<string, string> {
  const latest = new Map<string, { workClass: string; ts: number }>();
  for (const line of text.split('\n')) {
    // Cheap prefilter: route decisions are the bulk of the file.
    if (!line.includes('"route_decision"')) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Row;
    if (row['schema'] !== 'work-market.v1' || row['event'] !== 'route_decision') continue;
    const job = row['job'];
    if (typeof job !== 'string' || job.length === 0 || job.length > 200) continue;
    const ts = row['ts'];
    if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
    const workClass = row['work_class'];
    if (typeof workClass !== 'string' || !MARKET_WORK_CLASS.test(workClass)) continue;
    const prev = latest.get(job);
    if (prev !== undefined && prev.ts >= ts) continue;
    latest.set(job, { workClass, ts });
  }
  return new Map([...latest].map(([job, entry]) => [job, entry.workClass]));
}

/**
 * One rejected lane inside a route_decision's `rejected_lanes` record —
 * the market's per-lane why for not running the job there. `reasons` is
 * the entry's `reason_codes` under the same bounded-code rule
 * `reason_codes` follows on the decision itself: a recorded empty list
 * stays `[]`, a missing or all-unrecognizable list reads as unrecorded
 * (`null`).
 */
export interface MarketRejectedLane {
  lane: string;
  reasons: string[] | null;
}

/**
 * One job's newest work-market route_decision verdict — the decision-side
 * routing record the outcome's market_* fields carry. `lane` is the
 * market's `chosen_lane` (null inside a recorded decision when it routed
 * nowhere), `preferred` its `preferred_lane` hint, `override` the
 * `override.reason` code when the market picked off-hint, `reasons` its
 * `reason_codes` list, and `rejected` its `rejected_lanes` per-lane
 * rejection record. Every field stays null when the row recorded none —
 * unknown, never guessed.
 */
export interface MarketRouteDecision {
  lane: string | null;
  preferred: string | null;
  override: string | null;
  reasons: string[] | null;
  rejected: MarketRejectedLane[] | null;
}

/** Bound on recorded rejected lanes per decision — the dispatcher's lane set never approaches it. */
const MARKET_REJECTED_MAX = 32;

/**
 * A recorded reason-code list under the bounded reason-code shape:
 * entries deduplicated in recorded order and capped; a recorded empty
 * list stays `[]`, a missing, non-array or all-unrecognizable list
 * reads as unrecorded (`null`) — the same distinction
 * lane_hint_blocked_by and market_reasons keep.
 */
const boundedReasonList = (v: unknown): string[] | null => {
  if (!Array.isArray(v)) return null;
  if (v.length === 0) return [];
  const collected: string[] = [];
  const seen = new Set<string>();
  for (const code of v) {
    if (collected.length >= LANE_BLOCKED_MAX) break;
    if (typeof code === 'string' && LANE_BLOCKED_CODE.test(code) && !seen.has(code)) {
      seen.add(code);
      collected.push(code);
    }
  }
  return collected.length === 0 ? null : collected;
};

/**
 * The decision row's `rejected_lanes` record — the market's per-lane
 * rejection list. Each entry joins only as an object whose `lane`
 * matches the bounded lane-id shape; its `reason_codes` joins under
 * the same bounded-code rule `reason_codes` follows (recorded empty
 * stays `[]`, missing or all-unrecognizable reads `null`). A recorded
 * empty list stays `[]`, a missing or non-array value reads as
 * unrecorded (`null`), and a non-empty list whose every entry is
 * malformed reads as unrecorded too — never a guessed rejection set.
 */
const marketRejectedLanes = (v: unknown): MarketRejectedLane[] | null => {
  if (!Array.isArray(v)) return null;
  if (v.length === 0) return [];
  const collected: MarketRejectedLane[] = [];
  for (const entry of v) {
    if (collected.length >= MARKET_REJECTED_MAX) break;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const lane = (entry as Row)['lane'];
    if (typeof lane !== 'string' || !LANE_BLOCKED_HINT.test(lane)) continue;
    collected.push({ lane, reasons: boundedReasonList((entry as Row)['reason_codes']) });
  }
  return collected.length === 0 ? null : collected;
};

/**
 * Folds work-market.jsonl route_decision rows into each job's newest
 * recorded routing verdict. The dispatcher re-decides every waiting job
 * each tick, so rows collapse to the newest timestamp per job — the same
 * latest-decision rule foldRouteDecisionWorkClasses and the unfed
 * report's latestRouteDecisions apply, but without the work_class
 * requirement: a decision row counts on its bounded job id and finite
 * epoch-seconds ts alone, and each field joins only when it parses in
 * its bounded shape. `chosen_lane`/`preferred_lane` join in the bounded
 * lane-id shape the claim folds use, `override.reason` in the bounded
 * lowercase reason-code shape, `reason_codes` entries deduplicated
 * in recorded order and capped — a recorded empty list stays `[]`
 * while a missing or all-unrecognizable list reads as unrecorded
 * (`null`), the same distinction lane_hint_blocked_by keeps — and
 * `rejected_lanes` entries joining per lane under the same shapes: a
 * recorded empty list stays `[]`, a missing or all-unrecognizable
 * list reads as unrecorded (`null`), and a non-empty list whose every
 * entry is malformed reads as unrecorded too. Rows with a missing or
 * non-finite ts, a wrong schema/event, or a malformed job id are
 * skipped, never guessed; a job absent from the map keeps every
 * market_* field null.
 */
export function foldRouteDecisions(text: string): Map<string, MarketRouteDecision> {
  const latest = new Map<string, { ts: number; decision: MarketRouteDecision }>();
  for (const line of text.split('\n')) {
    // Cheap prefilter: route decisions are the bulk of the file.
    if (!line.includes('"route_decision"')) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Row;
    if (row['schema'] !== 'work-market.v1' || row['event'] !== 'route_decision') continue;
    const job = row['job'];
    if (typeof job !== 'string' || job.length === 0 || job.length > 200) continue;
    const ts = row['ts'];
    if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
    const prev = latest.get(job);
    if (prev !== undefined && prev.ts >= ts) continue;
    const lane = row['chosen_lane'];
    const preferred = row['preferred_lane'];
    const override = row['override'];
    const overrideReason = override !== null && typeof override === 'object' && !Array.isArray(override)
      ? (override as Row)['reason'] : undefined;
    const reasons = boundedReasonList(row['reason_codes']);
    const rejected = marketRejectedLanes(row['rejected_lanes']);
    latest.set(job, {
      ts,
      decision: {
        lane: typeof lane === 'string' && LANE_BLOCKED_HINT.test(lane) ? lane : null,
        preferred: typeof preferred === 'string' && LANE_BLOCKED_HINT.test(preferred) ? preferred : null,
        override: typeof overrideReason === 'string' && LANE_BLOCKED_CODE.test(overrideReason) ? overrideReason : null,
        reasons,
        rejected,
      },
    });
  }
  return new Map([...latest].map(([job, entry]) => [job, entry.decision]));
}

/**
 * The empty-tags ledger's row schema and closed tag vocabulary, mirrored
 * from the producer (src/core/fleet/empty-tags.ts): `phm jobs empty
 * --record` appends `job.empty-tag.v1` rows — { schema, job, lane, tag } —
 * where tag is one of EMPTY_TAGS. The router keeps its own copy of the
 * vocabulary so a fleet-side rename can never leak an unbounded label
 * into router.outcome.v1.
 */
const EMPTY_TAG_SCHEMA = 'job.empty-tag.v1';
const EMPTY_TAGS: ReadonlySet<string> = new Set([
  'already_done', 'pool_cap', 'blocked', 'no_change_needed', 'unknown',
]);

/**
 * Folds empty-tags.jsonl text into each job's recorded empty tag. The
 * ledger carries no timestamp — recordEmptyTags dedups by job id, so a
 * repeated row for one job resolves last-appended-wins like every other
 * append-only fold here. Only rows with the exact job.empty-tag.v1 schema,
 * a bounded job id and a tag in the closed EMPTY_TAGS vocabulary count;
 * malformed JSON, other schemas, out-of-vocabulary tags and non-object
 * rows are skipped, never guessed. A job with no tag row stays absent from
 * the map so its outcome keeps empty_tag null — the recorded-unknown tag
 * is itself evidence, distinct from missing evidence.
 */
export function foldEmptyTags(text: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const line of text.split('\n')) {
    // Cheap prefilter: the schema marker is on every real row.
    if (!line.includes(EMPTY_TAG_SCHEMA)) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Row;
    if (row['schema'] !== EMPTY_TAG_SCHEMA) continue;
    const job = row['job'];
    if (typeof job !== 'string' || job.length === 0 || job.length > 200) continue;
    const tag = row['tag'];
    if (typeof tag !== 'string' || !EMPTY_TAGS.has(tag)) continue;
    tags.set(job, tag);
  }
  return tags;
}

/**
 * One PR's recorded merge-queue evidence — the merge-events.jsonl
 * observations `foldMergeEvents` collapses per `owner/repo#n` key. Every
 * figure counts recorded rows under the same validation the fleet
 * merge-latency reader applies; a PR with no qualifying rows has no map
 * entry at all, so a joined outcome's merge_queue always carries at
 * least one recorded event.
 */
export interface MergeQueueEvidence {
  /** Recorded merge-events rows naming the PR. */
  events: number;
  /**
   * Distinct recorded `blocked` reasons in first-seen order — the merge
   * queue's own blocker vocabulary (`required_checks`, `review`,
   * `conflict`, `queue`, `other`). A `blocked` row without a recorded
   * in-vocabulary reason is not a merge observation at all and never
   * counts.
   */
  blocked_reasons: string[];
  /** Recorded `conflict` rows. */
  conflicts: number;
  /**
   * Recorded `check_observed` rows whose conclusion is `failure` —
   * required and unrelated check failures alike; `required` absent or
   * false still counts here.
   */
  check_failures: number;
  /** Of those, rows recorded `required: true`. */
  required_check_failures: number;
  /**
   * Distinct recorded `retry_requested` rows — deduplicated by
   * `at`+`head_sha` exactly like the merge-latency reader's retry
   * verdict, so a replayed append counts once.
   */
  retries: number;
  /** Distinct recorded `retry_failed` rows under the same dedupe. */
  retry_failures: number;
  /** Recorded `recut_requested` rows — the fleet asked for a recut of this PR. */
  recuts: number;
  /**
   * The ledger's last recorded auto-merge toggle in append order —
   * `enabled`/`disabled`; null when no toggle row was recorded. Untimed
   * toggle rows still count: they are state evidence, and append order
   * is the ledger's own chronology.
   */
  auto_merge: 'enabled' | 'disabled' | null;
}

/**
 * The merge-events ledger's closed event vocabulary — the same set the
 * fleet merge-latency reader accepts (src/cli/fleet-merge-latency.ts
 * MergeEventType). The router keeps its own copy so a producer-side
 * rename can never leak an unbounded event name into
 * router.outcome.v1.
 */
const MERGE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'opened', 'queued', 'checks_passed', 'conflict', 'recut_requested',
  'retry_requested', 'retry_failed', 'merged', 'closed',
  'auto_merge_enabled', 'auto_merge_disabled', 'eligible', 'blocked',
  'check_observed',
]);

/**
 * The `blocked` row's closed reason vocabulary — the merge-queue blocker
 * set (src/core/fleet/merge-queue-status.ts MergeQueueBlocker), kept as a
 * local copy for the same reason the event vocabulary is.
 */
const MERGE_BLOCKER_REASONS: ReadonlySet<string> = new Set([
  'queue', 'required_checks', 'conflict', 'review', 'other',
]);

/**
 * Merge-event types the ledger contract allows without a parseable `at`
 * — the auto-merge toggles and the merged/closed terminals are state
 * evidence; every other type needs its timestamp, the same rule
 * fleet-merge-latency's parseEvent applies.
 */
const MERGE_UNTIMED_TYPES: ReadonlySet<string> = new Set([
  'auto_merge_enabled', 'auto_merge_disabled', 'merged', 'closed',
]);

/**
 * Folds merge-events.jsonl text into per-PR merge-queue evidence keyed
 * `owner/repo#n` (lowercase repo — the same prKey shape
 * pullRequestKey and authorityRevertedPrKeys produce, so the outcome
 * join needs no second canonicalization). Only rows passing the same
 * validation the merge-latency reader applies count: a `blocked` row
 * needs a recorded in-vocabulary `reason`, a `check_observed` row a
 * recorded `conclusion` (and a boolean `required` when present), every
 * non-state/terminal type a parseable `at`, and `repo`/`pr`/`type` the
 * recorded shapes — anything else is skipped, never guessed. `blocked`
 * reasons join distinct in first-seen order; retry rows dedupe by
 * `at`+`head_sha` like the sibling's retry verdict; `auto_merge` is the
 * last recorded toggle in append order. Rows for PRs no jobs outcome
 * claims unambiguously join nothing — the map itself never creates
 * outcomes.
 */
export function foldMergeEvents(text: string): Map<string, MergeQueueEvidence> {
  interface Acc {
    events: number;
    blocked: string[];
    blockedSeen: Set<string>;
    conflicts: number;
    checkFailures: number;
    requiredCheckFailures: number;
    retryKeys: Set<string>;
    retryFailedKeys: Set<string>;
    recuts: number;
    autoMerge: 'enabled' | 'disabled' | null;
  }
  const prs = new Map<string, Acc>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Row;
    const repo = row['repo'];
    const pr = row['pr'];
    const type = row['type'];
    if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
        typeof pr !== 'number' || !Number.isSafeInteger(pr) || pr < 1 ||
        typeof type !== 'string' || !MERGE_EVENT_TYPES.has(type)) continue;
    let reason: string | null = null;
    if (type === 'blocked') {
      const r = row['reason'];
      if (typeof r !== 'string' || !MERGE_BLOCKER_REASONS.has(r)) continue;
      reason = r;
    }
    let conclusion: string | null = null;
    let required = false;
    if (type === 'check_observed') {
      const c = row['conclusion'];
      if (c !== 'success' && c !== 'failure' && c !== 'pending') continue;
      conclusion = c;
      const req = row['required'];
      if (req !== undefined && typeof req !== 'boolean') continue;
      required = req === true;
    }
    const at = row['at'];
    const atOk = typeof at === 'string' && Number.isFinite(Date.parse(at));
    if (!atOk && !MERGE_UNTIMED_TYPES.has(type)) continue;
    const key = `${repo.toLowerCase()}#${pr}`;
    const acc = prs.get(key) ?? {
      events: 0, blocked: [], blockedSeen: new Set<string>(), conflicts: 0,
      checkFailures: 0, requiredCheckFailures: 0,
      retryKeys: new Set<string>(), retryFailedKeys: new Set<string>(),
      recuts: 0, autoMerge: null,
    };
    acc.events++;
    if (reason !== null && !acc.blockedSeen.has(reason)) {
      acc.blockedSeen.add(reason);
      acc.blocked.push(reason);
    }
    if (type === 'conflict') acc.conflicts++;
    if (conclusion === 'failure') {
      acc.checkFailures++;
      if (required) acc.requiredCheckFailures++;
    }
    if (type === 'retry_requested' || type === 'retry_failed') {
      const head = typeof row['head_sha'] === 'string' ? row['head_sha'].toLowerCase() : '';
      const dedupe = `${at}|${head}`;
      (type === 'retry_requested' ? acc.retryKeys : acc.retryFailedKeys).add(dedupe);
    }
    if (type === 'recut_requested') acc.recuts++;
    if (type === 'auto_merge_enabled' || type === 'auto_merge_disabled') {
      acc.autoMerge = type === 'auto_merge_enabled' ? 'enabled' : 'disabled';
    }
    prs.set(key, acc);
  }
  return new Map([...prs].map(([key, a]) => [key, {
    events: a.events,
    blocked_reasons: a.blocked,
    conflicts: a.conflicts,
    check_failures: a.checkFailures,
    required_check_failures: a.requiredCheckFailures,
    retries: a.retryKeys.size,
    retry_failures: a.retryFailedKeys.size,
    recuts: a.recuts,
    auto_merge: a.autoMerge,
  }]));
}

export interface RouterOutcomeRead extends RouterOutcomeFold {
  /** 'read' is the only state with trustworthy outcomes; everything else is an unknown ledger. */
  state: LedgerReadState;
  path: string;
  /** Health of the eval.lane-scores.v1 projection behind `passk`; 'missing' or 'degraded' means every passk is null. */
  eval_state: LaneScoresRead['state'];
  /**
   * Health of the api-spend.jsonl tail behind spend-derived `cost_usd`.
   * Anything but 'read' means no spend costs were joined — outcomes keep only
   * explicit ledger cost fields, never a fabricated or zeroed figure.
   */
  spend_state: Exclude<LedgerReadState, 'too-large'>;
  /**
   * True when the spend ledger exceeded the retained tail: joined per-job
   * costs cover only the newest bytes and are lower bounds, never totals.
   */
  spend_truncated: boolean;
  /**
   * Health of the work-market.jsonl tail behind work_class joins from
   * route_decision rows. Anything but 'read' means no market classes were
   * joined — outcomes keep only explicit jobs-ledger work_class fields.
   */
  market_state: Exclude<LedgerReadState, 'too-large'>;
  /**
   * True when the market ledger exceeded the retained tail: joined classes
   * cover only the newest bytes, so older decisions read as unclassified.
   */
  market_truncated: boolean;
  /**
   * Health of the empty-tags.jsonl tail behind empty_tag joins. Anything
   * but 'read' means no tags were joined — outcomes keep empty_tag null,
   * never a guessed cause.
   */
  empty_tag_state: Exclude<LedgerReadState, 'too-large'>;
  /**
   * True when the empty-tags ledger exceeded the retained tail: joined
   * tags cover only the newest bytes, so older empties read untagged.
   */
  empty_tag_truncated: boolean;
  /**
   * Health of the merge-events.jsonl tail behind merge_queue joins.
   * Anything but 'read' means no merge-queue evidence was joined —
   * outcomes keep merge_queue null, never a guessed queue history.
   */
  merge_events_state: Exclude<LedgerReadState, 'too-large'>;
  /**
   * True when the merge-events ledger exceeded the retained tail: joined
   * evidence covers only the newest bytes, so older PRs read unqueued.
   */
  merge_events_truncated: boolean;
  /**
   * Health of the improve/revert-outcomes.jsonl ledger behind the
   * scan-detected revert join (`phm fleet reverts --record` detections of
   * fleet PRs reverted in git history). Anything but 'read' means no
   * recorded scan reverts were joined — outcomes keep only jobs-ledger,
   * authority-ledger and explicit revert evidence; 'too-large' means the
   * ledger exceeded its bound and was refused whole rather than partially
   * trusted.
   */
  revert_ledger_state: LedgerReadState;
  /**
   * True when the ledger exceeded the retained tail: the fold, and so every
   * count on this read, covers only the newest ROUTER_OUTCOME_LEDGER_LIMIT
   * bytes — a lower bound on the full history, never a claimed total.
   */
  truncated: boolean;
}

/**
 * Index lane-score rows by (lane, model). A duplicated pair is ambiguous and resolves
 * to null; rows whose passPowK is itself null stay null. Absent or unhealthy
 * projections yield no lookup at all.
 */
function laneScoreLookup(read: LaneScoresRead): ((lane: string, model: string) => number | null) | undefined {
  if (read.state !== 'healthy' || !read.scores) return undefined;
  const index = new Map<string, number | null>();
  const ambiguous = new Set<string>();
  for (const row of read.scores.lanes) {
    const key = JSON.stringify([row.lane, row.model]);
    if (ambiguous.has(key) || index.has(key)) { index.delete(key); ambiguous.add(key); continue; }
    index.set(key, row.passPowK);
  }
  return (lane, model) => {
    const key = JSON.stringify([lane, model]);
    return ambiguous.has(key) ? null : index.get(key) ?? null;
  };
}

/**
 * The authority ledger's verified evidence index, read lazily so fold-only
 * consumers never load the ledger module. Any failure degrades to no join —
 * the same as an empty ledger, never a fabricated revert.
 */
async function liveAuthorityEvidence(): Promise<readonly RouterOutcomeEvidenceRow[]> {
  try {
    const { ledgerSnapshot } = await import('../authority/ledger.js');
    return ledgerSnapshot('cached').index.evidence;
  } catch {
    return [];
  }
}

/**
 * Recorded `phm fleet reverts --record` detections behind the second revert
 * join — reverts of fleet PRs that only git history proves, invisible to
 * the jobs ledger and the authority index. Read lazily like the authority
 * evidence so fold-only consumers never load the ledger module; the file's
 * own health is reported on the read, and anything but a fully intact
 * ledger contributes no keys — corrupt evidence never marks a merge
 * reverted.
 */
async function liveRevertOutcomeKeys(rootDir: string | undefined): Promise<{ state: LedgerReadState; keys: ReadonlySet<string> }> {
  try {
    const { readRevertOutcomeRecords, revertOutcomesLedgerPath, standingRevertKeys } = await import('../improve/revert-ledger.js');
    const read = readRevertOutcomeRecords(revertOutcomesLedgerPath(rootDir));
    const state: LedgerReadState = read.state === 'missing' ? 'missing'
      : read.state === 'read' ? 'read'
      : read.reasons.includes('ledger-too-large') ? 'too-large' : 'unreadable';
    return { state, keys: state === 'read' ? standingRevertKeys(read.records) : new Set<string>() };
  } catch {
    return { state: 'unreadable', keys: new Set<string>() };
  }
}

/** Union the authority-ledger and scan-ledger revert key sets; undefined only when neither source produced keys. */
function unionRevertKeys(authority: ReadonlySet<string> | undefined, scan: ReadonlySet<string>): ReadonlySet<string> | undefined {
  if (authority === undefined && scan.size === 0) return undefined;
  const keys = new Set<string>(authority);
  for (const key of scan) keys.add(key);
  return keys;
}

/**
 * Reads the newest ROUTER_OUTCOME_LEDGER_LIMIT bytes of
 * <runsDir>/metrics/jobs.jsonl plus the same bound of
 * <runsDir>/metrics/api-spend.jsonl, <runsDir>/metrics/work-market.jsonl,
 * <runsDir>/metrics/empty-tags.jsonl and
 * <runsDir>/metrics/merge-events.jsonl.
 * `runsDir` defaults to ASHLR_RUNS_DIR,
 * then ~/.ashlr-runs, and must be absolute when given. `ashlarDir` is the
 * ASHLR root holding eval/passk/lane-scores.json (default ASHLR_HOME, then
 * ~/.ashlr). A missing or unreadable jobs ledger yields state != 'read' with
 * no outcomes, so callers can tell unknown input from a successfully read
 * empty ledger; a ledger larger than the bound reads its tail and reports
 * truncated:true. The spend, market and empty-tags ledgers degrade
 * independently: spend_state, market_state and empty_tag_state report
 * their health, spend-derived cost_usd fills only outcomes whose explicit
 * ledger cost stayed null, market-derived work_class fills only outcomes
 * whose jobs rows recorded none, and empty_tag fills only outcomes a
 * job.empty-tag.v1 row named — a missing joined ledger never zeroes,
 * guesses or blocks the jobs fold. The market ledger's newest
 * route_decision rows additionally join each outcome's
 * market_lane/market_preferred/market_override/market_reasons/
 * market_rejected verdict fields under the same market_state health
 * and newest-decision rule
 * work_class follows — decision rows naming jobs outside the jobs
 * window never create outcomes. The merge-events tail folds through
 * `foldMergeEvents` into per-PR `owner/repo#n` evidence and joins each
 * outcome's `merge_queue` through the job's newest unambiguous
 * canonical PR claim under the same claim rule the authority revert
 * join applies; merge_events_state reports the ledger's health and
 * merge_events_truncated marks a cut tail — anything but 'read' leaves
 * every merge_queue null. `reverted` additionally joins the
 * authority ledger's verified
 * evidence index (`authorityRevertedPrKeys`): a fleet merge the ledger
 * records as reverted marks its outcome through the job's unambiguous PR
 * URL claim, so held-merge tallies see reverts jobs.jsonl never writes.
 * The same claim rule joins the second revert source —
 * `improve/revert-outcomes.jsonl`, the detections `phm fleet reverts
 * --record` appends — whose newest-record-per-PR resolution clears a key
 * when a later scan finds the revert itself was reverted;
 * `revert_ledger_state` reports that ledger's health and anything but
 * 'read' contributes no keys. The scan join is independent of the
 * `authorityEvidence` option: `null` skips only the authority read.
 */
export async function readRouterOutcomes(opts: {
  runsDir?: string;
  lane?: string;
  ashlarDir?: string;
  /**
   * Authority-ledger evidence rows behind the revert join. Absent reads the
   * live `ledgerSnapshot('cached')` verified index; `null` skips the
   * authority join only — the revert-outcomes ledger join is independent;
   * an explicit array is used as given (tests). Only hash-verified rows ever
   * contribute, so a broken chain still marks only authentic reverts.
   */
  authorityEvidence?: readonly RouterOutcomeEvidenceRow[] | null;
} = {}): Promise<RouterOutcomeRead> {
  const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  if (!isAbsolute(runsDir)) throw new RangeError('runsDir must be an absolute path');
  if (opts.ashlarDir !== undefined && !isAbsolute(opts.ashlarDir)) throw new RangeError('ashlarDir must be an absolute path');
  const laneScores = readLaneScores({ rootDir: opts.ashlarDir });
  const path = join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE);
  const read = await readLedgerTail(path);
  const empty: RouterOutcomeFold = { outcomes: [], malformed_rows: 0, unattached_rows: 0, ambiguous_urls: 0, session_rows: 0 };
  const spendRead = await readLedgerTail(join(runsDir, ROUTER_SPEND_LEDGER_RELATIVE));
  const spendState = spendRead.state;
  const spendTruncated = spendRead.state === 'read' ? spendRead.truncated : false;
  const marketRead = await readLedgerTail(join(runsDir, ROUTER_MARKET_LEDGER_RELATIVE));
  const marketState = marketRead.state;
  const marketTruncated = marketRead.state === 'read' ? marketRead.truncated : false;
  const emptyTagRead = await readLedgerTail(join(runsDir, ROUTER_EMPTY_TAGS_LEDGER_RELATIVE));
  const emptyTagState = emptyTagRead.state;
  const emptyTagTruncated = emptyTagRead.state === 'read' ? emptyTagRead.truncated : false;
  const mergeEventsRead = await readLedgerTail(join(runsDir, ROUTER_MERGE_EVENTS_LEDGER_RELATIVE));
  const mergeEventsState = mergeEventsRead.state;
  const mergeEventsTruncated = mergeEventsRead.state === 'read' ? mergeEventsRead.truncated : false;
  const revertLedger = await liveRevertOutcomeKeys(opts.ashlarDir);
  if (read.state !== 'read') {
    return { ...empty, state: read.state, path, eval_state: laneScores.state,
      spend_state: spendState, spend_truncated: spendTruncated,
      market_state: marketState, market_truncated: marketTruncated,
      empty_tag_state: emptyTagState, empty_tag_truncated: emptyTagTruncated,
      merge_events_state: mergeEventsState, merge_events_truncated: mergeEventsTruncated,
      revert_ledger_state: revertLedger.state, truncated: false };
  }
  const workClasses = marketRead.state === 'read'
    ? foldRouteDecisionWorkClasses(marketRead.text)
    : new Map<string, string>();
  const authorityEvidence = opts.authorityEvidence === undefined
    ? await liveAuthorityEvidence()
    : opts.authorityEvidence;
  const folded = foldRouterOutcomes(read.text, {
    passkFor: laneScoreLookup(laneScores),
    workClassFor: (jobId) => workClasses.get(jobId) ?? null,
    revertedPrKeys: unionRevertKeys(
      authorityEvidence === null ? undefined : authorityRevertedPrKeys(authorityEvidence),
      revertLedger.keys),
    mergeEvents: mergeEventsRead.state === 'read' ? foldMergeEvents(mergeEventsRead.text) : undefined,
  });
  if (spendRead.state === 'read') {
    const costs = foldSpendCosts(spendRead.text);
    for (const o of folded.outcomes) {
      if (o.cost_usd !== null) continue;
      const sum = costs.get(o.job_id);
      if (sum !== undefined) o.cost_usd = sum;
    }
  }
  if (emptyTagRead.state === 'read') {
    const tags = foldEmptyTags(emptyTagRead.text);
    for (const o of folded.outcomes) {
      const tag = tags.get(o.job_id);
      if (tag !== undefined) o.empty_tag = tag;
    }
  }
  if (marketRead.state === 'read') {
    const decisions = foldRouteDecisions(marketRead.text);
    for (const o of folded.outcomes) {
      const decision = decisions.get(o.job_id);
      if (decision === undefined) continue;
      o.market_lane = decision.lane;
      o.market_preferred = decision.preferred;
      o.market_override = decision.override;
      o.market_reasons = decision.reasons;
      o.market_rejected = decision.rejected;
    }
  }
  const outcomes = opts.lane === undefined ? folded.outcomes : folded.outcomes.filter(o => o.lane === opts.lane);
  return { ...folded, outcomes, state: 'read', path, eval_state: laneScores.state,
    spend_state: spendState, spend_truncated: spendTruncated,
    market_state: marketState, market_truncated: marketTruncated,
    empty_tag_state: emptyTagState, empty_tag_truncated: emptyTagTruncated,
    merge_events_state: mergeEventsState, merge_events_truncated: mergeEventsTruncated,
    revert_ledger_state: revertLedger.state,
    truncated: read.truncated };
}
