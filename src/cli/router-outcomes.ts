/**
 * `ashlr router outcomes` — read-only per-job outcome records folded from the
 * host metrics ledgers (metrics/jobs.jsonl joined with metrics/api-spend.jsonl
 * for cost_usd, metrics/work-market.jsonl for work_class and
 * metrics/empty-tags.jsonl for empty_tag) by src/core/router/outcomes.ts:
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
 * empty tag
 * (empty_tag, joined from metrics/empty-tags.jsonl) and the advisory
 * pass^k join from eval.lane-scores.v1.
 * RQ-BATCH-* session rows are infrastructure evidence counted in
 * session_rows, never outcomes. Never writes; a missing ledger reports
 * `missing`, an unreadable or non-file one exits 1. Each read retains the
 * newest bounded tail of its ledger, so an oversized ledger reports
 * `truncated: true` (jobs), `spend_truncated: true` (spend),
 * `market_truncated: true` (market) or `empty_tag_truncated: true`
 * (empty tags) — coverage of the retained window, not a refusal.
 */
import { isAbsolute } from 'node:path';

import {
  readRouterOutcomes,
  type RouterOutcome,
  type RouterOutcomeRead,
} from '../core/router/outcomes.js';

export const ROUTER_OUTCOMES_USAGE =
  'Usage: ashlr router outcomes [--json] [--runs-dir <dir>] [--lane <lane>] [--limit <1..1000>]\n' +
  'Reads the newest bounded tail of <runs-dir>/metrics/jobs.jsonl (default ASHLR_RUNS_DIR, then ~/.ashlr-runs) joined with metrics/api-spend.jsonl for cost_usd; one router.outcome.v1 row per job in the retained window, newest first, truncated=true when older rows were not read. passk is advisory eval evidence, null when unknown. Exit 0 report (a missing ledger reports state=missing, not an error), 1 unreadable/non-file ledger, 2 usage.';

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
  /** True when the spend tail was cut; joined per-job costs are lower bounds. */
  spend_truncated: boolean;
  /** Health of the work-market.jsonl tail behind work_class joins. */
  market_state: RouterOutcomeRead['market_state'];
  /** True when the market tail was cut; joined classes cover only the newest bytes. */
  market_truncated: boolean;
  /** Health of the empty-tags.jsonl tail behind empty_tag joins. */
  empty_tag_state: RouterOutcomeRead['empty_tag_state'];
  /** True when the empty-tags tail was cut; joined tags cover only the newest bytes. */
  empty_tag_truncated: boolean;
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
  return [
    o.job_id,
    `lane=${text(o.lane)}`, `model=${text(o.model)}`, `tier=${text(o.tier)}`, `work_class=${text(o.work_class)}`,
    `lane_hint=${text(o.lane_hint)}`, `lane_override=${text(o.lane_override)}`,
    `merged=${text(o.merged)}`, `reverted=${text(o.reverted)}`, `ci_first_pass=${text(o.ci_first_pass)}`, `review=${review}`,
    `cost_usd=${text(o.cost_usd)}`, `acus=${text(o.acus)}`, `wall_s=${text(o.wall_s)}`, `ttm_s=${text(o.ttm_s)}`, `queue_wait_s=${text(o.queue_wait_s)}`, `ci_wall_s=${text(o.ci_wall_s)}`, `publish_wait_s=${text(o.publish_wait_s)}`, `tokens_total=${text(o.tokens_total)}`, `passk=${text(o.passk)}`,
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
  ].join(' ');
}

export function routerOutcomeLines(report: RouterOutcomesReport): string[] {
  return [
    `router outcomes state=${report.state} eval=${report.eval_state} spend=${report.spend_state} market=${report.market_state} empty_tags=${report.empty_tag_state} jobs=${report.total} shown=${report.returned} truncated=${report.truncated} malformed=${report.malformed_rows} unattached=${report.unattached_rows} ambiguous_urls=${report.ambiguous_urls} session_rows=${report.session_rows}`,
    `ledger ${report.path}`,
    ...(report.truncated ? ['coverage: retained tail only; older ledger rows were not read'] : []),
    ...(report.spend_truncated ? ['spend coverage: retained tail only; per-job costs are lower bounds'] : []),
    ...(report.market_truncated ? ['market coverage: retained tail only; work_class joins cover the newest bytes'] : []),
    ...(report.empty_tag_truncated ? ['empty-tag coverage: retained tail only; empty_tag joins cover the newest bytes'] : []),
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
