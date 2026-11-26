/**
 * `ashlr router outcomes` — read-only per-job outcome records folded from the
 * host metrics ledgers (metrics/jobs.jsonl joined with metrics/api-spend.jsonl
 * for cost_usd, metrics/work-market.jsonl for work_class and
 * metrics/empty-tags.jsonl for empty_tag) by src/core/router/outcomes.ts,
 * with the dispatcher's recorded repo cell folded as `repo`:
 * merge and revert state, CI
 * first pass, review findings, cost, wall time, recorded merge latency
 * (ttm_s), recorded queue-admission wait (queue_wait_s), recorded CI
 * wall seconds (ci_wall_s), recorded publish-station wait
 * (publish_wait_s), recorded token
 * usage (tokens_total plus the token breakdown,
 * ACU spend and usage provenance labels), the finish row's recorded diff
 * size (diff_files/diff_lines), the batch member's recorded
 * task_outcome word, the dispatch claim's recorded lane override
 * (lane_hint/lane_override), the work market's recorded routing verdict
 * (market_lane/market_preferred/market_override/market_reasons/
 * market_rejected, joined
 * from the same route_decision rows as work_class), the skip gate's
 * recorded launch decline
 * (skipped/skip_reason/skip_code), the fleet's recorded keep-queued
 * verdict (deferred/defer_reason/defer_repeat_of), the fleet's recorded
 * terminal no-op verdict
 * (noop/noop_reason/noop_repeat_of, folded from empty-family outcome
 * phases like DONE-NOOP), the fleet's recorded
 * session-handoff advisory
 * (handoff_trigger/handoff_lane/handoff_target, folded from
 * session-failover.v1 provider-wall receipts), the fleet's recorded
 * provider-wall lane hold
 * (provider_wall_trigger/provider_wall_pattern/provider_wall_lane,
 * folded from autobackoff_hold receipts), the fleet's recorded
 * slot-throttle detection
 * (pool_kind/pool_mem_free_pct/pool_swap_gb, folded from pool
 * receipts), the node runner's recorded execution verdict
 * (node_outcome/node_id/node_pack, folded from phm-node-runner.v1
 * finish rows keyed on the logical jobId), the fleet's recorded
 * empty tag
 * (empty_tag, joined from metrics/empty-tags.jsonl), the merge queue's
 * recorded per-PR observations
 * (merge_queue, joined from metrics/merge-events.jsonl through the
 * job's unambiguous canonical PR claim — blocked reasons, check
 * failures, conflicts, retries, recuts, auto-merge state) and the
 * advisory pass^k join from eval.lane-scores.v1. The reward-signal
 * substrate under the ASHLR home root
 * (<ashlr>/metrics/reward-signals.jsonl) fills what the jobs fold
 * left null — resolved `merged`, `ttm_s` (only while the standing
 * verdict is a merge), `ci_wall_s`, `cost_usd`, `repo` — and supplies
 * `pool_pct_used`, the row's recorded subscription-pool percentage
 * points consumed (a different unit than cost_usd and acus), and the
 * launch-cost ledger's recorded first-minute resource probe
 * (launch_cost_status/launch_peak_processes/launch_mean_cpu_pct/
 * launch_peak_cpu_pct, joined from metrics/launch-cost.jsonl) and the
 * standing pull request's newest recorded cross-model review verdict
 * (cross_review, joined from <ashlr>/fleet/cross-review.jsonl through
 * the job's unambiguous canonical PR claim — the review record's
 * approve/reject/failed/skipped outcome and its `at` timestamp) and
 * the job-cost-model ledger's summed modeled spend estimate
 * (modeled_cost_usd, joined from metrics/job-cost-model.jsonl — the
 * subscription lanes' only per-job dollar figure, a modeled estimate
 * never summed with cost_usd).
 * RQ-BATCH-* session rows are infrastructure evidence counted in
 * session_rows, never outcomes. Never writes; a missing ledger reports
 * `missing`, an unreadable or non-file one exits 1. Each read retains the
 * newest bounded tail of its ledger, so an oversized ledger reports
 * `truncated: true` (jobs), `spend_truncated: true` (spend),
 * `market_truncated: true` (market), `empty_tag_truncated: true`
 * (empty tags), `merge_events_truncated: true` (merge events),
 * `reward_truncated: true` (reward signals),
 * `launch_cost_truncated: true` (launch cost) or
 * `cross_review_truncated: true` (cross-review) —
 * coverage of the retained window, not a refusal.
 */
import { isAbsolute } from 'node:path';

import {
  readRouterOutcomes,
  type RouterOutcome,
  type RouterOutcomeRead,
} from '../core/router/outcomes.js';

