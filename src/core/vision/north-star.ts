/**
 * M162: North-star leverage metric for the ashlr fleet.
 *
 * The true north star for an autonomous engineering fleet is NOT proposal
 * volume — it is HUMAN LEVERAGE: how much substantive engineering work is
 * being done autonomously, and how many hours that frees for Mason to focus
 * on direction and vision.
 *
 * computeNorthStar(cfg) — reads quality metrics over the last 7d and derives:
 *   - substantiveMerges7d: merged proposals that are non-trivial (dormant: 0)
 *   - engHoursSaved7d:    estimated engineering hours freed (dormant: 0)
 *   - leverageScore:      0–100 from measured self-improvement outcomes in the
 *                         outcome ledger (50 = neutral), null when unknown
 *   - trend:              week-over-week direction of that score, 'unknown'
 *                         when either week lacks enough measured outcomes
 *
 * northStarSummary() — one-paragraph briefing-ready string summarising
 *   the leverage metric. Never throws.
 */

import type { AshlrConfig } from '../types.js';
import { computeQualityMetrics as _computeQualityMetrics } from '../fleet/quality-metrics.js';
import { MIN_GROUP_SAMPLES, readLedger, scoreOutcomes, type LedgerRead } from '../improve/outcomes.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NorthStarMetric {
  /** Proposals merged in the last 7d that are non-trivial (>6 diff lines, non-doc title). */
  substantiveMerges7d: number;
  /** Estimated engineering hours freed (substantiveMerges × avgHoursPerMerge). */
  engHoursSaved7d: number;
  /**
   * Leverage score 0–100 from self-improvement outcomes measured in the last 7d:
   * 50 + 50 × (improved − regressed) / measured. 100 = every measured change
   * improved its metric, 50 = neutral, 0 = every one regressed. Null (unknown,
   * never 0) below MIN_GROUP_SAMPLES measured outcomes or on a broken ledger.
   */
  leverageScore: number | null;
  /** Week-over-week direction of leverageScore; 'unknown' when either week's score is. */
  trend: 'up' | 'flat' | 'down' | 'unknown';
  /** The measured outcomes behind leverageScore. */
  leverage: MeasuredLeverage;
  /** Raw quality snapshot used for computation. */
  raw: {
    merged: number;
    trivialRatio: number;
    acceptRate: number;
    emptyRate: number;
    avgDiffLines: number;
    proposalsCreated: number;
  };
  computedAt: string;
}

