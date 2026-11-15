/** Offline attempt-cohort metrics. No clock, filesystem, pricing or routing side effects. */
export interface OutcomeGroup {
  name: string;
  model: string | null;
  tier: string | null;
  jobs: number;
  finished: number;
  finishRate: number | null;
  prRate: number | null;
  emptyRate: number | null;
  medianDuration: number | null;
  estCost: number | null;
  samples: { pr: number; published: number; empty: number; duration: number; cost: number };
  evidenceRefs: string[];
}
export interface RepoOutcome {
  repo: string;
  merged: number;
  mergesPerDay: number;
  revertRate: number | null;
  revertSamples: number;
  reverted: number;
  timeToMerge: { p50: number | null; p90: number | null; p95: number | null; samples: number };
  evidenceRefs: string[];
}
export interface OutcomeMetrics {
  schema: 'fleet.outcome-metrics.v1';
  sourceState: 'healthy' | 'missing' | 'degraded';
  since: string;
  until: string;
  hours: number;
  ignoredRows: number;
  unknownMergeTimes: number;
  totals: OutcomeGroup | null;
  byLane: OutcomeGroup[];
  byModelTier: OutcomeGroup[];
  byRepo: RepoOutcome[];
}
export interface OutcomeMetricsInput {
  events: readonly unknown[] | null;
  nowMs: number;
  hours?: number;
  sourceState?: 'healthy' | 'degraded';
}
type Row = Record<string, unknown>;
type Event = { row: Row; kind: string; at: number; ref: string; job: string | null; url: string | null };
type Attempt = { launch: Event; finishes: Event[]; prs: Event[] };
const DAY = 86_400_000;
const label = (value: unknown): string | null => typeof value === 'string' && /^[\w][\w.:@/-]{0,159}$/.test(value) ? value : null;
const time = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(n) ? n : null;
};
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const url = (value: unknown): string | null => typeof value === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\/?$/i.test(value) ? value.replace(/\/$/, '').toLowerCase() : null;
const rate = (yes: number, total: number): number | null => total ? yes / total : null;
/** Linear interpolation on sorted samples; null means no measurement. Units stay unchanged. */
export function outcomePercentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), index = (sorted.length - 1) * p;
  const lo = Math.floor(index), hi = Math.ceil(index);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (index - lo);
}
function group(name: string, attempts: Attempt[], model: string | null = null, tier: string | null = null): OutcomeGroup {
  const durations: number[] = [], costs: number[] = [];
  let finished = 0, pr = 0, published = 0, empty = 0, empties = 0;
  for (const a of attempts) {
    // Conflicting repeated finish boundaries cannot supply measurements.
    const f = a.finishes.length === 1 ? a.finishes[0] : undefined;
    if (a.finishes.length) finished++;
    if (a.prs.length || f?.row.hasPr === true) { pr++; published++; }
    else if (f?.row.empty === true || f?.row.hasPr === false) pr++;
    if (typeof f?.row.empty === 'boolean') { empty++; if (f.row.empty) empties++; }
    if (f) {
      durations.push(number(f.row.wall_s) ?? (f.at - a.launch.at) / 1000);
      const cost = number(f.row.estCost) ?? number(f.row.cost_usd) ?? number(f.row.cost);
      if (cost !== null) costs.push(cost);
    }
  }
  return { name, model, tier, jobs: attempts.length, finished, finishRate: rate(finished, attempts.length),
    prRate: rate(published, pr), emptyRate: rate(empties, empty), medianDuration: outcomePercentile(durations, 0.5),
    estCost: costs.length === attempts.length && costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null,
    samples: { pr, published, empty, duration: durations.length, cost: costs.length },
    evidenceRefs: [...new Set(attempts.flatMap(a => [a.launch.ref, ...a.finishes.map(f => f.ref), ...a.prs.map(p => p.ref)]))] };
}