export const ROUTER_OUTCOMES_USAGE =
  'Usage: ashlr router outcomes [--json] [--runs-dir <dir>] [--lane <lane>] [--limit <1..1000>]\n' +
  'Reads the newest bounded tail of <runs-dir>/metrics/jobs.jsonl (default ASHLR_RUNS_DIR, then ~/.ashlr-runs) joined with metrics/api-spend.jsonl for cost_usd, metrics/merge-events.jsonl for merge_queue, metrics/launch-cost.jsonl for the recorded launch resource probe, metrics/job-cost-model.jsonl for the modeled per-job spend estimate (modeled_cost_usd), plus <ashlr>/metrics/reward-signals.jsonl fills unresolved merged/ttm_s/ci_wall_s/cost_usd/repo and supplies pool_pct_used, <ashlr>/fleet/cross-review.jsonl supplies the standing PR\'s newest cross-model review verdict (cross_review); one router.outcome.v1 row per job in the retained window, newest first, truncated=true when older rows were not read. passk is advisory eval evidence, null when unknown. Exit 0 report (a missing ledger reports state=missing, not an error), 1 unreadable/non-file ledger, 2 usage.';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

interface RouterOutcomesArgs {
  runsDir?: string;
  lane?: string;
  limit: number;
  json: boolean;
}

function parseArgs(args: string[]): RouterOutcomesArgs | null {
  const parsed: RouterOutcomesArgs = { limit: DEFAULT_LIMIT, json: false };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') {
      if (seen.has(arg)) return null;
      seen.add(arg);
      parsed.json = true;
      continue;
    }
    if (arg !== '--runs-dir' && arg !== '--lane' && arg !== '--limit') return null;
    if (seen.has(arg)) return null;
    seen.add(arg);
    const value = args[++i];
    if (value === undefined || value === '' || value.startsWith('--')) return null;
    if (arg === '--runs-dir') {
      if (!isAbsolute(value)) return null;
      parsed.runsDir = value;
    } else if (arg === '--lane') {
      parsed.lane = value;
    } else {
      const limit = Number(value);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) return null;
      parsed.limit = limit;
    }
  }
  return parsed;
}

export interface RouterOutcomesReport {
  schema: 'router.outcomes.v1';
  state: RouterOutcomeRead['state'];
  path: string;
  eval_state: RouterOutcomeRead['eval_state'];
  /** Health of the api-spend.jsonl tail behind spend-derived cost_usd. */
  spend_state: RouterOutcomeRead['spend_state'];
  /** True when the spend tail was cut and spend-derived costs were withheld. */
  spend_truncated: boolean;
  /** Health of the work-market.jsonl tail behind work_class joins. */
  market_state: RouterOutcomeRead['market_state'];
  /** True when the market tail was cut; joined classes cover only the newest bytes. */
  market_truncated: boolean;
  /** Health of the empty-tags.jsonl tail behind empty_tag joins. */
  empty_tag_state: RouterOutcomeRead['empty_tag_state'];
  /** True when the empty-tags tail was cut; joined tags cover only the newest bytes. */
  empty_tag_truncated: boolean;
  /** Health of the merge-events.jsonl tail behind merge_queue joins. */
  merge_events_state: RouterOutcomeRead['merge_events_state'];
  /** True when the merge-events tail was cut; joined evidence covers only the newest bytes. */
  merge_events_truncated: boolean;
  /** Health of the revert-outcomes.jsonl ledger behind scan-detected revert joins. */
  revert_ledger_state: RouterOutcomeRead['revert_ledger_state'];
  /** Health of the reward-signals.jsonl tail behind the reward-signal joins. */
  reward_state: RouterOutcomeRead['reward_state'];
  /** True when the reward tail was cut; joined evidence covers only the newest bytes. */
  reward_truncated: boolean;
  /** Health of the launch-cost.jsonl tail behind the launch_cost_* joins. */
  launch_cost_state: RouterOutcomeRead['launch_cost_state'];
  /** True when the launch-cost tail was cut; joined evidence covers only the newest bytes. */
  launch_cost_truncated: boolean;
  /** Health of the cross-review.jsonl tail behind cross_review joins. */
  cross_review_state: RouterOutcomeRead['cross_review_state'];
  /** True when the cross-review tail was cut; joined verdicts cover only the newest bytes. */
  cross_review_truncated: boolean;
  /** Health of the job-cost-model.jsonl tail behind modeled_cost_usd joins. */
  job_cost_state: RouterOutcomeRead['job_cost_state'];
  /** True when the job-cost-model tail was cut; joined modeled values cover only the newest bytes. */
  job_cost_truncated: boolean;
  /** Jobs with at least one folded outcome row, after --lane filtering. */
  total: number;
  /** Rows actually returned (newest first, capped by --limit). */
  returned: number;
  limit: number;
  malformed_rows: number;
  unattached_rows: number;
  ambiguous_urls: number;
  /** Rows keyed by RQ-BATCH-* session ids — batch-session infrastructure, never outcomes. */
  session_rows: number;
  /** True when the ledger exceeded the retained tail; counts cover only the newest bytes. */
  truncated: boolean;
  outcomes: RouterOutcome[];
}

