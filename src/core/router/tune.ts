import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  readLedgerFile,
  readRouterOutcomes,
  type LedgerReadState,
  type RouterOutcome,
} from './outcomes.js';

// Outcome-driven router weight proposals (ENDSTATE D5 first step). Folds the
// recorded router.outcome.v1 jobs ledger, enriched by work-market.v1
// route_decision rows (work_class, chosen_lane), into per-(work_class, lane)
// cohorts and emits bounded router.weights.v1 proposals relative to the
// work-class pool merge rate. Everything is advisory: --apply only appends
// proposal rows to metrics/router-weights.jsonl; nothing reads that journal
// for routing, and unknown evidence stays null, never 0.

export const ROUTER_TUNE_REPORT_SCHEMA = 'router.tune.report.v1';
export const ROUTER_WEIGHTS_SCHEMA = 'router.weights.v1';
export const ROUTER_WEIGHTS_LEDGER_LIMIT = 4 * 1024 * 1024;
export const ROUTER_WEIGHTS_RELATIVE = join('metrics', 'router-weights.jsonl');
export const ROUTER_TUNE_DEFAULT_MIN_SAMPLE = 5;
export const ROUTER_TUNE_DEFAULT_MAX_SHIFT = 0.1;

export interface RouterWeightProposal {
  schema: typeof ROUTER_WEIGHTS_SCHEMA;
  work_class: string | null;
  lane: string;
  /** Bounded multiplier vs the work-class pool merge rate; 1.0 means at pool rate. */
  weight: number;
  /** Resolved outcomes (merged known true or false) behind the proposal. */
  evidence_n: number;
  updated_at: string;
}

export type RouterTuneStatus =
  | 'proposed'
  | 'insufficient-evidence'
  | 'zero-pool-merge-rate';

export interface RouterTuneCohort {
  work_class: string | null;
  lane: string;
  attempts: number;
  /** Outcomes whose merge state is recorded (the evidence basis). */
  resolved: number;
  merged: number;
  pending: number;
  merge_rate: number | null;
  pool_resolved: number;
  pool_merge_rate: number | null;
  ci_first_pass_rate: number | null;
  /** Mean recorded cost over merged outcomes with a known cost; null when none. */
  cost_per_merged_usd: number | null;
  mean_wall_s: number | null;
  weight: number | null;
  status: RouterTuneStatus;
}

export interface RouterTuneApplied {
  path: string;
  appended: number;
  deduplicated: number;
  /** Ledger state observed before appending; 'read' enables dedupe. */
  prior_state: LedgerReadState;
}

export interface RouterTuneReport {
  schema: typeof ROUTER_TUNE_REPORT_SCHEMA;
  advisory: true;
  generated_at: string;
  runs_dir: string;
  parameters: { min_sample: number; max_shift: number };
  inputs: {
    outcomes: {
      state: LedgerReadState;
      path: string;
      outcomes: number;
      malformed_rows: number;
      unattached_rows: number;
      ambiguous_urls: number;
    };
    work_market: {
      state: LedgerReadState;
      path: string;
      route_decision_rows: number;
    };
  };
  /** Outcomes dropped because no lane could be attributed after enrichment. */
  unattributed_outcomes: number;
  cohorts: RouterTuneCohort[];
  weights: RouterWeightProposal[];
  applied: RouterTuneApplied | null;
}

export interface RouterTuneOptions {
  runsDir?: string;
  minSample?: number;
  maxShift?: number;
  /** Append deduplicated router.weights.v1 rows to metrics/router-weights.jsonl. */
  apply?: boolean;
  now?: Date;
}

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

interface RouteDecision {
  work_class: string | null;
  chosen_lane: string | null;
}

/** Latest work-market.v1 route_decision per job; later rows win per field. */
function foldRouteDecisions(text: string): { decisions: Map<string, RouteDecision>; rows: number } {
  const decisions = new Map<string, RouteDecision>();
  let rows = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (row['schema'] !== 'work-market.v1' || row['event'] !== 'route_decision') continue;
    const job = str(row['job']);
    if (!job) continue;
    rows++;
    const prior = decisions.get(job) ?? { work_class: null, chosen_lane: null };
    decisions.set(job, {
      work_class: str(row['work_class']) ?? prior.work_class,
      chosen_lane: str(row['chosen_lane']) ?? prior.chosen_lane,
    });
  }
  return { decisions, rows };
}

interface CohortAcc {
  work_class: string | null;
  lane: string;
  attempts: number;
  resolved: number;
  merged: number;
  ciKnown: number;
  ciTrue: number;
  mergedCostSum: number;
  mergedCostN: number;
  wallSum: number;
  wallN: number;
}

