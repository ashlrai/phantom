/**
 * router-eval.ts — RQ-SELFOPT-EVAL-HARNESS: offline router/prompt-policy eval
 * harness and regression benchmark.
 *
 * It freezes a set of past router lines with known outcomes (router-eval.v1
 * JSONL), replays any policy — a pure `(job, catalog) => decision` — against
 * them, and reports merge rate, cost per merged PR and wall time with
 * confidence intervals.
 *
 * Outcome honesty (same stance as test/helpers/router-replay.ts):
 *   - When the replayed arm equals the recorded `chosen` arm, the recorded
 *     outcome is the observation.
 *   - When it differs, the outcome is taken from the line's frozen `arms`
 *     counterfactual table when one covers the arm — synthetic benchmark
 *     ground truth — and is 'unobserved' otherwise. Unobserved decisions are
 *     never estimated, interpolated or credited; they only shrink the
 *     measured cohort and are reported as such.
 *   - A policy may only read the router-time fields (PolicyJobView): no
 *     outcome, cost or wall-time column is visible at decision time.
 *
 * Confidence intervals: Wilson score for the merge-rate proportion;
 * deterministic seeded percentile bootstrap for the ratio (per-merged-PR) and
 * wall-time means. The seed is fixed in the report so a baseline is byte-for-
 * byte reproducible; intervals describe sampling noise over the frozen set,
 * not counterfactual certainty.
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Dataset schema (router-eval.v1)
// ---------------------------------------------------------------------------

/** Terminal outcomes a dispatched job can end in. */
export type TerminalOutcome = 'merged' | 'closed' | 'failed';
/** Every recorded outcome, including non-terminal states. */
export type RouterOutcome = TerminalOutcome | 'held' | 'pending';

const TERMINAL: readonly RouterOutcome[] = ['merged', 'closed', 'failed'];
const OUTCOMES: readonly RouterOutcome[] = [...TERMINAL, 'held', 'pending'];

/** What a counterfactual arm entry records: the outcome had the job run there. */
export interface ArmOutcome {
  outcome: TerminalOutcome;
  costUsd?: number;
  tokens?: number;
  wallTimeMs?: number;
}

/** One frozen router line. Fields beyond the ones below are preserved, not
 * interpreted — real journals carry more than the harness reads. */
export interface RouterEvalJob {
  id: string;
  at?: string;
  repo?: string;
  /** Lane the queue assigned the job to (the default dispatch target). */
  pool?: string;
  tier?: string;
  priority?: string;
  task?: string;
  /** Arms the router could have picked, recorded at decision time. */
  candidates: string[];
  /** The arm actually used; null only for 'held' outcomes. */
  chosen: string | null;
  outcome: RouterOutcome;
  costUsd?: number;
  tokens?: number;
  wallTimeMs?: number;
  /** Frozen counterfactual surface: arm -> outcome had the job run there. */
  arms?: Record<string, ArmOutcome>;
}

/** Arm catalog metadata a policy legitimately knows at decision time —
 * advertised cost basis and display tier; never outcome data. */
export interface ArmMeta {
  catalogCostUsd?: number;
  tier?: string;
  label?: string;
}

export interface RouterEvalMeta {
  id?: string;
  day?: string;
  note?: string;
  arms?: Record<string, ArmMeta>;
}

export interface RouterEvalDataset {
  meta: RouterEvalMeta;
  jobs: RouterEvalJob[];
  /** sha256 of the exact source text — the baseline's integrity anchor. */
  sha256: string;
}