/** Wraps the core fold in the command's report shape; the page is the newest `limit` rows. */
export function buildRouterOutcomesReport(read: RouterOutcomeRead, limit: number): RouterOutcomesReport {
  const page = read.outcomes.slice(-limit).reverse();
  return {
    schema: 'router.outcomes.v1',
    state: read.state,
    path: read.path,
    eval_state: read.eval_state,
    spend_state: read.spend_state,
    spend_truncated: read.spend_truncated,
    market_state: read.market_state,
    market_truncated: read.market_truncated,
    empty_tag_state: read.empty_tag_state,
    empty_tag_truncated: read.empty_tag_truncated,
    merge_events_state: read.merge_events_state,
    merge_events_truncated: read.merge_events_truncated,
    revert_ledger_state: read.revert_ledger_state,
    reward_state: read.reward_state,
    reward_truncated: read.reward_truncated,
    launch_cost_state: read.launch_cost_state,
    launch_cost_truncated: read.launch_cost_truncated,
    cross_review_state: read.cross_review_state,
    cross_review_truncated: read.cross_review_truncated,
    job_cost_state: read.job_cost_state,
    job_cost_truncated: read.job_cost_truncated,
    total: read.outcomes.length,
    returned: page.length,
    limit,
    malformed_rows: read.malformed_rows,
    unattached_rows: read.unattached_rows,
    ambiguous_urls: read.ambiguous_urls,
    session_rows: read.session_rows,
    truncated: read.truncated,
    outcomes: page,
  };
}

const text = (value: string | number | boolean | null): string => (value === null ? 'unknown' : String(value));

function outcomeLine(o: RouterOutcome): string {
  const review = o.review_findings === null ? 'unknown'
    : `fixed:${o.review_findings.fixed},rejected:${o.review_findings.rejected},ignored:${o.review_findings.ignored}`;
  const mq = o.merge_queue;
  const mergeQueue = mq === null ? 'unknown'
    : `events:${mq.events},blocked:[${mq.blocked_reasons.join(',')}],conflicts:${mq.conflicts},` +
      `check_failures:${mq.check_failures},required_check_failures:${mq.required_check_failures},` +
      `checks_passed:${mq.checks_passed},check_observations:${mq.check_observations},` +
      `retries:${mq.retries},retry_failures:${mq.retry_failures},recuts:${mq.recuts},` +
      `auto_merge:${mq.auto_merge ?? 'unknown'}`;
  const cr = o.cross_review;
  const crossReview = cr === null ? 'unknown' : `${cr.outcome}@${cr.at ?? 'unknown'}`;
  return [
    o.job_id,
    `lane=${text(o.lane)}`, `model=${text(o.model)}`, `tier=${text(o.tier)}`, `work_class=${text(o.work_class)}`, `repo=${text(o.repo)}`,
    `lane_hint=${text(o.lane_hint)}`, `lane_override=${text(o.lane_override)}`,
    `merged=${text(o.merged)}`, `reverted=${text(o.reverted)}`, `ci_first_pass=${text(o.ci_first_pass)}`, `review=${review}`,
    `cost_usd=${text(o.cost_usd)}`, `pool_pct_used=${text(o.pool_pct_used)}`, `acus=${text(o.acus)}`, `modeled_cost_usd=${text(o.modeled_cost_usd)}`, `wall_s=${text(o.wall_s)}`, `ttm_s=${text(o.ttm_s)}`, `queue_wait_s=${text(o.queue_wait_s)}`, `ci_wall_s=${text(o.ci_wall_s)}`, `publish_wait_s=${text(o.publish_wait_s)}`, `tokens_total=${text(o.tokens_total)}`, `passk=${text(o.passk)}`,
    `empty=${text(o.empty)}`, `exit_code=${text(o.exit_code)}`, `failure_class=${text(o.failure_class)}`,
    `empty_class=${text(o.empty_class)}`, `empty_tag=${text(o.empty_tag)}`, `task_outcome=${text(o.task_outcome)}`,
    `skipped=${text(o.skipped)}`, `skip_reason=${text(o.skip_reason)}`, `skip_code=${text(o.skip_code)}`,
    `deferred=${text(o.deferred)}`, `defer_reason=${text(o.defer_reason)}`, `defer_repeat_of=${text(o.defer_repeat_of)}`,
    `noop=${text(o.noop)}`, `noop_reason=${text(o.noop_reason)}`, `noop_repeat_of=${text(o.noop_repeat_of)}`,
    `lane_hint_blocked_by=${o.lane_hint_blocked_by === null ? 'unknown' : `[${o.lane_hint_blocked_by.join(',')}]`}`,
    `market_lane=${text(o.market_lane)}`, `market_preferred=${text(o.market_preferred)}`, `market_override=${text(o.market_override)}`,
    `market_reasons=${o.market_reasons === null ? 'unknown' : `[${o.market_reasons.join(',')}]`}`,
    `market_rejected=${o.market_rejected === null ? 'unknown' : `[${o.market_rejected.map(e => e.reasons === null ? e.lane : `${e.lane}:${e.reasons.join('+')}`).join(';')}]`}`,
    `handoff_trigger=${text(o.handoff_trigger)}`, `handoff_lane=${text(o.handoff_lane)}`, `handoff_target=${text(o.handoff_target)}`,
    `provider_wall_trigger=${text(o.provider_wall_trigger)}`, `provider_wall_pattern=${text(o.provider_wall_pattern)}`, `provider_wall_lane=${text(o.provider_wall_lane)}`,
    `pool_kind=${text(o.pool_kind)}`, `pool_mem_free_pct=${text(o.pool_mem_free_pct)}`, `pool_swap_gb=${text(o.pool_swap_gb)}`,
    `node_outcome=${text(o.node_outcome)}`, `node_id=${text(o.node_id)}`, `node_pack=${text(o.node_pack)}`,
    `launch_cost_status=${text(o.launch_cost_status)}`, `launch_peak_processes=${text(o.launch_peak_processes)}`,
    `launch_mean_cpu_pct=${text(o.launch_mean_cpu_pct)}`, `launch_peak_cpu_pct=${text(o.launch_peak_cpu_pct)}`,
    `merge_queue=${mergeQueue}`, `cross_review=${crossReview}`,
  ].join(' ');
}

