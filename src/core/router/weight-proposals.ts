import { z } from 'zod';

import type { RouterOutcome, RouterOutcomeRead } from './outcomes.js';

// Advisory router-weight proposals from recorded outcomes. Recovered from the pure proposal slice of
// PR #6794 (head f9e484e87ec2d01f155cc280e818d2e98519dbe7, src/core/router/tune.ts). Math only: no I/O,
// no weights.json, no applyRouterWeights. Nothing here changes live routing, rank or admission.

export const ROUTER_WEIGHT_PROPOSAL_SOURCE = {
  pr: 6794,
  head_sha: 'f9e484e87ec2d01f155cc280e818d2e98519dbe7',
  recovered_from: 'src/core/router/tune.ts#proposeRouterWeights',
} as const;
export const ROUTER_WEIGHT_BASELINE = 0.5;
export const ROUTER_WEIGHT_DEFAULT_MIN_SAMPLES = 20;
export const ROUTER_WEIGHT_DEFAULT_MAX_SHIFT = 0.1;

// Mirrors the documented route-ID shape. Not imported from src/core/routing/** (Tier-1 protected).
const ROUTE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const isRouteId = (v: unknown): v is string => typeof v === 'string' && ROUTE_ID.test(v);
const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export interface RouterWeightBaseline { work_class: string; lane: string; weight: number }

export interface RouterWeightProposalOptions {
  /** Known (merged true/false) outcomes required before a shift is proposed. Default 20. */
  minSamples?: number;
  /** Largest move from the baseline in either direction, in (0, 1]. Default 0.1. */
  maxShift?: number;
  /** Current weights. Absent (work_class, lane) pairs start at ROUTER_WEIGHT_BASELINE. */
  baselines?: readonly RouterWeightBaseline[];
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
}

export interface RouterWeightProposalSet {
  proposals: RouterWeightProposal[];
  known_outcomes: number;
  unknown_outcomes: number;
  unclassified_outcomes: number;
}

/**
 * Groups by (work_class, lane). Non-ID work_class or lane is unclassified; merged:null is unknown and
 * excluded from evidence. A group below minSamples is refused and keeps its baseline. Otherwise the
 * weight moves toward the observed held-merge rate — merged outcomes recorded as reverted count as
 * known evidence but never as held merges — capped at maxShift and clamped to [0, 1].
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

  const groups = new Map<string, { work_class: string; lane: string; known: number; merged: number; reverted: number }>();
  let known = 0, unknown = 0, unclassified = 0;
  for (const o of outcomes) {
    if (!isRouteId(o.work_class) || !isRouteId(o.lane)) { unclassified++; continue; }
    if (o.merged === null) { unknown++; continue; }
    const key = JSON.stringify([o.work_class, o.lane]);
    const g = groups.get(key) ?? { work_class: o.work_class, lane: o.lane, known: 0, merged: 0, reverted: 0 };
    g.known++;
    if (o.merged) {
      if (o.reverted === true) g.reverted++;
      else g.merged++;
    }
    groups.set(key, g);
    known++;
  }

  const proposals = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, g]): RouterWeightProposal => {
    const baseline = baselines.get(key) ?? ROUTER_WEIGHT_BASELINE;
    const base = { work_class: g.work_class, lane: g.lane, known_n: g.known, reverted_n: g.reverted, baseline_weight: baseline };
    if (g.known < minSamples) {
      return { ...base, status: 'refused', reason: 'insufficient-evidence', proposed_weight: baseline, shift: 0 };
    }
    const proposed = clamp(baseline + clamp(g.merged / g.known - baseline, -maxShift, maxShift), 0, 1);
    return { ...base, status: 'proposed', reason: null, proposed_weight: round6(proposed), shift: round6(proposed - baseline) };
  });
  return { proposals, known_outcomes: known, unknown_outcomes: unknown, unclassified_outcomes: unclassified };
}

export interface RouterWeightProposalReport {
  schema: 'router.weight-proposals.v1';
  /** Always true: proposals are never applied to routing, rank, admission or weights.json. */
  advisory_only: true;
  as_of: string;
  source: typeof ROUTER_WEIGHT_PROPOSAL_SOURCE;
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
  /** 'unavailable' when the ledger was not read; counts are then null, never zero. */
  status: 'proposed' | 'insufficient-evidence' | 'unavailable';
  bounds: { min_samples: number; max_shift: number };
  known_outcomes: number | null;
  unknown_outcomes: number | null;
  unclassified_outcomes: number | null;
  proposals: RouterWeightProposal[];
}

/** Wraps one bounded ledger read. Raw ledger rows are never copied into the report. */
export function buildRouterWeightProposalReport(read: RouterOutcomeRead, asOf: string, opts: RouterWeightProposalOptions = {}): RouterWeightProposalReport {
  if (!z.iso.datetime().safeParse(asOf).success) throw new RangeError('as_of must be an ISO-8601 UTC timestamp');
  const bounds = { min_samples: opts.minSamples ?? ROUTER_WEIGHT_DEFAULT_MIN_SAMPLES, max_shift: opts.maxShift ?? ROUTER_WEIGHT_DEFAULT_MAX_SHIFT };
  const head = { schema: 'router.weight-proposals.v1' as const, advisory_only: true as const, as_of: asOf,
    source: ROUTER_WEIGHT_PROPOSAL_SOURCE, ledger: { state: read.state, path: read.path }, truncated: read.truncated,
    market_state: read.market_state, market_truncated: read.market_truncated, bounds };
  if (read.state !== 'read') {
    return { ...head, status: 'unavailable', known_outcomes: null, unknown_outcomes: null, unclassified_outcomes: null, proposals: [] };
  }
  const set = proposeRouterWeights(read.outcomes, { ...opts, minSamples: bounds.min_samples, maxShift: bounds.max_shift });
  const status = set.proposals.some(p => p.status === 'proposed') ? 'proposed' : 'insufficient-evidence';
  return { ...head, status, known_outcomes: set.known_outcomes, unknown_outcomes: set.unknown_outcomes,
    unclassified_outcomes: set.unclassified_outcomes, proposals: set.proposals };
}