function fail(file: string, line: number, why: string): never {
  throw new Error(`${file}:${line}: ${why}`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function optNumber(file: string, line: number, rec: Record<string, unknown>, key: string, integer = false): number | undefined {
  const v = rec[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || (integer && !Number.isSafeInteger(v))) {
    fail(file, line, `bad ${key}`);
  }
  return v;
}

function optString(file: string, line: number, rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') fail(file, line, `bad ${key}`);
  return v;
}

function parseArmOutcomes(file: string, line: number, value: unknown, candidates: string[] | undefined): Record<string, ArmOutcome> | undefined {
  if (value === undefined) return undefined;
  const rec = asRecord(value);
  if (!rec) fail(file, line, 'arms must be an object');
  const arms: Record<string, ArmOutcome> = {};
  for (const [arm, raw] of Object.entries(rec)) {
    if (candidates && !candidates.includes(arm)) fail(file, line, `arms entry ${arm} is not a candidate`);
    const entry = asRecord(raw);
    if (!entry) fail(file, line, `arms.${arm} must be an object`);
    if (!TERMINAL.includes(entry['outcome'] as RouterOutcome)) fail(file, line, `arms.${arm} needs a terminal outcome`);
    arms[arm] = {
      outcome: entry['outcome'] as TerminalOutcome,
      costUsd: optNumber(file, line, entry, 'costUsd'),
      tokens: optNumber(file, line, entry, 'tokens', true),
      wallTimeMs: optNumber(file, line, entry, 'wallTimeMs'),
    };
  }
  return arms;
}

function parseArmCatalog(file: string, line: number, value: unknown): Record<string, ArmMeta> | undefined {
  if (value === undefined) return undefined;
  const rec = asRecord(value);
  if (!rec) fail(file, line, 'meta.arms must be an object');
  const arms: Record<string, ArmMeta> = {};
  for (const [arm, raw] of Object.entries(rec)) {
    const entry = asRecord(raw);
    if (!entry) fail(file, line, `meta.arms.${arm} must be an object`);
    arms[arm] = {
      catalogCostUsd: optNumber(file, line, entry, 'catalogCostUsd'),
      tier: optString(file, line, entry, 'tier'),
      label: optString(file, line, entry, 'label'),
    };
  }
  return arms;
}

/**
 * Parse a router-eval.v1 dataset. Malformed input throws with file:line: the
 * frozen record must be exactly what was checked in — never silently fewer
 * jobs than were written.
 */
export function parseRouterEvalDataset(text: string, file = 'jobs.jsonl'): RouterEvalDataset {
  let meta: RouterEvalMeta = {};
  let seenMeta = false;
  const jobs: RouterEvalJob[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (raw === '' || raw.startsWith('#')) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(raw);
    } catch {
      fail(file, i + 1, 'not JSON');
    }
    if (rec!.v !== 1) fail(file, i + 1, `unsupported v ${JSON.stringify(rec!.v)}`);
    if (rec!.kind === 'meta') {
      if (jobs.length > 0) fail(file, i + 1, 'meta must precede job lines');
      if (seenMeta) fail(file, i + 1, 'duplicate meta line');
      seenMeta = true;
      meta = {
        id: optString(file, i + 1, rec!, 'id'),
        day: optString(file, i + 1, rec!, 'day'),
        note: optString(file, i + 1, rec!, 'note'),
        arms: parseArmCatalog(file, i + 1, rec!.arms),
      };
      continue;
    }
    if (rec!.kind !== undefined && rec!.kind !== 'job') fail(file, i + 1, `unknown kind ${JSON.stringify(rec!.kind)}`);
    const id = rec!.id;
    if (typeof id !== 'string' || id === '') fail(file, i + 1, 'job needs an id');
    if (seen.has(id)) fail(file, i + 1, `duplicate id ${id}`);
    seen.add(id);
    let candidates: string[] | undefined;
    if (rec!.candidates !== undefined) {
      if (!Array.isArray(rec!.candidates) || rec!.candidates.length === 0
        || rec!.candidates.some((c) => typeof c !== 'string' || c === '')) {
        fail(file, i + 1, 'bad candidates');
      }
      candidates = rec!.candidates as string[];
      if (new Set(candidates).size !== candidates.length) fail(file, i + 1, 'duplicate candidate');
    }
    const chosen = rec!.chosen === undefined ? undefined : rec!.chosen;
    if (chosen !== null && typeof chosen !== 'string') fail(file, i + 1, 'bad chosen');
    const outcome = rec!.outcome;
    if (!OUTCOMES.includes(outcome as RouterOutcome)) fail(file, i + 1, `bad outcome ${JSON.stringify(outcome)}`);
    // Held means never dispatched (chosen must be null); pending means
    // dispatched but unresolved (chosen must be a real arm).
    if (outcome === 'held' && chosen !== null) fail(file, i + 1, 'held outcome requires chosen=null');
    if (outcome !== 'held' && chosen === null) fail(file, i + 1, 'dispatched outcome requires a chosen arm');
    if (typeof chosen === 'string' && candidates && !candidates.includes(chosen)) {
      fail(file, i + 1, 'chosen is not a candidate');
    }
    const arms = parseArmOutcomes(file, i + 1, rec!.arms, candidates);
    // A counterfactual entry for the arm that ran is the same realized
    // outcome; a frozen record may not disagree with itself.
    if (typeof chosen === 'string' && arms?.[chosen]) {
      const a = arms[chosen]!;
      if (a.outcome !== outcome) fail(file, i + 1, `arms.${chosen} contradicts the recorded outcome`);
      for (const key of ['costUsd', 'tokens', 'wallTimeMs'] as const) {
        if (rec![key] !== undefined && a[key] !== undefined && a[key] !== rec![key]) {
          fail(file, i + 1, `arms.${chosen}.${key} contradicts the recorded value`);
        }
      }
    }
    jobs.push({
      id,
      at: optString(file, i + 1, rec!, 'at'),
      repo: optString(file, i + 1, rec!, 'repo'),
      pool: optString(file, i + 1, rec!, 'pool'),
      tier: optString(file, i + 1, rec!, 'tier'),
      priority: optString(file, i + 1, rec!, 'priority'),
      task: optString(file, i + 1, rec!, 'task'),
      candidates: candidates ?? [],
      chosen: (chosen ?? null) as string | null,
      outcome: outcome as RouterOutcome,
      costUsd: optNumber(file, i + 1, rec!, 'costUsd'),
      tokens: optNumber(file, i + 1, rec!, 'tokens', true),
      wallTimeMs: optNumber(file, i + 1, rec!, 'wallTimeMs'),
      arms,
    });
  }
  return { meta, jobs, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

/** The router-time view a policy may decide from — outcome columns stripped. */
export interface PolicyJobView {
  id: string;
  at?: string;
  repo?: string;
  pool?: string;
  tier?: string;
  priority?: string;
  task?: string;
  candidates: string[];
}

export interface PolicyDecision {
  /** The arm to run, or null to hold. */
  arm: string | null;
  reason?: string;
}

export interface RouterPolicy {
  readonly name: string;
  decide(job: PolicyJobView, catalog: Readonly<Record<string, ArmMeta>>): PolicyDecision;
}

/** Replays the recorded choice; reproduces the logged history (the baseline).
 * `chosen` is a recorded column, not a decision-time field, so it is bound
 * here at construction — never read off the view handed to decide(). */
function loggedPolicy(jobs: readonly RouterEvalJob[]): RouterPolicy {
  const chosen = new Map(jobs.map((j) => [j.id, j.chosen]));
  return {
    name: 'logged',
    decide: (job) => ({ arm: chosen.get(job.id) ?? null, reason: 'replays the recorded arm' }),
  };
}

/** Routes every job to its queue-assigned pool, ignoring any router override. */
const STRICT_POOL: RouterPolicy = {
  name: 'strict-pool',
  decide: (job) => job.pool !== undefined && (job.candidates.length === 0 || job.candidates.includes(job.pool))
    ? { arm: job.pool, reason: 'queue-assigned pool' }
    : { arm: null, reason: 'pool is not an eligible candidate' },
};

/** Picks the cheapest advertised catalog cost among candidates; unknown is last. */
const CHEAPEST: RouterPolicy = {
  name: 'cheapest',
  decide: (job, catalog) => {
    const priced = job.candidates.map((arm, index) => ({ arm, index, cost: catalog[arm]?.catalogCostUsd ?? Infinity }));
    if (priced.length === 0) return { arm: null, reason: 'no eligible candidates' };
    priced.sort((a, b) => (a.cost - b.cost) || (a.index - b.index));
    const pick = priced[0]!;
    return { arm: pick.arm, reason: pick.cost === Infinity ? 'cheapest of unpriced candidates' : `cheapest catalog cost ${pick.cost}` };
  },
};

/** Holds everything — a negative control: all decisions change, nothing is observed. */
const HOLD_ALL: RouterPolicy = {
  name: 'hold-all',
  decide: () => ({ arm: null, reason: 'negative control' }),
};

/**
 * Builtin policies. `logged` needs the dataset (it replays recorded choices);
 * the rest are fixed. A harness caller supplies its own RouterPolicy for any
 * other router or prompt policy — the seam is the function signature.
 */
export function builtinRouterPolicy(name: string, jobs: readonly RouterEvalJob[] = []): RouterPolicy | undefined {
  switch (name) {
    case 'logged': return loggedPolicy(jobs);
    case 'strict-pool': return STRICT_POOL;
    case 'cheapest': return CHEAPEST;
    case 'hold-all': return HOLD_ALL;
    default: return undefined;
  }
}

export const BUILTIN_ROUTER_POLICIES: readonly string[] = ['logged', 'strict-pool', 'cheapest', 'hold-all'];

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** How a job's replayed outcome was resolved. */
export type DecisionResolution =
  | 'recorded'        // replayed == chosen, recorded terminal outcome
  | 'counterfactual'  // replayed != chosen, frozen arms table covered it
  | 'unobserved'      // replayed != chosen, no frozen outcome exists
  | 'rejected'        // policy picked an arm outside the recorded candidates
  | 'held'            // both record and replay agree the job never ran
  | 'pending';        // recorded outcome is unresolved

export interface DecisionRow {
  id: string;
  chosen: string | null;
  replayed: string | null;
  changed: boolean;
  resolution: DecisionResolution;
  outcome?: TerminalOutcome;
  reason?: string;
}

export interface ResolvedJob {
  decision: DecisionRow;
  /** Set on recorded/counterfactual rows. */
  outcome?: TerminalOutcome;
  costUsd?: number;
  tokens?: number;
  wallTimeMs?: number;
}

function viewOf(job: RouterEvalJob): PolicyJobView {
  const { id, at, repo, pool, tier, priority, task, candidates } = job;
  return { id, at, repo, pool, tier, priority, task, candidates };
}

function decide(policy: RouterPolicy, job: RouterEvalJob, catalog: Readonly<Record<string, ArmMeta>>): PolicyDecision {
  const d = policy.decide(viewOf(job), catalog);
  if (d === null || typeof d !== 'object' || (d.arm !== null && typeof d.arm !== 'string')) {
    throw new Error(`Policy ${policy.name} returned an invalid decision for ${job.id}`);
  }
  return { arm: d.arm ?? null, reason: d.reason };
}

function resolveOne(policy: RouterPolicy, job: RouterEvalJob, catalog: Readonly<Record<string, ArmMeta>>): ResolvedJob {
  const d = decide(policy, job, catalog);
  const row: DecisionRow = { id: job.id, chosen: job.chosen, replayed: d.arm, changed: d.arm !== job.chosen, resolution: 'unobserved', reason: d.reason };
  if (d.arm !== null && job.candidates.length > 0 && !job.candidates.includes(d.arm)) {
    row.resolution = 'rejected';
    return { decision: row };
  }
  if (!row.changed) {
    if (job.outcome === 'held') row.resolution = 'held';
    else if (job.outcome === 'pending') row.resolution = 'pending';
    else {
      row.resolution = 'recorded';
      row.outcome = job.outcome as TerminalOutcome;
      return { decision: row, outcome: row.outcome, costUsd: job.costUsd, tokens: job.tokens, wallTimeMs: job.wallTimeMs };
    }
    return { decision: row };
  }
  const cf = d.arm === null ? undefined : job.arms?.[d.arm];
  if (cf === undefined) return { decision: row };
  row.resolution = 'counterfactual';
  row.outcome = cf.outcome;
  return { decision: row, outcome: cf.outcome, costUsd: cf.costUsd, tokens: cf.tokens, wallTimeMs: cf.wallTimeMs };
}

// ---------------------------------------------------------------------------
// Metrics with confidence intervals
// ---------------------------------------------------------------------------

export interface MetricReport {
  value: number | null;
  /** 95% interval; null when the cohort cannot support one. */
  ci95: [number, number] | null;
  /** Cohort size the estimate is computed on. */
  n: number;
  /** Bootstrap resamples dropped (a ratio resample with no merges). */
  degenerate?: number;
}

/** Wilson score interval for a binomial proportion, z=1.96. */
export function wilsonInterval(successes: number, n: number, z = 1.959963984540054): [number, number] | null {
  if (n <= 0) return null;
  const p = successes / n;
  const z2 = z * z;
  const center = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** Deterministic PRNG (mulberry32); a fixed seed makes baselines reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted: readonly number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

/**
 * Percentile bootstrap over jobs (resample with replacement). `statistic`
 * returns null for a degenerate resample (e.g. a ratio with no merges);
 * those are counted and dropped. All sampling uses `seed` — never Math.random.
 */
function bootstrap<T>(items: readonly T[], statistic: (sample: T[]) => number | null, resamples: number, seed: number): { ci: [number, number] | null; degenerate: number } {
  if (items.length < 2 || resamples < 10) return { ci: null, degenerate: 0 };
  const rand = mulberry32(seed);
  const stats: number[] = [];
  let degenerate = 0;
  for (let b = 0; b < resamples; b++) {
    const sample: T[] = new Array(items.length);
    for (let i = 0; i < items.length; i++) sample[i] = items[Math.floor(rand() * items.length)]!;
    const s = statistic(sample);
    if (s === null || !Number.isFinite(s)) degenerate++;
    else stats.push(s);
  }
  if (stats.length < resamples * 0.5) return { ci: null, degenerate };
  stats.sort((a, b) => a - b);
  return { ci: [percentile(stats, 2.5), percentile(stats, 97.5)], degenerate };
}

const DEFAULT_BOOTSTRAP_SEED = 0x5e1f07;
const DEFAULT_RESAMPLES = 2000;

export interface EvalOptions {
  /** Include the per-job decision table in the report. */
  includeDecisions?: boolean;
  resamples?: number;
  seed?: number;
}

export interface ArmReport {
  arm: string;
  decided: number;
  observed: number;
  merged: number;
  resolved: number;
  mergeRate: number | null;
  costUsd: number;
  tokens: number;
  wallTimeMsMean: number | null;
}

export interface RouterEvalReport {
  schemaVersion: 1;
  dataset: { id?: string; day?: string; jobs: number; sha256: string };
  policy: string;
  coverage: {
    jobs: number;
    changed: number;
    rejected: number;
    observed: number;
    unobserved: number;
    held: number;
    pending: number;
    resolved: number;
  };
  mergeRate: MetricReport;
  costPerMergedPrUsd: MetricReport;
  tokensPerMergedPr: MetricReport;
  wallTimeMsMean: MetricReport;
  perArm: ArmReport[];
  bootstrap: { seed: number; resamples: number };
  decisions?: DecisionRow[];
}

function ratioMetric(jobs: readonly ResolvedJob[], pick: (j: ResolvedJob) => number | undefined, resamples: number, seed: number): MetricReport {
  const cohort = jobs.filter((j) => j.outcome !== undefined && pick(j) !== undefined);
  const merged = cohort.filter((j) => j.outcome === 'merged').length;
  const value = merged === 0 ? null : cohort.reduce((s, j) => s + pick(j)!, 0) / merged;
  const { ci, degenerate } = bootstrap(cohort, (sample) => {
    const m = sample.filter((j) => j.outcome === 'merged').length;
    return m === 0 ? null : sample.reduce((s, j) => s + pick(j)!, 0) / m;
  }, resamples, seed);
  return { value, ci95: ci, n: cohort.length, ...(degenerate ? { degenerate } : {}) };
}

function meanMetric(jobs: readonly ResolvedJob[], pick: (j: ResolvedJob) => number | undefined, resamples: number, seed: number): MetricReport {
  const cohort = jobs.filter((j) => j.outcome !== undefined && pick(j) !== undefined);
  const value = cohort.length === 0 ? null : cohort.reduce((s, j) => s + pick(j)!, 0) / cohort.length;
  const { ci, degenerate } = bootstrap(cohort, (sample) => sample.reduce((s, j) => s + pick(j)!, 0) / sample.length, resamples, seed);
  return { value, ci95: ci, n: cohort.length, ...(degenerate ? { degenerate } : {}) };
}

/** Replay a policy over the frozen set and compute the benchmark report. */
export function evaluateRouterPolicy(dataset: RouterEvalDataset, policy: RouterPolicy, opts: EvalOptions = {}): RouterEvalReport {
  const resamples = Math.floor(opts.resamples ?? DEFAULT_RESAMPLES);
  const seed = (opts.seed ?? DEFAULT_BOOTSTRAP_SEED) >>> 0;
  const catalog = dataset.meta.arms ?? {};
  const resolved = dataset.jobs.map((job) => resolveOne(policy, job, catalog));
  const terminal = resolved.filter((r) => r.outcome !== undefined);
  const merged = terminal.filter((r) => r.outcome === 'merged').length;

  const perArm = new Map<string, ResolvedJob[]>();
  for (const r of resolved) {
    const arm = r.decision.replayed;
    if (arm === null) continue;
    const group = perArm.get(arm) ?? [];
    group.push(r);
    perArm.set(arm, group);
  }
  const arms: ArmReport[] = [...perArm.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([arm, group]) => {
    const term = group.filter((r) => r.outcome !== undefined);
    const m = term.filter((r) => r.outcome === 'merged').length;
    const walls = term.flatMap((r) => r.wallTimeMs === undefined ? [] : [r.wallTimeMs]);
    return {
      arm,
      decided: group.length,
      observed: term.length,
      merged: m,
      resolved: term.length,
      mergeRate: term.length === 0 ? null : m / term.length,
      costUsd: term.reduce((s, r) => s + (r.costUsd ?? 0), 0),
      tokens: term.reduce((s, r) => s + (r.tokens ?? 0), 0),
      wallTimeMsMean: walls.length === 0 ? null : walls.reduce((a, b) => a + b, 0) / walls.length,
    };
  });

  const count = (r: DecisionResolution) => resolved.filter((x) => x.decision.resolution === r).length;
  const report: RouterEvalReport = {
    schemaVersion: 1,
    dataset: {
      ...(dataset.meta.id !== undefined ? { id: dataset.meta.id } : {}),
      ...(dataset.meta.day !== undefined ? { day: dataset.meta.day } : {}),
      jobs: dataset.jobs.length,
      sha256: dataset.sha256,
    },
    policy: policy.name,
    coverage: {
      jobs: resolved.length,
      changed: resolved.filter((r) => r.decision.changed).length,
      rejected: count('rejected'),
      observed: count('recorded') + count('counterfactual'),
      unobserved: count('unobserved'),
      held: count('held'),
      pending: count('pending'),
      resolved: terminal.length,
    },
    mergeRate: {
      value: terminal.length === 0 ? null : merged / terminal.length,
      ci95: wilsonInterval(merged, terminal.length),
      n: terminal.length,
    },
    costPerMergedPrUsd: ratioMetric(resolved, (j) => j.costUsd, resamples, seed),
    tokensPerMergedPr: ratioMetric(resolved, (j) => j.tokens, resamples, seed + 1),
    wallTimeMsMean: meanMetric(resolved, (j) => j.wallTimeMs, resamples, seed + 2),
    perArm: arms,
    bootstrap: { seed, resamples },
    ...(opts.includeDecisions ? { decisions: resolved.map((r) => r.decision) } : {}),
  };
  return report;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const usd = (n: number) => `$${n.toFixed(2)}`;
const tok = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));
const minutes = (ms: number) => `${Math.round(ms / 60_000)}m`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function metricText(m: MetricReport, fmt: (n: number) => string): string {
  if (m.value === null) return 'unknown';
  const ci = m.ci95 ? ` [${fmt(m.ci95[0])} – ${fmt(m.ci95[1])}]` : ' [no CI]';
  return `${fmt(m.value)}${ci} (n=${m.n}${m.degenerate ? `, ${m.degenerate} degenerate` : ''})`;
}

/** Compact markdown report — the committed baseline's human-readable form. */
export function formatRouterEvalMarkdown(report: RouterEvalReport): string {
  const c = report.coverage;
  const lines: string[] = [
    '# Router eval report',
    '',
    `- Dataset: ${report.dataset.id ?? 'unnamed'}${report.dataset.day ? ` (${report.dataset.day})` : ''} — ${report.dataset.jobs} frozen router lines, sha256 \`${report.dataset.sha256.slice(0, 12)}\``,
    `- Policy: \`${report.policy}\` — bootstrap ${report.bootstrap.resamples} resamples, seed ${report.bootstrap.seed}`,
    '',
    '## Headline (95% CI)',
    '',
    `| Metric | Value |`,
    `| --- | --- |`,
    `| Merge rate | ${metricText(report.mergeRate, pct)} |`,
    `| Cost per merged PR | ${metricText(report.costPerMergedPrUsd, usd)} |`,
    `| Tokens per merged PR | ${metricText(report.tokensPerMergedPr, tok)} |`,
    `| Wall time (mean) | ${metricText(report.wallTimeMsMean, minutes)} |`,
    '',
    '## Coverage',
    '',
    `resolved=${c.resolved} observed=${c.observed} unobserved=${c.unobserved} held=${c.held} pending=${c.pending} changed=${c.changed} rejected=${c.rejected} of ${c.jobs} jobs.`,
    '',
    '## Per-arm',
    '',
    '| Arm | Decided | Observed | Merged | Resolved | Merge rate | Cost USD | Tokens | Mean wall |',
    '| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |',
  ];
  for (const a of report.perArm) {
    lines.push(`| ${a.arm.replace(/[|\\\r\n]/g, ' ')} | ${a.decided} | ${a.observed} | ${a.merged} | ${a.resolved} | ${a.mergeRate === null ? 'unknown' : pct(a.mergeRate)} | ${usd(a.costUsd)} | ${tok(a.tokens)} | ${a.wallTimeMsMean === null ? 'unknown' : minutes(a.wallTimeMsMean)} |`);
  }
  lines.push(
    '',
    'Merge-rate intervals are Wilson score intervals; cost/token-per-merge and wall-time intervals are seeded percentile bootstrap. Changed decisions without a frozen counterfactual are unobserved — never estimated. Intervals describe sampling noise over the frozen set, not counterfactual certainty.',
    '',
  );
  return lines.join('\n');
}
