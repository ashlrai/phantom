/** Local interface for RQ-METRICS-ROUTER-FEED and RQ-BUDGET-LEDGER.
 * Observation only. Replace the reader when the upstream modules land.
 * Shares are fractions; missing observations are null, never invented zeros.
 */
export interface MetricsWork {
  pr: string;
  template: string;
  kind: 'production' | 'exploration';
  merged: boolean;
  impactScore: number;
}

export interface MetricsPool {
  pool: string;
  unit: string;
  limit: number;
  used: number;
  observedHours: number;
  resetsAt: string;
}

export interface RouterMetricsFeed {
  observedAt: string;
  windowHours: number;
  work: MetricsWork[];
  pools: MetricsPool[];
}

/** Explicit stub: absence is not a successful empty measurement. */
export function readRouterMetricsFeed(): RouterMetricsFeed | null {
  return null;
}

export interface FleetMetrics {
  schema: 'fleet-metrics.v1';
  sourceState: 'healthy' | 'unavailable' | 'degraded';
  observedAt: string | null;
  windowHours: number | null;
  rollups: { total: number; merged: number; impactScore: number } | null;
  productionShare: number | null;
  explorationShare: number | null;
  topTemplatesToRetire: Array<{ template: string; total: number; merged: number; impactScore: number }>;
  scoreboard: {
    topPrs: Array<{ pr: string; template: string; impactScore: number }>;
    topTemplates: Array<{ template: string; total: number; merged: number; impactScore: number }>;
  };
  budgets: Array<{
    pool: string; unit: string; limit: number; used: number; remaining: number;
    burnPerHour: number | null; projectedExhaustionAt: string | null; resetsAt: string;
    exhaustionVsReset: 'before-reset' | 'at-reset' | 'after-reset' | 'no-burn' | 'unknown';
  }>;
}

function emptyMetrics(sourceState: FleetMetrics['sourceState']): FleetMetrics {
  return {
    schema: 'fleet-metrics.v1', sourceState, observedAt: null, windowHours: null,
    rollups: null, productionShare: null, explorationShare: null,
    topTemplatesToRetire: [], scoreboard: { topPrs: [], topTemplates: [] }, budgets: [],
  };
}

/** A failed or malformed source degrades only this slice of fleet status. */
export function readFleetMetrics(reader: () => RouterMetricsFeed | null = readRouterMetricsFeed): FleetMetrics {
  try { return buildFleetMetrics(reader()); }
  catch { return emptyMetrics('degraded'); }
}

const nonnegative = (n: number): boolean => Number.isFinite(n) && n >= 0;
const dateValid = (s: string): boolean => Number.isFinite(Date.parse(s));