export function routerOutcomeLines(report: RouterOutcomesReport): string[] {
  return [
    `router outcomes state=${report.state} eval=${report.eval_state} spend=${report.spend_state} market=${report.market_state} empty_tags=${report.empty_tag_state} merge_events=${report.merge_events_state} revert_ledger=${report.revert_ledger_state} reward=${report.reward_state} launch_cost=${report.launch_cost_state} cross_review=${report.cross_review_state} job_cost=${report.job_cost_state} jobs=${report.total} shown=${report.returned} truncated=${report.truncated} malformed=${report.malformed_rows} unattached=${report.unattached_rows} ambiguous_urls=${report.ambiguous_urls} session_rows=${report.session_rows}`,
    `ledger ${report.path}`,
    ...(report.truncated ? ['coverage: retained tail only; older ledger rows were not read'] : []),
    ...(report.spend_truncated ? ['spend coverage: truncated ledger, spend-derived job costs withheld'] : []),
    ...(report.market_truncated ? ['market coverage: retained tail only; work_class joins cover the newest bytes'] : []),
    ...(report.empty_tag_truncated ? ['empty-tag coverage: retained tail only; empty_tag joins cover the newest bytes'] : []),
    ...(report.merge_events_truncated ? ['merge-event coverage: retained tail only; merge_queue joins cover the newest bytes'] : []),
    ...(report.reward_truncated ? ['reward coverage: retained tail only; reward-signal joins cover the newest bytes'] : []),
    ...(report.launch_cost_truncated ? ['launch-cost coverage: retained tail only; launch_cost joins cover the newest bytes'] : []),
    ...(report.cross_review_truncated ? ['cross-review coverage: retained tail only; cross_review joins cover the newest bytes'] : []),
    ...(report.job_cost_truncated ? ['job-cost coverage: retained tail only; modeled_cost_usd joins cover the newest bytes'] : []),
    ...report.outcomes.map(outcomeLine),
  ];
}

export async function cmdRouterOutcomes(
  args: string[],
  read: typeof readRouterOutcomes = readRouterOutcomes,
): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(ROUTER_OUTCOMES_USAGE); return 0; }
  const parsed = parseArgs(args);
  if (!parsed) { console.error(ROUTER_OUTCOMES_USAGE); return 2; }
  let result: RouterOutcomeRead;
  try {
    const opts: { runsDir?: string; lane?: string } = {};
    if (parsed.runsDir !== undefined) opts.runsDir = parsed.runsDir;
    if (parsed.lane !== undefined) opts.lane = parsed.lane;
    result = await read(opts);
  } catch { console.error('Router outcomes unavailable.'); return 1; }
  const report = buildRouterOutcomesReport(result, parsed.limit);
  console.log(parsed.json ? JSON.stringify(report) : routerOutcomeLines(report).join('\n'));
  return result.state === 'read' || result.state === 'missing' ? 0 : 1;
}