const cohortKey = (workClass: string | null, lane: string): string =>
  JSON.stringify([workClass, lane]);

const dedupeKey = (workClass: string | null, lane: string, weight: number, evidenceN: number): string =>
  JSON.stringify([workClass, lane, weight, evidenceN]);

function accumulate(acc: Map<string, CohortAcc>, workClass: string | null, lane: string, o: RouterOutcome): void {
  const key = cohortKey(workClass, lane);
  const c = acc.get(key) ?? {
    work_class: workClass, lane, attempts: 0, resolved: 0, merged: 0,
    ciKnown: 0, ciTrue: 0, mergedCostSum: 0, mergedCostN: 0, wallSum: 0, wallN: 0,
  };
  c.attempts++;
  if (o.merged !== null) {
    c.resolved++;
    if (o.merged) {
      c.merged++;
      if (o.cost_usd !== null) { c.mergedCostSum += o.cost_usd; c.mergedCostN++; }
    }
  }
  if (o.ci_first_pass !== null) { c.ciKnown++; if (o.ci_first_pass) c.ciTrue++; }
  if (o.wall_s !== null) { c.wallSum += o.wall_s; c.wallN++; }
  acc.set(key, c);
}

async function readWorkMarket(runsDir: string): Promise<{
  state: LedgerReadState; path: string; decisions: Map<string, RouteDecision>; rows: number;
}> {
  const path = join(runsDir, 'metrics', 'work-market.jsonl');
  const read = await readLedgerFile(path);
  if (read.state !== 'read') return { state: read.state, path, decisions: new Map(), rows: 0 };
  const { decisions, rows } = foldRouteDecisions(read.text);
  return { state: 'read', path, decisions, rows };
}

/** Dedupe keys already present in the weights journal; unreadable ledger dedupes nothing. */
async function recordedWeightKeys(runsDir: string): Promise<{ keys: Set<string>; state: LedgerReadState }> {
  const path = join(runsDir, ROUTER_WEIGHTS_RELATIVE);
  const read = await readLedgerFile(path, ROUTER_WEIGHTS_LEDGER_LIMIT);
  const keys = new Set<string>();
  if (read.state !== 'read') return { keys, state: read.state };
  for (const line of read.text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      const row = value as Record<string, unknown>;
      if (row['schema'] !== ROUTER_WEIGHTS_SCHEMA) continue;
      const wc = str(row['work_class']);
      const lane = str(row['lane']);
      const weight = typeof row['weight'] === 'number' && Number.isFinite(row['weight']) ? row['weight'] : null;
      const n = typeof row['evidence_n'] === 'number' && Number.isSafeInteger(row['evidence_n']) ? row['evidence_n'] : null;
      if (lane !== null && weight !== null && n !== null) keys.add(dedupeKey(wc, lane, weight, n));
    } catch { /* Partial journal rows are not dedupe evidence. */ }
  }
  return { keys, state: 'read' };
}

/**
 * Folds recorded outcomes into bounded weight proposals. Read-only unless
 * `apply` is set, which appends deduplicated router.weights.v1 rows to
 * <runsDir>/metrics/router-weights.jsonl (mode 0600). Proposals are advisory:
 * no router, bandit, queue or spend path consumes the journal.
 */