/** Pure projection with deterministic rankings and at most ten rows per ranking. */
export function buildFleetMetrics(feed: RouterMetricsFeed | null): FleetMetrics {
  if (feed === null) return emptyMetrics('unavailable');
  if (!dateValid(feed.observedAt) || !nonnegative(feed.windowHours) || feed.windowHours === 0 ||
    feed.work.some((w) => !w.pr || !w.template || !nonnegative(w.impactScore) ||
      !['production', 'exploration'].includes(w.kind) || typeof w.merged !== 'boolean') ||
    new Set(feed.work.map((w) => w.pr)).size !== feed.work.length ||
    new Set(feed.pools.map((p) => p.pool)).size !== feed.pools.length ||
    feed.pools.some((p) => !p.pool || !p.unit || !nonnegative(p.limit) || !nonnegative(p.used) ||
      !nonnegative(p.observedHours) || !dateValid(p.resetsAt) || Date.parse(p.resetsAt) <= Date.parse(feed.observedAt))) {
    return emptyMetrics('degraded');
  }
  const templates = new Map<string, { template: string; total: number; merged: number; impactScore: number }>();
  for (const w of feed.work) {
    const t = templates.get(w.template) ?? { template: w.template, total: 0, merged: 0, impactScore: 0 };
    t.total++;
    if (w.merged) { t.merged++; t.impactScore += w.impactScore; }
    templates.set(w.template, t);
  }
  const total = feed.work.length;
  const merged = feed.work.filter((w) => w.merged);
  const production = feed.work.filter((w) => w.kind === 'production').length;
  const impactScore = merged.reduce((sum, w) => sum + w.impactScore, 0);
  if (!Number.isFinite(impactScore)) return emptyMetrics('degraded');
  return {
    schema: 'fleet-metrics.v1', sourceState: 'healthy', observedAt: feed.observedAt, windowHours: feed.windowHours,
    rollups: { total, merged: merged.length, impactScore },
    productionShare: total ? production / total : null,
    explorationShare: total ? (total - production) / total : null,
    // Candidates only: this feed never retires a template or changes routing.
    topTemplatesToRetire: [...templates.values()].filter((t) => t.impactScore === 0)
      .sort((a, b) => b.total - a.total || a.template.localeCompare(b.template)).slice(0, 10),
    scoreboard: {
      topPrs: merged.map(({ pr, template, impactScore }) => ({ pr, template, impactScore }))
        .sort((a, b) => b.impactScore - a.impactScore || a.pr.localeCompare(b.pr)).slice(0, 10),
      topTemplates: [...templates.values()]
        .sort((a, b) => b.impactScore - a.impactScore || a.template.localeCompare(b.template)).slice(0, 10),
    },
    budgets: [...feed.pools].sort((a, b) => a.pool.localeCompare(b.pool)).map((p) => {
      const remaining = Math.max(0, p.limit - p.used);
      const burnPerHour = p.observedHours > 0 ? p.used / p.observedHours : null;
      const exhaustion = remaining === 0 ? Date.parse(feed.observedAt)
        : burnPerHour && Number.isFinite(burnPerHour) ? Date.parse(feed.observedAt) + remaining / burnPerHour * 3_600_000 : NaN;
      const validExhaustion = Number.isFinite(exhaustion) && Math.abs(exhaustion) <= 8.64e15;
      const delta = exhaustion - Date.parse(p.resetsAt);
      return {
        pool: p.pool, unit: p.unit, limit: p.limit, used: p.used, remaining,
        burnPerHour: burnPerHour !== null && Number.isFinite(burnPerHour) ? burnPerHour : null,
        projectedExhaustionAt: validExhaustion ? new Date(exhaustion).toISOString() : null,
        resetsAt: p.resetsAt,
        exhaustionVsReset: validExhaustion ? delta < 0 ? 'before-reset' : delta > 0 ? 'after-reset' : 'at-reset'
          : burnPerHour === 0 ? 'no-burn' : 'unknown',
      };
    }),
  };
}

export function formatFleetMetrics(m: FleetMetrics): string[] {
  const share = (value: number | null): string => value === null ? 'unknown' : `${(value * 100).toFixed(1)}%`;
  const lines = [`Metrics: ${m.sourceState} (${m.schema})`];
  if (m.rollups) lines.push(`  work: ${m.rollups.total}; merged: ${m.rollups.merged}; impact: ${m.rollups.impactScore}`);
  lines.push(`  production share: ${share(m.productionShare)}; exploration share: ${share(m.explorationShare)}`);
  for (const t of m.topTemplatesToRetire) lines.push(`  retirement candidate: ${t.template} (${t.total} work, ${t.impactScore} impact)`);
  for (const p of m.scoreboard.topPrs) lines.push(`  top PR: ${p.pr} (${p.impactScore} impact; ${p.template})`);
  for (const t of m.scoreboard.topTemplates) lines.push(`  top template: ${t.template} (${t.impactScore} impact)`);
  for (const p of m.budgets) lines.push(`  pool ${p.pool}: ${p.remaining} ${p.unit} remaining; burn ${p.burnPerHour ?? 'unknown'}/hour; exhaustion ${p.projectedExhaustionAt ?? 'unknown'}; reset ${p.resetsAt} (${p.exhaustionVsReset})`);
  return lines;
}