export function buildOutcomeMetrics(input: OutcomeMetricsInput): OutcomeMetrics {
  const hours = input.hours ?? 24, until = input.nowMs, since = until - hours * 3_600_000;
  if (!Number.isFinite(until) || Math.abs(until) > 8.63e15 || !Number.isFinite(hours) || hours < 1 || hours > 2160) throw new RangeError('Invalid metrics window');
  const events: Event[] = [];
  let ignoredRows = 0;
  for (const [i, value] of (input.events ?? []).entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { ignoredRows++; continue; }
    const row = value as Row;
    const kind = label(row.event) ?? (row.source === 'metrics-outcomes-reconciler' ? 'outcome' : null);
    if (!kind || !['launch', 'finish', 'publish', 'published', 'outcome', 'merged', 'revert', 'revert_coverage'].includes(kind)) continue;
    const at = time(row.ts ?? row.timestamp ?? row.at);
    const job = label(row.job ?? row.jobId ?? row.job_id);
    const prUrl = url(row.url ?? row.prUrl ?? row.pr_url ?? row.pr);
    if (at === null || (['launch', 'finish'].includes(kind) && !job)) { ignoredRows++; continue; }
    if (at <= until) events.push({ row, kind, at, ref: `events:${i}`, job, url: prUrl });
  }
  events.sort((a, b) => a.at - b.at || (Number(b.kind === 'launch') - Number(a.kind === 'launch')));
  const attempts: Attempt[] = [], current = new Map<string, Attempt>(), seen = new Set<string>();
  for (const e of events) {
    if (!e.job) continue;
    // Exact duplicate rows are idempotent, including launch and finish retries.
    const key = JSON.stringify([e.job, e.kind, e.at, Object.entries(e.row).sort(([a], [b]) => a.localeCompare(b))]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (e.kind === 'launch') {
      const prior = current.get(e.job);
      if (prior?.launch.at === e.at) {
        // One timestamp cannot prove two attempts. Conflicting route metadata is unknown.
        if (['lane', 'model', 'tier', 'repo'].some(k => label(prior.launch.row[k]) !== label(e.row[k]))) {
          ignoredRows++;
          prior.launch = { ...prior.launch, row: { ...prior.launch.row, lane: null, model: null, tier: null } };
        }
        continue;
      }
      const a: Attempt = { launch: e, finishes: [], prs: [] };
      attempts.push(a); current.set(e.job, a);
    } else {
      const a = current.get(e.job);
      if (!a) continue;
      if (e.kind === 'finish') a.finishes.push(e);
      if (e.url && ['publish', 'published'].includes(e.kind)) a.prs.push(e);
    }
  }
  const cohort = attempts.filter(a => a.launch.at >= since);
  const grouped = (key: (a: Attempt) => string) => {
    const groups = new Map<string, Attempt[]>();
    for (const a of cohort) { const k = key(a), list = groups.get(k) ?? []; list.push(a); groups.set(k, list); }
    return [...groups].sort(([a], [b]) => a.localeCompare(b));
  };
  const byLane = grouped(a => label(a.launch.row.lane) ?? 'unknown').map(([k, a]) => group(k, a));
  const byModelTier = grouped(a => JSON.stringify([label(a.launch.row.model), label(a.launch.row.tier)]))
    .map(([k, a]) => { const [model, tier] = JSON.parse(k) as [string | null, string | null]; return group(k, a, model, tier); });
  // PRs have their own merge-time cohort, independent of launch time or lane attribution.
  const prs = new Map<string, Event[]>();
  for (const e of events) if (e.url) { const list = prs.get(e.url) ?? []; list.push(e); prs.set(e.url, list); }
  const repos = new Map<string, { at: number; ttm: number | null; reverted: boolean; covered: boolean; refs: string[] }[]>();
  const coverageEvents = events.filter(e => e.kind === 'revert_coverage');
  let unknownMergeTimes = 0;
  for (const [prUrl, rows] of prs) {
    const merges = rows.filter(e => e.kind === 'merged' || (e.kind === 'outcome' && (e.row.state ?? e.row.outcome ?? e.row.status) === 'MERGED'));
    if (!merges.length) continue;
    const stamps = [...new Set(merges.map(e => time(e.row.mergedAt) ?? (e.kind === 'merged' ? e.at : null)).filter((t): t is number => t !== null))];
    if (stamps.length !== 1) { unknownMergeTimes++; continue; }
    const at = stamps[0]!;
    if (at < since || at > until) continue;
    const repo = prUrl.split('/').slice(3, 5).join('/');
    const reverted = rows.some(e => {
      const t = time(e.row.revertedAt) ?? (e.kind === 'revert' ? e.at : null);
      return t !== null && t >= at && t <= at + 7 * DAY && t <= e.at;
    });
    const coverage = coverageEvents.filter(e => e.row.repo === repo &&
      (time(e.row.from) ?? Infinity) <= at && (time(e.row.through) ?? -Infinity) >= at + 7 * DAY &&
      (time(e.row.through) ?? Infinity) <= e.at);
    const measuredTtm = [...new Set(merges.map(e => number(e.row.ttm_s)).filter((v): v is number => v !== null))];
    const publishedAt = rows.filter(e => ['publish', 'published'].includes(e.kind) && e.at <= at).map(e => e.at);
    const ttm = measuredTtm.length === 1 ? measuredTtm[0]! : measuredTtm.length === 0 && publishedAt.length ? (at - publishedAt.reduce((a, b) => Math.min(a, b), Infinity)) / 1000 : null;
    const list = repos.get(repo) ?? [];
    list.push({ at, ttm, reverted, covered: reverted || coverage.length > 0, refs: [...rows, ...coverage].map(e => e.ref) }); repos.set(repo, list);
  }
  const byRepo = [...repos].sort(([a], [b]) => a.localeCompare(b)).map(([repo, rows]): RepoOutcome => {
    const samples = rows.flatMap(r => r.ttm === null ? [] : [r.ttm]), covered = rows.filter(r => r.covered);
    return { repo, merged: rows.length, mergesPerDay: rows.length * 24 / hours,
      revertRate: covered.length === rows.length ? rate(covered.filter(r => r.reverted).length, covered.length) : null,
      revertSamples: covered.length, reverted: rows.filter(r => r.reverted).length,
      timeToMerge: { p50: outcomePercentile(samples, 0.5), p90: outcomePercentile(samples, 0.9), p95: outcomePercentile(samples, 0.95), samples: samples.length },
      evidenceRefs: [...new Set(rows.flatMap(r => r.refs))] };
  });
  return { schema: 'fleet.outcome-metrics.v1', sourceState: input.events === null ? 'missing' : ignoredRows || input.sourceState === 'degraded' ? 'degraded' : 'healthy',
    since: new Date(since).toISOString(), until: new Date(until).toISOString(), hours, ignoredRows, unknownMergeTimes,
    totals: input.events === null ? null : group('all', cohort), byLane, byModelTier, byRepo };
}