export async function tuneRouterWeights(opts: RouterTuneOptions = {}): Promise<RouterTuneReport> {
  const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  if (!isAbsolute(runsDir)) throw new RangeError('runsDir must be an absolute path');
  const minSample = opts.minSample ?? ROUTER_TUNE_DEFAULT_MIN_SAMPLE;
  const maxShift = opts.maxShift ?? ROUTER_TUNE_DEFAULT_MAX_SHIFT;
  if (!Number.isSafeInteger(minSample) || minSample < 1) throw new RangeError('minSample must be a positive integer');
  if (!Number.isFinite(maxShift) || maxShift <= 0 || maxShift > 1) throw new RangeError('maxShift must be in (0, 1]');
  const now = opts.now ?? new Date();
  const generatedAt = now.toISOString();

  const [outcomeRead, market] = await Promise.all([
    readRouterOutcomes({ runsDir }),
    readWorkMarket(runsDir),
  ]);

  const cohorts = new Map<string, CohortAcc>();
  let unattributed = 0;
  for (const o of outcomeRead.outcomes) {
    const decision = market.decisions.get(o.job_id);
    const workClass = o.work_class ?? decision?.work_class ?? null;
    const lane = o.lane ?? decision?.chosen_lane ?? null;
    if (lane === null) { unattributed++; continue; }
    accumulate(cohorts, workClass, lane, o);
  }

  // Pool merge rate per work_class (null work_class pools as 'unclassified').
  const pools = new Map<string, { resolved: number; merged: number }>();
  for (const c of cohorts.values()) {
    const key = c.work_class ?? '';
    const p = pools.get(key) ?? { resolved: 0, merged: 0 };
    p.resolved += c.resolved;
    p.merged += c.merged;
    pools.set(key, p);
  }

  const rows: RouterTuneCohort[] = [...cohorts.values()].map((c) => {
    const pool = pools.get(c.work_class ?? '') ?? { resolved: 0, merged: 0 };
    const poolRate = pool.resolved > 0 ? r6(pool.merged / pool.resolved) : null;
    const mergeRate = c.resolved > 0 ? r6(c.merged / c.resolved) : null;
    let weight: number | null = null;
    let status: RouterTuneStatus;
    // The pool contains this cohort, so pool.resolved >= c.resolved >= minSample here.
    if (c.resolved < minSample) status = 'insufficient-evidence';
    else if (poolRate === null || poolRate === 0) status = 'zero-pool-merge-rate';
    else {
      const raw = (c.merged / c.resolved) / (pool.merged / pool.resolved);
      weight = r6(Math.min(1 + maxShift, Math.max(1 - maxShift, raw)));
      status = 'proposed';
    }
    return {
      work_class: c.work_class,
      lane: c.lane,
      attempts: c.attempts,
      resolved: c.resolved,
      merged: c.merged,
      pending: c.attempts - c.resolved,
      merge_rate: mergeRate,
      pool_resolved: pool.resolved,
      pool_merge_rate: poolRate,
      ci_first_pass_rate: c.ciKnown > 0 ? r6(c.ciTrue / c.ciKnown) : null,
      cost_per_merged_usd: c.mergedCostN > 0 ? r6(c.mergedCostSum / c.mergedCostN) : null,
      mean_wall_s: c.wallN > 0 ? r6(c.wallSum / c.wallN) : null,
      weight,
      status,
    };
  });
  rows.sort((a, b) =>
    (a.work_class ?? '') === (b.work_class ?? '')
      ? a.lane.localeCompare(b.lane)
      : (a.work_class ?? '') < (b.work_class ?? '') ? -1 : 1);

  const weights: RouterWeightProposal[] = rows.flatMap((c) =>
    c.weight === null ? [] : [{
      schema: ROUTER_WEIGHTS_SCHEMA,
      work_class: c.work_class,
      lane: c.lane,
      weight: c.weight,
      evidence_n: c.resolved,
      updated_at: generatedAt,
    }]);

  let applied: RouterTuneApplied | null = null;
  if (opts.apply === true && weights.length > 0) {
    const metricsDir = join(runsDir, 'metrics');
    await mkdir(metricsDir, { recursive: true, mode: 0o700 });
    const prior = await recordedWeightKeys(runsDir);
    const fresh = weights.filter((w) =>
      !prior.keys.has(dedupeKey(w.work_class, w.lane, w.weight, w.evidence_n)));
    if (fresh.length > 0) {
      const path = join(runsDir, ROUTER_WEIGHTS_RELATIVE);
      await appendFile(path, fresh.map((w) => `${JSON.stringify(w)}\n`).join(''), { mode: 0o600 });
      applied = { path, appended: fresh.length, deduplicated: weights.length - fresh.length, prior_state: prior.state };
    } else {
      applied = { path: join(runsDir, ROUTER_WEIGHTS_RELATIVE), appended: 0, deduplicated: weights.length, prior_state: prior.state };
    }
  }

  return {
    schema: ROUTER_TUNE_REPORT_SCHEMA,
    advisory: true,
    generated_at: generatedAt,
    runs_dir: runsDir,
    parameters: { min_sample: minSample, max_shift: maxShift },
    inputs: {
      outcomes: {
        state: outcomeRead.state,
        path: outcomeRead.path,
        outcomes: outcomeRead.outcomes.length,
        malformed_rows: outcomeRead.malformed_rows,
        unattached_rows: outcomeRead.unattached_rows,
        ambiguous_urls: outcomeRead.ambiguous_urls,
      },
      work_market: {
        state: market.state,
        path: market.path,
        route_decision_rows: market.rows,
      },
    },
    unattributed_outcomes: unattributed,
    cohorts: rows,
    weights,
    applied,
  };
}
