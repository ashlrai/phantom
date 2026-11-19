/**
 * `ashlr router outcomes` — read-only per-job outcome records folded from the
 * host metrics ledger (metrics/jobs.jsonl) by src/core/router/outcomes.ts:
 * merge state, CI first pass, review findings, cost, wall time and the
 * advisory pass^k join from eval.lane-scores.v1. Never writes; a missing
 * ledger reports `missing`, an unreadable or non-file one exits 1. The read
 * retains the newest bounded tail of the ledger, so an oversized ledger
 * reports `truncated: true` — coverage of the retained window, not a refusal.
 */
import { isAbsolute } from 'node:path';

import {
  readRouterOutcomes,
  type RouterOutcome,
  type RouterOutcomeRead,
} from '../core/router/outcomes.js';

export const ROUTER_OUTCOMES_USAGE =
  'Usage: ashlr router outcomes [--json] [--runs-dir <dir>] [--lane <lane>] [--limit <1..1000>]\n' +
  'Reads the newest bounded tail of <runs-dir>/metrics/jobs.jsonl (default ASHLR_RUNS_DIR, then ~/.ashlr-runs); one router.outcome.v1 row per job in the retained window, newest first, truncated=true when older rows were not read. passk is advisory eval evidence, null when unknown. Exit 0 report (a missing ledger reports state=missing, not an error), 1 unreadable/non-file ledger, 2 usage.';

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
  /** Jobs with at least one folded outcome row, after --lane filtering. */
  total: number;
  /** Rows actually returned (newest first, capped by --limit). */
  returned: number;
  limit: number;
  malformed_rows: number;
  unattached_rows: number;
  ambiguous_urls: number;
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
    total: read.outcomes.length,
    returned: page.length,
    limit,
    malformed_rows: read.malformed_rows,
    unattached_rows: read.unattached_rows,
    ambiguous_urls: read.ambiguous_urls,
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
    `merged=${text(o.merged)}`, `ci_first_pass=${text(o.ci_first_pass)}`, `review=${review}`,
    `cost_usd=${text(o.cost_usd)}`, `wall_s=${text(o.wall_s)}`, `passk=${text(o.passk)}`,
  ].join(' ');
}

export function routerOutcomeLines(report: RouterOutcomesReport): string[] {
  return [
    `router outcomes state=${report.state} eval=${report.eval_state} jobs=${report.total} shown=${report.returned} truncated=${report.truncated} malformed=${report.malformed_rows} unattached=${report.unattached_rows} ambiguous_urls=${report.ambiguous_urls}`,
    `ledger ${report.path}`,
    ...(report.truncated ? ['coverage: retained tail only; older ledger rows were not read'] : []),
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