export interface MeasuredLeverage {
  /** Outcomes whose head was measured in the window, by status. */
  measured: number;
  improved: number;
  unchanged: number;
  regressed: number;
  /** Proposals with ledger activity in the window but no usable paired measurement. */
  unknown: number;
  /** The prior 7d window's score, for the trend. */
  priorScore: number | null;
  ledgerIntact: boolean;
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Score thresholds.
 * A score >= 70 means the fleet is delivering real leverage.
 * A score < 30 means the fleet is mostly generating noise.
 */
export const LEVERAGE_SCORE_GOOD = 70;
export const LEVERAGE_SCORE_POOR = 30;
/** Score change between weeks that counts as a trend rather than noise. */
export const LEVERAGE_TREND_POINTS = 5;

const DAY_MS = 86_400_000;

interface WindowCounts { measured: number; improved: number; unchanged: number; regressed: number; unknown: number }

const scoreOf = (c: WindowCounts): number | null =>
  c.measured < MIN_GROUP_SAMPLES ? null : Math.round(50 + 50 * (c.improved - c.regressed) / c.measured);

/**
 * Leverage from the outcome ledger (`phm improve measure`). An outcome lands in
 * the window of its latest head measurement; an unknown one in the window of
 * its latest ledger record. Pure apart from the injected read.
 */
export function measuredLeverage(read: LedgerRead, now: Date = new Date()): { score: number | null; trend: NorthStarMetric['trend']; leverage: MeasuredLeverage } {
  const reasons = [...read.reasons];
  const latestHead = new Map<string, number>();
  const latestAny = new Map<string, number>();
  for (const r of read.records) {
    const t = Date.parse(r.at);
    if (!Number.isFinite(t)) continue;
    latestAny.set(r.proposalId, Math.max(t, latestAny.get(r.proposalId) ?? -Infinity));
    if (r.type === 'measured' && r.phase === 'head') latestHead.set(r.proposalId, Math.max(t, latestHead.get(r.proposalId) ?? -Infinity));
  }
  const empty = (): WindowCounts => ({ measured: 0, improved: 0, unchanged: 0, regressed: 0, unknown: 0 });
  const current = empty(), prior = empty();
  const end = now.getTime();
  for (const o of scoreOutcomes(read.records)) {
    const t = o.status === 'unknown' ? latestAny.get(o.proposalId) : latestHead.get(o.proposalId);
    if (t === undefined || t > end) continue;
    const bucket = t > end - 7 * DAY_MS ? current : t > end - 14 * DAY_MS ? prior : null;
    if (!bucket) continue;
    if (o.status === 'unknown') { bucket.unknown++; continue; }
    bucket.measured++;
    bucket[o.status]++;
  }
  const score = read.intact ? scoreOf(current) : null;
  const priorScore = read.intact ? scoreOf(prior) : null;
  if (!read.intact) reasons.push('ledger-not-intact');
  else if (score === null) reasons.push(`needs-${MIN_GROUP_SAMPLES}-measured-outcomes-in-7d`);
  const trend: NorthStarMetric['trend'] = score === null || priorScore === null ? 'unknown'
    : score - priorScore >= LEVERAGE_TREND_POINTS ? 'up' : priorScore - score >= LEVERAGE_TREND_POINTS ? 'down' : 'flat';
  return { score, trend, leverage: { ...current, priorScore, ledgerIntact: read.intact, reasons } };
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

/**
 * Compute the north-star leverage metric from quality metrics.
 *
 * Uses computeQualityMetrics from fleet/quality-metrics with a 7d window
 * (current) and a 30d window (for trend). Best-effort — never throws.
 */
export function computeNorthStar(_cfg: AshlrConfig): NorthStarMetric {
  const computedAt = new Date().toISOString();

  let measured: ReturnType<typeof measuredLeverage>;
  try {
    measured = measuredLeverage(readLedger());
  } catch (err) {
    measured = { score: null, trend: 'unknown', leverage: { measured: 0, improved: 0, unchanged: 0, regressed: 0, unknown: 0, priorScore: null,
      ledgerIntact: false, reasons: [`ledger-unreadable: ${err instanceof Error ? err.message : String(err)}`] } };
  }

  const zero = (): NorthStarMetric => ({
    substantiveMerges7d: 0,
    engHoursSaved7d: 0,
    leverageScore: measured.score,
    trend: measured.trend,
    leverage: measured.leverage,
    raw: { merged: 0, trivialRatio: 0, acceptRate: 0, emptyRate: 0, avgDiffLines: 0, proposalsCreated: 0 },
    computedAt,
  });

  try {
    const computeQualityMetrics = _computeQualityMetrics;

    const m7 = computeQualityMetrics('7d');
    const m30 = computeQualityMetrics('30d');

    // Operational metrics below remain factual. Merge and hours-saved credit stay
    // dormant until post-merge credit has a proof verifier; the leverage score
    // comes only from paired base/head measurements in the outcome ledger.
    const substantiveMerges7d = 0;
    const engHoursSaved7d = 0;
    void m30;

    return {
      substantiveMerges7d,
      engHoursSaved7d,
      leverageScore: measured.score,
      trend: measured.trend,
      leverage: measured.leverage,
      raw: {
        merged: m7.merged,
        trivialRatio: m7.trivialRatio,
        acceptRate: m7.acceptRate,
        emptyRate: m7.emptyRate,
        avgDiffLines: m7.avgDiffLines,
        proposalsCreated: m7.proposalsCreated,
      },
      computedAt,
    };
  } catch {
    return zero();
  }
}

// ---------------------------------------------------------------------------
// Briefing summary
// ---------------------------------------------------------------------------

/**
 * Generate a one-paragraph briefing-ready summary of the leverage metric.
 * Safe to call with a pre-computed metric or it computes lazily.
 * Never throws.
 */
export function northStarSummary(metric: NorthStarMetric): string {
  try {
    const { raw, leverage } = metric;
    const counts = leverage
      ? `${leverage.measured} measured (${leverage.improved} improved, ${leverage.unchanged} unchanged, ${leverage.regressed} regressed), ${leverage.unknown} unknown`
      : 'no outcome ledger read';
    const measuredLine = metric.leverageScore === null || metric.leverageScore === undefined
      ? `Measured leverage score: unavailable (${counts}; needs ${MIN_GROUP_SAMPLES} measured outcomes in 7d and an intact ledger)`
      : `Measured leverage score: ${metric.leverageScore}/100 (${counts}; 50 = neutral), trend ${metric.trend}`;

    return `=== NORTH-STAR: HUMAN LEVERAGE (7d) ===
Positive post-merge leverage credit: unavailable pending authenticated release
${measuredLine}
Negative indicators: ${(raw.trivialRatio * 100).toFixed(0)}% trivial | ${(raw.emptyRate * 100).toFixed(1)}% empty-diff
Proposals created: ${raw.proposalsCreated}`;
  } catch {
    return '=== NORTH-STAR: HUMAN LEVERAGE ===\nMetric unavailable.';
  }
}
